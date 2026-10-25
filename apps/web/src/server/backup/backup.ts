import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStore } from "../documents/store";

// #63 Encrypted backups. A backup is a directory holding:
//   manifest.json      — format, backup id, time, counts and SHA-256 of every
//                        encrypted file (no data, no object keys, no secrets)
//   database.dump.enc  — `pg_dump --format=custom`, encrypted as it streams
//                        (plaintext never touches the disk while backing up)
//   objects.json.enc   — encrypted index: the dump's plaintext SHA-256 and,
//                        per document, its key, file, size and SHA-256
//   objects/NNNNNN.enc — each stored document, encrypted
// Encryption is AES-256-GCM with a 32-byte key kept apart from the backups
// (BACKUP_ENCRYPTION_KEY, base64). Every file has its own random 96-bit IV
// and a 128-bit tag, and is bound (as additional authenticated data) to its
// backup id and file name, so files can't be swapped between backups or
// positions. A changed byte, a wrong key, a truncated or substituted file
// fails to decrypt instead of restoring something wrong.

const MAGIC = Buffer.from("JFBACKUP2");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + IV_BYTES;
export const BACKUP_FORMAT = 2;

export type BackupManifest = {
  format: number;
  /** Random id bound into every file's authentication. */
  id: string;
  createdAt: string;
  appEnv: string | null;
  database: { file: string; bytes: number; sha256: string };
  objects: { index: string; count: number; bytes: number; sha256: string };
  files: Record<string, string>;
};

export type ObjectIndexEntry = {
  key: string;
  file: string;
  bytes: number;
  /** SHA-256 of the plaintext object, checked after restore. */
  sha256: string;
};

type SealedIndex = {
  /** SHA-256 of the plaintext dump, checked after decrypting it. */
  databaseSha256: string;
  objects: ObjectIndexEntry[];
};

/** The 32-byte key from base64; refuses anything else. */
export function backupKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error("Set BACKUP_ENCRYPTION_KEY (32 bytes, base64)");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded.trim())
    throw new Error("BACKUP_ENCRYPTION_KEY must be exactly 32 bytes, base64");
  return key;
}

const aad = (id: string, file: string) => Buffer.from(`${id}\n${file}`);

/** A transform that writes MAGIC‖IV, the ciphertext, then the GCM tag. */
export function encryptingStream(
  key: Buffer,
  binding: { id: string; file: string },
): Transform {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding.id, binding.file));
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!started) {
        started = true;
        this.push(Buffer.concat([MAGIC, iv]));
      }
      done(null, cipher.update(chunk));
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([MAGIC, iv]));
      const last = cipher.final();
      done(null, Buffer.concat([last, cipher.getAuthTag()]));
    },
  });
}

/** Encrypt a buffer in one go (indexes and documents). */
export function encryptBuffer(
  key: Buffer,
  plain: Uint8Array,
  binding: { id: string; file: string },
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding.id, binding.file));
  return Buffer.concat([
    MAGIC,
    iv,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function parseHeader(head: Buffer) {
  if (
    head.length < HEADER + TAG_BYTES ||
    !head.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Error("Not a JobFlow backup file (or it is truncated)");
  return head.subarray(MAGIC.length, HEADER);
}

/** Decrypt a buffer; throws if it was altered, moved or the key is wrong. */
export function decryptBuffer(
  key: Buffer,
  sealed: Buffer,
  binding: { id: string; file: string },
): Buffer {
  const iv = parseHeader(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(binding.id, binding.file));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(HEADER, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/**
 * Decrypt an encrypted file into `out` (a 0600 file), authenticating it
 * completely; returns the plaintext SHA-256. Nothing reads `out` until this
 * resolves, so a tampered file never reaches pg_restore.
 */
async function decryptFile(
  key: Buffer,
  path: string,
  binding: { id: string; file: string },
  out: string | null,
): Promise<string> {
  // One open handle for the size check, the header/tag and the body, so
  // the file can't be swapped between checking and reading it.
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size < HEADER + TAG_BYTES)
      throw new Error("Not a JobFlow backup file (or it is truncated)");
    const head = Buffer.alloc(HEADER);
    const tag = Buffer.alloc(TAG_BYTES);
    await file.read(head, 0, HEADER, 0);
    await file.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    const iv = parseHeader(Buffer.concat([head, tag]));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(binding.id, binding.file));
    decipher.setAuthTag(tag);
    const hash = createHash("sha256");
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, out ? chunk : undefined);
      },
    });
    const body = file.createReadStream({
      start: HEADER,
      end: size - TAG_BYTES - 1,
      autoClose: false,
    });
    if (out)
      await pipeline(
        body,
        decipher,
        tee,
        createWriteStream(out, { mode: 0o600, flags: "wx" }),
      );
    else
      await pipeline(body, decipher, tee, async function* (source) {
        for await (const _ of source) void _;
      });
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/**
 * Connection settings for pg_dump/pg_restore without secrets on the command
 * line: the password moves to PGPASSWORD in a minimal child environment
 * (no encryption key or storage secrets are passed on).
 */
