BEGIN;

-- #32 Job assignments: employees assigned to a whole job or to one of its
-- visits. Ended (never deleted) when unassigned, so history stays.

-- A visit can be referenced together with its job, so an assignment's visit
-- must belong to the assignment's job.
CREATE UNIQUE INDEX "job_visits_company_id_job_id_id_key" ON "job_visits"("company_id", "job_id", "id");

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "visit_id" UUID,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" UUID,
    "created_by" UUID NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assignments_end_consistent" CHECK (("ended_at" IS NULL) = ("ended_by" IS NULL)),
    CONSTRAINT "assignments_end_after_start" CHECK ("ended_at" IS NULL OR "ended_at" >= "assigned_at")
);

-- One live assignment per employee per job (whole job) or per visit.
CREATE UNIQUE INDEX "assignments_live_job_key" ON "assignments"("company_id", "job_id", "employee_id")
  WHERE "visit_id" IS NULL AND "ended_at" IS NULL;
CREATE UNIQUE INDEX "assignments_live_visit_key" ON "assignments"("company_id", "visit_id", "employee_id")
  WHERE "visit_id" IS NOT NULL AND "ended_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "assignments_company_id_id_key" ON "assignments"("company_id", "id");
CREATE INDEX "assignments_company_id_employee_id_ended_at_idx" ON "assignments"("company_id", "employee_id", "ended_at");
CREATE INDEX "assignments_company_id_job_id_idx" ON "assignments"("company_id", "job_id");
CREATE INDEX "assignments_company_id_created_by_idx" ON "assignments"("company_id", "created_by");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_id_job_id_fkey" FOREIGN KEY ("company_id", "job_id") REFERENCES "jobs"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employees"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_id_job_id_visit_id_fkey" FOREIGN KEY ("company_id", "job_id", "visit_id") REFERENCES "job_visits"("company_id", "job_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_company_id_ended_by_fkey" FOREIGN KEY ("company_id", "ended_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
