const { kv } = require('@vercel/kv');
const { requireAuth } = require('./_auth');

// The Monitoring Sheet is a standalone manual tracker — separate from the
// job-order records in api/orders.js. Rows are typed in by hand (Date, JO
// number, client, description, sizes, etc.) rather than being derived from
// any saved job order. All rows live in one Redis hash: { [rowId]: JSON }.
const KEY = 'monitoring-sheet';

module.exports = async (req, res) => {
  // List every row. Any logged-in account can view the sheet.
  if (req.method === 'GET') {
    const auth = requireAuth(req, res);
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

    const auth = requireAuth(req, res);
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

  // Delete a row. Any logged-in account can remove rows.
  if (req.method === 'DELETE') {
    const auth = requireAuth(req, res);
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
