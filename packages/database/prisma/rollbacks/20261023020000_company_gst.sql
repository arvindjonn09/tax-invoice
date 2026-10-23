-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys GST registration history.
BEGIN;
DROP TABLE company_gst_registrations;
ALTER TABLE companies
    DROP COLUMN legal_name,
    DROP COLUMN abn,
    DROP COLUMN address_line1,
    DROP COLUMN address_line2,
    DROP COLUMN suburb,
    DROP COLUMN state,
    DROP COLUMN postcode,
    DROP COLUMN invoice_prefix,
    DROP COLUMN job_prefix,
    DROP COLUMN bas_period;
DROP TYPE bas_reporting_period;
DROP TYPE gst_accounting_basis;
COMMIT;
