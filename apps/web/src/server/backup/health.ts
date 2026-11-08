// #355: the daily backup health check on the self-hosted site. Decides,
// from the names of complete backups locally and on the file share, whether
// the operator needs an email. Pure, so the thresholds are unit-tested.
import type { EmailMessage } from "../email/transport";
import { isBackupName } from "./backup";

export type BackupHealthInput = {
  /** Names of complete local backups (with a manifest). */
  local: readonly string[];
  /** Names of complete backups on the share, or null when it's unreachable. */
  share: readonly string[] | null;
  now: Date;
  /** The nightly backup runs every 24 hours; 2 hours of slack. */
  maxLocalAgeHours?: number;
  /** The owner's computer may sleep overnight; only 2 days behind is news. */
  maxShareAgeHours?: number;
};

export type BackupHealth = {
  ok: boolean;
  problems: string[];
  newestLocal: Date | null;
  newestShare: Date | null;
  shareReachable: boolean;
};

/** A backup name such as 2026-11-08T024207Z as a time, or null. */
export function backupTime(name: string): Date | null {
  if (!isBackupName(name)) return null;
  const iso = `${name.slice(0, 13)}:${name.slice(13, 15)}:${name.slice(15, 17)}Z`;
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? null : time;
}

function newest(names: readonly string[]): Date | null {
  let best: Date | null = null;
  for (const name of names) {
    const time = backupTime(name);
    if (time && (!best || time > best)) best = time;
  }
  return best;
}

const HOUR = 3_600_000;

export function assessBackups(input: BackupHealthInput): BackupHealth {
  const maxLocal = input.maxLocalAgeHours ?? 26;
  const maxShare = input.maxShareAgeHours ?? 48;
  const newestLocal = newest(input.local);
  const newestShare = input.share ? newest(input.share) : null;
  const shareReachable = input.share !== null;
  const age = (time: Date) => (input.now.getTime() - time.getTime()) / HOUR;
  const problems: string[] = [];

  if (!newestLocal) {
    problems.push("There is no complete backup on this server.");
  } else if (age(newestLocal) > maxLocal) {
    problems.push(
      `The nightly backup is failing: the newest one on this server is ${Math.floor(age(newestLocal))} hours old.`,
    );
  }

  if (!newestShare || age(newestShare) > maxShare) {
    const behind = newestShare
      ? `the newest backup there is ${Math.floor(age(newestShare) / 24)} days old`
      : "it holds no complete backup";
    problems.push(
      shareReachable
        ? `The file share is behind: ${behind}, although it can be reached. Copies to it are failing.`
        : `The file share can't be reached, and ${behind}. Check that the Windows computer is on and connected.`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    newestLocal,
    newestShare,
    shareReachable,
  };
}

const sydney = (time: Date | null) =>
  time
    ? `${new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(time)} (Sydney)`
    : "none";

const CHECKS = [
  "To see what happened, on the server:",
  "  systemctl list-timers 'jobflow-backup*'",
  "  journalctl -u jobflow-backup.service -u jobflow-backup-sync.service -n 50",
  "Backups are explained in docs/ops/backups.md.",
];

/** The alert, or with `test` the set-up confirmation. No secrets or hosts. */
export function backupHealthEmail(
  health: BackupHealth,
  to: string,
  options: { test?: boolean } = {},
): EmailMessage {
  const status = [
    `Newest backup on this server: ${sydney(health.newestLocal)}`,
    `Newest backup on the file share: ${sydney(health.newestShare)}${health.shareReachable ? "" : " (share not reachable now)"}`,
  ];
  if (options.test) {
    return {
      to,
      subject: "JobFlow backup alerts are set up",
      text: [
        "This is a test. JobFlow will email this address once a day if backups stop working, or if the file share falls more than 2 days behind.",
        "",
        health.ok
          ? "Backups are healthy right now."
          : "Backups need attention right now:",
        ...health.problems.map((problem) => `- ${problem}`),
        "",
        ...status,
      ].join("\n"),
    };
  }
  return {
    to,
    subject: "JobFlow backups need attention",
    text: [
      ...health.problems.map((problem) => `- ${problem}`),
      "",
      ...status,
      "",
      ...CHECKS,
      "",
      "This email repeats once a day until the problem is fixed.",
    ].join("\n"),
  };
}
