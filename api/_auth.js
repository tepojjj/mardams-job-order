const crypto = require('crypto');

// IMPORTANT: set a real AUTH_SECRET env var in the Vercel project settings.
// This fallback only exists so the app doesn't hard-crash if it's missing,
// but sessions signed with the fallback are not secure for production use.
const SECRET = process.env.AUTH_SECRET || 'insecure-default-please-set-AUTH_SECRET-env-var';
if (!process.env.AUTH_SECRET) {
  console.warn('AUTH_SECRET is not set — using an insecure fallback. Set AUTH_SECRET in your Vercel project env vars.');
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // sessions last 12 hours

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

// ---- Passwords: scrypt with a random salt, stored as "salt:hash" (hex) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  let check;
  try {
    check = crypto.scryptSync(password, salt, 64).toString('hex');
  } catch (e) {
    return false;
  }
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- Sessions: HMAC-signed token, no server-side session storage needed ----
function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const payloadStr = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('hex');
  return `${payloadStr}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadStr, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadStr));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload; // { username, role, exp }
}

function getAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verifyToken(token);
}

// Returns the auth payload, or writes a 401 and returns null.
function requireAuth(req, res) {
  const auth = getAuth(req);
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return auth;
}

// Returns the auth payload if its role is in `roles`, or writes 401/403 and returns null.
function requireRole(req, res, roles) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (!roles.includes(auth.role)) {
    res.status(403).json({ error: 'Not authorized for this action' });
    return null;
  }
  return auth;
}

module.exports = {
  TOKEN_TTL_MS,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  getAuth,
  requireAuth,
  requireRole
};
