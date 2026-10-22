# JobFlow (tax-invoice) — Claude Code team playbook

**Read [`AGENTS.md`](AGENTS.md) first.** It holds the product and engineering rules (scope, GST, money, security,
demo data, quality gates) and applies to every agent. This file holds the **team workflow** — who does what and how
work moves through GitHub. The two must stay consistent; if you change one, check the other.

Specification (source of truth): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) ·
[docs/GST.md](docs/GST.md) · [docs/DATA_MODEL.md](docs/DATA_MODEL.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/UI_DESIGN.md](docs/UI_DESIGN.md) ·
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

Work is tracked in GitHub Issues at https://github.com/arvindjonn09/tax-invoice/issues under milestones
**M0 Foundation → M5 Production pilot**, built in that order.

## Non-negotiables (summary of AGENTS.md)
- AUD as integer cents; never floating point for money.
- **GST and job profitability are built and tested together.** Profit uses GST-exclusive amounts; recoverable GST is
  never revenue, profit or expense; only non-creditable GST is job cost. Both fixtures in
  [docs/GST.md](docs/GST.md#combined-gst-and-profit-acceptance-fixture) must pass.
- In scope: GST calculation, tax invoices, draft GST/BAS. Out of scope: lodgement, superannuation, PAYG, STP, payroll.
- Server-side, deny-by-default authorisation with company and object scope; subcontractors never see prices or profit.
- Issued/approved financial records are never edited or deleted — credit, void, reversal, audit event.
- Demo data is database-backed, flagged, shown with a persistent **"Demo Data"** indicator, and refused in production.
- Dashboard/invoice-builder are **design previews only** in M0; their financial functionality waits for M3/M4.

## Tech stack
Decided (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): Next.js App Router + React, strict TypeScript, Tailwind +
shadcn/ui, Zod, PostgreSQL + Prisma, Auth.js (or equivalent maintained library), S3-compatible private storage,
server-side PDF, Docker Compose, Vitest + Playwright. The architect records it in `docs/adr/0001-tech-stack.md` during M0
and fills in the commands below.

| Task | Command |
|---|---|
| Install | _TBD in M0_ |
| Dev server | _TBD in M0_ |
| Type-check | _TBD in M0_ |
| Lint | _TBD in M0_ |
| Unit / integration tests | _TBD in M0_ |
| E2E tests | _TBD in M0_ |
| DB migrate / seed demo | _TBD in M0_ |

## The team (`.claude/agents/`)

| Agent | Role |
|---|---|
| `orchestrator` | Breaks goals into issues, dispatches agents, verifies, integrates, reports |
| `product-analyst` | User stories, acceptance criteria, issue grooming |
| `research-dev` | Spikes, library evaluation, prototypes |
| `domain-expert` | Australian GST / tax-invoice / record-keeping rules, fixtures (sourced from the ATO) |
| `architect` | ADRs, architecture, data model, API contracts, task breakdown |
| `ui-ux-designer` | Flows, screen specs, design system, accessibility |
| `database-engineer` | Prisma schema, migrations, constraints, seeds |
| `backend-engineer` | Services, APIs, business logic, auth, PDFs |
| `frontend-engineer` | Pages, components, forms, client integration |
| `engineer` | Generalist: glue, small fixes, refactors |
| `qa-engineer` | Test plans, automated tests, acceptance verification |
| `code-reviewer` | PR review (read-only) |
| `security-engineer` | Threat models, security review, dependency audit |
| `devops-engineer` | CI/CD, Docker, environments, backups, deploy |
| `tech-writer` | README, guides, API docs, changelog |

### How to run
- **Full team:** `claude --agent orchestrator` (the orchestrator must be the main session to dispatch subagents).
- **One specialist:** "use the architect agent on #12" or `@backend-engineer`.
- **Skills:** `/plan-feature <idea>` → epic + issues; `/work-issue <n>` → issue to reviewed PR.

## Lifecycle
```
issue (status:ready) → owner agent claims → branch → code + tests → PR (Closes #n)
  → CI green → qa-engineer + code-reviewer (+ security-engineer for auth/money/files/PII)
  → owner (user) merges → issue closes → orchestrator marks dependants status:ready
```

### Labels (`scripts/setup-labels.sh`)
- **Area:** `frontend` `backend` `database` `security` `gst` `testing` `documentation` `infra` `design`
- **Owner:** `agent:<name>`
- **Type:** `type:epic` `type:feature` `type:bug` `type:spike` `type:chore` `type:docs` `type:design`
- **Status:** `status:ready` `status:in-progress` `status:in-review` `status:blocked` `status:needs-info`
  (no status label = backlog, waiting on dependencies)
- **Priority:** `priority:p0` … `priority:p3`
- **Milestone:** GitHub milestones `M0 Foundation` … `M5 Production pilot`

### Rules every agent follows
> `gh issue view` / `gh pr view` without `--json` fail on this machine's gh 2.45 (Projects-classic deprecation).
> Always pass `--json …` (e.g. `--json title,body,labels,milestone,comments`).

1. **Read the issue first** — `gh issue view <n> --json title,body,labels,milestone,comments` — and its "Depends on" issues. Don't start if a dependency
   is open; comment instead. Never work without an issue.
2. **Claim it:** `gh issue edit <n> --add-label status:in-progress --remove-label status:ready` and comment a short plan.
3. **Branch** from up-to-date `main`: `<type>/<issue>-<slug>`, e.g. `feat/14-customer-crud`. Never commit to `main`.
4. **Commits:** Conventional Commits with the issue — `feat(customers): add archive (#14)`.
5. **PR:** `gh pr create` with `Closes #<n>`, summary and a test plan with real output (template in
   `.github/pull_request_template.md`); set `status:in-review`. Application PRs need green CI: type-check, lint,
   tests, and security checks.
6. **Hand-off:** finish with an issue comment — done / left / next agent. Blocked → `status:blocked` + reason.
7. **Stay in lane:** work for another agent goes into an issue labelled for that agent.
8. **Evidence over claims:** report actual command output; say what wasn't run.
9. **Never** commit secrets, real customer/employee data, real ABNs or `.env` files; never force-push `main`. Don't
   merge PRs or close issues unless the user says so.

## Project docs layout
- `docs/*.md` — specification (above)
- `docs/adr/NNNN-title.md` — architecture decisions (architect)
- `docs/research/` — spikes and domain research (research-dev, domain-expert)
- `docs/design/` — flows, screen specs, design system (ui-ux-designer)
- `docs/security/` — threat models, reviews (security-engineer)
- `docs/testing/` — test plans (qa-engineer)
