const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess } = require('./_auth');

// One serverless function handling two related resources, so this
// stays a single function on Vercel's Hobby plan (12-function cap)
// instead of two. Pick the resource with ?resource=materials|stock
// (materials is the default when omitted).
//
// resource=materials — the master Material List: one row per material,
// with its Supplier, Brand, and Unit. Inventory and Purchase History
// reference rows here by id instead of storing their own copies.
//
// resource=stock — every Stock In/Out movement for every material.
// Inventory's Current Stock is computed by summing this ledger per
// material, never stored directly. Purchase History keeps exactly one
// auto "in" row here per purchase row (id `purchase-<purchaseRowId>`);
// everything else is a manual row from the Stock In/Out tab.
//
// Each resource is its own Redis hash: { [rowId]: JSON }.
const KEYS = {
  materials: 'material-list',
  stock: 'stock-ledger',
};

function resolveKey(req){
  const resource = req.query && req.query.resource;
  return KEYS[resource] || KEYS.materials;
}

module.exports = async (req, res) => {
  const KEY = resolveKey(req);

  // List every row for the resource. Any logged-in Apparel account can view.
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

  // Create or update a row (upsert by id). Any logged-in Apparel account
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

  // Delete a row by id.
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
