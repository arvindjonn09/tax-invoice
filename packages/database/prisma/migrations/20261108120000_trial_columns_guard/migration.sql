-- #260 (L2): a company's access mode and trial dates change only through the
-- platform operator. jobflow_app has UPDATE on companies (the profile PATCH,
-- logos, settings), so without this a future mass-assignment bug could give a
-- company free use for life. The operator's writes already declare the
-- 'operator' read-only exemption key (withAudit, ADR 0004 D4); that key is
-- transaction-local, so it never carries over to another request.
BEGIN;

CREATE FUNCTION jobflow_guard_company_trial_columns() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.access_mode, NEW.trial_started_at, NEW.trial_last_day, NEW.trial_extension_count)
       IS DISTINCT FROM (OLD.access_mode, OLD.trial_started_at, OLD.trial_last_day, OLD.trial_extension_count)
     AND nullif(current_setting('jobflow.read_only_exemption', true), '')
       IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'jobflow_trial_columns_operator_only' USING ERRCODE = '42501',
      DETAIL = 'Only the platform operator can change a company''s access mode or trial dates.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER companies_trial_columns_guard
  BEFORE UPDATE OF access_mode, trial_started_at, trial_last_day, trial_extension_count ON companies
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_company_trial_columns();

-- Every company has a mode since the #211 backfill. With no default, an
-- insert that forgets to choose one fails instead of becoming unrestricted.
ALTER TABLE companies ALTER COLUMN access_mode DROP DEFAULT;

COMMIT;
