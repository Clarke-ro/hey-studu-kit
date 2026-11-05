#!/usr/bin/env node
// Keep a free Render study app awake: GET /healthz every 10 minutes, 24/7.
// URL from STUDY_PING_URL (set by start-pinger.sh from ~/.hey-studu/url). No secrets.
'use strict';

const BASE = (process.env.STUDY_PING_URL || '').replace(/\/$/, '');
if (!BASE) {
  console.error('study-pinger: STUDY_PING_URL is not set');
  process.exit(1);
}
const URL = BASE.endsWith('/healthz') ? BASE : `${BASE}/healthz`;
const INTERVAL_MS = Number(process.env.STUDY_PING_INTERVAL_MS || 10 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.STUDY_PING_TIMEOUT_MS || 90 * 1000);

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' GMT');
}

async function pingOnce() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(URL, { method: 'GET', signal: ac.signal, redirect: 'follow' });
    console.log(`${stamp()} study-pinger: ${res.status} ${Date.now() - started}ms ${URL}`);
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || String(err);
    console.log(`${stamp()} study-pinger: FAIL ${Date.now() - started}ms ${msg}`);
  } finally {
    clearTimeout(t);
  }
}

console.log(`${stamp()} study-pinger: starting; every ${INTERVAL_MS / 1000}s -> ${URL}`);
pingOnce();
setInterval(pingOnce, INTERVAL_MS);
