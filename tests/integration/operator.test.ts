import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import {
  ENROLMENT_CODE_HEADER,
  consumeEnrolmentCode,
  isOperator,
  operatorAllowlist,
} from "../../apps/web/src/server/operator/access";
import { runOperatorCommand } from "../../apps/web/src/server/operator/cli-commands";
import { createWithOperator } from "../../apps/web/src/server/operator/policy";
import {
  TrialAccessError,
  extendTrial,
  setAccessMode,
} from "../../apps/web/src/server/operator/trial-access";
import { decryptPayload } from "../../apps/web/src/server/email/crypto";
import { withAudit } from "../../packages/database/src/index";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #230 (ADR 0004 D5, D6): the platform operator, TOTP, trialAccess and the CLI.
const ORIGIN = "http://127.0.0.1:3000";
const SECRET = "test-outbox-key-0123456789abcdef-0123456789";
const PASSWORD = "synthetic password for tests";
const NOW = new Date("2026-11-06T02:00:00Z");
const TODAY = "2026-11-06";
const factory = syntheticFactory(0x2300);
let database: CommittedDatabase;
let db: PrismaClient;
let auth: ReturnType<typeof createAuth>;
let ip = 0;
const allowlisted: string[] = [];
const env = (extra: Record<string, string> = {}) => ({
  APP_ENV: "development",
  EMAIL_OUTBOX_KEY: SECRET,
  BETTER_AUTH_URL: ORIGIN,
  JOBFLOW_OPERATOR_USER_IDS: allowlisted.join(","),
  ...extra,
});
const deps = () => ({
  db,
  emailSecret: SECRET,
  appUrl: ORIGIN,
  now: () => NOW,
});

function authRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${(++ip % 250) + 1}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
async function signIn(email: string) {
  const response = await auth.handler(
    authRequest("/sign-in/email", { email, password: PASSWORD }),
  );
  expect(response.status).toBe(200);
  return response;
}
async function newUser(verified = true) {
  const user = await createCredentialUser(db, {
    email: `operator-${randomUUID()}@jobflow.invalid`,
    name: "Synthetic Operator",
    password: PASSWORD,
  });
  if (verified) {
    await db.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
  }
  return user;
}
async function newOperator() {
  const user = await newUser();
  await db.platformOperator.create({
    data: {
      userId: user.id,
      grantedReason: "Synthetic grant",
      grantedBy: "test",
    },
  });
  allowlisted.push(user.id);
  process.env.JOBFLOW_OPERATOR_USER_IDS = allowlisted.join(",");
  return user;
}
async function newCompany(
  options: { lastDay?: string; demo?: boolean; unrestricted?: boolean } = {},
) {
  const owner = await newUser();
  const company = {
    ...factory.company(owner.id),
    isDemo: Boolean(options.demo),
    ...(options.demo || options.unrestricted
      ? { accessMode: "unrestricted" as const }
      : {
          accessMode: "trial" as const,
          trialStartedAt: new Date("2026-10-20T00:00:00Z"),
          trialLastDay: new Date(
            `${options.lastDay ?? "2026-11-20"}T00:00:00Z`,
          ),
        }),
  };
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, owner.id),
    });
  });
  return { id: company.id, owner };
}
const lastDayOf = async (id: string) =>
  (await db.company.findUniqueOrThrow({ where: { id } })).trialLastDay
    ?.toISOString()
    .slice(0, 10);

/** RFC 6238 from the URI the plugin hands back, as an authenticator app does. */
function totp(uri: string, at = Date.now()) {
  const encoded = new URL(uri).searchParams.get("secret")!;
  let bits = "";
  for (const char of encoded.replace(/=+$/, "")) {
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(char)
      .toString(2)
      .padStart(5, "0");
  }
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  auth = createAuth({
    db,
    secret: "x".repeat(32),
    baseURL: ORIGIN,
    production: false,
  });
}, 60_000);
afterAll(async () => {
  delete process.env.JOBFLOW_OPERATOR_USER_IDS;
  await database?.release();
});

