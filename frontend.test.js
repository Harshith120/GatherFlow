import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { newDb } from "pg-mem";
import { createApp } from "./server.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const clientScript = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const password = "A-secure-test-password-2026";

async function setup(t, appOptions = {}) {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemoryPool } = memoryDb.adapters.createPg();
  const pool = new MemoryPool();
  for (const migration of ["V1__initial.sql", "V2__smart_checkin.sql", "V3__normalized_event_operations.sql", "V4__email_verification.sql"]) {
    const sql = readFileSync(new URL(`./migrations/${migration}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map(part => part.trim()).filter(Boolean)) {
      if (statement.includes("jsonb_array_elements(events.questions)")) continue;
      await pool.query(statement);
    }
  }
  const server = await createApp({
    pool,
    jwtSecret: "test-secret-with-enough-entropy-for-auth",
    skipMigrationCheck: true,
    emailDomainCheck: async () => true,
    ...appOptions
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    pool,
    baseUrl,
    async request(path, { token, method = "GET", body } = {}) {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const data = await response.json().catch(() => ({}));
      return { status: response.status, data };
    }
  };
}

async function openPage(t, baseUrl, token = "", pageUrl = `${baseUrl}/`) {
  const dom = new JSDOM(html, {
    url: pageUrl,
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  Object.defineProperty(window, "isSecureContext", { value: true });
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) }
  });
  Object.defineProperty(window.crypto, "randomUUID", { value: randomUUID });
  let bannerObjectUrlId = 0;
  window.URL.createObjectURL = () => `blob:gatherflow-${++bannerObjectUrlId}`;
  window.URL.revokeObjectURL = () => {};
  window.__fetchRequests = [];
  window.confirm = () => true;
  window.fetch = (url, options = {}) => {
    window.__fetchRequests.push({ url: String(url), options });
    return fetch(new URL(url, baseUrl), options);
  };
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  if (token) window.localStorage.setItem("gatherflow.session", token);
  window.eval(clientScript);
  t.after(() => window.close());

  const isVerificationLink = new URL(pageUrl).searchParams.has("verifyEmail");
  await waitFor(() => isVerificationLink
    ? !window.document.querySelector("#emailVerificationScreen").classList.contains("hidden")
    : token
      ? !window.document.querySelector("#appShell").classList.contains("hidden")
      : window.document.querySelector("#publicDirectoryList .empty-state, #publicDirectoryList [data-public-event]"));
  if (token) await waitFor(() => window.document.querySelector("#eventCards .empty-state, #eventCards .event-card, #eventCards [data-status-event], #eventCards [data-join-volunteer]"));
  return window;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the UI to update.");
}

function click(window, selector) {
  const element = window.document.querySelector(selector);
  assert.ok(element, `Expected element ${selector} to exist.`);
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return element;
}

function submit(window, selector) {
  const form = window.document.querySelector(selector);
  assert.ok(form, `Expected form ${selector} to exist.`);
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function setValue(window, selector, value) {
  const control = window.document.querySelector(selector);
  assert.ok(control, `Expected control ${selector} to exist.`);
  control.value = value;
  return control;
}

async function registerAccountThroughUi(app, t, window, { name, email, role = "ORGANIZER" }) {
  click(window, "#openAuth");
  click(window, '.auth-tab[data-auth-mode="register"]');
  setValue(window, '#authForm [name="name"]', name);
  setValue(window, '#authForm [name="email"]', email);
  setValue(window, '#authForm [name="password"]', password);
  setValue(window, '#authForm [name="role"]', role);
  submit(window, "#authForm");
  await waitFor(() => !window.document.querySelector("#appShell").classList.contains("hidden"));
  await waitFor(() => window.document.querySelector("#eventCards .empty-state, #eventCards .event-card, #eventCards [data-status-event], #eventCards [data-join-volunteer]"));
  return window.localStorage.getItem("gatherflow.session");
}

async function loginThroughUi(window, email, accountPassword = password) {
  if (window.document.querySelector("#publicLanding").classList.contains("hidden")) {
    click(window, "#logoutButton");
  }
  click(window, "#openAuth");
  setValue(window, '#authForm [name="email"]', email);
  setValue(window, '#authForm [name="password"]', accountPassword);
  submit(window, "#authForm");
  await waitFor(() => !window.document.querySelector("#appShell").classList.contains("hidden"));
  await waitFor(() => window.document.querySelector("#eventCards .empty-state, #eventCards .event-card, #eventCards [data-status-event], #eventCards [data-join-volunteer]"));
}

async function createEventThroughUi(window, title, { startsAt, registrationStartAt, registrationEndAt, bannerData } = {}) {
  click(window, "#headerAction");
  const form = window.document.querySelector("#eventForm");
  setValue(window, '#eventForm [name="title"]', title);
  setValue(window, '#eventForm [name="description"]', "A test event created through the organizer workflow.");
  setValue(window, '#eventForm [name="location"]', "Community Hall");
  setValue(window, '#eventForm [name="capacity"]', "25");
  if (startsAt) setValue(window, '#eventForm [name="startsAt"]', startsAt);
  if (registrationStartAt) setValue(window, '#eventForm [name="registrationStartAt"]', registrationStartAt);
  if (registrationEndAt) setValue(window, '#eventForm [name="registrationEndAt"]', registrationEndAt);
  if (bannerData) form.dataset.bannerData = bannerData;
  submit(window, "#eventForm");
  await waitFor(() => [...window.document.querySelectorAll("#eventCards h2")].some(heading => heading.textContent === title));
  return window.document.querySelector("#eventCards [data-status-event]")?.dataset.statusEvent;
}

async function createAccount(app, name, email, role = "ORGANIZER") {
  const result = await app.request("/api/auth/register", {
    method: "POST",
    body: { name, email, password, role }
  });
  assert.equal(result.status, 201);
  return result.data;
}

async function createPublishedEvent(app, token, title) {
  const created = await app.request("/api/events", {
    method: "POST",
    token,
    body: {
      title,
      location: "Community Hall",
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      capacity: 25,
      description: "A public event for frontend tests."
    }
  });
  assert.equal(created.status, 201);
  const event = created.data.event;
  const published = await app.request(`/api/events/${event.id}/status`, {
    method: "PATCH",
    token,
    body: { status: "PUBLISHED" }
  });
  assert.equal(published.status, 200);
  return published.data.event;
}

test("frontend login displays auth errors and opens the authenticated workspace", async t => {
  const app = await setup(t);
  const account = await createAccount(app, "Login Organizer", `login-${randomUUID()}@example.test`);
  const window = await openPage(t, app.baseUrl);
  click(window, "#openAuth");
  setValue(window, '#authForm [name="email"]', account.user.email);
  setValue(window, '#authForm [name="password"]', "incorrect-password-2026");
  submit(window, "#authForm");
  await waitFor(() => window.document.querySelector("#authError").textContent);
  assert.match(window.document.querySelector("#authError").textContent, /invalid|incorrect/i);

  setValue(window, '#authForm [name="password"]', password);
  submit(window, "#authForm");
  await waitFor(() => !window.document.querySelector("#appShell").classList.contains("hidden"));
  await waitFor(() => window.document.querySelector("#eventCards .empty-state, #eventCards .event-card, #eventCards [data-status-event], #eventCards [data-join-volunteer]"));
  assert.equal(window.document.querySelector("#profileName").textContent, "Login Organizer");
  assert.ok(window.localStorage.getItem("gatherflow.session"));
});

test("frontend event form creates and publishes an event", async t => {
  const app = await setup(t);
  const window = await openPage(t, app.baseUrl);
  const email = `creator-${randomUUID()}@example.test`;
  const token = await registerAccountThroughUi(app, t, window, { name: "Event Creator", email });
  const title = `UI Event ${randomUUID()}`;
  const startsAt = "2035-06-15T18:45";
  const registrationStartAt = "2035-06-14T09:30";
  const registrationEndAt = "2035-06-15T17:00";
  const bannerData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const eventId = await createEventThroughUi(window, title, {
    startsAt,
    registrationStartAt,
    registrationEndAt,
    bannerData
  });
  assert.ok(eventId);
  const createRequest = window.__fetchRequests.find(request =>
    request.url === "/api/events" && request.options.method === "POST"
  );
  assert.ok(createRequest);
  const submittedEvent = JSON.parse(createRequest.options.body);
  assert.equal(submittedEvent.startsAt, new Date(startsAt).toISOString());
  assert.equal(submittedEvent.registrationStartAt, new Date(registrationStartAt).toISOString());
  assert.equal(submittedEvent.registrationEndAt, new Date(registrationEndAt).toISOString());
  assert.equal(submittedEvent.bannerData, bannerData);
  await waitFor(() => window.document.querySelector("#eventCards [data-event-banner]")?.src.startsWith("blob:gatherflow-"));
  await waitFor(() => window.document.querySelector("#eventBanner [data-event-banner]")?.src.startsWith("blob:gatherflow-"));
  const bannerRequest = window.__fetchRequests.find(request => request.url === `/api/events/${eventId}/banner`);
  assert.ok(bannerRequest);
  assert.equal(bannerRequest.options.headers.Authorization, `Bearer ${token}`);
  click(window, `[data-edit-event="${eventId}"]`);
  await waitFor(() => window.document.querySelector("#bannerPreview").src.startsWith("blob:gatherflow-"));
  window.document.querySelector("#eventDialog").close();
  click(window, '[data-view="events"]');
  click(window, `[data-status-event="${eventId}"][data-event-status="PUBLISHED"]`);
  await waitFor(() => !window.document.querySelector(`[data-status-event="${eventId}"][data-event-status="PUBLISHED"]`));

  const saved = await app.request(`/api/events/${eventId}`, { token });
  assert.equal(saved.data.event.title, title);
  assert.equal(saved.data.event.status, "PUBLISHED");
  assert.equal(saved.data.event.location, "Community Hall");
  assert.equal(new Date(saved.data.event.starts_at).toISOString(), new Date(startsAt).toISOString());
  assert.equal(new Date(saved.data.event.registration_start_at).toISOString(), new Date(registrationStartAt).toISOString());
  assert.equal(new Date(saved.data.event.registration_end_at).toISOString(), new Date(registrationEndAt).toISOString());
  assert.ok(saved.data.event.bannerUrl);
});

test("event registration links use the configured public URL and warn for local-only URLs", async t => {
  const publicApp = await setup(t, { publicAppUrl: "https://events.example.test" });
  const organizer = await createAccount(publicApp, "Share Organizer", `share-${randomUUID()}@example.test`);
  const event = await createPublishedEvent(publicApp, organizer.token, "Shareable event");
  const window = await openPage(t, publicApp.baseUrl, organizer.token);
  await waitFor(() => window.document.querySelector("#attendeeList .empty-state"));
  const copiedLinks = [];
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async link => copiedLinks.push(link) }
  });

  click(window, `[data-copy-event="${event.id}"]`);
  await waitFor(() => copiedLinks.length);
  assert.equal(copiedLinks[0], `https://events.example.test/?event=${event.id}`);
  assert.equal(window.document.querySelector("#toast").textContent, "Registration link copied");

  const localApp = await setup(t, { publicAppUrl: "http://localhost:3000" });
  const localOrganizer = await createAccount(localApp, "Local Share Organizer", `local-share-${randomUUID()}@example.test`);
  const localEvent = await createPublishedEvent(localApp, localOrganizer.token, "Local-only event");
  const localWindow = await openPage(t, localApp.baseUrl, localOrganizer.token);
  await waitFor(() => localWindow.document.querySelector("#attendeeList .empty-state"));
  const localCopiedLinks = [];
  Object.defineProperty(localWindow.navigator, "clipboard", {
    value: { writeText: async link => localCopiedLinks.push(link) }
  });

  click(localWindow, `[data-copy-event="${localEvent.id}"]`);
  await waitFor(() => localCopiedLinks.length);
  assert.equal(new URL(localCopiedLinks[0]).hostname, "localhost");
  assert.match(localWindow.document.querySelector("#toast").textContent, /local-only.*APP_BASE_URL/i);
});

test("signed-in attendees can register from the events view using their account details", async t => {
  const app = await setup(t);
  const organizer = await createAccount(app, "Registration Organizer", `register-owner-${randomUUID()}@example.test`);
  const event = await createPublishedEvent(app, organizer.token, "Attendee self-registration");
  const attendee = await createAccount(
    app,
    "Signed-in Attendee",
    `register-attendee-${randomUUID()}@example.test`,
    "ATTENDEE"
  );
  const window = await openPage(t, app.baseUrl);
  await loginThroughUi(window, attendee.user.email);

  const registerButton = await waitFor(() => window.document.querySelector(`[data-register="${event.id}"]`));
  assert.equal(registerButton.disabled, false);
  click(window, `[data-register="${event.id}"]`);
  await waitFor(() => window.document.querySelector("#registrationDialog").open);
  assert.equal(window.document.querySelector('#registrationForm [name="name"]').value, attendee.user.name);
  assert.equal(window.document.querySelector('#registrationForm [name="email"]').value, attendee.user.email);
  assert.equal(window.document.querySelector('#registrationForm [name="email"]').readOnly, true);

  setValue(window, '#registrationForm [name="phone"]', "555-0404");
  submit(window, "#registrationForm");
  await waitFor(() => window.document.querySelector("#ticketDialog").open);
  const ticketCode = window.document.querySelector(".ticket-card code").textContent;
  const saved = await app.pool.query(`
    SELECT COUNT(*) AS count
    FROM registrations r
    JOIN attendees a ON a.id=r.attendee_profile_id
    JOIN tickets t ON t.registration_id=r.id
    WHERE r.event_id=$1 AND a.email=$2 AND t.ticket_code=$3
  `, [event.id, attendee.user.email, ticketCode]);
  assert.equal(Number(saved.rows[0].count), 1);
});

test("frontend public registration displays a QR ticket backed by a stored registration", async t => {
  const app = await setup(t);
  const organizer = await createAccount(app, "Public Event Organizer", `public-owner-${randomUUID()}@example.test`);
  const event = await createPublishedEvent(app, organizer.token, "Public UI registration");
  const window = await openPage(t, app.baseUrl);
  click(window, `[data-public-event="${event.id}"]`);
  await waitFor(() => window.document.querySelector("#landingTitle").textContent === event.title);
  click(window, "#landingRegister");
  setValue(window, '#registrationForm [name="name"]', "UI Attendee");
  setValue(window, '#registrationForm [name="email"]', `attendee-${randomUUID()}@example.test`);
  setValue(window, '#registrationForm [name="phone"]', "555-0101");
  submit(window, "#registrationForm");
  await waitFor(() => window.document.querySelector("#ticketDialog").open);

  const ticket = window.document.querySelector(".ticket-card code").textContent;
  const qr = window.document.querySelector(".ticket-qr");
  assert.ok(ticket);
  assert.match(qr.src, /^data:image\/png;base64,/);
  const stored = await app.pool.query(
    "SELECT attendees.name, tickets.ticket_code FROM attendees JOIN registrations ON registrations.attendee_profile_id=attendees.id JOIN tickets ON tickets.registration_id=registrations.id WHERE tickets.ticket_code=$1",
    [ticket]
  );
  assert.equal(stored.rows[0].name, "UI Attendee");
  assert.equal(stored.rows[0].ticket_code, ticket);
});

test("frontend attendee search and QR scan check in the selected volunteer event attendee", async t => {
  const app = await setup(t);
  const organizer = await createAccount(app, "Check-in Organizer", `checkin-owner-${randomUUID()}@example.test`);
  const event = await createPublishedEvent(app, organizer.token, "Volunteer scan event");
  const volunteerEmail = `volunteer-${randomUUID()}@example.test`;
  const volunteer = await createAccount(app, "UI Volunteer", volunteerEmail, "VOLUNTEER");
  const attendeeEmail = `guest-${randomUUID()}@example.test`;
  const registration = await app.request(`/api/events/${event.id}/registrations`, {
    method: "POST",
    body: { name: "Searchable Guest", email: attendeeEmail, phone: "555-0202", answers: {} }
  });
  assert.equal(registration.status, 201);
  const ticketCode = registration.data.registrations[0].ticket_code;
  const persistedRegistration = await app.pool.query(
    "SELECT r.id FROM registrations r JOIN tickets t ON t.registration_id=r.id WHERE t.ticket_code=$1",
    [ticketCode]
  );
  await app.request(`/api/events/${event.id}/volunteers`, {
    method: "POST",
    token: organizer.token,
    body: { email: volunteerEmail }
  });
  const window = await openPage(t, app.baseUrl);
  await loginThroughUi(window, volunteerEmail);
  await waitFor(() => !window.document.querySelector("#appShell").classList.contains("hidden"));
  click(window, '[data-view="checkin"]');

  const search = setValue(window, "#attendeeSearch", attendeeEmail);
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => window.document.querySelector("#attendeeList [data-attendee]"));
  assert.match(window.document.querySelector("#attendeeList").textContent, /Searchable Guest/);
  assert.equal(window.document.querySelectorAll("#attendeeList [data-attendee]").length, 1);

  class FakeQrReader {
    async decodeFromConstraints(_constraints, _video, callback) {
      window.__deliverQr = callback;
      return { stop() {} };
    }
  }
  window.ZXingBrowser = { BrowserMultiFormatReader: FakeQrReader };
  click(window, "#startQrScanner");
  await waitFor(() => typeof window.__deliverQr === "function");
  window.__deliverQr({ getText: () => ticketCode }, null);
  await waitFor(() => window.document.querySelector("#checkinFeedback").textContent.includes("checked in successfully"));

  const savedCheckin = await app.pool.query(
    "SELECT check_ins.method, users.name FROM check_ins JOIN users ON users.id=check_ins.actor_id WHERE check_ins.registration_id=$1",
    [persistedRegistration.rows[0].id]
  );
  assert.equal(savedCheckin.rows[0].method, "QR_SCAN");
  assert.equal(savedCheckin.rows[0].name, "UI Volunteer");
});

