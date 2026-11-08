import { can } from "@jobflow/authz";
import { type TrialPhase, trialStatus } from "@jobflow/domain";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { type PolicyHandler, privateJson } from "../authz/policy";

import { supportEmail } from "../email/addresses";

export { DEFAULT_SUPPORT_EMAIL } from "../email/addresses";

/** Full trial status, for `trial.read` holders (owner, manager, accountant). */
export type TrialStatusView = {
  mode: "unrestricted" | "trial";
  phase: TrialPhase | null;
  daysRemaining: number | null;
  /** Last Sydney day of the trial, `YYYY-MM-DD`. */
  lastDay: string | null;
  /** When the company becomes read-only (ISO instant). */
  readOnlyFrom: string | null;
  supportEmail: string;
  extended: boolean;
};
/** What employees and subcontractors see: no dates or countdown (S8 AC2). */
export type TrialReadOnlyView = { readOnly: boolean };

type Row = {
  access_mode: "unrestricted" | "trial";
  last_day: string | null;
  read_only_from: Date | null;
  trial_extension_count: number;
  read_only: boolean;
  now: Date;
};

/**
 * The company's trial status from the database clock, for `trial.read`
 * holders: the API below and the /settings/trial page (#232).
 */
export async function loadTrialStatus(
  db: PrismaClient,
  companyId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TrialStatusView & { readOnly: boolean }> {
  const [row] = await db.$queryRaw<Row[]>`
    SELECT access_mode::text AS access_mode,
           to_char(trial_last_day, 'YYYY-MM-DD') AS last_day,
           read_only_from, trial_extension_count,
           (access_mode = 'trial' AND read_only_from <= now()) AS read_only,
           now() AS now
    FROM companies WHERE id = ${companyId}::uuid`;
  // Callers only ever pass a company the actor belongs to.
  const company = row!;
  const trial = company.access_mode === "trial" && company.last_day !== null;
  const computed = trial ? trialStatus(company.last_day!, company.now) : null;
  return {
    mode: trial ? "trial" : "unrestricted",
    phase: computed?.phase ?? null,
    daysRemaining: computed?.daysRemaining ?? null,
    lastDay: trial ? company.last_day : null,
    readOnlyFrom: trial
      ? (company.read_only_from?.toISOString() ?? null)
      : null,
    supportEmail: supportEmail(env),
    extended: trial && company.trial_extension_count > 0,
    readOnly: trial && company.read_only === true,
  };
}

/**
 * GET /api/company/trial (#221, S8). Every member may ask (`company.read`),
 * but only `trial.read` holders get dates and phase; everyone else learns
 * only whether the company is read-only. Phase and days remaining use the
 * database clock, the same one that decides read-only.
 */
export function trialHandlers(
  db: () => PrismaClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const status: PolicyHandler<unknown> = async ({ actor }) => {
    const { readOnly, ...view } = await loadTrialStatus(
      db(),
      actor.companyId,
      env,
    );
    if (!can(actor.role, "trial.read"))
      return privateJson({ readOnly } satisfies TrialReadOnlyView);
    return privateJson(view satisfies TrialStatusView);
  };
  return { status };
}
