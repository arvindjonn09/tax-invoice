// #259: host CLI for the email suppression list. The address is read from
// standard input, never from the command line, because pnpm prints a
// script's arguments and shells keep them in history:
//   printf '%s\n' 'someone@example.com' | pnpm email suppress --reason bounce
//   printf '%s\n' 'someone@example.com' | pnpm email unsuppress
// Typing the address at the "Address:" prompt works too. Needs the app's
// DATABASE_URL and EMAIL_OUTBOX_KEY. Only the address HMAC is stored, and the
// audit row records who ran it (--by, or the OS user).
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createDatabaseClient } from "../../packages/database/src/index";
import {
  SUPPRESSION_REASONS,
  type SuppressionReason,
  checkAddress,
  checkRanBy,
  suppressAddress,
  unsuppressAddress,
} from "../../apps/web/src/server/email/suppression";
import {
  loadLocalEnvironment,
  requireDatabaseUrl,
} from "../database/environment.mjs";

const USAGE =
  "Usage: pnpm email suppress --reason bounce|complaint|manual [--by <name>]\n" +
  "       pnpm email unsuppress [--by <name>]\n" +
  "The address is read from standard input.";

async function readAddress(): Promise<string> {
  const lines = createInterface({
    input: process.stdin,
    output: process.stdin.isTTY ? process.stderr : undefined,
    terminal: process.stdin.isTTY,
  });
  try {
    if (process.stdin.isTTY) process.stderr.write("Address: ");
    for await (const line of lines) return line;
    return "";
  } finally {
    lines.close();
  }
}

loadLocalEnvironment();
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      address: { type: "string" },
      reason: { type: "string" },
      by: { type: "string" },
    },
  });
  if (values.address !== undefined)
    throw new Error(
      `--address isn't accepted: pnpm would print it. Pipe the address in instead.\n${USAGE}`,
    );
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    (command !== "suppress" && command !== "unsuppress")
  )
    throw new Error(USAGE);
  if (
    command === "suppress" &&
    !SUPPRESSION_REASONS.includes(values.reason as SuppressionReason)
  )
    throw new Error(`--reason must be bounce, complaint or manual\n${USAGE}`);
  if (command === "unsuppress" && values.reason)
    throw new Error(`unsuppress takes no --reason\n${USAGE}`);
  const ranBy = checkRanBy(values.by ?? userInfo().username);
  const secret = process.env.EMAIL_OUTBOX_KEY;
  if (!secret) throw new Error("Set EMAIL_OUTBOX_KEY to the app's value");
  const address = checkAddress(await readAddress());
  const db = createDatabaseClient(
    requireDatabaseUrl(process.env.DATABASE_URL).toString(),
  );
  try {
    const result =
      command === "suppress"
        ? await suppressAddress(
            db,
            secret,
            address,
            values.reason as SuppressionReason,
            ranBy,
          )
        : await unsuppressAddress(db, secret, address, ranBy);
    const id = result.addressHash.slice(0, 12);
    console.log(
      result.changed
        ? `${command === "suppress" ? "Suppressed" : "Unsuppressed"} (${id}…).`
        : `No change (${id}…).`,
    );
  } finally {
    await db.$disconnect();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
