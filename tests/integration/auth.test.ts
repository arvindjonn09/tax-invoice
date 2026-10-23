import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import {
  SIGN_IN_MAX_ATTEMPTS,
  createAuth,
} from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import {
  resolveActor,
  setActiveCompany,
} from "../../apps/web/src/server/auth/actor";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// Sign-in creates committed sessions, so this file uses its own database.
const ORIGIN = "http://127.0.0.1:3000";
// Random per run: no secret-shaped literal in the repository.
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = "correct horse battery staple";
let database: CommittedDatabase;
let db: PrismaClient;
let auth: ReturnType<typeof createAuth>;
const factory = syntheticFactory(0x1313);
const emails = {
  owner: "owner@jobflow.invalid",
  member: "member@jobflow.invalid",
  lonely: "lonely@jobflow.invalid",
  demo: "demo@example.test",
};
type Key = "owner" | "member" | "lonely" | "demo" | "companyA" | "companyB";
const ids = {} as Record<Key, string>;

let ipCounter = 0;
/** A fresh client IP per call keeps tests independent of the sign-in throttle. */
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

function signIn(
  instance: ReturnType<typeof createAuth>,
  email: string,
  password: string,
  options: { ip?: string; origin?: string } = {},
) {
  return instance.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: options.origin ?? ORIGIN,
        "x-forwarded-for": options.ip ?? nextIp(),
      },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** Turn a Set-Cookie response into request headers carrying the session cookie. */
function cookieHeaders(response: Response): Headers {
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return new Headers({ cookie: cookies });
}

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  auth = createAuth({ db, secret: SECRET, baseURL: ORIGIN, production: false });
  for (const [key, email] of Object.entries(emails)) {
    const user = await createCredentialUser(db, {
      email,
      name: `Synthetic ${key}`,
      password: PASSWORD,
    });
    ids[key as Key] = user.id;
  }
  // Owner of two companies; member of one; "lonely" belongs to none.
  for (const key of ["companyA", "companyB"] as const) {
    const company = factory.company(ids.owner);
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: company });
      await tx.membership.create({
        data: factory.membership(company.id, ids.owner),
      });
    });
    ids[key] = company.id;
  }
  await db.membership.create({
    data: {
      companyId: ids.companyA,
      userId: ids.member,
      createdBy: ids.owner,
      role: "employee",
    },
  });
}, 60_000);
afterAll(() => database?.release());

