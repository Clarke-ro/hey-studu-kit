'use strict';
// hey studu kit: study app (Render web service + Postgres).
// Secrets are env only (see .env.example): POST_TOKEN, VAPID_*, DATABASE_URL, CHAT_WEBHOOK_*.
// Branding + bot roster: kit.config.json (kit.js).
const express = require('express');
const webpush = require('web-push');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const need = (k) => { const v = (process.env[k] || '').trim(); if (!v) { console.error(`${k} is not set`); process.exit(1); } return v; };
const TOKEN = need('POST_TOKEN');
// VAPID subject: a mailto: or https: contact for push services. Defaults to the service's own URL on Render.
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
if (!/^(mailto:|https:\/\/)/.test(VAPID_SUBJECT)) { console.error('VAPID_SUBJECT must be mailto:... or https://... (or set PUBLIC_URL)'); process.exit(1); }
const VAPID = { publicKey: need('VAPID_PUBLIC_KEY'), privateKey: need('VAPID_PRIVATE_KEY'), subject: VAPID_SUBJECT };
webpush.setVapidDetails(VAPID.subject, VAPID.publicKey, VAPID.privateKey);
delete process.env.VAPID_PRIVATE_KEY; delete process.env.POST_TOKEN; // keep them out of anything that dumps env
const PUSH_DRY_RUN = process.env.PUSH_DRY_RUN === '1';

const db = require('./db');
const store = require('./store');
const S = store.S;

