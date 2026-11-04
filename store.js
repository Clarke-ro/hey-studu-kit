'use strict';
// All app state, loaded once from Postgres at startup and kept in memory (single Render instance);
// every change is written through to Postgres (awaited) before the API answers. Upload bytes are NOT
// kept in memory: they are read from the uploads table on demand.
const crypto = require('crypto');
const db = require('./db');

const S = {
  messages: [], subscriptions: [], counters: { messages: 1, chat: 1 },
  chat: { nextId: 1, messages: [] },
  progress: null, auth: null, sessions: {},
  submissions: new Map(),          // id -> record
  uploads: {},                     // id -> meta {id,file,name,type,kind,size,created_at}
  uploadBytesTotal: 0,
  content: new Map(),              // path -> {body, sha256, updated_at}
  presence: { view: null, at: 0 },
  loaded_at: null,
};

async function load() {
  await db.migrate();
  const [m, s, c, kv, se, sub, up, ct] = await Promise.all([
    db.q('SELECT data FROM messages ORDER BY id'),
    db.q('SELECT data FROM subscriptions'),
    db.q('SELECT data FROM chat_messages ORDER BY id'),
    db.q('SELECT k, v FROM kv'),
    db.q('SELECT key, data FROM sessions'),
    db.q('SELECT data FROM submissions'),
    db.q('SELECT id, meta, octet_length(bytes) AS n FROM uploads'),
    db.q('SELECT path, body, sha256, updated_at FROM content'),
  ]);
  S.messages = m.rows.map(r => r.data);
  S.subscriptions = s.rows.map(r => r.data);
  const KV = Object.fromEntries(kv.rows.map(r => [r.k, r.v]));
  const maxId = (l) => l.reduce((a, x) => Math.max(a, x.id), 0) + 1;
  S.counters = { messages: Math.max((KV.counters && KV.counters.messages) || 1, maxId(S.messages)), chat: Math.max((KV.counters && KV.counters.chat) || 1, 1) };
  // in place: chat.js holds a reference to S.chat
  S.chat.nextId = Math.max(S.counters.chat, maxId(c.rows.map(r => r.data))); S.chat.messages = c.rows.map(r => r.data);
  S.progress = KV.progress || null;
  S.auth = KV.auth || null;
  S.presence = KV.presence || { view: null, at: 0 };
  S.sessions = Object.fromEntries(se.rows.map(r => [r.key, r.data]));
  S.submissions = new Map(sub.rows.map(r => [r.data.id, r.data]));
  S.uploads = {}; S.uploadBytesTotal = 0;
  for (const r of up.rows) { S.uploads[r.id] = r.meta; S.uploadBytesTotal += Number(r.n); }
  S.content = new Map(ct.rows.map(r => [r.path, { body: r.body, sha256: r.sha256, updated_at: r.updated_at.toISOString() }]));
  S.loaded_at = new Date().toISOString();
  console.log(`store: loaded ${S.messages.length} messages, ${S.subscriptions.length} subs, ${S.chat.messages.length} chat, ${S.submissions.size} submissions, ${Object.keys(S.uploads).length} uploads, ${S.content.size} content files, ${Object.keys(S.sessions).length} sessions`);
}

const J = (v) => JSON.stringify(v);
const kvSet = (k, v) => db.w('INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()', [k, J(v)]);
const saveCounters = () => kvSet('counters', { messages: S.counters.messages, chat: S.chat.nextId });

