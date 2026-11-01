-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys bill submissions.
BEGIN;
DROP TABLE subcontractor_bill_submission_items;
DROP TABLE subcontractor_bill_submissions;
DROP FUNCTION jobflow_guard_bill_submission();
DROP FUNCTION jobflow_guard_bill_submission_item();
COMMIT;
