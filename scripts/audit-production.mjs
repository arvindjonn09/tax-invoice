import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// pnpm 9 reads manifest audit exceptions even with --prod. Audit an isolated
// copy of the same workspace/lockfile with all manifest exceptions removed.
const auditDirectory = mkdtempSync(join(tmpdir(), "jobflow-production-audit-"));
try {
  const manifestPaths = [
    "package.json",
    ...["apps", "packages"].flatMap((root) =>
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${root}/${entry.name}/package.json`),
    ),
  ];
  for (const path of manifestPaths) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.pnpm) delete manifest.pnpm.auditConfig;
    const destination = join(auditDirectory, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, JSON.stringify(manifest));
  }
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    cpSync(path, join(auditDirectory, path));
  }
  console.log(
    "Auditing unchanged production lockfile with no manifest audit exceptions",
  );
  const result = spawnSync(
    "pnpm",
    ["audit", "--prod", "--audit-level", "high"],
    {
      cwd: auditDirectory,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(auditDirectory, { recursive: true, force: true });
}
