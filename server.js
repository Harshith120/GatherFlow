import { createServer as createHttpServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { Pool } from "pg";
import QRCode from "qrcode";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(root);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const imagePattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const eventStatuses = new Set(["DRAFT", "PUBLISHED", "REGISTRATION_CLOSED", "COMPLETED", "CANCELLED"]);
const rateLimitRules = [
  { method: "POST", path: "/api/auth/login", key: "login", limit: 10, windowMs: 15 * 60 * 1000 },
  { method: "POST", path: "/api/auth/register", key: "account-registration", limit: 10, windowMs: 60 * 60 * 1000 },
  { method: "POST", path: "/api/auth/resend-verification", key: "email-verification-resend", limit: 5, windowMs: 15 * 60 * 1000 },
  { method: "POST", path: "/api/auth/verify-email", key: "email-verification", limit: 20, windowMs: 15 * 60 * 1000 },
  { method: "POST", path: "/api/auth/forgot-password", key: "password-reset-request", limit: 5, windowMs: 15 * 60 * 1000 },
  { method: "POST", path: "/api/auth/reset-password", key: "password-reset", limit: 10, windowMs: 15 * 60 * 1000 },
  { method: "POST", path: /^\/api\/events\/[0-9a-f-]+\/registrations(?:\/resend-verification)?$/i, key: "public-registration", limit: 30, windowMs: 60 * 60 * 1000 },
  { method: "POST", path: /^\/api\/events\/[0-9a-f-]+\/check-in$/i, key: "check-in", limit: 300, windowMs: 60 * 1000 }
];

const localPartPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeEmail(value, message = "Enter a valid email address.") {
  const input = String(value || "").trim();
  const separator = input.lastIndexOf("@");
  if (separator <= 0 || separator !== input.indexOf("@")) fail(400, message);
  const localPart = input.slice(0, separator);
  const domain = domainToASCII(input.slice(separator + 1)).toLowerCase();
  const labels = domain.split(".");
  if (localPart.length > 64 || !localPartPattern.test(localPart) ||
    input.length > 254 || !domain || domain.length > 253 || labels.length < 2 ||
    labels.some(label => label.length > 63 || !domainLabelPattern.test(label)) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels[labels.length - 1])) {
    fail(400, message);
  }
  return `${localPart.toLowerCase()}@${domain}`;
}

async function hasMailRecords(domain) {
  try {
    const records = await resolveMx(domain);
    if (records.some(record => record.exchange !== ".")) return true;
    if (records.length) return false;
  } catch (error) {
    if (!["ENODATA", "ENOTFOUND"].includes(error.code)) throw error;
    if (error.code === "ENOTFOUND") return false;
  }

  const addressResults = await Promise.allSettled([resolve4(domain), resolve6(domain)]);
  if (addressResults.some(result => result.status === "fulfilled" && result.value.length)) return true;
  const temporaryFailure = addressResults.find(result =>
    result.status === "rejected" && !["ENODATA", "ENOTFOUND"].includes(result.reason?.code)
  );
  if (temporaryFailure) throw temporaryFailure.reason;
  return false;
}

async function requireMailDomain(email, emailDomainCheck) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  let canReceiveMail;
  try {
    canReceiveMail = await emailDomainCheck(domain);
  } catch (error) {
    if (error.status) throw error;
    fail(503, "We could not verify this email domain right now. Please try again.");
  }
  if (!canReceiveMail) fail(400, "This email domain cannot receive email. Check the address and try again.");
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function checkPassword(password, storedHash) {
  const [salt, key] = String(storedHash).split(":");
  if (!salt || !key) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function makeToken(user, secret) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    role: user.role,
    ver: user.token_version || 0,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
  })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}

function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const content = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(content).digest();
  try {
    const actual = Buffer.from(parts[2], "base64url");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (header.alg !== "HS256" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return payload;
  } catch {
    return null;
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function escapeEmailHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function jsonResponse(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...headers
  });
  response.end(JSON.stringify(value));
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()"
};

