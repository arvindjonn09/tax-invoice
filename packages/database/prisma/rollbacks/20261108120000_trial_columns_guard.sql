-- Reverses 20261108120000_trial_columns_guard: the trial columns become
-- writable by any company UPDATE again, and new companies default to
-- unrestricted.
BEGIN;
ALTER TABLE companies ALTER COLUMN access_mode SET DEFAULT 'unrestricted';
DROP TRIGGER companies_trial_columns_guard ON companies;
DROP FUNCTION jobflow_guard_company_trial_columns();
COMMIT;
