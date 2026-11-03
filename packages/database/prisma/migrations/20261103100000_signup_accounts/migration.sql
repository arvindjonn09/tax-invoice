-- #210 (ADR 0004 D1, D2, D7): public sign-up accounts, email outbox,
-- platform audit, actor-aware company audit and trial access state (#211).
-- Existing companies become `unrestricted` (S13) with one system audit event each.
BEGIN;

CREATE TYPE "company_access_mode" AS ENUM ('unrestricted', 'trial');
CREATE TYPE "account_token_purpose" AS ENUM ('email_verification', 'password_reset');
CREATE TYPE "audit_actor_kind" AS ENUM ('member', 'operator', 'system');
CREATE TYPE "platform_actor_kind" AS ENUM ('anonymous', 'user', 'operator', 'system');
CREATE TYPE "email_status" AS ENUM ('pending', 'sending', 'sent', 'failed', 'cancelled');

-- Company access state. read_only_from is derived by trigger, never written by the app.
ALTER TABLE "companies"
  ADD COLUMN "access_mode" "company_access_mode" NOT NULL DEFAULT 'unrestricted',
  ADD COLUMN "trial_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "trial_last_day" DATE,
  ADD COLUMN "read_only_from" TIMESTAMPTZ(3),
  ADD COLUMN "trial_extension_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "self_service_owner_id" UUID,
  ADD COLUMN "self_service_request_key" VARCHAR(100);

CREATE UNIQUE INDEX "companies_self_service_owner_id_key" ON "companies"("self_service_owner_id");
CREATE INDEX "companies_access_mode_read_only_from_idx" ON "companies"("access_mode", "read_only_from");
ALTER TABLE "companies" ADD CONSTRAINT "companies_self_service_owner_id_fkey" FOREIGN KEY ("self_service_owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "companies" ADD CONSTRAINT "companies_demo_unrestricted" CHECK (NOT "is_demo" OR "access_mode" = 'unrestricted');
ALTER TABLE "companies" ADD CONSTRAINT "companies_trial_fields" CHECK (
  "access_mode" <> 'trial'
  OR ("trial_started_at" IS NOT NULL AND "trial_last_day" IS NOT NULL AND "read_only_from" IS NOT NULL)
);
ALTER TABLE "companies" ADD CONSTRAINT "companies_trial_extension_count_non_negative" CHECK ("trial_extension_count" >= 0);
ALTER TABLE "companies" ADD CONSTRAINT "companies_self_service_key_with_owner" CHECK (
  "self_service_request_key" IS NULL OR "self_service_owner_id" IS NOT NULL
);

-- The trial ends at midnight Sydney time after its last day (DST-safe in the database).
CREATE FUNCTION jobflow_company_read_only_from() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.read_only_from := CASE
    WHEN NEW.trial_last_day IS NULL THEN NULL
    ELSE ((NEW.trial_last_day + 1)::timestamp AT TIME ZONE 'Australia/Sydney')
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER companies_read_only_from BEFORE INSERT OR UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION jobflow_company_read_only_from();

-- Company audit events may now be recorded by the system (and later an operator).
ALTER TABLE "audit_events"
  ADD COLUMN "actor_kind" "audit_actor_kind" NOT NULL DEFAULT 'member',
  ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor" CHECK (
  ("actor_kind" = 'member' AND "created_by" IS NOT NULL)
  OR ("actor_kind" <> 'member' AND "created_by" IS NULL)
);

CREATE TABLE "account_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" "account_token_purpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_tokens_token_hash_key" ON "account_tokens"("token_hash");
CREATE INDEX "account_tokens_user_id_purpose_created_at_idx" ON "account_tokens"("user_id", "purpose", "created_at");
-- At most one live token per user and purpose.
CREATE UNIQUE INDEX "account_tokens_one_live" ON "account_tokens"("user_id", "purpose")
  WHERE "consumed_at" IS NULL AND "superseded_at" IS NULL;
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_token_hash_hex" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

CREATE TABLE "terms_acceptances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "terms_version" VARCHAR(40) NOT NULL,
    "privacy_version" VARCHAR(40) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "terms_acceptances_user_id_idx" ON "terms_acceptances"("user_id");
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE TRIGGER terms_acceptances_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON terms_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" VARCHAR(50) NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "user_id" UUID,
    "company_id" UUID,
    "payload_ciphertext" BYTEA,
    "status" "email_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "provider_message_id" VARCHAR(200),
    "last_error" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_outbox_dedupe_key_key" ON "email_outbox"("dedupe_key");
CREATE INDEX "email_outbox_status_next_attempt_at_idx" ON "email_outbox"("status", "next_attempt_at");
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_payload_cleared" CHECK (
  "status" NOT IN ('sent', 'cancelled') OR "payload_ciphertext" IS NULL
);
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_attempts_non_negative" CHECK ("attempts" >= 0);

CREATE TABLE "email_suppressions" (
    "address_hash" CHAR(64) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("address_hash")
);
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_reason" CHECK ("reason" IN ('bounce', 'complaint', 'manual'));

-- Events with no company (sign-up, verification, password reset). No personal data in metadata.
CREATE TABLE "platform_audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_kind" "platform_actor_kind" NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_audit_events_user_id_created_at_idx" ON "platform_audit_events"("user_id", "created_at");
CREATE INDEX "platform_audit_events_action_created_at_idx" ON "platform_audit_events"("action", "created_at");
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_metadata_size" CHECK (octet_length("metadata"::text) <= 16384);
CREATE TRIGGER platform_audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION jobflow_reject_history_mutation();

-- S13: every existing company keeps full access, recorded once.
INSERT INTO "audit_events" ("company_id", "created_by", "actor_kind", "action", "target_type", "target_id", "metadata")
SELECT "id", NULL, 'system', 'company.access_initialised', 'company', "id"::text,
       '{"changes":{"accessMode":{"before":null,"after":"unrestricted"}}}'::jsonb
FROM "companies";

COMMIT;
