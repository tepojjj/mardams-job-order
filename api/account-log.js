const { kv } = require('@vercel/kv');
const { requireRole } = require('./_auth');
const { LOG_KEY } = require('./_account-log');

module.exports = async (req, res) => {
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
};
