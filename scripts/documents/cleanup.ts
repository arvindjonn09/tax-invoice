// Delete documents that were uploaded but never attached, after the grace
// period (#137). Run daily on staging/production (docs/ops/documents.md):
//   pnpm documents:cleanup [--dry-run] [--grace-days 7]
import { parseArgs } from "node:util";
import { createDatabaseClient } from "../../packages/database/src/index";
import {
  UNATTACHED_GRACE_DAYS,
  cleanUnattachedDocuments,
} from "../../apps/web/src/server/documents/cleanup";
import { storeFromEnvironment } from "../../apps/web/src/server/documents/store";
import {
  loadLocalEnvironment,
  requireDatabaseUrl,
} from "../database/environment.mjs";

async function main() {
  loadLocalEnvironment();
  // Strict: a typo like --dryrun must fail, never turn into a real run.
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      "grace-days": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const dryRun = values["dry-run"];
  const grace = values["grace-days"];
  if (grace !== undefined && !/^[1-9][0-9]*$/.test(grace))
    throw new RangeError(
      "--grace-days must be a whole number of days, 1 or more",
    );
  const graceDays = grace === undefined ? UNATTACHED_GRACE_DAYS : Number(grace);
  const store = storeFromEnvironment();
  if (!store) throw new Error("Document storage isn't configured");
  if (
    ["staging", "production"].includes(process.env.APP_ENV ?? "") &&
    !process.env.MAINTENANCE_DATABASE_URL
  )
    throw new Error("Document cleanup needs MAINTENANCE_DATABASE_URL");
  const db = createDatabaseClient(
    requireDatabaseUrl(
      process.env.MAINTENANCE_DATABASE_URL ?? process.env.DATABASE_URL,
    ).toString(),
  );
  try {
    const result = await cleanUnattachedDocuments(db, store, {
      dryRun,
      graceDays,
    });
    // Counts only: never file names or object keys.
    console.log(
      JSON.stringify({
        dryRun,
        graceDays,
        deleted: result.deleted.length,
        bytes: result.deleted.reduce((sum, d) => sum + d.sizeBytes, 0),
        skipped: result.skipped,
        failed: result.failed,
        objectsLeft: result.objectsLeft,
        errors: result.errors,
      }),
    );
    if (result.failed > 0 || result.objectsLeft > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Only our own messages: database errors can carry connection details.
  const message = error instanceof Error ? error.message : "";
  console.error(
    error instanceof RangeError ||
      /^Document /.test(message) ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? `Cleanup failed: ${message}`
      : "Cleanup failed (details redacted)",
  );
  process.exitCode = 1;
});
