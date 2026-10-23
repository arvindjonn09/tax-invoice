-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys jobs and their history.
BEGIN;
DROP TABLE job_visits;
DROP TABLE job_status_events;
DROP FUNCTION jobflow_reject_history_mutation();
DROP TABLE jobs;
DROP TABLE number_sequences;
DROP TYPE job_visit_status;
DROP TYPE job_status;
COMMIT;
