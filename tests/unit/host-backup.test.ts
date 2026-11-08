import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #351: nightly backups to a Windows file share on the self-hosted site.
const read = (name: string) =>
  readFileSync(
    new URL(`../../infra/backup/host/${name}`, import.meta.url),
    "utf8",
  );
const service = read("jobflow-backup.service");
const timer = read("jobflow-backup.timer");
const run = read("run.sh");
const sync = read("sync.sh");
const syncService = read("jobflow-backup-sync.service");
const syncTimer = read("jobflow-backup-sync.timer");
const install = read("install.sh");

describe("self-hosted backups (#351)", () => {
  it("runs nightly as prod, with the key in its own file", () => {
    expect(timer).toMatch(/^OnCalendar=.*02:15:00 Australia\/Sydney$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(service).toMatch(/^User=prod$/m);
    expect(service).toMatch(/^EnvironmentFile=\/etc\/jobflow\/backup\.env$/m);
    expect(service).toMatch(
      /^EnvironmentFile=\/etc\/jobflow\/backup-key\.env$/m,
    );
    expect(service).toContain("/var/lib/jobflow-maintenance/on");
  });

  it("backs up and verifies locally first, then hands over to the share copy", () => {
    expect(run.indexOf("infra/backup/run-backup.sh")).toBeGreaterThan(0);
    expect(run.indexOf("infra/backup/run-backup.sh")).toBeLessThan(
      run.indexOf("exec sh infra/backup/host/sync.sh"),
    );
    // Run through sh, so a lost executable bit can't break the unit.
    expect(service).toMatch(/^ExecStart=\/bin\/sh \S+\/run\.sh$/m);
  });

  it("copies every backup the share is missing, verifying before it lands", () => {
    const order = [
      "flock -w",
      "timeout 60 ls",
      "mountpoint -q",
      'for dir in "$BACKUP_ROOT"/*/',
      "manifest.json",
      'cp -R "${dir%/}" "$BACKUP_SHARE_DIR/.incoming/$name"',
      "backup:verify",
      'mv "$BACKUP_SHARE_DIR/.incoming/$name"',
      "backup:prune",
    ].map((step) => sync.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Already on the share: skipped.
    expect(sync).toContain(
      '[ -f "$BACKUP_SHARE_DIR/$name/manifest.json" ] && continue',
    );
    expect(sync).toContain("exit 2");
  });

  it("retries the copy hourly, as prod, with the key in its own file", () => {
    expect(syncTimer).toMatch(/^OnCalendar=hourly$/m);
    expect(syncService).toMatch(/^User=prod$/m);
    expect(syncService).toMatch(/^ExecStart=\/bin\/sh \S+\/sync\.sh$/m);
    expect(syncService).toMatch(
      /^EnvironmentFile=\/etc\/jobflow\/backup-key\.env$/m,
    );
    // Conflicts= would stop a running nightly backup.
    expect(syncService).not.toContain("Conflicts=");
    expect(install).toContain(
      "enable --now jobflow-backup.timer jobflow-backup-sync.timer",
    );
  });

  it("reuses a mounted share, or mounts one encrypted", () => {
    expect(install).toContain('mountpoint -q "$mountpoint"');
    expect(install).toContain("runuser -u prod -- test -w");
    expect(install).toMatch(/vers=3\.1\.1,seal,/);
    expect(install).toContain("domain=%s");
  });

  it("reads the database through a read-only role, never the owner", () => {
    expect(install).toContain("GRANT pg_read_all_data TO jobflow_backup");
    expect(install).toContain(
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
    );
    // Provisioned through an owner connection when the app login can't (#352 review).
    expect(install).toContain("BACKUP_ADMIN_DATABASE_URL");
    expect(install).toContain("rolsuper OR rolcreaterole");
    // The password is quoted by psql, never spliced into SQL by the shell.
    expect(install).toContain("PASSWORD :'role_password'");
    expect(install).toMatch(/DATABASE_URL=postgresql:\/\/jobflow_backup:/);
  });

  it("keeps secrets out of the repository and an existing key in place", () => {
    expect(install).toContain("read -rsp");
    expect(install).toContain("chmod 0600 /etc/jobflow/backup-share.cred");
    expect(install).toContain("chmod 0600 /etc/jobflow/backup-key.env");
    expect(install).toContain("if [ ! -s /etc/jobflow/backup-key.env ]; then");
    // No host addresses in these files (loopback aside).
    for (const file of [
      service,
      timer,
      run,
      sync,
      syncService,
      syncTimer,
      install,
    ])
      expect(file).not.toMatch(
        /\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b|\.ts\.net/,
      );
  });
});
