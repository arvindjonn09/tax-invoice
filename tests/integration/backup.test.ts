import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createDatabaseClient } from "../../packages/database/src/index";
import {
  backupKey,
  createBackup,
  decryptBuffer,
  encryptBuffer,
  pgConnection,
  prunePlan,
  restoreBackup,
  verifyBackup,
} from "../../apps/web/src/server/backup/backup";
import { MemoryStore } from "../../apps/web/src/server/documents/store";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #63: encrypted backups of the database and documents, verified and
// restored into an empty database; tampering or a wrong key never restores.
const require = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
type PgClient = {
  connect(): Promise<void>;
  query<T>(sql: string): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};
const { Client } = require("pg") as {
  Client: new (config: { connectionString: string }) => PgClient;
};

const MARKER = `Synthetic Backup Marker ${randomUUID()}`;
const DOCUMENT = Buffer.from(`%PDF-1.7 ${MARKER} private document body`);

let database: CommittedDatabase;
let db: PrismaClient;
let dir = "";
let companyId = "";
const key = randomBytes(32);
const store = new MemoryStore();
// CI can point at a matching client: PG_DUMP / PG_RESTORE.
const pg = {
  ...(process.env.PG_DUMP ? { pgDump: process.env.PG_DUMP } : {}),
  ...(process.env.PG_RESTORE ? { pgRestore: process.env.PG_RESTORE } : {}),
};

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  dir = await mkdtemp(join(tmpdir(), "jobflow-backup-test-"));
  const factory = syntheticFactory(0x6363);
  const user = await db.user.create({
    data: { email: `${randomUUID()}@jobflow.invalid`, name: "Synthetic owner" },
  });
  const company = { ...factory.company(user.id), name: MARKER };
  companyId = company.id;
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, user.id),
    });
  });
  await db.auditEvent.create({
    data: {
      companyId,
      createdBy: user.id,
      action: "backup.test",
      targetType: "company",
      targetId: companyId,
    },
  });
  await store.put(`documents/${companyId}/a`, DOCUMENT);
  await store.put(`documents/${companyId}/b`, randomBytes(4096));
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await database?.release();
});

