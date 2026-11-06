import { readFile, readdir, readlink } from "node:fs/promises";
import { extensionLastDay, sydneyDate, trialStatus } from "@jobflow/domain";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import type { AdminConfig } from "./auth";

// ---------- Organisations ----------

export type OrganisationRow = {
  id: string;
  name: string;
  isDemo: boolean;
  licence: "full" | "trial" | "trial_ended";
  trialLastDay: string | null;
  daysRemaining: number | null;
  owner: { name: string | null; email: string } | null;
  members: number;
  jobs: number;
  invoices: number;
  createdAt: Date;
  lastActivity: Date | null;
};

export async function listOrganisations(
  db: PrismaClient,
  now = new Date(),
): Promise<OrganisationRow[]> {
  const [companies, members, jobs, invoices, activity] = await Promise.all([
    db.company.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        isDemo: true,
        accessMode: true,
        trialLastDay: true,
        createdAt: true,
        memberships: {
          where: { role: "owner", isActive: true },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { user: { select: { name: true, email: true } } },
        },
      },
    }),
    db.membership.groupBy({
      by: ["companyId"],
      where: { isActive: true },
      _count: { _all: true },
    }),
    db.job.groupBy({ by: ["companyId"], _count: { _all: true } }),
    db.invoice.groupBy({ by: ["companyId"], _count: { _all: true } }),
    db.auditEvent.groupBy({ by: ["companyId"], _max: { createdAt: true } }),
  ]);
  const count = (rows: { companyId: string; _count: { _all: number } }[]) =>
    new Map(rows.map((row) => [row.companyId, row._count._all]));
  const memberCount = count(members);
  const jobCount = count(jobs);
  const invoiceCount = count(invoices);
  const lastSeen = new Map(
    activity.map((row) => [row.companyId, row._max.createdAt]),
  );
  return companies.map((company) => {
    const lastDay = company.trialLastDay?.toISOString().slice(0, 10) ?? null;
    const status =
      company.accessMode === "trial" && lastDay
        ? trialStatus(lastDay, now)
        : null;
    return {
      id: company.id,
      name: company.name,
      isDemo: company.isDemo,
      licence: !status
        ? "full"
        : status.phase === "expired"
          ? "trial_ended"
          : "trial",
      trialLastDay: lastDay,
      daysRemaining: status ? Math.max(0, status.daysRemaining) : null,
      owner: company.memberships[0]?.user ?? null,
      members: memberCount.get(company.id) ?? 0,
      jobs: jobCount.get(company.id) ?? 0,
      invoices: invoiceCount.get(company.id) ?? 0,
      createdAt: company.createdAt,
      lastActivity: lastSeen.get(company.id) ?? null,
    };
  });
}

export class AdminActionError extends Error {}

