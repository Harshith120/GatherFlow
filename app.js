const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const tokenKey = "gatherflow.session";
const offlineKey = "gatherflow.offline-checkins";
let sessionToken = localStorage.getItem(tokenKey) || "";
let user = null;
let events = [];
let currentEvent = null;
let dashboard = null;
let dashboardRefreshTimer = null;
let attendees = [];
let selectedAttendeeId = null;
let activeFilter = "ALL";
let authMode = "login";
let editingEvent = null;
let currentRegistrationEvent = null;
let publicDirectory = [];
let ticketConfirmation = null;
let checkinHistory = [];
let recoveryMode = false;
let scannerControls = null;
let ticketScanBusy = false;
let emailVerificationToken = "";

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setButtonBusy(button, label) {
  if (!button) return;
  if (label) {
    if (!button.hasAttribute("aria-busy")) {
      button.dataset.idleHtml = button.innerHTML;
      button.dataset.idleDisabled = String(button.disabled);
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = label;
    return;
  }
  if (!button.hasAttribute("aria-busy")) return;
  button.innerHTML = button.dataset.idleHtml || button.textContent;
  button.disabled = button.dataset.idleDisabled === "true";
  button.removeAttribute("aria-busy");
  delete button.dataset.idleHtml;
  delete button.dataset.idleDisabled;
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  $("#syncStatusText").textContent = online ? "Online" : "Offline";
  $("#networkStatusText").textContent = online ? "Connected" : "Offline";
  $("#syncStatus").classList.toggle("offline", !online);
  $("#networkStatus").classList.toggle("offline", !online);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    const error = new Error("Could not reach GatherFlow. Check your connection and try again.");
    error.status = 0;
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";
  $$(".auth-tab").forEach(tab => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $("#authTitle").textContent = isRegister ? "Create your account" : "Welcome back";
  $("#authCopy").textContent = isRegister
    ? "Join an event or start organizing your own."
    : "Sign in to pick up where you left off.";
  $("#nameField").classList.toggle("hidden", !isRegister);
  $("#roleField").classList.toggle("hidden", !isRegister);
  $("#nameField input").required = isRegister;
  $("#forgotPassword").classList.toggle("hidden", isRegister);
  $("#authSubmit").textContent = isRegister ? "Create account" : "Sign in";
  $("#authError").textContent = "";
  $("#authNotice").textContent = "";
}

function showAuth() {
  $("#appShell").classList.add("hidden");
  $("#publicLanding").classList.add("hidden");
  $("#emailVerificationScreen").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
}

function showEmailVerification(token) {
  emailVerificationToken = token;
  $("#authScreen").classList.add("hidden");
  $("#publicLanding").classList.add("hidden");
  $("#appShell").classList.add("hidden");
  $("#emailVerificationScreen").classList.remove("hidden");
  $("#emailVerificationError").textContent = "";
  $("#emailVerificationMessage").textContent = "Verify the address to activate the account or confirm your event registration.";
  $("#confirmEmailButton").classList.remove("hidden");
  $("#verificationReturnToSignIn").classList.add("hidden");
}

async function showPublicDirectory() {
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.add("hidden");
  $("#publicLanding").classList.remove("hidden");
  $("#emailVerificationScreen").classList.add("hidden");
  $("#landingTitle").textContent = "Find your next gathering";
  $("#landingDescription").textContent = "Browse upcoming public events and save your place—no account required.";
  $("#landingMeta").classList.add("hidden");
  $("#landingRegister").classList.add("hidden");
  $("#landingRegister").disabled = false;
  $("#backToEvents").classList.add("hidden");
  $("#publicDirectoryList").classList.remove("hidden");
  $("#landingError").textContent = "";
  try {
    const result = await api("/api/public/events");
    publicDirectory = result.events;
    $("#publicDirectoryList").innerHTML = publicDirectory.length
      ? publicDirectory.map(event => `
        <article class="public-event-row public-directory-row">
          ${event.bannerUrl ? `<img class="public-event-banner" src="${escapeHtml(event.bannerUrl)}" alt="" />` : ""}
          <div class="event-date-mark"><strong>${escapeHtml(new Date(event.starts_at).toLocaleDateString(undefined, { day: "2-digit" }))}</strong><small>${escapeHtml(new Date(event.starts_at).toLocaleDateString(undefined, { month: "short" }))}</small></div>
          <div class="public-event-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(formatDate(event.starts_at))} · ${escapeHtml(event.location)}</small></div>
          <span class="event-status ${statusStyle(event.status)}">${escapeHtml(statusLabel(event.status))}</span>
          <button class="secondary" data-public-event="${escapeHtml(event.id)}">View event</button>
        </article>`).join("")
      : `<div class="empty-state">No public events are available yet. Check back soon.</div>`;
  } catch (error) {
    $("#landingError").textContent = error.message;
  }
}

async function showApp() {
  $("#authScreen").classList.add("hidden");
  $("#publicLanding").classList.add("hidden");
  $("#emailVerificationScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  $("#profileName").textContent = user.name;
  $("#profileRole").textContent = user.role.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
  $("#profileAvatar").textContent = user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  $("#greeting").textContent = `Welcome, ${user.name.split(/\s+/)[0]}`;
  const canManage = ["ORGANIZER", "PLATFORM_ADMIN"].includes(user.role);
  $("#headerAction").classList.toggle("hidden", !canManage);
  $("#createEvent").classList.toggle("hidden", !canManage);
  $("#addAttendee").classList.toggle("hidden", !canManage);
  $("#shareEvent").classList.toggle("hidden", !currentEvent);
  $$("[data-view='checkin'], [data-view='people']").forEach(button => button.classList.toggle("hidden", user.role === "ATTENDEE"));
  selectView(user.role === "ATTENDEE" ? "events" : "overview");
  await refreshWorkspace().catch(showFatalError);
  if (canManage) startDashboardPolling();
}

function showFatalError(error) {
  showToast(error.message);
}

async function refreshWorkspace() {
  const canManage = ["ORGANIZER", "PLATFORM_ADMIN"].includes(user.role);
  const [result, dashboardResult] = await Promise.all([
    api("/api/events"),
    canManage ? api("/api/dashboard") : Promise.resolve(null)
  ]);
  dashboard = dashboardResult;
  const selectedId = currentEvent?.id;
  events = result.events;
  currentEvent = events.find(event => event.id === selectedId) || events[0] || null;
  renderEventPicker();
  renderEventCards();
  const canManageAttendees = ["ORGANIZER", "PLATFORM_ADMIN"].includes(user.role);
  const isAssignedVolunteer = user.role === "VOLUNTEER" && currentEvent?.isVolunteer;
  $$("[data-view='checkin'], [data-view='people']").forEach(button =>
    button.classList.toggle("hidden", !canManageAttendees && !isAssignedVolunteer));
  if (currentEvent && (canManageAttendees || isAssignedVolunteer)) {
    const [attendeeResult, historyResult] = await Promise.all([
      api(`/api/events/${currentEvent.id}/attendees`),
      api(`/api/events/${currentEvent.id}/check-in-history`)
    ]);
    attendees = attendeeResult.attendees;
    checkinHistory = historyResult.history;
    renderAttendees();
    renderPeople();
    renderCheckinHistory();
    renderOverview();
    await syncOfflineCheckins();
  } else {
    attendees = [];
    checkinHistory = [];
    renderAttendees();
    renderPeople();
    renderCheckinHistory();
    renderOverview();
  }
}

async function refreshDashboard() {
  if (!user || !["ORGANIZER", "PLATFORM_ADMIN"].includes(user.role)) return;
  dashboard = await api("/api/dashboard");
  renderOverview();
}

function startDashboardPolling() {
  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshDashboard().catch(error => showToast(`Dashboard refresh failed: ${error.message}`));
  }, 30000);
}

function renderEventPicker() {
  const picker = $("#eventPicker");
  if (!events.length) {
    picker.innerHTML = `<option value="">${user.role === "ATTENDEE" ? "Browse events" : "No events yet"}</option>`;
    picker.disabled = true;
    return;
  }
  picker.disabled = false;
  picker.innerHTML = events.map(event =>
    `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)}</option>`).join("");
  picker.value = currentEvent?.id || events[0].id;
}

function renderOverview() {
  const publicMode = ["ATTENDEE", "VOLUNTEER"].includes(user.role);
  const isVolunteer = user.role === "VOLUNTEER";
  const canManage = ["ORGANIZER", "PLATFORM_ADMIN"].includes(user.role);
  $("#overviewEyebrow").textContent = publicMode
    ? (isVolunteer ? "VOLUNTEER OPPORTUNITIES" : "UPCOMING EVENTS")
    : "YOUR WORKSPACE";
  $("#overviewSubtitle").textContent = publicMode
    ? (isVolunteer ? "Find an event and join its volunteer team." : "Find a gathering and save your place.")
    : "Organization-wide activity across your events.";
  $("#publicEventsPanel").classList.toggle("hidden", !publicMode);
  if (publicMode) {
    $(".panel-header h2", $("#publicEventsPanel")).textContent = isVolunteer ? "Volunteer opportunities" : "Discover events";
    $(".panel-header p", $("#publicEventsPanel")).textContent = isVolunteer
      ? "Join an upcoming event team"
      : "Upcoming GatherFlow events";
    $("#eventBanner").classList.add("hidden");
    $("#statsGrid").classList.add("hidden");
    $(".dashboard-grid").classList.add("hidden");
    $("#dashboardChartPanel").classList.add("hidden");
    $("#publicEventList").innerHTML = events.length
      ? events.map(event => `
        <article class="public-event-row">
          ${event.bannerUrl ? `<img class="public-event-banner" src="${escapeHtml(event.bannerUrl)}" alt="" />` : ""}
          <div class="event-date-mark"><strong>${escapeHtml(new Date(event.starts_at).toLocaleDateString(undefined, { day: "2-digit" }))}</strong><small>${escapeHtml(new Date(event.starts_at).toLocaleDateString(undefined, { month: "short" }))}</small></div>
          <div class="public-event-copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(formatDate(event.starts_at))} · ${escapeHtml(event.location)}</small></div>
          <span class="event-status ${statusStyle(event.status)}">${escapeHtml(statusLabel(event.status))}</span>
          ${isVolunteer
            ? `<button class="primary" data-join-volunteer="${escapeHtml(event.id)}" ${event.isVolunteer || !event.canVolunteer ? "disabled" : ""}>${event.isVolunteer ? "You're volunteering" : event.canVolunteer ? "Join as volunteer" : "Sign-up closed"}</button>`
            : `<button class="primary" data-register="${escapeHtml(event.id)}" ${event.canRegister ? "" : "disabled"}>${event.canRegister ? "Register" : statusLabel(event.status)}</button>`}
        </article>`).join("")
      : `<div class="empty-state">${isVolunteer ? "No upcoming volunteer opportunities are available yet." : "No events are open for registration just yet."}</div>`;
    $("#shareEvent").classList.add("hidden");
    return;
  }
  $(".dashboard-grid").classList.remove("hidden");
  $("#dashboardChartPanel").classList.toggle("hidden", !canManage);
  $("#eventBanner").classList.toggle("hidden", !currentEvent && !canManage);
  $("#statsGrid").classList.toggle("hidden", !canManage);
  $("#shareEvent").classList.toggle("hidden", !currentEvent || !["PUBLISHED", "REGISTRATION_CLOSED"].includes(currentEvent.status));
  if (!currentEvent) {
    $("#greeting").textContent = "Your next gathering starts here";
    $("#eventBanner").innerHTML = `<div class="empty-state"><strong>No events yet</strong><span>Create your first event, then share its registration link with your community.</span><button class="primary" data-create-event>Create an event</button></div>`;
  } else {
    $("#greeting").textContent = `Welcome back, ${user.name.split(/\s+/)[0]}`;
    $("#eventBanner").innerHTML = `
      <div class="event-banner-copy"><span class="event-status ${statusStyle(currentEvent.status)}">${escapeHtml(statusLabel(currentEvent.status))}</span><h2>${escapeHtml(currentEvent.title)}</h2><p>${escapeHtml(currentEvent.description || "Bring your community together.")}</p>
        <div class="event-meta"><span>◷ ${escapeHtml(formatDate(currentEvent.starts_at))}</span><span>⌖ ${escapeHtml(currentEvent.location)}</span><span>♧ ${currentEvent.capacity} places</span></div></div>
      ${canManage ? `<button class="secondary volunteer-button" id="manageVolunteers">Manage volunteers</button>` : ""}`;
  }
  if (canManage) renderOrganizerDashboard();
}

function renderOrganizerDashboard() {
  const metrics = dashboard?.metrics || {
    publishedEvents: 0,
    registrations: 0,
    checkedIn: 0,
    pendingArrivals: 0,
    walkInRegistrations: 0,
    attendanceRate: 0
  };
  const attendance = Number(metrics.attendanceRate) || 0;
  $("#statsGrid").innerHTML = `
    <article class="stat-card"><div class="stat-top"><span>Published events</span></div><strong>${Number(metrics.publishedEvents) || 0}</strong><div class="stat-note">Across your organization</div></article>
    <article class="stat-card"><div class="stat-top"><span>Registrations</span></div><strong>${Number(metrics.registrations) || 0}</strong><div class="stat-note">Active attendee registrations</div></article>
    <article class="stat-card"><div class="stat-top"><span>Checked in</span></div><strong>${Number(metrics.checkedIn) || 0}</strong><div class="stat-note">Verified arrivals</div></article>
    <article class="stat-card"><div class="stat-top"><span>Pending arrivals</span></div><strong>${Number(metrics.pendingArrivals) || 0}</strong><div class="stat-note">Registered, not yet checked in</div></article>
    <article class="stat-card"><div class="stat-top"><span>Walk-in registrations</span></div><strong>${Number(metrics.walkInRegistrations) || 0}</strong><div class="stat-note">Added by event staff on site</div></article>
    <article class="stat-card"><div class="stat-top"><span>Attendance rate</span><span class="trend positive">${attendance}%</span></div><strong>${attendance}%</strong><div class="mini-progress"><div class="green" style="width:${Math.min(100, attendance)}%"></div></div><small>Checked in / active registrations</small></article>`;

  const registrations = dashboard?.recentRegistrations || [];
  $("#recentList").innerHTML = registrations.length
    ? registrations.map(item => `<div class="activity-row"><div class="person-avatar ${avatarColor(item.name)}">${escapeHtml(initials(item.name))}</div><div><strong>${escapeHtml(item.name)} · ${escapeHtml(item.event_title)}</strong><small>${escapeHtml(item.group_name || item.email)} · ${item.registration_source === "WALK_IN" ? "Walk-in" : "Online"}</small></div><time>${escapeHtml(relativeTime(item.registered_at))}</time></div>`).join("")
    : `<div class="empty-state">Recent registrations will appear here.</div>`;

  const checkIns = dashboard?.recentCheckIns || [];
  $("#recentCheckinList").innerHTML = checkIns.length
    ? checkIns.map(item => `<div class="activity-row"><div class="person-avatar ${avatarColor(item.attendee_name)}">${escapeHtml(initials(item.attendee_name))}</div><div><strong>${escapeHtml(item.attendee_name)} · ${escapeHtml(item.event_title)}</strong><small>${escapeHtml(item.actor_name || "Staff")} · ${escapeHtml(item.method.replaceAll("_", " ").toLowerCase())}</small></div><time>${escapeHtml(relativeTime(item.checked_in_at))}</time></div>`).join("")
    : `<div class="empty-state">Recent check-ins will appear here.</div>`;

  const performance = dashboard?.eventPerformance || [];
  $("#eventPerformanceList").innerHTML = performance.length
    ? performance.map(item => {
      const capacity = Math.max(1, Number(item.capacity) || 0);
      const registered = Number(item.registered) || 0;
      const checkedIn = Number(item.checked_in) || 0;
      const registrationWidth = Math.min(100, registered / capacity * 100);
      const checkedInWidth = Math.min(100, checkedIn / capacity * 100);
      return `<article class="performance-row">
        <div class="performance-heading"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(statusLabel(item.status))}</span></div>
        <div class="performance-bar-row"><small>Registrations</small><div class="performance-track"><i class="registration-fill" style="width:${registrationWidth}%"></i></div><b>${registered}/${Number(item.capacity)}</b></div>
        <div class="performance-bar-row"><small>Checked in</small><div class="performance-track"><i class="checkin-fill" style="width:${checkedInWidth}%"></i></div><b>${checkedIn}</b></div>
      </article>`;
    }).join("")
    : `<div class="empty-state">Event performance will appear once events are created.</div>`;
}

function renderEventCards() {
  const canManage = ["ORGANIZER", "PLATFORM_ADMIN"].includes(user.role);
  $(".view-heading .page-subtitle", $("#eventsView")).textContent = user.role === "VOLUNTEER"
    ? "Browse upcoming events and join a volunteer team."
    : user.role === "ATTENDEE"
      ? "Browse upcoming events and register to attend."
      : "Create events and share a link to register.";
  $("#eventCards").innerHTML = events.length
    ? events.map(event => `<article class="panel event-card">
      ${event.bannerUrl ? `<img class="event-card-banner" src="${escapeHtml(event.bannerUrl)}" alt="" />` : ""}
      <div class="event-card-top"><span class="event-status ${statusStyle(event.status)}">${escapeHtml(statusLabel(event.status))}</span><span class="event-card-capacity">${event.registered} / ${event.capacity} registered</span></div>
      <h2>${escapeHtml(event.title)}</h2><p>${escapeHtml(event.description || "No description yet.")}</p>
      <div class="event-meta"><span>◷ ${escapeHtml(formatDate(event.starts_at))}</span><span>⌖ ${escapeHtml(event.location)}</span>${event.registration_end_at ? `<span>Registration ends ${escapeHtml(formatDate(event.registration_end_at))}</span>` : ""}</div>
      <div class="event-card-actions">${canManage
        ? `<button class="secondary" data-edit-event="${escapeHtml(event.id)}">Edit</button>
          ${event.storedStatus === "DRAFT" ? `<button class="primary" data-event-status="PUBLISHED" data-status-event="${escapeHtml(event.id)}">Publish</button><button class="secondary" data-event-status="CANCELLED" data-status-event="${escapeHtml(event.id)}">Cancel event</button>` : ""}
          ${event.storedStatus === "PUBLISHED" ? `<button class="secondary" data-event-status="DRAFT" data-status-event="${escapeHtml(event.id)}">Unpublish</button><button class="secondary" data-event-status="REGISTRATION_CLOSED" data-status-event="${escapeHtml(event.id)}">Close registration</button><button class="secondary" data-event-status="COMPLETED" data-status-event="${escapeHtml(event.id)}">Mark completed</button><button class="secondary" data-event-status="CANCELLED" data-status-event="${escapeHtml(event.id)}">Cancel event</button>` : ""}
          ${event.storedStatus === "REGISTRATION_CLOSED" ? `<button class="primary" data-event-status="PUBLISHED" data-status-event="${escapeHtml(event.id)}">Reopen registration</button><button class="secondary" data-event-status="COMPLETED" data-status-event="${escapeHtml(event.id)}">Mark completed</button><button class="secondary" data-event-status="CANCELLED" data-status-event="${escapeHtml(event.id)}">Cancel event</button>` : ""}
          ${event.storedStatus === "CANCELLED" ? `<button class="secondary" data-event-status="DRAFT" data-status-event="${escapeHtml(event.id)}">Restore draft</button>` : ""}
          ${["PUBLISHED","REGISTRATION_CLOSED"].includes(event.status) ? `<button class="secondary" data-copy-event="${escapeHtml(event.id)}">Copy registration link</button>` : ""}
          <button class="text-button" data-manage-volunteers="${escapeHtml(event.id)}">Volunteers</button>
          <button class="text-button danger-text" data-archive-event="${escapeHtml(event.id)}">Archive</button>`
        : user.role === "VOLUNTEER"
          ? `${event.isVolunteer
            ? `<button class="secondary" disabled>You're volunteering</button><button class="text-button danger-text" data-leave-volunteer="${escapeHtml(event.id)}">Leave team</button>`
            : `<button class="primary" data-join-volunteer="${escapeHtml(event.id)}" ${event.canVolunteer ? "" : "disabled"}>${event.canVolunteer ? "Join as volunteer" : "Sign-up closed"}</button>`}`
          : `<button class="primary" data-register="${escapeHtml(event.id)}" ${event.canRegister ? "" : "disabled"}>${event.canRegister ? "Register" : statusLabel(event.status)}</button>`}
        <button class="text-button" data-select-event="${escapeHtml(event.id)}">Open overview</button>
      </div></article>`).join("")
    : `<div class="panel empty-state"><strong>${canManage ? "No events yet" : user.role === "VOLUNTEER" ? "No volunteer opportunities yet" : "No events available"}</strong><span>${canManage ? "Create your first event to get started." : user.role === "VOLUNTEER" ? "Upcoming events will appear here when organizers publish them." : "Check back when organizers publish upcoming events."}</span>${canManage ? `<button class="primary" data-create-event>Create your first event</button>` : ""}</div>`;
}

function statusLabel(status) {
  return ({
    DRAFT: "Draft",
    PUBLISHED: "Published",
    REGISTRATION_CLOSED: "Registration closed",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled"
  })[status] || status;
}

function statusStyle(status) {
  return `status-${String(status || "").toLowerCase().replaceAll("_", "-")}`;
}

function renderAttendees() {
  const list = $("#attendeeList");
  const search = $("#attendeeSearch").value.trim().toLowerCase();
  const offlineIds = new Set(getOfflineCheckins().filter(item => item.eventId === currentEvent?.id).map(item => item.registrationId));
  const rows = attendees.map(person =>
    offlineIds.has(person.id) && person.status === "REGISTERED"
      ? { ...person, status: "CHECKED_IN", pendingOffline: true }
      : person);
  $("#allCount").textContent = rows.length;
  $("#registeredCount").textContent = rows.filter(person => person.status === "REGISTERED").length;
  $("#checkedCount").textContent = rows.filter(person => person.status === "CHECKED_IN").length;
  const filtered = rows.filter(person => {
    const matchesTab = activeFilter === "ALL" || person.status === activeFilter;
    const matchesSearch = `${person.id} ${person.name} ${person.email} ${person.phone} ${person.group_name} ${person.ticket_code}`.toLowerCase().includes(search);
    return matchesTab && matchesSearch;
  });
  list.innerHTML = filtered.length ? filtered.map(person => `
    <button class="attendee-row ${person.id === selectedAttendeeId ? "selected" : ""}" data-attendee="${escapeHtml(person.id)}">
      <span class="person-avatar ${avatarColor(person.name)}">${escapeHtml(initials(person.name))}</span>
      <span class="attendee-copy"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.group_name || person.email)}</small></span>
      <span class="arrival-badge ${person.status === "CHECKED_IN" ? "done" : person.status === "CANCELLED" ? "cancelled" : ""}">${person.pendingOffline ? "Sync pending" : person.status === "CHECKED_IN" ? "Checked in" : person.status === "CANCELLED" ? "Cancelled" : "Registered"}</span>
    </button>`).join("") : `<div class="empty-state">No matching attendees.</div>`;
  const selected = rows.find(person => person.id === selectedAttendeeId);
  if (selected) renderAttendeeDetail(selected);
  else if (!filtered.some(person => person.id === selectedAttendeeId)) {
    selectedAttendeeId = filtered[0]?.id || null;
    if (filtered[0]) renderAttendeeDetail(filtered[0]);
    else $("#checkinDetail").innerHTML = `<div class="empty-detail"><span>♧</span><strong>Select an attendee</strong><small>Choose a person from the list to see their registration.</small></div>`;
  }
}

function renderAttendeeDetail(person) {
  const pending = getOfflineCheckins().some(item => item.eventId === currentEvent?.id && item.registrationId === person.id);
  const checkedIn = person.status === "CHECKED_IN" || pending;
  $("#checkinDetail").innerHTML = `
    <div class="selected-person"><span class="person-avatar ${avatarColor(person.name)} xl">${escapeHtml(initials(person.name))}</span><div><p>SELECTED ATTENDEE</p><h2>${escapeHtml(person.name)}</h2><small>${escapeHtml(person.email)}</small></div></div>
    <div class="detail-status ${person.status === "CANCELLED" ? "warning" : ""}"><span class="status-dot ${checkedIn ? "checked" : ""}"></span><div><strong>${person.status === "CANCELLED" ? "Registration cancelled" : pending ? "Check-in pending sync" : checkedIn ? "Checked in" : "Registered"}</strong><small>${person.checked_in_at ? `Arrived ${escapeHtml(formatDate(person.checked_in_at))}` : pending ? "Saved on this device" : "Not yet checked in"}</small></div></div>
    <dl class="detail-grid"><div><dt>Phone</dt><dd>${escapeHtml(person.phone || "—")}</dd></div><div><dt>Group</dt><dd>${escapeHtml(person.group_name || "Individual")}</dd></div><div><dt>Registration ID</dt><dd class="ticket-code">${escapeHtml(person.id)}</dd></div><div><dt>Ticket code</dt><dd class="ticket-code">${escapeHtml(person.ticket_code)}</dd></div><div><dt>Registered</dt><dd>${escapeHtml(formatDate(person.registered_at))}</dd></div>${person.checked_in_at ? `<div><dt>Checked in by</dt><dd>${escapeHtml(person.checked_in_by_name || "Unknown staff")}</dd></div>` : ""}</dl>
    ${recoveryMode && person.status === "REGISTERED" && !pending ? `<label class="identity-verification"><input id="identityVerified" type="checkbox" /> I verified this attendee's identity</label>` : ""}
    <div class="quick-actions"><button class="checkin-btn" id="completeCheckin" ${checkedIn || person.status === "CANCELLED" ? "disabled" : ""}>${person.status === "CANCELLED" ? "Cancelled ticket" : checkedIn ? "Already checked in" : recoveryMode ? "Verify and check in" : "Complete manual check-in"}</button></div>`;
}

function renderCheckinHistory() {
  const list = $("#checkinHistoryList");
  if (!list) return;
  list.innerHTML = checkinHistory.length
    ? checkinHistory.map(item => `
      <article class="checkin-history-row">
        <div><strong>${escapeHtml(item.attendee_name)}</strong><small>${escapeHtml(item.actor_name)} · ${escapeHtml(item.method.replaceAll("_", " ").toLowerCase())}${item.identity_verified ? " · identity verified" : ""}</small></div>
        <time>${escapeHtml(formatDate(item.checked_in_at))}</time>
      </article>`).join("")
    : `<div class="empty-state">No check-ins recorded for this event yet.</div>`;
}

function showCheckinFeedback(message, kind = "success") {
  const feedback = $("#checkinFeedback");
  feedback.textContent = message;
  feedback.className = `checkin-feedback ${kind}`;
}

function stopQrScanner() {
  scannerControls?.stop();
  scannerControls = null;
  const video = $("#qrVideo");
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  $("#scannerPanel").classList.add("hidden");
  setButtonBusy($("#startQrScanner"));
}

async function startQrScanner() {
  if (scannerControls) return;
  if (!currentEvent) return showCheckinFeedback("Select an event before scanning tickets.", "warning");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return showCheckinFeedback("Camera scanning requires a secure page (HTTPS or localhost) and camera access.", "error");
  }
  const Reader = window.ZXingBrowser?.BrowserMultiFormatReader;
  if (!Reader) {
    return showCheckinFeedback("The QR scanner could not load. Refresh the page and try again.", "error");
  }
  $("#checkinFeedback").classList.add("hidden");
  $("#scannerPanel").classList.remove("hidden");
  $("#scannerMessage").textContent = "Allow camera access and point it at the attendee's ticket.";
  setButtonBusy($("#startQrScanner"), "Starting camera…");
  try {
    const reader = new Reader();
    scannerControls = await reader.decodeFromConstraints(
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      $("#qrVideo"),
      (result, error) => {
        if (result && !ticketScanBusy) {
          ticketScanBusy = true;
          const ticketCode = result.getText();
          stopQrScanner();
          void checkInTicket({ ticketCode, method: "QR_SCAN" }).finally(() => {
            ticketScanBusy = false;
          });
        } else if (error && !["NotFoundException", "ChecksumException", "FormatException"].includes(error.name)) {
          $("#scannerMessage").textContent = `Scanner issue: ${error.message || "Unable to read this camera frame."}`;
        }
      }
    );
  } catch (error) {
    $("#scannerMessage").textContent = error.message || "Could not start the camera.";
    showCheckinFeedback($("#scannerMessage").textContent, "error");
    stopQrScanner();
  }
}

function setRecoveryMode(enabled) {
  recoveryMode = enabled;
  $("#toggleRecovery").textContent = enabled ? "Exit attendee recovery" : "Recover without QR";
  $("#recoveryNotice").classList.toggle("hidden", !enabled);
  if (enabled) {
    $("#attendeeSearch").value = "";
    selectedAttendeeId = null;
    activeFilter = "ALL";
    $$(".search-tabs button").forEach(button => {
      const active = button.dataset.filter === "ALL";
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    showCheckinFeedback("Recovery mode: select the matching registration and verify the attendee's identity.", "info");
  } else {
    $("#checkinFeedback").classList.add("hidden");
  }
  renderAttendees();
  $("#attendeeSearch").focus();
}

async function checkInTicket(payload) {
  try {
    const result = await api(`/api/events/${currentEvent.id}/check-in`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    selectedAttendeeId = result.attendee.id;
    if (recoveryMode) setRecoveryMode(false);
    showCheckinFeedback(`${result.attendee.name} checked in successfully.`, "success");
    try {
      await refreshWorkspace();
    } catch (error) {
      showToast(`Check-in saved, but attendee details could not refresh: ${error.message}`);
    }
  } catch (error) {
    const kind = /already been checked in|cancelled/i.test(error.message) ? "warning" : "error";
    showCheckinFeedback(error.message, kind);
  }
}

function renderPeople() {
  const search = $("#peopleSearch").value.trim().toLowerCase();
  const filtered = attendees.filter(person => `${person.name} ${person.email} ${person.group_name} ${person.ticket_code}`.toLowerCase().includes(search));
  const groups = new Map();
  attendees.forEach(person => {
    if (person.group_name) groups.set(person.group_name, (groups.get(person.group_name) || 0) + 1);
  });
  $("#peopleCount").textContent = `${attendees.length} ${attendees.length === 1 ? "attendee" : "attendees"}`;
  $("#peopleHint").textContent = `${groups.size} ${groups.size === 1 ? "group" : "groups"} · ${attendees.filter(person => person.status === "CHECKED_IN").length} checked in`;
  $("#peopleList").innerHTML = filtered.length
    ? filtered.map(person => `<div class="people-row"><span class="person-avatar ${avatarColor(person.name)}">${escapeHtml(initials(person.name))}</span><span class="attendee-copy"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.email)}</small></span><span class="group-cell">${escapeHtml(person.group_name || "Individual")}</span><span class="arrival-badge ${person.status === "CHECKED_IN" ? "done" : ""}">${person.status === "CHECKED_IN" ? "Checked in" : "Registered"}</span></div>`).join("")
    : `<div class="empty-state">No matching attendees.</div>`;
}

function selectView(name) {
  $$(".nav-item[data-view]").forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `${name}View`));
  if (name === "checkin") $("#attendeeSearch").focus();
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date to be announced" : date.toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short"
  });
}

function relativeTime(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

function avatarColor(name) {
  const colors = ["coral", "lavender", "teal", "blue"];
  return colors[[...name].reduce((total, char) => total + char.charCodeAt(0), 0) % colors.length];
}

function renderQuestionFields(questions, container, personIndex) {
  container.innerHTML = questions.map(question => {
    const required = question.required ? "required" : "";
    const fieldName = `question_${personIndex}_${question.id}`;
    if (question.type === "select") {
      return `<label class="form-field custom-question">${escapeHtml(question.label)}${question.required ? " *" : ""}
        <select name="${fieldName}" data-question-id="${escapeHtml(question.id)}" ${required}>
          <option value="">Choose an answer</option>${question.options.map(option => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}
        </select></label>`;
    }
    if (question.type === "checkbox") {
      return `<label class="form-field checkbox-field custom-checkbox"><input type="checkbox" name="${fieldName}" data-question-id="${escapeHtml(question.id)}" ${required} />${escapeHtml(question.label)}${question.required ? " *" : ""}</label>`;
    }
    const tag = question.type === "textarea" ? "textarea" : "input";
    const valueField = question.type === "textarea"
      ? `<textarea name="${fieldName}" rows="2" maxlength="500" data-question-id="${escapeHtml(question.id)}" ${required}></textarea>`
      : `<input name="${fieldName}" maxlength="500" data-question-id="${escapeHtml(question.id)}" ${required} />`;
    return `<label class="form-field custom-question">${escapeHtml(question.label)}${question.required ? " *" : ""}${valueField}</label>`;
  }).join("");
}

function readQuestionAnswers(container) {
  return Object.fromEntries($$("[data-question-id]", container).map(field => [
    field.dataset.questionId,
    field.type === "checkbox" ? field.checked : field.value.trim()
  ]));
}

function openRegistration(event) {
  currentRegistrationEvent = event;
  $("#registrationForm").reset();
  $("#guestFields").replaceChildren();
  $("#registrationTitle").textContent = `Register for ${event.title}`;
  $("#registrationDescription").textContent = `${formatDate(event.starts_at)} · ${event.location} · ${Math.max(0, event.capacity - event.registered)} places remaining`;
  $("#registrationForm").dataset.eventId = event.id;
  $("#registrationForm").dataset.questions = JSON.stringify(event.questions || []);
  renderQuestionFields(event.questions || [], $("#primaryQuestionFields"), "primary");
  $("#registrationForm").querySelector('[name="phone"]').required = true;
  $("#registrationDialog").showModal();
}

function showPublicLanding(event) {
  window.publicEvent = event;
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.add("hidden");
  $("#emailVerificationScreen").classList.add("hidden");
  $("#publicLanding").classList.remove("hidden");
  $("#publicDirectoryList").classList.add("hidden");
  $("#landingMeta").classList.remove("hidden");
  $("#landingRegister").classList.remove("hidden");
  $("#backToEvents").classList.remove("hidden");
  $("#landingTitle").textContent = event.title;
  $("#landingDescription").textContent = event.description || "Join us for a community gathering.";
  $("#landingMeta").innerHTML = `${event.bannerUrl ? `<img class="landing-banner" src="${escapeHtml(event.bannerUrl)}" alt="" />` : ""}<span>◷ ${escapeHtml(formatDate(event.starts_at))}</span><span>⌖ ${escapeHtml(event.location)}</span><span>♧ ${Math.max(0, event.capacity - event.registered)} places remaining</span>${event.registration_start_at ? `<span>Registration opens ${escapeHtml(formatDate(event.registration_start_at))}</span>` : ""}${event.registration_end_at ? `<span>Registration closes ${escapeHtml(formatDate(event.registration_end_at))}</span>` : ""}`;
  $("#landingRegister").disabled = !event.canRegister;
  $("#landingRegister").textContent = event.canRegister ? "Register for this event" : statusLabel(event.status);
}

function showTicketConfirmation(result, allowCancellations) {
  ticketConfirmation = result.confirmationCode;
  $("#confirmationCode").textContent = result.confirmationCode;
  $("#ticketCodes").innerHTML = result.registrations.map(registration =>
    `<div class="ticket-card">
      <img class="ticket-qr" src="${escapeHtml(registration.qrCode)}" alt="QR ticket for ${escapeHtml(registration.name)}" />
      <span>${escapeHtml(registration.name)}</span><code>${escapeHtml(registration.ticket_code)}</code>
    </div>`
  ).join("");
  $("#cancelRegistration").classList.toggle("hidden", !allowCancellations);
  $("#ticketDialog").showModal();
}

function openEventDialog() {
  const form = $("#eventForm");
  form.reset();
  editingEvent = null;
  form.dataset.bannerData = "";
  delete form.dataset.removeBanner;
  $("#eventDialogEyebrow").textContent = "NEW EVENT";
  $("#eventDialogTitle").textContent = "Create an event";
  form.querySelector('[type="submit"]').textContent = "Create event";
  $("#questionEditor").replaceChildren();
  $("#bannerPreviewWrap").classList.add("hidden");
  const localDate = dateTimeInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
  form.elements.startsAt.value = localDate;
  form.elements.startsAt.min = dateTimeInputValue(new Date());
  $("#eventDialog").showModal();
}

function dateTimeInputValue(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function editEvent(event) {
  const form = $("#eventForm");
  editingEvent = event;
  form.reset();
  form.dataset.eventId = event.id;
  form.dataset.bannerData = "";
  delete form.dataset.removeBanner;
  $("#eventDialogEyebrow").textContent = "EVENT DETAILS";
  $("#eventDialogTitle").textContent = "Edit event";
  form.querySelector('[type="submit"]').textContent = "Save changes";
  form.elements.startsAt.min = "";
  form.elements.title.value = event.title;
  form.elements.description.value = event.description || "";
  form.elements.startsAt.value = dateTimeInputValue(event.starts_at);
  form.elements.capacity.value = event.capacity;
  form.elements.location.value = event.location;
  form.elements.registrationStartAt.value = event.registration_start_at ? dateTimeInputValue(event.registration_start_at) : "";
  form.elements.registrationEndAt.value = event.registration_end_at ? dateTimeInputValue(event.registration_end_at) : "";
  form.elements.duplicatePolicy.value = event.duplicate_policy;
  form.elements.allowCancellations.checked = event.allow_cancellations;
  $("#questionEditor").innerHTML = (event.questions || []).map(questionEditorRow).join("");
  if (event.bannerUrl) {
    $("#bannerPreview").src = event.bannerUrl;
    $("#bannerPreviewWrap").classList.remove("hidden");
  } else {
    $("#bannerPreviewWrap").classList.add("hidden");
  }
  $("#eventDialog").showModal();
}

function questionEditorRow(question = {}) {
  const options = (question.options || []).join(", ");
  return `<div class="question-editor-row" data-question-row data-question-id="${escapeHtml(question.id || "")}">
    <label class="form-field">Question<input data-question-label value="${escapeHtml(question.label || "")}" maxlength="160" placeholder="What would you like to ask?" required /></label>
    <div class="question-controls">
      <label class="form-field">Answer type<select data-question-type>
        <option value="text" ${question.type === "text" || !question.type ? "selected" : ""}>Short answer</option>
        <option value="textarea" ${question.type === "textarea" ? "selected" : ""}>Long answer</option>
        <option value="select" ${question.type === "select" ? "selected" : ""}>Choose from a list</option>
        <option value="checkbox" ${question.type === "checkbox" ? "selected" : ""}>Yes / no</option>
      </select></label>
      <label class="required-toggle"><input data-question-required type="checkbox" ${question.required ? "checked" : ""} /> Required</label>
      <button class="icon-close remove-question" type="button" aria-label="Remove question">×</button>
    </div>
    <label class="form-field question-options ${question.type === "select" ? "" : "hidden"}">Options, separated by commas<input data-question-options value="${escapeHtml(options)}" maxlength="2000" placeholder="Option one, Option two" /></label>
  </div>`;
}

async function openVolunteerDialog(event) {
  $("#volunteerDialog").dataset.eventId = event.id;
  $("#volunteerForm").reset();
  $("#volunteerError").textContent = "";
  try {
    const result = await api(`/api/events/${event.id}/volunteers`);
    $("#volunteerList").innerHTML = result.volunteers.length
      ? result.volunteers.map(volunteer => `
        <div class="volunteer-row"><span><strong>${escapeHtml(volunteer.name)}</strong><small>${escapeHtml(volunteer.email)}</small></span>
          <button class="text-button danger-text" data-remove-volunteer="${escapeHtml(volunteer.id)}">Remove</button></div>`).join("")
      : `<div class="empty-state">No volunteers assigned to this event.</div>`;
    $("#volunteerDialog").showModal();
  } catch (error) {
    showToast(error.message);
  }
}

function getOfflineCheckins() {
  try {
    const items = JSON.parse(localStorage.getItem(offlineKey) || "[]");
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function saveOfflineCheckins(items) {
  localStorage.setItem(offlineKey, JSON.stringify(items));
}

async function syncOfflineCheckins() {
  if (!navigator.onLine || !sessionToken) return;
  const queued = getOfflineCheckins();
  if (!queued.length) return;
  const remaining = [];
  let synced = 0;
  let rejected = 0;
  for (const item of queued) {
    try {
      await api(`/api/events/${item.eventId}/check-in`, {
        method: "POST",
        body: JSON.stringify({
          registrationId: item.registrationId,
          method: item.method || "OFFLINE_SYNC",
          identityVerified: item.identityVerified === true
        })
      });
      synced += 1;
    } catch (error) {
      if (/already been checked in/i.test(error.message)) synced += 1;
      else if (/cancelled/i.test(error.message)) rejected += 1;
      else remaining.push(item);
    }
  }
  saveOfflineCheckins(remaining);
  if (rejected) showCheckinFeedback(`${rejected} queued check-in${rejected === 1 ? " was" : "s were"} rejected because the registration was cancelled.`, "warning");
  if (synced && currentEvent) {
    const [attendeeResult, historyResult] = await Promise.all([
      api(`/api/events/${currentEvent.id}/attendees`),
      api(`/api/events/${currentEvent.id}/check-in-history`)
    ]);
    attendees = attendeeResult.attendees;
    checkinHistory = historyResult.history;
    currentEvent.checkedIn = attendees.filter(person => person.status === "CHECKED_IN").length;
    renderAttendees();
    renderPeople();
    renderCheckinHistory();
    renderOverview();
    showToast(`${synced} offline ${synced === 1 ? "check-in" : "check-ins"} synced`);
  }
}

async function signOut() {
  stopQrScanner();
  clearInterval(dashboardRefreshTimer);
  localStorage.removeItem(tokenKey);
  sessionToken = "";
  user = null;
  events = [];
  currentEvent = null;
  dashboard = null;
  attendees = [];
  checkinHistory = [];
  recoveryMode = false;
  showAuth();
}

$$(".auth-tab").forEach(tab => tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode)));
$$("[role='tablist']").forEach(tablist => tablist.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const tabs = $$("[role='tab']", tablist);
  const selected = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
  if (!tabs.length || selected < 0) return;
  event.preventDefault();
  const offset = event.key === "ArrowRight" ? 1 : -1;
  const next = (selected + offset + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}));

$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
  const submit = $("#authSubmit");
  setButtonBusy(submit, authMode === "register" ? "Creating account…" : "Signing in…");
  $("#authError").textContent = "";
  $("#authNotice").textContent = "";
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify(values) });
    sessionToken = result.token;
    localStorage.setItem(tokenKey, sessionToken);
    user = result.user;
    form.reset();
    await showApp();
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    setButtonBusy(submit);
  }
});

$("#forgotPassword").addEventListener("click", () => {
  const form = $("#forgotPasswordForm");
  form.reset();
  form.elements.email.value = $("#authForm").elements.email.value;
  $("#forgotPasswordError").textContent = "";
  $("#forgotPasswordNotice").textContent = "";
  $("#developmentResetLink").classList.add("hidden");
  $("#forgotPasswordDialog").showModal();
  form.elements.email.focus();
});

$("#forgotPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  $("#forgotPasswordError").textContent = "";
  $("#forgotPasswordNotice").textContent = "";
  $("#developmentResetLink").classList.add("hidden");
  setButtonBusy(submitButton, "Sending…");
  try {
    const result = await api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: form.elements.email.value })
    });
    $("#forgotPasswordNotice").textContent = result.message;
    if (result.resetUrl) {
      const link = $("#developmentResetLink");
      link.href = result.resetUrl;
      link.classList.remove("hidden");
    }
  } catch (requestError) {
    $("#forgotPasswordError").textContent = requestError.message;
  } finally {
    setButtonBusy(submitButton);
  }
});

$("#resetPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  const error = $("#resetPasswordError");
  error.textContent = "";
  if (password !== form.elements.confirmation.value) {
    error.textContent = "The passwords do not match.";
    form.elements.confirmation.focus();
    return;
  }
  const submitButton = form.querySelector('[type="submit"]');
  setButtonBusy(submitButton, "Updating…");
  try {
    await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token: form.dataset.token, password })
    });
    form.closest("dialog").close();
    form.reset();
    delete form.dataset.token;
    showAuth();
    setAuthMode("login");
    showToast("Password updated. Sign in with your new password.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    setButtonBusy(submitButton);
  }
});

$("#browseEvents").addEventListener("click", showPublicDirectory);
$("#openAuth").addEventListener("click", () => {
  showAuth();
  setAuthMode("login");
});
$("#confirmEmailButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  $("#emailVerificationError").textContent = "";
  setButtonBusy(button, "Verifying…");
  try {
    const result = await api("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token: emailVerificationToken })
    });
    emailVerificationToken = "";
    if (result.kind === "ACCOUNT") {
      showAuth();
      setAuthMode("login");
      $("#authForm").elements.email.value = result.user.email;
      $("#authNotice").textContent = result.message;
      $("#verificationReturnToSignIn").classList.remove("hidden");
      return;
    }
    await showPublicDirectory();
    showTicketConfirmation(result, result.allowCancellations);
    showToast(result.message);
  } catch (error) {
    $("#emailVerificationError").textContent = error.message;
  } finally {
    setButtonBusy(button);
  }
});
$("#verificationReturnToSignIn").addEventListener("click", () => {
  showAuth();
  setAuthMode("login");
});
$("#backToEvents").addEventListener("click", showPublicDirectory);
$("#publicDirectoryList").addEventListener("click", async event => {
  const button = event.target.closest("[data-public-event]");
  if (!button) return;
  try {
    const result = await api(`/api/events/${button.dataset.publicEvent}`);
    showPublicLanding(result.event);
  } catch (error) {
    $("#landingError").textContent = error.message;
  }
});

$("#logoutButton").addEventListener("click", signOut);
$("#headerAction").addEventListener("click", openEventDialog);
$("#createEvent").addEventListener("click", openEventDialog);
$("#eventPicker").addEventListener("change", async event => {
  stopQrScanner();
  currentEvent = events.find(item => item.id === event.target.value) || null;
  selectedAttendeeId = null;
  await refreshWorkspace();
});
$$(".nav-item[data-view]").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.view !== "checkin") stopQrScanner();
  selectView(button.dataset.view);
}));
$$("[data-go]").forEach(button => button.addEventListener("click", () => selectView(button.dataset.go)));
$("#shareEvent").addEventListener("click", async () => {
  if (!currentEvent) return;
  const url = `${location.origin}/?event=${encodeURIComponent(currentEvent.id)}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Registration link copied");
  } catch {
    window.prompt("Copy this event registration link:", url);
  }
});
$("#addAttendee").addEventListener("click", () => {
  if (!currentEvent) return showToast("Create an event before adding attendees.");
  $("#attendeeForm").reset();
  $("#attendeeDialog").showModal();
});
$("#startQrScanner").addEventListener("click", startQrScanner);
$("#stopQrScanner").addEventListener("click", stopQrScanner);
$("#toggleRecovery").addEventListener("click", () => setRecoveryMode(!recoveryMode));
$("#attendeeSearch").addEventListener("input", () => {
  selectedAttendeeId = null;
  renderAttendees();
});
$("#peopleSearch").addEventListener("input", renderPeople);
$$(".search-tabs button").forEach(button => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  $$(".search-tabs button").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  renderAttendees();
}));

