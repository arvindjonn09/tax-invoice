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

  it("deploys only the tip of main, and never as root", () => {
    expect(position('"$target" != "$tip"')).toBeLessThan(
      position('touch "$flag"'),
    );
    expect(deploy).toMatch(/\$\(id -u\)" -eq 0/);
  });
});
