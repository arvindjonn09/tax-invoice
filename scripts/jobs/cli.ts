// #233: the scheduled jobs. `pnpm jobs:run` makes one pass and exits, for a
// timer to run every few minutes. It's safe to overlap or repeat: each reminder
// is unique per company, last day and threshold. Queued emails go out through
// the app's outbox sweep. Needs DATABASE_URL, EMAIL_OUTBOX_KEY and BETTER_AUTH_URL.
import { createDatabaseClient } from "../../packages/database/src/index";
import { supportEmail } from "../../apps/web/src/server/email/addresses";
import { runTrialReminders } from "../../apps/web/src/server/trial/reminders";
import {
  loadLocalEnvironment,
  requireDatabaseUrl,
} from "../database/environment.mjs";

loadLocalEnvironment();

const emailSecret = process.env.EMAIL_OUTBOX_KEY;
const appUrl = process.env.BETTER_AUTH_URL;
if (!emailSecret || !appUrl) {
  console.error("EMAIL_OUTBOX_KEY and BETTER_AUTH_URL must be set");
  process.exit(1);
}
const url = requireDatabaseUrl(process.env.DATABASE_URL);
const db = createDatabaseClient(url.href);
try {
  const result = await runTrialReminders({
    db,
    emailSecret,
    appUrl: new URL(appUrl).origin,
    supportEmail: supportEmail(),
  });
  console.log(
    `Trial reminders: ${result.sent} queued, ${result.failed} failed.`,
  );
  const outbox = await db.emailOutbox.groupBy({
    by: ["status"],
    where: { status: { in: ["pending", "failed"] } },
    _count: { _all: true },
  });
  const count = (status: string) =>
    outbox.find((row) => row.status === status)?._count._all ?? 0;
  console.log(
    `Email outbox: ${count("pending")} pending, ${count("failed")} failed.`,
  );
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
