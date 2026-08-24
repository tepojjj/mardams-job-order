const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess } = require('../lib/auth');

const KEY = 'last-job-order-number';

module.exports = async (req, res) => {
  // Preview the next number — does NOT save anything.
  if (req.method === 'GET') {
    const auth = requireJobOrdersAccess(req, res);
    if (!auth) return;

    const existing = await kv.get(KEY);
    const next = existing ? parseInt(existing, 10) + 1 : 1;
    res.status(200).json({ next });
    return;
  }

  if (req.method === 'POST') {
    const auth = requireJobOrdersAccess(req, res);
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

    // Atomically claim the next number (used when printing with an
    // auto-suggested number). kv.incr is atomic, so two people printing
    // at the same moment can never end up with the same number — one
    // request will always land on N, the other on N+1.
    if (body.action === 'increment') {
      const value = await kv.incr(KEY);
      res.status(200).json({ value });
      return;
    }

    // Give back a number that was claimed but never actually printed/saved
    // (e.g. the user hit Cancel in the browser's print dialog). Only rolls
    // back if nobody has claimed a newer number since — otherwise it's a
    // no-op, so this can never create a fresh collision.
    if (body.action === 'release' && Number.isFinite(body.value)) {
      const existing = await kv.get(KEY);
      const current = existing ? parseInt(existing, 10) : 0;
      if (current === body.value) {
        await kv.set(KEY, String(body.value - 1));
        res.status(200).json({ ok: true, released: true });
        return;
      }
      res.status(200).json({ ok: true, released: false });
      return;
    }

    // Save a manually-typed custom number. Only ever moves the counter
    // forward, never backward, so a custom number can't accidentally
    // rewind (and re-collide with) numbers that were already claimed.
    if (body.action === 'commit' && Number.isFinite(body.value)) {
      const existing = await kv.get(KEY);
      const current = existing ? parseInt(existing, 10) : 0;
      if (body.value > current) {
        await kv.set(KEY, String(body.value));
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  res.status(405).send('Method not allowed');
};