$("#attendeeList").addEventListener("click", event => {
  const row = event.target.closest("[data-attendee]");
  if (!row) return;
  selectedAttendeeId = row.dataset.attendee;
  renderAttendees();
});
$("#checkinDetail").addEventListener("click", async event => {
  if (event.target.id !== "completeCheckin") return;
  const person = attendees.find(item => item.id === selectedAttendeeId);
  if (!person || event.target.disabled) return;
  if (!currentEvent) return showCheckinFeedback("Select an event before checking in attendees.", "warning");
  const method = recoveryMode ? "RECOVERY" : "MANUAL";
  const identityVerified = $("#identityVerified")?.checked === true;
  if (method === "RECOVERY" && !identityVerified) {
    return showCheckinFeedback("Confirm that you verified the attendee's identity before continuing.", "warning");
  }
  setButtonBusy(event.target, recoveryMode ? "Verifying…" : "Checking in…");
  try {
    if (!navigator.onLine) {
      const queue = getOfflineCheckins();
      if (!queue.some(item => item.eventId === currentEvent.id && item.registrationId === person.id)) {
        queue.push({
          eventId: currentEvent.id,
          registrationId: person.id,
          method: method === "RECOVERY" ? "RECOVERY" : "OFFLINE_SYNC",
          identityVerified
        });
        saveOfflineCheckins(queue);
      }
      renderAttendees();
      showCheckinFeedback("Check-in saved on this device; it will sync when you're online.", "info");
      return;
    }
    selectedAttendeeId = person.id;
    await checkInTicket({ registrationId: person.id, method, identityVerified });
  } finally {
    setButtonBusy(event.target);
  }
});

