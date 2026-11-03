import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #210: sign-up accounts, outbox, platform audit and trial access state.
let database: CommittedDatabase;
let client: PrismaClient;
const factory = syntheticFactory(0x2100);
const owner = factory.user();
let companyId = "";

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
  const company = { ...factory.company(owner.id), isDemo: false };
  await client.$transaction(async (tx) => {
    await tx.user.create({ data: owner });
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, owner.id),
    });
  });
  companyId = company.id;
}, 60_000);
afterAll(() => database?.release());

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function startTrial(lastDay: string) {
  return client.company.update({
    where: { id: companyId },
    data: {
      accessMode: "trial",
      trialStartedAt: new Date(),
      trialLastDay: day(lastDay),
    },
    select: { readOnlyFrom: true },
  });
}

describe("trial access state", () => {
  it.each([
    ["AEDT", "2026-11-30", "2026-11-30T13:00:00.000Z"],
    ["AEST", "2026-06-30", "2026-06-30T14:00:00.000Z"],
    // DST ends 5 April 2026 03:00: midnight on the 5th is still AEDT.
    ["DST end", "2026-04-04", "2026-04-04T13:00:00.000Z"],
    // DST starts 4 October 2026 02:00: midnight on the 4th is still AEST.
    ["DST start", "2026-10-03", "2026-10-03T14:00:00.000Z"],
  ])(
    "becomes read-only at midnight Sydney after the last day (%s)",
    async (_label, lastDay, expected) => {
      const { readOnlyFrom } = await startTrial(lastDay);
      expect(readOnlyFrom?.toISOString()).toBe(expected);
    },
  );

  it("derives read_only_from in the database, ignoring app input", async () => {
    const updated = await client.company.update({
      where: { id: companyId },
      data: { readOnlyFrom: new Date("2099-01-01T00:00:00Z") },
      select: { readOnlyFrom: true },
    });
    expect(updated.readOnlyFrom?.toISOString()).toBe(
      "2026-10-03T14:00:00.000Z",
    );
  });

  it("refuses a trial without dates and a trial demo company", async () => {
    const extra = { ...factory.company(owner.id), isDemo: false };
    await expect(
      client.$transaction(async (tx) => {
        await tx.company.create({ data: { ...extra, accessMode: "trial" } });
        await tx.membership.create({
          data: factory.membership(extra.id, owner.id),
        });
      }),
    ).rejects.toThrow(/companies_trial_fields/);
    await expect(
      client.$transaction(async (tx) => {
        await tx.company.create({
          data: {
            ...factory.company(owner.id),
            isDemo: true,
            accessMode: "trial",
            trialStartedAt: new Date(),
            trialLastDay: day("2026-12-01"),
          },
        });
      }),
    ).rejects.toThrow(/companies_demo_unrestricted/);
  });

  it("allows one self-service company per user", async () => {
    await client.company.update({
      where: { id: companyId },
      data: { selfServiceOwnerId: owner.id, selfServiceRequestKey: "k-1" },
    });
    const second = { ...factory.company(owner.id), isDemo: false };
    await expect(
      client.$transaction(async (tx) => {
        await tx.company.create({
          data: { ...second, selfServiceOwnerId: owner.id },
        });
        await tx.membership.create({
          data: factory.membership(second.id, owner.id),
        });
      }),
    ).rejects.toThrow(/self_service_owner_id/);
  });
});

describe("actor-aware company audit", () => {
  it("requires a member for member events and none for system events", async () => {
    await expect(
      client.auditEvent.create({
        data: {
          companyId,
          actorKind: "member",
          action: "company.test_event",
          targetType: "company",
          targetId: companyId,
        },
      }),
    ).rejects.toThrow(/audit_events_actor/);
    await expect(
      client.auditEvent.create({
        data: {
          companyId,
          createdBy: owner.id,
          actorKind: "system",
          action: "company.test_event",
          targetType: "company",
          targetId: companyId,
        },
      }),
    ).rejects.toThrow(/audit_events_actor/);
    const system = await client.auditEvent.create({
      data: {
        companyId,
        actorKind: "system",
        action: "company.test_event",
        targetType: "company",
        targetId: companyId,
      },
    });
    expect(system.createdBy).toBeNull();
  });
});

