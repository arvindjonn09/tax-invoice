BEGIN;

-- #31 Jobs: per-company numbering, status machine, immutable status history,
-- multiple visits. Agreed price is GST-exclusive integer cents.

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('draft', 'quoted', 'approved', 'assigned', 'in_progress', 'awaiting_review', 'completed', 'invoiced', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "job_visit_status" AS ENUM ('scheduled', 'completed', 'cancelled');

-- CreateTable: per-company counters ("job", later "invoice"), incremented
-- atomically inside the creating transaction (no duplicates, no gaps from
-- rolled-back creates).
CREATE TABLE "number_sequences" (
    "company_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("company_id", "kind"),
    CONSTRAINT "number_sequences_positive" CHECK ("last_value" >= 0)
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    -- Prefix + number at creation; later prefix changes don't renumber.
    "reference" VARCHAR(30) NOT NULL,
    "customer_id" UUID NOT NULL,
    "location_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(4000),
    "status" "job_status" NOT NULL DEFAULT 'draft',
    "agreed_price_exclusive_cents" BIGINT,
    "due_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jobs_number_positive" CHECK ("number" > 0),
    CONSTRAINT "jobs_title_not_blank" CHECK (btrim("title") <> ''),
    -- Up to $10 billion; never negative.
    CONSTRAINT "jobs_price_bounds" CHECK ("agreed_price_exclusive_cents" IS NULL OR "agreed_price_exclusive_cents" BETWEEN 0 AND 1000000000000)
);

-- CreateTable: append-only (trigger below).
CREATE TABLE "job_status_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "from_status" "job_status",
    "to_status" "job_status" NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "job_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_visits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "status" "job_visit_status" NOT NULL DEFAULT 'scheduled',
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "job_visits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_visits_window" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_company_id_number_key" ON "jobs"("company_id", "number");
CREATE UNIQUE INDEX "jobs_company_id_id_key" ON "jobs"("company_id", "id");
CREATE INDEX "jobs_company_id_status_idx" ON "jobs"("company_id", "status");
CREATE INDEX "jobs_company_id_customer_id_idx" ON "jobs"("company_id", "customer_id");
CREATE INDEX "jobs_company_id_created_by_idx" ON "jobs"("company_id", "created_by");
CREATE INDEX "job_status_events_company_id_job_id_created_at_idx" ON "job_status_events"("company_id", "job_id", "created_at");
CREATE INDEX "job_status_events_company_id_created_by_idx" ON "job_status_events"("company_id", "created_by");
CREATE UNIQUE INDEX "job_visits_company_id_id_key" ON "job_visits"("company_id", "id");
CREATE INDEX "job_visits_company_id_job_id_starts_at_idx" ON "job_visits"("company_id", "job_id", "starts_at");
CREATE INDEX "job_visits_company_id_created_by_idx" ON "job_visits"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- The site must belong to the job's own customer.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_customer_id_location_id_fkey" FOREIGN KEY ("company_id", "customer_id", "location_id") REFERENCES "locations"("company_id", "customer_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "job_status_events" ADD CONSTRAINT "job_status_events_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "job_status_events" ADD CONSTRAINT "job_status_events_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER jobs_touch_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER job_visits_touch_updated_at BEFORE UPDATE ON job_visits
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- Status history can never be edited or removed, even with no matching rows.
CREATE FUNCTION jobflow_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER job_status_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON job_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