/** Serialise licence actions, so overlapping extensions can't lose an update. */
async function lockCompany(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM companies WHERE id = ${companyId}::uuid FOR UPDATE`;
}

/** Give a company full access (no trial). Audited as an operator action. */
export async function assignFullLicence(
  db: PrismaClient,
  companyId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockCompany(tx, companyId);
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: { isDemo: true, accessMode: true, trialLastDay: true },
    });
    if (!company) throw new AdminActionError("Organisation not found");
    if (company.isDemo)
      throw new AdminActionError("Demo companies can't be changed");
    if (company.accessMode === "unrestricted") return;
    await tx.company.update({
      where: { id: companyId },
      data: {
        accessMode: "unrestricted",
        trialLastDay: null,
        trialStartedAt: null,
      },
    });
    await tx.auditEvent.create({
      data: {
        companyId,
        actorKind: "operator",
        action: "company.access_mode_changed",
        targetType: "company",
        targetId: companyId,
        metadata: {
          source: "admin_console",
          changes: {
            accessMode: { before: "trial", after: "unrestricted" },
            trialLastDay: {
              before: company.trialLastDay?.toISOString().slice(0, 10) ?? null,
              after: null,
            },
          },
        },
      },
    });
  });
}

/**
 * Extend a trial by `days` (1–365). Counts from the later of its current
 * last day and yesterday, so an ended trial reopens from today.
 */
export async function extendTrial(
  db: PrismaClient,
  companyId: string,
  days: number,
  now = new Date(),
): Promise<string> {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new AdminActionError("Choose 1 to 365 days");
  }
  return db.$transaction(async (tx) => {
    await lockCompany(tx, companyId);
    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: {
        isDemo: true,
        accessMode: true,
        trialLastDay: true,
        trialExtensionCount: true,
      },
    });
    if (!company) throw new AdminActionError("Organisation not found");
    if (company.isDemo)
      throw new AdminActionError("Demo companies can't be changed");
    if (company.accessMode !== "trial" || !company.trialLastDay) {
      throw new AdminActionError(
        "This organisation already has a full licence",
      );
    }
    const current = company.trialLastDay.toISOString().slice(0, 10);
    const lastDay = extensionLastDay(current, sydneyDate(now), days);
    await tx.company.update({
      where: { id: companyId },
      data: {
        trialLastDay: new Date(`${lastDay}T00:00:00Z`),
        trialExtensionCount: company.trialExtensionCount + 1,
      },
    });
    await tx.auditEvent.create({
      data: {
        companyId,
        actorKind: "operator",
        action: "trial.extended",
        targetType: "company",
        targetId: companyId,
        metadata: {
          source: "admin_console",
          days,
          changes: { trialLastDay: { before: current, after: lastDay } },
        },
      },
    });
    return lastDay;
  });
}

// ---------- Settings / health ----------

export type SettingsSnapshot = {
  environment: string;
  publicUrl: string | null;
  version: string | null;
  email: {
    smtpConfigured: boolean;
    host: string | null;
    sender: string | null;
    outboxKeySet: boolean;
    pending: number;
    failed: number;
    sent24h: number;
  };
  database: {
    /** Null when this database role can't read migration history. */
    latestMigration: string | null;
    migrations: number | null;
    users: number;
    verifiedUsers: number;
    companies: number;
  };
  security: {
    authSecretSet: boolean;
    turnstileConfigured: boolean;
    adminGithubTokenSet: boolean;
  };
};

async function gitVersion(): Promise<string | null> {
  if (process.env.JOBFLOW_COMMIT) return process.env.JOBFLOW_COMMIT;
  // The deployed copy is a git worktree: .git is a file naming its gitdir.
  for (const root of ["../..", "."]) {
    try {
      let gitDir = `${process.cwd()}/${root}/.git`;
      const pointer = await readFile(gitDir, "utf8").catch(() => null);
      if (pointer?.startsWith("gitdir:")) gitDir = pointer.slice(7).trim();
      const head = (await readFile(`${gitDir}/HEAD`, "utf8")).trim();
      return head.startsWith("ref:") ? head.slice(5) : head.slice(0, 12);
    } catch {
      // try the next root
    }
  }
  return null;
}

export async function settingsSnapshot(
  db: PrismaClient,
  config: AdminConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SettingsSnapshot> {
  const since = new Date(Date.now() - 86_400_000);
  const [
    pending,
    failed,
    sent24h,
    users,
    verifiedUsers,
    companies,
    migrations,
  ] = await Promise.all([
    db.emailOutbox.count({ where: { status: { in: ["pending", "sending"] } } }),
    db.emailOutbox.count({ where: { status: "failed" } }),
    db.emailOutbox.count({ where: { status: "sent", sentAt: { gte: since } } }),
    db.user.count(),
    db.user.count({ where: { emailVerified: true } }),
    db.company.count(),
    db.$queryRaw<{ name: string; total: bigint }[]>`
        SELECT max(migration_name) AS name, count(*) AS total
        FROM _prisma_migrations WHERE finished_at IS NOT NULL`.catch(
      // The production runtime role has no access to migration history.
      () => null,
    ),
  ]);
  return {
    environment: env.APP_ENV ?? env.NODE_ENV ?? "unknown",
    publicUrl: env.BETTER_AUTH_URL ?? null,
    version: await gitVersion(),
    email: {
      smtpConfigured: Boolean(
        env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD,
      ),
      host: env.SMTP_HOST ?? null,
      sender: env.EMAIL_FROM ?? env.SMTP_USER ?? null,
      outboxKeySet: (env.EMAIL_OUTBOX_KEY ?? "").length >= 32,
      pending,
      failed,
      sent24h,
    },
    database: {
      latestMigration: migrations?.[0]?.name ?? null,
      migrations: migrations ? Number(migrations[0]?.total ?? 0) : null,
      users,
      verifiedUsers,
      companies,
    },
    security: {
      authSecretSet: (env.BETTER_AUTH_SECRET ?? "").length >= 32,
      turnstileConfigured: Boolean(env.TURNSTILE_SECRET_KEY),
      adminGithubTokenSet: Boolean(env.ADMIN_GITHUB_TOKEN),
    },
  };
}

// ---------- GitHub ----------

export type PullSummary = {
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  updatedAt: string;
  url: string;
  /** "unknown": GitHub wouldn't say, usually because of its rate limit. */
  ci: "passing" | "failing" | "running" | "none" | "unknown";
  failing: string[];
};

export type GithubSnapshot = {
  ok: boolean;
  error?: string;
  openPulls: PullSummary[];
  merged: { number: number; title: string; mergedAt: string; url: string }[];
  mainRuns: {
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    at: string;
  }[];
  issues: {
    byStatus: Record<
      string,
      { number: number; title: string; url: string; milestone: string | null }[]
    >;
    milestones: { title: string; open: number; closed: number }[];
  };
};

type GithubSettings = { repo: string; token: string | null };

/** From the server's environment; ADMIN_GITHUB_REPO must look like owner/name. */
export function githubSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GithubSettings {
  const repo = env.ADMIN_GITHUB_REPO || "arvindjonn09/tax-invoice";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("ADMIN_GITHUB_REPO must look like owner/name");
  }
  return { repo, token: env.ADMIN_GITHUB_TOKEN || null };
}

let cache: { at: number; repo: string; value: GithubSnapshot } | null = null;

async function github<T>(config: GithubSettings, path: string): Promise<T> {
  const response = await fetch(
    `https://api.github.com/repos/${config.repo}${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "jobflow-admin-console",
        "x-github-api-version": "2022-11-28",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new Error(`GitHub ${response.status} for ${path.split("?")[0]}`);
  return (await response.json()) as T;
}

