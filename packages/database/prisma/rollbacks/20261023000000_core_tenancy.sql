-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys every tenancy record.
BEGIN;
ALTER TABLE companies DROP CONSTRAINT companies_id_created_by_fkey;
DROP TABLE audit_events;
DROP TABLE idempotency_keys;
DROP TABLE memberships;
DROP TABLE companies;
DROP TABLE users;
DROP FUNCTION jobflow_reject_audit_mutation();
DROP FUNCTION jobflow_guard_membership_self_creation();
DROP FUNCTION jobflow_touch_updated_at();
DROP TYPE idempotency_state;
DROP TYPE membership_role;
COMMIT;
