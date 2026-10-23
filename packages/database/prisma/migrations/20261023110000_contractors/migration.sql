BEGIN;

-- #35 Contractors, job offers and acceptance snapshots. Amounts are
-- GST-exclusive integer cents. An offer can change only while it is open;
-- acceptance snapshots its terms and records the committed cost once.

-- CreateEnum
CREATE TYPE "contractor_rate_type" AS ENUM ('fixed', 'hourly');

-- CreateEnum: GST treatment of a line (docs/GST.md), shared by later lines.
CREATE TYPE "tax_code" AS ENUM ('TAXABLE_10', 'GST_FREE', 'INPUT_TAXED', 'OUT_OF_SCOPE');

-- CreateEnum
CREATE TYPE "contractor_offer_status" AS ENUM ('offered', 'accepted', 'declined', 'withdrawn');

-- CreateTable
CREATE TABLE "contractors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    -- Optional subcontractor login of the same company.
    "user_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "abn" CHAR(11),
    "gst_registered" BOOLEAN NOT NULL DEFAULT false,
    "email" VARCHAR(320),
    "phone" VARCHAR(30),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "contractors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contractors_name_not_blank" CHECK (btrim("name") <> ''),
    CONSTRAINT "contractors_abn_digits" CHECK ("abn" IS NULL OR "abn" ~ '^[0-9]{11}$'),
    -- Only an entity with an ABN can be registered for GST.
    CONSTRAINT "contractors_gst_needs_abn" CHECK (NOT "gst_registered" OR "abn" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "contractor_offers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "contractor_id" UUID NOT NULL,
    "scope" VARCHAR(2000) NOT NULL,
    "rate_type" "contractor_rate_type" NOT NULL,
    -- Fixed price, or price per hour.
    "rate_exclusive_cents" BIGINT NOT NULL,
    -- Hourly offers: estimated hours × 100 (7.5 h = 750).
    "estimated_hours_hundredths" INTEGER,
    "tax_code" "tax_code" NOT NULL,
    "status" "contractor_offer_status" NOT NULL DEFAULT 'offered',
    "response_note" VARCHAR(500),
    "responded_at" TIMESTAMPTZ(3),
    "responded_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "contractor_offers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contractor_offers_scope_not_blank" CHECK (btrim("scope") <> ''),
    -- Up to $10 billion; never negative.
    CONSTRAINT "contractor_offers_rate_bounds" CHECK ("rate_exclusive_cents" BETWEEN 0 AND 1000000000000),
    -- Hourly offers carry 0.01–9999.99 estimated hours; fixed offers none.
    CONSTRAINT "contractor_offers_hours" CHECK (
      ("rate_type" = 'hourly' AND "estimated_hours_hundredths" BETWEEN 1 AND 999999)
      OR ("rate_type" = 'fixed' AND "estimated_hours_hundredths" IS NULL)
    ),
    -- Every closed offer records who closed it and when.
    CONSTRAINT "contractor_offers_response" CHECK (
      ("status" = 'offered') = ("responded_at" IS NULL)
      AND ("responded_at" IS NULL) = ("responded_by" IS NULL)
    )
);

-- CreateTable: append-only (trigger below), one per accepted offer.
CREATE TABLE "contractor_acceptances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "contractor_id" UUID NOT NULL,
    -- Snapshot of the accepted terms; never recalculated.
    "rate_type" "contractor_rate_type" NOT NULL,
    "rate_exclusive_cents" BIGINT NOT NULL,
    "estimated_hours_hundredths" INTEGER,
    "tax_code" "tax_code" NOT NULL,
    "gst_rate_basis_points" INTEGER NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "inclusive_cents" BIGINT NOT NULL,
    "contractor_gst_registered" BOOLEAN NOT NULL,
    "company_gst_registered" BOOLEAN NOT NULL,
    -- Recorded once: exclusive + non-creditable GST (docs/DATA_MODEL.md).
    "committed_cost_cents" BIGINT NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_by" UUID NOT NULL,

    CONSTRAINT "contractor_acceptances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contractor_acceptances_amounts" CHECK (
      "exclusive_cents" >= 0 AND "gst_cents" >= 0
      AND "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "committed_cost_cents" BETWEEN "exclusive_cents" AND "inclusive_cents"
    ),
    CONSTRAINT "contractor_acceptances_rate" CHECK ("gst_rate_basis_points" BETWEEN 0 AND 10000)
);

