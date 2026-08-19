const { kv } = require('@vercel/kv');
const { requireAuth, hashPassword, verifyPassword } = require('./_auth');
const { logAccountChange } = require('./_account-log');

// All app accounts live in one Redis hash: { [username]: JSON string } —
// same store api/users.js and api/login.js use. This endpoint is
// self-service only: every action here reads/writes the CALLER's own
// account (auth.username from the verified token), never a username
// taken from the request body. Any logged-in account — Staff, Admin, or
// Super Admin — can change their own password and set their own display
// name / profile photo.
const USERS_KEY = 'app-users';

// Keep stored avatars reasonably small — this is a data URL, so ~700KB
// of base64 is roughly a 500KB image after client-side compression.
const MAX_PHOTO_LENGTH = 700000;

module.exports = async (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const uname = auth.username;

  if (req.method === 'GET') {
    const raw = await kv.hget(USERS_KEY, uname);
    if (!raw) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    res.status(200).json({
      username: record.username,
      role: record.role,
      displayName: record.displayName || '',
      photo: record.photo || null
    });
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

    const raw = await kv.hget(USERS_KEY, uname);
    if (!raw) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (body.action === 'change-password') {
      const { currentPassword, newPassword } = body;
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Current and new password are required' });
        return;
      }
      if (!verifyPassword(currentPassword, record.passwordHash)) {
        res.status(401).json({ error: 'Current password is incorrect' });
        return;
      }
      if (String(newPassword).length < 6) {
        res.status(400).json({ error: 'New password must be at least 6 characters' });
        return;
      }
      record.passwordHash = hashPassword(newPassword);
      await kv.hset(USERS_KEY, { [uname]: JSON.stringify(record) });
      await logAccountChange({
        type: 'password-change',
        username: uname,
        changedBy: uname,
        changedByRole: auth.role
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'update-profile') {
      const oldDisplayName = record.displayName || '';
      if (body.displayName !== undefined) {
        record.displayName = String(body.displayName || '').trim().slice(0, 60);
      }
      if (body.photo !== undefined) {
        if (body.photo && String(body.photo).length > MAX_PHOTO_LENGTH) {
          res.status(400).json({ error: 'Photo is too large — try a smaller image.' });
          return;
        }
        record.photo = body.photo || null;
      }
      await kv.hset(USERS_KEY, { [uname]: JSON.stringify(record) });
      if (body.displayName !== undefined && record.displayName !== oldDisplayName) {
        await logAccountChange({
          type: 'display-name-change',
          username: uname,
          changedBy: uname,
          changedByRole: auth.role,
          from: oldDisplayName,
          to: record.displayName
        });
      }
      res.status(200).json({ ok: true, displayName: record.displayName || '', photo: record.photo || null });
      return;
    }

    res.status(400).json({ error: 'Invalid action' });
    return;
  }

  res.status(405).send('Method not allowed');
};
