import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// Run deliberately invalid synthetic fixtures in an independent source copy.
// Never insert broken code or a credential-shaped fixture into the real checkout.
const directory = mkdtempSync(join(tmpdir(), "jobflow-gate-proof-"));
const sourceDirectory = join(directory, "source");
mkdirSync(sourceDirectory);
function execute(command, args, cwd = sourceDirectory) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated: ${result.signal}`);
  return result;
}
function pass(command, args, cwd) {
  const result = execute(command, args, cwd);
  if (result.status !== 0)
    throw new Error(`${command} setup failed: ${result.stderr}`);
  return result;
}
function rejects(label, command, args, expected, cwd) {
  const result = execute(command, args, cwd);
  if (result.status === 0 || !expected.test(result.stdout + result.stderr)) {
    throw new Error(
      `${label} did not reject the intended fault (exit ${result.status})`,
    );
  }
  console.log(`${label}: rejected intended fixture (exit ${result.status})`);
}
try {
  const files = pass("git", ["ls-files", "-z"], process.cwd())
    .stdout.split("\0")
    .filter(Boolean);
  for (const file of files) {
    mkdirSync(dirname(join(sourceDirectory, file)), { recursive: true });
    cpSync(file, join(sourceDirectory, file));
  }
  symlinkSync(
    join(process.cwd(), "node_modules"),
    join(sourceDirectory, "node_modules"),
    "dir",
  );
  for (const workspace of [
    "apps/web",
    "packages/authz",
    "packages/database",
    "packages/domain",
    "packages/shared-types",
  ]) {
    symlinkSync(
      join(process.cwd(), workspace, "node_modules"),
      join(sourceDirectory, workspace, "node_modules"),
      "dir",
    );
  }
  symlinkSync(
    join(process.cwd(), "packages/database/src/generated"),
    join(sourceDirectory, "packages/database/src/generated"),
    "dir",
  );

  const typeFixture = join(sourceDirectory, "tests/unit/ci-type-error.ts");
  writeFileSync(
    typeFixture,
    'export const invalid: number = "synthetic-type-error";\n',
  );
  rejects("TypeScript", "pnpm", ["exec", "tsc", "--noEmit"], /TS2322/);
  rmSync(typeFixture);

  const lintFixture = join(sourceDirectory, "tests/unit/ci-lint-error.ts");
  writeFileSync(
    lintFixture,
    'export const invalid: any = "synthetic-lint-error";\n',
  );
  rejects("ESLint", "pnpm", ["lint"], /no-explicit-any/);
  rmSync(lintFixture);

  const testFixture = join(sourceDirectory, "tests/unit/ci-failure.test.ts");
  writeFileSync(
    testFixture,
    'import { it, expect } from "vitest";\nit("synthetic negative gate", () => expect(1).toBe(2));\n',
  );
  rejects(
    "Vitest",
    "pnpm",
    ["exec", "vitest", "run", "tests/unit/ci-failure.test.ts"],
    /synthetic negative gate/,
  );
  rmSync(testFixture);

  const vulnerable = join(directory, "audit-fixture");
  mkdirSync(vulnerable);
  // Known vulnerable release, lockfile only; never install or execute its code.
  writeFileSync(
    join(vulnerable, "package.json"),
    JSON.stringify({
      name: "synthetic-audit-gate",
      private: true,
      dependencies: { lodash: "4.17.20" },
    }),
  );
  pass("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], vulnerable);
  rejects(
    "Dependency audit",
    "pnpm",
    ["audit", "--prod", "--audit-level", "high"],
    /lodash/,
    vulnerable,
  );

  const secrets = join(directory, "secret-fixture");
  mkdirSync(secrets);
  pass("git", ["init", "--quiet"], secrets);
  // Obviously synthetic AWS-format access ID; not an actual credential.
  writeFileSync(
    join(secrets, "fixture.txt"),
    `aws_access_key_id = ${"AK" + "IA"}${"ABCDEFGHIJKLMNOP"}\n`,
  );
  pass("git", ["add", "fixture.txt"], secrets);
  pass(
    "git",
    [
      "-c",
      "user.name=Synthetic gate fixture",
      "-c",
      "user.email=ci@example.test",
      "commit",
      "--quiet",
      "-m",
      "synthetic scanner fixture",
    ],
    secrets,
  );
  rejects(
    "Gitleaks",
    process.env.GITLEAKS_BIN ?? "gitleaks",
    ["git", ".", "--redact", "--no-banner", "--log-opts=--all"],
    /leaks found/,
    secrets,
  );
  console.log(
    "All five actual quality/security commands rejected their negative fixtures.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
