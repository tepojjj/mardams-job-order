const { kv } = require('@vercel/kv');
const { hashPassword, verifyPassword, signToken } = require('./_auth');

// All app accounts live in one Redis hash: { [username]: JSON string }.
const USERS_KEY = 'app-users';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

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

  const { username, password } = body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  const uname = String(username).trim().toLowerCase();

  const users = (await kv.hgetall(USERS_KEY)) || {};

  // First-run bootstrap: no accounts exist yet. The first successful login
  // using the SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD env vars (set these
  // in the Vercel project's Environment Variables) creates the one and only
  // Super Admin account. After that this branch never runs again.
  if (Object.keys(users).length === 0) {
    const bootUser = (process.env.SUPERADMIN_USERNAME || '').trim().toLowerCase();
    const bootPass = process.env.SUPERADMIN_PASSWORD || '';
    if (!bootUser || !bootPass) {
      res.status(500).json({ error: 'No accounts exist yet, and SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD are not configured on the server.' });
      return;
    }
    if (uname !== bootUser || password !== bootPass) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const record = {
      username: uname,
      passwordHash: hashPassword(password),
      role: 'super_admin',
      createdBy: 'system',
      createdAt: new Date().toISOString()
    };
    await kv.hset(USERS_KEY, { [uname]: JSON.stringify(record) });
    const token = signToken({ username: uname, role: 'super_admin' });
    res.status(200).json({ token, user: { username: uname, role: 'super_admin' } });
    return;
  }

  const raw = users[uname];
  if (!raw) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!verifyPassword(password, record.passwordHash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const token = signToken({ username: uname, role: record.role });
  res.status(200).json({ token, user: { username: uname, role: record.role } });
};
