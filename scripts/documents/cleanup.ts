// Delete documents that were uploaded but never attached, after the grace
// period (#137). Run daily on staging/production (docs/ops/documents.md):
//   pnpm documents:cleanup [--dry-run] [--grace-days 7]
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
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const at = args.indexOf("--grace-days");
  const graceDays = at >= 0 ? Number(args[at + 1]) : UNATTACHED_GRACE_DAYS;
  const store = storeFromEnvironment();
  if (!store) throw new Error("Document storage isn't configured");
  const db = createDatabaseClient(
    requireDatabaseUrl(process.env.DATABASE_URL).toString(),
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
      }),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Only our own messages: database errors can carry connection details.
  const message = error instanceof Error ? error.message : "";
  console.error(
    error instanceof RangeError || /^Document /.test(message)
      ? `Cleanup failed: ${message}`
      : "Cleanup failed (details redacted)",
  );
  process.exitCode = 1;
});
