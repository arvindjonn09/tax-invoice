-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys employee records.
BEGIN;
DROP TABLE employees;
COMMIT;