/** A fresh, empty database on the test server, dropped afterwards. */
async function emptyDatabase<T>(run: (url: string) => Promise<T>): Promise<T> {
  const base = new URL(database.url);
  const name = `jobflow_test_restore_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(
    `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`,
  );
  const target = new URL(base);
  target.pathname = `/${name}`;
  try {
    return await run(target.toString());
  } finally {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

const isEmpty = (url: string) => async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
    );
    return rows[0]!.count === "0";
  } finally {
    await client.end();
  }
};

describe("encrypted backups (#63)", () => {
  it("writes only ciphertext: no data, document bytes or object keys in plaintext", async () => {
    const manifest = await createBackup(
      { databaseUrl: database.url, store, appEnv: "test", ...pg },
      join(dir, "one"),
      key,
    );
    expect(manifest).toMatchObject({
      format: 2,
      appEnv: "test",
      objects: { count: 2 },
    });
    const files = [
      "manifest.json",
      manifest.database.file,
      manifest.objects.index,
      ...Object.keys(manifest.files),
    ];
    for (const file of files) {
      const bytes = await readFile(join(dir, "one", file));
      expect(bytes.includes(Buffer.from(MARKER))).toBe(false);
      expect(bytes.includes(Buffer.from(companyId))).toBe(false);
    }
    expect((await readdir(join(dir, "one", "objects"))).length).toBe(2);
    expect(await verifyBackup(join(dir, "one"))).toEqual(manifest);
    expect(await verifyBackup(join(dir, "one"), key)).toMatchObject({
      id: manifest.id,
      index: { objects: [{ bytes: DOCUMENT.length }, { bytes: 4096 }] },
    });
    // Never into a directory that already holds files.
    await expect(
      createBackup(
        { databaseUrl: database.url, store, ...pg },
        join(dir, "one"),
        key,
      ),
    ).rejects.toThrow(/empty directory/);
  });

  it("restores into an empty database and store: same rows, same documents", async () => {
    const target = new MemoryStore();
    await emptyDatabase(async (url) => {
      const restored = await restoreBackup(
        join(dir, "one"),
        { databaseUrl: url, store: target, ...pg },
        key,
        isEmpty(url),
      );
      expect(restored.objects).toBe(2);
      const copy = createDatabaseClient(url);
      try {
        expect(
          await copy.company.findUnique({ where: { id: companyId } }),
        ).toMatchObject({
          name: MARKER,
        });
        expect(await copy.auditEvent.count({ where: { companyId } })).toBe(1);
        // Append-only guards come back with the data.
        await expect(
          copy.auditEvent.deleteMany({ where: { companyId } }),
        ).rejects.toThrow();
      } finally {
        await copy.$disconnect();
      }
    });
    expect(
      Buffer.from((await target.get(`documents/${companyId}/a`))!),
    ).toEqual(DOCUMENT);
    expect(target.objects.size).toBe(2);
  });

  it("refuses a restore into a database that already has tables", async () => {
    await expect(
      restoreBackup(
        join(dir, "one"),
        { databaseUrl: database.url, store: new MemoryStore(), ...pg },
        key,
        isEmpty(database.url),
      ),
    ).rejects.toThrow(/empty database/);
  });

  it("refuses a tampered or swapped file, or the wrong key, restoring nothing", async () => {
    const tampered = join(dir, "tampered");
    await createBackup(
      { databaseUrl: database.url, store, ...pg },
      tampered,
      key,
    );
    const manifestPath = join(tampered, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      id: string;
      database: { file: string; sha256: string };
      files: Record<string, string>;
    };
    // 1. A changed dump byte, with the manifest hash forged to match: the
    //    sealed hash and the GCM tag still refuse it before pg_restore runs.
    const dumpPath = join(tampered, manifest.database.file);
    const dump = await readFile(dumpPath);
    dump[dump.length - 40]! ^= 0xff;
    await writeFile(dumpPath, dump);
    manifest.database.sha256 = createHash("sha256").update(dump).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyBackup(tampered)).resolves.toBeTruthy(); // hashes "match"
    await expect(verifyBackup(tampered, key)).rejects.toThrow();
    await emptyDatabase(async (url) => {
      const target = new MemoryStore();
      await expect(
        restoreBackup(
          tampered,
          { databaseUrl: url, store: target, ...pg },
          key,
          isEmpty(url),
        ),
      ).rejects.toThrow();
      expect(await isEmpty(url)()).toBe(true);
      expect(target.objects.size).toBe(0);
      // 2. The wrong key.
      await expect(
        restoreBackup(
          join(dir, "one"),
          { databaseUrl: url, store: target, ...pg },
          randomBytes(32),
          isEmpty(url),
        ),
      ).rejects.toThrow();
      expect(await isEmpty(url)()).toBe(true);
      expect(target.objects.size).toBe(0);
    });
    // 3. A document file swapped in from another backup (manifest forged):
    //    each file is bound to its backup id and name.
    const swapped = join(dir, "swapped");
    await createBackup(
      { databaseUrl: database.url, store, ...pg },
      swapped,
      key,
    );
    const foreign = await readFile(join(dir, "one", "objects", "000001.enc"));
    await writeFile(join(swapped, "objects", "000001.enc"), foreign);
    const swappedManifest = JSON.parse(
      await readFile(join(swapped, "manifest.json"), "utf8"),
    ) as { files: Record<string, string> };
    swappedManifest.files["objects/000001.enc"] = createHash("sha256")
      .update(foreign)
      .digest("hex");
    await writeFile(
      join(swapped, "manifest.json"),
      JSON.stringify(swappedManifest),
    );
    await expect(verifyBackup(swapped, key)).rejects.toThrow();
    // 4. Paths outside the backup layout are refused.
    manifest.database.file = "../../etc/passwd";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyBackup(tampered)).rejects.toThrow(/Unexpected file/);
  });

  it("round-trips buffers bound to their place and only accepts a 32-byte base64 key", () => {
    const at = { id: "backup-1", file: "objects/000001.enc" };
    const sealed = encryptBuffer(key, Buffer.from("x"), at);
    expect(decryptBuffer(key, sealed, at).toString()).toBe("x");
    expect(() =>
      decryptBuffer(key, sealed, { ...at, file: "objects/000002.enc" }),
    ).toThrow();
    expect(() =>
      decryptBuffer(key, sealed, { ...at, id: "backup-2" }),
    ).toThrow();
    expect(() => decryptBuffer(key, sealed.subarray(0, 10), at)).toThrow(
      /truncated/,
    );
    expect(backupKey(key.toString("base64"))).toEqual(key);
    expect(() => backupKey(undefined)).toThrow(/BACKUP_ENCRYPTION_KEY/);
    expect(() => backupKey(randomBytes(16).toString("base64"))).toThrow(
      /32 bytes/,
    );
  });

  it("keeps passwords and other secrets out of pg_dump's arguments and environment", () => {
    const connection = pgConnection(
      "postgresql://backup:s3cr%40t@db.example:5432/jobflow",
    );
    expect(connection.args.join(" ")).not.toContain("s3cr");
    expect(connection.env.PGPASSWORD).toBe("s3cr@t");
    expect(Object.keys(connection.env).sort()).toEqual(
      expect.arrayContaining(["PATH", "PGPASSWORD"]),
    );
    expect(connection.env).not.toHaveProperty("BACKUP_ENCRYPTION_KEY");
    expect(connection.env).not.toHaveProperty("DATABASE_URL");
  });

  it("keeps the newest backup of each recent day and month; ignores anything else", () => {
    const names = [
      "2026-10-25T021500Z",
      "2026-10-25T120000Z",
      "2026-10-24T021500Z",
      "2026-10-23T021500Z",
      "2026-09-30T021500Z",
      "2026-09-01T021500Z",
      "2026-08-31T021500Z",
      "notes.txt",
    ];
    expect(prunePlan(names, { daily: 2, monthly: 2 })).toEqual([
      "2026-10-25T021500Z",
      "2026-10-23T021500Z",
      "2026-09-01T021500Z",
      "2026-08-31T021500Z",
    ]);
    expect(prunePlan(names, { daily: 30, monthly: 12 })).toEqual([
      "2026-10-25T021500Z",
    ]);
  });

  it("prunes only complete backups and leaves an incomplete one without failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobflow-prune-test-"));
    try {
      for (const name of [
        "2026-10-25T021500Z",
        "2026-10-24T021500Z",
        "2026-10-23T021500Z",
      ]) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, "manifest.json"), "{}");
      }
      await mkdir(join(root, "2026-10-24T120000Z")); // a failed run's leftover
      await mkdir(join(root, "notes"));
      const { stdout, stderr } = await promisify(execFile)(
        new URL("../../node_modules/.bin/tsx", import.meta.url).pathname,
        [
          new URL("../../scripts/backup/cli.ts", import.meta.url).pathname,
          "prune",
          root,
          "--keep-daily",
          "1",
          "--keep-monthly",
          "1",
        ],
      );
      expect(stdout).toContain("Pruned 2 old backups.");
      expect(stderr).toContain("2026-10-24T120000Z");
      expect((await readdir(root)).sort()).toEqual([
        "2026-10-24T120000Z",
        "2026-10-25T021500Z",
        "notes",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