type ApiPull = {
  number: number;
  title: string;
  draft: boolean;
  updated_at: string;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
};
type ApiCheckRun = { name: string; status: string; conclusion: string | null };
type ApiIssue = {
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
  labels: { name: string }[];
  milestone: { title: string } | null;
};

const STATUS_LABELS = [
  "status:in-progress",
  "status:in-review",
  "status:blocked",
  "status:ready",
  "status:needs-info",
];

export async function githubSnapshot(
  config: GithubSettings = githubSettings(),
): Promise<GithubSnapshot> {
  if (cache && cache.repo === config.repo && Date.now() - cache.at < 60_000) {
    return cache.value;
  }
  try {
    const [open, closed, runs, issues, milestones] = await Promise.all([
      github<ApiPull[]>(
        config,
        "/pulls?state=open&per_page=50&sort=updated&direction=desc",
      ),
      github<ApiPull[]>(
        config,
        "/pulls?state=closed&per_page=20&sort=updated&direction=desc",
      ),
      github<{
        workflow_runs: {
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          created_at: string;
        }[];
      }>(config, "/actions/runs?branch=main&per_page=8"),
      github<ApiIssue[]>(config, "/issues?state=open&per_page=100"),
      github<{ title: string; open_issues: number; closed_issues: number }[]>(
        config,
        "/milestones?state=open&per_page=20",
      ),
    ]);
    const openPulls = await Promise.all(
      open.map(async (pull): Promise<PullSummary> => {
        const checks = await github<{ check_runs: ApiCheckRun[] }>(
          config,
          `/commits/${pull.head.sha}/check-runs?per_page=50`,
        ).catch(() => null);
        const runsFor = (checks?.check_runs ?? []).filter(
          (run) => run.conclusion !== "skipped",
        );
        const failing = runsFor
          .filter(
            (run) =>
              run.conclusion &&
              !["success", "neutral"].includes(run.conclusion),
          )
          .map((run) => run.name);
        const ci: PullSummary["ci"] =
          checks === null
            ? "unknown"
            : runsFor.length === 0
              ? "none"
              : failing.length > 0
                ? "failing"
                : runsFor.some((run) => run.status !== "completed")
                  ? "running"
                  : "passing";
        return {
          number: pull.number,
          title: pull.title,
          author: pull.user?.login ?? "unknown",
          branch: pull.head.ref,
          base: pull.base.ref,
          draft: pull.draft,
          updatedAt: pull.updated_at,
          url: pull.html_url,
          ci,
          failing,
        };
      }),
    );
    const byStatus: GithubSnapshot["issues"]["byStatus"] = {};
    for (const issue of issues.filter((item) => !item.pull_request)) {
      const status =
        issue.labels
          .map((label) => label.name)
          .find((name) => STATUS_LABELS.includes(name)) ?? "backlog";
      (byStatus[status] ??= []).push({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        milestone: issue.milestone?.title ?? null,
      });
    }
    const value: GithubSnapshot = {
      ok: true,
      openPulls,
      merged: closed
        .filter((pull) => pull.merged_at)
        .slice(0, 12)
        .map((pull) => ({
          number: pull.number,
          title: pull.title,
          mergedAt: pull.merged_at!,
          url: pull.html_url,
        })),
      mainRuns: runs.workflow_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        at: run.created_at,
      })),
      issues: {
        byStatus,
        milestones: milestones.map((milestone) => ({
          title: milestone.title,
          open: milestone.open_issues,
          closed: milestone.closed_issues,
        })),
      },
    };
    // A partial answer isn't worth keeping: try again on the next view.
    if (!openPulls.some((pull) => pull.ci === "unknown")) {
      cache = { at: Date.now(), repo: config.repo, value };
    }
    return value;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "GitHub unavailable",
      openPulls: [],
      merged: [],
      mainRuns: [],
      issues: { byStatus: {}, milestones: [] },
    };
  }
}