export function pgConnection(url: string): {
  args: string[];
  env: Record<string, string>;
} {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  return {
    args: [`--dbname=${parsed.toString()}`],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(password ? { PGPASSWORD: password } : {}),
    },
  };
}

/** Run a command, wiring stdin/stdout to streams; rejects on non-zero exit. */
function run(
  command: string,
  args: readonly string[],
  io: {
    /** Consumes stdout; awaited before the command counts as done. */
    stdout?: (out: Readable) => Promise<unknown>;
    env: Record<string, string>;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", io.stdout ? "pipe" : "ignore", "pipe"],
      env: io.env as NodeJS.ProcessEnv,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const piping: Promise<unknown>[] = [];
    if (io.stdout && child.stdout) piping.push(io.stdout(child.stdout));
    child.once("error", reject);
    child.once("close", (code) => {
      Promise.all(piping)
        .then(() => {
          if (code === 0) resolve();
          // Connection strings never reach the message: only the tool's
          // own stderr tail, with any URL credentials masked.
          else
            reject(
              new Error(
                `${command} exited with ${code}: ${stderr.replace(/\/\/[^@\s]*@/g, "//***@")}`,
              ),
            );
        })
        .catch(reject);
    });
  });
}

export type BackupSource = {
  databaseUrl: string;
  store: ObjectStore & { keys(): AsyncIterable<string> };
  appEnv?: string | null;
  pgDump?: string;
};

/** Write an encrypted backup of the database and every stored object. */
export async function createBackup(
  source: BackupSource,
  outDir: string,
  key: Buffer,
): Promise<BackupManifest> {
  await mkdir(join(outDir, "objects"), { recursive: true, mode: 0o700 });
  const entries = await readdir(outDir);
  if (entries.some((name) => name !== "objects"))
    throw new Error("Back up into a new, empty directory");
  const id = randomUUID();

  const database = "database.dump.enc";
  const dumpHash = createHash("sha256");
  const connection = pgConnection(source.databaseUrl);
  await run(
    source.pgDump ?? "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", ...connection.args],
    {
      env: connection.env,
      stdout: (out) =>
        pipeline(
          out,
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              dumpHash.update(chunk);
              done(null, chunk);
            },
          }),
          encryptingStream(key, { id, file: database }),
          createWriteStream(join(outDir, database), { mode: 0o600 }),
        ),
    },
  );

  const index: ObjectIndexEntry[] = [];
  const files: Record<string, string> = {};
  let bytes = 0;
  for await (const objectKey of source.store.keys()) {
    const body = await source.store.get(objectKey);
    if (!body) continue; // deleted while listing
    const file = `objects/${String(index.length + 1).padStart(6, "0")}.enc`;
    const sealed = encryptBuffer(key, body, { id, file });
    await writeFile(join(outDir, file), sealed, { mode: 0o600 });
    files[file] = sha256(sealed);
    index.push({
      key: objectKey,
      file,
      bytes: body.length,
      sha256: sha256(body),
    });
    bytes += body.length;
  }
  const indexFile = "objects.json.enc";
  const sealedIndex = encryptBuffer(
    key,
    Buffer.from(
      JSON.stringify({
        databaseSha256: dumpHash.digest("hex"),
        objects: index,
      } satisfies SealedIndex),
    ),
    { id, file: indexFile },
  );
  await writeFile(join(outDir, indexFile), sealedIndex, { mode: 0o600 });

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    id,
    createdAt: new Date().toISOString(),
    appEnv: source.appEnv ?? null,
    database: {
      file: database,
      bytes: (await stat(join(outDir, database))).size,
      sha256: await sha256File(join(outDir, database)),
    },
    objects: {
      index: indexFile,
      count: index.length,
      bytes,
      sha256: sha256(sealedIndex),
    },
    files,
  };
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

const FILE_NAME =
  /^(database\.dump\.enc|objects\.json\.enc|objects\/\d{6}\.enc)$/;

/** A manifest file path, refusing anything outside the backup's layout. */
function inside(dir: string, file: string) {
  if (!FILE_NAME.test(file)) throw new Error(`Unexpected file ${file}`);
  return join(dir, file);
}

