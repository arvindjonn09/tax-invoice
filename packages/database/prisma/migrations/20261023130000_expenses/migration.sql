BEGIN;

-- #40 Job and general expenses. Amounts are integer cents. Cost is incurred
-- once, on approval; approved and rejected expenses are final, and a
-- correction is an approved reversal with the original's exact negated cents.

-- CreateEnum
CREATE TYPE "expense_category" AS ENUM ('materials', 'travel', 'parking', 'equipment', 'misc');

-- CreateEnum
CREATE TYPE "price_entry" AS ENUM ('exclusive', 'inclusive');

-- CreateEnum: owner requirement (#40): chosen per expense, default in settings.
CREATE TYPE "expense_settlement" AS ENUM ('paid_at_purchase', 'on_account');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('card', 'cash', 'bank_transfer', 'other');

-- CreateEnum
CREATE TYPE "expense_status" AS ENUM ('submitted', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "default_expense_settlement" "expense_settlement" NOT NULL DEFAULT 'paid_at_purchase';

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    -- Null = a general (overhead) expense.
    "job_id" UUID,
    "category" "expense_category" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "supplier_name" VARCHAR(200),
    "purchased_on" DATE NOT NULL,
    -- As entered on the receipt.
    "price_entry" "price_entry" NOT NULL,
    "entered_amount_cents" BIGINT NOT NULL,
    "tax_code" "tax_code" NOT NULL,
    "gst_rate_basis_points" INTEGER NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "inclusive_cents" BIGINT NOT NULL,
    -- Business-use share of the GST that may be claimed (10000 = 100%).
    "creditable_basis_points" INTEGER NOT NULL DEFAULT 10000,
    "receipt_document_id" UUID,
    -- Null only for a cost-only reversal (no refund or supplier credit).
    "settlement" "expense_settlement",
    "paid_on" DATE,
    "payment_method" "payment_method",
    "status" "expense_status" NOT NULL DEFAULT 'submitted',
    "decision_note" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    -- Snapshot at approval; never recalculated.
    "company_gst_registered" BOOLEAN,
    -- The approver verified the retained document (R5/R6); never inferred.
    "evidence_verified" BOOLEAN,
    "has_evidence" BOOLEAN,
    "creditable_gst_cents" BIGINT,
    "non_creditable_gst_cents" BIGINT,
    "job_cost_cents" BIGINT,
    -- A reversal points at the approved expense it cancels (at most one).
    "reverses_id" UUID,
    -- A correction replaces a cost-only-reversed expense and reuses its
    -- original settlement (no new payment or payable). At most one.
    "corrects_id" UUID,
    "submitted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expenses_description_not_blank" CHECK (btrim("description") <> ''),
    CONSTRAINT "expenses_rate" CHECK ("gst_rate_basis_points" BETWEEN 0 AND 10000),
    CONSTRAINT "expenses_creditable" CHECK ("creditable_basis_points" BETWEEN 0 AND 10000),
    CONSTRAINT "expenses_amounts" CHECK (
      "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND abs("entered_amount_cents") <= 1000000000000
      AND CASE WHEN "reverses_id" IS NULL
        THEN "entered_amount_cents" >= 0 AND "exclusive_cents" >= 0 AND "gst_cents" >= 0
        ELSE "entered_amount_cents" <= 0 AND "exclusive_cents" <= 0 AND "gst_cents" <= 0
      END
    ),
    -- Paid at purchase records when and how, once; on account records
    -- neither. A reversal moves cash or the balance only when it says so.
    CONSTRAINT "expenses_settlement" CHECK (
      ("settlement" = 'paid_at_purchase' AND "paid_on" IS NOT NULL AND "payment_method" IS NOT NULL)
      OR ("settlement" = 'on_account' AND "paid_on" IS NULL AND "payment_method" IS NULL)
      OR ("settlement" IS NULL AND ("reverses_id" IS NOT NULL OR "corrects_id" IS NOT NULL) AND "paid_on" IS NULL AND "payment_method" IS NULL)
    ),
    CONSTRAINT "expenses_reversal_or_correction" CHECK ("reverses_id" IS NULL OR "corrects_id" IS NULL),
    CONSTRAINT "expenses_decision" CHECK (
      ("status" = 'submitted') = ("decided_at" IS NULL)
      AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
    ),
    -- Approved means the cost snapshot exists, and only then.
    CONSTRAINT "expenses_approved_snapshot" CHECK (
      ("status" = 'approved') = ("job_cost_cents" IS NOT NULL)
      AND ("job_cost_cents" IS NULL) = ("creditable_gst_cents" IS NULL)
      AND ("job_cost_cents" IS NULL) = ("non_creditable_gst_cents" IS NULL)
      AND ("job_cost_cents" IS NULL) = ("company_gst_registered" IS NULL)
      AND ("job_cost_cents" IS NULL) = ("has_evidence" IS NULL)
      AND ("job_cost_cents" IS NULL) = ("evidence_verified" IS NULL)
      AND ("job_cost_cents" IS NULL OR (
        "creditable_gst_cents" + "non_creditable_gst_cents" = "gst_cents"
        AND "job_cost_cents" = "exclusive_cents" + "non_creditable_gst_cents"
      ))
    ),
    -- Reversals are created already approved.
    CONSTRAINT "expenses_reversal_approved" CHECK ("reverses_id" IS NULL OR "status" = 'approved')
);

-- CreateIndex
CREATE UNIQUE INDEX "expenses_company_id_id_key" ON "expenses"("company_id", "id");
-- One receipt per expense, one reversal per expense.
CREATE UNIQUE INDEX "expenses_company_id_receipt_document_id_key" ON "expenses"("company_id", "receipt_document_id");
CREATE UNIQUE INDEX "expenses_company_id_reverses_id_key" ON "expenses"("company_id", "reverses_id");
CREATE UNIQUE INDEX "expenses_company_id_corrects_id_key" ON "expenses"("company_id", "corrects_id");
CREATE INDEX "expenses_company_id_job_id_idx" ON "expenses"("company_id", "job_id");
CREATE INDEX "expenses_company_id_status_purchased_on_idx" ON "expenses"("company_id", "status", "purchased_on");
CREATE INDEX "expenses_company_id_submitted_by_idx" ON "expenses"("company_id", "submitted_by");
CREATE INDEX "expenses_company_id_decided_by_idx" ON "expenses"("company_id", "decided_by");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_receipt_document_id_fkey" FOREIGN KEY ("company_id", "receipt_document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_corrects_id_fkey" FOREIGN KEY ("company_id", "corrects_id") REFERENCES "expenses"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_reverses_id_fkey" FOREIGN KEY ("company_id", "reverses_id") REFERENCES "expenses"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_submitted_by_fkey" FOREIGN KEY ("company_id", "submitted_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_decided_by_fkey" FOREIGN KEY ("company_id", "decided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER expenses_touch_updated_at BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- Expenses are never deleted. A decided expense (approved or rejected) can't
-- change at all, and deciding one can't change what was submitted.
CREATE FUNCTION jobflow_guard_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expenses are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'a % expense can''t be changed; record a reversal', OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'submitted' AND (
    NEW.job_id, NEW.category, NEW.description, NEW.supplier_name, NEW.purchased_on,
    NEW.price_entry, NEW.entered_amount_cents, NEW.tax_code, NEW.gst_rate_basis_points,
    NEW.exclusive_cents, NEW.gst_cents, NEW.inclusive_cents, NEW.creditable_basis_points,
    NEW.receipt_document_id, NEW.settlement, NEW.paid_on, NEW.payment_method,
    NEW.reverses_id, NEW.corrects_id
  ) IS DISTINCT FROM (
    OLD.job_id, OLD.category, OLD.description, OLD.supplier_name, OLD.purchased_on,
    OLD.price_entry, OLD.entered_amount_cents, OLD.tax_code, OLD.gst_rate_basis_points,
    OLD.exclusive_cents, OLD.gst_cents, OLD.inclusive_cents, OLD.creditable_basis_points,
    OLD.receipt_document_id, OLD.settlement, OLD.paid_on, OLD.payment_method,
    OLD.reverses_id, OLD.corrects_id
  ) THEN
    RAISE EXCEPTION 'deciding an expense can''t change it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER expenses_guard BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_expense();
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
