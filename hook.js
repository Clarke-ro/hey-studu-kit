'use strict';
// Shared: the chat bot's webhook (one try, 8 s), presence (which screen is open), same-origin check.
// The webhook comes from env CHAT_WEBHOOK_URL + CHAT_WEBHOOK_KEY (never logged). Lesson submissions go to
// SUBMISSION_WEBHOOK_URL + SUBMISSION_WEBHOOK_KEY if set (e.g. the Coach bot), else to the chat webhook.
const store = require('./store');
const HOOK = 'env:CHAT_WEBHOOK_URL';
const TIMEOUT_MS = 8000;

function hookConfig(kind = 'chat') {
  const E = process.env, get = (k) => (E[k] || '').trim();
  const ok = (url, key) => (/^https?:\/\//i.test(url) && key ? { url, key } : null);
  if (kind === 'submission') { const s = ok(get('SUBMISSION_WEBHOOK_URL'), get('SUBMISSION_WEBHOOK_KEY')); if (s) return s; }
  return ok(get('CHAT_WEBHOOK_URL'), get('CHAT_WEBHOOK_KEY'));
}
// returns null on success, else a reason string (never contains the key)
async function postHook(payload, kind = 'chat') {
  const cfg = hookConfig(kind);
  if (!cfg) return 'no webhook configured';
  try {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}`, 'X-Automation-Key': cfg.key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok ? null : `webhook HTTP ${r.status}`;
  } catch (e) { return e.name === 'TimeoutError' ? 'webhook timeout (8s)' : `webhook error: ${e.cause ? e.cause.code || e.cause.message : e.message}`; }
}

const sameOrigin = (req) => { // browser calls carry Origin; reject cross-site posts
  const o = req.get('origin'); if (!o) return true;
  try { return new URL(o).host === req.get('host'); } catch { return false; }
};

// ---- presence: the open screen heartbeats ~10s ('chat' or 'lesson:<id>'); pushes for it are skipped while fresh ----
const PRESENCE_TTL = 25000;
// state lives in store.S.presence (restored from the kv table at startup); written to the DB only when
// the open view changes, not on every 10 s heartbeat (keeps Neon idle-able)
const P = () => store.S.presence;
const viewActive = (view) => P().view === view && Date.now() - P().at < PRESENCE_TTL;
function setSeen(next) {
  const changed = next.view !== P().view;
  store.S.presence = next;
  if (changed) store.savePresence(next).catch(() => {});
}
function mountPresence(app) {
  app.post('/api/presence', require('express').text({ type: 'text/plain', limit: '2kb' }), (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin' });
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    b = b || {};
    const view = typeof b.view === 'string' && /^(chat|lesson:[a-z0-9-]+)$/.test(b.view) ? b.view : null;
    if (view && b.visible === true) setSeen({ view, at: Date.now() });
    else if (!view || P().view === view) setSeen({ view: null, at: 0 }); // hidden / left
    res.json({ ok: true, view: Date.now() - P().at < PRESENCE_TTL ? P().view : null });
  });
  app.get('/api/presence', (req, res) => {
    const seen = P(), fresh = Date.now() - seen.at < PRESENCE_TTL;
    res.json({ view: fresh ? seen.view : null, chat_active: viewActive('chat'), age_ms: seen.at ? Date.now() - seen.at : null });
  });
}

module.exports = { hookConfig, postHook, sameOrigin, viewActive, mountPresence, HOOK };
