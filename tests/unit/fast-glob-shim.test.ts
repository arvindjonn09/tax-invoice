import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The braces advisory (GHSA-vfj7-8cjw-p6xm) has no fixed version, so the
// only path to it — @next/eslint-plugin-next → fast-glob → micromatch →
// braces — is cut by overriding fast-glob for that plugin with a local shim.
const require = createRequire(import.meta.url);
const shim = require("../../tooling/fast-glob-shim/index.cjs") as {
  globSync: (pattern: unknown, options?: Record<string, unknown>) => string[];
};

describe("fast-glob shim for @next/eslint-plugin-next", () => {
  it("finds root directories the way fast-glob does", () => {
    const glob = (p: string) => shim.globSync(p, { onlyDirectories: true });
    expect(glob("apps/web/")).toEqual(["apps/web/"]);
    expect(glob("apps/web")).toEqual(["apps/web"]);
    expect(glob("apps/*")).toEqual(["apps/web"]);
    expect(glob("packages/*").sort()).toEqual([
      "packages/authz",
      "packages/database",
      "packages/domain",
      "packages/shared-types",
    ]);
    expect(glob("does-not-exist/")).toEqual([]);
    // Files never count as root directories.
    expect(glob("package.json")).toEqual([]);
    const absolute = glob(`${process.cwd()}/apps/web`);
    expect(absolute).toEqual([`${process.cwd()}/apps/web`]);
  });

  it("refuses any call the plugin does not make", () => {
    expect(() => shim.globSync("apps/*")).toThrow(/supports only/);
    expect(() =>
      shim.globSync("apps/*", { onlyDirectories: true, dot: true }),
    ).toThrow(/supports only/);
    expect(() => shim.globSync(["apps/*"], { onlyDirectories: true })).toThrow(
      /supports only/,
    );
  });

  it("is wired in only for the Next plugin, with no audit exceptions left", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.pnpm.overrides["@next/eslint-plugin-next>fast-glob"]).toBe(
      "link:./tooling/fast-glob-shim",
    );
    expect(manifest.pnpm.auditConfig).toBeUndefined();
    const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
    expect(lockfile).not.toMatch(/^\s+braces@/m);
  });
});
