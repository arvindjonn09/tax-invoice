BEGIN;

-- #50 Customer receipts and refunds, allocated to issued invoices.
-- Idempotent: each receipt carries its client idempotency key (unique per
-- company) and a request fingerprint, written in the same transaction as its
-- allocations — a duplicate waits on the unique index and is replayed, so a
-- crash leaves either everything or nothing (no pending state to recover).
-- Immutable once recorded; a mistake is voided (audited).

-- CreateEnum
CREATE TYPE "receipt_kind" AS ENUM ('receipt', 'refund');
CREATE TYPE "receipt_method" AS ENUM ('bank_transfer', 'card', 'cash', 'cheque', 'other');

-- CreateTable
CREATE TABLE "customer_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" "receipt_kind" NOT NULL DEFAULT 'receipt',
    "received_on" DATE NOT NULL,
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

    CONSTRAINT "customer_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_receipts_amount" CHECK ("amount_cents" > 0 AND "amount_cents" <= 1000000000000),
    CONSTRAINT "customer_receipts_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "customer_receipts_void" CHECK (
      ("voided_at" IS NULL) = ("voided_by" IS NULL)
      AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "receipt_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    -- Cash-basis GST attributed to this allocation (negative for a refund).
    "gst_attributed_cents" BIGINT NOT NULL,

    CONSTRAINT "receipt_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "receipt_allocations_amount" CHECK ("amount_cents" > 0)
);

-- CreateTable
-- Cash-basis GST correction written when a receipt or refund is voided: with
-- it, an invoice's live GST (unvoided allocations plus adjustments) is always
-- the rounded share of the money still received. Never edited; dated on the
-- void so earlier periods stay as reported.
CREATE TABLE "receipt_gst_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "adjusted_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_gst_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "receipt_gst_adjustments_nonzero" CHECK ("gst_cents" <> 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_receipts_company_id_idempotency_key_key" ON "customer_receipts"("company_id", "idempotency_key");
CREATE UNIQUE INDEX "customer_receipts_company_id_id_key" ON "customer_receipts"("company_id", "id");
CREATE INDEX "customer_receipts_company_id_customer_id_idx" ON "customer_receipts"("company_id", "customer_id");
CREATE INDEX "customer_receipts_company_id_received_on_idx" ON "customer_receipts"("company_id", "received_on");
CREATE INDEX "customer_receipts_company_id_created_by_idx" ON "customer_receipts"("company_id", "created_by");
CREATE UNIQUE INDEX "receipt_allocations_receipt_id_invoice_id_key" ON "receipt_allocations"("receipt_id", "invoice_id");
CREATE INDEX "receipt_allocations_company_id_invoice_id_idx" ON "receipt_allocations"("company_id", "invoice_id");
CREATE UNIQUE INDEX "receipt_gst_adjustments_receipt_id_invoice_id_key" ON "receipt_gst_adjustments"("receipt_id", "invoice_id");
CREATE INDEX "receipt_gst_adjustments_company_id_invoice_id_idx" ON "receipt_gst_adjustments"("company_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_company_id_voided_by_fkey" FOREIGN KEY ("company_id", "voided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_company_id_receipt_id_fkey" FOREIGN KEY ("company_id", "receipt_id") REFERENCES "customer_receipts"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "receipt_allocations" ADD CONSTRAINT "receipt_allocations_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoices"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "receipt_gst_adjustments" ADD CONSTRAINT "receipt_gst_adjustments_company_id_receipt_id_fkey" FOREIGN KEY ("company_id", "receipt_id") REFERENCES "customer_receipts"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "receipt_gst_adjustments" ADD CONSTRAINT "receipt_gst_adjustments_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoices"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Receipts are never deleted; the only change is a one-way void.
CREATE FUNCTION jobflow_guard_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipts are never deleted; void them' USING ERRCODE = '55000';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a void receipt can''t change' USING ERRCODE = '55000';
  END IF;
  IF (NEW.company_id, NEW.customer_id, NEW.kind, NEW.received_on, NEW.amount_cents, NEW.method,
      NEW.reference, NEW.idempotency_key, NEW.request_hash, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.company_id, OLD.customer_id, OLD.kind, OLD.received_on, OLD.amount_cents, OLD.method,
      OLD.reference, OLD.idempotency_key, OLD.request_hash, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a recorded receipt can''t be edited; void it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_receipts_guard BEFORE UPDATE OR DELETE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_receipt();
CREATE TRIGGER customer_receipts_no_truncate BEFORE TRUNCATE ON customer_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
-- Allocations are written with their receipt and never change.
CREATE TRIGGER receipt_allocations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON receipt_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER receipt_gst_adjustments_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON receipt_gst_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