$("#eventForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  const errorSlot = $('[data-error-for="eventForm"]');
  errorSlot.textContent = "";
  setButtonBusy(submitButton, editingEvent ? "Saving…" : "Creating…");
  try {
    const values = Object.fromEntries(new FormData(form));
    delete values.banner;
    values.capacity = Number(values.capacity);
    values.allowCancellations = form.elements.allowCancellations.checked;
    values.questions = $$("[data-question-row]", $("#questionEditor")).map(row => {
      const question = {
        id: row.dataset.questionId || crypto.randomUUID(),
        label: $("[data-question-label]", row).value.trim(),
        type: $("[data-question-type]", row).value,
        required: $("[data-question-required]", row).checked
      };
      if (question.type === "select") {
        question.options = $("[data-question-options]", row).value.split(",").map(option => option.trim()).filter(Boolean);
      }
      return question;
    });
    if (form.dataset.bannerData) values.bannerData = form.dataset.bannerData;
    if (form.dataset.removeBanner === "true") values.removeBanner = true;
    const result = editingEvent
      ? await api(`/api/events/${editingEvent.id}`, { method: "PATCH", body: JSON.stringify(values) })
      : await api("/api/events", { method: "POST", body: JSON.stringify(values) });
    form.closest("dialog").close();
    currentEvent = result.event;
    await refreshWorkspace();
    selectView("overview");
    showToast(editingEvent ? "Event details updated" : "Draft event created");
  } catch (error) {
    errorSlot.textContent = error.message;
  } finally {
    setButtonBusy(submitButton);
  }
});

