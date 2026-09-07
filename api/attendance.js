const { kv } = require('@vercel/kv');
const { requireAuth, requireRole } = require('./_auth');
const { logAccountChange } = require('./_account-log');

// All attendance punches live in one Redis hash: { "date|username": JSON string }.
// date is YYYY-MM-DD in Asia/Manila local time, computed server-side so the
// stamp is trustworthy no matter what the client's clock says.
const KEY = 'attendance-log';

// A day's punches happen in this fixed order: clock in for the morning,
// clock out for lunch, clock back in for the afternoon, clock out at the
// end of the regular shift. Overtime is a separate, optional pair that
// only becomes available once the regular shift is done — it isn't
// forced to happen every day.
const STEPS = [
  { action: 'morning_in', field: 'morningIn', requires: null, label: 'clocked in for the morning' },
  { action: 'noon_out', field: 'noonOut', requires: 'morningIn', label: 'clocked out for lunch' },
  { action: 'afternoon_in', field: 'afternoonIn', requires: 'noonOut', label: 'clocked in for the afternoon' },
  { action: 'afternoon_out', field: 'afternoonOut', requires: 'afternoonIn', label: 'clocked out for the day' },
  { action: 'ot_in', field: 'otIn', requires: 'afternoonOut', label: 'started overtime' },
  { action: 'ot_out', field: 'otOut', requires: 'otIn', label: 'ended overtime' }
];
const STEP_BY_ACTION = Object.fromEntries(STEPS.map((s) => [s.action, s]));

// Geofence: the office's fixed coordinates and how far (in meters) a punch
// can be from that point before it's flagged as off-site. Set OFFICE_LAT /
// OFFICE_LNG / OFFICE_RADIUS_M env vars to override — these defaults are
// Mardam Sign Ads' actual pin, radius 100m.
const OFFICE_LAT = parseFloat(process.env.OFFICE_LAT || '10.3481995');
const OFFICE_LNG = parseFloat(process.env.OFFICE_LNG || '123.9297401');
const OFFICE_RADIUS_M = parseFloat(process.env.OFFICE_RADIUS_M || '200');

// Great-circle distance between two lat/lng points, in meters (Haversine).
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Builds the geo-check result stored alongside a punch. Punches with no
// coordinates (location denied/unavailable) are flagged off-site too,
// since they can't be verified — but are still recorded, per policy: we
// flag suspicious punches for admin review rather than blocking them
// outright (network hiccups or a denied permission shouldn't lock
// someone out of clocking in).
function geoCheck(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return { lat: null, lng: null, distanceM: null, offsite: true, reason: 'no-location' };
  }
  const distanceM = Math.round(distanceMeters(lat, lng, OFFICE_LAT, OFFICE_LNG));
  return { lat, lng, distanceM, offsite: distanceM > OFFICE_RADIUS_M, reason: distanceM > OFFICE_RADIUS_M ? 'outside-geofence' : null };
}

function manilaNow() {
  // Vercel's runtime clock is UTC — shift to Asia/Manila (UTC+8) so "today"
  // lines up with the shop's actual business day.
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}
function manilaDateStr(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (already Manila-shifted)
}
function fieldKey(date, username) {
  return `${date}|${username}`;
}
function blankRecord(username, date) {
  return { username, date, morningIn: null, noonOut: null, afternoonIn: null, afternoonOut: null, otIn: null, otOut: null, geo: {} };
}

