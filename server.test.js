import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { createApp } from "./server.js";

async function setup(t, appOptions = {}) {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemoryPool } = memoryDb.adapters.createPg();
  const pool = new MemoryPool();
  const resetMessages = [];
  const emailMessages = [];
  const emailErrors = [];
  for (const migration of ["V1__initial.sql", "V2__smart_checkin.sql", "V3__normalized_event_operations.sql", "V4__email_verification.sql"]) {
    const sql = readFileSync(new URL(`./migrations/${migration}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map(part => part.trim()).filter(Boolean)) {
      // pg-mem cannot run the PostgreSQL lateral JSON array expansion used by V3.
      if (statement.includes("jsonb_array_elements(events.questions)")) continue;
      await pool.query(statement);
    }
  }
  const server = await createApp({
    pool,
    jwtSecret: "test-secret-with-enough-entropy-for-auth",
    skipMigrationCheck: true,
    resetLog: message => resetMessages.push(message),
    emailErrorLog: message => emailErrors.push(message),
    emailDomainCheck: async () => true,
    emailDelivery: async message => emailMessages.push(message),
    ...appOptions
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    pool,
    resetMessages,
    emailMessages,
    emailErrors,
    async request(path, { token, method = "GET", body, headers: extraHeaders = {} } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...extraHeaders
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : await response.text();
      return { status: response.status, data, contentType, headers: response.headers };
    }
  };
}

async function createUser(app, name, email, role = "ORGANIZER") {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    body: { name, email, password: "A-secure-test-password-2026", role }
  });
  assert.equal(response.status, 201);
  assert.ok(response.data.token);
  return response.data;
}

async function completeRegistration(app, eventId, body, options = {}) {
  return app.request(`/api/events/${eventId}/registrations`, {
    method: "POST",
    ...options,
    body
  });
}

async function waitForEmail(app, predicate, timeoutMs = 1000) {
  await waitUntil(() => app.emailMessages.find(predicate), timeoutMs);
  return app.emailMessages.find(predicate);
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the expected operation.");
}

async function createEvent(app, token, { title = "Neighborhood gathering", capacity = 5, extra = {} } = {}) {
  const response = await app.request("/api/events", {
    method: "POST",
    token,
    body: {
      title,
      location: "Austin, TX",
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      capacity,
      description: "A community event",
      ...extra
    }
  });
  assert.equal(response.status, 201);
  return response.data.event;
}

async function publish(app, token, eventId) {
  const response = await app.request(`/api/events/${eventId}/status`, {
    method: "PATCH",
    token,
    body: { status: "PUBLISHED" }
  });
  assert.equal(response.status, 200);
  return response.data.event;
}

function registration(name, email, answers = {}) {
  return { name, email, phone: "512-555-0100", answers };
}

test("authentication accepts valid credentials and protects account routes", async t => {
  const app = await setup(t);
  const email = "login-check@example.test";
  await createUser(app, "Login Check", email);

  const invalid = await app.request("/api/auth/login", {
    method: "POST",
    body: { email, password: "incorrect-password-2026" }
  });
  assert.equal(invalid.status, 401);

  const login = await app.request("/api/auth/login", {
    method: "POST",
    body: { email, password: "A-secure-test-password-2026" }
  });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  assert.equal(login.data.user.email, email);

  const profile = await app.request("/api/auth/me", { token: login.data.token });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.user.id, login.data.user.id);
  assert.equal((await app.request("/api/auth/me")).status, 401);
  assert.equal((await app.request("/api/auth/me", { token: "invalid.token.value" })).status, 401);
});

test("account creation and sign-in do not require email verification or successful email delivery", async t => {
  const app = await setup(t, { emailDelivery: async () => { throw new Error("mail service unavailable"); } });
  const email = "unverified-account@example.test";
  const created = await app.request("/api/auth/register", {
    method: "POST",
    body: { name: "Unverified Account", email, password: "A-secure-test-password-2026" }
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.token);
  const stored = await app.pool.query("SELECT email_verified_at FROM users WHERE email=$1", [email]);
  assert.equal(stored.rows[0].email_verified_at, null);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    body: { email, password: "A-secure-test-password-2026" }
  });
  assert.equal(login.status, 200);
  assert.equal((await app.request("/api/auth/me", { token: login.data.token })).status, 200);
});

test("email validation normalizes IDN domains and rejects malformed, undeliverable, or uncheckable domains", async t => {
  const checkedDomains = [];
  const app = await setup(t, {
    emailDomainCheck: async domain => {
      checkedDomains.push(domain);
      if (domain === "temporary.example") throw new Error("DNS unavailable");
      return domain !== "unroutable.example";
    }
  });
  const malformed = await app.request("/api/auth/register", {
    method: "POST",
    body: { name: "Malformed Address", email: "bad..local@example.test", password: "A-secure-test-password-2026" }
  });
  assert.equal(malformed.status, 400);

  const unroutable = await app.request("/api/auth/register", {
    method: "POST",
    body: { name: "Unroutable Address", email: "person@unroutable.example", password: "A-secure-test-password-2026" }
  });
  assert.equal(unroutable.status, 400);

  const temporary = await app.request("/api/auth/register", {
    method: "POST",
    body: { name: "Temporary Address", email: "person@temporary.example", password: "A-secure-test-password-2026" }
  });
  assert.equal(temporary.status, 503);

  const idn = await app.request("/api/auth/register", {
    method: "POST",
    body: { name: "IDN Address", email: "person@bücher.example", password: "A-secure-test-password-2026" }
  });
  assert.equal(idn.status, 201);
  assert.ok(checkedDomains.includes("xn--bcher-kva.example"));
  assert.ok((await app.request("/api/auth/login", {
    method: "POST",
    body: { email: "person@bücher.example", password: "A-secure-test-password-2026" }
  })).data.token);
  for (const domain of ["gmail.com", "outlook.com", "yahoo.com"]) {
    const provider = await app.request("/api/auth/register", {
      method: "POST",
      body: {
        name: "Mail Provider",
        email: `provider@${domain}`,
        password: "A-secure-test-password-2026"
      }
    });
    assert.equal(provider.status, 201);
    assert.ok(checkedDomains.includes(domain));
  }
});

test("public group registration checks every email domain while staff walk-ins bypass confirmation", async t => {
  const domains = [];
  const app = await setup(t, {
    emailDomainCheck: async domain => {
      domains.push(domain);
      return domain !== "unroutable.example";
    }
  });
  const organizer = await createUser(app, "Domain Test Organizer", "organizer@example.test");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);

  const rejectedGroup = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: {
      ...registration("Primary Contact", "primary@example.test"),
      attendees: [registration("Group Guest", "guest@unroutable.example")]
    }
  });
  assert.equal(rejectedGroup.status, 400);
  assert.ok(domains.includes("example.test"));
  assert.ok(domains.includes("unroutable.example"));
  const pending = await app.pool.query(
    "SELECT COUNT(*) AS count FROM email_verification_tokens WHERE purpose='EVENT_REGISTRATION' AND event_id=$1",
    [event.id]
  );
  assert.equal(Number(pending.rows[0].count), 0);

  const checksBeforeWalkIn = domains.length;
  const walkIn = await app.request(`/api/events/${event.id}/registrations`, {
    token: organizer.token,
    method: "POST",
    body: {
      ...registration("Walk In", "walkin@unroutable.example"),
      source: "WALK_IN"
    }
  });
  assert.equal(walkIn.status, 201);
  const source = await app.pool.query(
    "SELECT registration_source FROM registrations WHERE id=$1",
    [walkIn.data.registrations[0].id]
  );
  assert.equal(source.rows[0].registration_source, "WALK_IN");
  assert.equal(domains.length, checksBeforeWalkIn);
  const walkInEmail = await waitForEmail(app, message =>
    message.to === "walkin@unroutable.example" && message.purpose === "REGISTRATION_CONFIRMATION"
  );
  assert.match(walkInEmail.html, /data:image\/png;base64,/);
});

test("public registration completes before confirmation email delivery and emails event details with QR tickets", async t => {
  const messages = [];
  let releaseDelivery;
  const app = await setup(t, {
    emailDelivery: async message => {
      messages.push(message);
      await new Promise(resolve => { releaseDelivery = resolve; });
    }
  });
  const organizer = await createUser(app, "Registration Organizer", "pending-organizer@example.test");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);
  const result = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: registration("Email Ticket Guest", "ticket-guest@example.test")
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.registrations.length, 1);
  assert.ok(result.data.registrations[0].qrCode.startsWith("data:image/png;base64,"));
  const persisted = await app.pool.query(`
    SELECT COUNT(*) AS registrations FROM registrations WHERE event_id=$1
  `, [event.id]);
  assert.equal(Number(persisted.rows[0].registrations), 1);
  await waitUntil(() => messages.find(message => message.to === "ticket-guest@example.test"));
  assert.equal(messages[0].purpose, "REGISTRATION_CONFIRMATION");
  assert.match(messages[0].text, /Date and time:[\s\S]*Venue:/);
  assert.match(messages[0].text, /Email Ticket Guest:/);
  assert.match(messages[0].html, /data:image\/png;base64,/);
  assert.match(messages[0].html, /Austin, TX/);
  releaseDelivery();
});

test("email provider failures are logged without failing registration", async t => {
  const app = await setup(t, {
    emailDelivery: async () => { throw new Error("provider unavailable"); }
  });
  const organizer = await createUser(app, "Email Failure Organizer", "email-failure-owner@example.test");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);

  const result = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: registration("Email Failure Guest", "email-failure-guest@example.test")
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.registrations.length, 1);
  await waitUntil(() => app.emailErrors.length > 0);
  assert.match(app.emailErrors[0], /REGISTRATION_CONFIRMATION email delivery failed: provider unavailable/);
  const saved = await app.pool.query(
    "SELECT COUNT(*) AS count FROM registrations WHERE event_id=$1",
    [event.id]
  );
  assert.equal(Number(saved.rows[0].count), 1);
});

test("Resend receives authenticated transactional email including HTML tickets", async t => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFromEmail = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_API_KEY = "re_test-key";
  process.env.RESEND_FROM_EMAIL = "GatherFlow <tickets@example.test>";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = previousFromEmail;
  });

  const requests = [];
  const app = await setup(t, {
    emailDelivery: null,
    emailFetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    }
  });
  const organizer = await createUser(app, "Resend Organizer", "resend-owner@example.test");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);
  const result = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: registration("Resend Guest", "resend-guest@example.test")
  });
  assert.equal(result.status, 201);

  await waitUntil(() => requests.length === 1);
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(requests[0].options.headers.Authorization, "Bearer re_test-key");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.from, "GatherFlow <tickets@example.test>");
  assert.deepEqual(payload.to, ["resend-guest@example.test"]);
  assert.equal(payload.subject, `Registration confirmed: ${event.title}`);
  assert.match(payload.html, /data:image\/png;base64,/);
});

test("published events collect validated group registrations with unique QR tickets", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Morgan Organizer", "morgan@example.test");
  const event = await createEvent(app, organizer.token, {
    title: "Spring forum",
    capacity: 2,
    extra: {
      registrationStartAt: new Date(Date.now() - 60_000).toISOString(),
      registrationEndAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      questions: [{ id: "diet", label: "Meal preference", type: "select", required: true, options: ["Vegetarian", "None"] }]
    }
  });
  assert.equal(event.status, "DRAFT");
  assert.equal((await app.request(`/api/events/${event.id}`)).status, 404);
  await publish(app, organizer.token, event.id);
  const publicEvents = await app.request("/api/public/events");
  assert.equal(publicEvents.data.events.length, 1);
  assert.equal(publicEvents.data.events[0].questions[0].label, "Meal preference");

  const missingAnswer = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: registration("Jordan Lee", "jordan@example.test")
  });
  assert.equal(missingAnswer.status, 400);

  const group = await completeRegistration(app, event.id, {
      ...registration("Jordan Lee", "jordan@example.test", { diet: "Vegetarian" }),
      groupName: "Lee family",
      attendees: [registration("Taylor Lee", "taylor@example.test", { diet: "None" })]
  });
  assert.equal(group.status, 201);
  assert.equal(group.data.registrations.length, 2);
  assert.notEqual(group.data.registrations[0].ticket_code, group.data.registrations[1].ticket_code);
  assert.ok(group.data.registrations.every(person => person.qrCode.startsWith("data:image/png;base64,")));
  assert.ok(group.data.confirmationCode);
  const registrationAudit = await app.pool.query(
    "SELECT action,actor_id,metadata FROM audit_logs WHERE event_id=$1 AND action='REGISTRATION_CREATED'",
    [event.id]
  );
  assert.equal(registrationAudit.rows[0].action, "REGISTRATION_CREATED");
  assert.equal(registrationAudit.rows[0].actor_id, null);
  assert.equal(registrationAudit.rows[0].metadata.attendeeCount, 2);
  assert.equal(registrationAudit.rows[0].metadata.source, "PUBLIC");
  assert.equal(registrationAudit.rows[0].metadata.email, undefined);

  const duplicate = await completeRegistration(app, event.id, {
    ...registration("Jordan Duplicate", "JORDAN@example.test", { diet: "None" })
  });
  assert.equal(duplicate.status, 409);

  const full = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: registration("New Guest", "new@example.test", { diet: "None" })
  });
  assert.equal(full.status, 409);

  const attendees = await app.request(`/api/events/${event.id}/attendees`, { token: organizer.token });
  assert.equal(attendees.data.attendees.length, 2);
  assert.equal(attendees.data.attendees[1].answers.diet, "None");
  const loweredCapacity = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: organizer.token,
    body: { capacity: 1 }
  });
  assert.equal(loweredCapacity.status, 409);
});

test("cancellation releases event capacity and check-in rejects cancelled attendees", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Event Owner", "owner@example.test");
  const event = await createEvent(app, organizer.token, { capacity: 1 });
  await publish(app, organizer.token, event.id);
  const original = await completeRegistration(app, event.id, registration("Casey Guest", "casey@example.test"));
  const cancelled = await app.request(`/api/registrations/${original.data.confirmationCode}/cancel`, { method: "POST", body: {} });
  assert.equal(cancelled.status, 200);
  const group = await app.pool.query(
    "SELECT id FROM registration_groups WHERE confirmation_code=$1",
    [original.data.confirmationCode]
  );
  const cancellationAudit = await app.pool.query(
    "SELECT action,actor_id,metadata FROM audit_logs WHERE entity_id=$1 AND action='REGISTRATION_CANCELLED'",
    [group.rows[0].id]
  );
  assert.equal(cancellationAudit.rows[0].action, "REGISTRATION_CANCELLED");
  assert.equal(cancellationAudit.rows[0].actor_id, null);
  assert.equal(cancellationAudit.rows[0].metadata.attendeeCount, 1);

  const replacement = await completeRegistration(app, event.id, registration("Replacement Guest", "replacement@example.test"));
  assert.equal(replacement.status, 201);
  const reusedCancellation = await app.request(`/api/registrations/${original.data.confirmationCode}/cancel`, { method: "POST", body: {} });
  assert.equal(reusedCancellation.status, 409);

  const noDuplicateCheckin = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: organizer.token,
    body: { registrationId: original.data.registrations[0].id }
  });
  assert.equal(noDuplicateCheckin.status, 409);
  const cancelledTicketScan = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: organizer.token,
    body: { ticketCode: original.data.registrations[0].ticket_code, method: "QR_SCAN" }
  });
  assert.equal(cancelledTicketScan.status, 409);
});

test("event owners can edit, publish, close, and archive only their own events", async t => {
  const app = await setup(t);
  const owner = await createUser(app, "Event Owner", "owner@example.test");
  const other = await createUser(app, "Other Owner", "other@example.test");
  const event = await createEvent(app, owner.token);
  const invalidTransition = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: owner.token,
    body: { status: "COMPLETED" }
  });
  assert.equal(invalidTransition.status, 409);
  const denied = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: other.token,
    body: { title: "Unauthorized edit" }
  });
  assert.equal(denied.status, 403);

  await publish(app, owner.token, event.id);
  const edited = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: owner.token,
    body: {
      title: "Updated community gathering",
      questions: [{ label: "Accessibility needs", type: "text", required: false }]
    }
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.event.title, "Updated community gathering");
  assert.equal(edited.data.event.questions[0].label, "Accessibility needs");
  const saved = await app.request(`/api/events/${event.id}/`, { token: owner.token });
  assert.equal(saved.data.event.title, "Updated community gathering");
  const ownerEvents = await app.request("/api/events/", { token: owner.token });
  assert.equal(ownerEvents.data.events.some(item => item.id === event.id), true);

  const closed = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: owner.token,
    body: { status: "REGISTRATION_CLOSED" }
  });
  assert.equal(closed.data.event.status, "REGISTRATION_CLOSED");
  const illegalTransition = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: owner.token,
    body: { status: "PUBLISHED" }
  });
  assert.equal(illegalTransition.status, 200);
  const completed = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: owner.token,
    body: { status: "COMPLETED" }
  });
  assert.equal(completed.data.event.status, "COMPLETED");
  const reopenCompleted = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: owner.token,
    body: { status: "PUBLISHED" }
  });
  assert.equal(reopenCompleted.status, 409);
  const archived = await app.request(`/api/events/${event.id}`, { method: "DELETE", token: owner.token });
  assert.equal(archived.data.archived, true);
  assert.equal((await app.request(`/api/events/${event.id}`)).status, 404);
  const audit = await app.pool.query(
    "SELECT action FROM audit_logs WHERE event_id=$1 ORDER BY created_at",
    [event.id]
  );
  assert.deepEqual(new Set(audit.rows.map(row => row.action)), new Set([
    "EVENT_CREATED", "EVENT_STATUS_CHANGED", "EVENT_UPDATED", "EVENT_ARCHIVED"
  ]));
});

test("important event changes and cancellations notify active registered attendees", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Update Organizer", "update-organizer@example.test");
  const event = await createEvent(app, organizer.token, { title: "Community dinner" });
  await publish(app, organizer.token, event.id);
  const registrationResult = await completeRegistration(app, event.id, {
    ...registration("Primary Guest", "primary-update@example.test"),
    attendees: [registration("Group Guest", "group-update@example.test")]
  });
  assert.equal(registrationResult.status, 201);

  const revisedDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const edited = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: organizer.token,
    body: { startsAt: revisedDate, location: "New Community Hall" }
  });
  assert.equal(edited.status, 200);
  const primaryUpdate = await waitForEmail(app, message =>
    message.to === "primary-update@example.test" && message.purpose === "EVENT_UPDATE"
  );
  const groupUpdate = await waitForEmail(app, message =>
    message.to === "group-update@example.test" && message.purpose === "EVENT_UPDATE"
  );
  assert.match(primaryUpdate.text, /New Community Hall/);
  assert.match(primaryUpdate.text, /Community dinner/);
  assert.match(groupUpdate.text, /Date and time:/);

  const cancelled = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: organizer.token,
    body: { status: "CANCELLED" }
  });
  assert.equal(cancelled.status, 200);
  const cancellation = await waitForEmail(app, message =>
    message.to === "primary-update@example.test" && message.subject.startsWith("Event cancelled:")
  );
  assert.match(cancellation.text, /has been cancelled/);
  await waitForEmail(app, message =>
    message.to === "group-update@example.test" && message.subject.startsWith("Event cancelled:")
  );
});

test("event banners are validated, stored in PostgreSQL, and removed on request", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Banner Owner", "banner@example.test");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const event = await createEvent(app, organizer.token, { extra: { bannerData: png } });
  assert.ok(event.bannerUrl);
  const privateBanner = await app.request(event.bannerUrl, { token: organizer.token });
  assert.equal(privateBanner.status, 200);
  assert.equal(privateBanner.contentType, "image/png");

  await publish(app, organizer.token, event.id);
  const publicBanner = await app.request(event.bannerUrl);
  assert.equal(publicBanner.status, 200);
  const removed = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: organizer.token,
    body: { removeBanner: true }
  });
  assert.equal(removed.data.event.bannerUrl, null);
  assert.equal((await app.request(event.bannerUrl)).status, 404);

  const invalid = await app.request("/api/events", {
    method: "POST",
    token: organizer.token,
    body: {
      title: "Bad banner",
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      location: "Test",
      capacity: 2,
      bannerData: "data:image/png;base64,PGh0bWw+"
    }
  });
  assert.equal(invalid.status, 400);
});

test("duplicate registration policy can be configured per event", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Policy Owner", "policy@example.test");
  const event = await createEvent(app, organizer.token, {
    extra: { duplicatePolicy: "ALLOW_DUPLICATES" }
  });
  await publish(app, organizer.token, event.id);
  const first = await completeRegistration(app, event.id, registration("Guest One", "repeat@example.test"));
  const second = await completeRegistration(app, event.id, registration("Guest Two", "REPEAT@example.test"));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const edited = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: organizer.token,
    body: { duplicatePolicy: "EMAIL_ONCE" }
  });
  assert.equal(edited.status, 200);
  const blocked = await completeRegistration(app, event.id, registration("Guest Three", "repeat@example.test"));
  assert.equal(blocked.status, 409);
});

test("volunteers are scoped to assigned events and can be removed by organizers", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Event Owner", "owner@example.test");
  const otherOrganizer = await createUser(app, "Other Owner", "other@example.test");
  const volunteer = await createUser(app, "Front Desk Volunteer", "volunteer@example.test", "VOLUNTEER");
  const event = await createEvent(app, organizer.token);
  await app.request(`/api/events/${event.id}/status`, { method: "PATCH", token: organizer.token, body: { status: "PUBLISHED" } });
  const registrationResult = await completeRegistration(app, event.id, registration("Casey Guest", "casey@example.test"));

  const denied = await app.request(`/api/events/${event.id}/attendees`, { token: otherOrganizer.token });
  assert.equal(denied.status, 403);
  const add = await app.request(`/api/events/${event.id}/volunteers`, {
    method: "POST",
    token: organizer.token,
    body: { email: "volunteer@example.test" }
  });
  assert.equal(add.status, 201);
  const addAudit = await app.pool.query(
    "SELECT actor_id,entity_id FROM audit_logs WHERE event_id=$1 AND action='VOLUNTEER_ADDED'",
    [event.id]
  );
  assert.equal(addAudit.rows[0].actor_id, organizer.user.id);
  assert.equal(addAudit.rows[0].entity_id, volunteer.user.id);
  const assigned = await app.request(`/api/events/${event.id}/volunteers`, { token: organizer.token });
  assert.equal(assigned.data.volunteers.length, 1);
  const checkin = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: { registrationId: registrationResult.data.registrations[0].id }
  });
  assert.equal(checkin.status, 200);

  const remove = await app.request(`/api/events/${event.id}/volunteers/${volunteer.user.id}`, {
    method: "DELETE",
    token: organizer.token
  });
  assert.equal(remove.status, 200);
  const removalAudit = await app.pool.query(
    "SELECT actor_id,entity_id FROM audit_logs WHERE event_id=$1 AND action='VOLUNTEER_REMOVED'",
    [event.id]
  );
  assert.equal(removalAudit.rows[0].actor_id, organizer.user.id);
  assert.equal(removalAudit.rows[0].entity_id, volunteer.user.id);
  const deniedAfterRemoval = await app.request(`/api/events/${event.id}/attendees`, { token: volunteer.token });
  assert.equal(deniedAfterRemoval.status, 403);
});

test("QR and recovery check-ins verify tickets, prevent duplicates, and audit the responsible volunteer", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Event Owner", "owner@example.test");
  const volunteer = await createUser(app, "Event Volunteer", "volunteer@example.test", "VOLUNTEER");
  const attendee = await createUser(app, "Unauthorized Guest", "unauthorized@example.test", "ATTENDEE");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);
  await app.request(`/api/events/${event.id}/volunteers`, {
    method: "POST",
    token: organizer.token,
    body: { email: "volunteer@example.test" }
  });
  const recovered = await completeRegistration(app, event.id, registration("Recoverable Guest", "recoverable@example.test"));
  const scanned = await completeRegistration(app, event.id, registration("Scanned Guest", "scanned@example.test"));

  const invalidTicket = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: { ticketCode: "NOT-A-REAL-TICKET", method: "QR_SCAN" }
  });
  assert.equal(invalidTicket.status, 404);
  const unauthorizedCheckin = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: attendee.token,
    body: { ticketCode: recovered.data.registrations[0].ticket_code, method: "QR_SCAN" }
  });
  assert.equal(unauthorizedCheckin.status, 403);

  const unverifiedRecovery = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: { registrationId: recovered.data.registrations[0].id, method: "RECOVERY" }
  });
  assert.equal(unverifiedRecovery.status, 400);

  const recoveredCheckin = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: {
      registrationId: recovered.data.registrations[0].id,
      method: "RECOVERY",
      identityVerified: true
    }
  });
  assert.equal(recoveredCheckin.status, 200);
  assert.equal(recoveredCheckin.data.attendee.checked_in_by_name, "Event Volunteer");

  const qrCheckin = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: { ticketCode: scanned.data.registrations[0].ticket_code, method: "QR_SCAN" }
  });
  assert.equal(qrCheckin.status, 200);
  assert.ok(qrCheckin.data.attendee.checked_in_at);
  const duplicateScan = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: volunteer.token,
    body: { ticketCode: scanned.data.registrations[0].ticket_code, method: "QR_SCAN" }
  });
  assert.equal(duplicateScan.status, 409);

  const history = await app.request(`/api/events/${event.id}/check-in-history`, { token: volunteer.token });
  assert.equal(history.data.history.length, 2);
  assert.deepEqual(new Set(history.data.history.map(item => item.method)), new Set(["RECOVERY", "QR_SCAN"]));
  assert.ok(history.data.history.every(item => item.actor_name === "Event Volunteer"));
  assert.equal(history.data.history.find(item => item.method === "RECOVERY").identity_verified, true);
});

test("volunteers can discover upcoming events, join, and leave the event team", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Event Owner", "owner@example.test");
  const volunteer = await createUser(app, "Event Volunteer", "volunteer@example.test", "VOLUNTEER");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);

  const opportunities = await app.request("/api/events", { token: volunteer.token });
  assert.equal(opportunities.status, 200);
  assert.equal(opportunities.data.events.length, 1);
  assert.equal(opportunities.data.events[0].canVolunteer, true);
  assert.equal(opportunities.data.events[0].isVolunteer, false);

  const joined = await app.request(`/api/events/${event.id}/volunteers/`, {
    method: "POST",
    token: volunteer.token,
    body: {}
  });
  assert.equal(joined.status, 201);
  const joinedAudit = await app.pool.query(
    "SELECT actor_id,entity_id FROM audit_logs WHERE event_id=$1 AND action='VOLUNTEER_JOINED'",
    [event.id]
  );
  assert.equal(joinedAudit.rows[0].actor_id, volunteer.user.id);
  assert.equal(joinedAudit.rows[0].entity_id, volunteer.user.id);
  const assignedEvents = await app.request("/api/events", { token: volunteer.token });
  assert.equal(assignedEvents.data.events[0].isVolunteer, true);
  assert.equal(assignedEvents.data.events[0].canVolunteer, false);
  assert.equal((await app.request(`/api/events/${event.id}/attendees`, { token: volunteer.token })).status, 200);

  const duplicateJoin = await app.request(`/api/events/${event.id}/volunteers`, {
    method: "POST",
    token: volunteer.token,
    body: {}
  });
  assert.equal(duplicateJoin.status, 200);
  assert.equal(duplicateJoin.data.alreadyJoined, true);

  const left = await app.request(`/api/events/${event.id}/volunteers/`, {
    method: "DELETE",
    token: volunteer.token,
    body: {}
  });
  assert.equal(left.status, 200);
  const leftAudit = await app.pool.query(
    "SELECT action FROM audit_logs WHERE event_id=$1 AND actor_id=$2 AND action='VOLUNTEER_LEFT'",
    [event.id, volunteer.user.id]
  );
  assert.equal(leftAudit.rowCount, 1);
  assert.equal((await app.request(`/api/events/${event.id}/attendees`, { token: volunteer.token })).status, 403);
});

test("volunteer self-registration and organizer assignment notify the event organizer", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Volunteer Organizer", "volunteer-owner@example.test");
  const volunteer = await createUser(app, "Volunteer Applicant", "volunteer-applicant@example.test", "VOLUNTEER");
  const selfJoinEvent = await createEvent(app, organizer.token, { title: "Volunteer Signup Event" });
  await publish(app, organizer.token, selfJoinEvent.id);

  const joined = await app.request(`/api/events/${selfJoinEvent.id}/volunteers`, {
    method: "POST",
    token: volunteer.token,
    body: {}
  });
  assert.equal(joined.status, 201);
  const selfJoinNotice = await waitForEmail(app, message =>
    message.to === organizer.user.email &&
    message.purpose === "VOLUNTEER_ASSIGNMENT" &&
    message.subject.includes("Volunteer Signup Event")
  );
  assert.match(selfJoinNotice.text, /Volunteer Applicant/);
  assert.match(selfJoinNotice.text, /volunteer-applicant@example\.test/);
  assert.match(selfJoinNotice.text, /Assigned role: Volunteer/);

  const assignedEvent = await createEvent(app, organizer.token, { title: "Volunteer Assignment Event" });
  const assigned = await app.request(`/api/events/${assignedEvent.id}/volunteers`, {
    method: "POST",
    token: organizer.token,
    body: { email: volunteer.user.email }
  });
  assert.equal(assigned.status, 201);
  const assignmentNotice = await waitForEmail(app, message =>
    message.to === organizer.user.email &&
    message.purpose === "VOLUNTEER_ASSIGNMENT" &&
    message.subject.includes("Volunteer Assignment Event")
  );
  assert.match(assignmentNotice.text, /Assigned role: Volunteer/);
  await waitForEmail(app, message =>
    message.to === volunteer.user.email &&
    message.subject.includes("Volunteer Assignment Event")
  );
});

test("password reset links are single-use and invalidate existing sessions", async t => {
  const app = await setup(t);
  const account = await createUser(app, "Pat Attendee", "pat@example.test", "ATTENDEE");
  const forgot = await app.request("/api/auth/forgot-password", {
    method: "POST",
    body: { email: "pat@example.test" }
  });
  assert.equal(forgot.status, 200);
  const resetEmail = [...app.emailMessages].reverse().find(item => item.purpose === "PASSWORD_RESET");
  const resetLink = resetEmail?.text.match(/reset-password\?token=([^\s]+)/)?.[1];
  assert.ok(resetLink);
  assert.equal(resetEmail.to, "pat@example.test");
  assert.equal(app.resetMessages.some(message => message.includes("pat@example.test") || message.includes(resetLink)), false);

  const reset = await app.request("/api/auth/reset-password", {
    method: "POST",
    body: { token: resetLink, password: "An-even-better-password-2026" }
  });

  assert.equal(reset.status, 200);
  assert.equal((await app.request("/api/auth/me", { token: account.token })).status, 401);
  const oldLogin = await app.request("/api/auth/login", {
    method: "POST",
    body: { email: "pat@example.test", password: "A-secure-test-password-2026" }
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await app.request("/api/auth/login", {
    method: "POST",
    body: { email: "pat@example.test", password: "An-even-better-password-2026" }
  });
  assert.equal(newLogin.status, 200);
  const reused = await app.request("/api/auth/reset-password", {
    method: "POST",
    body: { token: resetLink, password: "Another-new-password-2026" }
  });
  assert.equal(reused.status, 400);
});

test("API applies configured CORS origins, security headers, and sensitive-route limits", async t => {
  const app = await setup(t, { corsAllowedOrigins: ["https://organizer.example.test"] });
  const allowedOrigin = "https://organizer.example.test";
  const preflight = await app.request("/api/auth/login", {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const allowedRequest = await app.request("/api/public/events", {
    headers: { Origin: allowedOrigin }
  });
  assert.equal(allowedRequest.headers.get("access-control-allow-origin"), allowedOrigin);

  const blockedOrigin = await app.request("/api/auth/login", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example.test" }
  });
  assert.equal(blockedOrigin.status, 403);
  assert.equal(blockedOrigin.headers.get("access-control-allow-origin"), null);
  const publicEvents = await app.request("/api/public/events");
  assert.equal(publicEvents.headers.get("permissions-policy"), "camera=(self), microphone=(), geolocation=()");
  const roleEscalation = await app.request("/api/auth/register", {
    method: "POST",
    body: {
      name: "Unapproved Admin",
      email: "self-admin@example.test",
      password: "A-secure-test-password-2026",
      role: "PLATFORM_ADMIN"
    }
  });
  assert.equal(roleEscalation.status, 400);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await app.request("/api/auth/login", {
      method: "POST",
      body: { email: "missing@example.test", password: "invalid" }
    })).status, 401);
  }
  const limited = await app.request("/api/auth/login", {
    method: "POST",
    body: { email: "missing@example.test", password: "invalid" }
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("static hosting exposes only the public browser assets", async t => {
  const app = await setup(t);
  assert.equal((await app.request("/")).status, 200);
  assert.equal((await app.request("/styles.css")).status, 200);
  assert.equal((await app.request("/vendor/zxing-browser.min.js")).status, 200);
  assert.equal((await app.request("/server.js")).status, 404);
  assert.equal((await app.request("/.gitignore")).status, 404);
});

test("organizer dashboard aggregates database activity and isolates other organizations", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Dana Organizer", "dana@example.test");
  const event = await createEvent(app, organizer.token, {
    capacity: 4,
    extra: { questions: [{ id: "access", label: "Access needs", type: "text", required: false }] }
  });
  await publish(app, organizer.token, event.id);

  const publicRegistration = await completeRegistration(app, event.id, registration("Jordan Guest", "jordan@example.test"));
  assert.equal(publicRegistration.status, 201);
  const walkInRegistration = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    token: organizer.token,
    body: { ...registration("Riley Walkin", "riley@example.test"), source: "WALK_IN" }
  });
  assert.equal(walkInRegistration.status, 201);

  const checkedIn = await app.request(`/api/events/${event.id}/check-in`, {
    method: "POST",
    token: organizer.token,
    body: { registrationId: publicRegistration.data.registrations[0].id, method: "MANUAL" }
  });
  assert.equal(checkedIn.status, 200);

  const dashboard = await app.request("/api/dashboard", { token: organizer.token });
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.data.metrics, {
    publishedEvents: 1,
    registrations: 2,
    checkedIn: 1,
    pendingArrivals: 1,
    walkInRegistrations: 1,
    attendanceRate: 50
  });
  assert.equal(dashboard.data.recentRegistrations.length, 2);
  assert.equal(dashboard.data.recentRegistrations.some(item => item.registration_source === "WALK_IN"), true);
  assert.equal(dashboard.data.recentCheckIns[0].attendee_name, "Jordan Guest");
  assert.equal(Number(dashboard.data.eventPerformance[0].registered), 2);
  assert.equal(Number(dashboard.data.eventPerformance[0].checked_in), 1);
  assert.equal(dashboard.data.eventPerformance[0].title, event.title);
  assert.equal(Number(dashboard.data.eventPerformance[0].capacity), 4);
  const publicSource = await app.pool.query(
    "SELECT registration_source FROM registrations WHERE id=$1",
    [publicRegistration.data.registrations[0].id]
  );
  assert.equal(publicSource.rows[0].registration_source, "PUBLIC");

  const otherOrganizer = await createUser(app, "Other Organizer", "other@example.test");
  const otherDashboard = await app.request("/api/dashboard", { token: otherOrganizer.token });
  assert.equal(otherDashboard.status, 200);
  assert.equal(otherDashboard.data.metrics.registrations, 0);
  const attendee = await createUser(app, "Normal Attendee", "attendee@example.test", "ATTENDEE");
  assert.equal((await app.request("/api/dashboard", { token: attendee.token })).status, 403);

  const tables = await Promise.all([
    "organizations", "organization_members", "event_questions", "attendees",
    "tickets", "check_ins", "volunteer_assignments", "audit_logs"
  ].map(table => app.pool.query(`SELECT COUNT(*) FROM ${table}`)));
  assert.equal(tables.length, 8);
  const question = await app.pool.query("SELECT label FROM event_questions WHERE event_id=$1", [event.id]);
  assert.equal(question.rows[0].label, "Access needs");
});

test("Flyway schema upgrade preserves and normalizes legacy registration data", async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemoryPool } = memoryDb.adapters.createPg();
  const pool = new MemoryPool();
  const apply = async name => {
    const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map(part => part.trim()).filter(Boolean)) {
      if (statement.includes("jsonb_array_elements(events.questions)")) continue;
      await pool.query(statement);
    }
  };
  await apply("V1__initial.sql");
  await apply("V2__smart_checkin.sql");

  const organizerId = "11111111-1111-4111-8111-111111111111";
  const volunteerId = "22222222-2222-4222-8222-222222222222";
  const eventId = "33333333-3333-4333-8333-333333333333";
  const groupId = "44444444-4444-4444-8444-444444444444";
  const registrationId = "55555555-5555-4555-8555-555555555555";
  const auditId = "66666666-6666-4666-8666-666666666666";
  await pool.query(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ($1,'Organizer','owner@example.test','hash','ORGANIZER'),
      ($2,'Volunteer','volunteer@example.test','hash','VOLUNTEER')
  `, [organizerId, volunteerId]);
  await pool.query(`
    INSERT INTO events (id,organizer_id,title,starts_at,location,capacity,status,questions)
    VALUES ($1,$2,'Legacy event',$3,'Austin',10,'PUBLISHED','[]'::jsonb)
  `, [eventId, organizerId, new Date(Date.now() + 86400000)]);
  await pool.query(
    "INSERT INTO event_members (event_id,user_id,role) VALUES ($1,$2,'VOLUNTEER')",
    [eventId, volunteerId]
  );
  await pool.query(`
    INSERT INTO registration_groups (id,event_id,confirmation_code,contact_email,group_name)
    VALUES ($1,$2,'legacy-confirmation','guest@example.test','Guest family')
  `, [groupId, eventId]);
  await pool.query(`
    INSERT INTO registrations (
      id,event_id,group_id,name,email,phone,group_name,answers,ticket_code,status,checked_in_by
    ) VALUES ($1,$2,$3,'Legacy Guest','guest@example.test','512-555-0100','Guest family',
      '{}'::jsonb,'LEGACY-TICKET','CHECKED_IN',$4)
  `, [registrationId, eventId, groupId, volunteerId]);
  await pool.query(`
    INSERT INTO checkin_audit (id,event_id,registration_id,actor_id,method,identity_verified)
    VALUES ($1,$2,$3,$4,'RECOVERY',TRUE)
  `, [auditId, eventId, registrationId, volunteerId]);
  await apply("V3__normalized_event_operations.sql");
  await apply("V4__email_verification.sql");

  const event = await pool.query("SELECT organization_id FROM events WHERE id=$1", [eventId]);
  assert.equal(event.rows[0].organization_id, organizerId);
  const attendee = await pool.query("SELECT name,email,phone FROM attendees WHERE id=$1", [registrationId]);
  assert.deepEqual(attendee.rows[0], {
    name: "Legacy Guest",
    email: "guest@example.test",
    phone: "512-555-0100"
  });
  const ticket = await pool.query("SELECT ticket_code,status FROM tickets WHERE registration_id=$1", [registrationId]);
  assert.equal(ticket.rows[0].ticket_code, "LEGACY-TICKET");
  assert.equal(ticket.rows[0].status, "ACTIVE");
  const checkIn = await pool.query("SELECT method,identity_verified FROM check_ins WHERE registration_id=$1", [registrationId]);
  assert.equal(checkIn.rows[0].method, "RECOVERY");
  assert.equal(checkIn.rows[0].identity_verified, true);
  const assignment = await pool.query("SELECT user_id FROM volunteer_assignments WHERE event_id=$1", [eventId]);
  assert.equal(assignment.rows[0].user_id, volunteerId);
  const audit = await pool.query("SELECT action,entity_id FROM audit_logs WHERE entity_id=$1", [registrationId]);
  assert.equal(audit.rows[0].action, "CHECK_IN");
  const source = await pool.query("SELECT registration_source FROM registrations WHERE id=$1", [registrationId]);
  assert.equal(source.rows[0].registration_source, "PUBLIC");
  const legacyAccount = await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [organizerId]);
  assert.equal(legacyAccount.rows[0].email_verified_at, null);
  await pool.end();
});

