const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess } = require('./_auth');

// The Monitoring Sheet is a standalone manual tracker — separate from the
// job-order records in api/orders.js. Rows are typed in by hand (Date, JO
// number, client, description, remarks, etc.) rather than being derived
// from any saved job order. All rows live in one Redis hash: { [rowId]: JSON }.
const KEY = 'monitoring-sheet';

module.exports = async (req, res) => {
  // List every row. Any logged-in account can view the sheet.
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

  // Create or update a row. Any logged-in account (Staff, Admin, or Super
  // Admin) can add or edit rows — this is a shared manual tracker, not
  // tied to the stricter job-order edit permissions.
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

  // Delete a row (by id), or every row linked to a job order (by
  // joNumber — used when that job order itself gets deleted, so the
  // monitoring sheet doesn't keep orphaned rows pointing at it).
  if (req.method === 'DELETE') {
    const auth = requireJobOrdersAccess(req, res);
    if (!auth) return;

    const { id, joNumber } = req.query;

    if (joNumber) {
      const all = (await kv.hgetall(KEY)) || {};
      const idsToRemove = Object.entries(all)
        .filter(([, v]) => {
          try {
            const row = typeof v === 'string' ? JSON.parse(v) : v;
            return row && row.joNumber === joNumber;
          } catch (e) {
            return false;
          }
        })
        .map(([rowId]) => rowId);

      if (idsToRemove.length > 0) {
        await kv.hdel(KEY, ...idsToRemove);
      }
      res.status(200).json({ ok: true, deleted: idsToRemove.length });
      return;
    }

    if (!id) {
      res.status(400).json({ error: 'Missing id or joNumber' });
      return;
    }

    await kv.hdel(KEY, id);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};
