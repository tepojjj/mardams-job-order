const { kv } = require('@vercel/kv');
const { requireRole } = require('./_auth');

// Company-wide holiday calendar used to compute holiday pay. One holiday
// per calendar date. The Super Admin manages this list —
// the same role that runs Payroll — since it's what tells
// generatePayroll() (in index.html) which dates get holiday-pay rules
// instead of ordinary Present/Late/Absent/Undertime treatment.
const KEY = 'payroll-holidays';

const TYPES = ['regular', 'special_non_working', 'special_working'];

module.exports = async (req, res) => {
  // List holidays, optionally within a date range. Super Admin
  // only — this app's Payroll tab is the only place holidays are used.
  if (req.method === 'GET') {
    const auth = requireRole(req, res, ['super_admin']);
    if (!auth) return;

    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;

    const all = (await kv.hgetall(KEY)) || {};
    const holidays = Object.values(all)
      .map((v) => {
        try {
          return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .filter((h) => (!from || h.date >= from) && (!to || h.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.status(200).json({ holidays });
    return;
  }

  // Add or update a holiday (one per date — saving the same date again
  // overwrites it, which is how "editing" a holiday works from the UI).
  if (req.method === 'POST') {
    const auth = requireRole(req, res, ['super_admin']);
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
      return;
    }
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) {
      res.status(400).json({ error: 'Holiday name is required' });
      return;
    }
    const type = String(body.type || '');
    if (!TYPES.includes(type)) {
      res.status(400).json({ error: 'Type must be regular, special_non_working, or special_working' });
      return;
    }

    const record = { date, name, type, createdBy: auth.username, createdAt: new Date().toISOString() };
    await kv.hset(KEY, { [date]: JSON.stringify(record) });
    res.status(200).json({ ok: true, holiday: record });
    return;
  }

  // Remove a holiday.
  if (req.method === 'DELETE') {
    const auth = requireRole(req, res, ['super_admin']);
    if (!auth) return;

    const date = req.query.date;
    if (!date) {
      res.status(400).json({ error: 'Missing date' });
      return;
    }
    await kv.hdel(KEY, date);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};
