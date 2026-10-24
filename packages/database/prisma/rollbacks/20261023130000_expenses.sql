-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys expenses and the settlement default.
BEGIN;
DROP TABLE expenses;
DROP FUNCTION jobflow_guard_expense();
ALTER TABLE companies DROP COLUMN default_expense_settlement;
DROP TYPE expense_status;
DROP TYPE payment_method;
DROP TYPE expense_settlement;
DROP TYPE price_entry;
DROP TYPE expense_category;
COMMIT;
