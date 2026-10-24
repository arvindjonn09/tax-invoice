BEGIN;

-- #48 The PDF of an issued invoice or credit note, stored privately (#34) as
-- a document, once. Rendering is deterministic from the frozen issue
-- snapshot; the stored bytes and their SHA-256 never change afterwards.

-- CreateTable
CREATE TABLE "invoice_pdfs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "renderer_version" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "invoice_pdfs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_pdfs_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_pdfs_company_id_invoice_id_key" ON "invoice_pdfs"("company_id", "invoice_id");
CREATE UNIQUE INDEX "invoice_pdfs_company_id_document_id_key" ON "invoice_pdfs"("company_id", "document_id");
CREATE INDEX "invoice_pdfs_company_id_created_by_idx" ON "invoice_pdfs"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "invoice_pdfs" ADD CONSTRAINT "invoice_pdfs_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoices"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoice_pdfs" ADD CONSTRAINT "invoice_pdfs_company_id_document_id_fkey" FOREIGN KEY ("company_id", "document_id") REFERENCES "documents"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoice_pdfs" ADD CONSTRAINT "invoice_pdfs_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Only an issued (or later voided) document has a PDF.
CREATE FUNCTION jobflow_check_invoice_pdf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM invoices WHERE id = NEW.invoice_id) = 'draft' THEN
    RAISE EXCEPTION 'a draft has no stored PDF' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_pdfs_issued_only BEFORE INSERT ON invoice_pdfs
  FOR EACH ROW EXECUTE FUNCTION jobflow_check_invoice_pdf();
CREATE TRIGGER invoice_pdfs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON invoice_pdfs
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
