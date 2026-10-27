// #63 Backups: `pnpm backup:create <dir>`, `pnpm backup:verify <dir>`,
// `pnpm backup:restore <dir>` and `pnpm backup:drill [--record <dir>]`.
// Reads DATABASE_URL, BACKUP_ENCRYPTION_KEY and the S3_* / local MinIO
// settings the app uses. Connection strings and keys are never printed.
import { randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupKey,
  createBackup,
  isBackupName,
  prunePlan,
  restoreBackup,
  verifyBackup,
} from "../../apps/web/src/server/backup/backup";
import { storeFromEnvironment } from "../../apps/web/src/server/documents/store";
import { loadLocalEnvironment } from "../database/environment.mjs";

const require = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
type PgClient = {
  connect(): Promise<void>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
const { Client } = require("pg") as {
  Client: new (config: {
    connectionString: string;
    connectionTimeoutMillis?: number;
  }) => PgClient;
};

type Store = NonNullable<ReturnType<typeof storeFromEnvironment>>;

function storeOrFail(env: NodeJS.ProcessEnv): Store {
  const store = storeFromEnvironment(env);
  if (!store) throw new Error("No document storage configured (S3_* or MinIO)");
  return store;
}

async function withClient<T>(
  url: string,
  run: (client: PgClient) => Promise<T>,
) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** True when the database has no tables of its own (safe to restore into). */
const emptyDatabase = (url: string) => () =>
  withClient(url, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    return rows[0]!.count === "0";
  });

/** Row counts of every application table. */
const tableCounts = (url: string) =>
  withClient(url, async (client) => {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const counts: Record<string, number> = {};
    for (const { tablename } of rows) {
      // Names come from the catalog, quoted as identifiers.
      const result = await client.query<{ count: string }>(
        `SELECT count(*) FROM "${tablename.replaceAll('"', '""')}"`,
      );
      counts[tablename] = Number(result.rows[0]!.count);
    }
    return counts;
  });

const seconds = (start: number) =>
  Math.round((performance.now() - start) / 10) / 100;