function getRateLimitRetryAfter(request, method, pathname, buckets) {
  const rule = rateLimitRules.find(candidate =>
    candidate.method === method &&
    (candidate.path instanceof RegExp ? candidate.path.test(pathname) : candidate.path === pathname)
  );
  if (!rule) return 0;
  const now = Date.now();
  const key = `${rule.key}:${request.socket.remoteAddress || "unknown"}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + rule.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 10000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  return bucket.count > rule.limit ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) : 0;
}

function parseCorsOrigins(config) {
  const origins = new Set((Array.isArray(config) ? config : String(config || "").split(","))
    .map(origin => String(origin).trim())
    .filter(Boolean));
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("CORS_ALLOWED_ORIGINS must contain valid HTTP or HTTPS origins.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("CORS_ALLOWED_ORIGINS must contain origins only, without paths or trailing slashes.");
    }
  }
  return origins;
}

function userView(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

function parseDate(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) fail(400, `${label} must be a valid date and time.`);
  return date.toISOString();
}

function parseImage(dataUrl) {
  if (dataUrl === null || dataUrl === undefined || dataUrl === "") return null;
  if (typeof dataUrl !== "string") fail(400, "Event banner must be a valid image.");
  const match = dataUrl.match(imagePattern);
  if (!match) fail(400, "Banner must be a PNG, JPEG, or WebP image.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) fail(400, "Event banner must be smaller than 2 MB.");
  const mime = `image/${match[1]}`;
  const validSignature = match[1] === "png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === "jpeg"
      ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) fail(400, "The selected file does not match its image format.");
  return { bytes, mime };
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length > 20) fail(400, "Add at most 20 registration questions.");
  const ids = new Set();
  return raw.map(question => {
    const id = String(question?.id || randomUUID());
    const label = String(question?.label || "").trim();
    const type = String(question?.type || "text");
    const required = question?.required === true;
    if (!/^[\w-]{1,80}$/.test(id) || ids.has(id)) fail(400, "Question identifiers must be unique.");
    if (label.length < 2 || label.length > 160) fail(400, "Question text must be between 2 and 160 characters.");
    if (!["text", "textarea", "select", "checkbox"].includes(type)) fail(400, "Choose a supported registration question type.");
    ids.add(id);
    if (type !== "select") return { id, label, type, required };
    const options = Array.isArray(question.options)
      ? question.options.map(option => String(option).trim()).filter(Boolean)
      : [];
    if (options.length < 2 || options.length > 20 || options.some(option => option.length > 100) ||
      new Set(options).size !== options.length) fail(400, `Question "${label}" needs 2–20 unique options.`);
    return { id, label, type, required, options };
  });
}

function validateAnswers(answers, questions) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) fail(400, "Provide answers to the event questions.");
  const result = {};
  for (const question of questions) {
    const value = answers[question.id];
    if (question.required && (value === undefined || value === null || value === "")) {
      fail(400, `Answer the required question: ${question.label}.`);
    }
    if (value === undefined || value === null || value === "") continue;
    if (question.type === "checkbox") {
      if (typeof value !== "boolean") fail(400, `Answer "${question.label}" with a yes or no.`);
      if (question.required && value !== true) fail(400, `Accept the required question: ${question.label}.`);
      result[question.id] = value;
      continue;
    }
    if (typeof value !== "string" || value.trim().length > 500) fail(400, `Answer "${question.label}" must be 500 characters or fewer.`);
    const normalized = value.trim();
    if (question.type === "select" && !question.options.includes(normalized)) {
      fail(400, `Choose a valid option for "${question.label}".`);
    }
    result[question.id] = normalized;
  }
  return result;
}

function validatePerson(person) {
  const name = String(person?.name || "").trim();
  const email = normalizeEmail(person?.email, `Enter a valid email address for ${name || "each attendee"}.`);
  const phone = String(person?.phone || "").trim();
  if (name.length < 2 || name.length > 100) fail(400, "Each attendee name must be between 2 and 100 characters.");
  if (phone.length < 3 || phone.length > 40) fail(400, `Enter a valid phone number for ${name}.`);
  return { name, email, phone };
}

function eventView(row) {
  const registered = Number(row.registered || 0);
  const checkedIn = Number(row.checked_in || 0);
  let status = row.status;
  if (status === "PUBLISHED" && (
    registered >= row.capacity ||
    (row.registration_end_at && new Date(row.registration_end_at).getTime() <= Date.now()) ||
    new Date(row.starts_at).getTime() <= Date.now()
  )) status = "REGISTRATION_CLOSED";
  const withinWindow = (!row.registration_start_at || new Date(row.registration_start_at).getTime() <= Date.now()) &&
    (!row.registration_end_at || new Date(row.registration_end_at).getTime() > Date.now()) &&
    new Date(row.starts_at).getTime() > Date.now();
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    starts_at: row.starts_at,
    location: row.location,
    capacity: row.capacity,
    status,
    storedStatus: row.status,
    registration_start_at: row.registration_start_at,
    registration_end_at: row.registration_end_at,
    questions: row.questions || [],
    duplicate_policy: row.duplicate_policy,
    allow_cancellations: row.allow_cancellations,
    archived_at: row.archived_at,
    created_at: row.created_at,
    registered,
    checkedIn,
    canRegister: row.status === "PUBLISHED" && withinWindow && registered < row.capacity,
    isVolunteer: row.is_volunteer === true,
    canVolunteer: row.is_volunteer !== true &&
      ["PUBLISHED", "REGISTRATION_CLOSED"].includes(row.status) &&
      new Date(row.starts_at).getTime() > Date.now(),
    bannerUrl: row.banner_mime ? `/api/events/${row.id}/banner` : null
  };
}

async function eventWithStats(pool, row) {
  const [stats, questions] = await Promise.all([
    pool.query(`
      SELECT COUNT(CASE WHEN r.status <> 'CANCELLED' THEN 1 END) AS registered,
        COUNT(CASE WHEN c.id IS NOT NULL AND r.status <> 'CANCELLED' THEN 1 END) AS checked_in
      FROM registrations r
      LEFT JOIN check_ins c ON c.registration_id=r.id
      WHERE r.event_id=$1
    `, [row.id]),
    pool.query(`
      SELECT question_id,label,question_type,is_required,options
      FROM event_questions WHERE event_id=$1 ORDER BY position
    `, [row.id])
  ]);
  const normalizedQuestions = questions.rows.map(question => {
    const result = {
      id: question.question_id,
      label: question.label,
      type: question.question_type,
      required: question.is_required
    };
    if (question.question_type === "select") result.options = question.options || [];
    return result;
  });
  return { ...row, ...stats.rows[0], questions: normalizedQuestions };
}

async function getEvent(pool, id, { includeArchived = false } = {}) {
  const result = await pool.query(
    `SELECT * FROM events WHERE id=$1 ${includeArchived ? "" : "AND archived_at IS NULL"}`,
    [id]
  );
  return result.rows[0] ? eventWithStats(pool, result.rows[0]) : null;
}

async function replaceEventQuestions(queryable, eventId, questions) {
  await queryable.query("DELETE FROM event_questions WHERE event_id=$1", [eventId]);
  for (let position = 0; position < questions.length; position += 1) {
    const question = questions[position];
    await queryable.query(`
      INSERT INTO event_questions (
        event_id,question_id,label,question_type,is_required,options,position
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
    `, [
      eventId, question.id, question.label, question.type, question.required,
      JSON.stringify(question.options || []), position
    ]);
  }
}

async function getEventQuestions(queryable, eventId) {
  const result = await queryable.query(`
    SELECT question_id,label,question_type,is_required,options
    FROM event_questions WHERE event_id=$1 ORDER BY position
  `, [eventId]);
  return result.rows.map(question => {
    const normalized = {
      id: question.question_id,
      label: question.label,
      type: question.question_type,
      required: question.is_required
    };
    if (question.question_type === "select") normalized.options = question.options || [];
    return normalized;
  });
}

async function ensureOrganization(client, user) {
  await client.query(`
    INSERT INTO organizations (id,name,created_by)
    VALUES ($1,$2,$3)
    ON CONFLICT (created_by) DO NOTHING
  `, [user.id, `${user.name} Organization`.slice(0, 120), user.id]);
  const organization = await client.query("SELECT id FROM organizations WHERE created_by=$1", [user.id]);
  if (!organization.rowCount) throw new Error("Could not create the organizer's organization.");
  await client.query(`
    INSERT INTO organization_members (organization_id,user_id,role)
    VALUES ($1,$2,'OWNER')
    ON CONFLICT (organization_id,user_id) DO NOTHING
  `, [organization.rows[0].id, user.id]);
  return organization.rows[0].id;
}

async function writeAuditLog(client, {
  eventId,
  actorId = null,
  action,
  entityType,
  entityId,
  metadata = {}
}) {
  await client.query(`
    INSERT INTO audit_logs (id,event_id,actor_id,action,entity_type,entity_id,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [randomUUID(), eventId, actorId, action, entityType, entityId, JSON.stringify(metadata)]);
}

async function removeVolunteerAssignment(pool, eventId, volunteerId, actorId, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removed = await client.query(
      "DELETE FROM volunteer_assignments WHERE event_id=$1 AND user_id=$2 RETURNING user_id",
      [eventId, volunteerId]
    );
    if (!removed.rowCount) fail(404, "Volunteer is not assigned to this event.");
    await writeAuditLog(client, {
      eventId,
      actorId,
      action,
      entityType: "volunteer_assignment",
      entityId: volunteerId
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verifyFlywayMigrations(pool) {
  try {
    const result = await pool.query(`
      SELECT version FROM flyway_schema_history
      WHERE success=TRUE ORDER BY installed_rank DESC LIMIT 1
    `);
    if (result.rows[0]?.version !== "4") {
      throw new Error("GatherFlow database migrations are incomplete. Run `npm.cmd run db:migrate` in PowerShell before starting the server.");
    }
  } catch (error) {
    if (error.code === "42P01") {
      throw new Error("Flyway migrations have not been applied. Run `npm.cmd run db:migrate` in PowerShell before starting GatherFlow.");
    }
    throw error;
  }
}

function setEventStatus(event, nextStatus) {
  const transitions = {
    DRAFT: ["PUBLISHED", "CANCELLED"],
    PUBLISHED: ["DRAFT", "REGISTRATION_CLOSED", "COMPLETED", "CANCELLED"],
    REGISTRATION_CLOSED: ["PUBLISHED", "COMPLETED", "CANCELLED"],
    COMPLETED: [],
    CANCELLED: ["DRAFT"]
  };
  if (!eventStatuses.has(nextStatus) || !transitions[event.status]?.includes(nextStatus)) {
    fail(409, `Cannot change event status from ${event.status} to ${nextStatus}.`);
  }
}

async function registerPeople(pool, eventId, body, current, baseUrl, transactionClient = null) {
  const lead = validatePerson(body);
  if (body.attendees !== undefined && !Array.isArray(body.attendees)) fail(400, "Additional attendees must be a list.");
  const guests = body.attendees || [];
  if (guests.length > 9) fail(400, "A group can contain up to 10 attendees.");
  const people = [lead, ...guests.map(validatePerson)];
  const groupName = String(body.groupName || "").trim();
  const registrationSource = body.source === "WALK_IN" &&
    ["ORGANIZER", "PLATFORM_ADMIN"].includes(current?.role)
    ? "WALK_IN"
    : "PUBLIC";
  if (groupName.length > 120) fail(400, "Group name must be 120 characters or fewer.");
  if (current?.role === "ATTENDEE" && current.email !== lead.email) {
    fail(403, "Use your account email when registering while signed in.");
  }

  const ownsTransaction = transactionClient === null;
  const client = transactionClient || await pool.connect();
  const registrations = [];
  const groupId = randomUUID();
  const confirmationCode = randomBytes(32).toString("hex");
  try {
    if (ownsTransaction) await client.query("BEGIN");
    const locked = await client.query(
      "SELECT * FROM events WHERE id = $1 AND archived_at IS NULL FOR UPDATE",
      [eventId]
    );
    const event = locked.rows[0];
    if (!event || !["PUBLISHED", "REGISTRATION_CLOSED"].includes(event.status)) {
      fail(404, "This event is not open for registration.");
    }
    if (registrationSource !== "WALK_IN") {
      if (event.status !== "PUBLISHED") fail(409, "Registration for this event is closed.");
      const now = Date.now();
      if (event.registration_start_at && new Date(event.registration_start_at).getTime() > now) {
        fail(409, "Registration has not opened yet.");
      }
      if ((event.registration_end_at && new Date(event.registration_end_at).getTime() <= now) ||
        new Date(event.starts_at).getTime() <= now) fail(409, "Registration for this event is closed.");
    }
    const countResult = await client.query(
      "SELECT COUNT(*) AS count FROM registrations WHERE event_id = $1 AND status <> 'CANCELLED'",
      [eventId]
    );
    if (Number(countResult.rows[0].count) + people.length > event.capacity) {
      fail(409, "There are not enough remaining places for this group.");
    }
    const questions = await getEventQuestions(client, eventId);
    const answers = validateAnswers(body.answers || {}, questions);
    const emails = people.map(person => person.email);
    if (event.duplicate_policy === "EMAIL_ONCE" && new Set(emails).size !== emails.length) {
      fail(409, "Each attendee needs a different email for this event.");
    }
    if (event.duplicate_policy === "EMAIL_ONCE") {
      for (const email of emails) {
        const duplicate = await client.query(`
          SELECT 1 FROM registrations r
          JOIN attendees a ON a.id=r.attendee_profile_id
          WHERE r.event_id=$1 AND r.status <> 'CANCELLED' AND LOWER(a.email)=LOWER($2)
          LIMIT 1
        `, [eventId, email]);
        if (duplicate.rowCount) fail(409, "An attendee email is already registered for this event.");
      }
    }
    await client.query(`
      INSERT INTO registration_groups (id,event_id,confirmation_code,contact_email,group_name)
      VALUES ($1,$2,$3,$4,$5)
    `, [groupId, eventId, confirmationCode, lead.email, groupName]);
    for (let index = 0; index < people.length; index += 1) {
      const person = people[index];
      const guestAnswers = index === 0 ? answers : validateAnswers(guests[index - 1].answers || {}, questions);
      const id = randomUUID();
      const attendeeId = randomUUID();
      const ticketId = randomUUID();
      const ticketCode = randomBytes(24).toString("hex").toUpperCase();
      await client.query(`
        INSERT INTO attendees (id,name,email,phone) VALUES ($1,$2,$3,$4)
      `, [attendeeId, person.name, person.email, person.phone]);
      const inserted = await client.query(`
        INSERT INTO registrations (
          id,event_id,user_id,group_id,attendee_profile_id,answers,registration_source,duplicate_guard
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
        RETURNING id,answers,status,registered_at
      `, [
        id, eventId, current?.role === "ATTENDEE" && index === 0 ? current.id : null,
        groupId, attendeeId, JSON.stringify(guestAnswers), registrationSource,
        event.duplicate_policy === "EMAIL_ONCE"
      ]);
      await client.query(`
        INSERT INTO tickets (id,registration_id,ticket_code) VALUES ($1,$2,$3)
      `, [ticketId, id, ticketCode]);
      const row = {
        ...inserted.rows[0],
        name: person.name,
        email: person.email,
        phone: person.phone,
        group_name: groupName,
        ticket_code: ticketCode
      };
      row.qrCode = await QRCode.toDataURL(ticketCode, { errorCorrectionLevel: "M", margin: 1, width: 220 });
      registrations.push(row);
    }
    await writeAuditLog(client, {
      eventId,
      actorId: current?.id || null,
      action: "REGISTRATION_CREATED",
      entityType: "registration_group",
      entityId: groupId,
      metadata: { attendeeCount: people.length, source: registrationSource }
    });
    if (ownsTransaction) await client.query("COMMIT");
    return { groupId, confirmationCode, registrations };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK");
    if (error.code === "23505") fail(409, "This email is already registered for the event.");
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

export async function createApp({
  pool: suppliedPool,
  jwtSecret = process.env.JWT_SECRET || randomBytes(32).toString("hex"),
  resetLog = message => console.info(message),
  resetDelivery = null,
  emailDelivery = null,
  emailFetch = fetch,
  emailErrorLog = message => console.error(message),
  emailDomainCheck = hasMailRecords,
  corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS || "",
  skipMigrationCheck = false,
  publicAppUrl = process.env.APP_BASE_URL || null
} = {}) {
  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) throw new Error("JWT_SECRET must be configured in production.");
  if (process.env.NODE_ENV === "production" && Buffer.byteLength(jwtSecret) < 32) throw new Error("JWT_SECRET must contain at least 32 bytes in production.");
  const emailEndpoint = process.env.EMAIL_DELIVERY_ENDPOINT || process.env.RESET_EMAIL_ENDPOINT;
  const emailToken = process.env.EMAIL_DELIVERY_TOKEN || process.env.RESET_EMAIL_TOKEN;
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFromEmail = process.env.RESEND_FROM_EMAIL;
  const hasResendEmailDelivery = Boolean(resendApiKey && resendFromEmail);
  const hasEmailDelivery = Boolean(emailDelivery || hasResendEmailDelivery || (emailEndpoint && emailToken));
  if (process.env.NODE_ENV === "production" && (!hasEmailDelivery || !process.env.APP_BASE_URL)) {
    throw new Error("Production requires transactional email delivery and APP_BASE_URL.");
  }
  if (!hasEmailDelivery) {
    if (Boolean(resendApiKey) !== Boolean(resendFromEmail)) {
      emailErrorLog("Resend email delivery is incomplete. Set both RESEND_API_KEY and RESEND_FROM_EMAIL.");
    } else {
      emailErrorLog("Email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL, or configure EMAIL_DELIVERY_ENDPOINT and EMAIL_DELIVERY_TOKEN.");
    }
  }
  if (process.env.NODE_ENV === "production") {
    if (emailEndpoint && new URL(emailEndpoint).protocol !== "https:") {
      throw new Error("EMAIL_DELIVERY_ENDPOINT must use HTTPS in production.");
    }
    if (process.env.APP_BASE_URL && new URL(process.env.APP_BASE_URL).protocol !== "https:") {
      throw new Error("APP_BASE_URL must use HTTPS in production.");
    }
  }

  const allowedOrigins = parseCorsOrigins(corsAllowedOrigins);
  const rateLimitBuckets = new Map();
  const appBaseUrl = process.env.APP_BASE_URL || "http://localhost:3000";
  const pool = suppliedPool || new Pool();
  try {
    if (!skipMigrationCheck) await verifyFlywayMigrations(pool);
  } catch (error) {
    if (!suppliedPool) await pool.end();
    throw error;
  }

  async function sendEmail({ to, subject, text, html, purpose, resetUrl }) {
    if (emailDelivery) {
      await emailDelivery({ to, subject, text, ...(html ? { html } : {}), purpose });
      return;
    }
    if (purpose === "PASSWORD_RESET" && resetDelivery) {
      await resetDelivery({ email: to, resetUrl });
      return;
    }
    if (hasResendEmailDelivery) {
      const delivery = await emailFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendApiKey}`
        },
        body: JSON.stringify({
          from: resendFromEmail,
          to: [to],
          subject,
          text,
          ...(html ? { html } : {})
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!delivery.ok) throw new Error(`Resend email delivery failed with HTTP ${delivery.status}.`);
      return;
    }
    if (emailEndpoint && emailToken) {
      const delivery = await emailFetch(emailEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${emailToken}`
        },
        body: JSON.stringify({ to, subject, text, ...(html ? { html } : {}) }),
        signal: AbortSignal.timeout(10000)
      });
      if (!delivery.ok) throw new Error(`Transactional email delivery failed with HTTP ${delivery.status}.`);
      return;
    }
    throw new Error("Email delivery is not configured; set RESEND_API_KEY and RESEND_FROM_EMAIL, or EMAIL_DELIVERY_ENDPOINT and EMAIL_DELIVERY_TOKEN.");
  }

  function sendEmailInBackground(message) {
    setImmediate(() => {
      sendEmail(message).catch(error => {
        emailErrorLog(`${message.purpose} email delivery failed: ${error.message}`);
      });
    });
  }

  function notifyEventAttendeesInBackground(eventId, { subject, text }) {
    setImmediate(async () => {
      try {
        const recipients = await pool.query(`
          SELECT DISTINCT LOWER(a.email) AS email
          FROM registrations r
          JOIN attendees a ON a.id=r.attendee_profile_id
          WHERE r.event_id=$1 AND r.status<>'CANCELLED'
        `, [eventId]);
        const results = await Promise.allSettled(recipients.rows.map(({ email }) =>
          sendEmail({ to: email, subject, text, purpose: "EVENT_UPDATE" })
        ));
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length) {
          const reason = failures[0].reason;
          emailErrorLog(`Event update email delivery failed for ${failures.length} of ${results.length} recipients: ${reason.message}`);
        }
      } catch (error) {
        emailErrorLog(`Event update email notifications could not be prepared: ${error.message}`);
      }
    });
  }

  function notifyVolunteerAssignmentInBackground(eventId, volunteer, notifyVolunteer = false) {
    setImmediate(async () => {
      try {
        const event = await getVolunteerNotificationDetails(eventId);
        if (!event) throw new Error("Event not found.");
        const eventDate = new Date(event.starts_at).toISOString();
        const details = `Volunteer: ${volunteer.name}\nEmail: ${volunteer.email}\nAssigned role: Volunteer\nEvent: ${event.title}\nDate and time: ${eventDate}`;
        sendEmailInBackground({
          to: event.organizer_email,
          purpose: "VOLUNTEER_ASSIGNMENT",
          subject: `Volunteer joined: ${event.title}`,
          text: `A volunteer joined or was assigned to your event.\n\n${details}`
        });
        if (notifyVolunteer) {
          sendEmailInBackground({
            to: volunteer.email,
            purpose: "VOLUNTEER_ASSIGNMENT",
            subject: `You were added to an event team: ${event.title}`,
            text: `Hi ${volunteer.name},\n\nYou are assigned as a Volunteer for ${event.title}.\nDate and time: ${eventDate}\n\nSign in to access the event check-in tools.`
          });
        }
      } catch (error) {
        emailErrorLog(`Volunteer assignment email notifications could not be prepared: ${error.message}`);
      }
    });
  }

  async function getVolunteerNotificationDetails(eventId) {
    const result = await pool.query(`
      SELECT e.title,e.starts_at,u.email AS organizer_email
      FROM events e JOIN users u ON u.id=e.organizer_id
      WHERE e.id=$1
    `, [eventId]);
    return result.rows[0];
  }

  function sendRegistrationConfirmationInBackground(to, event, registrationResult) {
    const date = new Date(event.starts_at).toLocaleString("en-US", {
      dateStyle: "long", timeStyle: "short", timeZone: "UTC"
    });
    const ticketText = registrationResult.registrations.map(item =>
      `${item.name}: ${item.ticket_code}`
    ).join("\n");
    const ticketHtml = registrationResult.registrations.map(item => `
      <li>
        <p>${escapeEmailHtml(item.name)} — ticket code: <strong>${escapeEmailHtml(item.ticket_code)}</strong></p>
        <img src="${item.qrCode}" alt="QR ticket for ${escapeEmailHtml(item.name)}" width="220" height="220" />
      </li>`).join("");
    sendEmailInBackground({
      to,
      purpose: "REGISTRATION_CONFIRMATION",
      subject: `Registration confirmed: ${event.title}`,
      text: `Your registration for ${event.title} is confirmed.\n\nDate and time: ${date} UTC\nVenue: ${event.location}\n\nConfirmation code: ${registrationResult.confirmationCode}\n\nTickets:\n${ticketText}\n\nEach ticket code is also encoded in its QR code.`,
      html: `<h1>Registration confirmed: ${escapeEmailHtml(event.title)}</h1>
        <p>Date and time: ${escapeEmailHtml(date)} UTC<br>Venue: ${escapeEmailHtml(event.location)}</p>
        <p>Confirmation code: <strong>${escapeEmailHtml(registrationResult.confirmationCode)}</strong></p>
        <h2>Your tickets</h2><ul>${ticketHtml}</ul>`
    });
  }

  async function issueVerificationToken({
    purpose, userId = null, eventId = null, payload = null, expiresInMs, client = pool
  }) {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHmac("sha256", jwtSecret).update(token).digest("hex");
    await client.query(`
      INSERT INTO email_verification_tokens (token_hash,purpose,user_id,event_id,payload,expires_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)
    `, [tokenHash, purpose, userId, eventId, payload === null ? null : JSON.stringify(payload), new Date(Date.now() + expiresInMs)]);
    return token;
  }

  function makeVerificationUrl(token) {
    const url = new URL("/", appBaseUrl);
    url.searchParams.set("verifyEmail", token);
    return url.toString();
  }

  if (process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
    const email = normalizeEmail(process.env.PLATFORM_ADMIN_EMAIL);
    if (process.env.PLATFORM_ADMIN_PASSWORD.length < 10) {
      if (!suppliedPool) await pool.end();
      throw new Error("PLATFORM_ADMIN_EMAIL must be valid and PLATFORM_ADMIN_PASSWORD must contain at least 10 characters.");
    }
    try {
      await requireMailDomain(email, emailDomainCheck);
      await pool.query(`
        INSERT INTO users (id,name,email,password_hash,role)
        VALUES ($1,$2,$3,$4,'PLATFORM_ADMIN')
        ON CONFLICT (email) DO NOTHING
        RETURNING id,email
      `, [randomUUID(), "Platform administrator", email, hashPassword(process.env.PLATFORM_ADMIN_PASSWORD)]);
    } catch (error) {
      if (!suppliedPool) await pool.end();
      throw error;
    }
  }

  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method || "GET";

      if (url.pathname.startsWith("/api/")) {
        const requestOrigin = request.headers.origin;
        const corsHeaders = requestOrigin && allowedOrigins.has(requestOrigin)
          ? {
            "Access-Control-Allow-Origin": requestOrigin,
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            Vary: "Origin"
          }
          : {};
        for (const [name, value] of Object.entries(corsHeaders)) response.setHeader(name, value);
        if (method === "OPTIONS") {
          if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
            return jsonResponse(response, 403, { error: "This origin is not allowed." });
          }
          response.writeHead(204, {
            Allow: "GET, POST, PATCH, DELETE, OPTIONS",
            ...securityHeaders,
            ...corsHeaders
          });
          return response.end();
        }
        if (method === "GET" && url.pathname === "/api/config") {
          return jsonResponse(response, 200, { publicAppUrl });
        }
        const retryAfter = getRateLimitRetryAfter(request, method, url.pathname, rateLimitBuckets);
        if (retryAfter) {
          return jsonResponse(response, 429, { error: "Too many requests. Please try again later." }, {
            "Retry-After": String(retryAfter)
          });
        }
        const body = await readBody(request);
        const authHeader = request.headers.authorization || "";
        const claims = authHeader.startsWith("Bearer ") ? verifyToken(authHeader.slice(7), jwtSecret) : null;
        const signedInResult = claims ? await pool.query("SELECT * FROM users WHERE id = $1", [claims.sub]) : null;
        const signedInUser = signedInResult?.rows[0];
        const current = signedInUser && claims.ver === signedInUser.token_version
          ? signedInUser
          : null;
        const requireUser = () => current || fail(401, "Please sign in to continue.");
        const requireRole = (...allowed) => {
          const user = requireUser();
          if (!allowed.includes(user.role)) fail(403, "You do not have permission to perform this action.");
          return user;
        };
        const eventAccess = async (eventId, canCheckIn = false) => {
          const user = requireUser();
          const result = await pool.query("SELECT * FROM events WHERE id=$1 AND archived_at IS NULL", [eventId]);
          const event = result.rows[0];
          if (!event) fail(404, "Event not found.");
          if (user.role === "PLATFORM_ADMIN" || user.id === event.organizer_id) return { user, event };
          if (user.role === "ORGANIZER") {
            const member = await pool.query(`
              SELECT 1 FROM organization_members
              WHERE organization_id=$1 AND user_id=$2
            `, [event.organization_id, user.id]);
            if (member.rowCount) return { user, event };
          }
          const member = await pool.query(
            "SELECT 1 FROM volunteer_assignments WHERE event_id=$1 AND user_id=$2",
            [eventId, user.id]
          );
          if (user.role === "VOLUNTEER" && member.rowCount && canCheckIn) return { user, event };
          fail(403, "You do not have access to this event.");
        };

        if (method === "POST" && url.pathname === "/api/auth/register") {
          const name = String(body.name || "").trim();
          const email = normalizeEmail(body.email);
          const password = String(body.password || "");
          const role = body.role === undefined ? "ATTENDEE" : String(body.role);
          if (name.length < 2 || name.length > 100) fail(400, "Name must be between 2 and 100 characters.");
          if (password.length < 10 || password.length > 256) fail(400, "Password must be at least 10 characters.");
          if (!["ATTENDEE", "ORGANIZER", "VOLUNTEER"].includes(role)) fail(400, "Choose a valid account role.");
          await requireMailDomain(email, emailDomainCheck);
          const user = {
            id: randomUUID(), name, email, role,
            password_hash: hashPassword(password), token_version: 0
          };
          const client = await pool.connect();
          let createdUser;
          try {
            await client.query("BEGIN");
            const result = await client.query(`
              INSERT INTO users (id,name,email,password_hash,role)
              VALUES ($1,$2,$3,$4,$5) RETURNING *
            `, [user.id, name, email, user.password_hash, role]);
            createdUser = result.rows[0];
            if (role === "ORGANIZER") await ensureOrganization(client, createdUser);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") {
              fail(409, "An account with this email already exists. Sign in instead.");
            }
            throw error;
          } finally {
            client.release();
          }
          return jsonResponse(response, 201, {
            token: makeToken(createdUser, jwtSecret),
            user: userView(createdUser)
          });
        }

        if (method === "POST" && url.pathname === "/api/auth/login") {
          const email = normalizeEmail(body.email);
          const password = String(body.password || "");
          if (password.length > 256) fail(400, "Password must be 256 characters or fewer.");
          const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
          const user = result.rows[0];
          if (!user || !checkPassword(password, user.password_hash)) fail(401, "Email or password is incorrect.");
          return jsonResponse(response, 200, { token: makeToken(user, jwtSecret), user: userView(user) });
        }

        if (method === "POST" && url.pathname === "/api/auth/resend-verification") {
          const email = normalizeEmail(body.email);
          await requireMailDomain(email, emailDomainCheck);
          const found = await pool.query(
            "SELECT id,name FROM users WHERE email=$1 AND email_verified_at IS NULL",
            [email]
          );
          const result = {
            message: "If this account needs verification, a new link will be sent to its email address."
          };
          if (found.rowCount) {
            const user = found.rows[0];
            const client = await pool.connect();
            let token;
            let tokenHash;
            try {
              await client.query("BEGIN");
              token = await issueVerificationToken({
                purpose: "ACCOUNT",
                userId: user.id,
                expiresInMs: 24 * 60 * 60 * 1000,
                client
              });
              tokenHash = createHmac("sha256", jwtSecret).update(token).digest("hex");
              await client.query("COMMIT");
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              client.release();
            }
            const verificationUrl = makeVerificationUrl(token);
            try {
              await sendEmail({
                to: email,
                purpose: "ACCOUNT_VERIFICATION",
                subject: "Verify your GatherFlow account",
                text: `Hi ${user.name},\n\nConfirm this email address to activate your GatherFlow account:\n\n${verificationUrl}\n\nThis link expires in 24 hours.`
              });
            } catch (error) {
              if (tokenHash) await pool.query("DELETE FROM email_verification_tokens WHERE token_hash=$1", [tokenHash]);
              console.error("Account verification email delivery failed:", error.message);
              fail(502, "The verification email could not be sent. Please try again later.");
            }
            await pool.query(
              "DELETE FROM email_verification_tokens WHERE user_id=$1 AND purpose='ACCOUNT' AND token_hash<>$2",
              [user.id, tokenHash]
            );
            if (process.env.NODE_ENV !== "production" && !emailDelivery && !emailEndpoint) {
              result.verificationUrl = new URL(verificationUrl).pathname + new URL(verificationUrl).search;
            }
          }
          return jsonResponse(response, 200, result);
        }

        if (method === "POST" && url.pathname === "/api/auth/verify-email") {
          const verificationToken = String(body.token || "");
          if (!/^[\w-]{30,100}$/.test(verificationToken)) fail(400, "This verification link is invalid or has expired.");
          const tokenHash = createHmac("sha256", jwtSecret).update(verificationToken).digest("hex");
          const client = await pool.connect();
          let purpose;
          let verifiedUser;
          let registrationResult;
          let eventId;
          let eventTitle;
          let allowCancellations = true;
          let contactEmail;
          try {
            await client.query("BEGIN");
            const tokenResult = await client.query(`
              SELECT * FROM email_verification_tokens
              WHERE token_hash=$1 AND expires_at>NOW()
              FOR UPDATE
            `, [tokenHash]);
            const verification = tokenResult.rows[0];
            if (!verification) fail(400, "This verification link is invalid or has expired.");
            purpose = verification.purpose;
            if (purpose === "ACCOUNT") {
              const userResult = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [verification.user_id]);
              const user = userResult.rows[0];
              if (!user) fail(400, "This verification link is invalid or has expired.");
              await client.query(
                "UPDATE users SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$1",
                [user.id]
              );
              await client.query(
                "DELETE FROM email_verification_tokens WHERE user_id=$1 AND purpose='ACCOUNT'",
                [user.id]
              );
              verifiedUser = userView(user);
            } else {
              eventId = verification.event_id;
              contactEmail = verification.payload.email;
              const eventResult = await client.query(
                "SELECT title,allow_cancellations FROM events WHERE id=$1",
                [eventId]
              );
              if (!eventResult.rowCount) fail(400, "This event registration link is invalid or has expired.");
              eventTitle = eventResult.rows[0].title;
              allowCancellations = eventResult.rows[0].allow_cancellations;
              if (verification.completed_group_id) {
                registrationResult = {
                  groupId: verification.completed_group_id,
                  confirmationCode: verification.completed_confirmation_code
                };
              } else {
                const registeringUser = verification.user_id
                  ? (await client.query("SELECT * FROM users WHERE id=$1", [verification.user_id])).rows[0]
                  : null;
                registrationResult = await registerPeople(
                  pool, eventId, verification.payload, registeringUser, appBaseUrl, client
                );
                await client.query(`
                  UPDATE email_verification_tokens
                  SET completed_group_id=$1,completed_confirmation_code=$2
                  WHERE token_hash=$3
                `, [registrationResult.groupId, registrationResult.confirmationCode, tokenHash]);
              }
            }
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }

          if (purpose === "ACCOUNT") {
            return jsonResponse(response, 200, {
              verified: true,
              kind: "ACCOUNT",
              user: verifiedUser,
              message: "Email verified. You can now sign in."
            });
          }
          const registrations = await pool.query(`
            SELECT r.id,r.answers,r.status,r.registered_at,a.name,a.email,a.phone,
              g.group_name,t.ticket_code
            FROM registrations r
            JOIN attendees a ON a.id=r.attendee_profile_id
            JOIN registration_groups g ON g.id=r.group_id
            JOIN tickets t ON t.registration_id=r.id
            WHERE r.group_id=$1
            ORDER BY a.created_at,r.id
          `, [registrationResult.groupId]);
          if (!registrations.rowCount || registrations.rows.some(row => row.status === "CANCELLED")) {
            fail(409, "This registration was cancelled and its tickets are no longer valid.");
          }
          registrationResult.registrations = await Promise.all(registrations.rows.map(async row => ({
            ...row,
            qrCode: await QRCode.toDataURL(row.ticket_code, { errorCorrectionLevel: "M", margin: 1, width: 220 })
          })));
          sendEmailInBackground({
            to: contactEmail,
            purpose: "REGISTRATION_CONFIRMATION",
            subject: `Registration confirmed: ${eventTitle}`,
            text: `Your registration for ${eventTitle} is confirmed.\n\nConfirmation code: ${registrationResult.confirmationCode}\n\n${registrationResult.registrations.map(item => `${item.name}: ${item.ticket_code}`).join("\n")}\n\nEach attendee should bring their ticket code or QR ticket.`
          });
          return jsonResponse(response, 200, {
            verified: true,
            kind: "EVENT_REGISTRATION",
            eventTitle,
            allowCancellations,
            ...registrationResult,
            message: "Email verified and registration confirmed."
          });
        }

        if (method === "POST" && url.pathname === "/api/auth/forgot-password") {
          if (process.env.NODE_ENV === "production" && !emailDelivery && !resetDelivery &&
            (!emailEndpoint || !emailToken || !process.env.APP_BASE_URL)) {
            fail(503, "Password reset is temporarily unavailable. Please contact your event administrator.");
          }
          const email = normalizeEmail(body.email);
          const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
          const user = result.rows[0];
          let resetUrl;
          if (user) {
            const token = randomBytes(32).toString("base64url");
            const tokenHash = createHmac("sha256", jwtSecret).update(token).digest("hex");
            await pool.query("DELETE FROM password_resets WHERE user_id = $1", [user.id]);
            await pool.query("INSERT INTO password_resets (token_hash,user_id,expires_at) VALUES ($1,$2,$3)",
              [tokenHash, user.id, new Date(Date.now() + 30 * 60 * 1000)]);
            resetUrl = new URL(`/reset-password?token=${encodeURIComponent(token)}`, appBaseUrl).toString();
            if (process.env.NODE_ENV !== "production" && !hasEmailDelivery && !resetDelivery) {
              resetLog("Password reset email was not sent: configure email delivery to enable outbound mail. A local reset link is available in the response.");
            } else {
              try {
                await sendEmail({
                  to: email,
                  purpose: "PASSWORD_RESET",
                  resetUrl,
                  subject: "Reset your GatherFlow password",
                  text: `Use this link within 30 minutes to reset your GatherFlow password:\n\n${resetUrl}`
                });
              } catch (error) {
                await pool.query("DELETE FROM password_resets WHERE user_id = $1", [user.id]);
                console.error("Password reset delivery failed:", error.message);
                fail(502, "Password reset delivery failed. Please try again later.");
              }
            }
          }
          const resultBody = { message: "If an account exists for that email, a reset link has been created." };
          if (process.env.NODE_ENV !== "production" && resetUrl && !emailDelivery && !emailEndpoint) {
            resultBody.resetUrl = new URL(resetUrl).pathname + new URL(resetUrl).search;
          }
          return jsonResponse(response, 200, resultBody);
        }

        if (method === "POST" && url.pathname === "/api/auth/reset-password") {
          const password = String(body.password || "");
          if (password.length < 10 || password.length > 256) fail(400, "Password must be at least 10 characters.");
          const tokenHash = createHmac("sha256", jwtSecret).update(String(body.token || "")).digest("hex");
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const reset = await client.query(
              "SELECT * FROM password_resets WHERE token_hash=$1 AND expires_at > NOW() FOR UPDATE",
              [tokenHash]
            );
            if (!reset.rowCount) fail(400, "This reset link is invalid or has expired.");
            await client.query("UPDATE users SET password_hash=$1,token_version=token_version+1,updated_at=NOW() WHERE id=$2",
              [hashPassword(password), reset.rows[0].user_id]);
            await client.query("DELETE FROM password_resets WHERE user_id=$1", [reset.rows[0].user_id]);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          return jsonResponse(response, 200, { message: "Password updated. You can now sign in." });
        }

        if (method === "GET" && url.pathname === "/api/auth/me") {
          return jsonResponse(response, 200, { user: userView(requireUser()) });
        }

        if (method === "GET" && url.pathname === "/api/public/events") {
          const result = await pool.query(`
            SELECT * FROM events
            WHERE archived_at IS NULL AND status IN ('PUBLISHED','REGISTRATION_CLOSED')
            ORDER BY starts_at
          `);
          const events = await Promise.all(result.rows.map(row => eventWithStats(pool, row)));
          return jsonResponse(response, 200, { events: events.map(eventView) });
        }

        if (method === "GET" && url.pathname === "/api/dashboard") {
          const user = requireRole("ORGANIZER", "PLATFORM_ADMIN");
          const eventScope = user.role === "PLATFORM_ADMIN"
            ? "e.archived_at IS NULL"
            : "e.archived_at IS NULL AND e.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id=$1)";
          const values = user.role === "PLATFORM_ADMIN" ? [] : [user.id];
          const [metrics, recentRegistrations, recentCheckIns, eventPerformance] = await Promise.all([
            pool.query(`
              SELECT
                COUNT(DISTINCT CASE WHEN e.status='PUBLISHED' THEN e.id END) AS published_events,
                COUNT(CASE WHEN r.id IS NOT NULL AND r.status<>'CANCELLED' THEN 1 END) AS registrations,
                COUNT(CASE WHEN c.id IS NOT NULL AND r.status<>'CANCELLED' THEN 1 END) AS checked_in,
                COUNT(CASE WHEN r.status='REGISTERED' AND e.status NOT IN ('COMPLETED','CANCELLED') THEN 1 END) AS pending_arrivals,
                COUNT(CASE WHEN r.registration_source='WALK_IN' AND r.status<>'CANCELLED' THEN 1 END) AS walk_in_registrations
              FROM events e
              LEFT JOIN registrations r ON r.event_id=e.id
              LEFT JOIN check_ins c ON c.registration_id=r.id
              WHERE ${eventScope}
            `, values),
            pool.query(`
              SELECT r.id,a.name,a.email,g.group_name,r.registration_source,r.registered_at,
                e.id AS event_id,e.title AS event_title
              FROM registrations r
              JOIN attendees a ON a.id=r.attendee_profile_id
              JOIN registration_groups g ON g.id=r.group_id
              JOIN events e ON e.id=r.event_id
              WHERE ${eventScope} AND r.status<>'CANCELLED'
              ORDER BY r.registered_at DESC LIMIT 8
            `, values),
            pool.query(`
              SELECT c.id,a.name AS attendee_name,e.id AS event_id,e.title AS event_title,
                c.method,c.checked_in_at,u.name AS actor_name
              FROM check_ins c
              JOIN registrations r ON r.id=c.registration_id
              JOIN attendees a ON a.id=r.attendee_profile_id
              JOIN events e ON e.id=c.event_id
              LEFT JOIN users u ON u.id=c.actor_id
              WHERE ${eventScope}
              ORDER BY c.checked_in_at DESC LIMIT 8
            `, values),
            pool.query(`
              SELECT e.id,e.title,e.status,e.capacity,e.starts_at,
                COUNT(CASE WHEN r.status<>'CANCELLED' THEN 1 END) AS registered,
                COUNT(CASE WHEN c.id IS NOT NULL AND r.status<>'CANCELLED' THEN 1 END) AS checked_in
              FROM events e
              LEFT JOIN registrations r ON r.event_id=e.id
              LEFT JOIN check_ins c ON c.registration_id=r.id
              WHERE ${eventScope}
              GROUP BY e.id,e.title,e.status,e.capacity,e.starts_at
              ORDER BY e.starts_at DESC LIMIT 8
            `, values)
          ]);
          const counts = metrics.rows[0];
          const registrations = Number(counts.registrations || 0);
          const checkedIn = Number(counts.checked_in || 0);
          return jsonResponse(response, 200, {
            metrics: {
              publishedEvents: Number(counts.published_events || 0),
              registrations,
              checkedIn,
              pendingArrivals: Number(counts.pending_arrivals || 0),
              walkInRegistrations: Number(counts.walk_in_registrations || 0),
              attendanceRate: registrations ? Math.round(checkedIn / registrations * 100) : 0
            },
            recentRegistrations: recentRegistrations.rows,
            recentCheckIns: recentCheckIns.rows,
            eventPerformance: eventPerformance.rows
          });
        }

        if (method === "GET" && url.pathname === "/api/events") {
          const user = requireUser();
          if (user.role === "VOLUNTEER") {
            const result = await pool.query(`
              SELECT e.*,(m.user_id IS NOT NULL) AS is_volunteer
              FROM events e
              LEFT JOIN volunteer_assignments m ON m.event_id=e.id AND m.user_id=$1
              WHERE e.archived_at IS NULL
                AND (
                  e.status IN ('PUBLISHED','REGISTRATION_CLOSED')
                  OR m.user_id IS NOT NULL
                )
              ORDER BY e.starts_at
            `, [user.id]);
            const events = await Promise.all(result.rows.map(row => eventWithStats(pool, row)));
            return jsonResponse(response, 200, { events: events.map(eventView) });
          }
          let filter;
          let values = [];
          if (user.role === "PLATFORM_ADMIN") filter = "e.archived_at IS NULL";
          else if (user.role === "ORGANIZER") {
            filter = "e.archived_at IS NULL AND e.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id=$1)";
            values = [user.id];
          } else if (user.role === "VOLUNTEER") {
            filter = "e.archived_at IS NULL AND EXISTS (SELECT 1 FROM volunteer_assignments m WHERE m.event_id=e.id AND m.user_id=$1)";
            values = [user.id];
          } else {
            const result = await pool.query(`
              SELECT * FROM events
              WHERE archived_at IS NULL AND status IN ('PUBLISHED','REGISTRATION_CLOSED')
              ORDER BY starts_at
            `);
            const events = await Promise.all(result.rows.map(row => eventWithStats(pool, row)));
            return jsonResponse(response, 200, { events: events.map(eventView) });
          }
          const result = await pool.query(`
            SELECT * FROM events e WHERE ${filter} ORDER BY e.starts_at
          `, values);
          const events = await Promise.all(result.rows.map(row => eventWithStats(pool, row)));
          return jsonResponse(response, 200, { events: events.map(eventView) });
        }

        if (method === "POST" && url.pathname === "/api/events") {
          const user = requireRole("PLATFORM_ADMIN", "ORGANIZER");
          const title = String(body.title || "").trim();
          const location = String(body.location || "").trim();
          const description = String(body.description || "").trim();
          const startsAt = parseDate(body.startsAt, "Event date");
          const registrationStart = parseDate(body.registrationStartAt, "Registration start", true);
          const registrationEnd = parseDate(body.registrationEndAt, "Registration end", true);
          const capacity = Number(body.capacity);
          const questions = normalizeQuestions(body.questions || []);
          const duplicatePolicy = body.duplicatePolicy || "EMAIL_ONCE";
          const allowCancellations = body.allowCancellations !== false;
          const banner = parseImage(body.bannerData);
          if (title.length < 3 || title.length > 120 || !location || location.length > 200 ||
            description.length > 2000 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
            fail(400, "Enter a valid title, description, date, location, and capacity.");
          }
          if (duplicatePolicy !== "EMAIL_ONCE" && duplicatePolicy !== "ALLOW_DUPLICATES") {
            fail(400, "Choose a valid duplicate registration rule.");
          }
          if (registrationStart && registrationEnd && Date.parse(registrationStart) >= Date.parse(registrationEnd)) {
            fail(400, "Registration must end after it starts.");
          }
          if (registrationEnd && Date.parse(registrationEnd) > Date.parse(startsAt)) {
            fail(400, "Registration must close before the event starts.");
          }
          const eventId = randomUUID();
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const organizationId = await ensureOrganization(client, user);
            await client.query(`
              INSERT INTO events (
                id,organizer_id,organization_id,title,description,starts_at,location,capacity,status,
                registration_start_at,registration_end_at,duplicate_policy,
                allow_cancellations,banner_data,banner_mime
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,$14)
            `, [
              eventId, user.id, organizationId, title, description, startsAt, location, capacity,
              registrationStart, registrationEnd, duplicatePolicy, allowCancellations,
              banner?.bytes || null, banner?.mime || null
            ]);
            await replaceEventQuestions(client, eventId, questions);
            await writeAuditLog(client, {
              eventId,
              actorId: user.id,
              action: "EVENT_CREATED",
              entityType: "event",
              entityId: eventId,
              metadata: { status: "DRAFT" }
            });
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          const created = await getEvent(pool, eventId);
          return jsonResponse(response, 201, { event: eventView(created) });
        }

        const bannerPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/banner$/i);
        if (method === "GET" && bannerPath) {
          const event = await pool.query("SELECT banner_data,banner_mime,status FROM events WHERE id=$1 AND archived_at IS NULL", [bannerPath[1]]);
          const row = event.rows[0];
          if (!row?.banner_data) {
            fail(404, "Event banner not found.");
          }
          if (!["PUBLISHED", "REGISTRATION_CLOSED"].includes(row.status)) {
            await eventAccess(bannerPath[1]);
          }
          response.writeHead(200, {
            "Content-Type": row.banner_mime,
            "Cache-Control": ["PUBLISHED", "REGISTRATION_CLOSED"].includes(row.status)
              ? "public, max-age=3600"
              : "private, no-store",
            ...securityHeaders
          });
          return response.end(row.banner_data);
        }

        const statusPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/status$/i);
        if (method === "PATCH" && statusPath) {
          await eventAccess(statusPath[1]);
          requireRole("PLATFORM_ADMIN", "ORGANIZER");
          const client = await pool.connect();
          let eventId;
          let cancelled = false;
          try {
            await client.query("BEGIN");
            const result = await client.query("SELECT * FROM events WHERE id=$1 AND archived_at IS NULL FOR UPDATE", [statusPath[1]]);
            const event = result.rows[0];
            if (!event) fail(404, "Event not found.");
            const status = String(body.status || "");
            setEventStatus(event, status);
            cancelled = status === "CANCELLED";
            await client.query("UPDATE events SET status=$1,updated_at=NOW() WHERE id=$2", [status, event.id]);
            await writeAuditLog(client, {
              eventId: event.id,
              actorId: current.id,
              action: "EVENT_STATUS_CHANGED",
              entityType: "event",
              entityId: event.id,
              metadata: { from: event.status, to: status }
            });
            eventId = event.id;
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          const withStats = await getEvent(pool, eventId);
          if (cancelled) {
            notifyEventAttendeesInBackground(eventId, {
              subject: `Event cancelled: ${withStats.title}`,
              text: `We’re sorry, but ${withStats.title} has been cancelled.\n\nScheduled date and time: ${new Date(withStats.starts_at).toISOString()}\nVenue: ${withStats.location}\n\nPlease contact the event organizer if you have questions.`
            });
          }
          return jsonResponse(response, 200, { event: eventView(withStats) });
        }

        const volunteerPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/volunteers(?:\/([0-9a-f-]+))?$/i);
        if (volunteerPath && method === "GET") {
          await eventAccess(volunteerPath[1]);
          requireRole("PLATFORM_ADMIN", "ORGANIZER");
          const volunteers = await pool.query(`
            SELECT u.id,u.name,u.email,m.created_at
            FROM volunteer_assignments m JOIN users u ON u.id=m.user_id
            WHERE m.event_id=$1 ORDER BY u.name
          `, [volunteerPath[1]]);
          return jsonResponse(response, 200, { volunteers: volunteers.rows });
        }
        if (volunteerPath && method === "POST" && !volunteerPath[2]) {
          const user = requireUser();
          if (user.role === "VOLUNTEER") {
            const client = await pool.connect();
            let joined;
            try {
              await client.query("BEGIN");
              const event = await client.query(`
                SELECT id,title FROM events
                WHERE id=$1 AND archived_at IS NULL
                  AND status IN ('PUBLISHED','REGISTRATION_CLOSED')
                  AND starts_at > NOW()
                FOR UPDATE
              `, [volunteerPath[1]]);
              if (!event.rowCount) fail(409, "Volunteer sign-up is available only for upcoming events.");
              const existing = await client.query(
                "SELECT 1 FROM volunteer_assignments WHERE event_id=$1 AND user_id=$2",
                [volunteerPath[1], user.id]
              );
              joined = existing.rowCount ? { rowCount: 0 } : await client.query(`
                  INSERT INTO volunteer_assignments (event_id,user_id)
                  VALUES ($1,$2)
                  ON CONFLICT (event_id,user_id) DO NOTHING
                  RETURNING user_id
                `, [volunteerPath[1], user.id]);
              if (joined.rowCount) {
                await writeAuditLog(client, {
                  eventId: volunteerPath[1],
                  actorId: user.id,
                  action: "VOLUNTEER_JOINED",
                  entityType: "volunteer_assignment",
                  entityId: user.id
                });
              }
              await client.query("COMMIT");
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              client.release();
            }
            if (joined.rowCount) {
              notifyVolunteerAssignmentInBackground(volunteerPath[1], user);
            }
            return jsonResponse(response, joined.rowCount ? 201 : 200, {
              joined: true,
              alreadyJoined: !joined.rowCount
            });
          }
          await eventAccess(volunteerPath[1]);
          requireRole("PLATFORM_ADMIN", "ORGANIZER");
          const email = normalizeEmail(body.email, "Enter a valid volunteer email address.");
          await requireMailDomain(email, emailDomainCheck);
          const volunteer = await pool.query(
            "SELECT id,role,name,email FROM users WHERE email=$1",
            [email]
          );
          if (!volunteer.rowCount || volunteer.rows[0].role !== "VOLUNTEER") {
            fail(404, "Create a volunteer account before adding them to an event.");
          }
          const client = await pool.connect();
          let added;
          try {
            await client.query("BEGIN");
            added = await client.query(`
              INSERT INTO volunteer_assignments (event_id,user_id,assigned_by) VALUES ($1,$2,$3)
              ON CONFLICT (event_id,user_id) DO NOTHING
              RETURNING user_id
            `, [volunteerPath[1], volunteer.rows[0].id, user.id]);
            if (added.rowCount) {
              await writeAuditLog(client, {
                eventId: volunteerPath[1],
                actorId: user.id,
                action: "VOLUNTEER_ADDED",
                entityType: "volunteer_assignment",
                entityId: volunteer.rows[0].id
              });
            }
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          if (added.rowCount) {
            notifyVolunteerAssignmentInBackground(volunteerPath[1], volunteer.rows[0], true);
          }
          return jsonResponse(response, added.rowCount ? 201 : 200, { added: Boolean(added.rowCount) });
        }
        if (volunteerPath && method === "DELETE" && !volunteerPath[2]) {
          const user = requireRole("VOLUNTEER");
          await removeVolunteerAssignment(pool, volunteerPath[1], user.id, user.id, "VOLUNTEER_LEFT");
          return jsonResponse(response, 200, { left: true });
        }
        if (volunteerPath && method === "DELETE" && volunteerPath[2]) {
          await eventAccess(volunteerPath[1]);
          requireRole("PLATFORM_ADMIN", "ORGANIZER");
          await removeVolunteerAssignment(pool, volunteerPath[1], volunteerPath[2], current.id, "VOLUNTEER_REMOVED");
          return jsonResponse(response, 200, { removed: true });
        }

        const attendeesPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/attendees$/i);
        if (attendeesPath && method === "GET") {
          await eventAccess(attendeesPath[1], true);
          const attendees = await pool.query(`
            SELECT r.id,r.group_id,a.name,a.email,a.phone,g.group_name,r.answers,t.ticket_code,
              r.status,r.registered_at,c.checked_in_at,c.actor_id AS checked_in_by,r.cancelled_at,
              checkin_user.name AS checked_in_by_name
            FROM registrations r
            JOIN attendees a ON a.id=r.attendee_profile_id
            JOIN registration_groups g ON g.id=r.group_id
            JOIN tickets t ON t.registration_id=r.id
            LEFT JOIN check_ins c ON c.registration_id=r.id
            LEFT JOIN users checkin_user ON checkin_user.id=c.actor_id
            WHERE r.event_id=$1 ORDER BY a.name
          `, [attendeesPath[1]]);
          return jsonResponse(response, 200, { attendees: attendees.rows });
        }

        const historyPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/check-in-history$/i);
        if (historyPath && method === "GET") {
          await eventAccess(historyPath[1], true);
          const history = await pool.query(`
            SELECT c.id,c.method,c.identity_verified,c.checked_in_at,
              r.id AS registration_id,a.name AS attendee_name,
              actor.id AS actor_id,actor.name AS actor_name
            FROM check_ins c
            JOIN registrations r ON r.id=c.registration_id
            JOIN attendees a ON a.id=r.attendee_profile_id
            LEFT JOIN users actor ON actor.id=c.actor_id
            WHERE c.event_id=$1
            ORDER BY c.checked_in_at DESC
            LIMIT 50
          `, [historyPath[1]]);
          return jsonResponse(response, 200, { history: history.rows });
        }

        const checkinPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/check-in$/i);
        if (checkinPath && method === "POST") {
          await eventAccess(checkinPath[1], true);
          const method = String(body.method || "MANUAL");
          if (!["QR_SCAN", "MANUAL", "RECOVERY", "OFFLINE_SYNC"].includes(method)) {
            fail(400, "Choose a valid check-in method.");
          }
          const ticketCode = String(body.ticketCode || "").trim().toUpperCase();
          const registrationId = String(body.registrationId || "").trim();
          if (method === "QR_SCAN" && !ticketCode) fail(400, "A QR ticket code is required.");
          if (method !== "QR_SCAN" && !registrationId) fail(400, "Select a registration to check in.");
          if (method === "RECOVERY" && body.identityVerified !== true) {
            fail(400, "Verify the attendee's identity before completing recovery check-in.");
          }

          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const found = method === "QR_SCAN"
              ? await client.query(
                `SELECT r.*,t.status AS ticket_status FROM tickets t
                 JOIN registrations r ON r.id=t.registration_id
                 WHERE r.event_id=$1 AND t.ticket_code=$2 FOR UPDATE`,
                [checkinPath[1], ticketCode]
              )
              : await client.query(
                "SELECT * FROM registrations WHERE event_id=$1 AND id=$2 FOR UPDATE",
                [checkinPath[1], registrationId]
              );
            const registration = found.rows[0];
            if (!registration) fail(404, "Invalid ticket: no registration was found for this event.");
            if (registration.status === "CANCELLED") fail(409, "This ticket belongs to a cancelled registration.");
            if (registration.ticket_status && registration.ticket_status !== "ACTIVE") {
              fail(409, "This ticket is invalid or has been voided.");
            }
            if (registration.status === "CHECKED_IN") fail(409, "This attendee has already been checked in.");

            const updated = await client.query(`
              UPDATE registrations
              SET status='CHECKED_IN',checked_in_at=NOW(),checked_in_by=$1,updated_at=NOW()
              WHERE id=$2 AND status='REGISTERED'
              RETURNING checked_in_at
            `, [current.id, registration.id]);
            if (!updated.rowCount) fail(409, "This attendee has already been checked in.");
            await client.query(`
              INSERT INTO check_ins (
                id,event_id,registration_id,actor_id,method,identity_verified
              ) VALUES ($1,$2,$3,$4,$5,$6)
            `, [
              randomUUID(), checkinPath[1], registration.id, current.id, method,
              method === "RECOVERY"
            ]);
            await client.query(`
              INSERT INTO audit_logs (
                id,event_id,actor_id,action,entity_type,entity_id,metadata
              ) VALUES ($1,$2,$3,'CHECK_IN','registration',$4,$5::jsonb)
            `, [
              randomUUID(), checkinPath[1], current.id, registration.id,
              JSON.stringify({ method, identityVerified: method === "RECOVERY" })
            ]);
            const attendeeResult = await client.query(`
              SELECT a.name,a.email,a.phone,t.ticket_code
              FROM registrations r
              JOIN attendees a ON a.id=r.attendee_profile_id
              JOIN tickets t ON t.registration_id=r.id
              WHERE r.id=$1
            `, [registration.id]);
            await client.query("COMMIT");
            const attendee = attendeeResult.rows[0];
            return jsonResponse(response, 200, {
              checkedIn: true,
              attendee: {
                id: registration.id,
                name: attendee.name,
                email: attendee.email,
                phone: attendee.phone,
                ticket_code: attendee.ticket_code,
                status: "CHECKED_IN",
                checked_in_at: updated.rows[0].checked_in_at,
                checked_in_by: current.id,
                checked_in_by_name: current.name
              }
            });
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        }

        const resendRegistrationPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/registrations\/resend-verification$/i);
        if (resendRegistrationPath && method === "POST") {
          const email = normalizeEmail(body.email);
          await requireMailDomain(email, emailDomainCheck);
          const pending = await pool.query(`
            SELECT * FROM email_verification_tokens
            WHERE purpose='EVENT_REGISTRATION' AND event_id=$1
              AND payload->>'email'=$2 AND expires_at>NOW()
            ORDER BY created_at DESC LIMIT 1
          `, [resendRegistrationPath[1], email]);
          const result = {
            message: "If a registration is awaiting verification, a new link will be sent to its contact email."
          };
          if (pending.rowCount) {
            const rawToken = randomBytes(32).toString("base64url");
            const tokenHash = createHmac("sha256", jwtSecret).update(rawToken).digest("hex");
            const previousHash = pending.rows[0].token_hash;
            await pool.query(`
              INSERT INTO email_verification_tokens
                (token_hash,purpose,user_id,event_id,payload,completed_group_id,completed_confirmation_code,expires_at)
              VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
            `, [
              tokenHash,
              pending.rows[0].purpose,
              pending.rows[0].user_id,
              pending.rows[0].event_id,
              JSON.stringify(pending.rows[0].payload),
              pending.rows[0].completed_group_id,
              pending.rows[0].completed_confirmation_code,
              pending.rows[0].expires_at
            ]);
            const verificationUrl = makeVerificationUrl(rawToken);
            try {
              await sendEmail({
                to: email,
                purpose: "EVENT_REGISTRATION_VERIFICATION",
                subject: "Confirm your event registration",
                text: `Confirm this email address to finish your event registration:\n\n${verificationUrl}\n\nThis link expires in one hour.`
              });
            } catch (error) {
              await pool.query("DELETE FROM email_verification_tokens WHERE token_hash=$1", [tokenHash]);
              console.error("Event registration verification email delivery failed:", error.message);
              fail(502, "The verification email could not be sent. Please try again later.");
            }
            await pool.query("DELETE FROM email_verification_tokens WHERE token_hash=$1", [previousHash]);
            if (process.env.NODE_ENV !== "production" && !emailDelivery && !emailEndpoint) {
              result.verificationUrl = new URL(verificationUrl).pathname + new URL(verificationUrl).search;
            }
          }
          return jsonResponse(response, 200, result);
        }

        const registrationPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)\/registrations$/i);
        if (registrationPath && method === "POST") {
          const eventId = registrationPath[1];
          const isStaffWalkIn = body.source === "WALK_IN" &&
            ["ORGANIZER", "PLATFORM_ADMIN"].includes(current?.role);
          if (isStaffWalkIn) {
            const walkInContact = validatePerson(body);
            const eventResult = await pool.query(`
              SELECT title,starts_at,location,allow_cancellations
              FROM events WHERE id=$1 AND archived_at IS NULL
            `, [eventId]);
            const result = await registerPeople(pool, eventId, body, current, appBaseUrl);
            sendRegistrationConfirmationInBackground(walkInContact.email, eventResult.rows[0], result);
            return jsonResponse(response, 201, result);
          }

          const lead = validatePerson(body);
          if (body.attendees !== undefined && !Array.isArray(body.attendees)) fail(400, "Additional attendees must be a list.");
          const guests = body.attendees || [];
          if (guests.length > 9) fail(400, "A group can contain up to 10 attendees.");
          const people = [lead, ...guests.map(validatePerson)];
          if (current?.role === "ATTENDEE" && current.email !== lead.email) {
            fail(403, "Use your account email when registering while signed in.");
          }
          await Promise.all(people.map(person => requireMailDomain(person.email, emailDomainCheck)));

          const event = eventView(await getEvent(pool, eventId));
          if (!event.canRegister) fail(409, "Registration for this event is not currently available.");
          const result = await registerPeople(pool, eventId, body, current, appBaseUrl);
          sendRegistrationConfirmationInBackground(lead.email, event, result);
          return jsonResponse(response, 201, {
            ...result,
            eventTitle: event.title,
            allowCancellations: event.allow_cancellations,
            message: "Registration complete. Your ticket confirmation will be sent by email."
          });
        }

        const cancelPath = url.pathname.match(/^\/api\/registrations\/([0-9a-f]+)\/cancel$/i);
        if (cancelPath && method === "POST") {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const group = await client.query(`
              SELECT id,event_id FROM registration_groups
              WHERE confirmation_code=$1 FOR UPDATE
            `, [cancelPath[1]]);
            const registrationGroup = group.rows[0];
            if (!registrationGroup) fail(404, "Registration not found.");
            const event = await client.query(
              "SELECT allow_cancellations,starts_at,archived_at FROM events WHERE id=$1 FOR UPDATE",
              [registrationGroup.event_id]
            );
            const row = event.rows[0];
            if (!row || row.archived_at) fail(404, "Registration not found.");
            if (!row.allow_cancellations || new Date(row.starts_at).getTime() <= Date.now()) {
              fail(409, "This event no longer allows registration cancellations.");
            }
            const cancelled = await client.query(`
              UPDATE registrations SET status='CANCELLED',cancelled_at=NOW(),updated_at=NOW()
              WHERE group_id=$1 AND status <> 'CANCELLED' RETURNING id
            `, [registrationGroup.id]);
            if (!cancelled.rowCount) fail(409, "This registration was already cancelled.");
            for (const registration of cancelled.rows) {
              await client.query("UPDATE tickets SET status='VOID',updated_at=NOW() WHERE registration_id=$1", [registration.id]);
            }
            await client.query("UPDATE registration_groups SET cancelled_at=NOW(),updated_at=NOW() WHERE id=$1", [registrationGroup.id]);
            await writeAuditLog(client, {
              eventId: registrationGroup.event_id,
              action: "REGISTRATION_CANCELLED",
              entityType: "registration_group",
              entityId: registrationGroup.id,
              metadata: { attendeeCount: cancelled.rowCount }
            });
            await client.query("COMMIT");
            return jsonResponse(response, 200, { cancelled: true });
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        }

        const eventIdPath = url.pathname.match(/^\/api\/events\/([0-9a-f-]+)$/i);
        if (eventIdPath && method === "GET") {
          const row = await getEvent(pool, eventIdPath[1]);
          if (!row || !["PUBLISHED", "REGISTRATION_CLOSED"].includes(row.status)) fail(404, "Event not found.");
          return jsonResponse(response, 200, { event: eventView(row) });
        }
        if (eventIdPath && method === "PATCH") {
          await eventAccess(eventIdPath[1]);
          requireRole("PLATFORM_ADMIN", "ORGANIZER");
          const client = await pool.connect();
          let updatedEventId;
          let importantDetailsChanged = false;
          try {
            await client.query("BEGIN");
            const result = await client.query(
              "SELECT * FROM events WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
              [eventIdPath[1]]
            );
            const previous = result.rows[0];
            if (!previous) fail(404, "Event not found.");
            const value = (key, fallback) => Object.hasOwn(body, key) ? body[key] : fallback;
            const title = String(value("title", previous.title) || "").trim();
            const description = String(value("description", previous.description) || "").trim();
            const location = String(value("location", previous.location) || "").trim();
            const startsAt = parseDate(value("startsAt", previous.starts_at), "Event date");
            const registrationStart = parseDate(value("registrationStartAt", previous.registration_start_at), "Registration start", true);
            const registrationEnd = parseDate(value("registrationEndAt", previous.registration_end_at), "Registration end", true);
            const capacity = Number(value("capacity", previous.capacity));
            const previousQuestions = await getEventQuestions(client, eventIdPath[1]);
            const questions = normalizeQuestions(value("questions", previousQuestions));
            const duplicatePolicy = value("duplicatePolicy", previous.duplicate_policy);
            const allowCancellations = value("allowCancellations", previous.allow_cancellations);
            if (title.length < 3 || title.length > 120 || !location || location.length > 200 ||
              description.length > 2000 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
              fail(400, "Enter a valid title, description, date, location, and capacity.");
            }
            if (duplicatePolicy !== "EMAIL_ONCE" && duplicatePolicy !== "ALLOW_DUPLICATES") fail(400, "Choose a valid duplicate registration rule.");
            if (typeof allowCancellations !== "boolean") fail(400, "Cancellation setting must be enabled or disabled.");
            if (registrationStart && registrationEnd && Date.parse(registrationStart) >= Date.parse(registrationEnd)) {
              fail(400, "Registration must end after it starts.");
            }
            if (registrationEnd && Date.parse(registrationEnd) > Date.parse(startsAt)) fail(400, "Registration must close before the event starts.");
            const active = await client.query("SELECT COUNT(*) AS count FROM registrations WHERE event_id=$1 AND status <> 'CANCELLED'", [eventIdPath[1]]);
            if (capacity < Number(active.rows[0].count)) fail(409, "Capacity cannot be lower than the number of active registrations.");
            importantDetailsChanged =
              new Date(previous.starts_at).getTime() !== new Date(startsAt).getTime() ||
              previous.location !== location;
            const banner = Object.hasOwn(body, "bannerData") ? parseImage(body.bannerData) : null;
            const removeBanner = body.removeBanner === true;
            const updated = await client.query(`
              UPDATE events SET title=$1,description=$2,starts_at=$3,location=$4,capacity=$5,
                registration_start_at=$6,registration_end_at=$7,
                duplicate_policy=$8,allow_cancellations=$9,
                banner_data=CASE WHEN $10 THEN NULL WHEN $11 THEN $12 ELSE banner_data END,
                banner_mime=CASE WHEN $10 THEN NULL WHEN $11 THEN $13 ELSE banner_mime END,
                updated_at=NOW()
              WHERE id=$14 RETURNING id
            `, [
              title, description, startsAt, location, capacity, registrationStart, registrationEnd,
              duplicatePolicy, allowCancellations, removeBanner, Boolean(banner),
              banner?.bytes || null, banner?.mime || null, eventIdPath[1]
            ]);
            updatedEventId = updated.rows[0].id;
            await replaceEventQuestions(client, updatedEventId, questions);
            await writeAuditLog(client, {
              eventId: updatedEventId,
              actorId: current.id,
              action: "EVENT_UPDATED",
              entityType: "event",
              entityId: updatedEventId,
              metadata: {
                changedFields: [
                  "title", "description", "startsAt", "location", "capacity",
                  "registrationStartAt", "registrationEndAt", "duplicatePolicy",
                  "allowCancellations", "questions", "bannerData", "removeBanner"
                ].filter(field => Object.hasOwn(body, field))
              }
            });
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          const withStats = await getEvent(pool, updatedEventId);
          if (!withStats) fail(404, "Event not found.");
          if (importantDetailsChanged) {
            notifyEventAttendeesInBackground(updatedEventId, {
              subject: `Event details updated: ${withStats.title}`,
              text: `Important details for ${withStats.title} have changed.\n\nDate and time: ${new Date(withStats.starts_at).toISOString()}\nVenue: ${withStats.location}\n\nPlease review these updated event details before attending.`
            });
          }
          return jsonResponse(response, 200, { event: eventView(withStats) });
        }
        if (eventIdPath && method === "DELETE") {
          await eventAccess(eventIdPath[1]);
          requireRole("PLATFORM_ADMIN", "ORGANIZER");
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const archived = await client.query(`
              UPDATE events SET archived_at=NOW(),updated_at=NOW()
              WHERE id=$1 AND archived_at IS NULL RETURNING id
            `, [eventIdPath[1]]);
            if (!archived.rowCount) fail(404, "Event not found.");
            await writeAuditLog(client, {
              eventId: eventIdPath[1],
              actorId: current.id,
              action: "EVENT_ARCHIVED",
              entityType: "event",
              entityId: eventIdPath[1]
            });
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          return jsonResponse(response, 200, { archived: true });
        }

        fail(404, `API route not found: ${method} ${url.pathname}`);
      }

      serveStatic(url.pathname, response);
    } catch (error) {
      if (response.headersSent) return response.end();
      let status = Number.isInteger(error.status) ? error.status : 500;
      if (error.code === "23505") status = 409;
      if (status === 500) console.error("Request failed:", error);
      jsonResponse(response, status, {
        error: status === 500 ? "An unexpected server error occurred." : error.message
      });
    }
  });
  server.on("close", () => pool.end().catch(error => console.error("Database shutdown failed:", error)));
  return server;
}

