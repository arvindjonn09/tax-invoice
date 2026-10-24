BEGIN;

-- #38 Employee cost-rate history and timesheets (no payroll). Rates are
-- append-only and effective-dated; an approved timesheet snapshots the rate
-- in effect on its work date and its cost once. Decided timesheets are
-- final; a correction is an approved reversal with negated minutes and cost.

-- CreateEnum
CREATE TYPE "timesheet_status" AS ENUM ('submitted', 'approved', 'rejected');

-- CreateTable: append-only (trigger below).
CREATE TABLE "employee_rate_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    -- Internal cost per hour, integer cents; never negative, up to $1m/h.
    "hourly_cost_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "employee_rate_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_rate_history_bounds" CHECK ("hourly_cost_cents" BETWEEN 0 AND 100000000)
);

-- CreateTable
CREATE TABLE "timesheets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "visit_id" UUID,
    "work_date" DATE NOT NULL,
    -- Negative only on a reversal.
    "minutes" INTEGER NOT NULL,
    "note" VARCHAR(500),
    "status" "timesheet_status" NOT NULL DEFAULT 'submitted',
    "decision_note" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    -- Snapshot at approval; never recalculated.
    "rate_id" UUID,
    "hourly_cost_cents" BIGINT,
    "cost_cents" BIGINT,
    "reverses_id" UUID,
    "submitted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "timesheets_minutes" CHECK (
      CASE WHEN "reverses_id" IS NULL
        THEN "minutes" BETWEEN 1 AND 1440
        ELSE "minutes" BETWEEN -1440 AND -1
      END
    ),
    CONSTRAINT "timesheets_decision" CHECK (
      ("status" = 'submitted') = ("decided_at" IS NULL)
      AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
    ),
    -- Approved means the cost snapshot exists, and only then.
    CONSTRAINT "timesheets_approved_snapshot" CHECK (
      ("status" = 'approved') = ("cost_cents" IS NOT NULL)
      AND ("cost_cents" IS NULL) = ("hourly_cost_cents" IS NULL)
      AND ("cost_cents" IS NULL) = ("rate_id" IS NULL)
    ),
    CONSTRAINT "timesheets_reversal_approved" CHECK ("reverses_id" IS NULL OR "status" = 'approved')
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_rate_history_company_id_id_key" ON "employee_rate_history"("company_id", "id");
-- One rate per employee per start date (a correction is a new date).
CREATE UNIQUE INDEX "employee_rate_history_employee_from_key" ON "employee_rate_history"("company_id", "employee_id", "effective_from");
CREATE INDEX "employee_rate_history_company_id_created_by_idx" ON "employee_rate_history"("company_id", "created_by");
CREATE UNIQUE INDEX "timesheets_company_id_id_key" ON "timesheets"("company_id", "id");
-- At most one reversal per timesheet: labour is never counted twice.
CREATE UNIQUE INDEX "timesheets_company_id_reverses_id_key" ON "timesheets"("company_id", "reverses_id");
CREATE INDEX "timesheets_company_id_job_id_idx" ON "timesheets"("company_id", "job_id");
CREATE INDEX "timesheets_company_id_employee_id_work_date_idx" ON "timesheets"("company_id", "employee_id", "work_date");
CREATE INDEX "timesheets_company_id_status_idx" ON "timesheets"("company_id", "status");
CREATE INDEX "timesheets_company_id_submitted_by_idx" ON "timesheets"("company_id", "submitted_by");
CREATE INDEX "timesheets_company_id_decided_by_idx" ON "timesheets"("company_id", "decided_by");
CREATE INDEX "timesheets_company_id_rate_id_idx" ON "timesheets"("company_id", "rate_id");

-- AddForeignKey
ALTER TABLE "employee_rate_history" ADD CONSTRAINT "employee_rate_history_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employees"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "employee_rate_history" ADD CONSTRAINT "employee_rate_history_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employees"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- A visit must belong to the timesheet's own job.
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_job_id_visit_id_fkey" FOREIGN KEY ("company_id", "job_id", "visit_id") REFERENCES "job_visits"("company_id", "job_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_rate_id_fkey" FOREIGN KEY ("company_id", "rate_id") REFERENCES "employee_rate_history"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_reverses_id_fkey" FOREIGN KEY ("company_id", "reverses_id") REFERENCES "timesheets"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_submitted_by_fkey" FOREIGN KEY ("company_id", "submitted_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_company_id_decided_by_fkey" FOREIGN KEY ("company_id", "decided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER timesheets_touch_updated_at BEFORE UPDATE ON timesheets
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- Rate history can never be edited or removed (function from #31).
CREATE TRIGGER employee_rate_history_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON employee_rate_history
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

-- Timesheets are never deleted. A decided one can't change at all, and
-- deciding one can't change what was submitted.
CREATE FUNCTION jobflow_guard_timesheet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'timesheets are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'a % timesheet can''t be changed; record a reversal', OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'submitted' AND (
    NEW.employee_id, NEW.job_id, NEW.visit_id, NEW.work_date, NEW.minutes, NEW.note
  ) IS DISTINCT FROM (
    OLD.employee_id, OLD.job_id, OLD.visit_id, OLD.work_date, OLD.minutes, OLD.note
  ) THEN
    RAISE EXCEPTION 'deciding a timesheet can''t change it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER timesheets_guard BEFORE UPDATE OR DELETE ON timesheets
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_timesheet();
CREATE TRIGGER timesheets_no_truncate BEFORE TRUNCATE ON timesheets
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