test("end-to-end organizer, attendee, and volunteer journey updates the dashboard", async t => {
  const app = await setup(t);
  const organizerWindow = await openPage(t, app.baseUrl);
  const organizerEmail = `journey-organizer-${randomUUID()}@example.test`;
  await registerAccountThroughUi(app, t, organizerWindow, { name: "Journey Organizer", email: organizerEmail });
  const title = `GatherFlow journey ${randomUUID()}`;
  const eventId = await createEventThroughUi(organizerWindow, title);
  click(organizerWindow, '[data-view="events"]');
  click(organizerWindow, `[data-status-event="${eventId}"][data-event-status="PUBLISHED"]`);
  await waitFor(() => !organizerWindow.document.querySelector(`[data-status-event="${eventId}"][data-event-status="PUBLISHED"]`));
  const organizerToken = organizerWindow.localStorage.getItem("gatherflow.session");

  click(organizerWindow, "#logoutButton");
  click(organizerWindow, "#openAuth");
  setValue(organizerWindow, '#authForm [name="email"]', organizerEmail);
  setValue(organizerWindow, '#authForm [name="password"]', password);
  submit(organizerWindow, "#authForm");
  await waitFor(() => !organizerWindow.document.querySelector("#appShell").classList.contains("hidden"));
  const organizerEvents = await app.request("/api/events", { token: organizerToken });
  const event = organizerEvents.data.events.find(item => item.id === eventId);
  assert.equal(event.status, "PUBLISHED");

  const attendeeWindow = await openPage(t, app.baseUrl);
  click(attendeeWindow, `[data-public-event="${eventId}"]`);
  await waitFor(() => attendeeWindow.document.querySelector("#landingTitle").textContent === title);
  click(attendeeWindow, "#landingRegister");
  const attendeeEmail = `journey-attendee-${randomUUID()}@example.test`;
  setValue(attendeeWindow, '#registrationForm [name="name"]', "Journey Attendee");
  setValue(attendeeWindow, '#registrationForm [name="email"]', attendeeEmail);
  setValue(attendeeWindow, '#registrationForm [name="phone"]', "555-0303");
  submit(attendeeWindow, "#registrationForm");
  await waitFor(() => attendeeWindow.document.querySelector("#ticketDialog").open);
  const ticketCode = attendeeWindow.document.querySelector(".ticket-card code").textContent;
  assert.ok(ticketCode);
  const persistedRegistration = await app.pool.query(
    "SELECT registrations.id, attendees.name, tickets.ticket_code FROM registrations JOIN attendees ON attendees.id=registrations.attendee_profile_id JOIN tickets ON tickets.registration_id=registrations.id WHERE tickets.ticket_code=$1",
    [ticketCode]
  );
  assert.equal(persistedRegistration.rows[0].name, "Journey Attendee");

  const volunteerWindow = await openPage(t, app.baseUrl);
  const volunteerEmail = `journey-volunteer-${randomUUID()}@example.test`;
  await registerAccountThroughUi(app, t, volunteerWindow, { name: "Journey Volunteer", email: volunteerEmail, role: "VOLUNTEER" });
  click(volunteerWindow, `[data-join-volunteer="${eventId}"]`);
  await waitFor(() => volunteerWindow.document.querySelector('[data-view="checkin"]:not(.hidden)'));
  click(volunteerWindow, '[data-view="checkin"]');
  const search = setValue(volunteerWindow, "#attendeeSearch", attendeeEmail);
  search.dispatchEvent(new volunteerWindow.Event("input", { bubbles: true }));
  await waitFor(() => volunteerWindow.document.querySelector("#attendeeList [data-attendee]"));
  assert.match(volunteerWindow.document.querySelector("#attendeeList").textContent, /Journey Attendee/);

  class FakeQrReader {
    async decodeFromConstraints(_constraints, _video, callback) {
      volunteerWindow.__deliverQr = callback;
      return { stop() {} };
    }
  }
  volunteerWindow.ZXingBrowser = { BrowserMultiFormatReader: FakeQrReader };
  click(volunteerWindow, "#startQrScanner");
  await waitFor(() => typeof volunteerWindow.__deliverQr === "function");
  volunteerWindow.__deliverQr({ getText: () => ticketCode }, null);
  await waitFor(() => volunteerWindow.document.querySelector("#checkinFeedback").textContent.includes("checked in successfully"));

  const checkin = await app.pool.query(
    "SELECT check_ins.method, users.name FROM check_ins JOIN users ON users.id=check_ins.actor_id WHERE check_ins.registration_id=$1",
    [persistedRegistration.rows[0].id]
  );
  assert.equal(checkin.rows[0].method, "QR_SCAN");
  assert.equal(checkin.rows[0].name, "Journey Volunteer");

  click(organizerWindow, "#logoutButton");
  click(organizerWindow, "#openAuth");
  setValue(organizerWindow, '#authForm [name="email"]', organizerEmail);
  setValue(organizerWindow, '#authForm [name="password"]', password);
  submit(organizerWindow, "#authForm");
  await waitFor(() => organizerWindow.document.querySelectorAll("#statsGrid .stat-card")[2]?.querySelector("strong").textContent === "1");
  assert.equal(organizerWindow.document.querySelectorAll("#statsGrid .stat-card")[1].querySelector("strong").textContent, "1");
  assert.equal(organizerWindow.document.querySelectorAll("#statsGrid .stat-card")[2].querySelector("strong").textContent, "1");
});
