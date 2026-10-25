import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #66: the runbooks and user guides stay usable — every relative link
// resolves and every `pnpm <script>` they tell people to run exists.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docs = [
  "CHANGELOG.md",
  "README.md",
  ...readdirSync(join(root, "docs/ops"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/ops/${f}`),
  ...readdirSync(join(root, "docs/user"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/user/${f}`),
];
const scripts = Object.keys(
  (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts,
);

describe.each(docs)("%s (#66)", (file) => {
  const text = readFileSync(join(root, file), "utf8");

  it("has no broken relative links", () => {
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target!)) continue;
      const path = target!.split("#")[0]!;
      expect(
        existsSync(resolve(root, dirname(file), path)),
        `${file} → ${target}`,
      ).toBe(true);
    }
  });

  it("only names pnpm scripts that exist", () => {
    for (const [, name] of text.matchAll(
      /\bpnpm (?:--silent |-s )?([a-z][\w:-]*)/g,
    )) {
      if (["exec", "install", "--filter"].includes(name!)) continue;
      expect(scripts, `${file}: pnpm ${name}`).toContain(name);
    }
  });
});

describe("user guides (#66)", () => {
  it("cover invoices, payments and GST, and say GST isn't lodged", () => {
    for (const guide of ["invoices", "payments", "gst"])
      expect(existsSync(join(root, `docs/user/${guide}.md`))).toBe(true);
    expect(readFileSync(join(root, "docs/user/gst.md"), "utf8")).toMatch(
      /does \*\*not\*\* lodge/,
    );
  });
});
