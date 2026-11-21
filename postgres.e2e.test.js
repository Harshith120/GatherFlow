import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "./server.js";

const databaseUrl = process.env.GATHERFLOW_E2E_DATABASE_URL;
const testPassword = "A-secure-test-password-2026";

function assertIsTestDatabase(connectionString) {
  const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!/(^|[-_])(test|e2e)([-_]|$)/i.test(database)) {
    throw new Error("GATHERFLOW_E2E_DATABASE_URL must point to a database with 'test' or 'e2e' in its name.");
  }
}

test("PostgreSQL end-to-end stores registrations and QR check-ins for the organizer dashboard", {
  skip: !databaseUrl
}, async t => {
  assertIsTestDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const server = await createApp({
    pool,
    jwtSecret: "postgres-e2e-secret-with-sufficient-entropy",
    resetLog: () => {}
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { token, method = "GET", body } = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    assert.ok(response.ok, `${method} ${path} failed with ${response.status}: ${data.error || "unknown error"}`);
    return data;
  }

  const unique = randomUUID();
  const organizer = await request("/api/auth/register", {
    method: "POST",
    body: { name: "PostgreSQL Journey Organizer", email: `organizer-${unique}@example.test`, password: testPassword }
  });
  const volunteer = await request("/api/auth/register", {
    method: "POST",
    body: { name: "PostgreSQL Journey Volunteer", email: `volunteer-${unique}@example.test`, password: testPassword, role: "VOLUNTEER" }
  });
  const event = (await request("/api/events", {
    method: "POST",
    token: organizer.token,
    body: {
      title: `PostgreSQL journey ${unique}`,
      description: "Persist an attendee registration and verified arrival.",
      location: "Test venue",
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      capacity: 5
    }
  })).event;
  await request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: organizer.token,
    body: { status: "PUBLISHED" }
  });
  await request(`/api/events/${event.id}/volunteers`, {
    method: "POST",
    token: volunteer.token,
    body: {}
  });
  const registration = await request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: {
      name: "PostgreSQL Journey Attendee",
      email: `attendee-${unique}@example.test`,
      phone: "555-0404",
      answers: {}
    }
  });
  const ticketCode = registration.registrations[0].ticket_code;

  const storedBeforeCheckin = await pool.query(`
    SELECT attendees.name, tickets.ticket_code
    FROM registrations
    JOIN attendees ON attendees.id=registrations.attendee_profile_id
    JOIN tickets ON tickets.registration_id=registrations.id
    WHERE registrations.id=$1
  `, [registration.registrations[0].id]);
  assert.equal(storedBeforeCheckin.rows[0].name, "PostgreSQL Journey Attendee");
  assert.equal(storedBeforeCheckin.rows[0].ticket_code, ticketCode);

  const checkedIn = await request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: { ticketCode, method: "QR_SCAN" }
  });
  assert.equal(checkedIn.attendee.name, "PostgreSQL Journey Attendee");
  const persistedCheckin = await pool.query(
    "SELECT method, actor_id FROM check_ins WHERE registration_id=$1",
    [registration.registrations[0].id]
  );
  assert.equal(persistedCheckin.rows[0].method, "QR_SCAN");
  assert.equal(persistedCheckin.rows[0].actor_id, volunteer.user.id);

  const dashboard = await request("/api/dashboard", { token: organizer.token });
  assert.equal(dashboard.metrics.registrations, 1);
  assert.equal(dashboard.metrics.checkedIn, 1);
  assert.equal(dashboard.metrics.pendingArrivals, 0);
  assert.equal(dashboard.metrics.attendanceRate, 100);
});