async function drill(env: NodeJS.ProcessEnv, recordDir: string | null) {
  const key = backupKey(env.BACKUP_ENCRYPTION_KEY);
  const sourceUrl = env.DATABASE_URL ?? "";
  if (!sourceUrl) throw new Error("Set DATABASE_URL");
  const source = storeOrFail(env);
  const dir = await mkdtemp(join(tmpdir(), "jobflow-drill-"));
  const name = `jobflow_restore_drill_${randomUUID().replaceAll("-", "")}`;
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${name}`;
  const bucket = `${env.S3_BUCKET ?? "jobflow-documents"}-drill-${Date.now()}`;
  const target = storeOrFail({ ...env, S3_BUCKET: bucket });
  const timings = {
    backupSeconds: 0,
    verifySeconds: 0,
    restoreSeconds: 0,
    checkSeconds: 0,
  };
  let created = false;
  try {
    let start = performance.now();
    const manifest = await createBackup(
      { databaseUrl: sourceUrl, store: source, appEnv: env.APP_ENV ?? null },
      join(dir, "backup"),
      key,
    );
    timings.backupSeconds = seconds(start);
    start = performance.now();
    await verifyBackup(join(dir, "backup"), key);
    timings.verifySeconds = seconds(start);
    await withClient(sourceUrl, (client) =>
      client.query(
        `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`,
      ),
    );
    created = true;
    start = performance.now();
    const restored = await restoreBackup(
      join(dir, "backup"),
      { databaseUrl: targetUrl.toString(), store: target },
      key,
      emptyDatabase(targetUrl.toString()),
    );
    timings.restoreSeconds = seconds(start);
    start = performance.now();
    const [before, after] = await Promise.all([
      tableCounts(sourceUrl),
      tableCounts(targetUrl.toString()),
    ]);
    const mismatched = Object.keys({ ...before, ...after }).filter(
      (table) => before[table] !== after[table],
    );
    let objectsChecked = 0;
    for await (const objectKey of source.keys()) {
      const [a, b] = await Promise.all([
        source.get(objectKey),
        target.get(objectKey),
      ]);
      if (!a || !b || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0)
        mismatched.push(`object ${objectKey.slice(0, 12)}…`);
      objectsChecked += 1;
    }
    timings.checkSeconds = seconds(start);
    const result = {
      ok: mismatched.length === 0,
      at: new Date().toISOString(),
      tables: Object.keys(before).length,
      rows: Object.values(before).reduce((total, count) => total + count, 0),
      objects: restored.objects,
      objectsChecked,
      databaseBytes: manifest.database.bytes,
      objectBytes: manifest.objects.bytes,
      mismatched,
      ...timings,
    };
    console.log(JSON.stringify(result, null, 2));
    if (recordDir) {
      await mkdir(recordDir, { recursive: true });
      // Dated in Sydney, the business's calendar.
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Australia/Sydney",
      }).format(new Date(result.at));
      await writeFile(
        join(recordDir, `${day}.md`),
        [
          `# Restore drill — ${day}`,
          "",
          `Result: **${result.ok ? "passed" : "FAILED"}** (${env.APP_ENV ?? "unknown"} environment, synthetic data only).`,
          "",
          "| Step | Seconds |",
          "|---|---|",
          `| Encrypted backup (database + documents) | ${result.backupSeconds} |`,
          `| Verify checksums | ${result.verifySeconds} |`,
          `| Restore into an empty database and bucket | ${result.restoreSeconds} |`,
          `| Compare every table's rows and every document | ${result.checkSeconds} |`,
          "",
          `Restored ${result.tables} tables (${result.rows} rows) and ${result.objects} documents; database dump ${result.databaseBytes} bytes encrypted, documents ${result.objectBytes} bytes.`,
          result.ok
            ? "No differences."
            : `Differences: ${result.mismatched.join(", ")}`,
          "",
          "Command: `pnpm backup:drill --record docs/ops/restore-drills`",
          "",
        ].join("\n"),
      );
    }
    if (!result.ok) process.exitCode = 1;
  } finally {
    if (created)
      await withClient(sourceUrl, (client) =>
        client.query(`DROP DATABASE "${name}" WITH (FORCE)`),
      );
    for await (const objectKey of target.keys()) await target.delete(objectKey);
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  loadLocalEnvironment();
  const env = process.env;
  const [command, ...rest] = process.argv.slice(2);
  if (command === "create") {
    const dir = rest[0];
    if (!dir) throw new Error("Usage: pnpm backup:create <new directory>");
    const manifest = await createBackup(
      {
        databaseUrl: env.DATABASE_URL ?? "",
        store: storeOrFail(env),
        appEnv: env.APP_ENV ?? null,
      },
      dir,
      backupKey(env.BACKUP_ENCRYPTION_KEY),
    );
    console.log(
      `Backup written: ${manifest.database.bytes} bytes of database, ${manifest.objects.count} documents.`,
    );
  } else if (command === "verify") {
    // With the key: every file is decrypted and authenticated.
    const manifest = await verifyBackup(
      rest[0] ?? "",
      backupKey(env.BACKUP_ENCRYPTION_KEY),
    );
    console.log(
      `Backup ${manifest.createdAt} verified (${manifest.objects.count} documents).`,
    );
  } else if (command === "restore") {
    // Restoring touches a real database: refuse production unless confirmed.
    if (
      env.APP_ENV === "production" &&
      env.RESTORE_CONFIRM !== "restore-into-empty-database"
    )
      throw new Error(
        "Set RESTORE_CONFIRM=restore-into-empty-database to restore in production",
      );
    const url = env.RESTORE_DATABASE_URL ?? "";
    if (!url) throw new Error("Set RESTORE_DATABASE_URL (an empty database)");
    const restored = await restoreBackup(
      rest[0] ?? "",
      {
        databaseUrl: url,
        store: storeOrFail({
          ...env,
          S3_BUCKET: env.RESTORE_S3_BUCKET ?? env.S3_BUCKET,
        }),
      },
      backupKey(env.BACKUP_ENCRYPTION_KEY),
      emptyDatabase(url),
    );
    console.log(`Restored the database and ${restored.objects} documents.`);
  } else if (command === "prune") {
    const root = rest[0];
    if (!root)
      throw new Error(
        "Usage: pnpm backup:prune <root> [--keep-daily N] [--keep-monthly N]",
      );
    const option = (flag: string, fallback: number) => {
      const at = rest.indexOf(flag);
      const value = at >= 0 ? Number(rest[at + 1]) : fallback;
      if (!Number.isInteger(value) || value < 1)
        throw new Error(`${flag} must be a whole number above 0`);
      return value;
    };
    // Only complete backups (with a manifest) count for retention; an
    // incomplete one left by a failed run is reported, never deleted or
    // allowed to stop the nightly job.
    const complete: string[] = [];
    const incomplete: string[] = [];
    for (const name of await readdir(root)) {
      if (!isBackupName(name)) continue;
      try {
        await access(join(root, name, "manifest.json"));
        complete.push(name);
      } catch {
        incomplete.push(name);
      }
    }
    const doomed = prunePlan(complete, {
      daily: option("--keep-daily", 30),
      monthly: option("--keep-monthly", 12),
    });
    for (const name of doomed) await rm(join(root, name), { recursive: true });
    console.log(`Pruned ${doomed.length} old backups.`);
    if (incomplete.length > 0)
      console.warn(
        `Left ${incomplete.length} incomplete backup directories for review: ${incomplete.join(", ")}`,
      );
  } else if (command === "drill") {
    const at = rest.indexOf("--record");
    await drill(env, at >= 0 ? (rest[at + 1] ?? null) : null);
  } else {
    throw new Error(
      "Usage: backup create|verify|restore <dir>, or backup drill [--record <dir>]",
    );
  }
}

main().catch((error: unknown) => {
  // Messages never include connection strings (they are masked upstream).
  console.error(error instanceof Error ? error.message : "Backup failed");
  process.exitCode = 1;
});
