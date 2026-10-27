-- #62: records are kept for their retention period before they can be deleted:
-- generally 5 years for business records and 7 years for workplace (employee)
-- records, counted from the row's last change. Issued financial records are
-- already never deleted (their own guards); this covers the remaining records.
-- Unattached uploads (documents) stay deletable for cleanup (#137); attached
-- ones are protected by the records that reference them.
BEGIN;
CREATE FUNCTION jobflow_guard_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 r jsonb := to_jsonb(OLD);
 years integer := TG_ARGV[0]::integer;
 changed timestamptz := GREATEST((r->>'created_at')::timestamptz, (r->>'updated_at')::timestamptz,
   (r->>'assigned_at')::timestamptz, (r->>'ended_at')::timestamptz);
BEGIN
 IF changed IS NULL OR changed > now() - make_interval(years => years) THEN
  RAISE EXCEPTION 'jobflow_retention_period'
   USING ERRCODE = '55000', DETAIL = format('%s rows are kept for %s years after their last change', TG_TABLE_NAME, years);
 END IF;
 RETURN OLD;
END;
$$;
CREATE TRIGGER companies_retention BEFORE DELETE ON companies FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER memberships_retention BEFORE DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER customers_retention BEFORE DELETE ON customers FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER customer_contacts_retention BEFORE DELETE ON customer_contacts FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER locations_retention BEFORE DELETE ON locations FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER jobs_retention BEFORE DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER job_visits_retention BEFORE DELETE ON job_visits FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER assignments_retention BEFORE DELETE ON assignments FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER contractors_retention BEFORE DELETE ON contractors FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(5);
CREATE TRIGGER employees_retention BEFORE DELETE ON employees FOR EACH ROW EXECUTE FUNCTION jobflow_guard_retention(7);
COMMIT;
