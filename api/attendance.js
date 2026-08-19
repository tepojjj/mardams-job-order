const { kv } = require('@vercel/kv');
const { requireAuth, requireRole } = require('./_auth');

// All attendance punches live in one Redis hash: { "date|username": JSON string }.
// date is YYYY-MM-DD in Asia/Manila local time, computed server-side so the
// stamp is trustworthy no matter what the client's clock says.
const KEY = 'attendance-log';

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

module.exports = async (req, res) => {
  // Clock in / clock out. Any logged-in account (Staff, Admin, Super Admin)
  // punches their own attendance — the timestamp is always taken from the
  // server clock, never trusted from the client.
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

    const action = body.action;
    if (!['clock_in', 'clock_out'].includes(action)) {
      res.status(400).json({ error: 'action must be clock_in or clock_out' });
      return;
    }

    const now = manilaNow();
    const date = manilaDateStr(now);
    const nowIso = new Date().toISOString(); // stored as true UTC instant
    const key = fieldKey(date, auth.username);

    const existingRaw = await kv.hget(KEY, key);
    const existing = existingRaw ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw) : null;

    if (action === 'clock_in') {
      if (existing && existing.timeIn) {
        res.status(409).json({ error: 'Already clocked in today', record: existing });
        return;
      }
      const record = { username: auth.username, date, timeIn: nowIso, timeOut: null };
      await kv.hset(KEY, { [key]: JSON.stringify(record) });
      res.status(200).json({ ok: true, record });
      return;
    }

    // clock_out
    if (!existing || !existing.timeIn) {
      res.status(400).json({ error: "You haven't clocked in yet today" });
      return;
    }
    if (existing.timeOut) {
      res.status(409).json({ error: 'Already clocked out today', record: existing });
      return;
    }
    const record = { ...existing, timeOut: nowIso };
    await kv.hset(KEY, { [key]: JSON.stringify(record) });
    res.status(200).json({ ok: true, record });
    return;
  }

  // GET without ?report=1 — the caller's own today's punch, for the
  // clock-in/out widget. Available to any logged-in account.
  //
  // GET with ?report=1 — the full attendance log across every employee
  // for an optional date range (defaults to the last 31 days). This is
  // the "attendance results" view and is Super Admin only.
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
            return typeof v === 'string' ? JSON.parse(v) : v;
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
    const today = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    res.status(200).json({ today, date });
    return;
  }

  res.status(405).send('Method not allowed');
};
