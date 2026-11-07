import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { decryptPayload } from "../../apps/web/src/server/email/crypto";
import {
  dismissNotice,
  loadNotices,
} from "../../apps/web/src/server/trial/notices";
import { runTrialReminders } from "../../apps/web/src/server/trial/reminders";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #233 (S10): reminders go once per threshold and last day, only to active
// verified owners, and an extension re-arms them.
const SECRET = randomBytes(32).toString("hex");
const APP_URL = "https://jobflow.invalid";
const ORIGIN = "http://127.0.0.1:3000";
const SUPPORT = "support@jobflow.invalid";
const PASSWORD = "correct horse battery staple";
/** 1:00 pm on 10 Nov 2026 in Sydney. */
const NOW = new Date("2026-11-10T02:00:00Z");
const factory = syntheticFactory(0x2330);

let database: CommittedDatabase;
let db: PrismaClient;
let serial = 0;

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
}, 90_000);
afterAll(() => database?.release());

const run = (now = NOW) =>
  runTrialReminders({
    db,
    emailSecret: SECRET,
    appUrl: APP_URL,
    supportEmail: SUPPORT,
    now: () => now,
  });

/** Today is 10 Nov, so `daysLeft` = 7 means the last day is 16 Nov. */
function lastDayFor(daysLeft: number): string {
  const day = new Date(Date.UTC(2026, 10, 10 + daysLeft - 1));
  return day.toISOString().slice(0, 10);
}

async function user(name: string, verified = true) {
  serial += 1;
  const created = await createCredentialUser(db, {
    email: `${name}${serial}@jobflow.invalid`,
    name: `Synthetic ${name}`,
    password: PASSWORD,
  });
  await db.user.update({
    where: { id: created.id },
    data: { emailVerified: verified },
  });
  return created;
}

async function company(
  daysLeft: number | null,
  overrides: Record<string, unknown> = {},
) {
  const owner = await user("owner");
  const record = factory.company(owner.id);
  await db.$transaction(async (tx) => {
    await tx.company.create({
      data: {
        ...record,
        isDemo: false,
        ...(daysLeft === null
          ? { accessMode: "unrestricted" }
          : {
              accessMode: "trial",
              trialStartedAt: new Date("2026-10-01T00:00:00Z"),
              trialLastDay: new Date(`${lastDayFor(daysLeft)}T00:00:00Z`),
            }),
        ...overrides,
      },
    });
    await tx.membership.create({
      data: factory.membership(record.id, owner.id),
    });
  });
  return { id: record.id, owner };
}

const outbox = (companyId: string) =>
  db.emailOutbox.findMany({
    where: { companyId, kind: "trial_reminder" },
    orderBy: { createdAt: "asc" },
  });
const thresholds = async (companyId: string) =>
  (
    await db.trialNotification.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
    })
  ).map((row) => row.threshold);

