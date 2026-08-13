const { kv } = require('@vercel/kv');
const { requireAuth } = require('./_auth');

const KEY = 'last-job-order-number';

module.exports = async (req, res) => {
  // Preview the next number — does NOT save anything.
  if (req.method === 'GET') {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const existing = await kv.get(KEY);
    const next = existing ? parseInt(existing, 10) + 1 : 1;
    res.status(200).json({ next });
    return;
  }

  if (req.method === 'POST') {
    const auth = requireAuth(req, res);
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

    // Reset the counter entirely — next preview will start back at 1.
    if (body.action === 'reset') {
      await kv.del(KEY);
      res.status(200).json({ ok: true });
      return;
    }

    // Save the number that was actually used (called when the order is printed).
    if (body.action === 'commit' && Number.isFinite(body.value)) {
      await kv.set(KEY, String(body.value));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  res.status(405).send('Method not allowed');
};
