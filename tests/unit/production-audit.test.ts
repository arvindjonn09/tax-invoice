import { expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

it.each([0, 17])(
  "production audit removes exceptions and preserves exit code %i",
  (status) => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "jobflow-audit-test-"));
    const originalManifest = readFileSync("package.json", "utf8");
    try {
      writeFileSync(
        join(fixtureDirectory, "pnpm"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["audit", "--prod", "--audit-level", "high"]);
const manifests = ["package.json", ...["apps", "packages"].flatMap(root => fs.readdirSync(root).map(name => root + "/" + name + "/package.json"))];
assert.equal(manifests.length, 6);
for (const path of manifests) assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).pnpm?.auditConfig, undefined);
assert.deepEqual(fs.readFileSync("pnpm-lock.yaml"), fs.readFileSync(process.env.JOBFLOW_AUDIT_SOURCE + "/pnpm-lock.yaml"));
console.log(JSON.stringify({ directory: process.cwd() }));
process.exit(${status});
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        ["scripts/audit-production.mjs"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fixtureDirectory}:${process.env.PATH}`,
            JOBFLOW_AUDIT_SOURCE: process.cwd(),
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(status);
      const output = JSON.parse(
        result.stdout.trim().split("\n").at(-1) ?? "{}",
      );
      expect(typeof output.directory).toBe("string");
      expect(existsSync(output.directory)).toBe(false);
      expect(readFileSync("package.json", "utf8")).toBe(originalManifest);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  },
);
