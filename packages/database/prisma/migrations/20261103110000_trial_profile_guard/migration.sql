-- #211 (ADR 0004 D3, D4; contracts "Data model changes"): company profile
-- extras and logo, quote supplier snapshot, trial notifications, user notices,
-- trial extension requests and the commit-time read-only write guard.
-- Trial access state and the S13 backfill landed in #210.

-- PostgreSQL 12+ accepts ADD VALUE inside a transaction, but the new value
-- can't be used until that transaction commits. Nothing in this migration uses
-- it: the logo kind check names it only inside a function body, evaluated at
-- run time.
ALTER TYPE "document_kind" ADD VALUE IF NOT EXISTS 'company_logo';

BEGIN;

CREATE TYPE "trial_threshold" AS ENUM ('d7', 'd3', 'd1', 'ended');
CREATE TYPE "extension_request_status" AS ENUM ('pending', 'approved', 'declined', 'closed');

-- Company profile extras (S6). Formats are checked in Zod; the database keeps
-- lengths, the website scheme and the logo's kind and company.
ALTER TABLE "companies"
  ADD COLUMN "phone" VARCHAR(20),
  ADD COLUMN "business_email" VARCHAR(320),
  ADD COLUMN "website" VARCHAR(200),
  ADD COLUMN "about" VARCHAR(1000),
  ADD COLUMN "logo_document_id" UUID,
  ADD COLUMN "setup_checklist_dismissed_at" TIMESTAMPTZ(3);
ALTER TABLE "companies" ADD CONSTRAINT "companies_website_scheme" CHECK (
  "website" IS NULL OR "website" ~ '^https?://'
);
-- The logo must be one of this company's own documents.
ALTER TABLE "companies" ADD CONSTRAINT "companies_logo_document_fkey"
  FOREIGN KEY ("id", "logo_document_id") REFERENCES "documents"("company_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE FUNCTION jobflow_check_company_logo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.logo_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents
    WHERE id = NEW.logo_document_id AND company_id = NEW.id AND kind::text = 'company_logo'
  ) THEN
    RAISE EXCEPTION 'a company logo must be a company_logo document of the same company'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER companies_logo_kind BEFORE INSERT OR UPDATE OF logo_document_id ON companies
  FOR EACH ROW EXECUTE FUNCTION jobflow_check_company_logo();

-- S7: the supplier details shown on a sent quote. jobflow_guard_quote()
-- compares every column except the decision fields, so this is frozen once
-- the quote is sent without a change to that trigger.
ALTER TABLE "quotes" ADD COLUMN "supplier_snapshot" JSONB;

-- One row per reminder threshold sent for a company's current last day (S10).
CREATE TABLE "trial_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "trial_last_day" DATE NOT NULL,
    "threshold" "trial_threshold" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trial_notifications_company_id_trial_last_day_threshold_key"
  ON "trial_notifications"("company_id", "trial_last_day", "threshold");
ALTER TABLE "trial_notifications" ADD CONSTRAINT "trial_notifications_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- One-time notices a user has dismissed (S8 AC4, S10 AC3). company_id is null
-- for account-level notices; NULLS NOT DISTINCT keeps those unique too.
CREATE TABLE "user_notices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "company_id" UUID,
    "notice_key" VARCHAR(100) NOT NULL,
    "dismissed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_notices_user_id_company_id_notice_key_key"
  ON "user_notices"("user_id", "company_id", "notice_key") NULLS NOT DISTINCT;
ALTER TABLE "user_notices" ADD CONSTRAINT "user_notices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_notices" ADD CONSTRAINT "user_notices_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "user_notices" ADD CONSTRAINT "user_notices_key_nonempty" CHECK (btrim("notice_key") <> '');

-- Owner requests for more trial time, decided once by the operator (S14).
-- decided_by references users for now; #230 adds platform_operators and
-- retargets it there.
CREATE TABLE "trial_extension_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "message" VARCHAR(1000),
    "last_day_at_request" DATE NOT NULL,
    "status" "extension_request_status" NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "extension_days" INTEGER,
    "decision_note" VARCHAR(500),
    "new_last_day" DATE,
    "closed_reason" VARCHAR(30),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_extension_requests_pkey" PRIMARY KEY ("id")
);
-- At most one pending request per company.
CREATE UNIQUE INDEX "trial_extension_requests_one_pending"
  ON "trial_extension_requests"("company_id") WHERE "status" = 'pending';
CREATE INDEX "trial_extension_requests_status_created_at_idx"
  ON "trial_extension_requests"("status", "created_at");
