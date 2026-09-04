const { kv } = require('@vercel/kv');
const { requireRole, requireJobOrdersAccess } = require('./_auth');
const { LOG_KEY } = require('./_account-log');

const KEY = 'last-job-order-number';

// Merged with the old standalone api/account-log.js so the project stays
// under Vercel Hobby's 12-serverless-function cap. Routed by ?log=1 so the
// job-order counter keeps its original URL and behavior untouched; only the
// account-log GET moved, from /api/account-log to /api/counter?log=1.
module.exports = async (req, res) => {
  if (req.query && req.query.log === '1') {
    // Only Admins and the Super Admin can view this — never Staff.
    if (req.method === 'GET') {
      const auth = requireRole(req, res, ['admin', 'super_admin']);
      if (!auth) return;

      const all = (await kv.hgetall(LOG_KEY)) || {};
      const entries = Object.values(all)
        .map((v) => {
          try {
            return typeof v === 'string' ? JSON.parse(v) : v;
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (b.changedAt || '').localeCompare(a.changedAt || ''));

      res.status(200).json({ entries });
      return;
    }

    res.status(405).send('Method not allowed');
    return;
  }

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

    // Save a manually-typed custom number. The counter is set to exactly
    // this value — whether it's higher or lower than what's currently
    // stored — so the next auto-suggested number always picks up right
    // after whatever was actually saved (e.g. adjust down to JO-0099 and
    // the next suggestion becomes JO-0100, not a stale higher number).
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