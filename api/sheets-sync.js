const { requireAuth } = require('./_auth');

// Mirrors Monitoring Sheet changes into a Google Sheet, automatically,
// every time a row is created, edited, or deleted here.
//
// This app's own storage (Vercel KV, via api/monitor.js) stays the single
// source of truth — this function just forwards a copy of each change to
// a Google Apps Script Web App, which writes it into the target Google
// Sheet. If the integration isn't configured yet, or Google is briefly
// unreachable, this fails silently and never blocks the actual save.
//
// Setup: see README.md → "Google Sheets integration". Requires two env
// vars in the Vercel project:
//   GOOGLE_SHEETS_WEBHOOK_URL — the Apps Script /exec URL
//   GOOGLE_SHEETS_SECRET      — a random string only your Apps Script and
//                               this function know, so nobody else can
//                               write to your sheet even if they guess
//                               the webhook URL
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const auth = requireAuth(req, res);
  if (!auth) return;

  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    // Not configured yet — treat as a harmless no-op so the Monitoring
    // Sheet keeps working normally without the Google Sheets mirror.
    res.status(200).json({ ok: true, skipped: 'GOOGLE_SHEETS_WEBHOOK_URL is not set' });
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

  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, secret: process.env.GOOGLE_SHEETS_SECRET || '' })
    });
    const text = await upstream.text();
    res.status(200).json({ ok: true, forwarded: upstream.ok, response: text.slice(0, 500) });
  } catch (e) {
    // Never let a Google Sheets hiccup surface as a failed save — the row
    // is already safely stored in this app's own KV store either way.
    res.status(200).json({ ok: false, error: 'Could not reach the Google Sheets webhook' });
  }
};
