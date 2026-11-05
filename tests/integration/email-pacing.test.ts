import { spawn } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { addressDigest } from "../../apps/web/src/server/email/crypto";
import {
  BLOCKED_PAUSE_MS,
  DEFAULT_MAX_PER_HOUR,
  MAX_ATTEMPTS,
  MAX_PAUSE_MS,
  MAX_RATE_LIMITED_PER_ROW,
  RATE_LIMIT_PAUSE_MS,
  classifySendError,
  dispatchOutbox,
  enqueueEmail,
  maxPerHourFromEnv,
  pauseMs,
} from "../../apps/web/src/server/email/outbox";
import {
  suppressAddress,
  unsuppressAddress,
} from "../../apps/web/src/server/email/suppression";
import {
  type EmailTransport,
  MemoryTransport,
} from "../../apps/web/src/server/email/transport";
import { setLogSink } from "../../apps/web/src/server/log";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";

// #259: pacing under Zoho's hourly limit, account emails first, throttling
// and block replies, and the host suppression CLI.
const SECRET = "test-outbox-key-0123456789abcdef-0123456789";
const HOUR = 3_600_000;
let database: CommittedDatabase;
let client: PrismaClient;
let logs: string[] = [];
let restoreLog: () => void = () => undefined;

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
}, 60_000);
afterAll(() => database?.release());
beforeEach(async () => {
  await client.emailOutbox.deleteMany({});
  await client.emailSuppression.deleteMany({});
  await client.emailSendAttempt.deleteMany({});
  await client.emailDispatchState.update({
    where: { id: 1 },
    data: { pausedUntil: null, pauseStreak: 0 },
  });
  logs = [];
  restoreLog = setLogSink((line) => logs.push(line));
});
afterEach(() => restoreLog());

const to = (n: number) => `person${n}@example.test`;
async function queue(kind: string, n: number, at?: Date) {
  await client.$transaction((tx) =>
    enqueueEmail(tx, SECRET, {
      kind,
      dedupeKey: `${kind}:${n}`,
      message: { to: to(n), subject: `Synthetic ${kind}`, text: "Hello" },
    }),
  );
  if (at)
    await client.emailOutbox.update({
      where: { dedupeKey: `${kind}:${n}` },
      data: { nextAttemptAt: at, createdAt: at },
    });
}
const row = (key: string) =>
  client.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: key } });
const pausedUntil = async () =>
  (await client.emailDispatchState.findUniqueOrThrow({ where: { id: 1 } }))
    .pausedUntil;
const refusing = (responseCode: number, response: string): EmailTransport => ({
  name: "refusing",
  send: () =>
    Promise.reject(
      Object.assign(new Error(`${response} ${to(1)}`), {
        responseCode,
        response: `${responseCode} ${response} ${to(1)}`,
      }),
    ),
});
/** Due now: a little after the rows' database-set next_attempt_at. */
const soon = () => Date.now() + 1000;