$("#bannerInput").addEventListener("change", () => {
  const file = $("#bannerInput").files[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
    $("#bannerInput").value = "";
    return showToast("Choose a PNG, JPEG, or WebP image smaller than 2 MB.");
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    $("#eventForm").dataset.bannerData = String(reader.result);
    delete $("#eventForm").dataset.removeBanner;
    $("#bannerPreview").src = String(reader.result);
    $("#bannerPreviewWrap").classList.remove("hidden");
  });
  reader.addEventListener("error", () => showToast("Could not read the selected banner image."));
  reader.readAsDataURL(file);
});
$("#removeBanner").addEventListener("click", () => {
  $("#eventForm").dataset.bannerData = "";
  $("#eventForm").dataset.removeBanner = "true";
  $("#bannerInput").value = "";
  $("#bannerPreviewWrap").classList.add("hidden");
});
$("#addQuestion").addEventListener("click", () => {
  if ($$("[data-question-row]", $("#questionEditor")).length >= 20) return showToast("An event can have up to 20 registration questions.");
  $("#questionEditor").insertAdjacentHTML("beforeend", questionEditorRow());
});
$("#questionEditor").addEventListener("click", event => {
  if (event.target.closest(".remove-question")) event.target.closest("[data-question-row]").remove();
});
$("#questionEditor").addEventListener("change", event => {
  if (event.target.matches("[data-question-type]")) {
    $(".question-options", event.target.closest("[data-question-row]")).classList.toggle("hidden", event.target.value !== "select");
  }
});

