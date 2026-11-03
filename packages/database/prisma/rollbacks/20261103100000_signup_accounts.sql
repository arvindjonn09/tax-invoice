-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: forgets accounts' tokens, terms
-- acceptances, queued email, platform audit and trial state.
BEGIN;
DROP TABLE platform_audit_events;
DROP TABLE email_suppressions;
DROP TABLE email_outbox;
DROP TABLE terms_acceptances;
DROP TABLE account_tokens;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor;
ALTER TABLE audit_events ALTER COLUMN created_by SET NOT NULL, DROP COLUMN actor_kind;
DROP TRIGGER companies_read_only_from ON companies;
DROP FUNCTION jobflow_company_read_only_from();
ALTER TABLE companies
  DROP CONSTRAINT companies_demo_unrestricted,
  DROP CONSTRAINT companies_trial_fields,
  DROP CONSTRAINT companies_trial_extension_count_non_negative,
  DROP CONSTRAINT companies_self_service_key_with_owner,
  DROP CONSTRAINT companies_self_service_owner_id_fkey,
  DROP COLUMN access_mode,
  DROP COLUMN trial_started_at,
  DROP COLUMN trial_last_day,
  DROP COLUMN read_only_from,
  DROP COLUMN trial_extension_count,
  DROP COLUMN self_service_owner_id,
  DROP COLUMN self_service_request_key;
DROP TYPE email_status;
DROP TYPE platform_actor_kind;
DROP TYPE audit_actor_kind;
DROP TYPE account_token_purpose;
DROP TYPE company_access_mode;
COMMIT;
