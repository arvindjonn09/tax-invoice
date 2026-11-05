-- Run as migration owner after migrations and runtime grants (#170).
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='jobflow_maintenance') THEN
  CREATE ROLE jobflow_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO jobflow_maintenance;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM jobflow_maintenance;
GRANT SELECT, DELETE ON documents TO jobflow_maintenance;
GRANT SELECT, INSERT ON audit_events TO jobflow_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_delete_retries TO jobflow_maintenance;
GRANT EXECUTE ON FUNCTION jobflow_lock_document_for_cleanup(uuid,uuid) TO jobflow_maintenance;
-- The attachment check reads only each foreign key's own columns (the
-- document column and the column paired with documents.company_id: company_id
-- in most tables, companies.id for the logo, #211), never the full
-- financial/employee record. New attachment tables are covered on deploy.
DO $$ DECLARE r record; BEGIN
 FOR r IN
  SELECT c.conrelid::regclass AS tbl, string_agg(quote_ident(a.attname), ',') AS cols
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) AS k(child)
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.child
  WHERE c.contype='f' AND c.confrelid='documents'::regclass
  GROUP BY c.oid, c.conrelid
 LOOP
  EXECUTE format('GRANT SELECT (%s) ON %s TO jobflow_maintenance',r.cols,r.tbl);
 END LOOP;
END $$;
