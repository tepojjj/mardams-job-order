const { kv } = require('@vercel/kv');
const { requireJobOrdersAccess, requireJobOrdersRole } = require('./_auth');
const { logAccountChange } = require('./_account-log');

// All saved job orders live in one Redis hash: { [joNumber]: JSON string }.
// This is separate from api/counter.js (which only tracks the running number).
const KEY = 'job-orders';

// Job orders can carry a base64 reference photo, which can be sizeable.
// Duplicating that into a log entry on every single edit would bloat the
// account-change log fast, so the photo itself is left out of what gets
// logged — everything else (client, items, totals, dates, notes) is kept
// in full so an edit/deletion can still be traced and the prior values
// reviewed.
function sanitizeOrderForLog(order) {
  if (!order) return null;
  const { photo, ...rest } = order;
  return { ...rest, hadPhoto: !!photo };
}

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

    const { id, data, isEdit, previousId } = body;

    const auth = isEdit ? requireJobOrdersRole(req, res, ['admin', 'super_admin']) : requireJobOrdersAccess(req, res);
    if (!auth) return;

    if (!id || !data) {
      res.status(400).json({ error: 'Missing id or data' });
      return;
    }

    // Only a real edit (from the Browse tab's Edit screen, Admin/Super
    // Admin only) gets logged — not the routine resave that happens when
    // reprinting an already-saved order, since the form is locked while
    // viewing and that resave never actually changes anything. Grab the
    // "before" snapshot from previousId when the JO number itself was
    // changed as part of the edit, otherwise from the same id.
    let previousState = null;
    if (isEdit) {
      try {
        const existingRaw = await kv.hget(KEY, previousId || id);
        const existing = existingRaw ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw) : null;
        previousState = sanitizeOrderForLog(existing);
      } catch (e) {
        // Best effort — a failed lookup here should never block the save.
      }
    }

    await kv.hset(KEY, { [id]: JSON.stringify(data) });

    if (isEdit) {
      const renumbered = previousState && previousState.joNumber && previousState.joNumber !== id;
      await logAccountChange({
        type: 'joborder-edited',
        username: id,
        changedBy: auth.username,
        changedByRole: auth.role,
        details: renumbered ? `Renumbered from ${previousState.joNumber} to ${id}` : `Edited job order ${id}`,
        previousState,
        newState: sanitizeOrderForLog(data)
      });
    }

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

    // The "delete the stale duplicate under the old number" cleanup that
    // happens right after a JO-number-changing edit isn't a real deletion
    // from the user's point of view — that edit is already fully logged
    // by the POST handler above (previousState there already captures the
    // pre-renumber record). Logging this cleanup too would just be a
    // confusing, misleading second "deleted" entry for the same action.
    const auditSkip = req.query.auditSkip === '1';

    let previousState = null;
    if (!auditSkip) {
      try {
        const existingRaw = await kv.hget(KEY, id);
        const existing = existingRaw ? (typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw) : null;
        previousState = sanitizeOrderForLog(existing);
      } catch (e) {
        // Best effort — a failed lookup here should never block the delete.
      }
    }

    await kv.hdel(KEY, id);

    if (!auditSkip && previousState) {
      await logAccountChange({
        type: 'joborder-deleted',
        username: id,
        changedBy: auth.username,
        changedByRole: auth.role,
        details: `Deleted job order ${id}`,
        previousState
      });
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};