describe("account tokens, terms and outbox", () => {
  const hash = (n: number) => n.toString(16).padStart(64, "0");

  it("keeps one live token per user and purpose and stores only hex digests", async () => {
    const token = (n: number) => ({
      userId: owner.id,
      purpose: "email_verification" as const,
      tokenHash: hash(n),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const first = await client.accountToken.create({ data: token(1) });
    await expect(
      client.accountToken.create({ data: token(2) }),
    ).rejects.toThrow(/account_tokens_one_live|Unique constraint/);
    await client.accountToken.update({
      where: { id: first.id },
      data: { supersededAt: new Date() },
    });
    await client.accountToken.create({ data: token(2) });
    await expect(
      client.accountToken.create({
        data: {
          ...token(3),
          purpose: "password_reset",
          tokenHash: "Z".repeat(64),
        },
      }),
    ).rejects.toThrow(/account_tokens_token_hash_hex/);
  });

  it("keeps terms acceptances and platform audit append-only", async () => {
    await client.termsAcceptance.create({
      data: {
        userId: owner.id,
        termsVersion: "placeholder-1",
        privacyVersion: "placeholder-1",
      },
    });
    await client.platformAuditEvent.create({
      data: { actorKind: "anonymous", action: "account.sign_up_requested" },
    });
    await expect(
      client.termsAcceptance.updateMany({ data: { termsVersion: "x" } }),
    ).rejects.toThrow();
    await expect(client.platformAuditEvent.deleteMany({})).rejects.toThrow();
  });

  it("refuses a sent email that still holds its payload", async () => {
    await expect(
      client.emailOutbox.create({
        data: {
          kind: "verify_email",
          dedupeKey: "verify:test",
          status: "sent",
          payloadCiphertext: Buffer.from("secret"),
        },
      }),
    ).rejects.toThrow(/email_outbox_payload_cleared/);
  });
});

describe("S13 backfill", () => {
  it("marks every existing company unrestricted with one system event", async () => {
    // Reapply the migration over existing data, as a production deploy does.
    const sql = (file: string) =>
      readFile(
        new URL(`../../packages/database/prisma/${file}`, import.meta.url),
        "utf8",
      );
    const fresh = factory.company(owner.id);
    const freshOwner = factory.user();
    await client.$transaction(async (tx) => {
      await tx.user.create({ data: freshOwner });
      await tx.company.create({ data: { ...fresh, createdBy: freshOwner.id } });
      await tx.membership.create({
        data: factory.membership(fresh.id, freshOwner.id),
      });
    });
    // The rollback needs no system events and no sign-up rows to exist.
    await client.$executeRawUnsafe(
      "ALTER TABLE audit_events DISABLE TRIGGER USER",
    );
    await client.$executeRawUnsafe(
      "DELETE FROM audit_events WHERE actor_kind <> 'member'",
    );
    await client.$executeRawUnsafe(
      "ALTER TABLE audit_events ENABLE TRIGGER USER",
    );
    await client.$executeRawUnsafe(
      "UPDATE companies SET self_service_owner_id = NULL, self_service_request_key = NULL, access_mode = 'unrestricted', trial_started_at = NULL, trial_last_day = NULL",
    );
    await client.$executeRawUnsafe(
      await sql("rollbacks/20261103100000_signup_accounts.sql"),
    );
    await client.$executeRawUnsafe(
      await sql("migrations/20261103100000_signup_accounts/migration.sql"),
    );
    const companies = await client.company.findMany({
      select: { id: true, accessMode: true, readOnlyFrom: true },
    });
    expect(companies.length).toBeGreaterThanOrEqual(2);
    for (const company of companies) {
      expect(company).toMatchObject({
        accessMode: "unrestricted",
        readOnlyFrom: null,
      });
      const events = await client.auditEvent.findMany({
        where: { companyId: company.id, action: "company.access_initialised" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorKind: "system", createdBy: null });
    }
  });
});
