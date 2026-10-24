-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys timesheets and rate history.
BEGIN;
DROP TABLE timesheets;
DROP FUNCTION jobflow_guard_timesheet();
DROP TABLE employee_rate_history;
DROP TYPE timesheet_status;
COMMIT;
