// #259: host CLI for the email suppression list.
//   pnpm email suppress --address <a> --reason bounce|complaint|manual
//   pnpm email unsuppress --address <a>
// Needs DATABASE_URL and EMAIL_OUTBOX_KEY (the app's), and stores only the
// address HMAC. The address is never printed or logged.
import { parseArgs } from "node:util";
import { createDatabaseClient } from "../../packages/database/src/index";
import {
  SUPPRESSION_REASONS,
  type SuppressionReason,
  suppressAddress,
  unsuppressAddress,
} from "../../apps/web/src/server/email/suppression";
import {
  loadLocalEnvironment,
  requireDatabaseUrl,
} from "../database/environment.mjs";

const USAGE =
  "Usage: pnpm email suppress --address <a> --reason bounce|complaint|manual\n" +
  "       pnpm email unsuppress --address <a>";

loadLocalEnvironment();
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { address: { type: "string" }, reason: { type: "string" } },
  });
  const [command] = positionals;
  if (
    positionals.length !== 1 ||
    (command !== "suppress" && command !== "unsuppress") ||
    !values.address
  )
    throw new Error(USAGE);
  if (
    command === "suppress" &&
    !SUPPRESSION_REASONS.includes(values.reason as SuppressionReason)
  )
    throw new Error(`--reason must be bounce, complaint or manual\n${USAGE}`);
  if (command === "unsuppress" && values.reason)
    throw new Error(`unsuppress takes no --reason\n${USAGE}`);
  const secret = process.env.EMAIL_OUTBOX_KEY;
  if (!secret) throw new Error("Set EMAIL_OUTBOX_KEY to the app's value");
  const db = createDatabaseClient(
    requireDatabaseUrl(process.env.DATABASE_URL).toString(),
  );
  try {
    const result =
      command === "suppress"
        ? await suppressAddress(
            db,
            secret,
            values.address,
            values.reason as SuppressionReason,
          )
        : await unsuppressAddress(db, secret, values.address);
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
