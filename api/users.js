const { kv } = require('@vercel/kv');
const { hashPassword, requireRole } = require('./_auth');
const { logAccountChange, LOG_KEY } = require('./_account-log');

const USERS_KEY = 'app-users';

// Pull payType/rate/regularTimeIn/regularTimeOut off a request body and
// validate them. Only ever called for Super Admin requests — payroll
// configuration is Super-Admin-only. Returns { fields, error }.
//
// OT Rate, Allowance, and the SSS/PhilHealth/Pag-IBIG/Cash Advance
// deductions are handled separately by parseMoneyFields, below — they're
// set from this app's own Payroll tab (Super Admin only).
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

// Pull otRate/allowance/sssDeduction/philhealthDeduction/pagibigDeduction/
// cashAdvanceDeduction off a request body and validate them. These are the
// figures Payroll is actually run with, set from this app's Payroll tab —
// Super Admin only (this app has no Accounting role). Returns { fields, error }.
const MONEY_FIELDS = [
  ['otRate', 'Overtime rate'],
  ['allowance', 'Allowance'],
  ['sssDeduction', 'SSS deduction'],
  ['philhealthDeduction', 'PhilHealth deduction'],
  ['pagibigDeduction', 'Pag-IBIG deduction'],
  ['cashAdvanceDeduction', 'Cash advance deduction']
];

function parseMoneyFields(body) {
  const fields = {};
  for (const [key, label] of MONEY_FIELDS) {
    if (body[key] !== undefined) {
      const val = body[key] === null || body[key] === '' ? null : Number(body[key]);
      if (val !== null && (!Number.isFinite(val) || val < 0)) {
        return { error: `${label} must be a positive number` };
      }
      fields[key] = val;
    }
  }
  return { fields };
}

// Display name — the human-readable name shown for an account throughout
// the app (attendance, payroll, the account bar) instead of the raw
// username. Optional; falls back to the username wherever it's blank.
// Anyone who can create/edit accounts (Admin or Super Admin) can set it.
function parseDisplayNameField(body) {
  if (body.displayName === undefined) return { fields: {} };
  const raw = body.displayName === null ? '' : String(body.displayName).trim();
  if (raw.length > 60) {
    return { error: 'Display name must be 60 characters or fewer' };
  }
  return { fields: { displayName: raw || null } };
}

// Department (Apparel / Sign Ads) decides which side of Job Orders an
// account can see. It doesn't mean anything for Accounting accounts, so
// it's left optional there. Anyone who can create/edit accounts can set it.
function parseDepartmentField(body) {
  if (body.department === undefined) return { fields: {} };
  const dept = body.department === null || body.department === '' ? null : String(body.department);
  if (dept !== null && !['apparel', 'sign_ads'].includes(dept)) {
    return { error: 'Department must be "apparel" or "sign_ads"' };
  }
  return { fields: { department: dept } };
}

