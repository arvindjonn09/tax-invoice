-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys expense payment allocations.
BEGIN;
DROP TABLE supplier_payment_expense_gst_adjustments;
DROP TABLE supplier_payment_expense_allocations;
COMMIT;