describe("isOperator and withOperator", () => {
  const route = (production = false) =>
    createWithOperator({
      db: () => db,
      auth: () => auth,
      trustedOrigins: () => [ORIGIN],
      env: () => env(),
      production: () => production,
    })(async ({ operatorUserId }) => Response.json({ operatorUserId }));
  const call = (cookie?: string, production = false) =>
    route(production)(
      new Request(`${ORIGIN}/api/operator/ping`, {
        headers: {
          origin: ORIGIN,
          ...(cookie ? { cookie } : {}),
        },
      }),
      undefined,
    );
  const expect404 = async (response: Response) => {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  };

  it("lets in an active, allowlisted, verified operator", async () => {
    const user = await newOperator();
    const response = await call(cookieFrom(await signIn(user.email)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operatorUserId: user.id });
  });

  it("returns 404 when signed out", async () => {
    await expect404(await call());
  });

  it.each(["owner", "manager", "accountant", "employee", "subcontractor"])(
    "returns 404 for a company %s",
    async (role) => {
      const company = await newCompany({ unrestricted: true });
      const user = await newUser();
      await db.membership.create({
        data: {
          ...factory.membership(company.id, user.id),
          createdBy: company.owner.id,
          role: role as "owner",
        },
      });
      await expect404(await call(cookieFrom(await signIn(user.email))));
    },
  );

  it("returns 404 for a revoked operator on the next request", async () => {
    const user = await newOperator();
    const cookie = cookieFrom(await signIn(user.email));
    expect((await call(cookie)).status).toBe(200);
    await db.platformOperator.update({
      where: { userId: user.id },
      data: { revokedAt: new Date(), revokedReason: "Synthetic revoke" },
    });
    await expect404(await call(cookie));
  });

  it("returns 404 for an operator missing from the allowlist", async () => {
    const user = await newOperator();
    allowlisted.splice(allowlisted.indexOf(user.id), 1);
    await expect404(await call(cookieFrom(await signIn(user.email))));
  });

  it("returns 404 for someone only on the allowlist", async () => {
    const user = await newUser();
    allowlisted.push(user.id);
    await expect404(await call(cookieFrom(await signIn(user.email))));
  });

  it("returns 404 for an unverified operator", async () => {
    const user = await newOperator();
    const cookie = cookieFrom(await signIn(user.email));
    await db.user.update({
      where: { id: user.id },
      data: { emailVerified: false },
    });
    await expect404(await call(cookie));
  });

  it("returns 404 in production without TOTP, and passes with it", async () => {
    const user = await newOperator();
    const cookie = cookieFrom(await signIn(user.email));
    await expect404(await call(cookie, true));
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true },
    });
    expect((await call(cookie, true)).status).toBe(200);
  });

  it("returns 404 for a cross-origin request, even from an operator", async () => {
    const user = await newOperator();
    const cookie = cookieFrom(await signIn(user.email));
    const response = await route()(
      new Request(`${ORIGIN}/api/operator/ping`, {
        method: "POST",
        headers: { origin: "https://evil.example.com", cookie },
        body: "{}",
      }),
      undefined,
    );
    await expect404(response);
  });

  it("reads the allowlist ignoring spaces and case", () => {
    expect([
      ...operatorAllowlist({ JOBFLOW_OPERATOR_USER_IDS: " AA , bb ,," }),
    ]).toEqual(["aa", "bb"]);
    expect(operatorAllowlist({}).size).toBe(0);
  });
});

