import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  DEFAULT_MAX_PER_HOUR,
  RATE_LIMIT_PAUSE_MS,
  dispatchOutbox,
  enqueueEmail,
  isRateLimited,
  maxPerHourFromEnv,
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
// replies, and the host suppression CLI.
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
const statuses = async () =>
  Object.fromEntries(
    (
      await client.emailOutbox.findMany({
        select: { dedupeKey: true, status: true },
      })
    ).map((row) => [row.dedupeKey, row.status]),
  );

describe("pacing (EMAIL_MAX_PER_HOUR)", () => {
  it("reads the cap from the environment, defaulting to 40", () => {
    expect(DEFAULT_MAX_PER_HOUR).toBe(40);
    expect(maxPerHourFromEnv({})).toBe(40);
    expect(maxPerHourFromEnv({ EMAIL_MAX_PER_HOUR: "25" })).toBe(25);
    for (const bad of ["0", "-1", "2.5", "lots", ""])
      expect(maxPerHourFromEnv({ EMAIL_MAX_PER_HOUR: bad }), bad).toBe(40);
  });

  it("sends at most the cap in a rolling hour, across sweeps; the rest stay pending", async () => {
    const start = Date.now();
    for (let n = 1; n <= 5; n += 1)
      await queue("trial_reminder", n, new Date(start - 1000));
    const transport = new MemoryTransport();
    const at = (ms: number) => () => new Date(start + ms);

    const first = await dispatchOutbox(client, transport, SECRET, {
      maxPerHour: 3,
      now: at(0),
    });
    expect(first).toMatchObject({ sent: 3, paced: true });
    // A later sweep within the hour sends nothing more.
    const second = await dispatchOutbox(client, transport, SECRET, {
      maxPerHour: 3,
      now: at(30 * 60_000),
    });
    expect(second).toMatchObject({ sent: 0, paced: true });
    expect(
      Object.values(await statuses()).filter((s) => s === "pending"),
    ).toHaveLength(2);
    // Once the first sends are an hour old, the rest go.
    const third = await dispatchOutbox(client, transport, SECRET, {
      maxPerHour: 3,
      now: () => new Date(Date.now() + HOUR + 1000),
    });
    expect(third).toMatchObject({ sent: 2, paced: false });
    expect(transport.sent).toHaveLength(5);
  });

  it("holds the cap exactly when dispatchers run at the same time", async () => {
    for (let n = 1; n <= 8; n += 1) await queue("trial_reminder", n);
    const transport = new MemoryTransport();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        dispatchOutbox(client, transport, SECRET, { maxPerHour: 3 }),
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
    await dispatchOutbox(client, transport, SECRET, { maxPerHour: 2 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual([to(3), to(4)]);
    expect(await statuses()).toMatchObject({
      "trial_reminder:1": "pending",
      "trial_notice:2": "pending",
    });
  });
});

describe("throttling replies", () => {
  const refusing = (
    responseCode: number,
    response: string,
  ): EmailTransport => ({
    name: "refusing",
    send: () =>
      Promise.reject(
        Object.assign(new Error(`${response} ${to(1)}`), {
          responseCode,
          response: `${responseCode} ${response} ${to(1)}`,
        }),
      ),
  });

  it("recognises SMTP 4xx and a 554 that mentions a limit, nothing else", () => {
    expect(isRateLimited({ responseCode: 421 })).toBe(true);
    expect(isRateLimited({ responseCode: 451 })).toBe(true);
    expect(
      isRateLimited({
        responseCode: 554,
        response: "5.4.6 Outgoing mail quota exceeded",
      }),
    ).toBe(true);
    expect(
      isRateLimited({ responseCode: 554, response: "Unusual sending rate" }),
    ).toBe(true);
    expect(
      isRateLimited({ responseCode: 554, response: "Mailbox unavailable" }),
    ).toBe(false);
    expect(isRateLimited({ responseCode: 552 })).toBe(false);
    expect(isRateLimited(new Error("ECONNRESET"))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });

  it.each([
    [421, "Too many connections"],
    [554, "5.4.6 Outgoing mail quota exceeded"],
  ])(
    "reschedules a %i without using an attempt, pauses the queue, and logs no address",
    async (code, text) => {
      await queue("verify_email", 1);
      await queue("trial_reminder", 2);
      const now = Date.now() + 1000;
      const result = await dispatchOutbox(
        client,
        refusing(code, text),
        SECRET,
        { now: () => new Date(now) },
      );
      expect(result).toMatchObject({ sent: 0, failed: 0, rateLimited: true });
      const rows = await client.emailOutbox.findMany({
        orderBy: { dedupeKey: "asc" },
      });
      for (const row of rows) {
        expect(row.status).toBe("pending");
        expect(row.attempts).toBe(0);
        expect(row.payloadCiphertext).not.toBeNull();
        expect(row.nextAttemptAt.getTime()).toBe(now + RATE_LIMIT_PAUSE_MS);
      }
      const line = logs.find((entry) => entry.includes("email.rate_limited"));
      expect(line).toBeDefined();
      expect(logs.join("\n")).not.toMatch(/@example\.test|quota|connections/i);
      // Nothing is tried again before the pause ends.
      const transport = new MemoryTransport();
      const early = await dispatchOutbox(client, transport, SECRET, {
        now: () => new Date(now + RATE_LIMIT_PAUSE_MS - 1),
      });
      expect(early.sent).toBe(0);
      const later = await dispatchOutbox(client, transport, SECRET, {
        now: () => new Date(now + RATE_LIMIT_PAUSE_MS),
      });
      expect(later.sent).toBe(2);
    },
  );

  it("still counts a permanent 554 as a failed attempt", async () => {
    await queue("verify_email", 1);
    const result = await dispatchOutbox(
      client,
      refusing(554, "Mailbox unavailable"),
      SECRET,
    );
    expect(result).toMatchObject({ failed: 1, rateLimited: false });
    const row = await client.emailOutbox.findFirstOrThrow({});
    expect(row.attempts).toBe(1);
  });
});

describe("suppression list", () => {
  it("stores only the HMAC, audits each change, and is idempotent", async () => {
    const address = "Bounced.Person@Example.test";
    const hash = addressDigest(SECRET, address);
    expect(
      await suppressAddress(client, SECRET, ` ${address} `, "bounce"),
    ).toEqual({ addressHash: hash, changed: true });
    expect(await suppressAddress(client, SECRET, address, "bounce")).toEqual({
      addressHash: hash,
      changed: false,
    });
    expect(await suppressAddress(client, SECRET, address, "manual")).toEqual({
      addressHash: hash,
      changed: true,
    });
    expect(
      await client.emailSuppression.findUniqueOrThrow({
        where: { addressHash: hash },
      }),
    ).toMatchObject({ reason: "manual" });
    expect(await unsuppressAddress(client, SECRET, address)).toEqual({
      addressHash: hash,
      changed: true,
    });
    expect(await unsuppressAddress(client, SECRET, address)).toEqual({
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
      expect(event.metadata).toMatchObject({ addressHash: hash, via: "cli" });
    }
    expect(JSON.stringify(events)).not.toMatch(/bounced|example\.test/i);
  });

  it("refuses an unknown reason and anything but one address", async () => {
    await expect(
      suppressAddress(client, SECRET, "a@example.test", "spam" as "bounce"),
    ).rejects.toThrow(/bounce, complaint or manual/);
    for (const bad of [
      "",
      "nobody",
      "a@b",
      "a@example.test, b@example.test",
      "a b@example.test",
    ])
      await expect(
        suppressAddress(client, SECRET, bad, "manual"),
        bad,
      ).rejects.toThrow(/one email address/);
    expect(await client.emailSuppression.count()).toBe(0);
  });

  it("stops an email that was queued before the address was suppressed", async () => {
    await queue("trial_reminder", 1);
    await suppressAddress(client, SECRET, to(1), "complaint");
    const transport = new MemoryTransport();
    await dispatchOutbox(client, transport, SECRET);
    expect(transport.sent).toEqual([]);
    const row = await client.emailOutbox.findFirstOrThrow({});
    expect(row).toMatchObject({ status: "cancelled", payloadCiphertext: null });
    expect(logs.join("\n")).not.toContain("example.test");
  });
});

describe("pnpm email (host CLI)", () => {
  const run = (args: string[]) =>
    promisify(execFile)(
      "pnpm",
      ["exec", "tsx", "scripts/email/cli.ts", ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          EMAIL_OUTBOX_KEY: SECRET,
        },
      },
    ).then(
      (out) => ({ code: 0, ...out }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );

  it("suppresses and unsuppresses by address, printing only a hash prefix", async () => {
    const address = "cli-person@example.test";
    const hash = addressDigest(SECRET, address);
    const added = await run([
      "suppress",
      "--address",
      address,
      "--reason",
      "manual",
    ]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain(`Suppressed (${hash.slice(0, 12)}…)`);
    expect(added.stdout + added.stderr).not.toContain(address);
    expect(
      await client.emailSuppression.count({ where: { addressHash: hash } }),
    ).toBe(1);
    const removed = await run(["unsuppress", "--address", address]);
    expect(removed.code).toBe(0);
    expect(
      await client.emailSuppression.count({ where: { addressHash: hash } }),
    ).toBe(0);
  }, 60_000);

  it("refuses a bad reason or command with the usage text", async () => {
    for (const args of [
      ["suppress", "--address", "a@example.test", "--reason", "spam"],
      ["suppress", "--address", "a@example.test"],
      ["unsuppress", "--address", "a@example.test", "--reason", "manual"],
      ["delete", "--address", "a@example.test"],
      ["suppress"],
    ]) {
      const result = await run(args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toMatch(/Usage: pnpm email/);
    }
    expect(await client.emailSuppression.count()).toBe(0);
  }, 120_000);
});
