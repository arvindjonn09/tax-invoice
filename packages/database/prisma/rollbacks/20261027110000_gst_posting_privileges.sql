BEGIN;
-- Disposable-database rollback only: restores the insecure pre-#166 grants.
ALTER FUNCTION jobflow_guard_report_source() SECURITY INVOKER;
ALTER FUNCTION jobflow_guard_report_source() RESET search_path;
GRANT EXECUTE ON FUNCTION jobflow_guard_report_source() TO PUBLIC;
ALTER FUNCTION jobflow_supplier_credit_posting() SECURITY INVOKER;
ALTER FUNCTION jobflow_supplier_credit_posting() RESET search_path;
GRANT EXECUTE ON FUNCTION jobflow_supplier_credit_posting() TO PUBLIC;
ALTER FUNCTION jobflow_expense_payment_posting() SECURITY INVOKER;
ALTER FUNCTION jobflow_expense_payment_posting() RESET search_path;
GRANT EXECUTE ON FUNCTION jobflow_expense_payment_posting() TO PUBLIC;
ALTER FUNCTION jobflow_record_gst_posting(uuid, uuid, date) RESET search_path;
GRANT EXECUTE ON FUNCTION jobflow_record_gst_posting(uuid, uuid, date) TO PUBLIC;
ALTER FUNCTION jobflow_assert_open_period(uuid, date) RESET search_path;
ALTER FUNCTION jobflow_reporting_gate(uuid) RESET search_path;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobflow_app') THEN
GRANT UPDATE, DELETE ON job_status_events, employee_rate_history, contractor_acceptances, work_evidence, supplier_bill_items, receipt_allocations, receipt_gst_adjustments, supplier_payment_allocations, supplier_payment_gst_adjustments, invoice_pdfs, gst_source_postings, gst_periods, gst_report_revisions, gst_manual_adjustments, credit_cash_adjustments, supplier_credit_items, supplier_credit_gst_adjustments, supplier_payment_expense_allocations, supplier_payment_expense_gst_adjustments, subcontractor_bill_submission_items TO jobflow_app;
GRANT INSERT ON gst_source_postings TO jobflow_app;
 END IF;
END $$;
COMMIT;
