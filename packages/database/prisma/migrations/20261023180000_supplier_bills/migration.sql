BEGIN;

-- #46 Supplier and contractor bills, and supplier payments allocated to them.
-- A bill keeps the supplier's own line figures (R3) and snapshots, once, its
-- creditable GST, non-creditable GST and job cost (exclusive + non-creditable
-- GST). Payments settle the GST-inclusive balance and never change cost.
-- Payments are idempotent like customer receipts (#50): the client key and a
-- request fingerprint live on the payment row (unique per company), written
-- in the same transaction as its allocations, so a crash leaves everything or
-- nothing. Bills and payments are immutable except a one-way, audited void.

-- CreateTable
CREATE TABLE "supplier_bills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID,
    "contractor_id" UUID,
    -- The accepted offer this bill fulfils (releases its commitment).
    "offer_id" UUID,
    "supplier_name" VARCHAR(200) NOT NULL,
    "supplier_abn" CHAR(11),
    "supplier_gst_registered" BOOLEAN NOT NULL,
    "supplier_reference" VARCHAR(100),
    "issued_on" DATE NOT NULL,
    "due_on" DATE,
    "document_id" UUID,
    "evidence_verified" BOOLEAN NOT NULL DEFAULT false,
    "has_evidence" BOOLEAN NOT NULL,
    "creditable_basis_points" INTEGER NOT NULL DEFAULT 10000,
    "creditable_reason" VARCHAR(500),
    "company_gst_registered" BOOLEAN NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "inclusive_cents" BIGINT NOT NULL,
    "creditable_gst_cents" BIGINT NOT NULL,
    "non_creditable_gst_cents" BIGINT NOT NULL,
    "job_cost_cents" BIGINT NOT NULL,
    "note" VARCHAR(500),
    "void_reason" VARCHAR(500),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "supplier_bills_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_bills_name_not_blank" CHECK (btrim("supplier_name") <> ''),
    CONSTRAINT "supplier_bills_abn" CHECK ("supplier_abn" IS NULL OR "supplier_abn" ~ '^[0-9]{11}$'),
    CONSTRAINT "supplier_bills_gst_needs_abn" CHECK (NOT "supplier_gst_registered" OR "supplier_abn" IS NOT NULL),
    CONSTRAINT "supplier_bills_offer_needs_contractor" CHECK ("offer_id" IS NULL OR ("contractor_id" IS NOT NULL AND "job_id" IS NOT NULL)),
    CONSTRAINT "supplier_bills_due" CHECK ("due_on" IS NULL OR "due_on" >= "issued_on"),
    CONSTRAINT "supplier_bills_creditable" CHECK ("creditable_basis_points" BETWEEN 0 AND 10000),
    CONSTRAINT "supplier_bills_creditable_reason" CHECK ("creditable_basis_points" = 10000 OR "creditable_reason" IS NOT NULL),
    CONSTRAINT "supplier_bills_evidence" CHECK (NOT "has_evidence" OR ("document_id" IS NOT NULL AND "evidence_verified")),
    CONSTRAINT "supplier_bills_amounts" CHECK (
      "exclusive_cents" >= 0 AND "gst_cents" >= 0 AND "inclusive_cents" > 0
      AND "inclusive_cents" <= 1000000000000
      AND "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "creditable_gst_cents" >= 0 AND "non_creditable_gst_cents" >= 0
      AND "gst_cents" = "creditable_gst_cents" + "non_creditable_gst_cents"
      AND "job_cost_cents" = "exclusive_cents" + "non_creditable_gst_cents"
    ),
    CONSTRAINT "supplier_bills_no_claim_unregistered" CHECK ("company_gst_registered" OR "creditable_gst_cents" = 0),
    CONSTRAINT "supplier_bills_no_gst_unregistered_supplier" CHECK ("supplier_gst_registered" OR "gst_cents" = 0),
    CONSTRAINT "supplier_bills_void" CHECK (
      ("voided_at" IS NULL) = ("voided_by" IS NULL)
      AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "supplier_bill_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "tax_code" "tax_code" NOT NULL,
    "gst_rate_basis_points" INTEGER NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "inclusive_cents" BIGINT NOT NULL,

    CONSTRAINT "supplier_bill_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_bill_items_description" CHECK (btrim("description") <> ''),
    CONSTRAINT "supplier_bill_items_position" CHECK ("position" BETWEEN 1 AND 100),
    CONSTRAINT "supplier_bill_items_rate" CHECK (
      ("tax_code" = 'TAXABLE_10' AND "gst_rate_basis_points" = 1000)
      OR ("tax_code" <> 'TAXABLE_10' AND "gst_rate_basis_points" = 0 AND "gst_cents" = 0)
    ),
    CONSTRAINT "supplier_bill_items_amounts" CHECK (
      "exclusive_cents" >= 0 AND "gst_cents" >= 0
      AND "inclusive_cents" = "exclusive_cents" + "gst_cents"
    )
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "contractor_id" UUID,
    "payee_name" VARCHAR(200) NOT NULL,
    "paid_on" DATE NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "method" "receipt_method" NOT NULL,
    "reference" VARCHAR(100),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "void_reason" VARCHAR(500),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_payments_amount" CHECK ("amount_cents" > 0 AND "amount_cents" <= 1000000000000),
    CONSTRAINT "supplier_payments_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "supplier_payments_void" CHECK (
      ("voided_at" IS NULL) = ("voided_by" IS NULL)
      AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    -- Cash-basis input tax credit attributed to this allocation (R7).
    "creditable_gst_attributed_cents" BIGINT NOT NULL,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_payment_allocations_amount" CHECK ("amount_cents" > 0),
    CONSTRAINT "supplier_payment_allocations_gst" CHECK (
      "creditable_gst_attributed_cents" >= 0
      AND "creditable_gst_attributed_cents" <= "amount_cents"
    )
);

-- CreateTable
-- Input tax credit correction written when a supplier payment is voided, so a
-- bill's live attributed credit (unvoided allocations plus adjustments) is
-- always the rounded share of what stays paid (as receipt_gst_adjustments).
CREATE TABLE "supplier_payment_gst_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "creditable_gst_cents" BIGINT NOT NULL,
    "adjusted_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_gst_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_payment_gst_adjustments_nonzero" CHECK ("creditable_gst_cents" <> 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bills_company_id_id_key" ON "supplier_bills"("company_id", "id");
CREATE UNIQUE INDEX "supplier_bills_company_id_document_id_key" ON "supplier_bills"("company_id", "document_id");
-- One live bill per supplier invoice, so concurrent duplicates can't both count:
-- a contractor's reference, or a named supplier's (name and reference compared
-- case-insensitively). Voided bills free the reference.
CREATE UNIQUE INDEX "supplier_bills_live_contractor_reference_key" ON "supplier_bills"("company_id", "contractor_id", lower("supplier_reference"))
  WHERE "voided_at" IS NULL AND "supplier_reference" IS NOT NULL AND "contractor_id" IS NOT NULL;
CREATE UNIQUE INDEX "supplier_bills_live_supplier_reference_key" ON "supplier_bills"("company_id", lower("supplier_name"), lower("supplier_reference"))
  WHERE "voided_at" IS NULL AND "supplier_reference" IS NOT NULL AND "contractor_id" IS NULL;
CREATE INDEX "supplier_bills_company_id_job_id_idx" ON "supplier_bills"("company_id", "job_id");
CREATE INDEX "supplier_bills_company_id_contractor_id_idx" ON "supplier_bills"("company_id", "contractor_id");
CREATE INDEX "supplier_bills_company_id_offer_id_idx" ON "supplier_bills"("company_id", "offer_id");
CREATE INDEX "supplier_bills_company_id_issued_on_idx" ON "supplier_bills"("company_id", "issued_on");
CREATE INDEX "supplier_bills_company_id_created_by_idx" ON "supplier_bills"("company_id", "created_by");
CREATE UNIQUE INDEX "supplier_bill_items_bill_id_position_key" ON "supplier_bill_items"("bill_id", "position");
CREATE INDEX "supplier_bill_items_company_id_bill_id_idx" ON "supplier_bill_items"("company_id", "bill_id");
CREATE UNIQUE INDEX "supplier_payments_company_id_idempotency_key_key" ON "supplier_payments"("company_id", "idempotency_key");
CREATE UNIQUE INDEX "supplier_payments_company_id_id_key" ON "supplier_payments"("company_id", "id");
CREATE INDEX "supplier_payments_company_id_paid_on_idx" ON "supplier_payments"("company_id", "paid_on");
CREATE INDEX "supplier_payments_company_id_contractor_id_idx" ON "supplier_payments"("company_id", "contractor_id");
CREATE INDEX "supplier_payments_company_id_created_by_idx" ON "supplier_payments"("company_id", "created_by");
CREATE UNIQUE INDEX "supplier_payment_allocations_payment_id_bill_id_key" ON "supplier_payment_allocations"("payment_id", "bill_id");
CREATE INDEX "supplier_payment_allocations_company_id_bill_id_idx" ON "supplier_payment_allocations"("company_id", "bill_id");
CREATE UNIQUE INDEX "supplier_payment_gst_adjustments_payment_id_bill_id_key" ON "supplier_payment_gst_adjustments"("payment_id", "bill_id");
CREATE INDEX "supplier_payment_gst_adjustments_company_id_bill_id_idx" ON "supplier_payment_gst_adjustments"("company_id", "bill_id");

-- AddForeignKey (tenant-safe: every reference carries company_id)
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_company_id_contractor_id_fkey" FOREIGN KEY ("company_id", "contractor_id") REFERENCES "contractors"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- The acceptance must be for this very job and contractor.
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_acceptance_fkey" FOREIGN KEY ("company_id", "offer_id", "job_id", "contractor_id") REFERENCES "contractor_acceptances"("company_id", "offer_id", "job_id", "contractor_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_company_id_document_id_fkey" FOREIGN KEY ("company_id", "document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_company_id_voided_by_fkey" FOREIGN KEY ("company_id", "voided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_bill_items" ADD CONSTRAINT "supplier_bill_items_company_id_bill_id_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_company_id_contractor_id_fkey" FOREIGN KEY ("company_id", "contractor_id") REFERENCES "contractors"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_company_id_voided_by_fkey" FOREIGN KEY ("company_id", "voided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "supplier_payments"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_company_id_bill_id_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_gst_adjustments" ADD CONSTRAINT "supplier_payment_gst_adjustments_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "supplier_payments"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_gst_adjustments" ADD CONSTRAINT "supplier_payment_gst_adjustments_company_id_bill_id_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Bills are never deleted; the only change is a one-way void.
CREATE FUNCTION jobflow_guard_supplier_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bills are never deleted; void them' USING ERRCODE = '55000';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a void bill can''t change' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['void_reason', 'voided_at', 'voided_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['void_reason', 'voided_at', 'voided_by']) THEN
    RAISE EXCEPTION 'a recorded bill can''t be edited; void it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_bills_guard BEFORE UPDATE OR DELETE ON supplier_bills
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_supplier_bill();
CREATE TRIGGER supplier_bills_no_truncate BEFORE TRUNCATE ON supplier_bills
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER supplier_bill_items_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_bill_items
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

-- Payments: same one-way void; allocations never change.
CREATE FUNCTION jobflow_guard_supplier_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are never deleted; void them' USING ERRCODE = '55000';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a void payment can''t change' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['void_reason', 'voided_at', 'voided_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['void_reason', 'voided_at', 'voided_by']) THEN
    RAISE EXCEPTION 'a recorded payment can''t be edited; void it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_payments_guard BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_supplier_payment();
CREATE TRIGGER supplier_payments_no_truncate BEFORE TRUNCATE ON supplier_payments
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER supplier_payment_allocations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER supplier_payment_gst_adjustments_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_payment_gst_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
