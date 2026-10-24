-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys supplier credits.
BEGIN;
DROP TABLE supplier_credit_gst_adjustments;
DROP TABLE supplier_credit_items;
DROP TABLE supplier_credits;
DROP FUNCTION jobflow_guard_supplier_credit();
DROP FUNCTION jobflow_supplier_credit_posting();
COMMIT;
