-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys contractors, offers and acceptances.
BEGIN;
DROP TABLE contractor_acceptances;
DROP TABLE contractor_offers;
DROP FUNCTION jobflow_guard_contractor_offer();
DROP TABLE contractors;
DROP TYPE contractor_offer_status;
DROP TYPE tax_code;
DROP TYPE contractor_rate_type;
COMMIT;