// ---- inbox messages + push subscriptions ----
async function saveMessage(m) { await db.w('INSERT INTO messages (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [m.id, J(m)]); }
async function addMessage(m) { await saveMessage(m); await saveCounters(); }
async function saveMessages(list) { if (list.length) await db.w('UPDATE messages SET data = x.data FROM jsonb_to_recordset($1::jsonb) AS x(id integer, data jsonb) WHERE messages.id = x.id', [J(list.map(m => ({ id: m.id, data: m })))]); }
const deleteMessage = (id) => db.w('DELETE FROM messages WHERE id = $1', [id]);
const saveSub = (s) => db.w('INSERT INTO subscriptions (endpoint, data) VALUES ($1, $2) ON CONFLICT (endpoint) DO UPDATE SET data = EXCLUDED.data', [s.endpoint, J(s)]);
const deleteSubs = (endpoints) => db.w('DELETE FROM subscriptions WHERE endpoint = ANY($1::text[])', [endpoints]);

// ---- chat ----
const saveChat = (m) => db.w('INSERT INTO chat_messages (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [m.id, J(m)]);
async function addChat(m) { await saveChat(m); await saveCounters(); }
const deleteChat = (id) => db.w('DELETE FROM chat_messages WHERE id = $1', [id]);
async function wipeChat() { await db.w('DELETE FROM chat_messages'); await saveCounters(); }

// ---- progress, auth, sessions, presence ----
const saveProgress = (p) => kvSet('progress', p);
const saveAuth = (a) => kvSet('auth', a);
const savePresence = (p) => kvSet('presence', p);
const saveSession = (key, s) => db.w('INSERT INTO sessions (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data', [key, J(s)]);
const deleteSessions = (keys) => db.w('DELETE FROM sessions WHERE key = ANY($1::text[])', [keys]);
const clearSessions = () => db.w('DELETE FROM sessions');
// The password can be (re)set from outside (`node auth.js set` on the box) while the server runs: pick up a newer
// hash on the next login attempt. A new hash also drops the in-memory sessions (the CLI deleted them in the DB).
async function refreshAuth() {
  const r = await db.q("SELECT v FROM kv WHERE k = 'auth'");
  const a = r.rows[0] ? r.rows[0].v : null;
  if (a && a.hash && (!S.auth || a.set_at !== S.auth.set_at || a.hash !== S.auth.hash)) {
    S.auth = a;
    const se = await db.q('SELECT key, data FROM sessions');
    S.sessions = Object.fromEntries(se.rows.map(x => [x.key, x.data]));
    return true;
  }
  return false;
}

// ---- submissions ----
const saveSubmission = (s) => db.w('INSERT INTO submissions (id, lesson_id, created_at, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [s.id, s.lesson_id, s.created_at, J(s)]);
const deleteSubmission = (id) => db.w('DELETE FROM submissions WHERE id = $1', [id]);

// ---- uploads (bytes in bytea) ----
async function addUpload(meta, bytes) {
  await db.w('INSERT INTO uploads (id, meta, bytes, created_at) VALUES ($1, $2, $3, $4)', [meta.id, J(meta), bytes, meta.created_at]);
  S.uploads[meta.id] = meta; S.uploadBytesTotal += bytes.length;
}
async function uploadBytes(id) { const r = await db.q('SELECT bytes FROM uploads WHERE id = $1', [id]); return r.rows[0] ? r.rows[0].bytes : null; }
async function deleteUpload(id) {
  const u = S.uploads[id]; if (!u) return false;
  await db.w('DELETE FROM uploads WHERE id = $1', [id]);
  delete S.uploads[id]; S.uploadBytesTotal = Math.max(0, S.uploadBytesTotal - (u.size || 0)); return true;
}

// ---- content (study files pushed by box/content-sync.sh) ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// `mtime` (optional, ISO): the source file's mtime on the box, so "updated" reflects the edit, not the sync
async function putContent(path, body, mtime) {
  const h = sha256(body), cur = S.content.get(path);
  if (cur && cur.sha256 === h) return { path, sha256: h, changed: false, updated_at: cur.updated_at };
  const t = mtime && Date.parse(mtime) <= Date.now() + 60000 ? new Date(mtime).toISOString() : null;
  const r = await db.w('INSERT INTO content (path, body, sha256, updated_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now())) ON CONFLICT (path) DO UPDATE SET body = EXCLUDED.body, sha256 = EXCLUDED.sha256, updated_at = EXCLUDED.updated_at RETURNING updated_at', [path, body, h, t]);
  const updated_at = r.rows[0].updated_at.toISOString();
  S.content.set(path, { body, sha256: h, updated_at });
  return { path, sha256: h, changed: true, updated_at };
}
async function deleteContent(path) { if (!S.content.has(path)) return false; await db.w('DELETE FROM content WHERE path = $1', [path]); S.content.delete(path); return true; }
const content = (path) => { const c = S.content.get(path); return c ? c.body : null; };
const contentMeta = (path) => S.content.get(path) || null;

module.exports = {
  S, load, sha256,
  addMessage, saveMessage, saveMessages, deleteMessage, saveSub, deleteSubs,
  addChat, saveChat, deleteChat, wipeChat, saveCounters,
  saveProgress, saveAuth, refreshAuth, savePresence, saveSession, deleteSessions, clearSessions,
  saveSubmission, deleteSubmission,
  addUpload, uploadBytes, deleteUpload,
  putContent, deleteContent, content, contentMeta,
};
