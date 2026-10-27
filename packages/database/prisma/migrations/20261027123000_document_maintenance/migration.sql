BEGIN;
CREATE TABLE document_delete_retries (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
 object_key varchar(500) NOT NULL UNIQUE, attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 last_attempt_at timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(company_id,id)
);
-- FOR UPDATE needs UPDATE privilege. Keep the maintenance login's document
-- grants SELECT/DELETE only; this narrow owner-installed function locks only.
CREATE FUNCTION jobflow_lock_document_for_cleanup(cid uuid, did uuid) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT FROM public.documents WHERE company_id=cid AND id=did FOR UPDATE;
$$;
REVOKE ALL ON FUNCTION jobflow_lock_document_for_cleanup(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='jobflow_app') THEN
  REVOKE ALL ON document_delete_retries FROM jobflow_app;
  REVOKE DELETE ON documents FROM jobflow_app;
 END IF;
END $$;
COMMIT;
