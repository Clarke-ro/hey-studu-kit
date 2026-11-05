'use strict';
// Lesson submissions. Cloud: rows in Postgres `submissions` (cached in store.S.submissions); attachment
// bytes stay in `uploads` (referenced by id). The server forwards each one to the submission webhook (or the
// chat webhook) as {type:'submission', ...}; reviews come back via POST /api/submissions/:id/feedback (token)
// and are shown under the submission on the lesson page. Bots list them with box/api-get.sh /api/submissions...
const crypto = require('crypto');
const { hookConfig, postHook, sameOrigin } = require('./hook');
const uploads = require('./uploads');
const store = require('./store');
const kit = require('./kit');
const study = require('./study');

const LESSON_RE = /^[a-z0-9-]+$/, SUB_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;

function lessonTitle(id) {
  const raw = store.content(`lessons/${id}.md`); if (raw == null) return null;
  const m = raw.replace(/\r\n?/g, '\n').match(/^---\n[\s\S]*?^title\s*:\s*(.+)$/m); if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  return null;
}
const write = async (sub) => { await store.saveSubmission(sub); store.S.submissions.set(sub.id, sub); };
const find = (id) => (SUB_RE.test(id) && store.S.submissions.get(id)) || null;
const list = (lesson) => [...store.S.submissions.values()].filter(s => s.lesson_id === lesson).sort((a, b) => b.created_at.localeCompare(a.created_at));
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // UTC
const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/\s+$/, '').replace(/^\n+/, '').slice(0, max) : '');

const hookBody = (s) => ({ type: 'submission', lesson_id: s.lesson_id, lesson_title: s.lesson_title, submission_id: s.id, text: s.text, attachments: uploads.forHook(s.attachments) });
async function deliver(s) {
  s.attempts = (s.attempts || 0) + 1; s.last_attempt_at = new Date().toISOString();
  const reason = await postHook(hookBody(s), 'submission');
  const cur = find(s.id) || s; Object.assign(cur, { attempts: s.attempts, last_attempt_at: s.last_attempt_at });
  if (reason) {
    cur.status = 'undelivered'; cur.error = reason;
    console.log('submission-outbox ' + JSON.stringify({ at: new Date().toISOString(), submission_id: s.id, lesson_id: s.lesson_id, reason, chars: s.text.length, attachments: (s.attachments || []).map(a => a.url) }));
  } else if (cur.status !== 'reviewed') { cur.status = 'sent'; cur.delivered_at = new Date().toISOString(); delete cur.error; }
  await write(cur); return cur;
}

module.exports = function mount(app, { authOk, pushPayload, plainText, clip }) {
  app.get('/api/lessons/:id/submissions', (req, res) => {
    if (!LESSON_RE.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'no-store').json({ lesson_id: req.params.id, submissions: list(req.params.id), webhook_configured: !!hookConfig() });
  });

  app.post('/api/lessons/:id/submissions', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin' });
    const lesson = req.params.id, title = LESSON_RE.test(lesson) && lessonTitle(lesson);
    if (!title) return res.status(404).json({ error: 'lesson not found' });
    const text = str(req.body && req.body.text, 100000);
    const att = uploads.resolve(req.body && req.body.attachments);
    if (att.error) return res.status(400).json({ error: att.error });
    if (!text.trim() && !att.list.length) return res.status(400).json({ error: 'text or attachments required' });
    const now = new Date(), id = `${stamp(now)}-${crypto.randomBytes(2).toString('hex')}`;
    // files stay in the uploads table; the submission references them by id/url
    const attachments = att.list.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size, kind: a.kind, url: a.url }));
    const sub = { id, lesson_id: lesson, lesson_title: title, text, attachments, created_at: now.toISOString(), status: 'sent', feedback: [] };
    await write(sub);
    const out = await deliver(sub);
    res.status(201).json({ ok: true, submission: out, submissions: list(lesson) });
  });

  app.post('/api/submissions/:id/retry', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin' });
    const s = find(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
    const out = s.status === 'undelivered' ? await deliver(s) : s;
    res.json({ ok: true, submission: out, submissions: list(s.lesson_id) });
  });

  // all submissions, newest first.
  // ?status=sent|undelivered|reviewed  ?lesson=<id>  ?limit=N (default 50, max 500)
  app.get('/api/submissions', (req, res) => {
    let l = [...store.S.submissions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (typeof req.query.status === 'string') l = l.filter(s => s.status === req.query.status);
    if (typeof req.query.lesson === 'string') l = l.filter(s => s.lesson_id === req.query.lesson);
    const n = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.set('Cache-Control', 'no-store').json({ total: l.length, submissions: l.slice(0, n) });
  });

  app.get('/api/submissions/:id', (req, res) => {
    const s = find(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'no-store').json(s);
  });

  // review from the feedback bot (token). Body {text, push?:false, by?, passed?:bool, score?:number}.
  // Review pushes always send (unless push:false). No quiet_path — show even if the lesson is open.
  app.post('/api/submissions/:id/feedback', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const s = find(req.params.id); if (!s) return res.status(404).json({ error: `submission ${String(req.params.id).slice(0, 40)} not found` });
    const text = str(req.body && req.body.text, 40000).trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const fb = { text, at: new Date().toISOString(), by: typeof req.body.by === 'string' ? req.body.by.slice(0, 40) : kit.feedbackName() };
    const verdict = study.reviewVerdict(req.body || {}, text);
    if (verdict !== null) fb.passed = verdict;
    if (req.body && req.body.score != null && Number.isFinite(Number(req.body.score))) fb.score = Number(req.body.score);
    s.feedback = (s.feedback || []).concat(fb); s.status = 'reviewed'; s.reviewed_at = fb.at; delete s.error;
    await write(s);
    let test = null;
    try { test = await study.applyReviewProgress(s.lesson_id, { passed: fb.passed, coachScore: fb.score }); } catch (e) { console.error(e); }
    let push;
    if (req.body.push === false) push = { skipped: 'disabled', sent: 0 };
    else {
      try {
        const first = plainText(text.split('\n').find(l => l.trim()) || text);
        // No quiet_path: review notifications always show, even with the lesson open.
        push = await pushPayload(JSON.stringify({ title: `${fb.by}: feedback on ${clip(s.lesson_title, 60)}`, body: clip(first, 140), url: `/lessons/${s.lesson_id}#sub-${s.id}`, tag: `sub-${s.id}` }));
      } catch (e) { console.error(e); push = { error: true }; }
    }
    res.status(201).json({ ok: true, submission: s, push, test });
  });

  app.delete('/api/submissions/:id', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const s = find(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
    for (const a of s.attachments || []) await uploads.removeUnused(a.id, s);
    await store.deleteSubmission(s.id); store.S.submissions.delete(s.id);
    res.json({ ok: true, removed: s.id });
  });
};
