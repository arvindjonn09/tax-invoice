import { connect } from "node:net";

// #136: every upload is scanned for malware before it is stored (owner
// decision 5 November 2026: ClamAV). The scanner speaks clamd's INSTREAM
// protocol over TCP with Node's own `net`, so there's no extra dependency.
// Scanning fails closed: if it's required and clamd can't give a clear
// answer, the upload is refused and nothing is stored.

export type ScanResult =
  { status: "clean" } | { status: "infected"; signature: string };

export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

/** Thrown when the scanner can't give a clear clean/infected answer. */
export class ScannerUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`Malware scanner unavailable: ${reason}`);
  }
}

const CHUNK = 64 * 1024;
const MAX_REPLY = 1024;

/**
 * clamd INSTREAM: send `zINSTREAM\0`, then chunks of `<uint32 BE length><bytes>`,
 * then a zero-length chunk. clamd answers `stream: OK`, `stream: <name> FOUND`
 * or an error, terminated by NUL.
 */
export function clamdScanner(options: {
  host: string;
  port: number;
  timeoutMs?: number;
}): MalwareScanner {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    scan(bytes) {
      return new Promise<ScanResult>((resolve, reject) => {
        let reply = "";
        let settled = false;
        const finish = (error: Error | null, result?: ScanResult) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error);
          else resolve(result!);
        };
        // parseReply throws on an unclear reply: that must reject the scan,
        // never escape the socket's event handler.
        const answer = () => {
          try {
            finish(null, parseReply(reply));
          } catch (error) {
            finish(error as Error);
          }
        };
        const socket = connect({ host: options.host, port: options.port });
        socket.setTimeout(timeoutMs, () =>
          finish(new ScannerUnavailable("timeout")),
        );
        socket.on("error", (error) =>
          finish(new ScannerUnavailable(error.name || "connection")),
        );
        socket.on("data", (data) => {
          reply += data.toString("utf8");
          if (reply.length > MAX_REPLY)
            return finish(new ScannerUnavailable("reply too long"));
          if (reply.includes("\0")) answer();
        });
        socket.on("end", () =>
          reply ? answer() : finish(new ScannerUnavailable("no reply")),
        );
        socket.on("connect", () => {
          socket.write("zINSTREAM\0");
          for (let offset = 0; offset < bytes.length; offset += CHUNK) {
            const chunk = bytes.subarray(offset, offset + CHUNK);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            socket.write(size);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4)); // zero-length chunk: end of stream
        });
      }).catch((error: unknown) => {
        if (error instanceof ScannerUnavailable) throw error;
        throw new ScannerUnavailable("scan failed");
      });
    },
  };
}

/** Parse clamd's reply. Anything but a clear OK or FOUND is "unavailable". */
export function parseReply(raw: string): ScanResult {
  const reply = raw.replace(/\0[\s\S]*$/, "").trim();
  if (/^stream: OK$/.test(reply)) return { status: "clean" };
  const found = /^stream: (.{1,200}) FOUND$/.exec(reply);
  if (found) return { status: "infected", signature: found[1]! };
  // e.g. "INSTREAM size limit exceeded. ERROR", or anything unexpected.
  throw new ScannerUnavailable("unexpected reply");
}

/**
 * Scanning is required on staging and production (APP_ENV), so a missing or
 * broken scanner there refuses uploads. Elsewhere (development, CI) it is used
 * when CLAMAV_HOST is set and skipped otherwise.
 */
export function scannerFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { required: boolean; scanner: MalwareScanner | null } {
  const required =
    env.APP_ENV === "production" ||
    env.APP_ENV === "staging" ||
    (!env.APP_ENV && env.NODE_ENV === "production");
  const host = env.CLAMAV_HOST?.trim();
  if (!host) return { required, scanner: null };
  const port = Number(env.CLAMAV_PORT ?? "3310");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { required, scanner: null };
  return { required, scanner: clamdScanner({ host, port }) };
}
