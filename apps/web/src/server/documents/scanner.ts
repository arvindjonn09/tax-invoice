import { connect } from "node:net";

// #136: every upload is scanned for malware before it is stored (owner
// decision 5 November 2026: ClamAV). The scanner speaks clamd's INSTREAM
// protocol over TCP with Node's own `net`, so there's no extra dependency.
// Scanning fails closed: if it's required and clamd can't give a clear
// answer, the upload is refused and nothing is stored.

export type ScanResult =
  | { status: "clean" }
  | { status: "infected"; detection: string }
  /** clamd couldn't fully check the file (limits exceeded, encrypted). */
  | { status: "unscannable"; detection: string };

/** Frees a scan slot. Safe to call more than once. */
export type Release = () => void;

export interface MalwareScanner {
  /**
   * Take one of the limited scan slots, before the upload body is read, so a
   * burst can't exhaust clamd's threads or the app's memory. Rejects with
   * ScannerUnavailable("busy") when no slot frees up in time.
   */
  reserve(): Promise<Release>;
  scan(bytes: Uint8Array): Promise<ScanResult>;
  /** clamd answers PING with PONG (readiness). */
  ping(): Promise<boolean>;
}

/** Thrown when the scanner can't give a clear clean/infected answer. */
export class ScannerUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`Malware scanner unavailable: ${reason}`);
  }
}

const CHUNK = 64 * 1024;
const MAX_REPLY = 1024;

/** A counting semaphore with a bounded wait. */
function slots(max: number, waitMs: number) {
  let free = max;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  return (): Promise<Release> =>
    new Promise<Release>((resolve, reject) => {
      const grant = () => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          release();
        });
      };
      if (free > 0) {
        free -= 1;
        grant();
        return;
      }
      const timer = setTimeout(() => {
        const index = waiting.indexOf(onFree);
        if (index >= 0) waiting.splice(index, 1);
        reject(new ScannerUnavailable("busy"));
      }, waitMs);
      const onFree = () => {
        clearTimeout(timer);
        grant();
      };
      waiting.push(onFree);
    });
}

/**
 * One request/response exchange with clamd. The reply counts only once it is
 * NUL-terminated; a connection that ends without the terminator, or a reply
 * that arrives before everything was sent, is "unavailable".
 */
function exchange(options: {
  host: string;
  port: number;
  idleMs: number;
  deadlineMs: number;
  send: (socket: ReturnType<typeof connect>, done: () => void) => void;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let reply = "";
    let sent = false;
    let settled = false;
    const socket = connect({ host: options.host, port: options.port });
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    // The idle timer alone lets a slow drip run forever: this one doesn't.
    const deadline = setTimeout(
      () => finish(new ScannerUnavailable("deadline")),
      options.deadlineMs,
    );
    socket.setTimeout(options.idleMs, () =>
      finish(new ScannerUnavailable("timeout")),
    );
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(new ScannerUnavailable(error.code ?? "connection")),
    );
    socket.on("data", (data) => {
      if (!sent) return finish(new ScannerUnavailable("early reply"));
      reply += data.toString("utf8");
      const end = reply.indexOf("\0");
      if (end >= 0) return finish(null, reply.slice(0, end));
      if (reply.length > MAX_REPLY)
        finish(new ScannerUnavailable("reply too long"));
    });
    socket.on("end", () => finish(new ScannerUnavailable("cut-off reply")));
    socket.on("close", () => finish(new ScannerUnavailable("closed")));
    socket.on("connect", () =>
      options.send(socket, () => {
        sent = true;
      }),
    );
  });
}

/**
 * clamd INSTREAM: send `zINSTREAM\0`, then chunks of `<uint32 BE length><bytes>`,
 * then a zero-length chunk. clamd answers `stream: OK`, `stream: <name> FOUND`
 * or an error, terminated by NUL.
 */
