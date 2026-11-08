import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trialWindow } from "../../packages/domain/src/trial";
import type {
  Prisma,
  PrismaClient,
} from "../../packages/database/src/generated/prisma/client";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";
import { operatorUpdate, operatorUpdateInTx } from "../helpers/operator-update";

// #211: profile extras and logo, quote snapshot, trial notifications, user
// notices, extension requests and the commit-time read-only guard (ADR 0004
// D3, D4).
let database: CommittedDatabase;
let client: PrismaClient;
const factory = syntheticFactory(0x2110);
const owner = factory.user();
const member = factory.user();
const other = factory.user();
let companyId = "";
let otherCompanyId = "";

async function createCompany(userId: string) {
  const company = { ...factory.company(userId), isDemo: false };
  await client.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, userId),
    });
  });
  return company.id;
}

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
  for (const user of [owner, member, other])
    await client.user.create({ data: user });
  // decided_by references platform_operators (#230).
  await client.platformOperator.create({
    data: { userId: other.id, grantedReason: "Synthetic", grantedBy: "test" },
  });
  companyId = await createCompany(owner.id);
  await client.membership.create({
    data: {
      ...factory.membership(companyId, member.id),
      role: "employee",
      createdBy: owner.id,
    },
  });
  otherCompanyId = await createCompany(other.id);
}, 60_000);
afterAll(() => database?.release());

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Put the company on a trial whose last day is `lastDay` (Sydney). */
function setTrial(lastDay: string) {
  return operatorUpdate(client, {
    where: { id: companyId },
    data: {
      accessMode: "trial",
      trialStartedAt: new Date("2026-01-01T00:00:00Z"),
      trialLastDay: day(lastDay),
    },
    select: { readOnlyFrom: true },
  });
}
const expire = () => setTrial("2020-01-01");
const reopen = () =>
  operatorUpdate(client, {
    where: { id: companyId },
    data: { accessMode: "unrestricted" },
  });

type Event = {
  action: string;
  metadata?: Prisma.InputJsonValue;
  exemption?: string;
};
/** One transaction that records `events`, optionally declaring an exemption. */
function audited(
  events: Event[],
  extra?: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  return client.$transaction(async (tx) => {
    const exemption = events.find((event) => event.exemption)?.exemption;
    if (exemption)
      await tx.$executeRaw`SELECT set_config('jobflow.read_only_exemption', ${exemption}, true)`;
    for (const event of events)
      await tx.auditEvent.create({
        data: {
          companyId,
          createdBy: owner.id,
          action: event.action,
          targetType: "company",
          targetId: companyId,
          metadata: event.metadata ?? {},
        },
      });
    await extra?.(tx);
  });
}

describe("read_only_from: SQL agrees with packages/domain trialWindow", () => {
  it.each([
    "2026-11-02T04:00:00Z", // requirements example (AEDT)
    "2026-11-02T12:59:59Z", // 23:59:59 Sydney
    "2026-11-02T13:00:00Z", // 00:00 Sydney, still 2 Nov in UTC
    "2026-07-14T02:00:00Z", // AEST throughout
    "2026-09-20T02:00:00Z", // crosses DST start
    "2027-03-20T03:00:00Z", // crosses DST end
    // read_only_from on the DST days themselves (Claude A, #255 review):
    "2026-09-04T02:00:00Z", // last day 3 Oct → read-only 00:00 AEST on 4 Oct
    "2026-09-05T02:00:00Z", // last day 4 Oct → read-only 00:00 AEDT on 5 Oct
    "2027-03-05T02:00:00Z", // last day 3 Apr → read-only 00:00 AEDT on 4 Apr
    "2027-03-06T02:00:00Z", // last day 4 Apr → read-only 00:00 AEST on 5 Apr
  ])("trial started %s", async (start) => {
    const window = trialWindow(new Date(start));
    const { readOnlyFrom } = await setTrial(window.lastDay);
    expect(readOnlyFrom?.toISOString()).toBe(window.readOnlyFrom.toISOString());
  });
});

