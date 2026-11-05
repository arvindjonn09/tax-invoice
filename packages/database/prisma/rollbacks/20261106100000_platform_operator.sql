-- Reverses 20261106100000_platform_operator. This drops who acted on operator
-- audit events, so take a backup first if any exist.
BEGIN;
ALTER TABLE "trial_extension_requests" DROP CONSTRAINT "trial_extension_requests_decided_by_fkey";
ALTER TABLE "trial_extension_requests" ADD CONSTRAINT "trial_extension_requests_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor";
ALTER TABLE "audit_events" DROP COLUMN "operator_user_id";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor" CHECK (
  ("actor_kind" = 'member' AND "created_by" IS NOT NULL)
  OR ("actor_kind" <> 'member' AND "created_by" IS NULL)
);
DROP TABLE "two_factor";
ALTER TABLE "users" DROP COLUMN "two_factor_enabled";
DROP TABLE "operator_enrolment_codes";
DROP TABLE "platform_operators";
COMMIT;
