BEGIN;

-- #25 Company profile and effective-dated GST registration (docs/GST.md#company-configuration).

-- Overlap guard below needs equality on uuid inside a GiST exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "gst_accounting_basis" AS ENUM ('cash', 'non_cash');

-- CreateEnum
CREATE TYPE "bas_reporting_period" AS ENUM ('monthly', 'quarterly');

-- AlterTable: profile fields are optional until the owner completes set-up.
ALTER TABLE "companies"
    ADD COLUMN "legal_name" VARCHAR(200),
    ADD COLUMN "abn" CHAR(11),
    ADD COLUMN "address_line1" VARCHAR(200),
    ADD COLUMN "address_line2" VARCHAR(200),
    ADD COLUMN "suburb" VARCHAR(100),
    ADD COLUMN "state" VARCHAR(3),
    ADD COLUMN "postcode" CHAR(4),
    ADD COLUMN "invoice_prefix" VARCHAR(10) NOT NULL DEFAULT 'INV-',
    ADD COLUMN "job_prefix" VARCHAR(10) NOT NULL DEFAULT 'JOB-',
    ADD COLUMN "bas_period" "bas_reporting_period" NOT NULL DEFAULT 'quarterly',
    -- Digits only; the checksum is enforced by the application (packages/domain abn.ts).
    ADD CONSTRAINT "companies_abn_digits" CHECK ("abn" IS NULL OR "abn" ~ '^[0-9]{11}$'),
    ADD CONSTRAINT "companies_state_valid" CHECK ("state" IS NULL OR "state" IN ('ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA')),
    ADD CONSTRAINT "companies_postcode_digits" CHECK ("postcode" IS NULL OR "postcode" ~ '^[0-9]{4}$'),
    ADD CONSTRAINT "companies_prefixes_valid" CHECK ("invoice_prefix" ~ '^[A-Za-z0-9-]{1,10}$' AND "job_prefix" ~ '^[A-Za-z0-9-]{1,10}$');

-- CreateTable: one row per period during which the company IS registered.
-- No row covering a date means not registered on that date.
CREATE TABLE "company_gst_registrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    -- Inclusive last day; NULL = open-ended.
    "ends_on" DATE,
    "basis" "gst_accounting_basis" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "company_gst_registrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_gst_registrations_dates" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
    CONSTRAINT "company_gst_registrations_no_overlap" EXCLUDE USING gist (
        "company_id" WITH =,
        daterange("starts_on", "ends_on", '[]') WITH &&
    )
);

-- CreateIndex
CREATE INDEX "company_gst_registrations_company_id_starts_on_idx" ON "company_gst_registrations"("company_id", "starts_on");

-- CreateIndex
CREATE INDEX "company_gst_registrations_company_id_created_by_idx" ON "company_gst_registrations"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "company_gst_registrations" ADD CONSTRAINT "company_gst_registrations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_gst_registrations" ADD CONSTRAINT "company_gst_registrations_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER company_gst_registrations_touch_updated_at BEFORE UPDATE ON company_gst_registrations
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

COMMIT;
