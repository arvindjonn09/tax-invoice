import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_SECONDS,
  type AdminConfig,
  createSessionToken,
  credentialsMatch,
  loadAdminConfig,
  parseEnvFile,
  readCookie,
  sessionCookie,
  verifySessionToken,
} from "../../apps/web/src/server/admin-console/auth";
import {
  githubSettings,
  parseUpdates,
} from "../../apps/web/src/server/admin-console/data";

// #252: owner admin console credentials and sessions.
const config: AdminConfig = {
  username: "owner",
  password: "a long admin password",
  secret: "s".repeat(40),
  updatesFile: null,
};

function envFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "admin-env-"));
  const path = join(dir, ".env-admin");
  writeFileSync(path, text);
  return path;
}

describe("admin console credentials", () => {
  it("parses KEY=value lines with comments and quotes", () => {
    expect(
      parseEnvFile("# note\nA=1\nB=\"two words\"\n bad line\nC='x=y'\n"),
    ).toEqual({ A: "1", B: "two words", C: "x=y" });
  });

  it("stays off until username, a 12+ password and a 32+ secret are set", () => {
    expect(loadAdminConfig(null)).toBeNull();
    expect(
      loadAdminConfig(envFile("ADMIN_CONSOLE_USERNAME=owner\n")),
    ).toBeNull();
    expect(
      loadAdminConfig(
        envFile(
          `ADMIN_CONSOLE_USERNAME=owner\nADMIN_CONSOLE_PASSWORD=short\nADMIN_CONSOLE_SECRET=${"s".repeat(40)}\n`,
        ),
      ),
    ).toBeNull();
    expect(
      loadAdminConfig(
        envFile(
          `ADMIN_CONSOLE_USERNAME=owner\nADMIN_CONSOLE_PASSWORD=a long admin password\nADMIN_CONSOLE_SECRET=${"s".repeat(40)}\nAGENT_UPDATES_FILE=/tmp/u.md\n`,
        ),
      ),
    ).toMatchObject({
      username: "owner",
      updatesFile: "/tmp/u.md",
    });
  });

  it("matches only the exact username and password", async () => {
    expect(
      await credentialsMatch(config, "owner", "a long admin password"),
    ).toBe(true);
    expect(
      await credentialsMatch(config, "owner", "a long admin passwor"),
    ).toBe(false);
    expect(
      await credentialsMatch(config, "Owner", "a long admin password"),
    ).toBe(false);
  });
});

describe("admin console sessions", () => {
  it("accepts its own unexpired token and rejects tampering, expiry and rotation", () => {
    const now = Date.UTC(2026, 10, 3);
    const token = createSessionToken(config, now);
    expect(verifySessionToken(config, token, now)).toBe(true);
    expect(
      verifySessionToken(
        config,
        token,
        now + ADMIN_SESSION_SECONDS * 1000 + 1000,
      ),
    ).toBe(false);
    expect(verifySessionToken(config, `${token}x`, now)).toBe(false);
    expect(
      verifySessionToken({ ...config, secret: "t".repeat(40) }, token, now),
    ).toBe(false);
    expect(
      verifySessionToken({ ...config, username: "other" }, token, now),
    ).toBe(false);
    expect(verifySessionToken(config, undefined, now)).toBe(false);
  });

  it("sets a strict, HttpOnly cookie and reads it back", () => {
    const cookie = sessionCookie("abc.def", true);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Secure/);
    expect(readCookie("a=1; jobflow_admin=abc.def; b=2", "jobflow_admin")).toBe(
      "abc.def",
    );
  });
});

describe("GitHub settings", () => {
  it("reads the server environment and validates the repository", () => {
    expect(githubSettings({})).toEqual({
      repo: "arvindjonn09/tax-invoice",
      token: null,
    });
    expect(
      githubSettings({ ADMIN_GITHUB_REPO: "a/b", ADMIN_GITHUB_TOKEN: "t" }),
    ).toEqual({ repo: "a/b", token: "t" });
    expect(() => githubSettings({ ADMIN_GITHUB_REPO: "../../evil" })).toThrow(
      /owner\/name/,
    );
  });
});

describe("agent updates", () => {
  it("parses the shared updates log by agent", () => {
    expect(
      parseUpdates(
        "# heading\n2026-11-03 18:50 Sydney · Claude A · #252 · building console\n2026-11-03 19:00 Sydney · Codex (review) · #247 · approved · ok\nnot a log line\n",
      ),
    ).toEqual([
      {
        at: "2026-11-03 18:50 Sydney",
        agent: "Claude A",
        topic: "#252",
        text: "building console",
      },
      {
        at: "2026-11-03 19:00 Sydney",
        agent: "Codex",
        topic: "#247",
        text: "approved · ok",
      },
    ]);
  });
});
