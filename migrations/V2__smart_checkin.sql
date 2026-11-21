ALTER TABLE registrations
  ADD COLUMN checked_in_by UUID REFERENCES users(id);

CREATE TABLE checkin_audit (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id UUID NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id),
  method VARCHAR(16) NOT NULL
    CHECK (method IN ('QR_SCAN','MANUAL','RECOVERY','OFFLINE_SYNC')),
  identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX checkin_audit_event_time ON checkin_audit(event_id, checked_in_at);
