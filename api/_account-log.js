const { kv } = require('@vercel/kv');

// A running record of sensitive account changes — password changes/resets
// and display-name changes — so Admins and the Super Admin can look up
// what happened to an account (and when, and who did it) if a staff
// member forgets what they changed it to. Deliberately does NOT store
// plaintext passwords: password hashes are one-way, so there's nothing to
// recover — this log exists to support resetting a forgotten password
// (see the PATCH handler in api/users.js), not to reveal the old one.
const LOG_KEY = 'account-change-log';

async function logAccountChange(entry) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, changedAt: new Date().toISOString(), ...entry };
  try {
    await kv.hset(LOG_KEY, { [id]: JSON.stringify(record) });
  } catch (e) {
    // Never let a logging failure block the actual account change.
    console.warn('Could not write account change log entry.', e);
  }
}

module.exports = { logAccountChange, LOG_KEY };
