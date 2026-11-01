BEGIN;

-- #166: block pre-inserted posting dates from bypassing locked GST periods.
-- Only existing, owner-installed source triggers may mint GST postings.
-- Trigger invocation does not require runtime EXECUTE; revoking it also
-- prevents attaching these privileged functions to attacker-owned temp tables.
ALTER FUNCTION jobflow_guard_report_source() SECURITY DEFINER;
ALTER FUNCTION jobflow_guard_report_source() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION jobflow_guard_report_source() FROM PUBLIC;
ALTER FUNCTION jobflow_supplier_credit_posting() SECURITY DEFINER;
ALTER FUNCTION jobflow_supplier_credit_posting() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION jobflow_supplier_credit_posting() FROM PUBLIC;
ALTER FUNCTION jobflow_expense_payment_posting() SECURITY DEFINER;
ALTER FUNCTION jobflow_expense_payment_posting() SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION jobflow_expense_payment_posting() FROM PUBLIC;
ALTER FUNCTION jobflow_record_gst_posting(uuid, uuid, date) SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION jobflow_record_gst_posting(uuid, uuid, date) FROM PUBLIC;
-- Harden nested lookup paths too: temporary relations must never shadow public.
ALTER FUNCTION jobflow_assert_open_period(uuid, date) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION jobflow_reporting_gate(uuid) SET search_path = pg_catalog, public, pg_temp;

-- Upgrades must close the hole even before the deployment grant script reruns.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobflow_app') THEN
REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_events,
  job_status_events,
  employee_rate_history,
  contractor_acceptances,
  work_evidence,
  supplier_bill_items,
  receipt_allocations,
  receipt_gst_adjustments,
  supplier_payment_allocations,
  supplier_payment_gst_adjustments,
  invoice_pdfs,
  gst_source_postings,
  gst_periods,
  gst_report_revisions,
  gst_manual_adjustments,
  credit_cash_adjustments,
  supplier_credit_items,
  supplier_credit_gst_adjustments,
  supplier_payment_expense_allocations,
  supplier_payment_expense_gst_adjustments,
  subcontractor_bill_submission_items
FROM jobflow_app;
REVOKE INSERT ON gst_source_postings FROM jobflow_app;
REVOKE ALL ON FUNCTION jobflow_guard_report_source(), jobflow_supplier_credit_posting(), jobflow_expense_payment_posting(), jobflow_record_gst_posting(uuid, uuid, date) FROM jobflow_app;
 END IF;
END
$$;
COMMIT;