/**
 * Check every file against the manifest. With the key, also decrypt and
 * authenticate every file (the dump and each document against the hashes
 * sealed in the index) — a forged manifest or a wrong key fails here.
 */
export async function verifyBackup(
  dir: string,
  key?: Buffer,
): Promise<BackupManifest & { index?: SealedIndex }> {
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT)
    throw new Error(`Unknown backup format ${manifest.format}`);
  if (
    (await sha256File(inside(dir, manifest.database.file))) !==
    manifest.database.sha256
  )
    throw new Error("The database file doesn't match the manifest");
  const sealedIndex = await readFile(inside(dir, manifest.objects.index));
  if (sha256(sealedIndex) !== manifest.objects.sha256)
    throw new Error("The object index doesn't match the manifest");
  for (const [file, digest] of Object.entries(manifest.files))
    if (sha256(await readFile(inside(dir, file))) !== digest)
      throw new Error(`${file} doesn't match the manifest`);
  if (!key) return manifest;
  const index = JSON.parse(
    decryptBuffer(key, sealedIndex, {
      id: manifest.id,
      file: manifest.objects.index,
    }).toString("utf8"),
  ) as SealedIndex;
  if (
    (await decryptFile(
      key,
      inside(dir, manifest.database.file),
      { id: manifest.id, file: manifest.database.file },
      null,
    )) !== index.databaseSha256
  )
    throw new Error("The database dump failed its checksum");
  for (const entry of index.objects) {
    const body = decryptBuffer(key, await readFile(inside(dir, entry.file)), {
      id: manifest.id,
      file: entry.file,
    });
    if (sha256(body) !== entry.sha256)
      throw new Error(`Object ${entry.file} failed its checksum`);
  }
  return { ...manifest, index };
}

export type RestoreTarget = {
  /** An empty database: restore never overwrites existing tables. */
  databaseUrl: string;
  store: ObjectStore;
  pgRestore?: string;
};

/**
 * Restore a backup into an EMPTY database and a store. Every file is fully
 * authenticated before any of it is used: the dump is decrypted to a private
 * temporary file and checked against the sealed hash before pg_restore
 * reads it, and every document is checked before the first one is written.
 * If pg_restore or a document write then fails, the target is left partly
 * restored: drop it and start again (docs/ops/backups.md).
 */
export async function restoreBackup(
  dir: string,
  target: RestoreTarget,
  key: Buffer,
  isEmpty: () => Promise<boolean>,
): Promise<{ objects: number }> {
  const manifest = await verifyBackup(dir, key);
  const index = manifest.index!;
  if (!(await isEmpty()))
    throw new Error("Restore only into an empty database");
  const scratch = await mkdtemp(join(tmpdir(), "jobflow-restore-"));
  try {
    const dump = join(scratch, "database.dump");
    if (
      (await decryptFile(
        key,
        inside(dir, manifest.database.file),
        { id: manifest.id, file: manifest.database.file },
        dump,
      )) !== index.databaseSha256
    )
      throw new Error("The database dump failed its checksum");
    const connection = pgConnection(target.databaseUrl);
    await run(
      target.pgRestore ?? "pg_restore",
      [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
        ...connection.args,
        dump,
      ],
      { env: connection.env },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  for (const entry of index.objects) {
    const body = decryptBuffer(key, await readFile(inside(dir, entry.file)), {
      id: manifest.id,
      file: entry.file,
    });
    if (sha256(body) !== entry.sha256)
      throw new Error(`Object ${entry.file} failed its checksum`);
    await target.store.put(entry.key, body, "application/octet-stream");
  }
  return { objects: index.objects.length };
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;

/**
 * Which backup directories to delete under a retention policy: keep the
 * newest backup of each of the last `daily` days and of each of the last
 * `monthly` months. Names that aren't backup timestamps are never touched.
 */
/** Whether a directory name is a backup's UTC timestamp name. */
export const isBackupName = (name: string) => STAMP.test(name);

export function prunePlan(
  names: readonly string[],
  policy: { daily: number; monthly: number },
): string[] {
  const stamps = names
    .filter((name) => STAMP.test(name))
    .sort()
    .reverse();
  const keep = new Set<string>();
  const days = new Set<string>();
  const months = new Set<string>();
  for (const stamp of stamps) {
    const day = stamp.slice(0, 10);
    const month = stamp.slice(0, 7);
    if (!days.has(day) && days.size < policy.daily) {
      days.add(day);
      keep.add(stamp);
    }
    if (!months.has(month) && months.size < policy.monthly) {
      months.add(month);
      keep.add(stamp);
    }
  }
  return stamps.filter((stamp) => !keep.has(stamp));
}
