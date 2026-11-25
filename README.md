# GatherFlow

GatherFlow is a PostgreSQL-backed event registration and attendee-management
app. The browser UI is plain JavaScript, and the same-origin Node.js REST API
uses PostgreSQL for durable records, `pg` for database access, and `qrcode` to
create individual attendee tickets.

## Run locally

Requirements for local development: Node.js 22.13 or newer and PostgreSQL 15 or
newer. To run migrations, install either Flyway CLI 11 with Java 21 and
PostgreSQL support on `PATH`, or Docker Desktop and keep it running. The
migration script prefers Flyway CLI and falls back to the official Flyway 11
container when only Docker is available.

Set the connection settings in PowerShell, install dependencies, and start the
app:

```powershell
$env:PGHOST = "localhost"
$env:PGPORT = "5432"
$env:PGUSER = "gatherflow"
$env:PGPASSWORD = "your-local-database-password"
$env:PGDATABASE = "gatherflow"
npm.cmd ci
npm.cmd start
```

`npm.cmd start` applies Flyway migrations from `migrations/` and then starts the
API. To apply migrations without starting the app, run
`npm.cmd run db:migrate`. On Windows, if neither Flyway CLI nor Docker is
available, install one of them and reopen PowerShell before running the command
again. Starting `node .\server.js` directly skips migration execution and
requires the database to already be at the latest Flyway version.
On Windows, Docker Desktop may need WSL 2. If its engine cannot start, run
`wsl --install` from an Administrator PowerShell, restart Windows when prompted,
and launch Docker Desktop before migrating.
Run tests with `npm.cmd test`. The API and frontend interaction tests use an
in-memory PostgreSQL-compatible database. The end-to-end PostgreSQL test is
enabled by setting `GATHERFLOW_E2E_DATABASE_URL` to a dedicated database whose
name contains `test` or `e2e`; that database must already have the Flyway
migrations applied. The test persists uniquely named organizer, event,
registration, ticket, and check-in records, so never point it at a production
or personal data database. CI migrates an isolated PostgreSQL test database
and runs the complete suite against it. Run the browser-interaction suite alone
with `npm.cmd run test:frontend` or the database-backed journey with
`npm.cmd run test:postgres-e2e`.

Flyway records applied versions in `flyway_schema_history`. Existing GatherFlow
databases using the earlier `schema_migrations` table are baselined at version 2
and upgraded by V3 and V4 without deleting registration data.

Docker Compose starts PostgreSQL, runs Flyway migrations, and then starts
GatherFlow. PostgreSQL data is stored in the named `gatherflow-postgres` volume.
The database is also published to `127.0.0.1:5433` so a Node.js process running
on the host can use the same database. Copy `.env.example` only if you do not
already have a `.env`; keep existing settings and set `POSTGRES_PASSWORD` to
the password already used by the database volume:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env without overwriting existing secrets.
docker compose up --build
```

Event registration links use `APP_BASE_URL`. The example value
`http://localhost:3000` only works on the computer running GatherFlow. To share
events with people outside your local network, set `APP_BASE_URL` in `.env` to
the public HTTPS address that points to this app, then rebuild/restart it with
`docker compose up -d --build`. That address must resolve publicly and be routed
to the GatherFlow container through your hosting provider, reverse proxy, or
tunnel; changing the link alone does not publish a local Docker app.

Docker Compose gives process-level environment variables precedence over `.env`.
If this PowerShell session has an old `POSTGRES_PASSWORD`, clear it before
starting Compose so it uses the value in `.env`:

```powershell
Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue
```

The root `.env` file is Git-ignored. When running GatherFlow directly with
`npm.cmd start` or `npm.cmd run serve`, the Node scripts load `.env` and default
to the same database at `127.0.0.1:5433`, using `POSTGRES_PASSWORD` for its
password. If the Docker app is already using port 3000, set `$env:PORT` to a
different port before starting the host Node server. To use another host port
for PostgreSQL, set `POSTGRES_PORT` in `.env`.

Changing `POSTGRES_PASSWORD` does not update the role password in an existing
PostgreSQL volume. To rotate it, update the role with `\password gatherflow`
from a `psql` session, set the same value in `.env`, then recreate the app and
Flyway services. Do not remove the volume to resolve an authentication error.

If startup reports that PostgreSQL is unreachable, start the PostgreSQL service
or use the Docker Compose command above. For a local PostgreSQL installation,
set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` to a running
database before starting GatherFlow. The app does not start without PostgreSQL.
If startup reports `permission denied for schema public`, connect to the
`gatherflow` database as a PostgreSQL administrator and grant the app role
permission to create its migration tables:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO gatherflow;
```

## Event and registration workflows

- Organizers create draft events, edit event details, publish or unpublish
  registration, close/reopen registration, mark events completed/cancelled,
  and archive events without deleting registration history.
- Events support registration windows, attendee capacity, PNG/JPEG/WebP banners,
  custom required/optional text, choice and checkbox questions, repeat-email
  rules, and registration cancellation settings.
- Public visitors can browse published events, view event details, and register
  without an account. Group forms collect a name, email, phone and answers for
  each attendee.