module.exports = async (req, res) => {
  // Clock in / clock out through the day's sequence. Any logged-in account
  // (Staff, Admin, Super Admin, Accounting) punches their own attendance —
  // the timestamp is always taken from the server clock, never trusted
  // from the client.
  if (req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return;

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }
    }
    body = body || {};

    const step = STEP_BY_ACTION[body.action];
    if (!step) {
      res.status(400).json({ error: 'action must be one of: ' + STEPS.map((s) => s.action).join(', ') });
      return;
    }

    const now = manilaNow();
    const date = manilaDateStr(now);
    const nowIso = new Date().toISOString(); // stored as true UTC instant
    const key = fieldKey(date, auth.username);

    const existingRaw = await kv.hget(KEY, key);
    const existing = existingRaw ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw) : blankRecord(auth.username, date);

    if (existing[step.field]) {
      res.status(409).json({ error: `Already ${step.label} today`, record: existing });
      return;
    }
    if (step.requires && !existing[step.requires]) {
      const requiredStep = STEPS.find((s) => s.field === step.requires);
      res.status(400).json({ error: `You need to have ${requiredStep.label} first`, record: existing });
      return;
    }

    const record = {
      ...existing,
      [step.field]: nowIso,
      geo: { ...(existing.geo || {}), [step.field]: geoCheck(body.lat, body.lng) }
    };
    await kv.hset(KEY, { [key]: JSON.stringify(record) });
    res.status(200).json({ ok: true, record });
    return;
  }

  // GET without ?report=1 — the caller's own today's punches, for the
  // clock-in/out widget. Available to any logged-in account.
  //
  // GET with ?report=1 — the full attendance log across every employee
  // for an optional date range (defaults to the last 31 days). This is
  // the "attendance results" view and is Super Admin/Admin only.
  if (req.method === 'GET') {
    if (req.query.report === '1') {
      const auth = requireAuth(req, res);
      if (!auth) return;

      // Super Admin and Admin get the full company-wide report (every
      // employee). Staff only ever gets their OWN records — `mine=1` is
      // how the frontend asks for that explicitly, but the restriction is
      // enforced here regardless of what's passed, so a Staff account can
      // never pull another employee's history.
      const isSelfOnly = auth.role !== 'super_admin' && auth.role !== 'admin';

      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : manilaDateStr(manilaNow());
      const defaultFrom = manilaDateStr(new Date(manilaNow().getTime() - 30 * 24 * 60 * 60 * 1000));
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : defaultFrom;

      const all = (await kv.hgetall(KEY)) || {};
      const rows = Object.values(all)
        .map((v) => {
          try {
            const r = typeof v === 'string' ? JSON.parse(v) : v;
            // Older single-punch records only have timeIn/timeOut — map
            // them onto the new fields so old data still shows up.
            if (r && (r.timeIn !== undefined || r.timeOut !== undefined) && r.morningIn === undefined) {
              return { ...r, morningIn: r.timeIn || null, afternoonOut: r.timeOut || null, noonOut: null, afternoonIn: null, otIn: null, otOut: null };
            }
            return r;
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean)
        .filter((r) => r.date >= from && r.date <= to)
        .filter((r) => !isSelfOnly || r.username === auth.username)
        .sort((a, b) => (b.date === a.date ? a.username.localeCompare(b.username) : b.date.localeCompare(a.date)));

      res.status(200).json({ rows, from, to });
      return;
    }

    const auth = requireAuth(req, res);
    if (!auth) return;

    const date = manilaDateStr(manilaNow());
    const raw = await kv.hget(KEY, fieldKey(date, auth.username));
    let today = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (today && (today.timeIn !== undefined || today.timeOut !== undefined) && today.morningIn === undefined) {
      today = { ...today, morningIn: today.timeIn || null, afternoonOut: today.timeOut || null, noonOut: null, afternoonIn: null, otIn: null, otOut: null };
    }
    res.status(200).json({ today, date });
    return;
  }

  // Remove one attendance punch record (one date, one employee). This
  // edits the payroll-relevant record directly, so it's restricted to the
  // Super Admin only, and logged the same way password resets and other
  // sensitive account changes are.
  if (req.method === 'DELETE') {
    const auth = requireRole(req, res, ['super_admin']);
    if (!auth) return;

    const date = String(req.query.date || '');
    const username = String(req.query.username || '').trim().toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !username) {
      res.status(400).json({ error: 'Missing or invalid date/username' });
      return;
    }

    const key = fieldKey(date, username);
    const existingRaw = await kv.hget(KEY, key);
    if (!existingRaw) {
      res.status(404).json({ error: 'No attendance record found for that date/employee' });
      return;
    }

    await kv.hdel(KEY, key);
    await logAccountChange({
      type: 'attendance-deleted',
      username,
      changedBy: auth.username,
      changedByRole: auth.role,
      details: `Deleted attendance record for ${date}`
    });
    res.status(200).json({ ok: true });
    return;
  }

  // Edit one or more punch times on an attendance record, or manually
  // create one from scratch for an employee/date that has no punches yet
  // (Super Admin and Admin only). Accepts each field as either an ISO
  // instant or null to clear it — the client sends a Manila-local HH:MM
  // converted to a UTC ISO instant for the record's date, so what's
  // stored stays consistent with how punches are recorded normally.
  if (req.method === 'PATCH') {
    const auth = requireRole(req, res, ['super_admin', 'admin']);
    if (!auth) return;

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body || '{}');
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }
    }
    body = body || {};

    const date = String(body.date || '');
    const username = String(body.username || '').trim().toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !username) {
      res.status(400).json({ error: 'Missing or invalid date/username' });
      return;
    }

    const key = fieldKey(date, username);
    const existingRaw = await kv.hget(KEY, key);
    // No record yet for this employee/date is fine here — Admin/Super
    // Admin manually entering an attendance record for the first time
    // (e.g. an employee forgot to clock in) starts from a blank one.
    const isNewRecord = !existingRaw;
    const existing = existingRaw ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw) : blankRecord(username, date);

    const EDITABLE_FIELDS = ['morningIn', 'noonOut', 'afternoonIn', 'afternoonOut', 'otIn', 'otOut'];
    const updated = { ...existing, geo: { ...(existing.geo || {}) } };
    const changes = [];
    for (const field of EDITABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const value = body[field];
      if (value === null || value === '') {
        if (updated[field]) changes.push(`${field}: cleared`);
        updated[field] = null;
        delete updated.geo[field];
        continue;
      }
      const parsed = new Date(value);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: `Invalid time value for ${field}` });
        return;
      }
      if (updated[field] !== value) changes.push(`${field}: ${value}`);
      updated[field] = parsed.toISOString();
      // A field an Admin/Super Admin manually set (or corrected) is a
      // trusted, on-record entry — it doesn't carry a real GPS location,
      // so it should never show an "Off-site" badge like a live punch.
      delete updated.geo[field];
    }

    await kv.hset(KEY, { [key]: JSON.stringify(updated) });
    if (isNewRecord) {
      await logAccountChange({
        type: 'attendance-manual-added',
        username,
        changedBy: auth.username,
        changedByRole: auth.role,
        details: `Manually added attendance for ${date}${changes.length ? ' — ' + changes.join(', ') : ''}`
      });
    } else if (changes.length > 0) {
      await logAccountChange({
        type: 'attendance-edited',
        username,
        changedBy: auth.username,
        changedByRole: auth.role,
        details: `Edited attendance for ${date} — ${changes.join(', ')}`
      });
    }
    res.status(200).json({ ok: true, record: updated });
    return;
  }

  res.status(405).send('Method not allowed');
};