-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys money received.
BEGIN;
DROP TABLE receipt_allocations;
DROP TABLE customer_receipts;
DROP FUNCTION jobflow_guard_receipt();
DROP TYPE receipt_method;
DROP TYPE receipt_kind;
COMMIT;
