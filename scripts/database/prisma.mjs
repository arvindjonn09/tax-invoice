import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./environment.mjs";

export function runPrisma(arguments_, environment = process.env) {
  const result = spawnSync("pnpm", ["exec", "prisma", ...arguments_], {
    cwd: join(repositoryRoot, "packages/database"),
    env: environment,
    encoding: "utf8",
  });
  // Never relay connection strings from diagnostics, even on failed commands.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(
    /postgres(?:ql)?:\/\/[^\s"']+/gi,
    "[database URL redacted]",
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Prisma command failed: ${output}`);
  }
  return output;
}
