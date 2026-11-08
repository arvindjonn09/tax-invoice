import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UPLOAD_BODY_LIMIT } from "../../apps/web/src/server/documents/handlers";

// #326: the gate keeps the properties the app and the deploy rely on.
// infra/host/test-gate.sh runs the same files against real nginx.
const read = (path: string) =>
  readFileSync(new URL(`../../infra/host/${path}`, import.meta.url), "utf8");
const gate = read("nginx-gate.conf");
const deploy = read("deploy.sh");

describe("maintenance gate (#326)", () => {
  it("listens on loopback only, in front of the app", () => {
    expect(gate.match(/^\s*listen .*$/gm)).toEqual([
      "    listen 127.0.0.1:3299;",
    ]);
    expect(gate).toContain("proxy_pass http://127.0.0.1:3300;");
  });

  it("leaves the client IP headers to the tunnel", () => {
    expect(gate).not.toMatch(
      /proxy_set_header (X-Forwarded-For|CF-Connecting-IP)/i,
    );
    expect(gate).toContain("proxy_set_header Host $http_host;");
  });

  it("covers its own downtime without hiding the app's own errors", () => {
    expect(gate).toMatch(/error_page 502 503 504 =503 /);
    expect(gate).not.toMatch(/^\s*proxy_intercept_errors on/m);
    expect(gate).toMatch(/add_header Retry-After "\d+" always;/);
  });

  it("accepts the largest upload the app does", () => {
    const [, megabytes] = /client_max_body_size (\d+)m;/.exec(gate) ?? [];
    expect(Number(megabytes) * 1024 * 1024).toBeGreaterThanOrEqual(
      UPLOAD_BODY_LIMIT,
    );
  });
});

describe("deploy script (#326)", () => {
  const position = (step: string) => {
    const at = deploy.indexOf(step);
    expect(at, step).toBeGreaterThanOrEqual(0);
    return at;
  };

  it("turns maintenance on before migrating and off only after readiness", () => {
    const order = [
      'touch "$flag"',
      "sudo -n systemctl stop jobflow.service",
      "pnpm db:migrate",
      "sudo -n systemctl start jobflow.service",
      'curl -fsS --max-time 5 "$ready_url"',
      'rm -f "$flag"\n',
    ].map(position);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("takes a verified backup before anything changes (#359)", () => {
    expect(position('"$target" != "$tip"')).toBeLessThan(
      position("sudo -n systemctl start jobflow-backup.service"),
    );
    expect(
      position("sudo -n systemctl start jobflow-backup.service"),
    ).toBeLessThan(position('touch "$flag"'));
    // Exit 2 (share unreachable) still left a local backup; anything else stops.
    expect(deploy).toContain("--property=ExecMainStatus");
    expect(deploy).toContain('JOBFLOW_SKIP_BACKUP:-}" = 1');
    // A skipped run (maintenance already on) isn't a backup: a complete new
    // folder must exist (Codex review).
    expect(deploy).toContain('[[ "$newest" < "$started" ]]');
    expect(deploy).toContain('"$backups/$newest/manifest.json"');
    expect(read("sudoers-jobflow-deploy")).toContain(
      "/usr/bin/systemctl start jobflow-backup.service",
    );
  });

  it("deploys only the tip of main, and never as root", () => {
    expect(position('"$target" != "$tip"')).toBeLessThan(
      position('touch "$flag"'),
    );
    expect(deploy).toMatch(/\$\(id -u\)" -eq 0/);
  });
});

describe("scheduled jobs timer (#234)", () => {
  const service = read("jobflow-jobs.service");
  const timer = read("jobflow-jobs.timer");

  it("runs every 5 minutes and catches up after downtime", () => {
    expect(timer).toContain("OnCalendar=*:0/5");
    expect(timer).toContain("Persistent=true");
  });

  it("runs as prod, never root, and stands aside during maintenance", () => {
    expect(service).toContain("User=prod");
    expect(service).toContain("ExecStart=/home/prod/.local/bin/pnpm jobs:run");
    expect(service).toContain(
      "ExecCondition=/usr/bin/test ! -e /var/lib/jobflow-maintenance/on",
    );
  });

  it("is installed with the rest of the host setup", () => {
    const install = read("install.sh");
    for (const file of [
      "jobflow-jobs.service",
      "jobflow-jobs.timer",
      "nginx-gate.conf",
      "sudoers-jobflow-deploy",
    ])
      expect(install).toContain(file);
    expect(install).toContain("visudo -cf");
    expect(install).toContain("systemctl enable --now jobflow-jobs.timer");
  });
});

describe("starting at boot (#234)", () => {
  const services = read("jobflow-services.service");
  const dropIn = read("jobflow.service.d/services.conf");
  const install = read("install.sh");

  it("starts the database and file storage as prod, and stops them cleanly", () => {
    expect(services).toMatch(/^User=prod$/m);
    expect(services).toMatch(
      /^ExecStart=\/home\/prod\/\.local\/bin\/jobflow-services start$/m,
    );
    expect(services).toMatch(
      /^ExecStop=\/home\/prod\/\.local\/bin\/jobflow-services stop$/m,
    );
    expect(services).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("starts the app and the jobs only after them", () => {
    for (const unit of [dropIn, read("jobflow-jobs.service")]) {
      expect(unit).toMatch(/^After=.*jobflow-services\.service/m);
      expect(unit).toMatch(/^Wants=.*jobflow-services\.service/m);
    }
  });

  it("removes nginx's sample site only when it has just installed nginx", () => {
    const nginx = install.slice(
      install.indexOf("Installing nginx"),
      install.indexOf("Installing the maintenance page"),
    );
    const [kept, fresh] = nginx.split("else");
    expect(kept).toContain("ok installed");
    expect(kept).not.toContain("rm -f");
    expect(fresh).toContain("apt-get install -y nginx");
    expect(fresh).toContain("rm -f /etc/nginx/sites-enabled/default");
  });

  it("is installed and enabled by the install script", () => {
    expect(install).toContain(
      "systemctl enable --now jobflow-services.service",
    );
    expect(install).toContain(
      "/etc/systemd/system/jobflow.service.d/services.conf",
    );
  });
});
