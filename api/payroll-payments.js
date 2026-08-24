const { kv } = require('@vercel/kv');
const { requireRole } = require('../lib/auth');

// Track record of which employees have actually been PAID for a given
// payroll period, separate from generatePayroll() (in index.html) which
// only *computes* what's owed on the fly and never persists anything.
// One record per (username, from, to) combo — running payroll again for
// the same dates does not create a duplicate; marking as paid again just
// overwrites the record (e.g. to fix a typo'd amount).
const KEY = 'payroll-payments';

function recordId(username, from, to) {
  return `${username}__${from}__${to}`;
}

module.exports = async (req, res) => {
  // List payment records, optionally filtered by date range and/or
  // employee. Used both to show "Paid" badges on the current Payroll
  // breakdown and to render the standalone Payment History table.
  if (req.method === 'GET') {
    const auth = requireRole(req, res, ['super_admin']);
    if (!auth) return;

    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const username = req.query.username || null;

    const all = (await kv.hgetall(KEY)) || {};
    const payments = Object.values(all)
      .map((v) => {
        try {
          return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      // A record's period [from, to] counts as "in range" if it overlaps
      // the requested range at all — not just an exact match — so a
      // payroll run for 8/1–8/15 still shows as paid when someone later
      // asks about 8/1–8/31.
      .filter((p) => (!from || p.to >= from) && (!to || p.from <= to))
      .filter((p) => !username || p.username === username)
      .sort((a, b) => (b.paidAt || '').localeCompare(a.paidAt || ''));

    res.status(200).json({ payments });
    return;
  }

  // Mark an employee as paid for a specific period.
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

    const username = String(body.username || '').trim();
    const from = String(body.from || '');
    const to = String(body.to || '');
    if (!username) {
      res.status(400).json({ error: 'Missing username' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
      return;
    }
    const netPay = Number(body.netPay);
    if (!Number.isFinite(netPay)) {
      res.status(400).json({ error: 'netPay must be a number' });
      return;
    }

    const id = recordId(username, from, to);
    const record = {
      id,
      username,
      displayName: String(body.displayName || username).slice(0, 120),
      from,
      to,
      netPay,
      paidBy: auth.username,
      paidAt: new Date().toISOString()
    };
    await kv.hset(KEY, { [id]: JSON.stringify(record) });
    res.status(200).json({ ok: true, payment: record });
    return;
  }

  // Undo a "paid" mark (e.g. it was clicked by mistake).
  if (req.method === 'DELETE') {
    const auth = requireRole(req, res, ['super_admin']);
    if (!auth) return;

    const username = req.query.username;
    const from = req.query.from;
    const to = req.query.to;
    if (!username || !from || !to) {
      res.status(400).json({ error: 'Missing username/from/to' });
      return;
    }
    await kv.hdel(KEY, recordId(username, from, to));
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};