test("organizers can record distinct walk-ins after online registration closes", async t => {
  const app = await setup(t);
  const organizer = await createUser(app, "Event Owner", "owner@example.test");
  const event = await createEvent(app, organizer.token);
  await publish(app, organizer.token, event.id);
  const existing = await completeRegistration(app, event.id, registration("Jordan Guest", "jordan@example.test"));
  assert.equal(existing.status, 201);
  const started = await app.request(`/api/events/${event.id}`, {
    method: "PATCH",
    token: organizer.token,
    body: { startsAt: new Date(Date.now() - 60_000).toISOString() }
  });
  assert.equal(started.status, 200);
  const closed = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token: organizer.token,
    body: { status: "REGISTRATION_CLOSED" }
  });
  assert.equal(closed.status, 200);

  const duplicate = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    token: organizer.token,
    body: { ...registration("Jordan Guest", "jordan@example.test"), source: "WALK_IN" }
  });
  assert.equal(duplicate.status, 409);

  const walkIn = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    token: organizer.token,
    body: { ...registration("Riley Walkin", "riley@example.test"), source: "WALK_IN" }
  });
  assert.equal(walkIn.status, 201);
  const saved = await app.pool.query(
    "SELECT registration_source FROM registrations WHERE id=$1",
    [walkIn.data.registrations[0].id]
  );
  assert.equal(saved.rows[0].registration_source, "WALK_IN");
});
