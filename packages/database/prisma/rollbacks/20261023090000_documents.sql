-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: orphans stored objects.
BEGIN;
DROP TABLE documents;
DROP TYPE document_kind;
COMMIT;