describe("commit-time read-only guard", () => {
  it("lets an unrestricted company and a running trial write", async () => {
    await reopen();
    await expect(
      audited([{ action: "customer.created" }]),
    ).resolves.toBeUndefined();
    await setTrial("2099-12-31");
    await expect(
      audited([{ action: "customer.created" }]),
    ).resolves.toBeUndefined();
  });

  it("refuses a business write once the trial has expired, rolling back everything", async () => {
    await expire();
    const before = await client.auditEvent.count({ where: { companyId } });
    await expect(
      audited([{ action: "customer.created" }], (tx) =>
        tx.company.update({
          where: { id: companyId },
          data: { about: "changed" },
        }),
      ),
    ).rejects.toThrow(/jobflow_company_read_only/);
    expect(await client.auditEvent.count({ where: { companyId } })).toBe(
      before,
    );
    const company = await client.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    expect(company.about).toBeNull();
  });

  it("checks at commit: a write that started writable and commits after expiry is rolled back", async () => {
    await setTrial("2099-12-31");
    await expect(
      audited([{ action: "customer.created" }], (tx) =>
        // Expiry lands inside the same transaction, after the audit row.
        operatorUpdateInTx(tx, {
          where: { id: companyId },
          data: { trialLastDay: day("2020-01-01") },
        }),
      ),
    ).rejects.toThrow(/jobflow_company_read_only/);
  });

  it("judges expiry by the clock at commit, not at transaction start (S9 AC4)", async () => {
    await setTrial("2099-12-31");
    // Make the company expire one second from now: set read_only_from
    // directly, with the deriving trigger switched off for that statement.
    await client.$transaction([
      client.$executeRaw`ALTER TABLE companies DISABLE TRIGGER companies_read_only_from`,
      client.$executeRaw`UPDATE companies SET read_only_from = clock_timestamp() + interval '1 second' WHERE id = ${companyId}::uuid`,
      client.$executeRaw`ALTER TABLE companies ENABLE TRIGGER companies_read_only_from`,
    ]);
    // The transaction starts (and writes) while the company is writable,
    // then commits after expiry: with now() instead of clock_timestamp()
    // in the guard, this would wrongly commit.
    await expect(
      client.$transaction(
        async (tx) => {
          await tx.auditEvent.create({
            data: {
              companyId,
              createdBy: owner.id,
              action: "customer.created",
              targetType: "company",
              targetId: companyId,
            },
          });
          await tx.$executeRaw`SELECT pg_sleep(2)`;
        },
        { timeout: 10_000 },
      ),
    ).rejects.toThrow(/jobflow_company_read_only/);
  });

  it("an extension committed first makes the write succeed", async () => {
    await expire();
    await setTrial("2099-12-31");
    await expect(
      audited([{ action: "customer.created" }]),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["export", "company.exported"],
    ["export", "report.exported"],
    ["export", "report.export_refused"],
    ["record_rendering", "invoice.pdf_stored"],
    ["access_removal", "invitation.revoked"],
    ["invitation_pre_expiry", "invitation.accepted"],
    ["trial_extension_request", "trial_extension.requested"],
    ["operator", "trial.extended"],
    ["operator", "company.access_mode_changed"],
    ["operator", "trial_extension.approved"],
    ["operator", "trial_extension.declined"],
    ["housekeeping", "document.unattached_deleted"],
  ])("exemption %s admits %s", async (exemption, action) => {
    await expire();
    await expect(audited([{ action, exemption }])).resolves.toBeUndefined();
  });

  it("an exemption key admits only its own actions", async () => {
    await expire();
    // A valid key with an unrelated action in the same transaction.
    await expect(
      audited([
        { action: "company.exported", exemption: "export" },
        { action: "invoice.issued" },
      ]),
    ).rejects.toThrow(/jobflow_company_read_only/);
    await expect(
      audited([{ action: "invoice.pdf_stored", exemption: "export" }]),
    ).rejects.toThrow(/jobflow_company_read_only/);
  });

  it("an unknown or empty key admits nothing", async () => {
    await expire();
    for (const exemption of ["everything", "EXPORT", " export"])
      await expect(
        audited([{ action: "company.exported", exemption }]),
      ).rejects.toThrow(/jobflow_company_read_only/);
    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('jobflow.read_only_exemption', '', true)`;
        await tx.auditEvent.create({
          data: {
            companyId,
            createdBy: owner.id,
            action: "company.exported",
            targetType: "company",
            targetId: companyId,
          },
        });
      }),
    ).rejects.toThrow(/jobflow_company_read_only/);
  });

  it("an exemption is transaction-local: it doesn't carry into the next transaction", async () => {
    await expire();
    await audited([{ action: "company.exported", exemption: "export" }]);
    await expect(audited([{ action: "company.exported" }])).rejects.toThrow(
      /jobflow_company_read_only/,
    );
  });

  it("access_removal admits a pure deactivation, never a role change", async () => {
    await expire();
    const deactivate = {
      changes: { isActive: { before: true, after: false } },
    };
    await expect(
      audited([
        {
          action: "membership.access_updated",
          exemption: "access_removal",
          metadata: deactivate,
        },
      ]),
    ).resolves.toBeUndefined();
    for (const metadata of [
      { changes: { role: { before: "employee", after: "manager" } } },
      {
        changes: {
          isActive: { before: true, after: false },
          role: { before: "employee", after: "manager" },
        },
      },
      { changes: { isActive: { before: false, after: true } } }, // reactivation
      // Deactivation plus any other changed field (a later PATCH field).
      {
        changes: {
          isActive: { before: true, after: false },
          title: { before: null, after: "Lead" },
        },
      },
      {},
    ])
      await expect(
        audited([
          {
            action: "membership.access_updated",
            exemption: "access_removal",
            metadata,
          },
        ]),
      ).rejects.toThrow(/jobflow_company_read_only/);
  });

  it("never blocks another company", async () => {
    await expire();
    await expect(
      client.auditEvent.create({
        data: {
          companyId: otherCompanyId,
          createdBy: other.id,
          action: "customer.created",
          targetType: "company",
          targetId: otherCompanyId,
        },
      }),
    ).resolves.toBeDefined();
  });

  afterAll(async () => {
    await reopen();
  });
});

describe("company profile extras", () => {
  async function document(
    company: string,
    createdBy: string,
    kind: "receipt" | "company_logo",
  ) {
    const id = factory.id();
    await client.document.create({
      data: {
        id,
        companyId: company,
        kind,
        objectKey: `documents/${company}/${"b".repeat(48)}${id.slice(-12).replace(/-/g, "0").padStart(16, "0")}`,
        fileName: "logo.png",
        contentType: "image/png",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        createdBy,
      },
    });
    return id;
  }

  it("accepts only a company_logo document of the same company as the logo", async () => {
    await reopen();
    const logo = await document(companyId, owner.id, "company_logo");
    await client.company.update({
      where: { id: companyId },
      data: { logoDocumentId: logo },
    });
    const receipt = await document(companyId, owner.id, "receipt");
    await expect(
      client.company.update({
        where: { id: companyId },
        data: { logoDocumentId: receipt },
      }),
    ).rejects.toThrow(/company_logo/);
    const foreign = await document(otherCompanyId, other.id, "company_logo");
    await expect(
      client.company.update({
        where: { id: companyId },
        data: { logoDocumentId: foreign },
      }),
    ).rejects.toThrow();
    const company = await client.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    expect(company.logoDocumentId).toBe(logo);
  });

  it("allows only http(s) websites", async () => {
    await client.company.update({
      where: { id: companyId },
      data: { website: "https://synthetic.example" },
    });
    for (const website of [
      "javascript:alert(1)",
      "ftp://synthetic.example",
      "synthetic.example",
    ])
      await expect(
        client.company.update({ where: { id: companyId }, data: { website } }),
      ).rejects.toThrow(/companies_website_scheme/);
  });
});

describe("quote supplier snapshot", () => {
  it("is set when the quote is sent and frozen afterwards", async () => {
    await reopen();
    const customerId = factory.id();
    const quoteId = factory.id();
    await client.customer.create({
      data: {
        id: customerId,
        companyId,
        name: "Synthetic Customer",
        createdBy: owner.id,
      },
    });
    await client.quote.create({
      data: {
        id: quoteId,
        companyId,
        number: 1,
        customerId,
        title: "Synthetic quote",
        createdBy: owner.id,
      },
    });
    const snapshot = { v: 2, name: "Synthetic Test Company", abn: null };
    await client.quote.update({
      where: { id: quoteId },
      data: {
        status: "sent",
        sentOn: day("2026-11-03"),
        sentAt: new Date(),
        sentBy: owner.id,
        gstRegistered: false,
        supplierSnapshot: snapshot,
      },
    });
    await expect(
      client.quote.update({
        where: { id: quoteId },
        data: { supplierSnapshot: { ...snapshot, name: "Changed" } },
      }),
    ).rejects.toThrow(/sent quote can't be edited/);
    const quote = await client.quote.findUniqueOrThrow({
      where: { id: quoteId },
    });
    expect(quote.supplierSnapshot).toEqual(snapshot);
  });
});

describe("trial notifications and user notices", () => {
  it("records each threshold once per last day", async () => {
    const row = {
      companyId,
      trialLastDay: day("2026-12-01"),
      threshold: "d7" as const,
    };
    await client.trialNotification.create({ data: row });
    await expect(
      client.trialNotification.create({ data: row }),
    ).rejects.toThrow();
    // An extension changes the last day, which re-arms the threshold.
    await client.trialNotification.create({
      data: { ...row, trialLastDay: day("2026-12-15") },
    });
  });

  it("keeps account-level notices unique too (NULLS NOT DISTINCT)", async () => {
    const notice = {
      userId: owner.id,
      companyId: null,
      noticeKey: "trial.welcome",
    };
    await client.userNotice.create({ data: notice });
    await expect(client.userNotice.create({ data: notice })).rejects.toThrow();
    await client.userNotice.create({ data: { ...notice, companyId } });
  });
});

describe("trial extension requests", () => {
  const base = () => ({
    companyId,
    requestedBy: owner.id,
    lastDayAtRequest: day("2026-12-01"),
  });

  it("allows one pending request per company, even concurrently", async () => {
    const results = await Promise.allSettled([
      client.trialExtensionRequest.create({ data: base() }),
      client.trialExtensionRequest.create({ data: base() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("requires the requester to be a member of the company", async () => {
    // A fully valid declined row, so only the membership FK can refuse it.
    await expect(
      client.trialExtensionRequest.create({
        data: {
          ...base(),
          requestedBy: other.id,
          status: "declined",
          decidedAt: new Date(),
          decidedBy: other.id,
          decisionNote: "Synthetic decline",
        },
      }),
    ).rejects.toThrow(/trial_extension_requests_requester_fkey/);
  });

  it("accepts each decided status with exactly its fields", async () => {
    const decided = { decidedAt: new Date(), decidedBy: other.id };
    for (const data of [
      {
        status: "closed" as const,
        closedReason: "direct_extension",
        newLastDay: day("2026-12-20"),
      },
      { status: "closed" as const, closedReason: "made_unrestricted" },
      { status: "declined" as const, decisionNote: "Synthetic decline" },
      {
        status: "approved" as const,
        extensionDays: 365,
        newLastDay: day("2027-12-01"),
      },
    ])
      await expect(
        client.trialExtensionRequest.create({
          data: { ...base(), ...decided, ...data },
        }),
        JSON.stringify(data),
      ).resolves.toBeDefined();
  });

  it("refuses decided rows with the wrong or missing fields", async () => {
    const decided = { decidedAt: new Date(), decidedBy: other.id };
    for (const data of [
      // made_unrestricted carries no new last day.
      {
        status: "closed" as const,
        closedReason: "made_unrestricted",
        newLastDay: day("2026-12-20"),
      },
      // A blank decline reason.
      { status: "declined" as const, decisionNote: "   " },
    ])
      await expect(
        client.trialExtensionRequest.create({
          data: { ...base(), ...decided, ...data },
        }),
        JSON.stringify(data),
      ).rejects.toThrow(/trial_extension_requests_decision/);
    // 366 days: a valid approved row otherwise, so only the range check fails.
    await expect(
      client.trialExtensionRequest.create({
        data: {
          ...base(),
          ...decided,
          status: "approved",
          extensionDays: 366,
          newLastDay: day("2027-12-02"),
        },
      }),
    ).rejects.toThrow(/trial_extension_requests_extension_days/);
  });

  it("carries exactly the fields of its status", async () => {
    const pending = await client.trialExtensionRequest.findFirstOrThrow({
      where: { companyId, status: "pending" },
    });
    // Approved without days or a new last day.
    await expect(
      client.trialExtensionRequest.update({
        where: { id: pending.id },
        data: {
          status: "approved",
          decidedAt: new Date(),
          decidedBy: other.id,
        },
      }),
    ).rejects.toThrow(/trial_extension_requests_decision/);
    // Declined without a reason.
    await expect(
      client.trialExtensionRequest.update({
        where: { id: pending.id },
        data: {
          status: "declined",
          decidedAt: new Date(),
          decidedBy: other.id,
        },
      }),
    ).rejects.toThrow(/trial_extension_requests_decision/);
    // Closed by a direct extension needs the new last day.
    await expect(
      client.trialExtensionRequest.update({
        where: { id: pending.id },
        data: {
          status: "closed",
          decidedAt: new Date(),
          decidedBy: other.id,
          closedReason: "direct_extension",
        },
      }),
    ).rejects.toThrow(/trial_extension_requests_decision/);
    // Closed without any reason (a NULL CHECK result must not pass).
    for (const newLastDay of [null, day("2026-12-15")])
      await expect(
        client.trialExtensionRequest.update({
          where: { id: pending.id },
          data: {
            status: "closed",
            decidedAt: new Date(),
            decidedBy: other.id,
            newLastDay,
          },
        }),
      ).rejects.toThrow(/trial_extension_requests_decision/);
    // An unknown closed reason.
    await expect(
      client.trialExtensionRequest.update({
        where: { id: pending.id },
        data: {
          status: "closed",
          decidedAt: new Date(),
          decidedBy: other.id,
          closedReason: "other",
        },
      }),
    ).rejects.toThrow(/trial_extension_requests_decision/);
  });

  it("is decided once and then never changes or disappears", async () => {
    const pending = await client.trialExtensionRequest.findFirstOrThrow({
      where: { companyId, status: "pending" },
    });
    await client.trialExtensionRequest.update({
      where: { id: pending.id },
      data: {
        status: "approved",
        decidedAt: new Date(),
        decidedBy: other.id,
        extensionDays: 14,
        newLastDay: day("2026-12-15"),
        decisionNote: "Synthetic approval",
      },
    });
    await expect(
      client.trialExtensionRequest.update({
        where: { id: pending.id },
        data: { decisionNote: "Edited" },
      }),
    ).rejects.toThrow(/decided trial extension request/);
    await expect(
      client.trialExtensionRequest.delete({ where: { id: pending.id } }),
    ).rejects.toThrow(/never deleted/);
    // A new request is allowed once the previous one is decided.
    await expect(
      client.trialExtensionRequest.create({
        data: { ...base(), message: "Synthetic" },
      }),
    ).resolves.toBeDefined();
  });

  it("refuses changes to a pending request's own details", async () => {
    const pending = await client.trialExtensionRequest.findFirstOrThrow({
      where: { companyId, status: "pending" },
    });
    await expect(
      client.trialExtensionRequest.update({
        where: { id: pending.id },
        data: { message: "Rewritten" },
      }),
    ).rejects.toThrow(/details can't change/);
  });
});

describe("trial columns change only through the operator (#260)", () => {
  const refused = /jobflow_trial_columns_operator_only/;

  it("refuses access_mode, trial_started_at, trial_last_day and trial_extension_count without the operator key", async () => {
    for (const data of [
      { accessMode: "trial" as const },
      { trialLastDay: day("2099-12-31") },
      { trialExtensionCount: 5 },
      { trialStartedAt: new Date("2020-01-01T00:00:00Z") },
    ])
      await expect(
        client.company.update({ where: { id: otherCompanyId }, data }),
      ).rejects.toThrow(refused);
    // Another exemption key isn't enough either.
    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('jobflow.read_only_exemption', 'export', true)`;
        await tx.company.update({
          where: { id: otherCompanyId },
          data: { trialExtensionCount: 5 },
        });
      }),
    ).rejects.toThrow(refused);
  });

  it("allows other company columns, and the trial columns with the operator key", async () => {
    await client.company.update({
      where: { id: otherCompanyId },
      data: { name: "Synthetic Renamed" },
    });
    const updated = await operatorUpdate(client, {
      where: { id: otherCompanyId },
      data: { trialExtensionCount: { increment: 1 } },
    });
    expect(updated.trialExtensionCount).toBeGreaterThan(0);
  });

  it("the key is transaction-local: it doesn't carry into the next statement", async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('jobflow.read_only_exemption', 'operator', true)`;
    });
    await expect(
      client.company.update({
        where: { id: otherCompanyId },
        data: { trialExtensionCount: 0 },
      }),
    ).rejects.toThrow(refused);
  });

  it("has no column default: an insert must choose an access mode", async () => {
    await expect(
      client.$executeRaw`INSERT INTO companies (name, created_by) VALUES ('No mode', ${owner.id}::uuid)`,
    ).rejects.toThrow(/access_mode/);
  });
});
