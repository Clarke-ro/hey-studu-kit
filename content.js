'use strict';
// Study content (lessons, curriculum, roadmap, opportunities) pushed from the bot's box by box/content-sync.sh.
// Token only. The app reads it from the in-memory copy (store.S.content), mirrored in the `content` table.
//   GET    /api/content            -> [{path, sha256, size, updated_at}]
//   GET    /api/content/<path>     -> raw body
//   PUT    /api/content/<path>     -> raw body (text, <= 1 MB); optional X-Source-Mtime: <ISO>
//   DELETE /api/content/<path>
const express = require('express');
const store = require('./store');

const ALLOWED = /^(curriculum\.json|roadmap\.md|opportunities\.md|LESSONS\.md|lessons\/[a-z0-9-]+\.md)$/;
const MAX = 1024 * 1024;

module.exports = function mount(app, { authOk }) {
  const guard = (req, res, next) => (authOk(req) ? next() : res.status(401).json({ error: 'unauthorized' }));
  const pathOf = (req) => { const p = req.params.p; const s = Array.isArray(p) ? p.join('/') : String(p || ''); return ALLOWED.test(s) ? s : null; };

  app.get('/api/content', guard, (req, res) => {
    res.set('Cache-Control', 'no-store').json([...store.S.content.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([path, c]) => ({ path, sha256: c.sha256, size: Buffer.byteLength(c.body), updated_at: c.updated_at })));
  });
  app.get('/api/content/*p', guard, (req, res) => {
    const p = pathOf(req); if (!p) return res.status(400).json({ error: 'path not allowed' });
    const c = store.S.content.get(p); if (!c) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'no-store').set('ETag', `"${c.sha256}"`).type(p.endsWith('.json') ? 'application/json' : 'text/markdown').send(c.body);
  });
  app.put('/api/content/*p', guard, express.raw({ type: () => true, limit: MAX }), async (req, res) => {
    const p = pathOf(req); if (!p) return res.status(400).json({ error: 'path not allowed' });
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'body required' });
    const body = req.body.toString('utf8');
    if (Buffer.byteLength(body) !== req.body.length || body.includes('\uFFFD')) return res.status(400).json({ error: 'body must be UTF-8 text' });
    if (p.endsWith('.json')) { try { JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'invalid JSON: ' + e.message.slice(0, 120) }); } }
    const r = await store.putContent(p, body, req.get('x-source-mtime'));
    res.json({ ok: true, ...r, size: req.body.length });
  });
  app.delete('/api/content/*p', guard, async (req, res) => {
    const p = pathOf(req); if (!p) return res.status(400).json({ error: 'path not allowed' });
    res.json({ ok: true, removed: await store.deleteContent(p) });
  });
  // the JSON parser must not run on content bodies; mounted before express.json() in server.js
  app.use('/api/content', (err, req, res, next) => (err && err.type === 'entity.too.large' ? res.status(413).json({ error: 'max 1 MB' }) : next(err)));
};
