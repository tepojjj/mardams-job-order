const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess } = require('../lib/auth');

// Every stock movement — Stock In and Stock Out — for every material.
// Inventory's Current Stock is not stored anywhere; it's computed by
// summing this ledger per material (all "in" rows minus all "out" rows).
//
// Two kinds of rows live here:
//  - source: "purchase"  — auto-created/updated by Purchase History
//    whenever a purchase row's Material/Qty is saved (id is always
//    `purchase-<purchaseRowId>` so re-saving updates the same row
//    instead of creating a duplicate, and deleting the purchase row
//    deletes this one too). These are read-only from this tab.
//  - source: "manual"    — typed in by hand here, mainly Stock Out
//    entries by personnel when a material is used, but Stock In
//    corrections are allowed too.
//
// All rows live in one Redis hash: { [rowId]: JSON }.
const KEY = 'stock-ledger';

module.exports = async (req, res) => {
  // List every ledger row. Any logged-in Apparel account can view.
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

  // Create or update a ledger row (upsert by id — see the note above
  // about how Purchase History reuses `purchase-<purchaseRowId>`).
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

  // Delete a ledger row by id.
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