function authOk(req) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1].trim()), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const kit = require('./kit');
const { displayName } = kit;
const plainText = (s) => (s || '').replace(/```[a-z]*\n?/gi, '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function pushPayload(payload) {
  if (PUSH_DRY_RUN) return { sent: 0, failed: 0, removed: 0, dry_run: S.subscriptions.length };
  const dead = []; let sent = 0, failed = 0;
  await Promise.all(S.subscriptions.map(async (s) => {
    try { await webpush.sendNotification(s, payload, { TTL: 86400 }); sent++; }
    catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
      else console.error('push error', e.statusCode, (e.body || e.message || '').toString().slice(0, 200));
    }
  }));
  if (dead.length) { S.subscriptions = S.subscriptions.filter(s => !dead.includes(s.endpoint)); await store.deleteSubs(dead).catch(() => {}); }
  return { sent, failed, removed: dead.length };
}
const pushAll = (msg) => pushPayload(JSON.stringify({ title: `${displayName(msg.bot)}: ${msg.title}`, body: clip(plainText(msg.body), 120), id: msg.id, url: `/m/${msg.id}` }));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false); // client IP is derived explicitly in auth.js (CF-Connecting-IP on Render)

// health check for Render + the external pinger: no auth, no data. Hits the DB at most once per
// HEALTHZ_DB_INTERVAL_S (default 1 h) so the pinger doesn't keep Neon's compute awake (free plan = 100 CU-h/month).
const HZ_MS = Number(process.env.HEALTHZ_DB_INTERVAL_S || 3600) * 1000;
let hz = { at: 0, ok: null, ms: null, error: null };
app.get('/healthz', async (req, res) => {
  if (Date.now() - hz.at > HZ_MS) {
    hz.at = Date.now();
    try { hz = { at: hz.at, ok: true, ms: await db.ping(), error: null }; }
    catch (e) { hz = { at: hz.at, ok: false, ms: null, error: 'db unreachable' }; console.error('healthz db:', e.message); }
  }
  const st = db.stats();
  res.set('Cache-Control', 'no-store').status(hz.ok === false ? 503 : 200)
    .json({ ok: hz.ok !== false, db: { ok: hz.ok, ms: hz.ms, checked_at: new Date(hz.at).toISOString(), error: hz.error, write_errors: st.write_errors }, uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576) });
});

require('./auth').mount(app, { authOk });
require('./uploads').mount(app, { authOk });
require('./content')(app, { authOk });
app.use(express.json({ limit: '256kb' }));

app.post('/api/messages', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const body0 = req.body || {};
  const bot = str(body0.bot, 40).toLowerCase();
  const title = str(body0.title, 200);
  const body = str(body0.body, 20000);
  const link = str(body0.link, 2000) || null;
  if (!bot || !title) return res.status(400).json({ error: 'bot and title are required' });
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'link must be http(s)' });
  const msg = { id: S.counters.messages++, bot, title, body, link, created_at: new Date().toISOString(), read: false };
  S.messages.push(msg); await store.addMessage(msg);
  let push = null;
  try { push = await pushAll(msg); } catch (e) { console.error(e); }
  res.status(201).json({ ok: true, message: msg, push });
});
app.get('/api/messages', (req, res) => {
  let list = S.messages.slice().sort((a, b) => b.id - a.id);
  if (req.query.bot) list = list.filter(m => m.bot === req.query.bot);
  res.set('Cache-Control', 'no-store').json(list);
});
app.post('/api/messages/:id/read', async (req, res) => {
  const m = S.messages.find(m => m.id === Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'not found' });
  m.read = req.body && req.body.read === false ? false : true; await store.saveMessage(m);
  res.json({ ok: true, message: m });
});
app.post('/api/read-all', async (req, res) => {
  const changed = S.messages.filter(m => !m.read); changed.forEach(m => { m.read = true; });
  await store.saveMessages(changed);
  res.json({ ok: true, updated: changed.length });
});
app.delete('/api/messages/:id', async (req, res) => {
  const id = Number(req.params.id), i = S.messages.findIndex(m => m.id === id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  S.messages.splice(i, 1); await store.deleteMessage(id); res.json({ ok: true });
});

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: VAPID.publicKey }));
app.post('/api/subscribe', async (req, res) => {
  const s = req.body;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 2000 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string')
    return res.status(400).json({ error: 'invalid subscription' });
  const sub = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) }, created_at: new Date().toISOString() };
  S.subscriptions = S.subscriptions.filter(x => x.endpoint !== s.endpoint).concat(sub);
  await store.saveSub(sub); res.status(201).json({ ok: true });
});
app.post('/api/unsubscribe', async (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (typeof ep === 'string') { S.subscriptions = S.subscriptions.filter(x => x.endpoint !== ep); await store.deleteSubs([ep]); }
  res.json({ ok: true });
});
require('./study')(app);

// ---- kit branding: manifest (public, for install), window.KIT (signed-in), index.html with title/accent
const fs = require('fs');
const K = kit.KIT, E = kit.esc;
app.get('/manifest.json', (req, res) => res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
  name: K.title, short_name: K.short_name, description: `${K.title}: lessons, updates and chat for ${K.field}`,
  id: '/', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1115', theme_color: K.accent,
  icons: [192, 512].flatMap(n => [{ src: `/icons/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'any' }, { src: `/icons/maskable-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'maskable' }]),
}, null, 1)));
app.get('/kit.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(`window.KIT=${JSON.stringify(kit.publicKit()).replace(/</g, '\\u003c')};`));
app.get('/api/kit', (req, res) => res.set('Cache-Control', 'no-store').json(kit.publicKit()));
const INDEX = fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8')
  .replace(/\{\{TITLE\}\}/g, E(K.title)).replace(/\{\{SHORT\}\}/g, E(K.short_name)).replace(/\{\{ACCENT\}\}/g, K.accent);
const sendIndex = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(INDEX);
app.get('/index.html', sendIndex);
require('./chat')(app, { authOk, pushPayload, plainText, clip });
require('./submissions')(app, { authOk, pushPayload, plainText, clip });

app.use(express.static(path.join(DIR, 'public'), {
  index: false,
  setHeaders(res, p) {
    if (p.endsWith('sw.js') || p.endsWith('.html') || p.endsWith('manifest.json')) res.set('Cache-Control', 'no-cache');
    if (p.endsWith('manifest.json')) res.type('application/manifest+json');
  },
}));
const ROUTES = /^\/(roadmap|lessons|inbox|opps|chat)?\/?$|^\/(m\/\d+|lessons\/[a-z0-9-]+|opps\/[a-z0-9-]+)\/?$/;
app.get(ROUTES, sendIndex);

// async handler errors (e.g. DB down) -> JSON 500, never a stack trace
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('error', req.method, req.path, err && err.message);
  res.status(500).json({ error: 'server error' });
});

(async () => {
  await store.load();
  const server = app.listen(PORT, HOST, () => console.log(`${kit.KIT.title} on ${HOST}:${PORT}${PUSH_DRY_RUN ? ' [PUSH_DRY_RUN]' : ''}`));
  const stop = (sig) => { console.log(`${sig}: draining`); server.close(); db.flush().then(() => db.pool.end()).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
})().catch((e) => { console.error('startup failed:', e.message); process.exit(1); });