- Registration uses a PostgreSQL transaction and locks the event row while
  checking capacity. Unique active email indexes enforce the configured
  duplicate rule; cancelled registrations release their places.
- Each attendee receives a unique QR image and ticket code. Each group receives
  a separate unguessable confirmation code that can cancel the group before
  the event starts when cancellation is enabled. The primary contact receives
  an email with event details and each attendee's ticket code and QR image.
- Volunteer self-signups and organizer assignments notify the event organizer;
  date/time or venue changes and event cancellations notify registered guests.
- Organizers and assigned volunteers can scan QR tickets with a device camera,
  search by attendee name, email, phone, registration ID, or ticket code, and
  manually check in guests. Camera scanning requires HTTPS or localhost and
  camera permission.
- Attendee recovery searches existing registrations only; staff must confirm
  identity before check-in. Invalid, cancelled, and duplicate tickets are
  rejected. Check-ins record the timestamp, responsible user, method, and
  recovery verification in the event audit history.
- Organizers can view event statistics and registration answers and manage
  assigned volunteers. Volunteer accounts can browse upcoming opportunities,
  join or leave an event team, then access that event's attendee list and
  check-in tools while assigned.
- The organizer dashboard reports organization-scoped event, registration,
  walk-in, arrival, and attendance totals, with recent registration/check-in
  activity and a capacity comparison chart. It refreshes after workspace
  operations and periodically while open.
- Offline check-ins for already-loaded attendees queue in the browser and sync
  when the connection returns; the synchronized action is also audited.

## Database model

Flyway migrations maintain normalized `organizations`,
`organization_members`, `events`, `event_questions`, `registration_groups`,
`attendees`, `registrations`, `tickets`, `check_ins`,
`volunteer_assignments`, `audit_logs`, email-verification tokens, and
password-reset tables. The upgrade
migration copies existing event questions, attendee details, tickets,
volunteer assignments, and check-in history before removing their legacy
duplicate columns/tables.

## Configuration and security

`pg` uses the standard `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and
`PGDATABASE` variables. Set `DATABASE_URL` instead when using a hosted database.
Set a strong `JWT_SECRET` and `NODE_ENV=production` in production.
The API is same-origin by default. If a separate web origin must call it, set
`CORS_ALLOWED_ORIGINS` to a comma-separated allowlist of exact origins (for
example, `https://events.example.com`, without paths or trailing slashes).
Credentials are not enabled for cross-origin requests.

Optional initial platform-administrator provisioning uses
`PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` on first startup.
Password resets, event registration confirmations, volunteer notifications, and
important event updates use the configured email delivery service. Account
creation and sign-in do not require email verification. Production email
delivery supports Resend directly or a custom email adapter. For Resend, set
these variables in the ignored local `.env` file:

- `RESEND_API_KEY`: an API key from the Resend dashboard.
- `RESEND_FROM_EMAIL`: a sender such as `GatherFlow <no-reply@your-verified-domain.com>`.

Verify the sender domain in Resend before sending to attendees. Resend's
`onboarding@resend.dev` sender is for limited testing and can only send to the
address associated with your Resend account. For production, also set
`APP_BASE_URL` to GatherFlow's public HTTPS address; this is also used for event
registration links. Alternatively, configure a custom adapter with:

- `EMAIL_DELIVERY_ENDPOINT`: an HTTPS endpoint that accepts `to`, `subject`,
  and `text` JSON (plus optional `html`) and sends the email.
- `EMAIL_DELIVERY_TOKEN`: bearer credential for that endpoint.

`RESET_EMAIL_ENDPOINT` and `RESET_EMAIL_TOKEN` remain supported as aliases for
existing password-reset deployments. Configure the email provider's verified
sender address/domain separately, including the SPF and DKIM DNS records
required by that provider. GatherFlow validates recipient email syntax and
mail-routing DNS records for common providers such as Gmail, Outlook, and
Yahoo, but this does not prove a specific mailbox exists or configure the
sender. A successful public registration immediately creates its tickets and
queues an email with event details, ticket codes, and QR images for the primary
contact; group guests' email domains are checked too. Volunteer self-signups
and organizer assignments notify the event organizer. Changes to event date or
venue and event cancellations notify active registered attendees.

Email notifications run asynchronously after registration, volunteer, and event
updates complete. Delivery failures are logged and do not roll back or delay
those workflows. In development without email delivery configured, the app
logs a warning and no outbound email is sent. Provider failures are logged
without logging recipient addresses or tokens.

Production startup fails when its JWT signing key or email configuration is
missing.
Authentication, public registration, and check-in routes have per-process IP
rate limits; multi-instance deployments should use a shared rate-limit store.
Put the app behind an HTTPS reverse proxy and keep database, signing-key,
administrator, and email-endpoint credentials secret.

Passwords are hashed with Node.js `scrypt`; signed sessions expire after eight
hours. Reset links expire after 30 minutes and invalidate existing sessions.
PostgreSQL stores event and registration data permanently; no data is stored
in SQLite or browser storage other than the offline check-in queue.
