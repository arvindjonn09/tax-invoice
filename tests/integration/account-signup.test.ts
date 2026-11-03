import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  type AccountDependencies,
  resendVerification,
  signUp,
  verifyEmail,
} from "../../apps/web/src/server/account/handlers";
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "../../apps/web/src/server/account/terms";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { isVerified } from "../../apps/web/src/server/auth/actor";
import { decryptPayload } from "../../apps/web/src/server/email/crypto";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";

// #217/#218: public sign-up, email verification and resend (ADR 0004 D1).
const ORIGIN = "http://localhost:3000";
const SECRET = "test-outbox-key-0123456789abcdef-0123456789";
let database: CommittedDatabase;
let client: PrismaClient;
let breached = false;
let turnstileOk = true;
let production = false;

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = database.client;
}, 60_000);
afterAll(() => database?.release());

const deps: AccountDependencies = {
  db: () => client,
  auth: () =>
    createAuth({
      db: client,
      secret: "x".repeat(32),
      baseURL: ORIGIN,
      production: false,
    }),
  trustedOrigins: () => [ORIGIN],
  appUrl: () => ORIGIN,
  emailSecret: () => SECRET,
  production: () => production,
  dispatch: () => {},
  isBreached: async () => breached,
  verifyTurnstile: async () => turnstileOk,
};

let ipCounter = 0;
function post(path: string, body: unknown, ip = `198.51.100.${++ipCounter}`) {
  const text = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      "x-forwarded-for": ip,
    },
    body: text,
  });
}

const form = (email: string, extra: Record<string, unknown> = {}) => ({
  name: "Sam Sample",
  email,
  password: "correct horse battery",
  passwordConfirmation: "correct horse battery",
  acceptTerms: true,
  termsVersion: TERMS_VERSION,
  privacyVersion: PRIVACY_VERSION,
  ...extra,
});

async function emailsFor(email: string) {
  const user = await client.user.findUnique({ where: { email } });
  const rows = await client.emailOutbox.findMany({
    where: { userId: user?.id ?? "00000000-0000-0000-0000-000000000000" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    kind: row.kind,
    message: row.payloadCiphertext
      ? decryptPayload(SECRET, row.payloadCiphertext)
      : null,
    status: row.status,
  }));
}

const tokenFrom = (text: string) =>
  /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];

describe("sign-up", () => {
  it("creates an unverified user, records the terms and queues a verification email", async () => {
    const response = await signUp(deps)(
      post("/api/account/sign-up", form(" New.Owner@Example.com ")),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "check-email" });
    const user = await client.user.findUniqueOrThrow({
      where: { email: "new.owner@example.com" },
      include: { termsAcceptances: true, memberships: true },
    });
    expect(user).toMatchObject({ name: "Sam Sample", emailVerified: false });
    expect(user.termsAcceptances).toMatchObject([
      { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    ]);
    // Sign-up creates no company, membership or trial (S2 AC10).
    expect(user.memberships).toEqual([]);
    const [email] = await emailsFor("new.owner@example.com");
    expect(email?.kind).toBe("verify_email");
    expect(email?.message?.text).toContain(`${ORIGIN}/verify-email#token=`);
    // No user-entered text in mail to an unverified address (S2 AC9).
    expect(email?.message?.text).not.toContain("Sam");
  });

  it("answers an existing email identically and leaves that account unchanged", async () => {
    const before = await client.user.findUniqueOrThrow({
      where: { email: "new.owner@example.com" },
      include: { accounts: true },
    });
    const response = await signUp(deps)(
      post(
        "/api/account/sign-up",
        form("new.owner@example.com", { name: "Mallory" }),
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "check-email" });
    const after = await client.user.findUniqueOrThrow({
      where: { email: "new.owner@example.com" },
      include: { accounts: true },
    });
    expect(after.name).toBe(before.name);
    expect(after.accounts[0]?.password).toBe(before.accounts[0]?.password);
    const kinds = (await emailsFor("new.owner@example.com")).map((e) => e.kind);
    expect(kinds).toEqual(["verify_email", "account_exists"]);
  });

  it("creates exactly one account for concurrent sign-ups", async () => {
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        signUp(deps)(post("/api/account/sign-up", form("race@example.com"))),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
    expect(
      await client.user.count({ where: { email: "race@example.com" } }),
    ).toBe(1);
  });

  it("validates fields, terms, breached passwords and Turnstile", async () => {
    const bad = await signUp(deps)(
      post(
        "/api/account/sign-up",
        form("bad@example.com", {
          name: " ",
          password: "short",
          passwordConfirmation: "different",
          acceptTerms: false,
        }),
      ),
    );
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json()).fields).sort()).toEqual([
      "acceptTerms",
      "name",
      "password",
    ]);
    const mismatch = await signUp(deps)(
      post(
        "/api/account/sign-up",
        form("mismatch@example.com", {
          passwordConfirmation: "something else!",
        }),
      ),
    );
    expect(Object.keys((await mismatch.json()).fields)).toEqual([
      "passwordConfirmation",
    ]);
    const stale = await signUp(deps)(
      post(
        "/api/account/sign-up",
        form("stale@example.com", { termsVersion: "old" }),
      ),
    );
    expect((await stale.json()).code).toBe("terms_changed");
    const extra = await signUp(deps)(
      post(
        "/api/account/sign-up",
        form("extra@example.com", { companyId: "x" }),
      ),
    );
    expect(extra.status).toBe(400);
    breached = true;
    const leaked = await signUp(deps)(
      post("/api/account/sign-up", form("leaked@example.com")),
    );
    breached = false;
    expect((await leaked.json()).fields.password).toMatch(/data breach/);
    turnstileOk = false;
    const robot = await signUp(deps)(
      post("/api/account/sign-up", form("robot@example.com")),
    );
    turnstileOk = true;
    expect((await robot.json()).code).toBe("turnstile_failed");
    expect(
      await client.user.count({
        where: {
          email: {
            in: [
              "bad@example.com",
              "stale@example.com",
              "extra@example.com",
              "leaked@example.com",
              "robot@example.com",
            ],
          },
        },
      }),
    ).toBe(0);
  });

  it("throttles sign-up per IP and refuses cross-origin requests", async () => {
    const ip = "203.0.113.99";
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (
          await signUp(deps)(
            post("/api/account/sign-up", form(`throttle${i}@example.com`), ip),
          )
        ).status,
      );
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    const forged = post("/api/account/sign-up", form("csrf@example.com"));
    forged.headers.set("origin", "https://evil.example");
    expect((await signUp(deps)(forged)).status).toBe(403);
  });

  it("in production refuses reserved domains and stays closed with placeholder terms", async () => {
    production = true;
    const closed = await signUp(deps)(
      post("/api/account/sign-up", form("prod@example.com")),
    );
    production = false;
    expect(closed.status).toBe(503);
    expect((await closed.json()).code).toBe("signup_unavailable");
  });
});