async function readBody(request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method)) return {};
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) fail(413, "Request body is too large.");
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(400, "Expected a JSON object.");
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    fail(400, "Request body must be valid JSON.");
  }
}

function serveStatic(pathname, response) {
  const requested = pathname === "/" || pathname === "/reset-password" ? "index.html" : decodeURIComponent(pathname).slice(1);
  const isQrScannerBundle = pathname === "/vendor/zxing-browser.min.js";
  if (!["index.html", "styles.css", "app.js"].includes(requested) && !isQrScannerBundle) {
    response.writeHead(404);
    return response.end("Not found");
  }
  const file = isQrScannerBundle
    ? resolve(root, "node_modules/@zxing/browser/umd/zxing-browser.min.js")
    : resolve(publicRoot, requested);
  if (!existsSync(file)) {
    response.writeHead(404);
    return response.end("Not found");
  }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  response.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    ...securityHeaders
  });
  response.end(readFileSync(file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createApp();
    const port = Number(process.env.PORT || 3000);
    server.listen(port, () => console.info(`GatherFlow running at http://localhost:${port}`));
  } catch (error) {
    const causes = error instanceof AggregateError ? error.errors : [error];
    const connectionFailures = causes.filter(cause =>
      ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(cause?.code)
    );
    const missingPassword = causes.some(cause =>
      /client password must be a string/i.test(cause?.message || "")
    );
    const schemaPermissionDenied = causes.some(cause => cause?.code === "42501");
    if (schemaPermissionDenied) {
      console.error("GatherFlow's PostgreSQL user cannot create tables in the database's public schema.");
      console.error("As a database administrator, make gatherflow the database/schema owner or grant it CREATE on schema public.");
      console.error("For example, run: GRANT USAGE, CREATE ON SCHEMA public TO gatherflow;");
    } else if (missingPassword) {
      console.error("GatherFlow could not authenticate to PostgreSQL because its password is missing or not a string.");
      console.error("Set PGPASSWORD to the password for PGUSER, or include a password in DATABASE_URL.");
    } else if (connectionFailures.length) {
      const host = process.env.PGHOST || "localhost";
      const port = process.env.PGPORT || "5432";
      const configuredBy = process.env.DATABASE_URL ? "DATABASE_URL" : "PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE";
      console.error(`GatherFlow could not connect to PostgreSQL (${configuredBy}; ${host}:${port}).`);
      console.error("Start PostgreSQL and verify the database connection settings before starting GatherFlow.");
      for (const cause of connectionFailures) {
        console.error(`  ${cause.code}: ${cause.message}`);
      }
    } else {
      console.error("GatherFlow failed to start:", error);
    }
    process.exitCode = 1;
  }
}
