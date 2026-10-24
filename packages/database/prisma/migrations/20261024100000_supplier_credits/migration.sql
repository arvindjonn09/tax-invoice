BEGIN;

-- #140 Supplier credit notes (adjustment notes) against bills. A credit is
-- its own document linked to one bill in the same company. It snapshots, once,
-- how much it takes off the bill's claimable GST (for the purchaser an
-- increasing adjustment, s19-80: credit paid back), non-creditable GST and
-- job cost, at the bill's own creditable share. The application never
-- credits beyond what is still owing. Cash-basis attribution is re-based on
-- the net bill with append-only, dated corrections, as payment voids do.
-- Immutable except a one-way, audited void.

-- CreateTable
CREATE TABLE "supplier_credits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "supplier_reference" VARCHAR(100),
    "issued_on" DATE NOT NULL,
    -- When the note was received (became known); adjustments are attributed
    -- to the later of this and the issue date.
    "received_on" DATE NOT NULL,
    "document_id" UUID,
    "evidence_verified" BOOLEAN NOT NULL DEFAULT false,
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

    CONSTRAINT "supplier_credits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_credits_received" CHECK ("received_on" >= "issued_on"),
    CONSTRAINT "supplier_credits_evidence" CHECK (NOT "evidence_verified" OR "document_id" IS NOT NULL),
    CONSTRAINT "supplier_credits_amounts" CHECK (
      "exclusive_cents" >= 0 AND "gst_cents" >= 0 AND "inclusive_cents" > 0
      AND "inclusive_cents" <= 1000000000000
      AND "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "creditable_gst_cents" >= 0 AND "non_creditable_gst_cents" >= 0
      AND "gst_cents" = "creditable_gst_cents" + "non_creditable_gst_cents"
      AND "job_cost_cents" = "exclusive_cents" + "non_creditable_gst_cents"
    ),
    CONSTRAINT "supplier_credits_void" CHECK (
      ("voided_at" IS NULL) = ("voided_by" IS NULL)
      AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "supplier_credit_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "credit_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "tax_code" "tax_code" NOT NULL,
    "gst_rate_basis_points" INTEGER NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "inclusive_cents" BIGINT NOT NULL,

    CONSTRAINT "supplier_credit_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_credit_items_description" CHECK (btrim("description") <> ''),
    CONSTRAINT "supplier_credit_items_position" CHECK ("position" BETWEEN 1 AND 100),
    CONSTRAINT "supplier_credit_items_rate" CHECK (
      ("tax_code" = 'TAXABLE_10' AND "gst_rate_basis_points" = 1000)
      OR ("tax_code" <> 'TAXABLE_10' AND "gst_rate_basis_points" = 0 AND "gst_cents" = 0)
    ),
    CONSTRAINT "supplier_credit_items_amounts" CHECK (
      "exclusive_cents" >= 0 AND "gst_cents" >= 0
      AND "inclusive_cents" = "exclusive_cents" + "gst_cents"
    )
);

-- CreateTable
CREATE TABLE "supplier_credit_gst_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "credit_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "event" VARCHAR(10) NOT NULL,
    "creditable_gst_cents" BIGINT NOT NULL,
    "adjusted_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_credit_gst_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_credit_gst_adjustments_event" CHECK ("event" IN ('recorded', 'voided')),
    CONSTRAINT "supplier_credit_gst_adjustments_nonzero" CHECK ("creditable_gst_cents" <> 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credits_company_id_id_key" ON "supplier_credits"("company_id", "id");
CREATE UNIQUE INDEX "supplier_credits_company_id_id_bill_id_key" ON "supplier_credits"("company_id", "id", "bill_id");
CREATE UNIQUE INDEX "supplier_credits_company_id_document_id_key" ON "supplier_credits"("company_id", "document_id");
-- One live credit per supplier note reference on a bill, so a double-submit
-- can't record the same note twice. Voided credits free the reference.
CREATE UNIQUE INDEX "supplier_credits_live_reference_key" ON "supplier_credits"("company_id", "bill_id", lower("supplier_reference"))
  WHERE "voided_at" IS NULL AND "supplier_reference" IS NOT NULL;
CREATE INDEX "supplier_credits_company_id_bill_id_idx" ON "supplier_credits"("company_id", "bill_id");
CREATE INDEX "supplier_credits_company_id_issued_on_idx" ON "supplier_credits"("company_id", "issued_on");
CREATE INDEX "supplier_credits_company_id_created_by_idx" ON "supplier_credits"("company_id", "created_by");
CREATE UNIQUE INDEX "supplier_credit_items_credit_id_position_key" ON "supplier_credit_items"("credit_id", "position");
CREATE INDEX "supplier_credit_items_company_id_credit_id_idx" ON "supplier_credit_items"("company_id", "credit_id");
CREATE UNIQUE INDEX "supplier_credit_gst_adjustments_credit_id_event_key" ON "supplier_credit_gst_adjustments"("credit_id", "event");
CREATE INDEX "supplier_credit_gst_adjustments_company_id_bill_id_idx" ON "supplier_credit_gst_adjustments"("company_id", "bill_id");

-- AddForeignKey (tenant-safe: every reference carries company_id)
ALTER TABLE "supplier_credits" ADD CONSTRAINT "supplier_credits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_credits" ADD CONSTRAINT "supplier_credits_company_id_bill_id_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_credits" ADD CONSTRAINT "supplier_credits_company_id_document_id_fkey" FOREIGN KEY ("company_id", "document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_credits" ADD CONSTRAINT "supplier_credits_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_credits" ADD CONSTRAINT "supplier_credits_company_id_voided_by_fkey" FOREIGN KEY ("company_id", "voided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_credit_items" ADD CONSTRAINT "supplier_credit_items_company_id_credit_id_fkey" FOREIGN KEY ("company_id", "credit_id") REFERENCES "supplier_credits"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Same credit, same bill: a correction can never land on another bill.
ALTER TABLE "supplier_credit_gst_adjustments" ADD CONSTRAINT "supplier_credit_gst_adjustments_credit_fkey" FOREIGN KEY ("company_id", "credit_id", "bill_id") REFERENCES "supplier_credits"("company_id", "id", "bill_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_credit_gst_adjustments" ADD CONSTRAINT "supplier_credit_gst_adjustments_company_id_bill_id_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Credits are never deleted; the only change is a one-way void.
CREATE FUNCTION jobflow_guard_supplier_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credits are never deleted; void them' USING ERRCODE = '55000';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a void credit can''t change' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['void_reason', 'voided_at', 'voided_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['void_reason', 'voided_at', 'voided_by']) THEN
    RAISE EXCEPTION 'a recorded credit can''t be edited; void it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_credits_guard BEFORE UPDATE OR DELETE ON supplier_credits
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_supplier_credit();
CREATE TRIGGER supplier_credits_no_truncate BEFORE TRUNCATE ON supplier_credits
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER supplier_credit_items_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_credit_items
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER supplier_credit_gst_adjustments_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_credit_gst_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
