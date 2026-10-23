BEGIN;

-- #28 Customers, contacts and service locations. Nothing is hard-deleted:
-- archived rows are hidden from pickers but keep history for jobs/invoices.

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "abn" CHAR(11),
    "billing_email" VARCHAR(320),
    "billing_phone" VARCHAR(30),
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "suburb" VARCHAR(100),
    "state" VARCHAR(3),
    "postcode" CHAR(4),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customers_name_not_blank" CHECK (btrim("name") <> ''),
    CONSTRAINT "customers_abn_digits" CHECK ("abn" IS NULL OR "abn" ~ '^[0-9]{11}$'),
    CONSTRAINT "customers_state_valid" CHECK ("state" IS NULL OR "state" IN ('ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA')),
    CONSTRAINT "customers_postcode_digits" CHECK ("postcode" IS NULL OR "postcode" ~ '^[0-9]{4}$')
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "position" VARCHAR(100),
    "email" VARCHAR(320),
    "phone" VARCHAR(30),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_contacts_name_not_blank" CHECK (btrim("name") <> '')
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" VARCHAR(100),
    "address_line1" VARCHAR(200) NOT NULL,
    "address_line2" VARCHAR(200),
    "suburb" VARCHAR(100) NOT NULL,
    "state" VARCHAR(3) NOT NULL,
    "postcode" CHAR(4) NOT NULL,
    "access_notes" VARCHAR(500),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "locations_address_not_blank" CHECK (btrim("address_line1") <> '' AND btrim("suburb") <> ''),
    CONSTRAINT "locations_state_valid" CHECK ("state" IN ('ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA')),
    CONSTRAINT "locations_postcode_digits" CHECK ("postcode" ~ '^[0-9]{4}$')
);

-- CreateIndex: tenant-safe targets for child rows and jobs.
CREATE UNIQUE INDEX "customers_company_id_id_key" ON "customers"("company_id", "id");
CREATE UNIQUE INDEX "customer_contacts_company_id_id_key" ON "customer_contacts"("company_id", "id");
CREATE UNIQUE INDEX "locations_company_id_id_key" ON "locations"("company_id", "id");
-- Lets a job require that its location belongs to its customer (#31).
CREATE UNIQUE INDEX "locations_company_id_customer_id_id_key" ON "locations"("company_id", "customer_id", "id");

-- CreateIndex
CREATE INDEX "customers_company_id_archived_at_name_idx" ON "customers"("company_id", "archived_at", "name");
CREATE INDEX "customers_company_id_created_by_idx" ON "customers"("company_id", "created_by");
CREATE INDEX "customer_contacts_company_id_customer_id_idx" ON "customer_contacts"("company_id", "customer_id");
CREATE INDEX "customer_contacts_company_id_created_by_idx" ON "customer_contacts"("company_id", "created_by");
CREATE INDEX "locations_company_id_customer_id_idx" ON "locations"("company_id", "customer_id");
CREATE INDEX "locations_company_id_created_by_idx" ON "locations"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER customers_touch_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER customer_contacts_touch_updated_at BEFORE UPDATE ON customer_contacts
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER locations_touch_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

COMMIT;
