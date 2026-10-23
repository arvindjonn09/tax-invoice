BEGIN;

-- #30 Employee records (no payroll). An employee may be linked to a user
-- account of the SAME company; the composite FK makes a cross-tenant link
-- impossible.

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "user_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(30),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employees_name_not_blank" CHECK (btrim("name") <> '')
);

-- CreateIndex: tenant-safe target for assignments/timesheets (company_id, id).
CREATE UNIQUE INDEX "employees_company_id_id_key" ON "employees"("company_id", "id");

-- CreateIndex: one employee record per user account per company.
CREATE UNIQUE INDEX "employees_company_id_user_id_key" ON "employees"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "employees_company_id_is_active_name_idx" ON "employees"("company_id", "is_active", "name");

-- CreateIndex
CREATE INDEX "employees_company_id_created_by_idx" ON "employees"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_user_id_fkey" FOREIGN KEY ("company_id", "user_id") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TRIGGER employees_touch_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

COMMIT;