describe("pacing (EMAIL_MAX_PER_HOUR)", () => {
  it("reads the cap from the environment; 0 or junk is an error, not a silent default", () => {
    expect(DEFAULT_MAX_PER_HOUR).toBe(40);
    expect(maxPerHourFromEnv({})).toBe(40);
    expect(maxPerHourFromEnv({ EMAIL_MAX_PER_HOUR: "25" })).toBe(25);
    for (const bad of ["0", "-1", "2.5", "lots"])
      expect(maxPerHourFromEnv({ EMAIL_MAX_PER_HOUR: bad }), bad).toBe(40);
    expect(logs.filter((l) => l.includes("email.config_invalid"))).toHaveLength(
      1,
    );
  });

  it("sends at most the cap in a rolling hour, across sweeps; the rest stay pending", async () => {
    const start = soon();
    for (let n = 1; n <= 5; n += 1)
      await queue("trial_reminder", n, new Date(start - 2000));
    const transport = new MemoryTransport();
    const at = (ms: number) => () => new Date(start + ms);
    expect(
      await dispatchOutbox(client, transport, SECRET, {
        maxPerHour: 3,
        now: at(0),
      }),
    ).toMatchObject({ sent: 3, paced: true });
    expect(
      await dispatchOutbox(client, transport, SECRET, {
        maxPerHour: 3,
        now: at(30 * 60_000),
      }),
    ).toMatchObject({ sent: 0, paced: true });
    expect(
      await client.emailOutbox.count({ where: { status: "pending" } }),
    ).toBe(2);
    expect(
      await dispatchOutbox(client, transport, SECRET, {
        maxPerHour: 3,
        now: at(HOUR + 1000),
      }),
    ).toMatchObject({ sent: 2, paced: false });
    expect(transport.sent).toHaveLength(5);
  });

  it("counts failed sends toward the cap, not only successful ones", async () => {
    for (let n = 1; n <= 5; n += 1) await queue("trial_reminder", n);
    const now = soon();
    const result = await dispatchOutbox(
      client,
      refusing(552, "Mailbox full"),
      SECRET,
      { maxPerHour: 3, now: () => new Date(now) },
    );
    expect(result).toMatchObject({ failed: 3, paced: true });
    expect(await client.emailSendAttempt.count()).toBe(3);
  });

  it("holds the cap exactly when dispatchers run at the same time", async () => {
    for (let n = 1; n <= 8; n += 1) await queue("trial_reminder", n);
    const transport = new MemoryTransport();
    const now = soon();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        dispatchOutbox(client, transport, SECRET, {
          maxPerHour: 3,
          now: () => new Date(now),
        }),
      ),
    );
    expect(results.reduce((total, r) => total + r.sent, 0)).toBe(3);
    expect(transport.sent).toHaveLength(3);
  });

  it("claims account emails before reminders and notices, whatever their age", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await queue("trial_reminder", 1, old);
    await queue("trial_notice", 2, old);
    await queue("password_reset", 3);
    await queue("verify_email", 4);
    const transport = new MemoryTransport();
    const now = soon();
    await dispatchOutbox(client, transport, SECRET, {
      maxPerHour: 2,
      now: () => new Date(now),
    });
    expect(transport.sent.map((m) => m.to).sort()).toEqual([to(3), to(4)]);
    expect((await row("trial_reminder:1")).status).toBe("pending");
    expect((await row("trial_notice:2")).status).toBe("pending");
  });

  it("prunes attempt records older than two hours", async () => {
    await client.emailSendAttempt.create({
      data: { attemptedAt: new Date(Date.now() - 3 * HOUR) },
    });
    await queue("verify_email", 1);
    await dispatchOutbox(client, new MemoryTransport(), SECRET, {
      now: () => new Date(soon()),
    });
    expect(await client.emailSendAttempt.count()).toBe(1);
  });
});

describe("classifying send errors", () => {
  it("treats SMTP 4xx as throttling and only narrow 5xx phrases as limits or blocks", () => {
    const c = (responseCode: number, response = "") =>
      classifySendError({ responseCode, response });
    expect(c(421, "Too many connections")).toBe("throttled");
    expect(c(451)).toBe("throttled");
    expect(c(554, "5.4.6 Outgoing mail quota exceeded")).toBe("throttled");
    expect(c(554, "Unusual sending activity detected")).toBe("throttled");
    expect(c(550, "Sending limit exceeded for today")).toBe("throttled");
    expect(c(554, "5.1.8 Email Outgoing Blocked")).toBe("blocked");
    expect(c(554, "Your account has been blocked")).toBe("blocked");
    for (const text of [
      "Mailbox unavailable",
      "Rejected by corporate policy",
      "Content moderated",
      "Failed to generate NDR",
      "Message rated as spam",
    ])
      expect(c(554, text), text).toBe("other");
    expect(c(552)).toBe("other");
    expect(classifySendError(new Error("ECONNRESET"))).toBe("other");
    expect(classifySendError(undefined)).toBe("other");
  });

  it("backs off 15, 30, 60, 120 minutes and caps at 4 hours; a block waits at least an hour", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => pauseMs(n, "throttled"))).toEqual([
      RATE_LIMIT_PAUSE_MS,
      2 * RATE_LIMIT_PAUSE_MS,
      4 * RATE_LIMIT_PAUSE_MS,
      8 * RATE_LIMIT_PAUSE_MS,
      MAX_PAUSE_MS,
      MAX_PAUSE_MS,
    ]);
    expect(pauseMs(1, "blocked")).toBe(BLOCKED_PAUSE_MS);
    expect(pauseMs(5, "blocked")).toBe(MAX_PAUSE_MS);
  });
});

