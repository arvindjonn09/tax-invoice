-- #259: email pacing under Zoho's rolling-hour limit.
-- email_dispatch_state: one row holding the provider-wide pause after a
-- throttling reply, checked by every dispatcher inside the claim lock, so
-- emails queued during a pause wait too.
CREATE TABLE "email_dispatch_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "paused_until" TIMESTAMPTZ(3),
    "pause_streak" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_dispatch_state_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "email_dispatch_state" ADD CONSTRAINT "email_dispatch_state_single_row" CHECK ("id" = 1);
ALTER TABLE "email_dispatch_state" ADD CONSTRAINT "email_dispatch_state_streak_non_negative" CHECK ("pause_streak" >= 0);
INSERT INTO "email_dispatch_state" ("id") VALUES (1);

-- email_send_attempts: one row per SMTP attempt, whatever its outcome, so
-- failing and throttled sends count toward the hourly cap too. Pruned by the
-- dispatcher after two hours; no address or content.
CREATE TABLE "email_send_attempts" (
    "id" BIGSERIAL NOT NULL,
    "attempted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_send_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_send_attempts_attempted_at_idx" ON "email_send_attempts"("attempted_at");

-- How often this row met a throttling reply (they use no attempt until the cap).
ALTER TABLE "email_outbox" ADD COLUMN "rate_limited_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_rate_limited_non_negative" CHECK ("rate_limited_count" >= 0);
