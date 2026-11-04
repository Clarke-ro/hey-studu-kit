'use strict';
// Uploads: POST raw bytes to /api/uploads (one file per request, X-Filename header), served back from
// /uploads/<random>.<ext> with fixed safe content types. Cloud: bytes live in Postgres (uploads.bytes
// bytea), the index is in memory (store.S.uploads). Caps: 10 MB per file, UPLOADS_TOTAL_MB overall.
const crypto = require('crypto');
const express = require('express');
const { sameOrigin } = require('./hook');
const store = require('./store');

const MAX = 10 * 1024 * 1024;
const MAX_FILES = 5;
const TOTAL_MAX = Number(process.env.UPLOADS_TOTAL_MB || 300) * 1024 * 1024; // Neon free storage is 1 GB
const BASE = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

// ext -> [type stored/sent to the bot, content type served, kind]
const TYPES = {
  jpg: ['image/jpeg', 'image/jpeg', 'image'], jpeg: ['image/jpeg', 'image/jpeg', 'image'], png: ['image/png', 'image/png', 'image'],
  webp: ['image/webp', 'image/webp', 'image'], gif: ['image/gif', 'image/gif', 'image'],
  heic: ['image/heic', 'image/heic', 'image'], heif: ['image/heif', 'image/heif', 'image'],
  pdf: ['application/pdf', 'application/pdf', 'pdf'],
  txt: ['text/plain', 'text/plain; charset=utf-8', 'text'], log: ['text/plain', 'text/plain; charset=utf-8', 'text'],
  md: ['text/markdown', 'text/plain; charset=utf-8', 'text'], py: ['text/x-python', 'text/plain; charset=utf-8', 'text'],
  js: ['text/javascript', 'text/plain; charset=utf-8', 'text'], ts: ['text/typescript', 'text/plain; charset=utf-8', 'text'],
  json: ['application/json', 'text/plain; charset=utf-8', 'text'], csv: ['text/csv', 'text/plain; charset=utf-8', 'text'],
  ps1: ['text/plain', 'text/plain; charset=utf-8', 'text'], sh: ['text/x-shellscript', 'text/plain; charset=utf-8', 'text'],
};
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf', 'text/plain': 'txt' };

function sniff(buf, ext) { // content must match the claimed kind
  const kind = TYPES[ext][2], h = buf.subarray(0, 16);
  if (kind === 'image') {
    if (ext === 'jpg' || ext === 'jpeg') return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
    if (ext === 'png') return h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === 'gif') return h.toString('latin1', 0, 4) === 'GIF8';
    if (ext === 'webp') return h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WEBP';
    return h.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(h.toString('latin1', 8, 12));
  }
  if (kind === 'pdf') return h.toString('latin1', 0, 5) === '%PDF-';
  if (buf.includes(0)) return false; // text: valid UTF-8, no NULs
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

const index = new Proxy({}, { get: (_, id) => store.S.uploads[id] }); // read-only view of the in-memory index

const cleanName = (n) => String(n || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>"]/g, '').trim().slice(0, 120) || 'file';
const pub = (u) => u && { id: u.id, name: u.name, type: u.type, size: u.size, kind: u.kind, url: `/uploads/${u.file}` };
// resolve client-sent ids to attachment records (for messages / submissions)
function resolve(ids) {
  if (!Array.isArray(ids)) return { list: [] };
  if (ids.length > MAX_FILES) return { error: `max ${MAX_FILES} files per message` };
  const list = [];
  for (const id of ids) { const u = typeof id === 'string' && index[id]; if (!u) return { error: `unknown attachment ${String(id).slice(0, 40)}` }; list.push(pub(u)); }
  return { list };
}
const remove = (id) => store.deleteUpload(id); // async -> true/false
// remove only if no other chat message / submission still points at it (a submission references the
// same upload row as the chat message it was attached from). `skip` = the record being deleted.
const inUse = (id, skip) => store.S.chat.messages.some(m => m !== skip && (m.attachments || []).some(a => a.id === id))
  || [...store.S.submissions.values()].some(s => s !== skip && (s.attachments || []).some(a => a.id === id));
const removeUnused = async (id, skip) => (inUse(id, skip) ? false : remove(id));
// what the bot gets: {name, type, size, url, api_path}. Bytes live in Postgres: fetch them with the
// bearer token, e.g. `box/fetch-upload.sh <api_path>` (or api-get.sh <api_path> > file).
const forHook = (list) => (list || []).map(a => { const u = a.url || ''; return { name: a.name, type: a.type, size: a.size, url: BASE() + u, api_path: u }; });

function mount(app, { authOk }) {
  app.post('/api/uploads', express.raw({ type: () => true, limit: MAX }), async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'empty file' });
    let name = 'file'; try { name = cleanName(decodeURIComponent(req.get('x-filename') || '')); } catch { name = cleanName(req.get('x-filename')); }
    let ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]; ext = ext && ext.toLowerCase();
    if (!ext || !TYPES[ext]) { // e.g. a pasted image "image" with no extension: fall back to the declared type
      const e2 = MIME_EXT[(req.get('content-type') || '').split(';')[0].trim().toLowerCase()];
      if (!e2) return res.status(415).json({ error: 'file type not allowed' });
      ext = e2; name = name.replace(/\.[^.]*$/, '') + '.' + ext;
    }
    if (!sniff(buf, ext)) return res.status(415).json({ error: `file content doesn't look like .${ext}` });
    if (store.S.uploadBytesTotal + buf.length > TOTAL_MAX) return res.status(507).json({ error: 'upload storage is full — ask your chat bot to clear old files' });
    const id = crypto.randomBytes(16).toString('hex');
    const file = `${id}.${ext}`;
    const [type, , kind] = TYPES[ext];
    const meta = { id, file, name, type, kind, size: buf.length, created_at: new Date().toISOString() };
    await store.addUpload(meta, buf);
    res.status(201).json(pub(meta));
  });
  app.use('/api/uploads', (err, req, res, next) => { // body-parser errors (too big)
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'file too large (max 10 MB)' });
    next(err);
  });
  app.delete('/api/uploads/:id', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    res.status((await remove(req.params.id)) ? 200 : 404).json({ ok: true });
  });
  // serve: exact names only (no listing), fixed content types, same-origin, never executable
  app.get(/^\/uploads\/([a-f0-9]{32})\.([a-z0-9]{2,5})$/, async (req, res) => {
    const u = index[req.params[0]];
    if (!u || u.file !== `${req.params[0]}.${req.params[1]}`) return res.status(404).end();
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).end();
    const [, served, kind] = TYPES[req.params[1]];
    res.set({
      'Content-Type': served, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable', 'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `${kind === 'text' || kind === 'image' || kind === 'pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
    });
    const bytes = await store.uploadBytes(u.id);
    if (!bytes) return res.status(404).end();
    res.send(bytes);
  });
  app.all(/^\/uploads(\/.*)?$/, (req, res) => res.status(404).end());
}

module.exports = { mount, resolve, remove, removeUnused, forHook, pub, MAX_FILES, TYPES };
