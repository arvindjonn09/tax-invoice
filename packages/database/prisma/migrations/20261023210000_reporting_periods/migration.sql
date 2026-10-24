BEGIN;
CREATE TABLE gst_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
 starts_on date NOT NULL, ends_on date NOT NULL, locked_at timestamptz(3) NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(company_id,id), CHECK(ends_on>=starts_on),
 FOREIGN KEY(company_id,created_by) REFERENCES memberships(company_id,user_id),
 EXCLUDE USING gist(company_id WITH =, daterange(starts_on,ends_on,'[]') WITH &&)
);
CREATE INDEX gst_periods_company_id_starts_on_idx ON gst_periods(company_id,starts_on);
CREATE TABLE gst_report_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, period_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), report jsonb NOT NULL, note varchar(1000) NOT NULL CHECK(btrim(note)<>''),
 created_at timestamptz(3) NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(company_id,period_id,revision), FOREIGN KEY(company_id,period_id) REFERENCES gst_periods(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES memberships(company_id,user_id)
);
CREATE TABLE gst_manual_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), period_id uuid,
 idempotency_key varchar(200) NOT NULL, request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), report_revision integer,
 effective_on date NOT NULL, g1 bigint NOT NULL DEFAULT 0, one_a bigint NOT NULL DEFAULT 0, one_b bigint NOT NULL DEFAULT 0,
 reason varchar(1000) NOT NULL CHECK(btrim(reason)<>''), created_at timestamptz(3) NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(company_id,idempotency_key),
 CHECK((period_id IS NULL)=(report_revision IS NULL)),
 CHECK(g1<>0 OR one_a<>0 OR one_b<>0),
 FOREIGN KEY(company_id,period_id) REFERENCES gst_periods(company_id,id),
 FOREIGN KEY(company_id,created_by) REFERENCES memberships(company_id,user_id)
);
CREATE INDEX gst_manual_adjustments_company_id_effective_on_idx ON gst_manual_adjustments(company_id,effective_on);
-- Original business dates remain intact. These immutable postings record the
-- open tax date chosen under the same gate as period finalisation.
CREATE TABLE gst_source_postings (
 company_id uuid NOT NULL REFERENCES companies(id), source_id uuid NOT NULL,
 original_on date NOT NULL, effective_on date NOT NULL,
 PRIMARY KEY(company_id,source_id,original_on), CHECK(effective_on>=original_on)
);
CREATE TRIGGER gst_source_postings_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON gst_source_postings FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
-- Writers share this gate; finalisation takes it exclusively before reading.
-- Finalisation never takes source-row locks, avoiding reversed row-lock order.
CREATE FUNCTION jobflow_reporting_gate(cid uuid) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock_shared(hashtextextended('jobflow-report:'||cid::text,0));
$$;
CREATE FUNCTION jobflow_assert_open_period(cid uuid, day date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM jobflow_reporting_gate(cid);
 IF EXISTS(SELECT 1 FROM gst_periods WHERE company_id=cid AND day BETWEEN starts_on AND ends_on) THEN
  RAISE EXCEPTION 'jobflow_period_locked' USING ERRCODE='55000';
 END IF;
END;
$$;
CREATE FUNCTION jobflow_record_gst_posting(cid uuid, sid uuid, day date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE posting_day date;
BEGIN
 PERFORM jobflow_reporting_gate(cid);
 posting_day:=day;
 IF EXISTS(SELECT 1 FROM gst_periods WHERE company_id=cid AND day BETWEEN starts_on AND ends_on) THEN
  posting_day:=(clock_timestamp() AT TIME ZONE 'Australia/Sydney')::date;
 END IF;
 PERFORM jobflow_assert_open_period(cid,posting_day);
 INSERT INTO gst_source_postings(company_id,source_id,original_on,effective_on)
 VALUES(cid,sid,day,posting_day) ON CONFLICT DO NOTHING;
END;
$$;
CREATE FUNCTION jobflow_guard_report_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; cid uuid; day date; parent_day date; sid uuid; settlement_day date;
BEGIN
 r:=to_jsonb(NEW); cid:=(r->>'company_id')::uuid; sid:=(r->>'id')::uuid;
 IF TG_TABLE_NAME='invoices' THEN
  IF r->>'status'='draft' THEN RETURN NEW; END IF;
  day:=CASE WHEN r->>'status'='void' THEN ((r->>'voided_at')::timestamptz AT TIME ZONE 'Australia/Sydney')::date ELSE (r->>'issue_date')::date END;
 ELSIF TG_TABLE_NAME IN ('expenses','timesheets') THEN
  IF r->>'status'<>'approved' THEN RETURN NEW; END IF;
  IF r->>'reverses_id' IS NOT NULL OR r->>'corrects_id' IS NOT NULL THEN
   day:=((r->>'decided_at')::timestamptz AT TIME ZONE 'Australia/Sydney')::date;
  ELSE day:=COALESCE((r->>'purchased_on')::date,(r->>'work_date')::date); END IF;
 ELSIF TG_TABLE_NAME IN ('supplier_bills','customer_receipts','supplier_payments') THEN
  day:=CASE WHEN r->>'voided_at' IS NOT NULL THEN ((r->>'voided_at')::timestamptz AT TIME ZONE 'Australia/Sydney')::date
    ELSE COALESCE((r->>'issued_on')::date,(r->>'received_on')::date,(r->>'paid_on')::date) END;
  -- Removing an earlier non-cash settlement must not move tax out of a
  -- finalised period. This is a correction, unlike a newly received late item.
  IF TG_OP='UPDATE' AND r->>'voided_at' IS NOT NULL THEN
   IF TG_TABLE_NAME='customer_receipts' THEN
    SELECT min(i.issue_date) INTO parent_day FROM receipt_allocations a JOIN invoices i ON i.id=a.invoice_id
     WHERE a.receipt_id=sid AND i.issue_date>(r->>'received_on')::date;
    SELECT effective_on INTO settlement_day FROM gst_source_postings WHERE company_id=cid AND source_id=sid AND original_on=(r->>'received_on')::date;
    settlement_day:=COALESCE(settlement_day,(r->>'received_on')::date);
    IF settlement_day<parent_day AND EXISTS(SELECT 1 FROM company_gst_registrations WHERE company_id=cid AND basis='non_cash' AND parent_day>=starts_on AND (ends_on IS NULL OR parent_day<=ends_on)) THEN
     PERFORM jobflow_assert_open_period(cid,settlement_day);
    END IF;
   ELSIF TG_TABLE_NAME='supplier_payments' THEN
    SELECT min(b.issued_on) INTO parent_day FROM supplier_payment_allocations a JOIN supplier_bills b ON b.id=a.bill_id
     WHERE a.payment_id=sid AND b.issued_on>(r->>'paid_on')::date;
    SELECT effective_on INTO settlement_day FROM gst_source_postings WHERE company_id=cid AND source_id=sid AND original_on=(r->>'paid_on')::date;
    settlement_day:=COALESCE(settlement_day,(r->>'paid_on')::date);
    IF settlement_day<parent_day AND EXISTS(SELECT 1 FROM company_gst_registrations WHERE company_id=cid AND basis='non_cash' AND parent_day>=starts_on AND (ends_on IS NULL OR parent_day<=ends_on)) THEN
     PERFORM jobflow_assert_open_period(cid,settlement_day);
    END IF;
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='receipt_allocations' THEN
  sid:=(r->>'receipt_id')::uuid;
  SELECT received_on INTO day FROM customer_receipts WHERE id=sid;
  PERFORM jobflow_record_gst_posting(cid,sid,day);
  SELECT effective_on INTO day FROM gst_source_postings WHERE company_id=cid AND source_id=sid AND original_on=day;
  SELECT issue_date INTO parent_day FROM invoices WHERE id=(r->>'invoice_id')::uuid;
  IF day<parent_day AND EXISTS(SELECT 1 FROM company_gst_registrations WHERE company_id=cid AND basis='non_cash' AND parent_day>=starts_on AND (ends_on IS NULL OR parent_day<=ends_on)) THEN
   PERFORM jobflow_assert_open_period(cid,parent_day);
  END IF;
 ELSIF TG_TABLE_NAME='supplier_payment_allocations' THEN
  sid:=(r->>'payment_id')::uuid;
  SELECT paid_on INTO day FROM supplier_payments WHERE id=sid;
  PERFORM jobflow_record_gst_posting(cid,sid,day);
  SELECT effective_on INTO day FROM gst_source_postings WHERE company_id=cid AND source_id=sid AND original_on=day;
  SELECT issued_on INTO parent_day FROM supplier_bills WHERE id=(r->>'bill_id')::uuid;
  IF day<parent_day AND EXISTS(SELECT 1 FROM company_gst_registrations WHERE company_id=cid AND basis='non_cash' AND parent_day>=starts_on AND (ends_on IS NULL OR parent_day<=ends_on)) THEN
   PERFORM jobflow_assert_open_period(cid,parent_day);
  END IF;
 ELSE day:=(r->>'adjusted_on')::date; sid:=COALESCE((r->>'receipt_id')::uuid,(r->>'payment_id')::uuid,sid); END IF;
 PERFORM jobflow_record_gst_posting(cid,sid,day);
 -- A paid-at-purchase expense may have a distinct cash date.
 IF TG_TABLE_NAME='expenses' AND r->>'paid_on' IS NOT NULL THEN
  PERFORM jobflow_record_gst_posting(cid,sid,(r->>'paid_on')::date);
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER invoices_reporting_period BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER expenses_reporting_period BEFORE INSERT OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER timesheets_reporting_period BEFORE INSERT OR UPDATE ON timesheets FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER supplier_bills_reporting_period BEFORE INSERT OR UPDATE ON supplier_bills FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER customer_receipts_reporting_period BEFORE INSERT OR UPDATE ON customer_receipts FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER supplier_payments_reporting_period BEFORE INSERT OR UPDATE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER receipt_allocations_reporting_period BEFORE INSERT OR UPDATE ON receipt_allocations FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER supplier_payment_allocations_reporting_period BEFORE INSERT OR UPDATE ON supplier_payment_allocations FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER receipt_gst_adjustments_reporting_period BEFORE INSERT OR UPDATE ON receipt_gst_adjustments FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();
CREATE TRIGGER supplier_payment_gst_adjustments_reporting_period BEFORE INSERT OR UPDATE ON supplier_payment_gst_adjustments FOR EACH ROW EXECUTE FUNCTION jobflow_guard_report_source();

-- Effective registration/basis coverage of closed days cannot be changed.
CREATE FUNCTION jobflow_guard_locked_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; p record; old_span daterange; new_span daterange; old_basis text; new_basis text;
BEGIN
 IF TG_OP<>'INSERT' THEN cid:=OLD.company_id; old_span:=daterange(OLD.starts_on,OLD.ends_on,'[]'); old_basis:=OLD.basis::text; END IF;
 IF TG_OP<>'DELETE' THEN cid:=NEW.company_id; new_span:=daterange(NEW.starts_on,NEW.ends_on,'[]'); new_basis:=NEW.basis::text; END IF;
 PERFORM jobflow_reporting_gate(cid);
 FOR p IN SELECT starts_on,ends_on FROM gst_periods WHERE company_id=cid LOOP
  IF (COALESCE(old_span,'empty'::daterange)*daterange(p.starts_on,p.ends_on,'[]')) IS DISTINCT FROM
     (COALESCE(new_span,'empty'::daterange)*daterange(p.starts_on,p.ends_on,'[]'))
     OR (old_basis IS DISTINCT FROM new_basis AND COALESCE(old_span,'empty'::daterange)&&daterange(p.starts_on,p.ends_on,'[]')) THEN
   RAISE EXCEPTION 'jobflow_period_locked' USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
CREATE TRIGGER company_gst_registrations_locked BEFORE INSERT OR UPDATE OR DELETE ON company_gst_registrations
 FOR EACH ROW EXECUTE FUNCTION jobflow_guard_locked_registration();
CREATE TRIGGER gst_periods_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON gst_periods FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER gst_report_revisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON gst_report_revisions FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER gst_manual_adjustments_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON gst_manual_adjustments FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
COMMIT;
