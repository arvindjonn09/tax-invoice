import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { loadAdminConfig } from "@/server/admin-console/auth";
import {
  agentActivity,
  githubSnapshot,
  listOrganisations,
  runningAgents,
  settingsSnapshot,
} from "@/server/admin-console/data";
import { isAdminRequest } from "@/server/admin-console/handlers";
import { getDatabase } from "@/server/auth";
import { AdminLoginForm, AdminLogout, OrganisationActions } from "./client";

// Hidden owner console (#252): unlinked, never indexed, 404 when not configured.
export const metadata: Metadata = {
  title: "Admin console · JobFlow",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

const TABS = [
  { id: "settings", label: "Settings" },
  { id: "organisations", label: "Organisations" },
  { id: "github", label: "GitHub" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const dateTime = (value: Date | string | null) =>
  value
    ? new Intl.DateTimeFormat("en-AU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Australia/Sydney",
      }).format(new Date(value))
    : "—";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-6 text-card-foreground">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const yes = (value: boolean) => (value ? "✓ Yes" : "✗ No");

function Pill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "info";
  children: ReactNode;
}) {
  const tones = {
    success: "border-success-foreground bg-success text-success-foreground",
    warning: "border-warning-foreground bg-warning text-warning-foreground",
    danger: "border-danger-foreground bg-danger text-danger-foreground",
    info: "border-info-foreground bg-info text-info-foreground",
  };
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

async function SettingsTab({
  config,
}: {
  config: NonNullable<ReturnType<typeof loadAdminConfig>>;
}) {
  const settings = await settingsSnapshot(getDatabase(), config);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Application">
        <Facts
          rows={[
            ["Environment", settings.environment],
            ["Public URL", settings.publicUrl ?? "—"],
            ["Version", settings.version ?? "unknown"],
          ]}
        />
      </Card>
      <Card title="Email">
        <Facts
          rows={[
            ["SMTP configured", yes(settings.email.smtpConfigured)],
            ["SMTP host", settings.email.host ?? "—"],
            ["Sender", settings.email.sender ?? "—"],
            ["Outbox key set", yes(settings.email.outboxKeySet)],
            ["Waiting to send", settings.email.pending],
            ["Failed (gave up)", settings.email.failed],
            ["Sent in last 24 h", settings.email.sent24h],
          ]}
        />
      </Card>
      <Card title="Database">
        <Facts
          rows={[
            ["Latest migration", settings.database.latestMigration ?? "—"],
            [
              "Migrations applied",
              settings.database.migrations ??
                "Not readable by this database role",
            ],
            ["Users", settings.database.users],
            ["Verified users", settings.database.verifiedUsers],
            ["Organisations", settings.database.companies],
          ]}
        />
      </Card>
      <Card title="Security">
        <Facts
          rows={[
            ["Auth secret set", yes(settings.security.authSecretSet)],
            [
              "Turnstile (anti-bot) configured",
              yes(settings.security.turnstileConfigured),
            ],
            [
              "GitHub token for this console",
              yes(settings.security.adminGithubTokenSet),
            ],
          ]}
        />
        <p className="mt-4 text-sm text-muted-foreground">
          Values are never shown here. Change them in the server&apos;s{" "}
          <code>.env</code> and <code>.env-admin</code> files, then restart.
        </p>
      </Card>
    </div>
  );
}