-- CreateIndex
CREATE UNIQUE INDEX "contractors_company_id_id_key" ON "contractors"("company_id", "id");
CREATE UNIQUE INDEX "contractors_company_id_user_id_key" ON "contractors"("company_id", "user_id");
CREATE INDEX "contractors_company_id_archived_at_name_idx" ON "contractors"("company_id", "archived_at", "name");
CREATE INDEX "contractors_company_id_created_by_idx" ON "contractors"("company_id", "created_by");
CREATE UNIQUE INDEX "contractor_offers_company_id_id_key" ON "contractor_offers"("company_id", "id");
-- Lets an acceptance require the offer's own job and contractor.
CREATE UNIQUE INDEX "contractor_offers_company_id_id_job_id_contractor_id_key" ON "contractor_offers"("company_id", "id", "job_id", "contractor_id");
-- At most one open or accepted offer per contractor per job.
CREATE UNIQUE INDEX "contractor_offers_live_key" ON "contractor_offers"("company_id", "job_id", "contractor_id")
  WHERE "status" IN ('offered', 'accepted');
CREATE INDEX "contractor_offers_company_id_job_id_idx" ON "contractor_offers"("company_id", "job_id");
CREATE INDEX "contractor_offers_company_id_contractor_id_status_idx" ON "contractor_offers"("company_id", "contractor_id", "status");
CREATE INDEX "contractor_offers_company_id_created_by_idx" ON "contractor_offers"("company_id", "created_by");
CREATE INDEX "contractor_offers_company_id_responded_by_idx" ON "contractor_offers"("company_id", "responded_by");
CREATE UNIQUE INDEX "contractor_acceptances_offer_id_key" ON "contractor_acceptances"("offer_id");
CREATE UNIQUE INDEX "contractor_acceptances_company_id_offer_id_job_id_contractor_id_key" ON "contractor_acceptances"("company_id", "offer_id", "job_id", "contractor_id");
CREATE INDEX "contractor_acceptances_company_id_job_id_idx" ON "contractor_acceptances"("company_id", "job_id");
CREATE INDEX "contractor_acceptances_company_id_contractor_id_idx" ON "contractor_acceptances"("company_id", "contractor_id");
CREATE INDEX "contractor_acceptances_company_id_accepted_by_idx" ON "contractor_acceptances"("company_id", "accepted_by");

-- AddForeignKey
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_company_id_user_id_fkey" FOREIGN KEY ("company_id", "user_id") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractor_offers" ADD CONSTRAINT "contractor_offers_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractor_offers" ADD CONSTRAINT "contractor_offers_company_id_contractor_id_fkey" FOREIGN KEY ("company_id", "contractor_id") REFERENCES "contractors"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractor_offers" ADD CONSTRAINT "contractor_offers_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractor_offers" ADD CONSTRAINT "contractor_offers_company_id_responded_by_fkey" FOREIGN KEY ("company_id", "responded_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractor_acceptances" ADD CONSTRAINT "contractor_acceptances_offer_fkey" FOREIGN KEY ("company_id", "offer_id", "job_id", "contractor_id") REFERENCES "contractor_offers"("company_id", "id", "job_id", "contractor_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contractor_acceptances" ADD CONSTRAINT "contractor_acceptances_company_id_accepted_by_fkey" FOREIGN KEY ("company_id", "accepted_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER contractors_touch_updated_at BEFORE UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER contractor_offers_touch_updated_at BEFORE UPDATE ON contractor_offers
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- Offers are never deleted; once closed (accepted, declined, withdrawn) they
-- can't change at all, and closing one can't change its terms.
CREATE FUNCTION jobflow_guard_contractor_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contractor offers are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'offered' THEN
    RAISE EXCEPTION 'a % offer can''t be changed', OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'offered' AND (
    NEW.rate_type, NEW.rate_exclusive_cents, NEW.estimated_hours_hundredths,
    NEW.tax_code, NEW.scope, NEW.job_id, NEW.contractor_id
  ) IS DISTINCT FROM (
    OLD.rate_type, OLD.rate_exclusive_cents, OLD.estimated_hours_hundredths,
    OLD.tax_code, OLD.scope, OLD.job_id, OLD.contractor_id
  ) THEN
    RAISE EXCEPTION 'closing an offer can''t change its terms' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contractor_offers_guard BEFORE UPDATE OR DELETE ON contractor_offers
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_contractor_offer();
CREATE TRIGGER contractor_offers_no_truncate BEFORE TRUNCATE ON contractor_offers
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

-- Acceptance snapshots can never be edited or removed (function from #31).
CREATE TRIGGER contractor_acceptances_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON contractor_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
