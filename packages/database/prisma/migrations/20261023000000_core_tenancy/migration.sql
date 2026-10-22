BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('owner', 'manager', 'accountant', 'employee', 'subcontractor');

-- CreateEnum
CREATE TYPE "idempotency_state" AS ENUM ('pending', 'completed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "membership_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(100) NOT NULL,
    "target_id" VARCHAR(200) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "state" "idempotency_state" NOT NULL DEFAULT 'pending',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_created_by_idx" ON "users"("created_by");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_company_id_created_by_idx" ON "memberships"("company_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_company_id_user_id_key" ON "memberships"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_events_company_id_created_at_id_idx" ON "audit_events"("company_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "audit_events_company_id_target_type_target_id_idx" ON "audit_events"("company_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_events_company_id_created_by_idx" ON "audit_events"("company_id", "created_by");

-- CreateIndex
CREATE INDEX "idempotency_keys_company_id_created_by_idx" ON "idempotency_keys"("company_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_company_id_key_key" ON "idempotency_keys"("company_id", "key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_id_created_by_fkey" FOREIGN KEY ("id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_created_by_fkey" FOREIGN KEY ("company_id", "created_by") REFERENCES "memberships"("company_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The first owner's membership is inserted in the same transaction as its company.
ALTER TABLE companies ALTER CONSTRAINT companies_id_created_by_fkey
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE users ADD CONSTRAINT users_email_normalized CHECK
  (email = lower(btrim(email)) AND email <> '' AND email !~ '[[:space:]]');
ALTER TABLE companies ADD CONSTRAINT companies_name_nonempty CHECK (btrim(name) <> '');
ALTER TABLE audit_events ADD CONSTRAINT audit_events_labels_nonempty CHECK
  (btrim(action) <> '' AND btrim(target_type) <> '' AND btrim(target_id) <> '');
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_key_nonempty CHECK (btrim(key) <> '');
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_hash_sha256 CHECK (request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_outcome CHECK (
  (state = 'pending' AND response_status IS NULL AND response_body IS NULL)
  OR (state = 'completed' AND response_status IS NOT NULL
      AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL)
);

-- Cover SQL writers as well as Prisma's @updatedAt behavior.
CREATE FUNCTION jobflow_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER companies_touch_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER memberships_touch_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();
CREATE TRIGGER idempotency_keys_touch_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION jobflow_touch_updated_at();

-- Statement-level guards reject destructive operations even when no rows match.
CREATE FUNCTION jobflow_reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_audit_mutation();

COMMIT;
