import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  addressDigest,
  decryptPayload,
  encryptPayload,
} from "../../apps/web/src/server/email/crypto";
import {
  MAX_ATTEMPTS,
  cancelPendingEmail,
  dispatchOutbox,
  enqueueEmail,
  retryDelayMs,
} from "../../apps/web/src/server/email/outbox";
import {
  ConsoleTransport,
  type EmailTransport,
  MemoryTransport,
  SmtpTransport,
  transportFromEnv,
} from "../../apps/web/src/server/email/transport";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #214/#215: transactional outbox, encryption and SMTP transport selection.
const SECRET = "test-outbox-key-0123456789abcdef-0123456789";
let database: CommittedDatabase;
let client: PrismaClient;
const factory = syntheticFactory(0x2140);
const user = factory.user();

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
  await client.user.create({ data: user });
}, 60_000);
afterAll(() => database?.release());

const message = (to = "owner@example.test") => ({
  to,
  subject: "Verify your email",
  text: "Open https://jobflow.example.test/verify-email#token",
});

describe("payload encryption", () => {
  it("round-trips and never stores the address or link in clear text", () => {
    const sealed = encryptPayload(SECRET, message());
    expect(sealed.toString("latin1")).not.toContain("owner@example.test");
    expect(sealed.toString("latin1")).not.toContain("verify-email");
    expect(decryptPayload(SECRET, sealed)).toEqual(message());
  });

  it("rejects tampering, the wrong key and short secrets", () => {
    const sealed = encryptPayload(SECRET, message());
    const last = sealed.length - 1;
    sealed.writeUInt8(sealed.readUInt8(last) ^ 1, last);
    expect(() => decryptPayload(SECRET, sealed)).toThrow();
    expect(() =>
      decryptPayload(`${SECRET}x`, encryptPayload(SECRET, message())),
    ).toThrow();
    expect(() => encryptPayload("short", message())).toThrow(/32 characters/);
  });

  it("digests addresses case-insensitively", () => {
    expect(addressDigest(SECRET, " Owner@Example.TEST ")).toBe(
      addressDigest(SECRET, "owner@example.test"),
    );
  });
});

describe("outbox", () => {
  it("sends committed email once and clears the payload", async () => {
    await client.$transaction((tx) =>
      enqueueEmail(tx, SECRET, {
        kind: "verify_email",
        dedupeKey: "verify:one",
        userId: user.id,
        message: message(),
      }),
    );
    // Same dedupe key: no second email.
    await client.$transaction((tx) =>
      enqueueEmail(tx, SECRET, {
        kind: "verify_email",
        dedupeKey: "verify:one",
        message: message(),
      }),
    );
    const transport = new MemoryTransport();
    const [first, second] = await Promise.all([
      dispatchOutbox(client, transport, SECRET),
      dispatchOutbox(client, transport, SECRET),
    ]);
    expect(first.sent + second.sent).toBe(1);
    expect(transport.sent).toEqual([message()]);
    const row = await client.emailOutbox.findUniqueOrThrow({
      where: { dedupeKey: "verify:one" },
    });
    expect(row).toMatchObject({
      status: "sent",
      attempts: 1,
      payloadCiphertext: null,
    });
  });

  it("does not send email from a rolled-back transaction", async () => {
    await expect(
      client.$transaction(async (tx) => {
        await enqueueEmail(tx, SECRET, {
          kind: "verify_email",
          dedupeKey: "verify:rolled-back",
          message: message(),
        });
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    expect(
      await client.emailOutbox.count({
        where: { dedupeKey: "verify:rolled-back" },
      }),
    ).toBe(0);
  });

  it("retries with backoff and gives up after the last attempt", async () => {
    await client.$transaction((tx) =>
      enqueueEmail(tx, SECRET, {
        kind: "verify_email",
        dedupeKey: "verify:failing",
        message: message(),
      }),
    );
    const failing: EmailTransport = {
      name: "failing",
      send: () =>
        Promise.reject(
          Object.assign(new Error("552 mailbox full owner@example.test"), {
            responseCode: 552,
          }),
        ),
    };
    let clock = Date.now();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await dispatchOutbox(client, failing, SECRET, {
        now: () => new Date(clock),
      });
      expect(result.failed).toBe(1);
      clock += retryDelayMs(attempt) + 1;
    }
    const row = await client.emailOutbox.findUniqueOrThrow({
      where: { dedupeKey: "verify:failing" },
    });
    expect(row).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      payloadCiphertext: null,
    });
    expect(row.lastError).toBe("Error:552");
    expect(row.lastError).not.toContain("@");
  });

  it("cancels suppressed addresses and superseded pending email", async () => {
    await client.emailSuppression.create({
      data: {
        addressHash: addressDigest(SECRET, "bounced@example.test"),
        reason: "bounce",
      },
    });
    await client.$transaction(async (tx) => {
      await enqueueEmail(tx, SECRET, {
        kind: "verify_email",
        dedupeKey: "verify:suppressed",
        message: message("Bounced@example.test"),
      });
      await enqueueEmail(tx, SECRET, {
        kind: "verify_email",
        dedupeKey: "verify:superseded",
        userId: user.id,
        message: message(),
      });
      await cancelPendingEmail(tx, { userId: user.id, kind: "verify_email" });
    });
    const rows = await client.emailOutbox.findMany({
      where: { dedupeKey: { in: ["verify:suppressed", "verify:superseded"] } },
    });
    expect(rows.map((row) => [row.status, row.payloadCiphertext])).toEqual([
      ["cancelled", null],
      ["cancelled", null],
    ]);
  });
});

describe("transport selection", () => {
  it("uses Zoho SMTP when configured and refuses production without it", () => {
    expect(
      transportFromEnv(
        {
          SMTP_HOST: "smtppro.zoho.com.au",
          SMTP_PORT: "465",
          SMTP_USER: "admin@example.test",
          SMTP_PASSWORD: "app-password",
        },
        true,
      ),
    ).toBeInstanceOf(SmtpTransport);
    expect(transportFromEnv({}, false)).toBeInstanceOf(ConsoleTransport);
    expect(() => transportFromEnv({}, true)).toThrow(/SMTP is not configured/);
    expect(() =>
      transportFromEnv(
        { SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_PORT: "0" },
        false,
      ),
    ).toThrow(/SMTP_PORT/);
  });
});
