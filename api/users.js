const { kv } = require('@vercel/kv');
const { hashPassword, requireRole } = require('./_auth');
const { logAccountChange } = require('./_account-log');

const USERS_KEY = 'app-users';

// Pull payType/rate/regularTimeIn/regularTimeOut off a request body and
// validate them. Only ever called for Super Admin requests — payroll
// configuration is Super-Admin-only. Returns { fields, error }.
function parsePayrollFields(body) {
  const fields = {};
  if (body.payType !== undefined) {
    if (body.payType !== null && !['daily', 'fixed'].includes(body.payType)) {
      return { error: 'Pay type must be "daily" or "fixed"' };
    }
    fields.payType = body.payType;
  }
  if (body.rate !== undefined) {
    const rate = body.rate === null || body.rate === '' ? null : Number(body.rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
      return { error: 'Rate must be a positive number' };
    }
    fields.rate = rate;
  }
  if (body.regularTimeIn !== undefined) {
    if (body.regularTimeIn && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.regularTimeIn)) {
      return { error: 'Regular time in must be in HH:MM format' };
    }
    fields.regularTimeIn = body.regularTimeIn || null;
  }
  if (body.regularTimeOut !== undefined) {
    if (body.regularTimeOut && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.regularTimeOut)) {
      return { error: 'Regular time out must be in HH:MM format' };
    }
    fields.regularTimeOut = body.regularTimeOut || null;
  }
  return { fields };
}

module.exports = async (req, res) => {
  // List all accounts — Admins and the Super Admin can see the staff list.
  // Pay type/rate/regular shift times are payroll data, so those fields are
  // only included in the response when the requester is the Super Admin.
  if (req.method === 'GET') {
    const auth = requireRole(req, res, ['admin', 'super_admin']);
    if (!auth) return;

    const users = (await kv.hgetall(USERS_KEY)) || {};
    const isSuperAdmin = auth.role === 'super_admin';
    const list = Object.values(users)
      .map((v) => {
        try {
          return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .map((u) => ({
        username: u.username,
        role: u.role,
        createdBy: u.createdBy,
        createdAt: u.createdAt,
        ...(isSuperAdmin ? {
          payType: u.payType || null,
          rate: typeof u.rate === 'number' ? u.rate : null,
          regularTimeIn: u.regularTimeIn || null,
          regularTimeOut: u.regularTimeOut || null
        } : {})
      }))
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

    // Pay type / rate / regular shift times are payroll configuration —
    // only the Super Admin can set them, whether at creation or later.
    if (auth.role === 'super_admin') {
      const { fields, error } = parsePayrollFields(body);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      Object.assign(record, fields);
    }

    await kv.hset(USERS_KEY, { [uname]: JSON.stringify(record) });
    res.status(200).json({ ok: true, user: { username: uname, role, createdBy: auth.username, createdAt: record.createdAt } });
    return;
  }

  // Update an existing account. Two things can be changed here:
  //  - Password reset: an Admin can reset a Staff account's password;
  //    the Super Admin can reset a Staff or Admin account's password.
  //    This exists so a forgotten password never needs the password
  //    itself to be recovered — a new one is simply assigned, and nothing
  //    else about the account (attendance, payroll history, saved job
  //    orders, etc.) is touched.
  //  - Payroll configuration (pay type, rate, regular shift times) —
  //    Super Admin only, as before.
  if (req.method === 'PATCH') {
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

    const uname = String(body.username || '').trim().toLowerCase();
    if (!uname) {
      res.status(400).json({ error: 'Missing username' });
      return;
    }

    const raw = await kv.hget(USERS_KEY, uname);
    if (!raw) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const target = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let changed = false;

    if (body.newPassword !== undefined) {
      if (uname === auth.username) {
        res.status(400).json({ error: 'Use your account settings to change your own password' });
        return;
      }
      if (target.role === 'super_admin') {
        res.status(403).json({ error: 'The Super Admin password cannot be reset here' });
        return;
      }
      if (auth.role === 'admin' && target.role !== 'staff') {
        res.status(403).json({ error: 'Admin accounts can only reset Staff passwords' });
        return;
      }
      if (String(body.newPassword).length < 6) {
        res.status(400).json({ error: 'New password must be at least 6 characters' });
        return;
      }
      target.passwordHash = hashPassword(body.newPassword);
      changed = true;
      await logAccountChange({
        type: 'password-reset',
        username: target.username,
        changedBy: auth.username,
        changedByRole: auth.role
      });
    }

    if (auth.role === 'super_admin') {
      const { fields, error } = parsePayrollFields(body);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      if (Object.keys(fields).length) {
        Object.assign(target, fields);
        changed = true;
      }
    } else {
      const { fields } = parsePayrollFields(body);
      if (Object.keys(fields).length) {
        res.status(403).json({ error: 'Only the Super Admin can edit payroll settings' });
        return;
      }
    }

    if (!changed) {
      res.status(400).json({ error: 'No changes provided' });
      return;
    }

    await kv.hset(USERS_KEY, { [uname]: JSON.stringify(target) });
    res.status(200).json({
      ok: true,
      user: {
        username: target.username, role: target.role, createdBy: target.createdBy, createdAt: target.createdAt,
        payType: target.payType || null, rate: typeof target.rate === 'number' ? target.rate : null,
        regularTimeIn: target.regularTimeIn || null, regularTimeOut: target.regularTimeOut || null
      }
    });
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
