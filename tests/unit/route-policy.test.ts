import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Guard for #14: a route handler or server action without an explicit
// authorisation policy fails CI. Public exceptions must be listed with a reason.
const APP = join(import.meta.dirname, "../../apps/web/src/app");
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

const PUBLIC_ROUTES: Record<string, string> = {
  "api/health/route.ts": "liveness probe; returns no data",
  "api/auth/[...all]/route.ts":
    "Better Auth endpoints: sign-in/out and session; they enforce their own origin checks and throttling",
};
const POLICY_FREE_ACTIONS: Record<string, string> = {
  "account/page.tsx": "sign-out only affects the caller's own session",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

const all = files(APP).map((path) => ({
  path: relative(APP, path).replaceAll("\\", "/"),
  source: readFileSync(path, "utf8"),
}));

describe("route handlers", () => {
  const routes = all.filter(({ path }) => /(^|\/)route\.tsx?$/.test(path));

  it("finds the route files", () => {
    expect(routes.map(({ path }) => path)).toContain("api/company/route.ts");
  });

  for (const { path, source } of routes) {
    if (path in PUBLIC_ROUTES) continue;
    it(`${path} wraps every HTTP method in withPolicy`, () => {
      expect(source).not.toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+(${METHODS})\\b`),
      );
      const exported = [
        ...source.matchAll(
          new RegExp(`export\\s+const\\s+(${METHODS})\\s*=\\s*([^\\n]*)`, "g"),
        ),
      ];
      expect(exported.length).toBeGreaterThan(0);
      for (const [, method, value] of exported) {
        expect(value, `${method} in ${path}`).toMatch(/^withPolicy\(/);
      }
    });
  }

  it("lists only public routes that still exist", () => {
    const paths = routes.map(({ path }) => path);
    for (const path of Object.keys(PUBLIC_ROUTES))
      expect(paths).toContain(path);
  });
});

describe("server actions", () => {
  const actions = all.filter(({ source }) => /["']use server["']/.test(source));
  for (const { path, source } of actions) {
    if (path in POLICY_FREE_ACTIONS) continue;
    it(`${path} calls requireActor(...)`, () => {
      expect(source).toMatch(/requireActor\(/);
    });
  }
  it("lists only policy-free actions that still exist", () => {
    const paths = actions.map(({ path }) => path);
    for (const path of Object.keys(POLICY_FREE_ACTIONS))
      expect(paths).toContain(path);
  });
});