describe("throttling and block replies", () => {
  it.each([
    [421, "Too many connections", "email.rate_limited", RATE_LIMIT_PAUSE_MS],
    [
      554,
      "5.4.6 Outgoing mail quota exceeded",
      "email.rate_limited",
      RATE_LIMIT_PAUSE_MS,
    ],
    [
      554,
      "5.1.8 Email Outgoing Blocked",
      "email.provider_blocked",
      BLOCKED_PAUSE_MS,
    ],
  ])(
    "a %i pauses every dispatcher, uses no attempt, puts the row behind the others and logs %s at error with no address",
    async (code, text, event, pause) => {
      await queue("verify_email", 1);
      await queue("trial_reminder", 2);
      const now = soon();
      const result = await dispatchOutbox(
        client,
        refusing(code, text),
        SECRET,
        {
          now: () => new Date(now),
        },
      );
      expect(result).toMatchObject({ sent: 0, failed: 0, rateLimited: true });
      const until = now + pause;
      expect((await pausedUntil())?.getTime()).toBe(until);
      const refused = await row("verify_email:1");
      expect(refused).toMatchObject({
        status: "pending",
        attempts: 0,
        rateLimitedCount: 1,
      });
      expect(refused.nextAttemptAt.getTime()).toBeGreaterThan(until);
      const line = logs.find((entry) => entry.includes(event));
      expect(JSON.parse(line!)).toMatchObject({ level: "error" });
      expect(logs.join("\n")).not.toMatch(
        /@example\.test|quota|connections|outgoing blocked/i,
      );

      // Nothing goes during the pause; then the other row goes first.
      const transport = new MemoryTransport();
      expect(
        await dispatchOutbox(client, transport, SECRET, {
          now: () => new Date(until - 1),
        }),
      ).toMatchObject({ sent: 0, paused: true });
      expect(
        await dispatchOutbox(client, transport, SECRET, {
          now: () => new Date(until),
        }),
      ).toMatchObject({ sent: 1 });
      expect(transport.sent.map((m) => m.to)).toEqual([to(2)]);
    },
  );

  it("holds the pause for email queued during it", async () => {
    await queue("trial_reminder", 1);
    const now = soon();
    await dispatchOutbox(client, refusing(421, "Try later"), SECRET, {
      now: () => new Date(now),
    });
    await queue("verify_email", 2); // a sign-up during the pause
    const transport = new MemoryTransport();
    const during = await dispatchOutbox(client, transport, SECRET, {
      now: () => new Date(now + 60_000),
    });
    expect(during).toMatchObject({ sent: 0, paused: true });
    expect(transport.sent).toEqual([]);
    expect((await pausedUntil())?.getTime()).toBe(now + RATE_LIMIT_PAUSE_MS);
  });

  it("doubles the pause for each throttling reply in a row, and resets after a send", async () => {
    await queue("trial_reminder", 1);
    await queue("trial_reminder", 2);
    await queue("trial_reminder", 3);
    let now = soon();
    await dispatchOutbox(client, refusing(421, "Try later"), SECRET, {
      now: () => new Date(now),
    });
    now = (await pausedUntil())!.getTime();
    await dispatchOutbox(client, refusing(421, "Try later"), SECRET, {
      now: () => new Date(now),
    });
    expect((await pausedUntil())!.getTime() - now).toBe(
      2 * RATE_LIMIT_PAUSE_MS,
    );
    now = (await pausedUntil())!.getTime();
    await dispatchOutbox(client, new MemoryTransport(), SECRET, {
      limit: 1,
      now: () => new Date(now),
    });
    expect(
      (await client.emailDispatchState.findUniqueOrThrow({ where: { id: 1 } }))
        .pauseStreak,
    ).toBe(0);
  });

  it.each([
    [421, "Try later"],
    [554, "5.1.8 Email Outgoing Blocked"],
  ])(
    "marks a row failed on its 5th throttling or block reply (owner decision), still pausing the provider (%i)",
    async (code, text) => {
      expect(MAX_RATE_LIMITED_PER_ROW).toBe(5);
      await queue("verify_email", 1);
      await client.emailOutbox.update({
        where: { dedupeKey: "verify_email:1" },
        data: { rateLimitedCount: MAX_RATE_LIMITED_PER_ROW - 1 },
      });
      const result = await dispatchOutbox(
        client,
        refusing(code, text),
        SECRET,
        { now: () => new Date(soon()) },
      );
      expect(result).toMatchObject({ failed: 1, rateLimited: true });
      expect(await row("verify_email:1")).toMatchObject({
        status: "failed",
        attempts: 0,
        rateLimitedCount: MAX_RATE_LIMITED_PER_ROW,
        payloadCiphertext: null,
      });
      expect(await pausedUntil()).not.toBeNull();
      expect(
        JSON.parse(logs.find((l) => l.includes("markedFailed"))!),
      ).toMatchObject({ level: "error", rateLimitedCount: 5 });
    },
  );

  it("keeps a row pending on its 4th throttling reply", async () => {
    await queue("verify_email", 1);
    await client.emailOutbox.update({
      where: { dedupeKey: "verify_email:1" },
      data: { rateLimitedCount: MAX_RATE_LIMITED_PER_ROW - 2 },
    });
    await dispatchOutbox(client, refusing(421, "Try later"), SECRET, {
      now: () => new Date(soon()),
    });
    expect(await row("verify_email:1")).toMatchObject({
      status: "pending",
      rateLimitedCount: MAX_RATE_LIMITED_PER_ROW - 1,
    });
    expect(MAX_ATTEMPTS).toBe(8);
  });

  it("still counts a permanent 554 as a failed attempt", async () => {
    await queue("verify_email", 1);
    const result = await dispatchOutbox(
      client,
      refusing(554, "Mailbox unavailable"),
      SECRET,
      { now: () => new Date(soon()) },
    );
    expect(result).toMatchObject({ failed: 1, rateLimited: false });
    expect((await row("verify_email:1")).attempts).toBe(1);
  });
});

