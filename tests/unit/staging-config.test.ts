import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES } from "../../apps/web/src/server/documents/files";

// #64: the staging files keep the security properties the app relies on.
const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const compose = read("infra/staging/compose.yml");
const nginx = read("infra/nginx/templates/jobflow.conf.template");
const dockerfile = read("apps/web/Dockerfile");

/** The lines of one top-level service block in the Compose file. */
function service(name: string): string {
  const match = new RegExp(
    `\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z]+:\\n|\\nnetworks:)`,
  ).exec(compose);
  expect(match, `service ${name}`).not.toBeNull();
  return match![1]!;
}

describe("staging Compose (#64)", () => {
  it("publishes only nginx; the app and database are not reachable from outside", () => {
    expect(service("nginx")).toMatch(/ports:\n\s+- "80:80"\n\s+- "443:443"/);
    for (const name of ["web", "postgres", "migrate"]) {
      expect(service(name)).not.toMatch(/\n\s+ports:/);
    }
    expect(compose).toMatch(/\n  data:\n    internal: true/);
    expect(service("postgres")).toMatch(/networks: \[data\]/);
  });

  it("runs the web app hardened, as the runtime role, after migrations", () => {
    const web = service("web");
    expect(web).toMatch(/read_only: true/);
    expect(web).toMatch(/cap_drop: \[ALL\]/);
    expect(web).toMatch(/no-new-privileges:true/);
    expect(web).toMatch(/env_file: env\/web\.env/);
    expect(web).toMatch(/condition: service_completed_successfully/);
    expect(service("migrate")).toMatch(/env_file: env\/migrate\.env/);
  });

  it("pins every image to a version", () => {
    for (const [, image] of compose.matchAll(/image: (\S+)/g)) {
      expect(image).toMatch(/:[\w.-]+$/);
      expect(image).not.toMatch(/:latest$/);
    }
  });
});

describe("staging env examples (#64)", () => {
  const dir = new URL("../../infra/staging/env/", import.meta.url);
  const examples = readdirSync(dir).filter((f) => f.endsWith(".env.example"));

  it("hold placeholders only, and the real files are git-ignored", () => {
    expect(examples.sort()).toEqual([
      "compose.env.example",
      "migrate.env.example",
      "nginx.env.example",
      "postgres.env.example",
      "web.env.example",
    ]);
    for (const file of examples) {
      const text = readFileSync(new URL(file, dir), "utf8");
      for (const [, name, value] of text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
        if (/PASSWORD|SECRET|KEY/.test(name!)) {
          expect(value, `${file} ${name}`).toMatch(/replace/);
        }
      }
      expect(text).not.toMatch(/\.com\.au|AKIA[0-9A-Z]{16}/);
    }
    expect(read(".gitignore")).toContain("infra/staging/env/*.env");
  });

  it("gives the web app the jobflow_web role and the migrate job the owner", () => {
    const web = readFileSync(new URL("web.env.example", dir), "utf8");
    const migrate = readFileSync(new URL("migrate.env.example", dir), "utf8");
    expect(web).toMatch(/^DATABASE_URL=postgresql:\/\/jobflow_web:/m);
    expect(web).toMatch(/^BETTER_AUTH_URL=https:\/\//m);
    expect(web).toMatch(/^APP_ENV=staging$/m);
    expect(migrate).toMatch(/^DATABASE_URL=postgresql:\/\/jobflow_owner:/m);
  });
});

describe("nginx (#64)", () => {
  it("overwrites X-Forwarded-For so a client can't choose its throttling IP", () => {
    expect(nginx).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(nginx).not.toMatch(/\$proxy_add_x_forwarded_for/);
    expect(nginx).toMatch(/proxy_set_header X-Forwarded-Proto https;/);
  });

  it("serves TLS 1.2+ only, redirects HTTP and keeps HSTS on error pages", () => {
    expect(nginx).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
    expect(nginx).toMatch(/return 301 https:\/\/\$host\$request_uri;/);
    expect(nginx).toMatch(
      /add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;/,
    );
    expect(nginx).toMatch(/server_tokens off;/);
  });

  it("accepts the largest document but not much more, and rate-limits sign-in", () => {
    const [, size] = /client_max_body_size (\d+)m;/.exec(nginx)!;
    const limit = Number(size) * 1024 * 1024;
    expect(limit).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    expect(limit).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES * 1.25);
    expect(nginx).toMatch(
      /location \^~ \/api\/auth\/ \{\n\s+limit_req zone=jobflow_auth/,
    );
  });
});

describe("nginx upstream and unknown hosts (#64)", () => {
  it("re-resolves the app after a deploy recreates it", () => {
    expect(nginx).toMatch(/resolver 127\.0\.0\.11 /);
    expect(nginx).toMatch(/zone jobflow_web 64k;\n\s+server web:3000 resolve;/);
    expect(nginx).toMatch(/keepalive_timeout 4s;/);
  });

  it("drops requests for other host names before they reach the app", () => {
    expect(nginx).toMatch(/listen 80 default_server;[\s\S]*?return 444;/);
    expect(nginx).toMatch(
      /listen 443 ssl default_server;[\s\S]*?ssl_reject_handshake on;/,
    );
    expect(nginx).toMatch(/proxy_set_header Host \$server_name;/);
    expect(service("nginx")).toMatch(
      /nginx\/default\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/,
    );
  });
});

describe("deploy gate (#64)", () => {
  const deploy = read("infra/staging/deploy.sh");
  it("deploys only the current tip of main, with globbing off", () => {
    expect(deploy).toMatch(/^set -euf$/m);
    expect(deploy).toMatch(
      /\[ "\$SHA" = "\$\(git rev-parse origin\/main\)" \]/,
    );
    expect(deploy).not.toMatch(/--is-ancestor/);
    expect(deploy).toMatch(/\/usr\/local\/sbin\/jobflow-deploy/);
    // Migrations run before the new app replaces the old one.
    expect(deploy.indexOf("run --rm migrate")).toBeLessThan(
      deploy.indexOf("up -d --no-deps"),
    );
  });
});

describe("Dockerfile (#64)", () => {
  it("lets the non-root migrate job use pnpm without a download", () => {
    expect(dockerfile).toMatch(/COREPACK_HOME=\/corepack/);
    const migrate = dockerfile
      .split(/^FROM .* AS migrate$/m)[1]!
      .split(/^FROM /m)[0]!;
    expect(migrate).toMatch(/node scripts\/database\/cli\.mjs migrate deploy/);
    expect(migrate).not.toMatch(/CMD .*pnpm/);
  });

  it("runs the server as a non-root user from the standalone output", () => {
    const runtime = dockerfile.split(/^FROM .* AS runtime$/m)[1]!;
    expect(runtime).toMatch(/^USER node$/m);
    expect(runtime).toMatch(/\.next\/standalone/);
    expect(runtime).not.toMatch(/COPY \. \./);
    expect(runtime).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile/);
  });

  it("never copies env files into the build context", () => {
    const ignore = read(".dockerignore");
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^\*\*\/\.env\.\*$/m);
    expect(ignore).toMatch(/^infra\/staging\/env\/\*\.env$/m);
  });
});