module.exports = async (req, res) => {
  // Account-change log is served through this endpoint so it does not need
  // its own Vercel Serverless Function. This keeps the project at or below
  // the Hobby-plan function limit while preserving the existing UI.
  if (req.method === 'GET' && req.query.resource === 'account-log') {
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
        displayName: u.displayName || null,
        role: u.role,
        department: u.department || null,
        createdBy: u.createdBy,
        createdAt: u.createdAt,
        ...(isSuperAdmin ? {
          payType: u.payType || null,
          rate: typeof u.rate === 'number' ? u.rate : null,
          regularTimeIn: u.regularTimeIn || null,
          regularTimeOut: u.regularTimeOut || null,
          otRate: typeof u.otRate === 'number' ? u.otRate : null,
          allowance: typeof u.allowance === 'number' ? u.allowance : null,
          sssDeduction: typeof u.sssDeduction === 'number' ? u.sssDeduction : null,
          philhealthDeduction: typeof u.philhealthDeduction === 'number' ? u.philhealthDeduction : null,
          pagibigDeduction: typeof u.pagibigDeduction === 'number' ? u.pagibigDeduction : null,
          cashAdvanceDeduction: typeof u.cashAdvanceDeduction === 'number' ? u.cashAdvanceDeduction : null
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
    if (!['staff', 'admin', 'accounting'].includes(role)) {
      res.status(400).json({ error: 'Role must be staff, admin, or accounting' });
      return;
    }
    // Admins may only create Staff accounts with limited access.
    // Only the Super Admin can create Admin or Accounting accounts.
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

    // Department (Apparel / Sign Ads) — either the Admin or Super Admin
    // creating the account can set it. Not applicable to Accounting.
    const { fields: deptFields, error: deptError } = parseDepartmentField(body);
    if (deptError) {
      res.status(400).json({ error: deptError });
      return;
    }
    Object.assign(record, deptFields);

    // Display name — optional at creation time, same as department.
    const { fields: nameFields, error: nameError } = parseDisplayNameField(body);
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    Object.assign(record, nameFields);

    await kv.hset(USERS_KEY, { [uname]: JSON.stringify(record) });
    res.status(200).json({ ok: true, user: { username: uname, displayName: record.displayName || null, role, department: record.department || null, createdBy: auth.username, createdAt: record.createdAt } });
    return;
  }

  // Update an existing account. Two things can be changed here:
  //  - Password reset: an Admin can reset a Staff account's password;
  //    the Super Admin can reset a Staff or Admin account's password.
  //    This exists so a forgotten password never needs the password
  //    itself to be recovered — a new one is simply assigned, and nothing
  //    else about the account (attendance, payroll history, saved job
  //    orders, etc.) is touched.
  //  - Payroll configuration (pay type, rate, regular shift times, OT
  //    rate, allowance, and SSS/PhilHealth/Pag-IBIG/Cash Advance
  //    deductions) — Super Admin only.
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

    // OT rate / allowance / deductions — Super Admin only, from this
    // app's Payroll tab.
    if (auth.role === 'super_admin') {
      const { fields, error } = parseMoneyFields(body);
      if (error) {
        res.status(400).json({ error });
        return;
      }
      if (Object.keys(fields).length) {
        Object.assign(target, fields);
        changed = true;
      }
    } else {
      const { fields } = parseMoneyFields(body);
      if (Object.keys(fields).length) {
        res.status(403).json({ error: 'Only the Super Admin can edit payroll deductions' });
        return;
      }
    }

    const { fields: deptFields, error: deptError } = parseDepartmentField(body);
    if (deptError) {
      res.status(400).json({ error: deptError });
      return;
    }
    if (Object.keys(deptFields).length) {
      Object.assign(target, deptFields);
      changed = true;
    }

    // Display name — Admin (for Staff) or Super Admin (for anyone) can set
    // it. Logged to the account-change log so there's a record of who
    // renamed an account and what it changed from/to.
    const { fields: nameFields, error: nameError } = parseDisplayNameField(body);
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    if (Object.keys(nameFields).length) {
      const from = target.displayName || null;
      const to = nameFields.displayName;
      if (from !== to) {
        Object.assign(target, nameFields);
        changed = true;
        await logAccountChange({
          type: 'display-name-change',
          username: target.username,
          from,
          to,
          changedBy: auth.username,
          changedByRole: auth.role
        });
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
        username: target.username, displayName: target.displayName || null, role: target.role, department: target.department || null,
        createdBy: target.createdBy, createdAt: target.createdAt,
        payType: target.payType || null, rate: typeof target.rate === 'number' ? target.rate : null,
        regularTimeIn: target.regularTimeIn || null, regularTimeOut: target.regularTimeOut || null,
        otRate: typeof target.otRate === 'number' ? target.otRate : null,
        allowance: typeof target.allowance === 'number' ? target.allowance : null,
        sssDeduction: typeof target.sssDeduction === 'number' ? target.sssDeduction : null,
        philhealthDeduction: typeof target.philhealthDeduction === 'number' ? target.philhealthDeduction : null,
        pagibigDeduction: typeof target.pagibigDeduction === 'number' ? target.pagibigDeduction : null,
        cashAdvanceDeduction: typeof target.cashAdvanceDeduction === 'number' ? target.cashAdvanceDeduction : null
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
