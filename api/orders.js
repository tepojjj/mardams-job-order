const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess, requireJobOrdersRole } = require('./_auth');

// All saved job orders live in one Redis hash: { [joNumber]: JSON string }.
// This is separate from api/counter.js (which only tracks the running number).
const KEY = 'job-orders';

module.exports = async (req, res) => {
  // List every saved job order, most recently saved first. Any logged-in
  // account (Staff, Admin, or Super Admin) can browse job orders.
  if (req.method === 'GET') {
    const auth = requireJobOrdersAccess(req, res);
    if (!auth) return;

    const all = (await kv.hgetall(KEY)) || {};
    const orders = Object.values(all)
      .map((v) => {
        try {
          return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));

    res.status(200).json({ orders });
    return;
  }

  // Save/update a job order. Any logged-in account can create a NEW job
  // order (this is what the normal Print/Save-as-PDF flow uses for staff).
  // Editing an EXISTING job order's details from the Browse tab is
  // restricted to Admin and Super Admin accounts (Staff has view-only
  // access) — the client sends isEdit:true for that flow, so it's enforced
  // here server-side, not just by hiding the Edit button in the UI.
  if (req.method === 'POST') {
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

    const { id, data, isEdit } = body;

    const auth = isEdit ? requireJobOrdersRole(req, res, ['admin', 'super_admin']) : requireJobOrdersAccess(req, res);
    if (!auth) return;

    if (!id || !data) {
      res.status(400).json({ error: 'Missing id or data' });
      return;
    }

    await kv.hset(KEY, { [id]: JSON.stringify(data) });
    res.status(200).json({ ok: true });
    return;
  }

  // Delete a job order. Restricted to Admin and Super Admin accounts.
  if (req.method === 'DELETE') {
    const auth = requireJobOrdersRole(req, res, ['admin', 'super_admin']);
    if (!auth) return;

    const id = req.query.id;
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    await kv.hdel(KEY, id);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};
