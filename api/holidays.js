const { kv } = require('@vercel/kv');
const { requireRole } = require('./_auth');

// Company-wide holiday calendar used to compute holiday pay. One holiday
// per calendar date. The Super Admin manages this list —
// the same role that runs Payroll — since it's what tells
// generatePayroll() (in index.html) which dates get holiday-pay rules
// instead of ordinary Present/Late/Absent/Undertime treatment.
const KEY = 'payroll-holidays';

const TYPES = ['regular', 'special_non_working', 'special_working'];

// Fixed/recurring Philippine *regular* holidays (Labor Code Art. 94) —
// everything else the public holidays source returns (Chinese New Year,
// EDSA anniversary, All Saints' Day, Christmas Eve, Eid'l Fitr/Adha,
// etc.) is proclaimed as a *special non-working* day, so that's the
// default guess for anything not in this list. Movable dates (Maundy
// Thursday, Good Friday, Eid'l Fitr, Eid'l Adha) are matched by name,
// not a fixed date, since they shift every year.
const REGULAR_HOLIDAY_NAME_MATCHES = [
  "new year's day",
  'maundy thursday',
  'good friday',
  'araw ng kagitingan',
  'day of valor',
  'labor day',
  'labour day',
  'independence day',
  'national heroes day',
  'ninoy aquino day', // regular in some years, special non-working in others — flagged for review either way
  'bonifacio day',
  'christmas day',
  'rizal day'
];

function guessHolidayType(name) {
  const n = String(name || '').toLowerCase();
  return REGULAR_HOLIDAY_NAME_MATCHES.some((m) => n.includes(m)) ? 'regular' : 'special_non_working';
}

module.exports = async (req, res) => {
  // Suggest official PH public holidays for a year, sourced from a
  // public holiday API, for the Super Admin to review and add — this
  // never writes anything by itself. Type is a best guess (see
  // guessHolidayType above); movable special non-working days that
  // Malacañang proclaims individually each year (e.g. an extra bridge
  // holiday) won't show up here and still need to be added by hand.
  if (req.method === 'GET' && req.query.action === 'suggest') {
    const auth = requireRole(req, res, ['super_admin']);
    if (!auth) return;

    const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());

    let upstream;
    try {
      upstream = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/PH`);
    } catch (e) {
      res.status(502).json({ error: 'Could not reach the holiday source. Check your connection and try again.' });
      return;
    }
    if (!upstream.ok) {
      res.status(502).json({ error: 'Could not reach the holiday source. Try again later.' });
      return;
    }

    let data;
    try {
      data = await upstream.json();
    } catch (e) {
      res.status(502).json({ error: 'The holiday source returned something unexpected.' });
      return;
    }

    const existing = (await kv.hgetall(KEY)) || {};
    const suggestions = (Array.isArray(data) ? data : [])
      .map((h) => ({
        date: h.date,
        name: h.localName || h.name || 'Holiday',
        type: guessHolidayType(h.localName || h.name)
      }))
      .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date) && !existing[h.date])
      .sort((a, b) => a.date.localeCompare(b.date));

    res.status(200).json({ suggestions, year });
    return;
  }

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
