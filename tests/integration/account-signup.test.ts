import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  type AccountDependencies,
  forgotPassword,
  resendMine,
  resendVerification,
  resetPassword,
  signUp,
  verifyEmail,
} from "../../apps/web/src/server/account/handlers";
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "../../apps/web/src/server/account/terms";
import { type Auth, createAuth } from "../../apps/web/src/server/auth/config";
import { isVerified, resolveActor } from "../../apps/web/src/server/auth/actor";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { decryptPayload } from "../../apps/web/src/server/email/crypto";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #217/#218: public sign-up, email verification and resend (ADR 0004 D1).
const ORIGIN = "http://localhost:3000";
const SECRET = "test-outbox-key-0123456789abcdef-0123456789";
let database: CommittedDatabase;
let client: PrismaClient;
let breached = false;
let turnstileOk = true;
let production = false;
let hashed = 0;

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
  defer: (work) => work(),
  hashPassword: async () => {
    hashed += 1;
    return "hashed";
  },
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

  it("caps 'account exists' email to one recipient without changing the response", async () => {
    await signUp(deps)(
      post("/api/account/sign-up", form("flooded@example.com")),
    );
    const user = await client.user.findUniqueOrThrow({
      where: { email: "flooded@example.com" },
    });
    // Different hours would each be allowed by the dedupe key; force them.
    const realNow = Date.now;
    try {
      for (let hour = 0; hour < 5; hour += 1) {
        Date.now = () => realNow() + hour * 3_600_000;
        const response = await signUp(deps)(
          post("/api/account/sign-up", form("flooded@example.com")),
        );
        expect(response.status).toBe(202);
      }
    } finally {
      Date.now = realNow;
    }
    expect(
      await client.emailOutbox.count({
        where: { userId: user.id, kind: "account_exists" },
      }),
    ).toBe(3);
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

  it("refuses reserved domains in every environment, as they skip verification", async () => {
    for (const email of [
      "anyone@x.test",
      "a@b.invalid",
      "a@b.example",
      "a@b.localhost",
    ]) {
      const response = await signUp(deps)(
        post("/api/account/sign-up", form(email)),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).fields.email).toBeDefined();
      expect(await client.user.count({ where: { email } })).toBe(0);
    }
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
      post("/api/account/verify-email", {
        // Always a different last character, so the token is really changed.
        token: `${token!.slice(0, -1)}${token!.endsWith("A") ? "B" : "A"}`,
      }),
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
  });

  it("sends a verified account nothing, with the same response", async () => {
    const factory = syntheticFactory(0x2491);
    const user = {
      ...factory.user(),
      email: "already.verified@example.com",
      emailVerified: true,
    };
    await client.user.create({ data: user });
    const response = await resendVerification(deps)(
      post("/api/account/verification/resend", { email: user.email }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "check-email" });
    expect(await emailsFor(user.email)).toEqual([]);
  });

  it("spends the hashing work on an existing account (S2 AC4)", async () => {
    const email = "hash.check@example.com";
    await signUp(deps)(post("/api/account/sign-up", form(email)));
    hashed = 0;
    const response = await signUp(deps)(
      post("/api/account/sign-up", form(email)),
    );
    expect(response.status).toBe(202);
    expect(hashed).toBe(1);
  });

  it("keeps the public resend out of the account holder's allowance", async () => {
    const email = "own.allowance@example.com";
    await signUp(deps)(post("/api/account/sign-up", form(email)));
    const user = await client.user.findUniqueOrThrow({ where: { email } });
    const session = { user: { id: user.id }, session: {} };
    const own: AccountDependencies = {
      ...deps,
      auth: () => ({ api: { getSession: async () => session } }) as never,
    };
    // Strangers use up the public day limit...
    const now = BigInt(Date.now());
    await client.$executeRaw`
      INSERT INTO auth_rate_limits (key, count, last_request)
      VALUES (${`jobflow:verify:resend:public:day:${user.id}`}, 5, ${now})`;
    const publicResend = await emailsFor(email);
    await resendVerification(deps)(
      post("/api/account/verification/resend", { email }),
    );
    expect((await emailsFor(email)).length).toBe(publicResend.length);
    // ...and the holder can still send one, then hears the real wait.
    const mine = await resendMine(own)(
      post("/api/account/verification/resend-mine", {}),
    );
    expect(mine.status).toBe(202);
    await client.$executeRaw`
      UPDATE auth_rate_limits SET count = 5, last_request = ${
        now - BigInt(3600_000)
      }
      WHERE key = ${`jobflow:verify:resend:mine:day:${user.id}`}`;
    await client.$executeRaw`
      DELETE FROM auth_rate_limits
      WHERE key = ${`jobflow:verify:resend:mine:minute:${user.id}`}`;
    const refused = await resendMine(own)(
      post("/api/account/verification/resend-mine", {}),
    );
    expect(refused.status).toBe(429);
    const { retryAfterSeconds } = (await refused.json()) as {
      retryAfterSeconds: number;
    };
    expect(retryAfterSeconds).toBeGreaterThan(82_000);
    expect(retryAfterSeconds).toBeLessThanOrEqual(82_800);
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
    // Other reserved-TLD addresses get no exemption.
    expect(
      isVerified(
        { email: "staff@company.test", emailVerified: false },
        { APP_ENV: "staging" },
      ),
    ).toBe(false);
  });

  it("refuses an unverified member at the gate, before any membership query", async () => {
    const factory = syntheticFactory(0x2492);
    const user = {
      ...factory.user(),
      email: "unverified.member@example.com",
      emailVerified: false,
    };
    const company = { ...factory.company(user.id), isDemo: false };
    await client.user.create({ data: user });
    await client.$transaction(async (tx) => {
      await tx.company.create({ data: company });
      await tx.membership.create({
        data: factory.membership(company.id, user.id),
      });
    });
    const auth = {
      api: {
        getSession: async () => ({
          user: { id: user.id, email: user.email, emailVerified: false },
          session: { id: "s", activeCompanyId: company.id },
        }),
      },
    } as unknown as Auth;
    let queries = 0;
    const counting = new Proxy(client, {
      get(target, property, receiver) {
        queries += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await resolveActor(auth, counting, new Headers())).toEqual({
      status: "unverified",
      userId: user.id,
      email: user.email,
    });
    expect(queries).toBe(0);
    const route = createWithPolicy({
      auth: () => auth,
      db: () => client,
      trustedOrigins: () => [ORIGIN],
    })("company.read", async () => new Response("reached"));
    const refused = await route(new Request(`${ORIGIN}/api/company`), {
      params: Promise.resolve({}),
    });
    expect(refused.status).toBe(403);
  });
});

describe("password reset", () => {
  const NEW_PASSWORD = "a brand new synthetic password";
  const forgot = (email: string, ip?: string) =>
    forgotPassword(deps)(post("/api/account/password/forgot", { email }, ip));
  const reset = (token: unknown, password = NEW_PASSWORD, ip?: string) =>
    resetPassword(deps)(
      post(
        "/api/account/password/reset",
        { token, password, passwordConfirmation: password },
        ip,
      ),
    );
  let counter = 0;
  const newUser = async (verified = false) => {
    const email = `reset-${++counter}@synthetic.example.com`;
    const user = await client.user.create({
      data: { email, name: "Reset User", emailVerified: verified },
    });
    await client.authAccount.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: "old-hash",
      },
    });
    return user;
  };
  const latestToken = async (email: string) => {
    const emails = await emailsFor(email);
    const message = emails.filter((row) => row.kind === "password_reset").at(-1)
      ?.message as { text: string } | null | undefined;
    return tokenFrom(message?.text ?? "");
  };
  const passwordOf = async (userId: string) =>
    (
      await client.authAccount.findFirstOrThrow({
        where: { userId, providerId: "credential" },
      })
    ).password;

  it("answers the same 202 for known and unknown addresses, and emails only the known one", async () => {
    const user = await newUser();
    const known = await forgot(user.email);
    const unknown = await forgot("nobody-here@synthetic.example.com");
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
    expect(await latestToken(user.email)).toBeTruthy();
    expect(
      await client.emailOutbox.count({
        where: { userId: user.id, kind: "password_reset" },
      }),
    ).toBe(1);
  });

  it("does no account work before answering, so timing can't reveal one", async () => {
    const user = await newUser();
    const deferred: (() => Promise<void>)[] = [];
    const held: AccountDependencies = {
      ...deps,
      defer: (work) => {
        deferred.push(work);
      },
    };
    const response = await forgotPassword(held)(
      post("/api/account/password/forgot", { email: user.email }),
    );
    expect(response.status).toBe(202);
    expect(
      await client.accountToken.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(deferred).toHaveLength(1);
  });

  it("sends nothing to a demo account in production", async () => {
    const user = await client.user.create({
      data: { email: "reset-demo@example.test", name: "Demo" },
    });
    production = true;
    try {
      expect((await forgot(user.email)).status).toBe(202);
    } finally {
      production = false;
    }
    expect(await client.emailOutbox.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });

  it("refuses a failed Turnstile", async () => {
    turnstileOk = false;
    try {
      const response = await forgot("anyone@synthetic.example.com");
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("turnstile_failed");
    } finally {
      turnstileOk = true;
    }
  });

  const resetEmails = (userId: string) =>
    client.emailOutbox.count({ where: { userId, kind: "password_reset" } });

  it("doesn't let one IP use up an account's resets", async () => {
    const user = await newUser();
    const attacker = "203.0.113.90";
    for (let i = 0; i < 5; i += 1) await forgot(user.email, attacker);
    expect(await resetEmails(user.id)).toBe(3);
    const live = await client.accountToken.findFirstOrThrow({
      where: {
        userId: user.id,
        purpose: "password_reset",
        supersededAt: null,
        consumedAt: null,
      },
    });
    expect((await forgot(user.email, "203.0.113.91")).status).toBe(202);
    expect(await resetEmails(user.id)).toBe(4);
    expect(live.id).not.toBe(
      (
        await client.accountToken.findFirstOrThrow({
          where: {
            userId: user.id,
            purpose: "password_reset",
            supersededAt: null,
            consumedAt: null,
          },
        })
      ).id,
    );
  });

  it("leaves the live link alone when a request is throttled", async () => {
    const user = await newUser();
    const ip = "203.0.113.92";
    for (let i = 0; i < 3; i += 1) await forgot(user.email, ip);
    const token = await latestToken(user.email);
    await forgot(user.email, ip);
    expect((await reset(token)).status).toBe(200);
  });

  it("limits one account to 10 an hour across every IP", async () => {
    const user = await newUser();
    for (let i = 0; i < 12; i += 1) {
      await forgot(user.email, `203.0.114.${i + 1}`);
    }
    expect(await resetEmails(user.id)).toBe(10);
  });

  it("caps an account at 6 a day from one IP and 24 a day in all", async () => {
    const user = await newUser();
    const ip = "203.0.113.93";
    const spendTheHour = () =>
      client.$executeRaw`DELETE FROM auth_rate_limits WHERE key LIKE ${`jobflow:forgot:account:${user.id}%:hour`}`;
    for (let i = 0; i < 8; i += 1) {
      if (i % 3 === 0) await spendTheHour();
      await forgot(user.email, ip);
    }
    expect(await resetEmails(user.id)).toBe(6);
    for (let i = 0; i < 30; i += 1) {
      if (i % 9 === 0) await spendTheHour();
      await forgot(user.email, `203.0.115.${i + 1}`);
    }
    expect(await resetEmails(user.id)).toBe(24);
  });

  it("allows one live link, and lets only one of two simultaneous resets use it", async () => {
    const user = await newUser();
    await forgot(user.email, "203.0.113.94");
    const token = await latestToken(user.email);
    // account_tokens_one_live already refuses a second live link.
    await expect(
      client.accountToken.create({
        data: {
          userId: user.id,
          purpose: "password_reset",
          tokenHash: "f".repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    ).rejects.toThrow();
    const responses = await Promise.all([reset(token), reset(token)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(
      await client.accountToken.count({
        where: {
          userId: user.id,
          purpose: "password_reset",
          consumedAt: null,
          supersededAt: null,
        },
      }),
    ).toBe(0);
  });

  it("limits an account to 3 an hour from one IP: still 202, no email, counted", async () => {
    const user = await newUser();
    const ip = "203.0.113.95";
    for (let i = 0; i < 3; i += 1) await forgot(user.email, ip);
    const response = await forgot(user.email, ip);
    expect(response.status).toBe(202);
    expect(
      await client.emailOutbox.count({
        where: { userId: user.id, kind: "password_reset" },
      }),
    ).toBe(3);
    expect(
      await client.platformAuditEvent.count({
        where: {
          userId: user.id,
          action: "account.password_reset_throttled",
        },
      }),
    ).toBe(1);
  });

  it("limits an IP to 10 an hour: still 202, no email, counted", async () => {
    const ip = "203.0.113.77";
    const user = await newUser();
    for (let i = 0; i < 10; i += 1) {
      await forgot(`nobody-${i}@synthetic.example.com`, ip);
    }
    const before = await client.platformAuditEvent.count({
      where: { action: "account.password_reset_throttled", userId: null },
    });
    const response = await forgot(user.email, ip);
    expect(response.status).toBe(202);
    expect(await client.emailOutbox.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      await client.platformAuditEvent.count({
        where: { action: "account.password_reset_throttled", userId: null },
      }),
    ).toBe(before + 1);
  });

  it("replaces the hash, ends every session, verifies the address and sends the notice", async () => {
    const user = await newUser();
    for (const token of ["session-a", "session-b"]) {
      await client.authSession.create({
        data: {
          userId: user.id,
          token: `${user.id}-${token}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }
    await forgot(user.email);
    const token = await latestToken(user.email);

    const response = await reset(token);

    expect(response.status).toBe(200);
    expect(await passwordOf(user.id)).toBe("hashed");
    expect(await client.authSession.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      (await client.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerified,
    ).toBe(true);
    const emails = await emailsFor(user.email);
    const notice = emails.find((row) => row.kind === "password_changed");
    expect(notice?.status).toBe("pending");
    expect((notice?.message as { text: string }).text).not.toContain("#token=");
  });

  it("is single-use, and a new request supersedes the old link", async () => {
    const used = await newUser();
    await forgot(used.email);
    const once = await latestToken(used.email);
    expect((await reset(once)).status).toBe(200);
    await client.authAccount.updateMany({
      where: { userId: used.id },
      data: { password: "kept" },
    });
    const replay = await reset(once);
    expect(replay.status).toBe(400);
    expect((await replay.json()).code).toBe("token_invalid");
    expect(await passwordOf(used.id)).toBe("kept");

    const user = await newUser();
    await forgot(user.email);
    const first = await latestToken(user.email);
    await forgot(user.email);
    expect((await reset(first)).status).toBe(400);
    expect(await passwordOf(user.id)).toBe("old-hash");
    expect((await reset(await latestToken(user.email))).status).toBe(200);
  });

  it("refuses an expired token and leaves everything unchanged", async () => {
    const user = await newUser();
    await forgot(user.email);
    const token = await latestToken(user.email);
    await client.accountToken.updateMany({
      where: { userId: user.id, purpose: "password_reset" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await reset(token);
    expect(response.status).toBe(400);
    expect(await passwordOf(user.id)).toBe("old-hash");
    expect(
      (await client.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerified,
    ).toBe(false);
  });

  it("checks the new password before spending the token", async () => {
    const user = await newUser();
    await forgot(user.email);
    const token = await latestToken(user.email);
    expect((await reset(token, "too short")).status).toBe(400);
    const mismatch = await resetPassword(deps)(
      post("/api/account/password/reset", {
        token,
        password: NEW_PASSWORD,
        passwordConfirmation: "something else entirely",
      }),
    );
    expect(mismatch.status).toBe(400);
    breached = true;
    try {
      const refused = await reset(token);
      expect(refused.status).toBe(400);
      expect((await refused.json()).fields.password).toContain("breach");
    } finally {
      breached = false;
    }
    expect(await passwordOf(user.id)).toBe("old-hash");
    expect((await reset(token)).status).toBe(200);
  });

  it("rolls everything back if the transaction fails", async () => {
    const user = await newUser();
    await forgot(user.email);
    const token = await latestToken(user.email);
    const broken: AccountDependencies = {
      ...deps,
      emailSecret: () => "short",
    };
    const response = await resetPassword(broken)(
      post("/api/account/password/reset", {
        token,
        password: NEW_PASSWORD,
        passwordConfirmation: NEW_PASSWORD,
      }),
    );
    expect(response.status).toBe(500);
    expect(await passwordOf(user.id)).toBe("old-hash");
    expect((await reset(token)).status).toBe(200);
  });

  it("never reactivates a membership", async () => {
    const factory = syntheticFactory(219);
    const user = await newUser();
    const owner = factory.user();
    const company = { ...factory.company(owner.id), isDemo: false };
    await client.user.create({ data: owner });
    await client.$transaction(async (tx) => {
      await tx.company.create({ data: company });
      await tx.membership.create({
        data: factory.membership(company.id, owner.id),
      });
      await tx.membership.create({
        data: {
          ...factory.membership(company.id, user.id),
          createdBy: owner.id,
          role: "manager",
          isActive: false,
        },
      });
    });
    await forgot(user.email);
    expect((await reset(await latestToken(user.email))).status).toBe(200);
    expect(
      (
        await client.membership.findFirstOrThrow({
          where: { userId: user.id },
        })
      ).isActive,
    ).toBe(false);
  });

  it("keeps Better Auth's own reset and verification endpoints disabled", async () => {
    const auth = deps.auth();
    for (const path of [
      "request-password-reset",
      "reset-password",
      "send-verification-email",
      "verify-email",
    ]) {
      const response = await auth.handler(
        new Request(`${ORIGIN}/api/auth/${path}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: "x@synthetic.example.com" }),
        }),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("puts no address or token in audit metadata", async () => {
    const user = await newUser();
    await forgot(user.email);
    const token = await latestToken(user.email);
    await reset(token);
    const events = await client.platformAuditEvent.findMany({
      where: { userId: user.id },
    });
    const text = JSON.stringify(events.map((event) => event.metadata));
    expect(text).not.toContain(user.email);
    expect(text).not.toContain(token!);
  });
});
