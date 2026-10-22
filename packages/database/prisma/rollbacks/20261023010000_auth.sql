-- Test-only reversibility proof on an empty disposable database.
-- NOT a production rollback command: destroys every session and credential.
BEGIN;
DROP TABLE auth_sessions;
DROP TABLE auth_accounts;
DROP TABLE auth_verifications;
DROP TABLE auth_rate_limits;
ALTER TABLE users DROP COLUMN email_verified, DROP COLUMN image;
COMMIT;
