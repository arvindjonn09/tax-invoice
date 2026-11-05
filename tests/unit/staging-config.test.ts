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

  it("pins every external image and both Dockerfile bases by digest (#168)", () => {
    for (const [, image] of compose.matchAll(/image: (\S+)/g)) {
      if (image!.startsWith("jobflow-")) continue; // locally built release image
      // #136: set on the host, digest-pinned; the deploy gate enforces it.
      if (image!.startsWith("${CLAMAV_IMAGE:?")) continue;
      expect(image).toMatch(/:[\w.-]+@sha256:[a-f0-9]{64}$/);
    }
    expect(dockerfile).toMatch(
      /^# syntax=docker\/dockerfile:1@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toMatch(
      /^ARG NODE_IMAGE=node:24-bookworm-slim@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile.match(/^FROM \$\{NODE_IMAGE\}/gm)).toHaveLength(2);
  });
});

describe("malware scanning service (#136)", () => {
  const deploy = readFileSync(
    new URL("../../infra/staging/deploy.sh", import.meta.url),
    "utf8",
  );
  const example = readFileSync(
    new URL("../../infra/staging/env/compose.env.example", import.meta.url),
    "utf8",
  );
  const web = readFileSync(
    new URL("../../infra/staging/env/web.env.example", import.meta.url),
    "utf8",
  );
  const block = compose.slice(
    compose.indexOf("\n  clamav:\n"),
    compose.indexOf("\n  nginx:\n"),
  );

  it("runs clamd from a required, digest-pinned image the deploy gate checks", () => {
    expect(block).toMatch(/image: \$\{CLAMAV_IMAGE:\?/);
    expect(example).toMatch(/^CLAMAV_IMAGE=clamav\/clamav:[\w.-]+@sha256:/m);
    expect(deploy).toContain(
      "^clamav/clamav:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$",
    );
    // The check runs before anything is fetched or built.
    expect(deploy.indexOf("CLAMAV_IMAGE")).toBeLessThan(
      deploy.indexOf("git fetch"),
    );
  });

  it("keeps clamd private: no published port, its own networks", () => {
    expect(block).not.toMatch(/^\s+ports:/m);
    expect(block).toMatch(/networks: \[scan, clamav_updates\]/);
    expect(compose).toMatch(/ {2}scan:\n {4}internal: true/);
    expect(block).toMatch(/no-new-privileges:true/);
  });

  it("runs clamd unprivileged, read-only, with no capabilities", () => {
    expect(block).toMatch(/^ {4}user: clamav$/m);
    expect(block).toMatch(/entrypoint: \["\/init-unprivileged"\]/);
    expect(block).toMatch(/cap_drop: \[ALL\]/);
    expect(block).toMatch(/read_only: true/);
    expect(block).toMatch(/- \/tmp:size=\d+m/);
  });

  it("mounts a clamd.conf that never lets an over-limit file pass as clean", () => {
    expect(block).toContain("./clamav/clamd.conf:/etc/clamav/clamd.conf:ro");
    const conf = read("infra/staging/clamav/clamd.conf");
    expect(conf).toMatch(/^AlertExceedsMax yes$/m);
    expect(conf).toMatch(/^TCPSocket 3310$/m);
    // Uploads are at most 10 MB: clamd must accept the whole stream.
    expect(conf).toMatch(/^StreamMaxLength 12M$/m);
    // Encrypted files: an owner decision, recorded explicitly either way.
    expect(conf).toMatch(/^AlertEncrypted (yes|no)$/m);
  });

  it("starts clamd before the web app on every deploy", () => {
    const start = deploy.indexOf("up -d --wait --wait-timeout 900 clamav");
    expect(start).toBeGreaterThan(deploy.indexOf("run --rm migrate"));
    expect(start).toBeLessThan(
      deploy.indexOf("up -d --no-deps --wait --wait-timeout 300 web"),
    );
  });

  it("starts the web app only once clamd is healthy, and points it there", () => {
    const webBlock = compose.slice(
      compose.indexOf("\n  web:\n"),
      compose.indexOf("\n  clamav:\n"),
    );
    expect(webBlock).toMatch(/clamav:\n\s+condition: service_healthy/);
    expect(webBlock).toMatch(/networks: \[data, edge, scan\]/);
    expect(web).toMatch(/^CLAMAV_HOST=clamav$/m);
    expect(web).toMatch(/^CLAMAV_PORT=3310$/m);
  });
});

describe("staging env examples (#64)", () => {
  const dir = new URL("../../infra/staging/env/", import.meta.url);
  const examples = readdirSync(dir).filter((f) => f.endsWith(".env.example"));

  it("hold placeholders only, and the real files are git-ignored", () => {
    expect(examples.sort()).toEqual([
      "backup.env.example",
      "compose.env.example",
      "maintenance.env.example",
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

describe("staging backup (#173)", () => {
  it("runs on the stack's data network, as the read-only role, hardened", () => {
    const backup = service("backup");
    expect(backup).toMatch(/networks: \[data, edge\]/);
    expect(backup).toMatch(/profiles: \[backup\]/);
    expect(backup).toMatch(/read_only: true/);
    expect(backup).toMatch(/cap_drop: \[ALL\]/);
    expect(backup).toMatch(/\/var\/backups\/jobflow:\/backups/);
    expect(backup).toMatch(/path: \/etc\/jobflow\/backup-key\.env/);
    expect(backup).not.toMatch(/\n\s+ports:/);
    const env = read("infra/staging/env/backup.env.example");
    expect(env).toMatch(/^DATABASE_URL=postgresql:\/\/jobflow_backup:/m);
    expect(env).not.toMatch(/BACKUP_ENCRYPTION_KEY/);
  });

  it("has a pg_dump that matches the server and a timer that runs it", () => {
    const stage = dockerfile
      .split(/^FROM .* AS backup$/m)[1]!
      .split(/^FROM /m)[0]!;
    expect(stage).toMatch(/postgresql-client-16/);
    expect(compose).toMatch(/image: postgres:16\./);
    expect(stage).toMatch(/^USER node$/m);
    const unit = read("infra/staging/systemd/jobflow-staging-backup.service");
    expect(unit).toMatch(/--profile backup run --rm backup/);
    expect(unit).toMatch(/WorkingDirectory=\/opt\/jobflow/);
  });

  it("is rebuilt on every deploy, so backups run the released code", () => {
    const deploy = read("infra/staging/deploy.sh");
    expect(deploy).toMatch(
      /^docker build [^\n]*--target backup -t jobflow-backup:staging \./m,
    );
    expect(compose).toMatch(/image: jobflow-backup:staging/);
    expect(deploy.indexOf("--target backup")).toBeLessThan(
      deploy.indexOf("run --rm migrate"),
    );
  });
});

describe("deploy gate (#64)", () => {
  const deploy = read("infra/staging/deploy.sh");
  it("deploys only the current tip of main, with globbing off", () => {
    expect(deploy).toMatch(/^set -euf$/m);
    expect(deploy).toMatch(
      /if \[ "\$SHA" != "\$\(git rev-parse origin\/main\)" \]; then/,
    );
    // An older main commit is superseded (exit 0) and never checked out.
    const gate = deploy.slice(0, deploy.indexOf("git -c advice"));
    expect(gate).toMatch(
      /--is-ancestor[^\n]*\n\s+echo "superseded[^\n]*\n\s+exit 0/,
    );
    expect(deploy).toMatch(/\/usr\/local\/sbin\/jobflow-deploy/);
    // Migrations run before the new app replaces the old one.
    expect(deploy).toMatch(/--force-recreate --wait --wait-timeout \d+ nginx/);
    expect(deploy.indexOf("run --rm migrate")).toBeLessThan(
      deploy.indexOf("up -d --no-deps --wait --wait-timeout 300 web"),
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

describe("private document maintenance (#170)", () => {
  it("uses the released tool image with its own credentials and no backup keys", () => {
    const block = service("maintenance");
    expect(block).toMatch(/image: jobflow-backup:staging/);
    expect(block).toMatch(/profiles: \[maintenance\]/);
    expect(block).toMatch(/env_file: env\/maintenance.env/);
    expect(block).toMatch(/read_only: true/);
    expect(block).toMatch(/cap_drop: \[ALL\]/);
    expect(block).not.toMatch(/backup-key|ports:/);
    expect(read("infra/staging/env/maintenance.env.example")).toMatch(
      /MAINTENANCE_DATABASE_URL=postgresql:\/\/jobflow_maintenance:/,
    );
    expect(
      read("infra/staging/systemd/jobflow-document-cleanup.service"),
    ).toMatch(/--profile maintenance run --rm maintenance/);
  });
});
