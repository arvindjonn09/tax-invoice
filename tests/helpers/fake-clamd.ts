import { type AddressInfo, createServer, type Server } from "node:net";

/**
 * A minimal clamd for tests (#136): speaks INSTREAM and PING, reassembles the
 * chunks and reports the EICAR test file as infected only when the stream is
 * exactly that file (real clamd's Win.Test.EICAR_HDB-1 is a hash of the whole
 * content). Uploads must be a real PDF or image to reach the scanner, so
 * app-level tests use TEST_MARKER, a fake-only signature. `mode` simulates
 * failures and protocol violations.
 */
/** Only this fake reports it (as Jobflow.Test.Marker); real clamd won't. */
export const TEST_MARKER = "JOBFLOW-FAKE-CLAMD-TEST-MARKER-7f3c";

export const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export type FakeClamdMode =
  | "normal"
  /** clamd's own error reply, e.g. StreamMaxLength exceeded. */
  | "error"
  /** Never answers. */
  | "silent"
  | "garbage"
  /** `stream: OK` and FIN, without the NUL terminator. */
  | "unterminated"
  /** `stream: OK\0` straight after the command, before the stream. */
  | "early"
  /** One byte of a never-finished reply every 100 ms. */
  | "drip"
  /** Reports the file as over clamd's limits (AlertExceedsMax). */
  | "limits";

export type FakeClamd = {
  port: number;
  received: Buffer[];
  mode: FakeClamdMode;
  /** Milliseconds to wait before answering a complete stream. */
  delayMs: number;
  /** Most streams being scanned at once. */
  peak: number;
  close: () => Promise<void>;
};

export async function startFakeClamd(): Promise<FakeClamd> {
  const state: FakeClamd = {
    port: 0,
    received: [],
    mode: "normal",
    delayMs: 0,
    peak: 0,
    close: async () => undefined,
  };
  let active = 0;
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    // A stream stops counting as active once answered (before the client can
    // see the reply), or when its connection closes.
    let counted = true;
    const done = () => {
      if (counted && commandRead) active -= 1;
      counted = false;
    };
    const chunks: Buffer[] = [];
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        const command = buffer.subarray(0, end).toString();
        if (command === "zPING") {
          if (state.mode === "silent") return;
          socket.end("PONG\0");
          return;
        }
        if (command !== "zINSTREAM") {
          socket.end("UNKNOWN COMMAND\0");
          return;
        }
        buffer = buffer.subarray(end + 1);
        commandRead = true;
        active += 1;
        state.peak = Math.max(state.peak, active);
        socket.on("close", done);
        if (state.mode === "early") {
          socket.write("stream: OK\0");
          return;
        }
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const file = Buffer.concat(chunks);
          state.received.push(file);
          buffer = Buffer.alloc(0);
          const mode = state.mode;
          if (mode === "silent" || mode === "early") return;
          if (mode === "drip") {
            const drip = (left: string) => {
              if (socket.destroyed || !left) return;
              socket.write(left[0]!);
              later(100, () => drip(left.slice(1)));
            };
            drip("stream: OK".repeat(10));
            return;
          }
          const reply =
            mode === "error"
              ? "INSTREAM size limit exceeded. ERROR\0"
              : mode === "garbage"
                ? "stream: maybe?\0"
                : mode === "unterminated"
                  ? "stream: OK"
                  : mode === "limits"
                    ? "stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0"
                    : file.equals(Buffer.from(EICAR))
                      ? "stream: Win.Test.EICAR_HDB-1 FOUND\0"
                      : file.includes(TEST_MARKER)
                        ? "stream: Jobflow.Test.Marker FOUND\0"
                        : "stream: OK\0";
          later(state.delayMs, () => {
            done();
            socket.end(reply);
          });
          return;
        }
        if (buffer.length < 4 + size) return;
        chunks.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      server.close(() => resolve());
    });
  return state;
}
