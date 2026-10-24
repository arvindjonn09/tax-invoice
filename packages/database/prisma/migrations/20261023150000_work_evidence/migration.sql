BEGIN;

-- #42 Work evidence: photos, notes and customer signatures from the workers
-- on a job, and the completion review. Evidence is append-only; photos and
-- signatures are private documents (#34) the submitter uploaded.

-- CreateEnum
CREATE TYPE "work_evidence_kind" AS ENUM ('photo', 'note', 'signature');

-- CreateTable
CREATE TABLE "work_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "visit_id" UUID,
    "kind" "work_evidence_kind" NOT NULL,
    "document_id" UUID,
    "note" VARCHAR(2000),
    "submitted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_evidence_pkey" PRIMARY KEY ("id"),
    -- A note is text only; a photo or signature is a file (with an optional caption).
    CONSTRAINT "work_evidence_shape" CHECK (
      ("kind" = 'note' AND "document_id" IS NULL AND "note" IS NOT NULL AND btrim("note") <> '')
      OR ("kind" IN ('photo', 'signature') AND "document_id" IS NOT NULL)
    )
);

-- CreateIndex: a document is evidence at most once.
CREATE UNIQUE INDEX "work_evidence_company_id_document_id_key" ON "work_evidence"("company_id", "document_id");
CREATE INDEX "work_evidence_company_id_job_id_created_at_idx" ON "work_evidence"("company_id", "job_id", "created_at");
CREATE INDEX "work_evidence_company_id_submitted_by_idx" ON "work_evidence"("company_id", "submitted_by");

-- AddForeignKey
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- The visit (if any) must belong to the same job.
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_company_id_job_id_visit_id_fkey" FOREIGN KEY ("company_id", "job_id", "visit_id") REFERENCES "job_visits"("company_id", "job_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_company_id_document_id_fkey" FOREIGN KEY ("company_id", "document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "work_evidence" ADD CONSTRAINT "work_evidence_company_id_submitted_by_fkey" FOREIGN KEY ("company_id", "submitted_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Append-only, like job status history.
CREATE TRIGGER work_evidence_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON work_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
