BEGIN;

-- #139 Subcontractors submit their own bills for an accepted offer. The
-- office verifies the evidence and approves, which records the supplier bill
-- once (the #46 snapshot); or rejects, saying why. A submission never shows
-- the job price or committed cost (threat model T03). Decided once; never
-- edited or deleted.

-- CreateTable
CREATE TABLE "subcontractor_bill_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "contractor_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "supplier_reference" VARCHAR(100) NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE,
    "document_id" UUID NOT NULL,
    "note" VARCHAR(500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'submitted',
    "decision_note" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "bill_id" UUID,
    "submitted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontractor_bill_submissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subcontractor_bill_submissions_status" CHECK ("status" IN ('submitted', 'approved', 'rejected')),
    CONSTRAINT "subcontractor_bill_submissions_reference" CHECK (length(btrim("supplier_reference")) > 0),
    CONSTRAINT "subcontractor_bill_submissions_due" CHECK ("due_on" IS NULL OR "due_on" >= "issued_on"),
    -- Decision fields appear together; an approval links its bill, a
    -- rejection says why.
    CONSTRAINT "subcontractor_bill_submissions_decision" CHECK (
      ("status" = 'submitted' AND "decided_at" IS NULL AND "decided_by" IS NULL AND "bill_id" IS NULL AND "decision_note" IS NULL)
      OR ("status" = 'approved' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "bill_id" IS NOT NULL)
      OR ("status" = 'rejected' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "bill_id" IS NULL AND "decision_note" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "subcontractor_bill_submission_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "tax_code" VARCHAR(20) NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,

    CONSTRAINT "subcontractor_bill_submission_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subcontractor_bill_submission_items_tax_code" CHECK ("tax_code" IN ('TAXABLE_10', 'GST_FREE', 'INPUT_TAXED', 'OUT_OF_SCOPE')),
    CONSTRAINT "subcontractor_bill_submission_items_amounts" CHECK (
      "position" > 0 AND "exclusive_cents" >= 0 AND "gst_cents" >= 0
      AND "exclusive_cents" + "gst_cents" <= 1000000000000
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "subcontractor_bill_submissions_company_id_id_key" ON "subcontractor_bill_submissions"("company_id", "id");
CREATE UNIQUE INDEX "subcontractor_bill_submissions_document_key" ON "subcontractor_bill_submissions"("company_id", "document_id");
CREATE UNIQUE INDEX "subcontractor_bill_submissions_bill_key" ON "subcontractor_bill_submissions"("company_id", "bill_id");
CREATE INDEX "subcontractor_bill_submissions_status_idx" ON "subcontractor_bill_submissions"("company_id", "status", "created_at");
CREATE INDEX "subcontractor_bill_submissions_contractor_idx" ON "subcontractor_bill_submissions"("company_id", "contractor_id", "created_at");
-- One pending submission per contractor invoice number (case-insensitive).
CREATE UNIQUE INDEX "subcontractor_bill_submissions_pending_reference_key" ON "subcontractor_bill_submissions"("company_id", "contractor_id", lower("supplier_reference")) WHERE "status" = 'submitted';
CREATE UNIQUE INDEX "subcontractor_bill_submission_items_position_key" ON "subcontractor_bill_submission_items"("submission_id", "position");

-- AddForeignKey
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_contractor_fkey" FOREIGN KEY ("company_id", "contractor_id") REFERENCES "contractors"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_acceptance_fkey" FOREIGN KEY ("company_id", "offer_id", "job_id", "contractor_id") REFERENCES "contractor_acceptances"("company_id", "offer_id", "job_id", "contractor_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_document_fkey" FOREIGN KEY ("company_id", "document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_bill_fkey" FOREIGN KEY ("company_id", "bill_id") REFERENCES "supplier_bills"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_submitter_fkey" FOREIGN KEY ("company_id", "submitted_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submissions" ADD CONSTRAINT "subcontractor_bill_submissions_decider_fkey" FOREIGN KEY ("company_id", "decided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "subcontractor_bill_submission_items" ADD CONSTRAINT "subcontractor_bill_submission_items_submission_fkey" FOREIGN KEY ("company_id", "submission_id") REFERENCES "subcontractor_bill_submissions"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Decided once: only submitted → approved/rejected, setting just the
-- decision fields. Never deleted.
CREATE FUNCTION jobflow_guard_bill_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bill submissions are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'a decided bill submission can''t change' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decision_note', 'decided_at', 'decided_by', 'bill_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'decision_note', 'decided_at', 'decided_by', 'bill_id']) THEN
    RAISE EXCEPTION 'a submitted bill can''t be edited' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER subcontractor_bill_submissions_guard BEFORE UPDATE OR DELETE ON subcontractor_bill_submissions
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_bill_submission();
CREATE TRIGGER subcontractor_bill_submissions_no_truncate BEFORE TRUNCATE ON subcontractor_bill_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
-- Lines are written with their submission; never added after a decision.
CREATE FUNCTION jobflow_guard_bill_submission_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM subcontractor_bill_submissions
    WHERE id = NEW.submission_id AND company_id = NEW.company_id AND status = 'submitted'
  ) THEN
    RAISE EXCEPTION 'lines can only be added to a waiting submission' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER subcontractor_bill_submission_items_insert_guard BEFORE INSERT ON subcontractor_bill_submission_items
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_bill_submission_item();
CREATE TRIGGER subcontractor_bill_submission_items_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON subcontractor_bill_submission_items
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
