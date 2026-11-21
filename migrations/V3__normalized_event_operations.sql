CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  created_by UUID NOT NULL UNIQUE REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO organizations (id, name, created_by)
SELECT id, name || ' Organization', id
FROM users
WHERE role IN ('ORGANIZER','PLATFORM_ADMIN')
ON CONFLICT (created_by) DO NOTHING;

CREATE TABLE organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

INSERT INTO organization_members (organization_id, user_id, role)
SELECT id, created_by, 'OWNER' FROM organizations;

ALTER TABLE events ADD COLUMN organization_id UUID;
UPDATE events
SET organization_id = organizations.id
FROM organizations
WHERE organizations.created_by = events.organizer_id;
ALTER TABLE events ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE events ADD CONSTRAINT events_organization_fk
  FOREIGN KEY (organization_id) REFERENCES organizations(id);

CREATE TABLE event_questions (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  question_id VARCHAR(80) NOT NULL,
  label VARCHAR(160) NOT NULL,
  question_type VARCHAR(16) NOT NULL
    CHECK (question_type IN ('text','textarea','select','checkbox')),
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, question_id),
  UNIQUE (event_id, position)
);

INSERT INTO event_questions (
  event_id, question_id, label, question_type, is_required, options, position
)
SELECT
  events.id,
  COALESCE(question.value->>'id', 'question-' || question.position::text),
  question.value->>'label',
  question.value->>'type',
  COALESCE((question.value->>'required')::boolean, FALSE),
  COALESCE(question.value->'options', '[]'::jsonb),
  (question.position - 1)::integer
FROM events
CROSS JOIN LATERAL jsonb_array_elements(events.questions)
  WITH ORDINALITY AS question(value, position);

CREATE TABLE attendees (
  id UUID PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO attendees (id, name, email, phone, created_at, updated_at)
SELECT id, name, email, phone, registered_at, registered_at FROM registrations;

ALTER TABLE registrations RENAME COLUMN attendee_id TO user_id;
ALTER TABLE registrations ADD COLUMN attendee_profile_id UUID;
ALTER TABLE registrations ADD COLUMN registration_source VARCHAR(16) NOT NULL DEFAULT 'PUBLIC'
  CHECK (registration_source IN ('PUBLIC','WALK_IN'));
UPDATE registrations SET attendee_profile_id = id;
ALTER TABLE registrations ALTER COLUMN attendee_profile_id SET NOT NULL;
ALTER TABLE registrations ADD CONSTRAINT registrations_attendee_profile_fk
  FOREIGN KEY (attendee_profile_id) REFERENCES attendees(id);
ALTER TABLE registrations ADD CONSTRAINT registrations_attendee_profile_unique
  UNIQUE (attendee_profile_id);

CREATE TABLE tickets (
  id UUID PRIMARY KEY,
  registration_id UUID NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  ticket_code VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOID')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tickets (id, registration_id, ticket_code, status, created_at)
SELECT id, id, ticket_code,
  CASE WHEN status = 'CANCELLED' THEN 'VOID' ELSE 'ACTIVE' END,
  registered_at
FROM registrations;

CREATE TABLE volunteer_assignments (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

INSERT INTO volunteer_assignments (event_id, user_id, created_at)
SELECT event_id, user_id, created_at FROM event_members;

CREATE TABLE check_ins (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id UUID NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  method VARCHAR(16) NOT NULL
    CHECK (method IN ('QR_SCAN','MANUAL','RECOVERY','OFFLINE_SYNC')),
  identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO check_ins (
  id, event_id, registration_id, actor_id, method, identity_verified, checked_in_at
)
SELECT id, event_id, registration_id, actor_id, method, identity_verified, checked_in_at
FROM checkin_audit
ON CONFLICT (registration_id) DO NOTHING;

INSERT INTO check_ins (
  id, event_id, registration_id, actor_id, method, identity_verified, checked_in_at
)
SELECT r.id, r.event_id, r.id,
  r.checked_in_by, 'MANUAL', FALSE, COALESCE(r.checked_in_at, NOW())
FROM registrations r
WHERE r.status = 'CHECKED_IN'
ON CONFLICT (registration_id) DO NOTHING;

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(32) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO audit_logs (id, event_id, actor_id, action, entity_type, entity_id, metadata, created_at)
SELECT id, event_id, actor_id, 'CHECK_IN', 'registration', registration_id,
  '{}'::jsonb, checked_in_at
FROM checkin_audit;

DROP INDEX IF EXISTS registrations_event_email_active;
ALTER TABLE registrations DROP COLUMN name;
ALTER TABLE registrations DROP COLUMN email;
ALTER TABLE registrations DROP COLUMN phone;
ALTER TABLE registrations DROP COLUMN group_name;
ALTER TABLE registrations DROP COLUMN ticket_code;
ALTER TABLE events DROP COLUMN questions;
DROP TABLE event_members;
DROP TABLE checkin_audit;
DROP TABLE IF EXISTS schema_migrations;

ALTER TABLE users ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE events ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE registration_groups ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE registrations ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX organization_members_user ON organization_members(user_id, organization_id);
CREATE INDEX events_organization_status ON events(organization_id, status) WHERE archived_at IS NULL;
CREATE INDEX event_questions_order ON event_questions(event_id, position);
CREATE INDEX attendees_email ON attendees(LOWER(email));
CREATE INDEX volunteer_assignments_user ON volunteer_assignments(user_id, event_id);
CREATE INDEX check_ins_event_time ON check_ins(event_id, checked_in_at DESC);
CREATE INDEX audit_logs_event_action_time ON audit_logs(event_id, action, created_at DESC);
CREATE INDEX registrations_source ON registrations(registration_source, registered_at DESC);