describe("verification", () => {
  it("verifies once with the emailed token and rejects reuse or tampering", async () => {
    const [email] = await emailsFor("new.owner@example.com");
    const token = tokenFrom(email?.message?.text ?? "");
    expect(token).toBeDefined();
    const tampered = await verifyEmail(deps)(
      post("/api/account/verify-email", { token: `${token!.slice(0, -1)}A` }),
    );
    expect((await tampered.json()).code).toBe("token_invalid");
    const ok = await verifyEmail(deps)(
      post("/api/account/verify-email", { token }),
    );
    expect(await ok.json()).toEqual({ status: "verified" });
    const reuse = await verifyEmail(deps)(
      post("/api/account/verify-email", { token }),
    );
    expect(reuse.status).toBe(400);
    const user = await client.user.findUniqueOrThrow({
      where: { email: "new.owner@example.com" },
    });
    expect(user.emailVerified).toBe(true);
    expect(
      await client.platformAuditEvent.count({
        where: { userId: user.id, action: "account.email_verified" },
      }),
    ).toBe(1);
  });

  it("resend answers the same for any address and supersedes the old link", async () => {
    await signUp(deps)(
      post("/api/account/sign-up", form("resend@example.com")),
    );
    const [first] = await emailsFor("resend@example.com");
    const oldToken = tokenFrom(first?.message?.text ?? "");
    for (const email of [
      "resend@example.com",
      "nobody@example.com",
      "new.owner@example.com",
    ]) {
      const response = await resendVerification(deps)(
        post("/api/account/verification/resend", { email }),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "check-email" });
    }
    const emails = await emailsFor("resend@example.com");
    expect(emails.map((e) => e.kind)).toEqual(["verify_email", "verify_email"]);
    const old = await verifyEmail(deps)(
      post("/api/account/verify-email", { token: oldToken }),
    );
    expect(old.status).toBe(400);
    const fresh = tokenFrom(emails[1]?.message?.text ?? "");
    const ok = await verifyEmail(deps)(
      post("/api/account/verify-email", { token: fresh }),
    );
    expect(ok.status).toBe(200);
    // Verified accounts get nothing more; the minute limit also applies.
    await resendVerification(deps)(
      post("/api/account/verification/resend", { email: "resend@example.com" }),
    );
    expect((await emailsFor("resend@example.com")).length).toBe(2);
  });
});

describe("verified-session gating", () => {
  it("requires verification except for demo accounts outside production", () => {
    expect(
      isVerified({ email: "a@example.com", emailVerified: false }, {}),
    ).toBe(false);
    expect(
      isVerified({ email: "a@example.com", emailVerified: true }, {}),
    ).toBe(true);
    expect(
      isVerified(
        { email: "demo-owner@example.test", emailVerified: false },
        { APP_ENV: "development" },
      ),
    ).toBe(true);
    expect(
      isVerified(
        { email: "demo-owner@example.test", emailVerified: false },
        { APP_ENV: "production" },
      ),
    ).toBe(false);
    expect(
      isVerified({ email: "tester@jobflow.invalid", emailVerified: false }, {}),
    ).toBe(true);
    expect(
      isVerified(
        { email: "tester@jobflow.invalid", emailVerified: false },
        { APP_ENV: "production" },
      ),
    ).toBe(false);
  });
});
