CREATE TABLE users (
  id UUID PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('PLATFORM_ADMIN','ORGANIZER','VOLUNTEER','ATTENDEE')),
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE events (
  id UUID PRIMARY KEY,
  organizer_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(120) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  location VARCHAR(200) NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','REGISTRATION_CLOSED','COMPLETED','CANCELLED')),
  registration_start_at TIMESTAMPTZ,
  registration_end_at TIMESTAMPTZ,
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  duplicate_policy VARCHAR(24) NOT NULL DEFAULT 'EMAIL_ONCE'
    CHECK (duplicate_policy IN ('EMAIL_ONCE','ALLOW_DUPLICATES')),
  allow_cancellations BOOLEAN NOT NULL DEFAULT TRUE,
  banner_data BYTEA,
  banner_mime VARCHAR(32),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (registration_start_at IS NULL OR registration_end_at IS NULL
    OR registration_start_at < registration_end_at),
  CHECK (registration_end_at IS NULL OR registration_end_at <= starts_at)
);

CREATE TABLE event_members (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role = 'VOLUNTEER'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE registration_groups (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  confirmation_code VARCHAR(64) NOT NULL UNIQUE,
  contact_email VARCHAR(254) NOT NULL,
  group_name VARCHAR(120) NOT NULL DEFAULT '',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE registrations (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attendee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id UUID NOT NULL REFERENCES registration_groups(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  group_name VARCHAR(120) NOT NULL DEFAULT '',
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  ticket_code VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED'
    CHECK (status IN ('REGISTERED','CHECKED_IN','CANCELLED')),
  duplicate_guard BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_in_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE password_resets (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX registrations_event_status ON registrations(event_id, status);
CREATE INDEX registrations_group ON registrations(group_id);
CREATE UNIQUE INDEX registrations_event_email_active
  ON registrations(event_id, LOWER(email))
  WHERE status <> 'CANCELLED' AND duplicate_guard = TRUE;
CREATE INDEX events_public_listing ON events(status, starts_at) WHERE archived_at IS NULL;
