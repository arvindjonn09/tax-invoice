-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: removes the retention guards.
BEGIN;
DROP TRIGGER companies_retention ON companies;
DROP TRIGGER memberships_retention ON memberships;
DROP TRIGGER customers_retention ON customers;
DROP TRIGGER customer_contacts_retention ON customer_contacts;
DROP TRIGGER locations_retention ON locations;
DROP TRIGGER jobs_retention ON jobs;
DROP TRIGGER job_visits_retention ON job_visits;
DROP TRIGGER assignments_retention ON assignments;
DROP TRIGGER contractors_retention ON contractors;
DROP TRIGGER employees_retention ON employees;
DROP FUNCTION jobflow_guard_retention();
COMMIT;
