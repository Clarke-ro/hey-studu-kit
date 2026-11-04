'use strict';
// Single-user login for the study app.
// - Password: only a scrypt hash, in Postgres kv 'auth'. Set it with `node auth.js set` (reads STUDY_APP_PASSWORD
//   and DATABASE_URL; scripts/setup/set-password.sh). A running server picks a new hash up on the next login attempt.
// - Sessions: random id in an httpOnly/Secure/SameSite=Lax cookie (1 year, sliding); only sha256(id) is stored (sessions table).
// - Gate: every request needs a valid session OR the bearer token, except the login page, manifest, icons and /healthz.
//   Network position is NOT auth.
const net = require('net');
const crypto = require('crypto');
const store = require('./store');
const kit = require('./kit');
const K = kit.KIT;

const COOKIE = 'si_session';
const YEAR_MS = 365 * 24 * 3600 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 64;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt, o) => new Promise((res, rej) => crypto.scrypt(pw, salt, KEYLEN, o, (e, k) => e ? rej(e) : res(k)));

async function setPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('password must be at least 8 characters');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw.normalize('NFC'), salt, SCRYPT);
  const prev = store.S.auth;
  const a = { v: 1, alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: KEYLEN,
    salt: salt.toString('base64'), hash: hash.toString('base64'), gen: ((prev && prev.gen) || 0) + 1, set_at: new Date().toISOString() };
  await store.saveAuth(a); store.S.auth = a;
  await store.clearSessions(); store.S.sessions = {}; // a new password signs every device out
}
async function checkPassword(pw) {
  const a = store.S.auth;
  if (!a || !a.hash || typeof pw !== 'string' || pw.length > 1024) { await scrypt('x', 'dummy-salt', SCRYPT); return false; }
  const k = await scrypt(pw.normalize('NFC'), Buffer.from(a.salt, 'base64'), { N: a.N, r: a.r, p: a.p, maxmem: SCRYPT.maxmem });
  const h = Buffer.from(a.hash, 'base64');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
let lastRefresh = 0; // throttles store.refreshAuth() to one DB read per 5 s of login attempts
const configured = () => { const a = store.S.auth; return !!(a && a.hash); };

// ---------- sessions ----------
const sessions = () => store.S.sessions;
const bg = (p) => p.catch(() => {}); // logged in db.js
function cookies(req) {
  const out = {};
  (req.get('cookie') || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const cookieStr = (v, maxAgeS) => `${COOKIE}=${v}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;
function getSession(req) {
  const sid = cookies(req)[COOKIE];
  if (!sid || !/^[A-Za-z0-9_-]{40,64}$/.test(sid)) return null;
  const key = sha(sid), s = sessions()[key];
  if (!s) return null;
  if (Date.parse(s.exp) < Date.now()) { delete sessions()[key]; bg(store.deleteSessions([key])); return null; }
  return { sid, key, s };
}
async function newSession(req, res) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = new Date(), S = sessions(), key = sha(sid);
  S[key] = { created_at: now.toISOString(), last_seen: now.toISOString(), exp: new Date(+now + YEAR_MS).toISOString(), ua: (req.get('user-agent') || '').slice(0, 80) };
  await store.saveSession(key, S[key]);
  const keys = Object.keys(S);
  if (keys.length > 20) {
    const old = keys.sort((a, b) => Date.parse(S[a].last_seen) - Date.parse(S[b].last_seen)).slice(0, keys.length - 20);
    old.forEach(k => delete S[k]); await store.deleteSessions(old);
  }
  res.append('Set-Cookie', cookieStr(sid, YEAR_MS / 1000));
}
function touch(sess, res) { // sliding year: refresh at most once a day
  if (Date.now() - Date.parse(sess.s.last_seen) < 864e5) return;
  sess.s.last_seen = new Date().toISOString(); sess.s.exp = new Date(Date.now() + YEAR_MS).toISOString(); bg(store.saveSession(sess.key, sess.s));
  res.append('Set-Cookie', cookieStr(sess.sid, YEAR_MS / 1000));
}

// ---------- client ip + rate limit ----------
// Render: Cloudflare -> Render's load balancer -> app. Render KEEPS a client-sent X-Forwarded-For and appends
// to it, so the left-most XFF entry is attacker-controlled. Cloudflare sets CF-Connecting-IP to the real client
// and overwrites any client-sent value, so that's what we trust (TRUST_PROXY=cloudflare, default on Render).
// TRUST_PROXY=loopback: behind a local reverse proxy (last XFF entry from 127.0.0.1). none: socket address.
const PROXY = process.env.TRUST_PROXY || (process.env.RENDER ? 'cloudflare' : 'loopback');
function clientIp(req) {
  const ra = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (PROXY === 'cloudflare') {
    const cf = (req.get('cf-connecting-ip') || '').trim();
    if (net.isIP(cf)) return cf;
    // no CF header: Render's XFF is "<client-sent...>, <ip Cloudflare saw>, <cloudflare edge>, <render internal>"
    // (it appends; leftmost entries are client-controlled). Third from the right is the one Cloudflare saw.
    const xf = (req.get('x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean);
    return xf.length >= 3 && net.isIP(xf[xf.length - 3]) ? xf[xf.length - 3] : ra; // else hop address (global limit still applies)
  }
  const loop = ra === '127.0.0.1' || ra === '::1';
  const xff = (req.get('x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean);
  return loop && xff.length ? xff[xff.length - 1] : ra;
}
const WINDOW = 15 * 60 * 1000, PER_IP = 5, GLOBAL = 30;
const fails = new Map(); let globalFails = [];
// IPv6 clients are limited per /64 (one client can rotate addresses inside its prefix)
const rlKey = (ip) => ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
function limited(ip) {
  ip = rlKey(ip);
  const now = Date.now();
  globalFails = globalFails.filter(t => now - t < WINDOW);
  const l = (fails.get(ip) || []).filter(t => now - t < WINDOW); fails.set(ip, l);
  if (l.length >= PER_IP) return Math.ceil((WINDOW - (now - l[0])) / 1000);
  if (globalFails.length >= GLOBAL) return Math.ceil((WINDOW - (now - globalFails[0])) / 1000);
  return 0;
}
function fail(ip) {
  ip = rlKey(ip); const now = Date.now(); fails.set(ip, [...(fails.get(ip) || []), now]); globalFails.push(now); }
setInterval(() => { const now = Date.now(); for (const [k, l] of fails) if (!l.some(t => now - t < WINDOW)) fails.delete(k); }, 10 * 60 * 1000).unref();

// ---------- recent ingress (token-only diagnostics, no secrets) ----------
const ingress = [];
function note(req, outcome) {
  ingress.push({ at: new Date().toISOString(), method: req.method, path: req.path.slice(0, 60), ip: clientIp(req),
    cf: !!req.get('cf-ray'), outcome });
  if (ingress.length > 30) ingress.shift();
}

// ---------- login page ----------
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/|\\)[^\s]*$/.test(n) && !n.startsWith('/login') && n.length < 300) ? n : '/';
function page(next, msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f6f6f9" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e0f13" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${kit.esc(K.short_name)}">
<link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><link rel="icon" href="/icons/icon-192.png">
<title>Sign in · ${kit.esc(K.title)}</title>
<style>
:root{--bg:#f6f6f9;--surface:#fff;--fg:#0f1115;--fg2:#3b3f48;--muted:#858a95;--line:rgba(15,17,21,.11);--accent:${K.accent};--accent-2:color-mix(in srgb,${K.accent} 75%,#000);--accent-soft:color-mix(in srgb,${K.accent} 14%,transparent);--bad:#dc2626;--bad-soft:rgba(239,68,68,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f13;--surface:#17191f;--fg:#eceef2;--fg2:#c4c8d0;--muted:#7d838e;--line:rgba(255,255,255,.1);--accent:color-mix(in srgb,${K.accent} 70%,#fff);--accent-2:${K.accent};--accent-soft:color-mix(in srgb,${K.accent} 22%,transparent);--bad:#f26464;--bad-soft:rgba(242,100,100,.12)}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);min-height:100%}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;display:flex;min-height:100dvh;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top) + 24px) 22px calc(env(safe-area-inset-bottom) + 24px)}
main{width:100%;max-width:380px}
.logo{width:64px;height:64px;border-radius:16px;display:block;margin:0 0 20px;box-shadow:0 6px 20px color-mix(in srgb,${K.accent} 25%,transparent)}
h1{font-size:1.75rem;font-weight:700;letter-spacing:-.025em;margin:0 0 4px}
p.sub{color:var(--muted);margin:0 0 26px;font-size:.95rem}
label{display:block;font-size:.8rem;font-weight:600;color:var(--fg2);margin:0 0 6px}
input{width:100%;font:inherit;font-size:17px;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;outline:none;-webkit-appearance:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;font-size:17px;color:#fff;background:var(--accent);border:0;border-radius:14px;padding:14px;cursor:pointer}
button:active{background:var(--accent-2)}
.err{background:var(--bad-soft);color:var(--bad);border-radius:12px;padding:10px 14px;font-size:.9rem;margin:0 0 16px}
.foot{color:var(--muted);font-size:.8rem;margin-top:22px;text-align:center}
</style></head><body><main>
<img class="logo" src="/icons/icon-192.png" alt="">
<h1>${kit.esc(K.title)}</h1><p class="sub">Sign in to see your lessons, inbox and chat.</p>
${msg ? `<div class="err" role="alert">${esc(msg)}</div>` : ''}
<form method="post" action="/login" autocomplete="on">
<input type="hidden" name="next" value="${esc(next)}">
<input type="text" name="username" value="student" autocomplete="username" hidden aria-hidden="true" tabindex="-1">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus enterkeyhint="go">
<button type="submit">Sign in</button>
</form><p class="foot">You'll stay signed in on this device.</p>
</main></body></html>`;
}
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const PUBLIC = /^\/(manifest\.json|icons\/[a-z0-9-]+\.png|favicon\.ico)$/;
const ROBOTS = 'User-agent: *\nDisallow: /\n';

function mount(app, { authOk }) {
  // security headers everywhere
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }); next(); });

  app.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(ROBOTS));
  app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect(303, safeNext(req.query.next));
    note(req, 'login-page');
    res.set(PAGE_HEADERS).send(page(safeNext(req.query.next), configured() ? '' : 'Login isn’t set up yet.'));
  });
  app.post('/login', require('express').urlencoded({ extended: false, limit: '4kb' }), require('express').json({ limit: '4kb' }), async (req, res) => {
    const ip = clientIp(req), json = req.is('application/json');
    const next = safeNext(req.body && req.body.next);
    const reply = (code, msg) => json ? res.status(code).set('Cache-Control', 'no-store').json({ error: msg }) : res.status(code).set(PAGE_HEADERS).send(page(next, msg));
    const origin = req.get('origin');
    if (origin && origin !== 'null' && new URL(origin).host !== req.get('host')) { note(req, 'login-bad-origin'); return reply(403, 'Please sign in from the app.'); }
    const wait = limited(ip);
    if (wait) { note(req, 'login-rate-limited'); res.set('Retry-After', String(wait)); return reply(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`); }
    if (Date.now() - lastRefresh > 5000) { lastRefresh = Date.now(); await store.refreshAuth().catch(e => console.error(`auth refresh: ${e.message}`)); }
    const ok = await checkPassword(req.body && req.body.password);
    if (!ok) { fail(ip); note(req, 'login-fail'); console.log(`login failed ip=${ip}`); return reply(401, 'Wrong password.'); }
    fails.delete(rlKey(ip)); await newSession(req, res); note(req, 'login-ok'); console.log(`login ok ip=${ip}`);
    return json ? res.json({ ok: true, next }) : res.redirect(303, next);
  });
  app.post('/logout', async (req, res) => {
    const s = getSession(req);
    if (s) { delete sessions()[s.key]; await store.deleteSessions([s.key]); }
    res.append('Set-Cookie', cookieStr('', 0));
    res.set('Cache-Control', 'no-store'); res.set('Clear-Site-Data', '"cache"');
    return req.is('application/json') || (req.get('accept') || '').includes('json') ? res.json({ ok: true }) : res.redirect(303, '/login');
  });
  // token-only diagnostics: how requests arrive (client ip), session count. No secrets.
  app.get('/api/auth/status', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    res.set('Cache-Control', 'no-store').json({ configured: configured(), sessions: Object.keys(sessions()).length, trust_proxy: PROXY, recent: ingress.slice(-15) });
  });

  // the gate
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC.test(req.path)) return next();
    if (authOk(req)) return next();            // bots / scripts with the bearer token
    const s = getSession(req);
    if (s) { req.session = s; touch(s, res); return next(); }
    note(req, 'blocked');
    res.set('Cache-Control', 'no-store');
    const wantsHtml = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/') && (req.get('sec-fetch-mode') === 'navigate' || (req.get('accept') || '').includes('text/html'));
    if (wantsHtml) return res.redirect(302, '/login' + (req.originalUrl && req.originalUrl !== '/' ? '?next=' + encodeURIComponent(req.originalUrl) : ''));
    return res.status(401).json({ error: 'login required' });
  });
}

module.exports = { mount, setPassword, checkPassword, configured, clientIp };

if (require.main === module) {
  const cmd = process.argv[2];
  const done = () => require('./db').pool.end();
  if (cmd === 'set') {
    const pw = process.env.STUDY_APP_PASSWORD;
    if (!pw) { console.error('STUDY_APP_PASSWORD is not set'); process.exit(1); }
    store.load().then(() => setPassword(pw)).then(() => { console.log('password hash written to the database; all sessions cleared'); return done(); }).catch(e => { console.error(e.message); process.exit(1); });
  } else if (cmd === 'check-env') {
    store.load().then(() => checkPassword(process.env.STUDY_APP_PASSWORD || '')).then(ok => { console.log(ok ? 'env password matches hash' : 'env password does NOT match'); return done(); });
  } else { console.log('usage: node auth.js set | check-env   (reads STUDY_APP_PASSWORD; never prints it)'); }
}
