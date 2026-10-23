-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys assignment history.
BEGIN;
DROP TABLE assignments;
DROP INDEX job_visits_company_id_job_id_id_key;
COMMIT;
