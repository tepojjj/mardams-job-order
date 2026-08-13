const { kv } = require('@vercel/kv');

// All saved job orders live in one Redis hash: { [joNumber]: JSON string }.
// This is separate from api/counter.js (which only tracks the running number).
const KEY = 'job-orders';

module.exports = async (req, res) => {
  // List every saved job order, most recently saved first.
  if (req.method === 'GET') {
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

    const { id, data } = body;
    if (!id || !data) {
      res.status(400).json({ error: 'Missing id or data' });
      return;
    }

    await kv.hset(KEY, { [id]: JSON.stringify(data) });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};