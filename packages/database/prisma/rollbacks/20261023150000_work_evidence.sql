-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys work evidence.
BEGIN;
DROP TABLE work_evidence;
DROP TYPE work_evidence_kind;
COMMIT;