describe("trial reminder emails (#233)", () => {
  it.each([
    [8, []],
    [7, ["d7"]],
    [4, ["d7"]],
    [3, ["d3"]],
    [2, ["d3"]],
    [1, ["d1"]],
    [0, ["ended"]],
    [-30, ["ended"]],
  ])("with %i days left it sends %j", async (daysLeft, expected) => {
    const { id } = await company(daysLeft);
    await run();
    expect(await thresholds(id)).toEqual(expected);
    expect(await outbox(id)).toHaveLength(expected.length);
  });

  it("sends each threshold once, even with runs overlapping", async () => {
    const { id } = await company(7);
    await Promise.all([run(), run(), run()]);
    await run();
    expect(await thresholds(id)).toEqual(["d7"]);
    expect(await outbox(id)).toHaveLength(1);
  });

  it("walks through the thresholds as the days pass", async () => {
    const { id } = await company(7);
    for (const [at, count] of [
      ["2026-11-10T02:00:00Z", 1],
      ["2026-11-11T02:00:00Z", 1],
      ["2026-11-14T02:00:00Z", 2],
      ["2026-11-16T02:00:00Z", 3],
      ["2026-11-17T02:00:00Z", 4],
      ["2026-11-18T02:00:00Z", 4],
    ] as const) {
      await run(new Date(at));
      expect(await outbox(id), at).toHaveLength(count);
    }
    expect(await thresholds(id)).toEqual(["d7", "d3", "d1", "ended"]);
  });

  it("never sends an earlier threshold after a later one", async () => {
    const { id } = await company(2);
    await run();
    expect(await thresholds(id)).toEqual(["d3"]);
    // The clock going back (or a stale host) can't send the earlier one.
    await run(new Date("2026-11-07T02:00:00Z"));
    expect(await thresholds(id)).toEqual(["d3"]);
  });

  it("goes only to active owners with a verified email", async () => {
    const { id, owner } = await company(7);
    const unverified = await user("unverifiedowner", false);
    const inactive = await user("inactiveowner");
    const accountant = await user("accountant");
    await db.membership.createMany({
      data: [
        {
          companyId: id,
          userId: unverified.id,
          createdBy: owner.id,
          role: "owner",
        },
        {
          companyId: id,
          userId: inactive.id,
          createdBy: owner.id,
          role: "owner",
          isActive: false,
        },
        {
          companyId: id,
          userId: accountant.id,
          createdBy: owner.id,
          role: "accountant",
        },
      ],
    });
    await run();
    expect((await outbox(id)).map((row) => row.userId)).toEqual([owner.id]);
  });

  it("sends nothing for demo or unrestricted companies", async () => {
    const demo = await company(null, { isDemo: true });
    const unrestricted = await company(null);
    await run();
    for (const { id } of [demo, unrestricted]) {
      expect(await thresholds(id)).toEqual([]);
      expect(await outbox(id)).toEqual([]);
    }
  });

  it("re-arms every threshold after an extension", async () => {
    const { id } = await company(1);
    await run();
    expect(await thresholds(id)).toEqual(["d1"]);
    await db.company.update({
      where: { id },
      data: { trialLastDay: new Date(`${lastDayFor(7)}T00:00:00Z`) },
    });
    await run();
    expect(await thresholds(id)).toEqual(["d1", "d7"]);
  });

  it("gives the Sydney date, read-only meaning and both ways to extend", async () => {
    const { id } = await company(7);
    await run();
    const [row] = await outbox(id);
    const message = decryptPayload(SECRET, row!.payloadCiphertext!);
    expect(message.subject).toBe("Your JobFlow trial ends on 16 Nov 2026");
    expect(message.text).toContain("16 Nov 2026 (Sydney time)");
    expect(message.text).toContain("read-only");
    expect(message.text).toContain("view and export");
    expect(message.text).toContain(`${APP_URL}/settings/trial`);
    expect(message.text).toContain(SUPPORT);
  });

  it("logs by row ID, never by address", async () => {
    const write = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { id, owner } = await company(7);
    await run();
    const output = JSON.stringify(write.mock.calls);
    write.mockRestore();
    expect(output).toContain(id);
    expect(output).not.toContain(owner.email);
    expect(output).not.toContain("@jobflow.invalid");
  });

  it("carries on when one company fails", async () => {
    const good = await company(7);
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: never) => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error("database hiccup"))
            : target.$transaction(work);
        };
      },
    });
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const result = await runTrialReminders({
      db: flaky,
      emailSecret: SECRET,
      appUrl: APP_URL,
      now: () => NOW,
    });
    error.mockRestore();
    expect(result.failed).toBe(1);
    await run();
    expect(await thresholds(good.id)).toEqual(["d7"]);
  });
});