describe("suppression list", () => {
  it("stores only the HMAC, audits each change with who ran it, and is idempotent", async () => {
    const address = "Bounced.Person@Example.test";
    const hash = addressDigest(SECRET, address);
    expect(
      await suppressAddress(client, SECRET, ` ${address} `, "bounce", "aj"),
    ).toEqual({ addressHash: hash, changed: true });
    expect(
      await suppressAddress(client, SECRET, address, "bounce", "aj"),
    ).toEqual({ addressHash: hash, changed: false });
    expect(
      await suppressAddress(client, SECRET, address, "manual", "aj"),
    ).toEqual({ addressHash: hash, changed: true });
    expect(await unsuppressAddress(client, SECRET, address, "aj")).toEqual({
      addressHash: hash,
      changed: true,
    });
    expect(await unsuppressAddress(client, SECRET, address, "aj")).toEqual({
      addressHash: hash,
      changed: false,
    });
    const events = await client.platformAuditEvent.findMany({
      where: { action: { in: ["email.suppressed", "email.unsuppressed"] } },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.action)).toEqual([
      "email.suppressed",
      "email.suppressed",
      "email.unsuppressed",
    ]);
    for (const event of events) {
      expect(event.actorKind).toBe("operator");
      expect(event.metadata).toMatchObject({
        addressHash: hash,
        via: "cli",
        ranBy: "aj",
      });
    }
    expect(JSON.stringify(events)).not.toMatch(/bounced|example\.test/i);
  });

  it("refuses an unknown reason, a bad --by, and anything but one address", async () => {
    await expect(
      suppressAddress(
        client,
        SECRET,
        "a@example.test",
        "spam" as "bounce",
        "aj",
      ),
    ).rejects.toThrow(/bounce, complaint or manual/);
    await expect(
      suppressAddress(client, SECRET, "a@example.test", "manual", "a b"),
    ).rejects.toThrow(/--by/);
    for (const bad of [
      "",
      "nobody",
      "a@b",
      "a@example.test, b@example.test",
      "a b@example.test",
    ])
      await expect(
        suppressAddress(client, SECRET, bad, "manual", "aj"),
        bad,
      ).rejects.toThrow(/one email address/);
    expect(await client.emailSuppression.count()).toBe(0);
  });

  it("stops an email that was queued before the address was suppressed", async () => {
    await queue("trial_reminder", 1);
    await suppressAddress(client, SECRET, to(1), "complaint", "aj");
    const transport = new MemoryTransport();
    await dispatchOutbox(client, transport, SECRET, {
      now: () => new Date(soon()),
    });
    expect(transport.sent).toEqual([]);
    expect(await row("trial_reminder:1")).toMatchObject({
      status: "cancelled",
      payloadCiphertext: null,
    });
    expect(logs.join("\n")).not.toContain("example.test");
  });
});

