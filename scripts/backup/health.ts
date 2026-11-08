// #355: daily backup health check on the self-hosted site. Emails the
// operator (OPERATOR_NOTIFY_EMAIL, through the app's SMTP settings) when the
// nightly backup is failing or the file share is more than 2 days behind.
//   pnpm backup:health --local <root> --share <dir>|unreachable [--test]
// --test always sends, as a set-up confirmation. Run by
// infra/backup/host/health.sh, which decides whether the share is reachable
// without hanging on a sleeping computer.
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isBackupName } from "../../apps/web/src/server/backup/backup";
import {
  assessBackups,
  backupHealthEmail,
} from "../../apps/web/src/server/backup/health";
import { transportFromEnv } from "../../apps/web/src/server/email/transport";

const USAGE =
  "Usage: pnpm backup:health --local <root> --share <dir>|unreachable [--test]";

async function completeBackups(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const complete: string[] = [];
  for (const name of names) {
    if (!isBackupName(name)) continue;
    try {
      await access(join(root, name, "manifest.json"));
      complete.push(name);
    } catch {
      // Incomplete: left by a failed run, never counted.
    }
  }
  return complete;
}

async function main() {
  const { values } = parseArgs({
    options: {
      local: { type: "string" },
      share: { type: "string" },
      test: { type: "boolean", default: false },
    },
  });
  if (!values.local || !values.share) throw new Error(USAGE);
  const to = process.env.OPERATOR_NOTIFY_EMAIL?.trim();
  if (!to)
    throw new Error(
      "Set OPERATOR_NOTIFY_EMAIL: backup alerts have nowhere to go",
    );
  // Always as production: an alert must never fall back to the console.
  const transport = transportFromEnv(process.env, true);

  const health = assessBackups({
    local: await completeBackups(values.local),
    share:
      values.share === "unreachable"
        ? null
        : await completeBackups(values.share),
    now: new Date(),
  });
  if (health.ok && !values.test) {
    console.log("Backups are healthy; no email sent.");
    return;
  }
  await transport.send(backupHealthEmail(health, to, { test: values.test }));
  console.log(
    values.test
      ? `Test email sent (backups ${health.ok ? "healthy" : "need attention"}).`
      : `Alert email sent: ${health.problems.length} problem(s).`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
