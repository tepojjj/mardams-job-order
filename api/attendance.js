const { kv } = require('@vercel/kv');
const { requireAuth, requireRole } = require('./_auth');

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
  return { username, date, morningIn: null, noonOut: null, afternoonIn: null, afternoonOut: null, otIn: null, otOut: null };
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

    const record = { ...existing, [step.field]: nowIso };
    await kv.hset(KEY, { [key]: JSON.stringify(record) });
    res.status(200).json({ ok: true, record });
    return;
  }

  // GET without ?report=1 — the caller's own today's punches, for the
  // clock-in/out widget. Available to any logged-in account.
  //
  // GET with ?report=1 — the full attendance log across every employee
  // for an optional date range (defaults to the last 31 days). This is
  // the "attendance results" view and is Super Admin/Accounting only.
  if (req.method === 'GET') {
    if (req.query.report === '1') {
      const auth = requireRole(req, res, ['super_admin']);
      if (!auth) return;

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

  res.status(405).send('Method not allowed');
};