describe("pnpm email (the real host command)", () => {
  const run = (args: string[], input: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn("pnpm", ["email", ...args], {
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          EMAIL_OUTBOX_KEY: SECRET,
        },
      });
      let out = "";
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (out += data));
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
      child.stdin.end(input);
    });

  it("reads the address from stdin and never prints it, even in pnpm's own echo", async () => {
    const address = "cli-person@example.test";
    const hash = addressDigest(SECRET, address);
    const added = await run(
      ["suppress", "--reason", "manual", "--by", "aj"],
      `${address}\n`,
    );
    expect(added.code, added.out).toBe(0);
    expect(added.out).toContain(`Suppressed (${hash.slice(0, 12)}…)`);
    expect(added.out).not.toContain(address);
    expect(
      await client.emailSuppression.count({ where: { addressHash: hash } }),
    ).toBe(1);
    const removed = await run(["unsuppress", "--by", "aj"], `${address}\n`);
    expect(removed.code, removed.out).toBe(0);
    expect(removed.out).not.toContain(address);
    expect(
      await client.emailSuppression.count({ where: { addressHash: hash } }),
    ).toBe(0);
  }, 60_000);

  it("refuses --address, a bad reason or command, and empty input", async () => {
    for (const [args, input] of [
      [["suppress", "--address", "a@example.test", "--reason", "manual"], ""],
      [["suppress", "--reason", "spam"], "a@example.test\n"],
      [["suppress"], "a@example.test\n"],
      [["unsuppress", "--reason", "manual"], "a@example.test\n"],
      [["delete"], "a@example.test\n"],
      [["suppress", "--reason", "manual"], ""],
    ] as const) {
      const result = await run([...args], input);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.out, args.join(" ")).toMatch(
        /Usage: pnpm email|one email address/,
      );
    }
    expect(await client.emailSuppression.count()).toBe(0);
  }, 120_000);
});