$("#addGuest").addEventListener("click", () => {
  const rows = $$(".guest-field", $("#guestFields"));
  const count = rows.length;
  if (count >= 9) return showToast("A registration can include up to 10 people.");
  const row = document.createElement("section");
  row.className = "guest-field";
  row.dataset.personIndex = String(count);
  const questions = JSON.parse($("#registrationForm").dataset.questions || "[]");
  row.innerHTML = `<div class="guest-row-heading"><strong>Guest ${count + 1}</strong><button class="icon-close remove-guest" type="button" aria-label="Remove guest">×</button></div>
    <label class="form-field">Full name<input data-person-name required minlength="2" maxlength="100" /></label>
    <label class="form-field">Email address<input data-person-email type="email" required maxlength="254" /></label>
    <label class="form-field">Phone<input data-person-phone type="tel" required minlength="3" maxlength="40" /></label>
    <div class="guest-questions"></div>`;
  renderQuestionFields(questions, $(".guest-questions", row), `guest${count}`);
  $("#guestFields").append(row);
});
$("#guestFields").addEventListener("click", event => {
  if (event.target.closest(".remove-guest")) event.target.closest(".guest-field").remove();
});

$("#registrationForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  const errorSlot = $('[data-error-for="registrationForm"]');
  errorSlot.textContent = "";
  setButtonBusy(submitButton, "Registering…");
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);
  data.answers = readQuestionAnswers($("#primaryQuestionFields"));
  const guests = $$(".guest-field", form).map(row => ({
    name: $("[data-person-name]", row).value.trim(),
    email: $("[data-person-email]", row).value.trim(),
    phone: $("[data-person-phone]", row).value.trim(),
    answers: readQuestionAnswers($(".guest-questions", row))
  }));
  try {
    const result = await api(`/api/events/${form.dataset.eventId}/registrations`, {
      method: "POST",
      body: JSON.stringify({ ...data, attendees: guests })
    });
    form.closest("dialog").close();
    showTicketConfirmation(result, currentRegistrationEvent.allow_cancellations);
    showToast(result.message || "Registration complete. Save your ticket and confirmation.");
    if (!sessionToken) {
      const updated = await api(`/api/events/${currentRegistrationEvent.id}`);
      window.publicEvent = updated.event;
      $("#landingMeta").querySelectorAll(":scope > span:last-of-type").forEach(span => {
        span.textContent = `♧ ${Math.max(0, updated.event.capacity - updated.event.registered)} places remaining`;
      });
      $("#landingRegister").disabled = !updated.event.canRegister;
      $("#landingRegister").textContent = updated.event.canRegister ? "Register another attendee" : statusLabel(updated.event.status);
    } else {
      await refreshWorkspace();
    }
  } catch (error) {
    errorSlot.textContent = error.message;
  } finally {
    setButtonBusy(submitButton);
  }
});