describe("sign-in", () => {
  it("signs in with HttpOnly, SameSite=Lax cookies and a database session", async () => {
    const response = await signIn(auth, emails.owner, PASSWORD);
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("jobflow.session_token="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).not.toMatch(/; Secure/i);
    const session = await auth.api.getSession({
      headers: cookieHeaders(response),
    });
    expect(session?.user.email).toBe(emails.owner);
    expect(
      await db.authSession.count({ where: { userId: ids.owner } }),
    ).toBeGreaterThan(0);
  });

  it("uses Secure, __Secure- prefixed cookies in production", async () => {
    const production = createAuth({
      db,
      secret: SECRET,
      baseURL: ORIGIN,
      production: true,
    });
    const response = await signIn(production, emails.owner, PASSWORD);
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-jobflow.session_token="));
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; HttpOnly/i);
  });

  it("gives the same generic error for a wrong password and an unknown email", async () => {
    const wrong = await signIn(auth, emails.owner, "not the right password");
    const unknown = await signIn(auth, "nobody@jobflow.invalid", PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const [a, b] = await Promise.all([wrong.json(), unknown.json()]);
    expect(a).toEqual(b);
    expect(wrong.headers.getSetCookie().join()).not.toContain("session_token=");
  });

  it(`throttles sign-in after ${SIGN_IN_MAX_ATTEMPTS} attempts per client IP`, async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= SIGN_IN_MAX_ATTEMPTS; attempt += 1) {
      statuses.push(
        (await signIn(auth, emails.member, "wrong password!!", { ip })).status,
      );
    }
    expect(
      statuses.slice(0, SIGN_IN_MAX_ATTEMPTS).every((s) => s === 401),
    ).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Even the correct password is refused while throttled...
    expect((await signIn(auth, emails.member, PASSWORD, { ip })).status).toBe(
      429,
    );
    // ...but other clients are unaffected.
    expect((await signIn(auth, emails.member, PASSWORD)).status).toBe(200);
  });

  it("rejects a sign-in POST from another origin (CSRF)", async () => {
    const response = await signIn(auth, emails.owner, PASSWORD, {
      origin: "https://attacker.invalid",
    });
    expect(response.status).toBe(403);
  });

  it("has no public sign-up", async () => {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": nextIp(),
        },
        body: JSON.stringify({
          email: "new@jobflow.invalid",
          password: PASSWORD,
          name: "New",
        }),
      }),
    );
    expect(response.ok).toBe(false);
    expect(
      await db.user.count({ where: { email: "new@jobflow.invalid" } }),
    ).toBe(0);
  });

  it("refuses demo accounts in production, but not in development", async () => {
    const production = createAuth({
      db,
      secret: SECRET,
      baseURL: ORIGIN,
      production: true,
    });
    expect((await signIn(production, emails.demo, PASSWORD)).status).toBe(403);
    expect((await signIn(auth, emails.demo, PASSWORD)).status).toBe(200);
  });

  it("never logs passwords or session tokens", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      await signIn(auth, emails.owner, "a-secret-wrong-password");
      const ok = await signIn(auth, emails.owner, PASSWORD);
      const token = ok.headers.getSetCookie().join();
      const logged = spies
        .flatMap((spy) => spy.mock.calls.flat())
        .map(String)
        .join("\n");
      expect(logged).not.toContain("a-secret-wrong-password");
      expect(logged).not.toContain(PASSWORD);
      const raw = token.match(/session_token=([^;.]+)/)?.[1] ?? "never-matches";
      expect(logged).not.toContain(raw);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("sessions", () => {
  it("rejects an expired session", async () => {
    const response = await signIn(auth, emails.member, PASSWORD);
    const headers = cookieHeaders(response);
    const session = await auth.api.getSession({ headers });
    expect(session).not.toBeNull();
    await db.authSession.update({
      where: { id: session?.session.id ?? "" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await auth.api.getSession({ headers })).toBeNull();
  });

  it("revokes a session by deleting its row", async () => {
    const headers = cookieHeaders(await signIn(auth, emails.member, PASSWORD));
    const session = await auth.api.getSession({ headers });
    await db.authSession.delete({ where: { id: session?.session.id ?? "" } });
    expect(await auth.api.getSession({ headers })).toBeNull();
  });
});

describe("resolveActor", () => {
  it("is signed-out without a valid session cookie", async () => {
    expect(await resolveActor(auth, db, new Headers())).toEqual({
      status: "signed-out",
    });
  });

  it("reports a user without any active membership", async () => {
    const headers = cookieHeaders(await signIn(auth, emails.lonely, PASSWORD));
    expect(await resolveActor(auth, db, headers)).toEqual({
      status: "no-membership",
      userId: ids.lonely,
    });
  });

  it("selects a single membership automatically, with its role from the database", async () => {
    const headers = cookieHeaders(await signIn(auth, emails.member, PASSWORD));
    const resolution = await resolveActor(auth, db, headers);
    expect(resolution).toMatchObject({
      status: "active",
      actor: { userId: ids.member, companyId: ids.companyA, role: "employee" },
    });
  });

  it("asks a multi-company user to choose, then honours only their own companies", async () => {
    const headers = cookieHeaders(await signIn(auth, emails.owner, PASSWORD));
    expect(await resolveActor(auth, db, headers)).toMatchObject({
      status: "choose-company",
    });
    expect(await setActiveCompany(auth, db, headers, ids.companyB)).toBe(true);
    expect(await resolveActor(auth, db, headers)).toMatchObject({
      status: "active",
      actor: { companyId: ids.companyB, role: "owner" },
    });
    // A company the user doesn't belong to is refused.
    const memberHeaders = cookieHeaders(
      await signIn(auth, emails.member, PASSWORD),
    );
    expect(await setActiveCompany(auth, db, memberHeaders, ids.companyB)).toBe(
      false,
    );
    expect(await setActiveCompany(auth, db, new Headers(), ids.companyA)).toBe(
      false,
    );
  });

  it("stops honouring a remembered company once that membership is deactivated", async () => {
    const headers = cookieHeaders(await signIn(auth, emails.member, PASSWORD));
    await setActiveCompany(auth, db, headers, ids.companyA);
    await db.membership.updateMany({
      where: { userId: ids.member, companyId: ids.companyA },
      data: { isActive: false },
    });
    try {
      expect(await resolveActor(auth, db, headers)).toEqual({
        status: "no-membership",
        userId: ids.member,
      });
    } finally {
      await db.membership.updateMany({
        where: { userId: ids.member, companyId: ids.companyA },
        data: { isActive: true },
      });
    }
  });
});

describe("createCredentialUser", () => {
  it("rejects passwords shorter than 12 or longer than 128 characters", async () => {
    for (const password of ["short", "x".repeat(129)]) {
      await expect(
        createCredentialUser(db, {
          email: "weak@jobflow.invalid",
          name: "Weak",
          password,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("stores only a password hash", async () => {
    const account = await db.authAccount.findFirstOrThrow({
      where: { userId: ids.owner, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(PASSWORD);
  });
});

it("refuses a secret shorter than 32 characters", () => {
  expect(() =>
    createAuth({ db, secret: "too-short", baseURL: ORIGIN, production: false }),
  ).toThrow("at least 32");
});

it("uses Secure cookies for an HTTPS origin even outside production", async () => {
  const https = createAuth({
    db,
    secret: SECRET,
    baseURL: "https://jobflow.invalid",
    production: false,
  });
  const response = await https.handler(
    new Request("https://jobflow.invalid/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://jobflow.invalid",
        "x-forwarded-for": nextIp(),
      },
      body: JSON.stringify({ email: emails.owner, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie().join()).toMatch(
    /__Secure-jobflow\.session_token=.*; Secure/i,
  );
});
