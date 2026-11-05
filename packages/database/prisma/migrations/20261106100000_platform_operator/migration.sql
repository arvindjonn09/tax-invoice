-- #230 (ADR 0004 D5, D6; contracts "Data model changes"): the platform
-- operator, host-issued enrolment codes, Better Auth's TOTP tables and the
-- operator actor on the company audit trail.

CREATE TABLE "platform_operators" (
    "user_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_reason" VARCHAR(500) NOT NULL,
    "granted_by" VARCHAR(100) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(500),

    CONSTRAINT "platform_operators_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "platform_operators_reason_nonempty" CHECK (btrim("granted_reason") <> ''),
    CONSTRAINT "platform_operators_by_nonempty" CHECK (btrim("granted_by") <> ''),
    -- A revoked row always says why; an active row has no stale reason.
    CONSTRAINT "platform_operators_revocation" CHECK (
      ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
      OR ("revoked_at" IS NOT NULL AND btrim(COALESCE("revoked_reason", '')) <> '')
    )
);
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Issued only by `pnpm operator enrol-code`. The web role consumes a code and
-- never creates one. Only the SHA-256 digest is stored.
CREATE TABLE "operator_enrolment_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_enrolment_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operator_enrolment_codes_code_hash_key" ON "operator_enrolment_codes"("code_hash");
CREATE INDEX "operator_enrolment_codes_user_id_idx" ON "operator_enrolment_codes"("user_id");
ALTER TABLE "operator_enrolment_codes" ADD CONSTRAINT "operator_enrolment_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "platform_operators"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Better Auth's twoFactor plugin (schema for 1.7).
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "two_factor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failed_verification_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "two_factor_user_id_idx" ON "two_factor"("user_id");
CREATE INDEX "two_factor_secret_idx" ON "two_factor"("secret");
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ADR 0004 D6: who acted, for each audit actor kind.
ALTER TABLE "audit_events" ADD COLUMN "operator_user_id" UUID;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_operator_user_id_fkey"
  FOREIGN KEY ("operator_user_id") REFERENCES "platform_operators"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor" CHECK (
  ("actor_kind" = 'member' AND "created_by" IS NOT NULL AND "operator_user_id" IS NULL)
  OR ("actor_kind" = 'operator' AND "operator_user_id" IS NOT NULL AND "created_by" IS NULL)
  OR ("actor_kind" = 'system' AND "created_by" IS NULL AND "operator_user_id" IS NULL)
);

-- #211 left this pointing at users until platform_operators existed.
ALTER TABLE "trial_extension_requests" DROP CONSTRAINT "trial_extension_requests_decided_by_fkey";
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "platform_operators"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