$("#attendeeForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  const errorSlot = $('[data-error-for="attendeeForm"]');
  errorSlot.textContent = "";
  setButtonBusy(submitButton, "Adding attendee…");
  try {
    const values = Object.fromEntries(new FormData(form));
    values.source = "WALK_IN";
    await api(`/api/events/${currentEvent.id}/registrations`, { method: "POST", body: JSON.stringify(values) });
    form.closest("dialog").close();
    await refreshWorkspace();
    showToast("Attendee added");
  } catch (error) {
    errorSlot.textContent = error.message;
  } finally {
    setButtonBusy(submitButton);
  }
});

async function updateVolunteerSignup(eventId, joining, button) {
  setButtonBusy(button, joining ? "Joining…" : "Leaving…");
  try {
    await api(`/api/events/${eventId}/volunteers`, {
      method: joining ? "POST" : "DELETE",
      body: JSON.stringify({})
    });
    await refreshWorkspace();
    showToast(joining ? "You joined the volunteer team" : "You left the volunteer team");
  } catch (error) {
    showToast(error.message);
  } finally {
    setButtonBusy(button);
  }
}

$("#eventCards").addEventListener("click", async event => {
  if (event.target.closest("[data-create-event]")) return openEventDialog();
  const joinVolunteer = event.target.closest("[data-join-volunteer]");
  if (joinVolunteer) return updateVolunteerSignup(joinVolunteer.dataset.joinVolunteer, true, joinVolunteer);
  const leaveVolunteer = event.target.closest("[data-leave-volunteer]");
  if (leaveVolunteer) return updateVolunteerSignup(leaveVolunteer.dataset.leaveVolunteer, false, leaveVolunteer);
  const edit = event.target.closest("[data-edit-event]");
  if (edit) {
    const chosen = events.find(item => item.id === edit.dataset.editEvent);
    if (chosen) editEvent(chosen);
    return;
  }
  const statusButton = event.target.closest("[data-status-event]");
  if (statusButton) {
    const nextStatus = statusButton.dataset.eventStatus;
    const chosen = events.find(item => item.id === statusButton.dataset.statusEvent);
    if (["CANCELLED", "COMPLETED"].includes(nextStatus) &&
      !window.confirm(`${nextStatus === "CANCELLED" ? "Cancel" : "Mark"} “${chosen?.title || "this event"}” ${nextStatus === "CANCELLED" ? "and stop registrations?" : "as completed?"}`)) return;
    setButtonBusy(statusButton, "Updating…");
    try {
      await api(`/api/events/${statusButton.dataset.statusEvent}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus })
      });
      await refreshWorkspace();
      showToast("Event status updated");
    } catch (error) {
      showToast(error.message);
    } finally {
      setButtonBusy(statusButton);
    }
    return;
  }
  const archive = event.target.closest("[data-archive-event]");
  if (archive) {
    const chosen = events.find(item => item.id === archive.dataset.archiveEvent);
    if (!chosen || !window.confirm(`Archive “${chosen.title}”? Existing registrations will be retained.`)) return;
    try {
      await api(`/api/events/${chosen.id}`, { method: "DELETE" });
      if (currentEvent?.id === chosen.id) currentEvent = null;
      await refreshWorkspace();
      showToast("Event archived");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  const manage = event.target.closest("[data-manage-volunteers]");
  if (manage) {
    const chosen = events.find(item => item.id === manage.dataset.manageVolunteers);
    if (chosen) openVolunteerDialog(chosen);
    return;
  }
  const register = event.target.closest("[data-register]");
  if (register) {
    const chosen = events.find(item => item.id === register.dataset.register);
    if (chosen) openRegistration(chosen);
  }
  const copy = event.target.closest("[data-copy-event]");
  if (copy) {
    const chosen = events.find(item => item.id === copy.dataset.copyEvent);
    if (!chosen) return;
    const url = `${location.origin}/?event=${encodeURIComponent(chosen.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Registration link copied");
    } catch {
      window.prompt("Copy this event registration link:", url);
    }
  }
  const select = event.target.closest("[data-select-event]");
  if (select) {
    currentEvent = events.find(item => item.id === select.dataset.selectEvent) || null;
    await refreshWorkspace();
    selectView("overview");
  }
});
$("#publicEventList").addEventListener("click", event => {
  const joinVolunteer = event.target.closest("[data-join-volunteer]");
  if (joinVolunteer) return updateVolunteerSignup(joinVolunteer.dataset.joinVolunteer, true, joinVolunteer);
  const button = event.target.closest("[data-register]");
  const chosen = events.find(item => item.id === button?.dataset.register);
  if (chosen) openRegistration(chosen);
});
$("#landingRegister").addEventListener("click", () => {
  if (window.publicEvent?.canRegister) openRegistration(window.publicEvent);
});
$("#copyTickets").addEventListener("click", async () => {
  const codes = [
    `Registration confirmation: ${ticketConfirmation || ""}`,
    ...$$(".ticket-card code", $("#ticketCodes")).map(node => node.textContent)
  ].join("\n");
  try {
    await navigator.clipboard.writeText(codes);
    showToast("Ticket codes copied");
  } catch {
    window.prompt("Save your ticket codes:", codes);
  }
});
$("#cancelRegistration").addEventListener("click", async () => {
  if (!ticketConfirmation || !window.confirm("Cancel every attendee in this group registration?")) return;
  try {
    await api(`/api/registrations/${ticketConfirmation}/cancel`, { method: "POST", body: JSON.stringify({}) });
    $("#ticketDialog").close();
    showToast("Registration cancelled");
    const result = await api(`/api/events/${currentRegistrationEvent.id}`);
    if (!sessionToken) showPublicLanding(result.event);
    else await refreshWorkspace();
  } catch (error) {
    showToast(error.message);
  }
});
$("#volunteerForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');
  $("#volunteerError").textContent = "";
  setButtonBusy(submitButton, "Adding…");
  try {
    await api(`/api/events/${$("#volunteerDialog").dataset.eventId}/volunteers`, {
      method: "POST",
      body: JSON.stringify({ email: form.elements.email.value })
    });
    const volunteerEvent = events.find(item => item.id === $("#volunteerDialog").dataset.eventId);
    await openVolunteerDialog(volunteerEvent);
    showToast("Volunteer added to this event");
  } catch (error) {
    $("#volunteerError").textContent = error.message;
  } finally {
    setButtonBusy(submitButton);
  }
});
$("#volunteerList").addEventListener("click", async event => {
  const button = event.target.closest("[data-remove-volunteer]");
  if (!button) return;
  const volunteerName = button.closest(".volunteer-row").querySelector("strong").textContent;
  if (!window.confirm(`Remove ${volunteerName} from this event team?`)) return;
  setButtonBusy(button, "Removing…");
  const eventId = $("#volunteerDialog").dataset.eventId;
  try {
    await api(`/api/events/${eventId}/volunteers/${button.dataset.removeVolunteer}`, { method: "DELETE" });
    await openVolunteerDialog(events.find(item => item.id === eventId));
    showToast("Volunteer removed");
  } catch (error) {
    showToast(error.message);
  } finally {
    setButtonBusy(button);
  }
});
$("#eventBanner").addEventListener("click", async event => {
  if (event.target.closest("[data-create-event]")) return openEventDialog();
  if (event.target.id === "manageVolunteers" && currentEvent) openVolunteerDialog(currentEvent);
});

$$("[data-close]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
$$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
}));
$$("[data-create-event]").forEach(button => button.addEventListener("click", openEventDialog));
$$(".nav-item[data-view]").forEach(button => button.addEventListener("click", () => selectView(button.dataset.view)));
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("#appShell").classList.contains("hidden")) {
      selectView("checkin");
      $("#attendeeSearch").focus();
    }
  }
});
window.addEventListener("online", () => {
  updateNetworkStatus();
  syncOfflineCheckins();
});
window.addEventListener("offline", () => {
  updateNetworkStatus();
  showToast("Offline — check-ins will sync when you're back online.");
});
updateNetworkStatus();

