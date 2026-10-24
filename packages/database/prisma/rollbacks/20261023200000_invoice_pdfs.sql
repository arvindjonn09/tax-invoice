-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: forgets stored invoice PDFs.
BEGIN;
DROP TABLE invoice_pdfs;
DROP FUNCTION jobflow_check_invoice_pdf();
COMMIT;
