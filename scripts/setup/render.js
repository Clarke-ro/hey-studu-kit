#!/usr/bin/env node
'use strict';
// Render API helper for the setup bot. Secrets come from env and files and are sent in-process; never printed.
//   node render.js create        create (or update) the web service, all env vars set, deploy
//   node render.js set-webhook   set CHAT_WEBHOOK_URL/KEY (+ optional SUBMISSION_WEBHOOK_*) and redeploy
//   node render.js status        print the service's id, url and latest deploy status
// env (all):     RENDER_API_KEY, optional RENDER_API_BASE (default https://api.render.com/v1; used by tests)
// env (create):  DATABASE_URL, REPO_URL (https://github.com/<you>/<repo>), optional RENDER_OWNER_ID (else the
//                only workspace is used), SERVICE_NAME (hey-studu), RENDER_REGION (oregon), BRANCH (main),
//                VAPID_SUBJECT, CHAT_WEBHOOK_URL/KEY, SUBMISSION_WEBHOOK_URL/KEY, KIT_* branding overrides.
// files:         $HEY_STUDU_HOME/post-token, vapid.json (gen-secrets.sh); writes url + render-service-id there.
const fs = require('fs'), path = require('path');
const HOME = process.env.HEY_STUDU_HOME || path.join(process.env.HOME || '/root', '.hey-studu');
const API = (process.env.RENDER_API_BASE || 'https://api.render.com/v1').replace(/\/+$/, '');
const KEY = process.env.RENDER_API_KEY;
const say = (m) => console.log(`hey-studu render: ${m}`);
const die = (m) => { console.error(`hey-studu render: error: ${m}`); process.exit(1); };
if (!KEY) die('env RENDER_API_KEY is not set');
const REGIONS = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'];
const KIT_KEYS = ['KIT_TITLE', 'KIT_SHORT_NAME', 'KIT_STUDENT_NAME', 'KIT_FIELD', 'KIT_ACCENT', 'KIT_TIMEZONE', 'KIT_CHAT_BOT', 'KIT_FEEDBACK_BOT', 'KIT_BOTS', 'KIT_CHAT_SUGGESTIONS'];
const OPTIONAL = ['VAPID_SUBJECT', 'CHAT_WEBHOOK_URL', 'CHAT_WEBHOOK_KEY', 'SUBMISSION_WEBHOOK_URL', 'SUBMISSION_WEBHOOK_KEY', ...KIT_KEYS];

async function api(method, p, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + p, { method, headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429 && attempt < 5) { await new Promise(s => setTimeout(s, 1000 * (+r.headers.get('retry-after') || 5))); continue; }
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
    if (!r.ok) die(`${method} ${p} -> HTTP ${r.status}${j && j.message ? `: ${j.message}` : ''}`);
    return j;
  }
}
const readFile = (f) => { try { return fs.readFileSync(path.join(HOME, f), 'utf8').trim(); } catch { return ''; } };
const write = (f, v) => fs.writeFileSync(path.join(HOME, f), v + '\n', { mode: 0o600 });

async function owner() {
  if (process.env.RENDER_OWNER_ID) return process.env.RENDER_OWNER_ID;
  const list = (await api('GET', '/owners?limit=20')) || [];
  const ids = list.map(x => (x.owner || x)).filter(o => o && o.id);
  if (ids.length === 1) return ids[0].id;
  die(`found ${ids.length} Render workspaces; set RENDER_OWNER_ID to one of: ${ids.map(o => `${o.id} (${o.name})`).join(', ')}`);
}
async function findService(ownerId, name) {
  const list = (await api('GET', `/services?name=${encodeURIComponent(name)}&ownerId=${encodeURIComponent(ownerId)}&limit=20`)) || [];
  const s = list.map(x => x.service || x).find(s => s && s.name === name);
  return s || null;
}
function envVars() {
  const token = readFile('post-token'); let vapid = {};
  try { vapid = JSON.parse(readFile('vapid.json') || '{}'); } catch {}
  if (!token || !vapid.publicKey || !vapid.privateKey) die(`missing ${HOME}/post-token or vapid.json: run scripts/setup/gen-secrets.sh`);
  if (!process.env.DATABASE_URL) die('env DATABASE_URL is not set');
  const v = {
    NODE_VERSION: '22', NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=256', TRUST_PROXY: 'cloudflare',
    HEALTHZ_DB_INTERVAL_S: '3600', UPLOADS_TOTAL_MB: '300',
    DATABASE_URL: process.env.DATABASE_URL, POST_TOKEN: token, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  };
  for (const k of OPTIONAL) if (process.env[k]) v[k] = process.env[k];
  return v;
}
const serviceUrl = (s) => (s && s.serviceDetails && s.serviceDetails.url) || '';

