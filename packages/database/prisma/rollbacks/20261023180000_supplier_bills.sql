-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys bills and payments.
BEGIN;
DROP TABLE supplier_payment_gst_adjustments;
DROP TABLE supplier_payment_allocations;
DROP TABLE supplier_payments;
DROP TABLE supplier_bill_items;
DROP TABLE supplier_bills;
DROP FUNCTION jobflow_guard_supplier_payment();
DROP FUNCTION jobflow_guard_supplier_bill();
COMMIT;
