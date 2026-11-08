import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessBackups,
  backupHealthEmail,
  backupTime,
} from "../../apps/web/src/server/backup/health";

// #355: the daily backup health check and its email alert.
const now = new Date("2026-11-10T00:00:00Z"); // 11:00 Sydney
const hoursAgo = (hours: number) => {
  const t = new Date(now.getTime() - hours * 3_600_000).toISOString();
  return `${t.slice(0, 10)}T${t.slice(11, 13)}${t.slice(14, 16)}${t.slice(17, 19)}Z`;
};

describe("backupTime", () => {
  it("reads a backup name as UTC", () => {
    expect(backupTime("2026-11-08T024207Z")?.toISOString()).toBe(
      "2026-11-08T02:42:07.000Z",
    );
  });
  it("ignores anything else", () => {
    expect(backupTime(".incoming")).toBeNull();
    expect(backupTime("2026-13-45T999999Z")).toBeNull();
  });
});

describe("assessBackups (#355)", () => {
  it("is healthy after a normal night, even with the share a night behind", () => {
    // The owner's computer slept through last night's copy.
    const health = assessBackups({
      local: [hoursAgo(9), hoursAgo(33)],
      share: [hoursAgo(33)],
      now,
    });
    expect(health).toMatchObject({ ok: true, problems: [] });
  });

  it("flags a failing nightly backup after 26 hours", () => {
    const health = assessBackups({
      local: [hoursAgo(27)],
      share: [hoursAgo(27)],
      now,
    });
    expect(health.ok).toBe(false);
    expect(health.problems).toEqual([
      "The nightly backup is failing: the newest one on this server is 27 hours old.",
    ]);
  });

  it("flags no local backup at all", () => {
    const health = assessBackups({ local: [], share: [hoursAgo(5)], now });
    expect(health.problems).toEqual([
      "There is no complete backup on this server.",
    ]);
  });

  it("flags an unreachable share only once it's more than 2 days behind", () => {
    expect(
      assessBackups({ local: [hoursAgo(9)], share: null, now }).problems,
    ).toEqual([
      "The file share can't be reached, and it holds no complete backup. Check that the Windows computer is on and connected.",
    ]);
    const behind = assessBackups({
      local: [hoursAgo(9)],
      share: [hoursAgo(73)],
      now,
    });
    expect(behind.problems).toEqual([
      "The file share is behind: the newest backup there is 3 days old, although it can be reached. Copies to it are failing.",
    ]);
    expect(
      assessBackups({ local: [hoursAgo(9)], share: [hoursAgo(47)], now }).ok,
    ).toBe(true);
  });

  it("reports both problems together", () => {
    const health = assessBackups({ local: [], share: [], now });
    expect(health.problems).toHaveLength(2);
    expect(health.shareReachable).toBe(true);
  });

  it("honours custom thresholds", () => {
    expect(
      assessBackups({
        local: [hoursAgo(3)],
        share: [hoursAgo(3)],
        now,
        maxLocalAgeHours: 2,
        maxShareAgeHours: 2,
      }).problems,
    ).toHaveLength(2);
  });
});

describe("backupHealthEmail (#355)", () => {
  const failing = assessBackups({
    local: [hoursAgo(30)],
    share: null,
    now,
  });

  it("names the problems, the newest times in Sydney, and how to check", () => {
    const email = backupHealthEmail(failing, "owner@example.test");
    expect(email.to).toBe("owner@example.test");
    expect(email.subject).toBe("JobFlow backups need attention");
    expect(email.text).toContain("- The nightly backup is failing");
    expect(email.text).toContain("(Sydney)");
    expect(email.text).toContain(
      "Newest backup on the file share: none (share not reachable now)",
    );
    expect(email.text).toContain("journalctl -u jobflow-backup.service");
    expect(email.text).toContain("repeats once a day");
  });

  it("sends a set-up confirmation with --test", () => {
    const healthy = assessBackups({
      local: [hoursAgo(1)],
      share: [hoursAgo(1)],
      now,
    });
    const email = backupHealthEmail(healthy, "owner@example.test", {
      test: true,
    });
    expect(email.subject).toBe("JobFlow backup alerts are set up");
    expect(email.text).toContain("Backups are healthy right now.");
    expect(
      backupHealthEmail(failing, "o@example.test", { test: true }).text,
    ).toContain("Backups need attention right now:");
  });

  it("never mentions hosts, addresses or keys", () => {
    const text = backupHealthEmail(failing, "owner@example.test").text;
    expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}|ts\.net|password|KEY=/i);
  });
});

describe("health check on the host (#355)", () => {
  const read = (name: string) =>
    readFileSync(
      new URL(`../../infra/backup/host/${name}`, import.meta.url),
      "utf8",
    );
  const service = read("jobflow-backup-health.service");
  const timer = read("jobflow-backup-health.timer");
  const health = read("health.sh");
  const install = read("install.sh");

  it("runs daily at 09:00 Sydney as prod, without the encryption key", () => {
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 09:00:00 Australia\/Sydney$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(service).toMatch(/^User=prod$/m);
    expect(service).toMatch(/^EnvironmentFile=\/etc\/jobflow\/backup\.env$/m);
    expect(service).not.toContain("backup-key.env");
    expect(service).toMatch(/^ExecStart=\/bin\/sh \S+\/health\.sh$/m);
  });

  it("decides reachability with share_mounted, never hanging", () => {
    expect(health).toContain(". infra/backup/host/share.sh");
    expect(health).toContain('share_mounted "$mount"');
    expect(health).toContain("share=unreachable");
    expect(health).toContain("backup:health");
  });

  it("installs the timer, copies the email settings and sends a test", () => {
    expect(install).toContain(
      "grep -E '^(SMTP_[A-Z_]*|EMAIL_FROM|EMAIL_REPLY_TO|OPERATOR_NOTIFY_EMAIL)='",
    );
    expect(install).toContain("jobflow-backup-health.timer");
    expect(install).toContain("health.sh --test");
  });
});
