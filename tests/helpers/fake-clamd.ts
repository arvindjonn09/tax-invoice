import { type AddressInfo, createServer, type Server } from "node:net";

/**
 * A minimal clamd for tests (#136): speaks INSTREAM, reassembles the chunks
 * and reports the EICAR test string as infected. `mode` simulates failures.
 */
export const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export type FakeClamd = {
  port: number;
  received: Buffer[];
  mode: "normal" | "error" | "silent" | "garbage";
  close: () => Promise<void>;
};

export async function startFakeClamd(): Promise<FakeClamd> {
  const state: FakeClamd = {
    port: 0,
    received: [],
    mode: "normal",
    close: async () => undefined,
  };
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    const chunks: Buffer[] = [];
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        if (buffer.subarray(0, end).toString() !== "zINSTREAM") {
          socket.end("UNKNOWN COMMAND\0");
          return;
        }
        buffer = buffer.subarray(end + 1);
        commandRead = true;
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const file = Buffer.concat(chunks);
          state.received.push(file);
          if (state.mode === "silent") return; // never answer
          const reply =
            state.mode === "error"
              ? "INSTREAM size limit exceeded. ERROR\0"
              : state.mode === "garbage"
                ? "stream: maybe?\0"
                : file.includes(EICAR)
                  ? "stream: Win.Test.EICAR_HDB-1 FOUND\0"
                  : "stream: OK\0";
          socket.end(reply);
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
    new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
