-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: forgets recorded late bill evidence.
BEGIN;
DROP TABLE supplier_bill_evidence;
COMMIT;
