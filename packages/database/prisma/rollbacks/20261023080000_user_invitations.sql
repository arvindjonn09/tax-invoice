-- Test-only on an empty disposable database; destroys invitation history.
BEGIN;
DROP TABLE user_invitations;
COMMIT;
