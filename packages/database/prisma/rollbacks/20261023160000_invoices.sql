-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys issued invoices.
BEGIN;
DROP TABLE invoice_items;
DROP TABLE invoices;
DROP FUNCTION jobflow_guard_invoice_item();
DROP FUNCTION jobflow_guard_invoice();
DROP TYPE invoice_price_entry;
DROP TYPE invoice_status;
DROP TYPE invoice_kind;
COMMIT;