CREATE INDEX "trial_extension_requests_company_id_created_at_idx"
  ON "trial_extension_requests"("company_id", "created_at");
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_requester_fkey"
  FOREIGN KEY ("company_id", "requested_by") REFERENCES "memberships"("company_id", "user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_message_nonempty" CHECK (
  "message" IS NULL OR btrim("message") <> ''
);
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_extension_days" CHECK (
  "extension_days" IS NULL OR "extension_days" BETWEEN 1 AND 365
);
-- Each status carries exactly its own decision fields. COALESCE: a CHECK
-- that evaluates to NULL passes, so an unknown (NULL) branch must fail.
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_decision" CHECK (
  COALESCE(CASE "status"
    WHEN 'pending' THEN num_nonnulls("decided_at", "decided_by", "extension_days", "decision_note",
                                     "new_last_day", "closed_reason") = 0
    WHEN 'approved' THEN "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
                     AND "extension_days" IS NOT NULL AND "new_last_day" IS NOT NULL
                     AND "closed_reason" IS NULL
    WHEN 'declined' THEN "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
                     AND "decision_note" IS NOT NULL AND btrim("decision_note") <> ''
                     AND num_nonnulls("extension_days", "new_last_day", "closed_reason") = 0
    WHEN 'closed' THEN "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL
                     AND "extension_days" IS NULL AND "closed_reason" IS NOT NULL
                     AND (("closed_reason" = 'direct_extension' AND "new_last_day" IS NOT NULL)
                       OR ("closed_reason" = 'made_unrestricted' AND "new_last_day" IS NULL))
  END, false)
);

-- A request is decided once: only pending → decided, and nothing after that.
CREATE FUNCTION jobflow_guard_trial_extension_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trial extension requests are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided trial extension request can''t change' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.company_id, NEW.requested_by, NEW.message, NEW.last_day_at_request, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.requested_by, OLD.message, OLD.last_day_at_request, OLD.created_at) THEN
    RAISE EXCEPTION 'a trial extension request''s details can''t change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trial_extension_requests_guard BEFORE UPDATE OR DELETE ON trial_extension_requests
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_trial_extension_request();
CREATE TRIGGER trial_extension_requests_no_truncate BEFORE TRUNCATE ON trial_extension_requests
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

-- ADR 0004 D4: the authoritative read-only guard. Every company business
-- write records an audit event (withAudit refuses a transaction without one),
-- so a deferred check on audit_events sees every write at commit, using the
-- database clock at that moment. A transaction may declare one exemption key
-- with set_config('jobflow.read_only_exemption', key, true) (transaction-local);
-- each key admits only the actions listed here. This map mirrors
-- READ_ONLY_EXEMPTION_ACTIONS in TypeScript (#222), and a parity test keeps
-- them equal.
CREATE FUNCTION jobflow_read_only_exemption_actions(exemption text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE exemption
    WHEN 'export' THEN ARRAY['company.exported', 'report.exported', 'report.export_refused']
    WHEN 'record_rendering' THEN ARRAY['invoice.pdf_stored']
    WHEN 'access_removal' THEN ARRAY['membership.access_updated', 'invitation.revoked']
    WHEN 'invitation_pre_expiry' THEN ARRAY['invitation.accepted']
    WHEN 'trial_extension_request' THEN ARRAY['trial_extension.requested']
    WHEN 'operator' THEN ARRAY['trial.extended', 'company.access_mode_changed',
                               'trial_extension.approved', 'trial_extension.declined']
    WHEN 'housekeeping' THEN ARRAY['document.unattached_deleted']
    ELSE ARRAY[]::text[]
  END
$$;

-- SECURITY DEFINER with a fixed search_path: it only reads the company's
-- trial state, so every writer (web or maintenance login) is checked without
-- granting it access to those columns.
CREATE FUNCTION jobflow_assert_company_writable() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  company record;
  exemption text := nullif(current_setting('jobflow.read_only_exemption', true), '');
BEGIN
  SELECT access_mode, read_only_from INTO company FROM companies WHERE id = NEW.company_id;
  IF company.access_mode IS DISTINCT FROM 'trial' OR company.read_only_from > clock_timestamp() THEN
    RETURN NULL;
  END IF;
  IF exemption IS NOT NULL AND NEW.action = ANY (jobflow_read_only_exemption_actions(exemption)) THEN
    -- access_removal admits a membership change only when it is a pure
    -- deactivation: auditChanges() lists changed keys only, so the change set
    -- must hold isActive → false and nothing else (a role change, or any
    -- field a later PATCH adds, is refused).
    IF NEW.action <> 'membership.access_updated' OR (
         (NEW.metadata -> 'changes') - 'isActive' = '{}'::jsonb
         AND NEW.metadata #>> '{changes,isActive,after}' = 'false'
       ) THEN
      RETURN NULL;
    END IF;
  END IF;
  RAISE EXCEPTION 'jobflow_company_read_only' USING ERRCODE = '55000',
    DETAIL = 'The company is read-only; this change is not allowed.';
END;
$$;
CREATE CONSTRAINT TRIGGER audit_events_company_writable AFTER INSERT ON audit_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jobflow_assert_company_writable();

COMMIT;
