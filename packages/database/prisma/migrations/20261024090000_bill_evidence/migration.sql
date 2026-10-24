-- #142: late tax-invoice evidence reclassifies a bill's GST from job cost to
-- creditable GST on the day it is held (R6). Append-only; never edits the bill.
BEGIN;

-- CreateTable
CREATE TABLE "supplier_bill_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "adjusted_on" DATE NOT NULL,
    "creditable_gst_cents" BIGINT NOT NULL,
    "cash_catch_up_gst_cents" BIGINT NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_bill_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bill_evidence_company_id_bill_id_key" ON "supplier_bill_evidence"("company_id", "bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_bill_evidence_company_id_document_id_key" ON "supplier_bill_evidence"("company_id", "document_id");

-- AddForeignKey
ALTER TABLE "supplier_bill_evidence" ADD CONSTRAINT "supplier_bill_evidence_company_id_bill_id_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_bill_evidence" ADD CONSTRAINT "supplier_bill_evidence_company_id_document_id_fkey" FOREIGN KEY ("company_id", "document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "supplier_bill_evidence" ADD CONSTRAINT "supplier_bill_evidence_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;


ALTER TABLE "supplier_bill_evidence" ADD CONSTRAINT "supplier_bill_evidence_creditable_positive" CHECK ("creditable_gst_cents" > 0);
ALTER TABLE "supplier_bill_evidence" ADD CONSTRAINT "supplier_bill_evidence_catch_up_range" CHECK ("cash_catch_up_gst_cents" BETWEEN 0 AND "creditable_gst_cents");

CREATE TRIGGER supplier_bill_evidence_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON supplier_bill_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
-- Dated GST fact: a day inside a finalised period posts to the open period.
CREATE TRIGGER supplier_bill_evidence_reporting_period BEFORE INSERT ON supplier_bill_evidence
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
COMMIT;
