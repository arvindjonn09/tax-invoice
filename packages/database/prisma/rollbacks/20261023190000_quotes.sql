-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys quotes.
BEGIN;
DROP TABLE quote_items;
DROP TABLE quotes;
DROP FUNCTION jobflow_guard_quote_item();
DROP FUNCTION jobflow_guard_quote();
DROP TYPE quote_status;
DROP TYPE quote_kind;
COMMIT;
