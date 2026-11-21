ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

CREATE TABLE email_verification_tokens (
  token_hash VARCHAR(64) PRIMARY KEY,
  purpose VARCHAR(24) NOT NULL
    CHECK (purpose IN ('ACCOUNT','EVENT_REGISTRATION')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  payload JSONB,
  completed_group_id UUID REFERENCES registration_groups(id) ON DELETE CASCADE,
  completed_confirmation_code VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (purpose='ACCOUNT' AND user_id IS NOT NULL AND event_id IS NULL AND payload IS NULL
      AND completed_group_id IS NULL AND completed_confirmation_code IS NULL)
    OR
    (purpose='EVENT_REGISTRATION' AND event_id IS NOT NULL AND payload IS NOT NULL
      AND ((completed_group_id IS NULL AND completed_confirmation_code IS NULL)
        OR (completed_group_id IS NOT NULL AND completed_confirmation_code IS NOT NULL)))
  )
);

CREATE INDEX email_verification_user ON email_verification_tokens(user_id, expires_at)
  WHERE purpose='ACCOUNT';
CREATE INDEX email_verification_event_contact ON email_verification_tokens(event_id, expires_at)
  WHERE purpose='EVENT_REGISTRATION';
