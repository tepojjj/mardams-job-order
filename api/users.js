const { kv } = require('@vercel/kv');
const { hashPassword, requireRole } = require('./_auth');

const USERS_KEY = 'app-users';

module.exports = async (req, res) => {
  // List all accounts — Admins and the Super Admin can see the staff list.
  if (req.method === 'GET') {
    const auth = requireRole(req, res, ['admin', 'super_admin']);
    if (!auth) return;

    const users = (await kv.hgetall(USERS_KEY)) || {};
    const list = Object.values(users)
      .map((v) => {
        try {
          return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .map((u) => ({ username: u.username, role: u.role, createdBy: u.createdBy, createdAt: u.createdAt }))
      .sort((a, b) => a.username.localeCompare(b.username));

    res.status(200).json({ users: list });
    return;
  }

  // Create a new account.
  if (req.method === 'POST') {
    const auth = requireRole(req, res, ['admin', 'super_admin']);
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

    const { username, password, role } = body;
    if (!username || !password || !role) {
      res.status(400).json({ error: 'Username, password, and role are required' });
      return;
    }
    if (!['staff', 'admin'].includes(role)) {
      res.status(400).json({ error: 'Role must be staff or admin' });
      return;
    }
    // Admins may only create Staff accounts with limited access.
    // Only the Super Admin can create additional Admin accounts.
    if (auth.role === 'admin' && role !== 'staff') {
      res.status(403).json({ error: 'Admin accounts can only create Staff accounts' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }
    const uname = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(uname)) {
      res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, . _ -)' });
      return;
    }

    const existing = await kv.hget(USERS_KEY, uname);
    if (existing) {
      res.status(409).json({ error: 'That username already exists' });
      return;
    }

    const record = {
      username: uname,
      passwordHash: hashPassword(password),
      role,
      createdBy: auth.username,
      createdAt: new Date().toISOString()
    };
    await kv.hset(USERS_KEY, { [uname]: JSON.stringify(record) });
    res.status(200).json({ ok: true, user: { username: uname, role, createdBy: auth.username, createdAt: record.createdAt } });
    return;
  }

  // Remove an account.
  if (req.method === 'DELETE') {
    const auth = requireRole(req, res, ['admin', 'super_admin']);
    if (!auth) return;

    const uname = String(req.query.username || '').trim().toLowerCase();
    if (!uname) {
      res.status(400).json({ error: 'Missing username' });
      return;
    }
    if (uname === auth.username) {
      res.status(400).json({ error: "You can't delete your own account" });
      return;
    }

    const raw = await kv.hget(USERS_KEY, uname);
    if (!raw) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const target = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // The Super Admin account can't be removed through this endpoint.
    if (target.role === 'super_admin') {
      res.status(403).json({ error: 'The Super Admin account cannot be deleted' });
      return;
    }
    // Admins may only remove Staff accounts, not other Admins.
    if (auth.role === 'admin' && target.role !== 'staff') {
      res.status(403).json({ error: 'Admin accounts can only remove Staff accounts' });
      return;
    }

    await kv.hdel(USERS_KEY, uname);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
};