async function setVars(id, vars) { // per-key PUT: adds/updates without wiping vars set elsewhere
  for (const [key, value] of Object.entries(vars)) await api('PUT', `/services/${id}/env-vars/${encodeURIComponent(key)}`, { value });
}
async function deploy(id) { const d = await api('POST', `/services/${id}/deploys`, { clearCache: 'do_not_clear' }); return d && d.id; }

async function create() {
  const name = process.env.SERVICE_NAME || 'hey-studu';
  const region = process.env.RENDER_REGION || 'oregon';
  if (!REGIONS.includes(region)) die(`RENDER_REGION must be one of ${REGIONS.join(', ')}`);
  const repo = (process.env.REPO_URL || '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) die('env REPO_URL must be https://github.com/<owner>/<repo>');
  const vars = envVars();
  const ownerId = await owner();
  let s = await findService(ownerId, name);
  if (s) {
    say(`service ${name} exists (${s.id}); updating env vars and redeploying`);
    await setVars(s.id, vars);
    say(`deploy started: ${await deploy(s.id)}`);
  } else {
    const r = await api('POST', '/services', {
      type: 'web_service', name, ownerId, repo, branch: process.env.BRANCH || 'main', autoDeploy: 'yes',
      envVars: Object.entries(vars).map(([key, value]) => ({ key, value })),
      serviceDetails: { runtime: 'node', plan: 'free', region, healthCheckPath: '/healthz', numInstances: 1,
        envSpecificDetails: { buildCommand: 'npm ci --omit=dev', startCommand: 'node server.js' } },
    });
    s = r.service || r; say(`created service ${name} (${s.id}) in ${region}, free plan; first deploy ${r.deployId || 'started'}`);
  }
  const url = serviceUrl(s) || serviceUrl(await api('GET', `/services/${s.id}`));
  if (!url) die('service has no URL yet; run `node render.js status` in a minute');
  write('url', url); write('render-service-id', s.id);
  say(`url ${url} (saved to ${HOME}/url); dashboard ${s.dashboardUrl || 'https://dashboard.render.com'}`);
  say(`env vars set: ${Object.keys(vars).join(' ')}`);
}

async function setWebhook() {
  const id = process.env.RENDER_SERVICE_ID || readFile('render-service-id');
  if (!id) die(`no service id: set RENDER_SERVICE_ID or run create first`);
  const v = {};
  for (const k of ['CHAT_WEBHOOK_URL', 'CHAT_WEBHOOK_KEY', 'SUBMISSION_WEBHOOK_URL', 'SUBMISSION_WEBHOOK_KEY']) if (process.env[k]) v[k] = process.env[k];
  if (!v.CHAT_WEBHOOK_URL || !v.CHAT_WEBHOOK_KEY) die('env CHAT_WEBHOOK_URL and CHAT_WEBHOOK_KEY are required');
  if (!/^https?:\/\//.test(v.CHAT_WEBHOOK_URL)) die('CHAT_WEBHOOK_URL must be an http(s) URL');
  await setVars(id, v);
  say(`set ${Object.keys(v).join(' ')} on ${id}`);
  if (process.argv.includes('--no-deploy')) return say('not redeploying (--no-deploy): the change applies on the next deploy');
  say(`redeploy started: ${await deploy(id)} (wait-healthz.sh to wait for it)`);
}

async function status() {
  const id = process.env.RENDER_SERVICE_ID || readFile('render-service-id'); if (!id) die('no service id');
  const s = await api('GET', `/services/${id}`);
  const d = ((await api('GET', `/services/${id}/deploys?limit=1`)) || []).map(x => x.deploy || x)[0];
  say(`${s.name} ${id} ${serviceUrl(s)} suspended=${s.suspended} latest_deploy=${d ? `${d.id} ${d.status}` : 'none'}`);
}

const cmd = process.argv[2];
({ create, 'set-webhook': setWebhook, status }[cmd] || (() => die('usage: node render.js create | set-webhook [--no-deploy] | status')))()
  .catch(e => die(e.message));
