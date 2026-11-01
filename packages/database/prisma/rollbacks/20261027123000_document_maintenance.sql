BEGIN;
DROP FUNCTION jobflow_lock_document_for_cleanup(uuid,uuid);
DROP TABLE document_delete_retries;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='jobflow_app') THEN
  GRANT DELETE ON documents TO jobflow_app;
 END IF;
END $$;
COMMIT;
