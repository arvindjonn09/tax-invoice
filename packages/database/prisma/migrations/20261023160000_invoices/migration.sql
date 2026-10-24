BEGIN;

-- #47 Customer invoices and credit notes. A draft is editable; issuing
-- validates it, assigns the next per-company number, decides "Tax Invoice"
-- vs "Invoice" from GST registration on the issue date and freezes every
-- amount, line and party snapshot. Corrections are credit notes or a void.

-- CreateEnum
CREATE TYPE "invoice_kind" AS ENUM ('invoice', 'credit_note');
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'void');
CREATE TYPE "invoice_price_entry" AS ENUM ('exclusive', 'inclusive');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "kind" "invoice_kind" NOT NULL DEFAULT 'invoice',
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "customer_id" UUID NOT NULL,
    "job_id" UUID,
    "location_id" UUID,
    -- The invoice a credit note credits.
    "credits_id" UUID,
    "price_entry" "invoice_price_entry" NOT NULL DEFAULT 'exclusive',
    "customer_reference" VARCHAR(100),
    "notes" VARCHAR(2000),
    "due_on" DATE,
    -- Set at issue.
    "number" INTEGER,
    "reference" VARCHAR(30),
    "issue_date" DATE,
    "title" VARCHAR(20),
    "gst_registered" BOOLEAN,
    "supplier_snapshot" JSONB,
    "customer_snapshot" JSONB,
    "site_snapshot" JSONB,
    -- Sums of the rounded lines (positive; a credit note's kind negates it).
    "exclusive_cents" BIGINT NOT NULL DEFAULT 0,
    "gst_cents" BIGINT NOT NULL DEFAULT 0,
    "inclusive_cents" BIGINT NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ(3),
    "issued_by" UUID,
    "void_reason" VARCHAR(500),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoices_totals" CHECK (
      "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "exclusive_cents" >= 0 AND "gst_cents" >= 0
    ),
    CONSTRAINT "invoices_credit_note_link" CHECK (("kind" = 'credit_note') = ("credits_id" IS NOT NULL)),
    -- Issued and void documents carry their full issue snapshot; drafts none.
    CONSTRAINT "invoices_issue_snapshot" CHECK (
      ("status" = 'draft') = ("number" IS NULL)
      AND ("number" IS NULL) = ("reference" IS NULL)
      AND ("number" IS NULL) = ("issue_date" IS NULL)
      AND ("number" IS NULL) = ("title" IS NULL)
      AND ("number" IS NULL) = ("gst_registered" IS NULL)
      AND ("number" IS NULL) = ("supplier_snapshot" IS NULL)
      AND ("number" IS NULL) = ("customer_snapshot" IS NULL)
      AND ("number" IS NULL) = ("issued_at" IS NULL)
      AND ("number" IS NULL) = ("issued_by" IS NULL)
      AND ("number" IS NULL OR "number" > 0)
    ),
    CONSTRAINT "invoices_void" CHECK (
      ("status" = 'void') = ("voided_at" IS NOT NULL)
      AND ("voided_at" IS NULL) = ("voided_by" IS NULL)
      AND ("voided_at" IS NULL) = ("void_reason" IS NULL)
    ),
    CONSTRAINT "invoices_title_matches_registration" CHECK (
      "title" IS NULL
      OR ("gst_registered" AND "title" IN ('Tax Invoice', 'Adjustment Note'))
      OR (NOT "gst_registered" AND "title" IN ('Invoice', 'Credit Note'))
    ),
    -- Not registered on the issue date: no GST at all.
    CONSTRAINT "invoices_unregistered_no_gst" CHECK ("gst_registered" IS NOT FALSE OR "gst_cents" = 0)
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "quantity" VARCHAR(20) NOT NULL,
    "unit" VARCHAR(20),
    "unit_price_cents" BIGINT NOT NULL,
    "tax_code" "tax_code" NOT NULL,
    "gst_rate_basis_points" INTEGER NOT NULL,
    "exclusive_cents" BIGINT NOT NULL,
    "gst_cents" BIGINT NOT NULL,
    "inclusive_cents" BIGINT NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_items_amounts" CHECK (
      "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "unit_price_cents" BETWEEN 0 AND 1000000000000
      AND "exclusive_cents" >= 0 AND "gst_cents" >= 0
      AND "gst_rate_basis_points" BETWEEN 0 AND 10000
      AND "position" >= 0
    ),
    CONSTRAINT "invoice_items_quantity" CHECK ("quantity" ~ '^[0-9]{1,9}(\.[0-9]{1,4})?$')
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_company_id_id_key" ON "invoices"("company_id", "id");
CREATE UNIQUE INDEX "invoices_company_id_kind_number_key" ON "invoices"("company_id", "kind", "number");
CREATE INDEX "invoices_company_id_status_issue_date_idx" ON "invoices"("company_id", "status", "issue_date");
CREATE INDEX "invoices_company_id_customer_id_idx" ON "invoices"("company_id", "customer_id");
CREATE INDEX "invoices_company_id_job_id_idx" ON "invoices"("company_id", "job_id");
CREATE INDEX "invoices_company_id_credits_id_idx" ON "invoices"("company_id", "credits_id");
CREATE INDEX "invoices_company_id_created_by_idx" ON "invoices"("company_id", "created_by");
CREATE UNIQUE INDEX "invoice_items_invoice_id_position_key" ON "invoice_items"("invoice_id", "position");
CREATE INDEX "invoice_items_company_id_invoice_id_idx" ON "invoice_items"("company_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- The site must belong to the invoice's customer.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_customer_id_location_id_fkey" FOREIGN KEY ("company_id", "customer_id", "location_id") REFERENCES "locations"("company_id", "customer_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_credits_id_fkey" FOREIGN KEY ("company_id", "credits_id") REFERENCES "invoices"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_issued_by_fkey" FOREIGN KEY ("company_id", "issued_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_voided_by_fkey" FOREIGN KEY ("company_id", "voided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoices"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER invoices_touch_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- A draft may be discarded; an issued or void document is never deleted.
-- Once issued, nothing can change except a one-way void (status, void
-- fields, updated_at); a void is final.
CREATE FUNCTION jobflow_guard_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'issued invoices are never deleted; credit or void them' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'a void invoice can''t change' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'issued' AND (
    NEW.status <> 'void'
    OR (NEW.kind, NEW.customer_id, NEW.job_id, NEW.location_id, NEW.credits_id, NEW.price_entry,
        NEW.customer_reference, NEW.notes, NEW.due_on, NEW.number, NEW.reference, NEW.issue_date,
        NEW.title, NEW.gst_registered, NEW.supplier_snapshot, NEW.customer_snapshot, NEW.site_snapshot,
        NEW.exclusive_cents, NEW.gst_cents, NEW.inclusive_cents, NEW.issued_at, NEW.issued_by,
        NEW.created_by)
      IS DISTINCT FROM
       (OLD.kind, OLD.customer_id, OLD.job_id, OLD.location_id, OLD.credits_id, OLD.price_entry,
        OLD.customer_reference, OLD.notes, OLD.due_on, OLD.number, OLD.reference, OLD.issue_date,
        OLD.title, OLD.gst_registered, OLD.supplier_snapshot, OLD.customer_snapshot, OLD.site_snapshot,
        OLD.exclusive_cents, OLD.gst_cents, OLD.inclusive_cents, OLD.issued_at, OLD.issued_by,
        OLD.created_by)
  ) THEN
    RAISE EXCEPTION 'an issued invoice can''t be edited; credit or void it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_invoice();

-- Lines change only while their invoice is a draft, and never move between
-- invoices (moving one out of an issued invoice would drop a frozen line).
CREATE FUNCTION jobflow_guard_invoice_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status invoice_status;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'invoice lines can''t move to another invoice' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO parent_status FROM invoices
    WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of an issued invoice can''t change' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_invoice_item();
CREATE TRIGGER invoice_items_no_truncate BEFORE TRUNCATE ON invoice_items
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER invoices_no_truncate BEFORE TRUNCATE ON invoices
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