describe("TOTP enrolment", () => {
  const enable = (cookie: string, code?: string) =>
    auth.handler(
      authRequest(
        "/two-factor/enable",
        { password: PASSWORD },
        {
          cookie,
          ...(code ? { [ENROLMENT_CODE_HEADER]: code } : {}),
        },
      ),
    );
  const issueCode = async (userId: string, reset = false) =>
    (
      await runOperatorCommand(
        db,
        "enrol-code",
        { user: userId, by: "test", reset },
        env(),
      )
    )
      .split("\n")
      .at(-1)!;

  it("refuses a non-operator with 404", async () => {
    const user = await newUser();
    const response = await enable(cookieFrom(await signIn(user.email)), "x");
    expect(response.status).toBe(404);
    expect(await db.twoFactor.count({ where: { userId: user.id } })).toBe(0);
  });

  it("refuses an operator with no code, a wrong code or another operator's code", async () => {
    const user = await newOperator();
    const other = await newOperator();
    const cookie = cookieFrom(await signIn(user.email));
    expect((await enable(cookie)).status).toBe(403);
    expect((await enable(cookie, "wrong")).status).toBe(403);
    expect((await enable(cookie, await issueCode(other.id))).status).toBe(403);
    expect(await db.twoFactor.count({ where: { userId: user.id } })).toBe(0);
  });

  it("refuses an expired code and a used code", async () => {
    const user = await newOperator();
    const code = await issueCode(user.id);
    expect(
      await consumeEnrolmentCode(
        db,
        user.id,
        code,
        new Date(Date.now() + 11 * 60_000),
      ),
    ).toBe(false);
    expect(await consumeEnrolmentCode(db, user.id, code)).toBe(true);
    expect(await consumeEnrolmentCode(db, user.id, code)).toBe(false);
  });

  it("enrols with a code, then sign-in needs TOTP before there's a session", async () => {
    const user = await newOperator();
    const cookie = cookieFrom(await signIn(user.email));
    const enabled = await enable(cookie, await issueCode(user.id));
    expect(enabled.status).toBe(200);
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    const confirmed = await auth.handler(
      authRequest(
        "/two-factor/verify-totp",
        { code: totp(totpURI) },
        { cookie },
      ),
    );
    expect(confirmed.status).toBe(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .twoFactorEnabled,
    ).toBe(true);
    await db.authSession.deleteMany({ where: { userId: user.id } });

    const passwordOnly = await signIn(user.email);
    expect(await passwordOnly.json()).toMatchObject({
      twoFactorRedirect: true,
    });
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(0);

    const pending = cookieFrom(passwordOnly);
    const trust = await auth.handler(
      authRequest(
        "/two-factor/verify-totp",
        { code: totp(totpURI), trustDevice: true },
        { cookie: pending },
      ),
    );
    expect(trust.status).toBe(400);
    const verified = await auth.handler(
      authRequest(
        "/two-factor/verify-totp",
        { code: totp(totpURI) },
        { cookie: pending },
      ),
    );
    expect(verified.status).toBe(200);
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("keeps TOTP from being turned off over HTTP", async () => {
    const user = await newOperator();
    const response = await auth.handler(
      authRequest(
        "/two-factor/disable",
        { password: PASSWORD },
        { cookie: cookieFrom(await signIn(user.email)) },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("--reset clears a lost device and its sessions", async () => {
    const user = await newOperator();
    await signIn(user.email);
    await db.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true },
    });
    await db.twoFactor.create({
      data: { userId: user.id, secret: "s", backupCodes: "b" },
    });
    await issueCode(user.id, true);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .twoFactorEnabled,
    ).toBe(false);
    expect(await db.twoFactor.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("trialAccess", () => {
  const extend = async (
    operatorUserId: string,
    companyId: string,
    lastDay: string,
    reason = "Synthetic reason",
  ) =>
    extendTrial(deps(), {
      operatorUserId,
      companyId,
      lastDay,
      reason,
      requestId: "req-1",
    });

  it("extends, records the operator event and emails active owners", async () => {
    const operator = await newOperator();
    const company = await newCompany();
    await extend(operator.id, company.id, "2026-12-20");
    expect(await lastDayOf(company.id)).toBe("2026-12-20");
    const row = await db.company.findUniqueOrThrow({
      where: { id: company.id },
    });
    expect(row.trialExtensionCount).toBe(1);
    const [event] = await db.auditEvent.findMany({
      where: { companyId: company.id, action: "trial.extended" },
    });
    expect(event).toMatchObject({
      actorKind: "operator",
      operatorUserId: operator.id,
      createdBy: null,
    });
    expect(event!.metadata).toMatchObject({
      requestId: "req-1",
      changes: {
        trialLastDay: { before: "2026-11-20", after: "2026-12-20" },
        reason: { before: null, after: "Synthetic reason" },
      },
    });
    const [email] = await db.emailOutbox.findMany({
      where: { companyId: company.id, kind: "trial_extended" },
    });
    expect(email?.userId).toBe(company.owner.id);
    expect(decryptPayload(SECRET, email!.payloadCiphertext!).text).toContain(
      "2026-12-20",
    );
  });

  it.each([
    ["the same day", "2026-11-20", "later"],
    ["a shorter trial", "2026-11-10", "later"],
    ["more than 365 days away", "2027-11-07", "365"],
    ["a day that doesn't exist", "2026-02-30", "valid date"],
    ["junk", "soon", "valid date"],
  ])("refuses %s and changes nothing", async (_name, lastDay, message) => {
    const operator = await newOperator();
    const company = await newCompany();
    await expect(extend(operator.id, company.id, lastDay)).rejects.toThrow(
      message,
    );
    expect(await lastDayOf(company.id)).toBe("2026-11-20");
    expect(
      await db.auditEvent.count({
        where: { companyId: company.id, action: "trial.extended" },
      }),
    ).toBe(0);
  });

  it("refuses a date before today on an already expired trial", async () => {
    const operator = await newOperator();
    const company = await newCompany({ lastDay: "2026-10-01" });
    await expect(extend(operator.id, company.id, "2026-11-01")).rejects.toThrow(
      "past",
    );
  });

  it.each([
    ["an empty reason", "   "],
    ["a long reason", "x".repeat(501)],
  ])("refuses %s", async (_name, reason) => {
    const operator = await newOperator();
    const company = await newCompany();
    await expect(
      extend(operator.id, company.id, "2026-12-20", reason),
    ).rejects.toMatchObject({ code: "invalid_reason" });
  });

  it("refuses a demo company and an unknown company", async () => {
    const operator = await newOperator();
    const demo = await newCompany({ demo: true });
    await expect(
      extend(operator.id, demo.id, "2026-12-20"),
    ).rejects.toMatchObject({ code: "demo_company" });
    await expect(
      setAccessMode(deps(), {
        operatorUserId: operator.id,
        companyId: demo.id,
        reason: "Synthetic",
        mode: "trial",
        lastDay: "2026-12-20",
      }),
    ).rejects.toBeInstanceOf(TrialAccessError);
    await expect(
      extend(operator.id, randomUUID(), "2026-12-20"),
    ).rejects.toMatchObject({ code: "unknown_company" });
  });

  it("refuses to extend an unrestricted company", async () => {
    const operator = await newOperator();
    const company = await newCompany({ unrestricted: true });
    await expect(
      extend(operator.id, company.id, "2026-12-20"),
    ).rejects.toMatchObject({ code: "not_on_trial" });
  });

  it("serialises concurrent extensions", async () => {
    const operator = await newOperator();
    const company = await newCompany();
    const results = await Promise.allSettled(
      ["2026-12-01", "2026-12-20"].map((day) =>
        extend(operator.id, company.id, day),
      ),
    );
    const applied = results.filter((r) => r.status === "fulfilled").length;
    const events = await db.auditEvent.count({
      where: { companyId: company.id, action: "trial.extended" },
    });
    expect(events).toBe(applied);
    expect(
      (await db.company.findUniqueOrThrow({ where: { id: company.id } }))
        .trialExtensionCount,
    ).toBe(applied);
    expect(await lastDayOf(company.id)).toBe("2026-12-20");
  });

  it("makes a read-only company writable immediately", async () => {
    const operator = await newOperator();
    const company = await newCompany({ lastDay: "2020-01-01" });
    const write = () =>
      withAudit(db, async (_tx, audit) => {
        await audit({
          companyId: company.id,
          actorUserId: company.owner.id,
          action: "company.profile_updated",
          target: { type: "company", id: company.id },
        });
      });
    await expect(write()).rejects.toThrow(/read_only/);
    await extendTrial(
      { ...deps(), now: () => new Date() },
      {
        operatorUserId: operator.id,
        companyId: company.id,
        lastDay: new Date(Date.now() + 30 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        reason: "Synthetic reason",
      },
    );
    await expect(write()).resolves.toBeUndefined();
  });

  it("closes a pending request when extending directly", async () => {
    const operator = await newOperator();
    const company = await newCompany();
    const request = await db.trialExtensionRequest.create({
      data: {
        companyId: company.id,
        requestedBy: company.owner.id,
        lastDayAtRequest: new Date("2026-11-20T00:00:00Z"),
      },
    });
    await extend(operator.id, company.id, "2026-12-20");
    expect(
      await db.trialExtensionRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toMatchObject({
      status: "closed",
      closedReason: "direct_extension",
      decidedBy: operator.id,
    });
  });

  it("switches between modes, closing a pending request, and audits it", async () => {
    const operator = await newOperator();
    const company = await newCompany();
    await db.trialExtensionRequest.create({
      data: {
        companyId: company.id,
        requestedBy: company.owner.id,
        lastDayAtRequest: new Date("2026-11-20T00:00:00Z"),
      },
    });
    const base = {
      operatorUserId: operator.id,
      companyId: company.id,
      reason: "Synthetic reason",
    };
    await setAccessMode(deps(), { ...base, mode: "unrestricted" });
    expect(
      await db.company.findUniqueOrThrow({ where: { id: company.id } }),
    ).toMatchObject({ accessMode: "unrestricted" });
    expect(
      await db.trialExtensionRequest.findFirstOrThrow({
        where: { companyId: company.id },
      }),
    ).toMatchObject({ status: "closed", closedReason: "made_unrestricted" });
    await expect(
      setAccessMode(deps(), { ...base, mode: "unrestricted" }),
    ).rejects.toMatchObject({ code: "already_in_mode" });
    await expect(
      setAccessMode(deps(), { ...base, mode: "trial", lastDay: "2020-01-01" }),
    ).rejects.toMatchObject({ code: "invalid_date" });
    await setAccessMode(deps(), {
      ...base,
      mode: "trial",
      lastDay: TODAY,
    });
    expect(await lastDayOf(company.id)).toBe(TODAY);
    expect(
      await db.auditEvent.count({
        where: {
          companyId: company.id,
          action: "company.access_mode_changed",
          actorKind: "operator",
        },
      }),
    ).toBe(2);
  });
});

describe("pnpm operator", () => {
  const run = (
    command: string,
    values: Record<string, string | boolean> = {},
    extra: Record<string, string> = {},
  ) => runOperatorCommand(db, command, values, env(extra));

  it("refuses to run without APP_ENV", async () => {
    const withoutAppEnv: Record<string, string> = env();
    delete withoutAppEnv.APP_ENV;
    await expect(
      runOperatorCommand(db, "list", {}, withoutAppEnv),
    ).rejects.toThrow("APP_ENV");
  });

  it("grants only a verified user, and audits grant and revoke", async () => {
    const unverified = await newUser(false);
    const values = { user: unverified.id, reason: "Synthetic", by: "test" };
    await expect(run("grant", values)).rejects.toThrow("verified");
    const user = await newUser();
    await run("grant", { ...values, user: user.id });
    expect(
      await db.platformOperator.findUniqueOrThrow({
        where: { userId: user.id },
      }),
    ).toMatchObject({ grantedBy: "test", revokedAt: null });
    await run("revoke", { ...values, user: user.id });
    expect(
      (
        await db.platformOperator.findUniqueOrThrow({
          where: { userId: user.id },
        })
      ).revokedAt,
    ).not.toBeNull();
    await expect(run("revoke", { ...values, user: user.id })).rejects.toThrow(
      "active operator",
    );
    await run("grant", { ...values, user: user.id });
    expect(
      (
        await db.platformOperator.findUniqueOrThrow({
          where: { userId: user.id },
        })
      ).revokedAt,
    ).toBeNull();
    expect(
      await db.platformAuditEvent.groupBy({
        by: ["action", "actorKind"],
        where: { userId: user.id },
        _count: true,
        orderBy: { action: "asc" },
      }),
    ).toEqual([
      { action: "operator.granted", actorKind: "system", _count: 2 },
      { action: "operator.revoked", actorKind: "system", _count: 1 },
    ]);
  });

  it("revoking cancels an unused enrolment code", async () => {
    const user = await newOperator();
    const code = (await run("enrol-code", { user: user.id, by: "test" }))
      .split("\n")
      .at(-1)!;
    await run("revoke", { user: user.id, reason: "Synthetic", by: "test" });
    expect(await consumeEnrolmentCode(db, user.id, code)).toBe(false);
  });

  it("issues enrolment codes only to an operator, storing just the digest", async () => {
    const stranger = await newUser();
    await expect(
      run("enrol-code", { user: stranger.id, by: "test" }),
    ).rejects.toThrow("active operator");
    const user = await newOperator();
    const code = (await run("enrol-code", { user: user.id, by: "test" }))
      .split("\n")
      .at(-1)!;
    const rows = await db.operatorEnrolmentCode.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toBe(code);
    const events = await db.platformAuditEvent.findMany({
      where: { userId: user.id, action: "operator.enrolment_code_issued" },
    });
    expect(JSON.stringify(events)).not.toContain(code);
  });

  it("needs --as to pass the two-key check, then runs the same service", async () => {
    const company = await newCompany();
    const stranger = await newUser();
    const values = {
      as: stranger.id,
      company: company.id,
      "last-day": "2099-01-01",
      reason: "Synthetic",
    };
    await expect(run("extend", values)).rejects.toThrow("allowlisted");
    const operator = await newOperator();
    const lastDay = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(
      await run("extend", {
        ...values,
        as: operator.id,
        "last-day": lastDay,
      }),
    ).toContain(lastDay);
    expect(await lastDayOf(company.id)).toBe(lastDay);
    await expect(
      run("access", { ...values, as: operator.id, mode: "other" }),
    ).rejects.toThrow("--mode");
    expect(
      await run("access", {
        as: operator.id,
        company: company.id,
        reason: "Synthetic",
        mode: "unrestricted",
      }),
    ).toContain("unrestricted");
  });

  it("lists active operators with their allowlist and MFA state", async () => {
    const user = await newOperator();
    expect(await run("list")).toContain(`${user.id} granted`);
    expect(await run("list")).toContain("allowlisted=true");
    expect(
      await run("nonsense" as string).catch((e: Error) => e.message),
    ).toContain("Usage");
  });

  it("isOperator is false for an unknown user", async () => {
    allowlisted.push("00000000-0000-4000-8000-000000000000");
    expect(
      await isOperator(db, "00000000-0000-4000-8000-000000000000", {
        env: env(),
        production: false,
      }),
    ).toBe(false);
  });
});
