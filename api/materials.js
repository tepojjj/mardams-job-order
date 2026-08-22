const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess } = require('./_auth');

// The master Material List — one row per material, with its Supplier,
// Brand, and Unit. Inventory and Purchase History both reference rows
// here (by id) instead of storing their own copies of Material/Supplier/
// Unit, so editing a material here keeps everything else in sync.
// All rows live in one Redis hash: { [rowId]: JSON }.
const KEY = 'material-list';

module.exports = async (req, res) => {
  // List every material. Any logged-in Apparel account can view.
  if (req.method === 'GET') {
    const auth = requireJobOrdersAccess(req, res);
    if (!auth) return;

    const all = (await kv.hgetall(KEY)) || {};
    const rows = Object.values(all)
      .map((v) => {
        try {
          return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    res.status(200).json({ rows });
    return;
  }

  // Create or update a material row. Any logged-in Apparel account
  // (Staff, Admin, or Super Admin) can add or edit — same as the
  // Monitoring Sheet, not tied to the stricter job-order edit permissions.
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

    const auth = requireJobOrdersAccess(req, res);
    if (!auth) return;

    const { id, data } = body;
    if (!id || !data) {
      res.status(400).json({ error: 'Missing id or data' });
      return;
    }

    await kv.hset(KEY, { [id]: JSON.stringify(data) });
    res.status(200).json({ ok: true });
    return;
  }

  // Delete a material row by id.
  if (req.method === 'DELETE') {
    const auth = requireJobOrdersAccess(req, res);
    if (!auth) return;

    const { id } = req.query;
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