// ---------- Agents ----------

export type AgentEntry = {
  at: string;
  agent: string;
  topic: string;
  text: string;
};
export type AgentProcess = { pid: number; program: string; cwd: string | null };

/** Parse `when · agent · topic · text` lines from the shared updates page. */
export function parseUpdates(text: string): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const line of text.split("\n")) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const [at, agent, topic, ...rest] = line.split(" · ");
    if (!at || !agent) continue;
    entries.push({
      at: at.trim(),
      agent: agent.replace(/\s*\(.*\)$/, "").trim(),
      topic: (topic ?? "").trim(),
      text: rest.join(" · ").trim(),
    });
  }
  return entries;
}

export async function agentActivity(
  config: AdminConfig,
): Promise<{ byAgent: Record<string, AgentEntry[]>; source: string | null }> {
  const source = config.updatesFile;
  if (!source) return { byAgent: {}, source: null };
  const text = await readFile(source, "utf8").catch(() => "");
  const byAgent: Record<string, AgentEntry[]> = {};
  for (const entry of parseUpdates(text).reverse()) {
    const list = (byAgent[entry.agent] ??= []);
    if (list.length < 8) list.push(entry);
  }
  return { byAgent, source };
}

/**
 * Claude and Codex processes on this host. Only the program name and working
 * directory are shown, never arguments (they can hold tokens).
 */
export async function runningAgents(): Promise<AgentProcess[]> {
  const found: AgentProcess[] = [];
  const pids = await readdir("/proc").catch(() => [] as string[]);
  for (const pid of pids.filter((name) => /^\d+$/.test(name))) {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
      () => "",
    );
    const args = cmdline.split("\0").filter(Boolean);
    const program = args
      .slice(0, 2)
      .map((arg) => arg.split("/").pop() ?? "")
      .find((name) => /^(claude|codex)$/i.test(name));
    if (!program) continue;
    found.push({
      pid: Number(pid),
      program,
      cwd: await readlink(`/proc/${pid}/cwd`).catch(() => null),
    });
  }
  return found;
}
