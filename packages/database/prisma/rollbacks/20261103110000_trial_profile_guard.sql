-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: forgets profile extras, logos, quote
-- snapshots, reminders, notices and extension requests. The company_logo
-- enum value can't be removed in PostgreSQL and stays (unused).
BEGIN;
DROP TRIGGER audit_events_company_writable ON audit_events;
DROP FUNCTION jobflow_assert_company_writable();
DROP FUNCTION jobflow_read_only_exemption_actions(text);
DROP TABLE trial_extension_requests;
DROP FUNCTION jobflow_guard_trial_extension_request();
DROP TABLE user_notices;
DROP TABLE trial_notifications;
ALTER TABLE quotes DROP COLUMN supplier_snapshot;
DROP TRIGGER companies_logo_kind ON companies;
DROP FUNCTION jobflow_check_company_logo();
ALTER TABLE companies
  DROP CONSTRAINT companies_logo_document_fkey,
  DROP CONSTRAINT companies_website_scheme,
  DROP COLUMN phone,
  DROP COLUMN business_email,
  DROP COLUMN website,
  DROP COLUMN about,
  DROP COLUMN logo_document_id,
  DROP COLUMN setup_checklist_dismissed_at;
DROP TYPE extension_request_status;
DROP TYPE trial_threshold;
COMMIT;
