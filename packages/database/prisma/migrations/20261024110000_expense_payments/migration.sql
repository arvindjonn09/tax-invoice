BEGIN;

-- #141 Supplier payments settle approved on-account expenses as well as
-- bills, with the same rules: idempotent payments, no overpayment, cash-basis
-- input tax credit attributed on payment and corrected (append-only) when a
-- payment is voided. Payment rows are shared; these are its expense lines.

-- CreateTable
CREATE TABLE "supplier_payment_expense_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "creditable_gst_attributed_cents" BIGINT NOT NULL,

    CONSTRAINT "supplier_payment_expense_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_payment_expense_allocations_amount" CHECK ("amount_cents" > 0 AND "amount_cents" <= 1000000000000)
);

-- CreateTable
CREATE TABLE "supplier_payment_expense_gst_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "creditable_gst_cents" BIGINT NOT NULL,
    "adjusted_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_expense_gst_adjustments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_payment_expense_gst_adjustments_nonzero" CHECK ("creditable_gst_cents" <> 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_expense_allocations_payment_id_expense_id_key" ON "supplier_payment_expense_allocations"("payment_id", "expense_id");
CREATE INDEX "supplier_payment_expense_allocations_company_id_expense_id_idx" ON "supplier_payment_expense_allocations"("company_id", "expense_id");
CREATE UNIQUE INDEX "supplier_payment_expense_gst_adj_payment_expense_key" ON "supplier_payment_expense_gst_adjustments"("payment_id", "expense_id");
CREATE INDEX "supplier_payment_expense_gst_adj_company_expense_idx" ON "supplier_payment_expense_gst_adjustments"("company_id", "expense_id");

-- AddForeignKey (tenant-safe: every reference carries company_id)
ALTER TABLE "supplier_payment_expense_allocations" ADD CONSTRAINT "supplier_payment_expense_allocations_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "supplier_payments"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_expense_allocations" ADD CONSTRAINT "supplier_payment_expense_allocations_company_id_expense_id_fkey" FOREIGN KEY ("company_id", "expense_id") REFERENCES "expenses"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_expense_gst_adjustments" ADD CONSTRAINT "supplier_payment_expense_gst_adj_payment_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "supplier_payments"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_payment_expense_gst_adjustments" ADD CONSTRAINT "supplier_payment_expense_gst_adj_expense_fkey" FOREIGN KEY ("company_id", "expense_id") REFERENCES "expenses"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER supplier_payment_expense_allocations_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_payment_expense_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER supplier_payment_expense_gst_adjustments_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_payment_expense_gst_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();


-- Reporting periods (#54): payments to on-account expenses and their void
-- corrections are cash-basis GST sources. Record their posting date like a
-- bill payment's, so a late one never changes a finalised period. Own
-- function, so the reporting migration stays reversible.
CREATE FUNCTION jobflow_expense_payment_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE day date;
BEGIN
  IF TG_TABLE_NAME = 'supplier_payment_expense_allocations' THEN
    SELECT paid_on INTO day FROM supplier_payments
      WHERE id = NEW.payment_id AND company_id = NEW.company_id;
  ELSE
    day := NEW.adjusted_on;
  END IF;
  PERFORM jobflow_record_gst_posting(NEW.company_id, NEW.payment_id, day);
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_payment_expense_allocations_reporting_period BEFORE INSERT ON supplier_payment_expense_allocations
  FOR EACH ROW EXECUTE FUNCTION jobflow_expense_payment_posting();
CREATE TRIGGER supplier_payment_expense_gst_adjustments_reporting_period BEFORE INSERT ON supplier_payment_expense_gst_adjustments
  FOR EACH ROW EXECUTE FUNCTION jobflow_expense_payment_posting();

COMMIT;