export function clamdScanner(options: {
  host: string;
  port: number;
  /** No bytes either way for this long: give up. */
  idleMs?: number;
  /** The whole scan, connect to answer. Shorter than nginx's 60 s. */
  deadlineMs?: number;
  /** Concurrent scans per app process (clamd's MaxThreads defaults to 10). */
  maxConcurrent?: number;
  /** How long an upload waits for a free slot before a 503. */
  slotWaitMs?: number;
}): MalwareScanner {
  const idleMs = options.idleMs ?? 30_000;
  const deadlineMs = options.deadlineMs ?? 45_000;
  const reserve = slots(
    options.maxConcurrent ?? 4,
    options.slotWaitMs ?? 10_000,
  );
  const target = { host: options.host, port: options.port };
  return {
    reserve,
    async scan(bytes) {
      try {
        const reply = await exchange({
          ...target,
          idleMs,
          deadlineMs,
          send(socket, done) {
            socket.write("zINSTREAM\0");
            for (let offset = 0; offset < bytes.length; offset += CHUNK) {
              const chunk = bytes.subarray(offset, offset + CHUNK);
              const size = Buffer.alloc(4);
              size.writeUInt32BE(chunk.length);
              socket.write(size);
              socket.write(chunk);
            }
            // Zero-length chunk: end of stream. Only once it is written may
            // a reply count.
            socket.write(Buffer.alloc(4), done);
          },
        });
        return parseReply(reply);
      } catch (error) {
        if (error instanceof ScannerUnavailable) throw error;
        throw new ScannerUnavailable("scan failed");
      }
    },
    async ping() {
      try {
        const reply = await exchange({
          ...target,
          idleMs: 2000,
          deadlineMs: 2500,
          send(socket, done) {
            socket.write("zPING\0", done);
          },
        });
        return reply.trim() === "PONG";
      } catch {
        return false;
      }
    },
  };
}

/**
 * Detections that mean "clamd couldn't fully check this file", raised when
 * clamd.conf sets AlertExceedsMax (and, if the owner chooses, the
 * AlertEncrypted* options): see infra/staging/clamav/clamd.conf.
 */
const UNSCANNABLE = /^Heuristics\.(Limits\.Exceeded|Encrypted)/;

/** Parse clamd's reply (without its NUL). Anything unclear is "unavailable". */
export function parseReply(raw: string): ScanResult {
  const reply = raw.trim();
  if (/^stream: OK$/.test(reply)) return { status: "clean" };
  const found = /^stream: (.{1,200}) FOUND$/.exec(reply);
  if (found) {
    const detection = found[1]!;
    return UNSCANNABLE.test(detection)
      ? { status: "unscannable", detection }
      : { status: "infected", detection };
  }
  // e.g. "INSTREAM size limit exceeded. ERROR", or anything unexpected.
  throw new ScannerUnavailable("unexpected reply");
}

/** APP_ENV values that may switch scanning off with MALWARE_SCAN=off. */
const MAY_DISABLE = new Set(["development", "test"]);

export type Scanning = {
  /** Uploads are refused unless a scanner gives a clear answer. */
  required: boolean;
  scanner: MalwareScanner | null;
  /** MALWARE_SCAN=off was honoured (development and test only). */
  disabled: boolean;
};

/**
 * Scanning is required whenever NODE_ENV=production (every built app) or
 * APP_ENV is staging or production, so a missing or broken scanner refuses
 * uploads. Only `MALWARE_SCAN=off` with APP_ENV development or test turns it
 * off; on any other APP_ENV the switch is ignored. Outside production builds
 * (CI, `pnpm dev`) the scanner is used when CLAMAV_HOST is set.
 */
export function scannerFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Scanning {
  const appEnv = env.APP_ENV?.trim().toLowerCase() ?? "";
  const disabled =
    env.MALWARE_SCAN?.trim().toLowerCase() === "off" && MAY_DISABLE.has(appEnv);
  const required =
    !disabled &&
    (env.NODE_ENV === "production" ||
      appEnv === "staging" ||
      appEnv === "production");
  const host = env.CLAMAV_HOST?.trim();
  if (disabled || !host) return { required, scanner: null, disabled };
  const port = Number(env.CLAMAV_PORT ?? "3310");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { required, scanner: null, disabled };
  return { required, scanner: clamdScanner({ host, port }), disabled };
}