async function boot() {
  const search = new URLSearchParams(location.search);
  const verificationToken = search.get("verifyEmail");
  if (verificationToken) {
    showEmailVerification(verificationToken);
    history.replaceState(null, "", "/");
    return;
  }
  const resetToken = search.get("token");
  if (location.pathname === "/reset-password" && resetToken) {
    const form = $("#resetPasswordForm");
    form.reset();
    form.dataset.token = resetToken;
    history.replaceState(null, "", "/");
    showAuth();
    $("#resetPasswordDialog").showModal();
    return;
  }
  const eventId = new URLSearchParams(location.search).get("event");
  if (!sessionToken) {
    if (!eventId) return showPublicDirectory();
    try {
      const result = await api(`/api/events/${eventId}`);
      showPublicLanding(result.event);
    } catch (error) {
      await showPublicDirectory();
      $("#landingError").textContent = error.message;
    }
    return;
  }
  try {
    const result = await api("/api/auth/me");
    user = result.user;
    await showApp();
    if (eventId) {
      const selected = events.find(event => event.id === eventId);
      if (selected) openRegistration(selected);
      else {
        const publicResult = await api(`/api/events/${eventId}`);
        openRegistration(publicResult.event);
      }
    }
  } catch {
    localStorage.removeItem(tokenKey);
    sessionToken = "";
    if (eventId) {
      try {
        const result = await api(`/api/events/${eventId}`);
        showPublicLanding(result.event);
      } catch (error) {
        showAuth();
        $("#authError").textContent = error.message;
      }
    } else {
      await showPublicDirectory();
    }
  }
}

boot();
