// #230 (ADR 0004 D5): the only way to change who is a platform operator, and
// the recovery path for trial changes. Runs on the host with the migration
// credentials, so there's no HTTP path to it.
//   pnpm operator grant --user <uuid> --reason <text> --by <name>
//   pnpm operator revoke --user <uuid> --reason <text> --by <name>
//   pnpm operator list
//   pnpm operator enrol-code --user <uuid> --by <name> [--reset]
//   pnpm operator extend --as <operatorUserId> --company <uuid> --last-day <date> --reason <text>
//   pnpm operator access --as <operatorUserId> --company <uuid> --mode trial|unrestricted [--last-day <date>] --reason <text>
import { parseArgs } from "node:util";
import { createDatabaseClient } from "../../packages/database/src/index";
import { runOperatorCommand } from "../../apps/web/src/server/operator/cli-commands";
import {
  loadLocalEnvironment,
  requireDatabaseUrl,
} from "../database/environment.mjs";

loadLocalEnvironment();
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      user: { type: "string" },
      reason: { type: "string" },
      by: { type: "string" },
      as: { type: "string" },
      company: { type: "string" },
      "last-day": { type: "string" },
      mode: { type: "string" },
      reset: { type: "boolean" },
    },
  });
  const db = createDatabaseClient(
    requireDatabaseUrl(process.env.DATABASE_URL).toString(),
  );
  try {
    console.log(
      await runOperatorCommand(db, positionals[0], values, process.env),
    );
  } finally {
    await db.$disconnect();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
