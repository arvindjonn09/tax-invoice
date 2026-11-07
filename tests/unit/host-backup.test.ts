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

  it("backs up and verifies locally first, then copies, verifies and prunes the share", () => {
    const order = [
      "infra/backup/run-backup.sh",
      "mountpoint -q",
      ".incoming",
      "backup:verify",
      "backup:prune",
    ].map((step) => run.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(run).toContain("exit 2");
  });

  it("reads the database through a read-only role, never the owner", () => {
    expect(install).toContain("GRANT pg_read_all_data TO jobflow_backup");
    expect(install).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE");
    expect(install).toMatch(/DATABASE_URL=postgresql:\/\/jobflow_backup:/);
  });

  it("keeps secrets out of the repository and an existing key in place", () => {
    expect(install).toContain("read -rsp");
    expect(install).toContain("chmod 0600 /etc/jobflow/backup-share.cred");
    expect(install).toContain("chmod 0600 /etc/jobflow/backup-key.env");
    expect(install).toContain("if [ ! -s /etc/jobflow/backup-key.env ]; then");
    // No host addresses in these files (loopback aside).
    for (const file of [service, timer, run, install])
      expect(file).not.toMatch(
        /\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b|\.ts\.net/,
      );
  });
});
