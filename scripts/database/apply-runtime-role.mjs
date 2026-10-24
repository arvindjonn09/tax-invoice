// Grant the least-privilege runtime role after migrations (#64, #71). Runs as
// the migration OWNER (DATABASE_URL) — the same SQL the runtime-role test
// proves can't do DDL, disable triggers or rewrite the audit log.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { loadLocalEnvironment } from "./environment.mjs";

const require = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Client } = require("pg");

/** A configuration problem whose message is safe to print. */
class UsageError extends Error {}

async function main() {
  loadLocalEnvironment();
  const url = process.env.DATABASE_URL;
  if (!url) throw new UsageError("Set DATABASE_URL to the migration owner");
  const sql = await readFile(
    new URL(
      "../../packages/database/prisma/roles/runtime-role.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query(sql);
    // The web app's LOGIN role, a member of jobflow_app. The password comes
    // from the deploy environment and is quoted by PostgreSQL (%L), never
    // interpolated here.
    const password = process.env.RUNTIME_DATABASE_PASSWORD;
    // A deployed environment always needs the web login role.
    if (
      !password &&
      ["staging", "production"].includes(process.env.APP_ENV ?? "")
    ) {
      throw new UsageError(
        "Set RUNTIME_DATABASE_PASSWORD: the web app logs in as jobflow_web",
      );
    }
    if (password) {
      if (password.length < 24) {
        throw new UsageError(
          "RUNTIME_DATABASE_PASSWORD must be 24+ characters",
        );
      }
      const exists = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = 'jobflow_web'",
      );
      const verb = exists.rowCount ? "ALTER" : "CREATE";
      const { rows } = await client.query(
        `SELECT format('${verb} ROLE jobflow_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT PASSWORD %L', $1::text) AS sql`,
        [password],
      );
      await client.query(rows[0].sql);
      await client.query("GRANT jobflow_app TO jobflow_web");
    }
  } finally {
    await client.end();
  }
  console.log(
    "Runtime role jobflow_app granted (and jobflow_web, when configured).",
  );
}

main().catch((error) => {
  console.error(
    error instanceof UsageError
      ? error.message
      : "Granting the runtime role failed (details redacted)",
  );
  process.exitCode = 1;
});
