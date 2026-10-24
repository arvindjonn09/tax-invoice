BEGIN;

-- #44 Quotes and variations. A draft is editable. Sending freezes its lines,
-- prices and the company's GST registration on the send date. The customer's
-- decision is recorded once (accepted or declined) and never changes; an
-- accepted quote is linked once to the job it created or approved. A revision
-- is a new row sharing the quote number; sending it supersedes the earlier one.

-- CreateEnum
CREATE TYPE "quote_kind" AS ENUM ('quote', 'variation');
CREATE TYPE "quote_status" AS ENUM ('draft', 'sent', 'accepted', 'declined', 'superseded');

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "kind" "quote_kind" NOT NULL DEFAULT 'quote',
    "status" "quote_status" NOT NULL DEFAULT 'draft',
    "number" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revises_id" UUID,
    "customer_id" UUID NOT NULL,
    "location_id" UUID,
    -- The job quoted for (variation, or a quote for an existing draft job), or
    -- the job created when an accepted quote is converted.
    "job_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "scope" VARCHAR(4000),
    "price_entry" "invoice_price_entry" NOT NULL DEFAULT 'exclusive',
    "valid_until" DATE,
    "notes" VARCHAR(2000),
    "gst_registered" BOOLEAN,
    "exclusive_cents" BIGINT NOT NULL DEFAULT 0,
    "gst_cents" BIGINT NOT NULL DEFAULT 0,
    "inclusive_cents" BIGINT NOT NULL DEFAULT 0,
    "estimated_cost_cents" BIGINT NOT NULL DEFAULT 0,
    "sent_on" DATE,
    "sent_at" TIMESTAMPTZ(3),
    "sent_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "decision_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quotes_title" CHECK (btrim("title") <> ''),
    CONSTRAINT "quotes_number" CHECK ("number" > 0 AND "revision" > 0),
    CONSTRAINT "quotes_revision_link" CHECK (("revision" = 1) = ("revises_id" IS NULL)),
    CONSTRAINT "quotes_variation_job" CHECK ("kind" = 'quote' OR "job_id" IS NOT NULL),
    CONSTRAINT "quotes_totals" CHECK (
      "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "exclusive_cents" >= 0 AND "gst_cents" >= 0 AND "estimated_cost_cents" >= 0
      AND "inclusive_cents" <= 1000000000000
    ),
    -- Everything but a draft carries its send snapshot.
    CONSTRAINT "quotes_sent_snapshot" CHECK (
      ("status" = 'draft') = ("sent_at" IS NULL)
      AND ("sent_at" IS NULL) = ("sent_by" IS NULL)
      AND ("sent_at" IS NULL) = ("sent_on" IS NULL)
      AND ("sent_at" IS NULL) = ("gst_registered" IS NULL)
    ),
    CONSTRAINT "quotes_decision" CHECK (
      ("status" IN ('accepted', 'declined')) = ("decided_at" IS NOT NULL)
      AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
    ),
    CONSTRAINT "quotes_unregistered_no_gst" CHECK ("gst_registered" IS NOT FALSE OR "gst_cents" = 0)
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
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
    -- Internal estimate for this line; never shown to the customer.
    "estimated_cost_cents" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quote_items_amounts" CHECK (
      "inclusive_cents" = "exclusive_cents" + "gst_cents"
      AND "unit_price_cents" BETWEEN 0 AND 1000000000000
      AND "exclusive_cents" >= 0 AND "gst_cents" >= 0
      AND "estimated_cost_cents" BETWEEN 0 AND 1000000000000
      AND "gst_rate_basis_points" BETWEEN 0 AND 10000
      AND "position" >= 0
    ),
    CONSTRAINT "quote_items_quantity" CHECK ("quantity" ~ '^[0-9]{1,9}(\.[0-9]{1,4})?$')
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_company_id_id_key" ON "quotes"("company_id", "id");
CREATE UNIQUE INDEX "quotes_company_id_number_revision_key" ON "quotes"("company_id", "number", "revision");
CREATE UNIQUE INDEX "quotes_company_id_revises_id_key" ON "quotes"("company_id", "revises_id");
CREATE INDEX "quotes_company_id_status_idx" ON "quotes"("company_id", "status");
CREATE INDEX "quotes_company_id_customer_id_idx" ON "quotes"("company_id", "customer_id");
CREATE INDEX "quotes_company_id_job_id_idx" ON "quotes"("company_id", "job_id");
CREATE INDEX "quotes_company_id_created_by_idx" ON "quotes"("company_id", "created_by");
CREATE UNIQUE INDEX "quote_items_quote_id_position_key" ON "quote_items"("quote_id", "position");
CREATE INDEX "quote_items_company_id_quote_id_idx" ON "quote_items"("company_id", "quote_id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_customer_id_location_id_fkey" FOREIGN KEY ("company_id", "customer_id", "location_id") REFERENCES "locations"("company_id", "customer_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_revises_id_fkey" FOREIGN KEY ("company_id", "revises_id") REFERENCES "quotes"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_sent_by_fkey" FOREIGN KEY ("company_id", "sent_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_decided_by_fkey" FOREIGN KEY ("company_id", "decided_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_company_id_quote_id_fkey" FOREIGN KEY ("company_id", "quote_id") REFERENCES "quotes"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER quotes_touch_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- A draft is editable and may be discarded. Once sent, only these moves are
-- allowed: sent → accepted | declined | superseded (with decision fields),
-- and an accepted quote's job link set once. Accepted/declined are final.
CREATE FUNCTION jobflow_guard_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'sent quotes are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_at', 'decided_by', 'decision_note', 'job_id', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'decided_at', 'decided_by', 'decision_note', 'job_id', 'updated_at']) THEN
    RAISE EXCEPTION 'a sent quote can''t be edited; revise it' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'sent' THEN
    IF NEW.status = 'accepted' THEN RETURN NEW; END IF;
    IF NEW.status IN ('declined', 'superseded') AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'sent'
       AND (NEW.decided_at, NEW.decided_by, NEW.decision_note, NEW.job_id)
           IS NOT DISTINCT FROM (OLD.decided_at, OLD.decided_by, OLD.decision_note, OLD.job_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a sent quote can''t be edited; revise it' USING ERRCODE = '55000';
  END IF;
  -- An accepted quote's job link is set once, nothing else.
  IF OLD.status = 'accepted' AND NEW.status = 'accepted' AND OLD.job_id IS NULL
     AND (NEW.decided_at, NEW.decided_by, NEW.decision_note)
         IS NOT DISTINCT FROM (OLD.decided_at, OLD.decided_by, OLD.decision_note) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a decided quote can''t change' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER quotes_guard BEFORE UPDATE OR DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_quote();

-- Lines change only while their quote is a draft and never move.
CREATE FUNCTION jobflow_guard_quote_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status quote_status;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    RAISE EXCEPTION 'quote lines can''t move to another quote' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO parent_status FROM quotes
    WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a sent quote can''t change' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quote_items_guard BEFORE INSERT OR UPDATE OR DELETE ON quote_items
  FOR EACH ROW EXECUTE FUNCTION jobflow_guard_quote_item();
CREATE TRIGGER quote_items_no_truncate BEFORE TRUNCATE ON quote_items
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();
CREATE TRIGGER quotes_no_truncate BEFORE TRUNCATE ON quotes
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

COMMIT;
