import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStore } from "../documents/store";

// #63 Encrypted backups. A backup is a directory holding:
//   manifest.json      — format version, time, counts and SHA-256 of every
//                        encrypted file (no data, no object keys, no secrets)
//   database.dump.enc  — `pg_dump --format=custom`, encrypted as it streams
//                        (plaintext never touches the disk)
//   objects.json.enc   — encrypted index: object key → file, size, SHA-256
//   objects/NNNNNN.enc — each stored document, encrypted
// Encryption is AES-256-GCM with a 32-byte key kept apart from the backups
// (BACKUP_ENCRYPTION_KEY, base64). Every file has its own random 96-bit IV
// and a 128-bit tag: a changed byte, a wrong key or a truncated file fails
// to decrypt instead of restoring something wrong.

const MAGIC = Buffer.from("JFBACKUP1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + IV_BYTES;
export const BACKUP_FORMAT = 1;

export type BackupManifest = {
  format: number;
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

/** The 32-byte key from base64; refuses anything else. */
export function backupKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error("Set BACKUP_ENCRYPTION_KEY (32 bytes, base64)");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded.trim())
    throw new Error("BACKUP_ENCRYPTION_KEY must be exactly 32 bytes, base64");
  return key;
}

/** A transform that writes MAGIC‖IV, the ciphertext, then the GCM tag. */
export function encryptingStream(key: Buffer): Transform {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
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

/** Encrypt a buffer in one go (indexes and small objects). */
export function encryptBuffer(key: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
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

/** Decrypt a buffer; throws if it was altered or the key is wrong. */
export function decryptBuffer(key: Buffer, sealed: Buffer): Buffer {
  const iv = parseHeader(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(HEADER, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/**
 * A stream of an encrypted file's plaintext. The tag is read first (it sits
 * at the end), and the stream errors at the end if anything was altered —
 * so callers must treat the restore as failed unless the stream finishes.
 */
export async function decryptingFileStream(
  key: Buffer,
  path: string,
): Promise<Readable> {
  const { size } = await stat(path);
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(HEADER);
    await file.read(head, 0, HEADER, 0);
    const tag = Buffer.alloc(TAG_BYTES);
    if (size < HEADER + TAG_BYTES)
      throw new Error("Not a JobFlow backup file (or it is truncated)");
    await file.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    const iv = parseHeader(Buffer.concat([head, tag]));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const body = createReadStream(path, {
      start: HEADER,
      end: size - TAG_BYTES - 1,
    });
    return body.pipe(decipher);
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

/** Run a command, wiring stdin/stdout to streams; rejects on non-zero exit. */
function run(
  command: string,
  args: readonly string[],
  io: {
    stdin?: Readable;
    /** Consumes stdout; awaited before the command counts as done. */
    stdout?: (out: Readable) => Promise<unknown>;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [
        io.stdin ? "pipe" : "ignore",
        io.stdout ? "pipe" : "ignore",
        "pipe",
      ],
      env: io.env ?? process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const piping: Promise<unknown>[] = [];
    if (io.stdin && child.stdin) piping.push(pipeline(io.stdin, child.stdin));
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

  const database = "database.dump.enc";
  await run(
    source.pgDump ?? "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--dbname=${source.databaseUrl}`,
    ],
    {
      stdout: (out) =>
        pipeline(
          out,
          encryptingStream(key),
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
    const sealed = encryptBuffer(key, body);
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
  const sealedIndex = encryptBuffer(key, Buffer.from(JSON.stringify(index)));
  await writeFile(join(outDir, indexFile), sealedIndex, { mode: 0o600 });

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
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

/** Check every file's SHA-256 against the manifest before restoring. */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT)
    throw new Error(`Unknown backup format ${manifest.format}`);
  if (
    (await sha256File(join(dir, manifest.database.file))) !==
    manifest.database.sha256
  )
    throw new Error("The database file doesn't match the manifest");
  if (
    sha256(await readFile(join(dir, manifest.objects.index))) !==
    manifest.objects.sha256
  )
    throw new Error("The object index doesn't match the manifest");
  for (const [file, digest] of Object.entries(manifest.files))
    if (sha256(await readFile(join(dir, file))) !== digest)
      throw new Error(`${file} doesn't match the manifest`);
  return manifest;
}

export type RestoreTarget = {
  /** An empty database: restore never overwrites existing tables. */
  databaseUrl: string;
  store: ObjectStore;
  pgRestore?: string;
  psql?: string;
};

/**
 * Restore a verified backup into an EMPTY database and a store. Every file
 * is authenticated; a changed byte or wrong key aborts the restore.
 */
export async function restoreBackup(
  dir: string,
  target: RestoreTarget,
  key: Buffer,
  isEmpty: () => Promise<boolean>,
): Promise<{ objects: number }> {
  const manifest = await verifyBackup(dir);
  if (!(await isEmpty()))
    throw new Error("Restore only into an empty database");
  // Decrypt the whole index first: a wrong key fails before anything runs.
  const index = JSON.parse(
    decryptBuffer(
      key,
      await readFile(join(dir, manifest.objects.index)),
    ).toString("utf8"),
  ) as ObjectIndexEntry[];
  await run(
    target.pgRestore ?? "pg_restore",
    [
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction",
      `--dbname=${target.databaseUrl}`,
    ],
    {
      stdin: await decryptingFileStream(key, join(dir, manifest.database.file)),
    },
  );
  for (const entry of index) {
    const body = decryptBuffer(key, await readFile(join(dir, entry.file)));
    if (sha256(body) !== entry.sha256)
      throw new Error(`Object ${entry.file} failed its checksum`);
    await target.store.put(entry.key, body, "application/octet-stream");
  }
  return { objects: index.length };
}

/** Readable from bytes (tests and small payloads). */
export const readableOf = (data: Uint8Array) =>
  Readable.from([Buffer.from(data)]);

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;

/**
 * Which backup directories to delete under a retention policy: keep the
 * newest backup of each of the last `daily` days and of each of the last
 * `monthly` months. Names that aren't backup timestamps are never touched.
 */
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