describe("one-time notices (#233)", () => {
  const load = (
    target: { id: string; owner: { id: string } },
    daysLeft: number,
    overrides: Partial<Parameters<typeof loadNotices>[1]> = {},
  ) =>
    loadNotices(db, {
      userId: target.owner.id,
      companyId: target.id,
      role: "owner",
      isDemo: false,
      trialLastDay: lastDayFor(daysLeft),
      support: SUPPORT,
      now: NOW,
      ...overrides,
    });

  it.each([
    [7, "trial.threshold.7", "Your trial ends on 16 Nov 2026."],
    [3, "trial.threshold.3", "3 days left in your trial."],
    [1, "trial.threshold.1", "Today is the last day of your trial."],
    [0, "trial.threshold.ended", "You can still view and export"],
  ])("with %i days left it shows %s once", async (days, prefix, text) => {
    const target = await company(days);
    const [notice, ...rest] = await load(target, days);
    expect(rest).toEqual([]);
    expect(notice!.noticeKey).toBe(`${prefix}:${lastDayFor(days)}`);
    expect(notice!.text).toContain(text);
    expect(notice!.canRequest).toBe(true);
    expect(await load(target, days)).toEqual([]);
  });

  it("shows nothing with more than 7 days left, or to other people", async () => {
    const target = await company(7);
    expect(await load(target, 8)).toEqual([]);
    expect(await load(target, 7, { role: "accountant" })).toEqual([]);
    expect(await load(target, 7, { isDemo: true })).toEqual([]);
    expect(await load(target, 7, { trialLastDay: null })).toEqual([]);
  });

  it("re-arms for a new last day", async () => {
    const target = await company(7);
    expect(await load(target, 7)).toHaveLength(1);
    expect(await load(target, 6)).toHaveLength(1);
  });

  it("shows only one of several tabs the notice", async () => {
    const target = await company(7);
    const shown = await Promise.all([load(target, 7), load(target, 7)]);
    expect(shown.flat()).toHaveLength(1);
  });

  it("keeps showing an extension notice until it's dismissed", async () => {
    const target = await company(30);
    const noticeKey = "trial.extended:2026-12-15";
    await db.userNotice.create({
      data: { userId: target.owner.id, companyId: target.id, noticeKey },
    });
    const expected = [
      {
        noticeKey,
        text: "Your trial was extended to 15 Dec 2026.",
        canRequest: false,
      },
    ];
    expect(await load(target, 30)).toEqual(expected);
    expect(await load(target, 30)).toEqual(expected);
    await db.userNotice.updateMany({
      where: { noticeKey, userId: target.owner.id },
      data: { dismissedAt: NOW },
    });
    expect(await load(target, 30)).toEqual([]);
  });

  it("shows a declined request with the operator's reason", async () => {
    const target = await company(30);
    const membership = await db.membership.findFirstOrThrow({
      where: { companyId: target.id },
    });
    const operator = await user("operator");
    await db.platformOperator.create({
      data: {
        userId: operator.id,
        grantedReason: "Synthetic",
        grantedBy: "test",
      },
    });
    const request = await db.trialExtensionRequest.create({
      data: {
        companyId: target.id,
        requestedBy: membership.userId,
        lastDayAtRequest: new Date("2026-12-09T00:00:00Z"),
      },
    });
    await db.trialExtensionRequest.update({
      where: { id: request.id },
      data: {
        status: "declined",
        decidedAt: NOW,
        decidedBy: operator.id,
        decisionNote: "<b>Not eligible</b>",
      },
    });
    await db.userNotice.createMany({
      data: [
        {
          userId: target.owner.id,
          companyId: target.id,
          noticeKey: `trial.declined:${request.id}`,
        },
      ],
    });
    const [notice] = await load(target, 30);
    // Plain text here; React escapes it when it's shown.
    expect(notice!.text).toBe(
      "Your extension request was declined: <b>Not eligible</b>",
    );
  });
});

describe("POST /api/notices/dismiss (#233)", () => {
  const handler = (session: unknown) =>
    dismissNotice({
      db: () => db,
      auth: () => ({ api: { getSession: async () => session } }) as never,
      trustedOrigins: () => [ORIGIN],
      now: () => NOW,
    });
  const send = (body: unknown, session: unknown, origin = ORIGIN) =>
    handler(session)(
      new Request(`${ORIGIN}/api/notices/dismiss`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const sessionOf = (id: string, emailVerified = true) => ({
    user: { id, emailVerified, email: "x@example.org" },
  });

  it("dismisses only the caller's own notice", async () => {
    const mine = await company(30);
    const theirs = await company(30);
    const noticeKey = "trial.extended:2026-12-15";
    for (const target of [mine, theirs])
      await db.userNotice.create({
        data: { userId: target.owner.id, companyId: target.id, noticeKey },
      });
    const response = await send(
      { noticeKey, companyId: mine.id },
      sessionOf(mine.owner.id),
    );
    expect(response.status).toBe(204);
    const dismissed = async (target: typeof mine) =>
      (
        await db.userNotice.findFirstOrThrow({
          where: { userId: target.owner.id, noticeKey },
        })
      ).dismissedAt;
    expect(await dismissed(mine)).not.toBeNull();
    expect(await dismissed(theirs)).toBeNull();
    // Someone else's company or notice: 204 and no change.
    expect(
      (
        await send(
          { noticeKey, companyId: theirs.id },
          sessionOf(mine.owner.id),
        )
      ).status,
    ).toBe(204);
    expect(await dismissed(theirs)).toBeNull();
  });

  it("needs a session, a verified email, a trusted origin and valid input", async () => {
    const { owner } = await company(30);
    const body = { noticeKey: "trial.extended:2026-12-15" };
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, sessionOf(owner.id, false))).status).toBe(403);
    expect(
      (await send(body, sessionOf(owner.id), "https://evil.example")).status,
    ).toBe(403);
    expect((await send({}, sessionOf(owner.id))).status).toBe(400);
    expect(
      (await send({ ...body, extra: 1 }, sessionOf(owner.id))).status,
    ).toBe(400);
    expect(
      (await send({ noticeKey: "a".repeat(101) }, sessionOf(owner.id))).status,
    ).toBe(400);
  });
});