async function OrganisationsTab() {
  const rows = await listOrganisations(getDatabase());
  const counts = {
    full: rows.filter((row) => row.licence === "full" && !row.isDemo).length,
    trial: rows.filter((row) => row.licence === "trial").length,
    ended: rows.filter((row) => row.licence === "trial_ended").length,
    demo: rows.filter((row) => row.isDemo).length,
  };
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ["Full licence", counts.full],
          ["Free trial", counts.trial],
          ["Trial ended", counts.ended],
          ["Demo", counts.demo],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border bg-card p-4 text-card-foreground"
          >
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <Card title={`Organisations (${rows.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">
              All organisations and their licences
            </caption>
            <thead>
              <tr className="border-b">
                {[
                  "Organisation",
                  "Licence",
                  "Owner",
                  "Members",
                  "Jobs",
                  "Invoices",
                  "Created",
                  "Last activity",
                  "Actions",
                ].map((head) => (
                  <th
                    key={head}
                    scope="col"
                    className="px-2 py-2 font-semibold"
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/40 align-top"
                >
                  <th scope="row" className="px-2 py-3 font-medium">
                    {row.name}
                    {row.isDemo ? (
                      <span className="ml-2">
                        <Pill tone="warning">Demo</Pill>
                      </span>
                    ) : null}
                    <div className="text-xs font-normal text-muted-foreground">
                      {row.id}
                    </div>
                  </th>
                  <td className="px-2 py-3">
                    {row.licence === "full" ? (
                      <Pill tone="success">Full licence</Pill>
                    ) : row.licence === "trial" ? (
                      <Pill
                        tone={
                          (row.daysRemaining ?? 0) <= 7 ? "warning" : "info"
                        }
                      >
                        Free trial · {row.daysRemaining} days left
                      </Pill>
                    ) : (
                      <Pill tone="danger">Trial ended</Pill>
                    )}
                    {row.trialLastDay ? (
                      <div className="text-xs text-muted-foreground">
                        Last day {row.trialLastDay}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-3">
                    {row.owner ? (
                      <>
                        {row.owner.name ?? "—"}
                        <div className="text-xs text-muted-foreground">
                          {row.owner.email}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-3">{row.members}</td>
                  <td className="px-2 py-3">{row.jobs}</td>
                  <td className="px-2 py-3">{row.invoices}</td>
                  <td className="px-2 py-3">{dateTime(row.createdAt)}</td>
                  <td className="px-2 py-3">{dateTime(row.lastActivity)}</td>
                  <td className="px-2 py-3">
                    {row.isDemo ? (
                      "—"
                    ) : (
                      <OrganisationActions
                        companyId={row.id}
                        name={row.name}
                        licence={row.licence}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const STATUS_ORDER: [string, string][] = [
  ["status:in-progress", "In progress"],
  ["status:in-review", "In review"],
  ["status:blocked", "Blocked"],
  ["status:needs-info", "Needs info"],
  ["status:ready", "Ready to start"],
  ["backlog", "Backlog (waiting on dependencies)"],
];

async function GithubTab({
  config,
}: {
  config: NonNullable<ReturnType<typeof loadAdminConfig>>;
}) {
  const [snapshot, activity, processes] = await Promise.all([
    githubSnapshot(),
    agentActivity(config),
    runningAgents(),
  ]);
  const ciPill = (ci: string) =>
    ci === "passing" ? (
      <Pill tone="success">CI passing</Pill>
    ) : ci === "failing" ? (
      <Pill tone="danger">CI failing</Pill>
    ) : ci === "running" ? (
      <Pill tone="warning">CI running</Pill>
    ) : ci === "unknown" ? (
      <Pill tone="warning">CI unknown</Pill>
    ) : (
      <Pill tone="info">No CI</Pill>
    );
  return (
    <div className="space-y-6">
      {!snapshot.ok ? (
        <p
          role="alert"
          className="rounded-lg bg-danger p-4 text-danger-foreground"
        >
          GitHub couldn&apos;t be reached: {snapshot.error}. Add a read-only{" "}
          <code>ADMIN_GITHUB_TOKEN</code> to the server&apos;s <code>.env</code>{" "}
          and restart: without one, GitHub allows only 60 requests an hour.
        </p>
      ) : null}
      <Card title="Agents">
        <h3 className="mb-2 font-semibold">Running on this server now</h3>
        {processes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Claude or Codex processes are running.
          </p>
        ) : (
          <ul className="mb-6 space-y-1 text-sm">
            {processes.map((process) => (
              <li key={process.pid}>
                <Pill tone="success">{process.program}</Pill>{" "}
                <span className="text-muted-foreground">pid {process.pid}</span>{" "}
                <code>{process.cwd ?? "?"}</code>
              </li>
            ))}
          </ul>
        )}
        <h3 className="mb-2 font-semibold">Latest updates by agent</h3>
        {!activity.source ? (
          <p className="text-sm text-muted-foreground">
            Set <code>AGENT_UPDATES_FILE</code> in <code>.env-admin</code> to
            show the shared updates page.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {Object.entries(activity.byAgent).map(([agent, entries]) => (
              <div key={agent} className="rounded-xl border p-4">
                <h4 className="font-semibold">{agent}</h4>
                <ol className="mt-2 space-y-2 text-sm">
                  {entries.map((entry, index) => (
                    <li key={`${entry.at}-${index}`}>
                      <span className="text-muted-foreground">{entry.at}</span>{" "}
                      <strong>{entry.topic}</strong>
                      <p className="line-clamp-3">{entry.text}</p>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title={`Open pull requests (${snapshot.openPulls.length})`}>
        <ul className="space-y-3 text-sm">
          {snapshot.openPulls.map((pull) => (
            <li key={pull.number} className="flex flex-wrap items-start gap-2">
              {ciPill(pull.ci)}
              {pull.draft ? <Pill tone="info">Draft</Pill> : null}
              <a className="text-link underline" href={pull.url}>
                #{pull.number} {pull.title}
              </a>
              <span className="text-muted-foreground">
                {pull.branch} → {pull.base} · {pull.author} · updated{" "}
                {dateTime(pull.updatedAt)}
              </span>
              {pull.failing.length ? (
                <span className="w-full text-danger-foreground">
                  Failing: {pull.failing.join(", ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="CI on main">
          <ul className="space-y-2 text-sm">
            {snapshot.mainRuns.map((run, index) => (
              <li key={`${run.url}-${index}`} className="flex flex-wrap gap-2">
                {run.status !== "completed" ? (
                  <Pill tone="warning">{run.status}</Pill>
                ) : run.conclusion === "success" ? (
                  <Pill tone="success">success</Pill>
                ) : (
                  <Pill tone="danger">{run.conclusion ?? "unknown"}</Pill>
                )}
                <a className="text-link underline" href={run.url}>
                  {run.name}
                </a>
                <span className="text-muted-foreground">
                  {dateTime(run.at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Recently merged (finished)">
          <ul className="space-y-2 text-sm">
            {snapshot.merged.map((pull) => (
              <li key={pull.number}>
                <a className="text-link underline" href={pull.url}>
                  #{pull.number} {pull.title}
                </a>{" "}
                <span className="text-muted-foreground">
                  {dateTime(pull.mergedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Milestones">
        <ul className="space-y-2 text-sm">
          {snapshot.issues.milestones.map((milestone) => {
            const total = milestone.open + milestone.closed;
            const percent = total
              ? Math.round((milestone.closed / total) * 100)
              : 0;
            return (
              <li key={milestone.title}>
                <div className="flex justify-between">
                  <span className="font-medium">{milestone.title}</span>
                  <span>
                    {milestone.closed}/{total} done · {milestone.open} open
                  </span>
                </div>
                <div
                  className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Pending work (open issues)">
        <div className="grid gap-6 lg:grid-cols-2">
          {STATUS_ORDER.filter(
            ([key]) => snapshot.issues.byStatus[key]?.length,
          ).map(([key, label]) => (
            <div key={key}>
              <h3 className="mb-2 font-semibold">
                {label} ({snapshot.issues.byStatus[key]!.length})
              </h3>
              <ul className="space-y-1 text-sm">
                {snapshot.issues.byStatus[key]!.map((issue) => (
                  <li key={issue.number}>
                    <a className="text-link underline" href={issue.url}>
                      #{issue.number}
                    </a>{" "}
                    {issue.title}
                    {issue.milestone ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {issue.milestone}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default async function AdminConsolePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const config = loadAdminConfig();
  if (!config) notFound();
  const signedIn = isAdminRequest(config, await headers());
  if (!signedIn) {
    return (
      <main id="main" className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-2xl font-bold">Admin console</h1>
        <section className="mt-6 rounded-2xl border bg-card p-6 text-card-foreground">
          <AdminLoginForm />
        </section>
      </main>
    );
  }
  const requested = (await searchParams).tab;
  const tab: Tab = TABS.some((item) => item.id === requested)
    ? (requested as Tab)
    : "organisations";
  return (
    <main id="main" className="mx-auto max-w-7xl space-y-6 px-4 py-8 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">JobFlow admin console</h1>
        <AdminLogout />
      </header>
      <nav aria-label="Admin sections">
        <ul className="flex flex-wrap gap-2 border-b">
          {TABS.map((item) => (
            <li key={item.id}>
              <Link
                href={`/admin-console?tab=${item.id}`}
                aria-current={item.id === tab ? "page" : undefined}
                className={`inline-flex min-h-11 items-center border-b-2 px-4 font-medium ${
                  item.id === tab
                    ? "border-primary text-link"
                    : "border-transparent"
                }`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === "settings" ? (
        <SettingsTab config={config} />
      ) : tab === "github" ? (
        <GithubTab config={config} />
      ) : (
        <OrganisationsTab />
      )}
    </main>
  );
}
