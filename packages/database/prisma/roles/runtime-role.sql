-- Least-privilege runtime role for the web app (#71; deployment in #64).
--
-- Run as the MIGRATION owner after `prisma migrate deploy`, in the app
-- database. The app connects with a separate LOGIN role that is a member of
-- jobflow_app (password set by the operator, never committed):
--   CREATE ROLE jobflow_web LOGIN PASSWORD '...' IN ROLE jobflow_app;
-- Migrations keep using the owner's credentials; the runtime never does.
--
-- jobflow_app can read and write rows only. It cannot run DDL, disable or drop
-- triggers (not an owner), change session_replication_role (not a superuser),
-- or update/delete/truncate the append-only audit log.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobflow_app') THEN
    CREATE ROLE jobflow_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jobflow_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jobflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jobflow_app;
-- Tables created by later migrations (run by this same owner) get the same.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jobflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO jobflow_app;

-- Append-only audit: insert and read only (the trigger is a second layer).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM jobflow_app;
-- Migration bookkeeping belongs to the owner.
REVOKE ALL ON _prisma_migrations FROM jobflow_app;

-- Private maintenance channel (#170), reapplied after blanket grants.
REVOKE DELETE ON documents FROM jobflow_app;
REVOKE ALL ON document_delete_retries FROM jobflow_app;
REVOKE ALL ON FUNCTION jobflow_lock_document_for_cleanup(uuid,uuid) FROM jobflow_app;
