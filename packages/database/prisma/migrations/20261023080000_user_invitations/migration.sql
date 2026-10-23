BEGIN;
CREATE TABLE user_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  email VARCHAR(320) NOT NULL,
  role membership_role NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  accepted_at TIMESTAMPTZ(3),
  revoked_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID NOT NULL,
  CONSTRAINT user_invitations_creator_fkey FOREIGN KEY (company_id, created_by)
    REFERENCES memberships(company_id, user_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT user_invitations_email_normalized CHECK
    (email = lower(btrim(email)) AND email <> '' AND email !~ '[[:space:]]'),
  CONSTRAINT user_invitations_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_invitations_expiry CHECK (expires_at > created_at),
  CONSTRAINT user_invitations_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX user_invitations_company_id_created_at_id_idx ON user_invitations(company_id, created_at, id);
CREATE INDEX user_invitations_company_id_created_by_idx ON user_invitations(company_id, created_by);
-- Only one live invitation per email/company. Expired invitations are explicitly
-- revoked in the audited issuance transaction before a replacement is created.
CREATE UNIQUE INDEX user_invitations_pending_email_key ON user_invitations(company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
COMMIT;
