import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repositoryRoot } from "./environment.mjs";

export function redactDatabaseDiagnostics(output, environment = process.env) {
  // Exact configured URLs may contain whitespace or quotes in credentials.
  const values = [
    environment.DATABASE_URL,
    environment.TEST_DATABASE_URL,
  ].filter(Boolean);
  const urls = [];
  for (const value of values) {
    try {
      const canonical = new URL(value);
      if (["postgres:", "postgresql:"].includes(canonical.protocol)) {
        urls.push(value, canonical.href);
      }
    } catch {
      // Invalid configured values are removed after generic URL redaction.
    }
  }
  for (const value of [...new Set(urls)].sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(value, "[database URL redacted]");
  }
  output = output.replace(
    /postgres(?:ql)?:\/\/\S+/gi,
    "[database URL redacted]",
  );
  // Redact invalid values last: a value such as "postgresql" must not break
  // the scheme before the generic pattern has removed complete URLs.
  for (const value of values)
    output = output.replaceAll(value, "[database URL redacted]");
  return output;
}

export function runPrisma(arguments_, environment = process.env) {
  const result = spawnSync("pnpm", ["exec", "prisma", ...arguments_], {
    cwd: join(repositoryRoot, "packages/database"),
    env: environment,
    encoding: "utf8",
  });
  // Never relay connection strings from diagnostics, even on failed commands.
  const output = redactDatabaseDiagnostics(
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    environment,
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Prisma command failed: ${output}`);
  }
  return output;
}
