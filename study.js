'use strict';
// Study features: curriculum, lessons, progress, opportunities.
// Content files come from the `content` table (pushed from the bot's box by content-sync.sh; cached in
// memory by store.js); progress is the kv row 'progress'.
const store = require('./store');
const QUIZ_BONUS = 5; // xp per correct quiz answer

const { KIT } = require('./kit');
// calendar day (YYYY-MM-DD) in the student's timezone (kit.config.json `timezone`)
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: KIT.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d = new Date()) => DAY_FMT.format(new Date(d));
const prevDay = (k) => new Date(Date.parse(k + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10); // pure calendar math
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- curriculum ----------
function loadCurriculum() { // a fresh copy every call (callers decorate it)
  const raw = store.content('curriculum.json');
  try { const c = raw && JSON.parse(raw); if (c && Array.isArray(c.months)) return c; } catch {}
  return { months: [] };
}
function flatLessons(cur) {
  const out = [];
  for (const m of cur.months) for (const u of m.units) for (const l of u.lessons) out.push({ ...l, month: m.id, unit: u.id });
  return out;
}
const lessonPath = (id) => /^[a-z0-9-]+$/.test(id) ? `lessons/${id}.md` : null;
const lessonText = (id) => { const p = lessonPath(id); return p ? store.content(p) : null; };
const hasFile = (id) => lessonText(id) != null;

// ---------- progress ----------
function loadProgress() {
  const p = store.S.progress ? clone(store.S.progress) : { completed: {}, activity_days: [], answers: [], xp_bonus: 0 };
  p.completed ||= {}; p.activity_days ||= []; p.answers ||= [];
  return p;
}
function streakOf(days) {
  const set = new Set(days);
  const today = dayKey(), yest = prevDay(today);
  let d = set.has(today) ? today : set.has(yest) ? yest : null;
  let n = 0;
  while (d && set.has(d)) { n++; d = prevDay(d); }
  return n;
}
function bestStreak(days) {
  const s = [...new Set(days)].sort(); let best = 0, run = 0, prev = null;
  for (const k of s) { run = prev && (new Date(k) - new Date(prev) === 864e5) ? run + 1 : 1; best = Math.max(best, run); prev = k; }
  return best;
}
function summary(p = loadProgress(), cur = loadCurriculum()) {
  const lessons = flatLessons(cur);
  const xp = Object.values(p.completed).reduce((s, c) => s + (c.xp || 0), 0) + (p.xp_bonus || 0);
  const current = (lessons.find(l => !p.completed[l.id]) || {}).id || null;
  return {
    xp, streak: streakOf(p.activity_days), best_streak: bestStreak(p.activity_days),
    today: dayKey(), active_today: p.activity_days.includes(dayKey()),
    current, completed: p.completed, activity_days: [...new Set(p.activity_days)].sort(),
    lessons_done: Object.keys(p.completed).length, lessons_total: lessons.length,
  };
}
async function saveProgress(p, cur) {
  const s = summary(p, cur);
  const next = { ...p, xp: s.xp, streak: s.streak, current: s.current, updated_at: new Date().toISOString() };
  await store.saveProgress(next); store.S.progress = next;
  return s;
}

function curriculumWithStatus() {
  const cur = loadCurriculum(), p = loadProgress(), s = summary(p, cur);
  let n = 0;
  for (const m of cur.months) {
    let done = 0, total = 0;
    for (const u of m.units) {
      let ud = 0;
      for (const l of u.lessons) {
        l.n = ++n; total++;
        l.status = p.completed[l.id] ? 'done' : l.id === s.current ? 'current' : 'locked';
        l.available = hasFile(l.id);
        if (p.completed[l.id]) { l.completed_at = p.completed[l.id].date; l.score = p.completed[l.id].score; l.total = p.completed[l.id].total; done++; ud++; }
      }
      u.done = ud; u.total = u.lessons.length;
    }
    m.done = done; m.total = total;
  }
  return { ...cur, progress: s };
}

// ---------- lesson files ----------
// ---\nkey: value\n---  then markdown; ```quiz blocks are pulled out into questions.
function parseQuiz(src) {
  const q = { question: '', lang: '', code: '', options: {}, answer: '', explain: '' };
  const lines = src.replace(/\r/g, '').split('\n');
  let key = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^(question|q|lang|code|answer|explain|explanation|[ABCD])\s*:\s?(.*)$/i);
    if (m) {
      key = m[1].toLowerCase(); let v = m[2];
      if (key === 'q') key = 'question';
      if (key === 'explanation') key = 'explain';
      if (key === 'code' && v.trim() === '|') {
        const code = [];
        while (i + 1 < lines.length && (/^(  |\t)/.test(lines[i + 1]) || (!lines[i + 1].trim() && i + 2 < lines.length && /^(  |\t)/.test(lines[i + 2])))) code.push(lines[++i].replace(/^(  |\t)/, ''));
        q.code = code.join('\n'); key = null; continue;
      }
      if (/^[abcd]$/.test(key)) { q.options[key.toUpperCase()] = v.trim(); key = 'opt:' + key.toUpperCase(); }
      else q[key] = v.trim();
      continue;
    }
    if (key && l.trim() && /^\s+/.test(l)) { // continuation line
      if (key.startsWith('opt:')) q.options[key.slice(4)] += ' ' + l.trim(); else q[key] += ' ' + l.trim();
    }
  }
  q.answer = (q.answer || '').trim().toUpperCase().slice(0, 1);
  q.options = Object.entries(q.options).sort().map(([k, text]) => ({ key: k, text }));
  return q.question && q.options.length >= 2 && q.answer ? q : null;
}
function parseLesson(id) {
  const t = lessonText(id);
  if (t == null) return null;
  let raw = t.replace(/\r\n?/g, '\n');
  const meta = {};
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split('\n')) { const m = line.match(/^(\w+)\s*:\s*(.*)$/); if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
    raw = raw.slice(fm[0].length);
  }
  const quiz = [];
  // ```submit block: practice-work box. Body is a one-line prompt, or `prompt:` / `placeholder:` lines.
  let submit = null;
  raw = raw.replace(/^```submit[^\n]*\n([\s\S]*?)\n?```[ \t]*$/gm, (_, b) => {
    const kv = {}; let plain = [];
    for (const line of b.split('\n')) { const m = line.match(/^(prompt|placeholder)\s*:\s*(.*)$/i); if (m) kv[m[1].toLowerCase()] = m[2].trim(); else if (line.trim()) plain.push(line.trim()); }
    submit = { prompt: kv.prompt || plain.join(' ') || 'Paste your work here', placeholder: kv.placeholder || '' };
    return '';
  });
  const body = raw.replace(/^```quiz[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm, (_, b) => { const q = parseQuiz(b); if (q) quiz.push(q); return ''; })
    .replace(/\n{3,}/g, '\n\n').trim();
  return { id, title: meta.title || id, unit: meta.unit || null, minutes: Number(meta.minutes) || null, xp: Number(meta.xp) || 20, meta, body, quiz, submit };
}

// ---------- opportunities.md ----------
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const M = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const DATE_RE = new RegExp(`(\\d{1,2})(?:\\s*[–-]\\s*(\\d{1,2}))?\\s+${M}(?:\\s+(\\d{4}))?(?:\\s*[–-]\\s*(\\d{1,2})\\s+${M}(?:\\s+(\\d{4}))?)?`, 'i');
const STRONG_RE = /deadline|due|submi|redeem|apply before|closes/i;
const KEY_RE = /deadline|due|submit|redeem|apply|applications?|registration closes|closes|window/i;
function parseDates(text, refYear) {
  // returns {start, end, kind} as ISO strings (dates are read as UTC) or null
  const segs = text.split(/;/).map(s => s.trim()).filter(Boolean);
  const parsed = [];
  for (const seg of segs) {
    const m = seg.match(DATE_RE);
    if (!m) continue;
    const y2 = m[7] ? +m[7] : null, y1 = m[4] ? +m[4] : (y2 || refYear);
    let start = Date.UTC(y1, MON[m[3].slice(0, 3).toLowerCase()], +m[1]);
    let end = m[2] ? Date.UTC(y1, MON[m[3].slice(0, 3).toLowerCase()], +m[2])
      : m[5] ? Date.UTC(y2 || y1, MON[m[6].slice(0, 3).toLowerCase()], +m[5]) : null;
    // explicit UTC+0 conversion after the date, e.g. "= 15 Nov 2026 07:45 UTC+0" or "= 22:00 UTC+0"
    const t = seg.slice(m.index + m[0].length).match(new RegExp(`=\\s*(?:(\\d{1,2})\\s+${M}\\s+(\\d{4})\\s+)?(\\d{1,2}):(\\d{2})(?:[–-][\\d:]+)?\\s*UTC\\+0`, 'i'));
    let timed = false, startTimed = false;
    if (t) {
      const base = t[1] ? Date.UTC(+t[3], MON[t[2].slice(0, 3).toLowerCase()], +t[1]) : (end && KEY_RE.test(seg) ? end : start);
      const at = base + (+t[4]) * 36e5 + (+t[5]) * 6e4;
      if (end && KEY_RE.test(seg)) { end = at; timed = true; } else { start = at; if (end) end += 86399e3; timed = !end; startTimed = true; }
    } else if (end) end += 86399e3;
    parsed.push({ seg, start, end, timed, startTimed, key: KEY_RE.test(seg), strong: STRONG_RE.test(seg) });
  }
  if (!parsed.length) return null;
  const p = parsed.find(x => x.strong) || parsed.find(x => x.key) || parsed[0];
  if (p.key) { // a deadline: the relevant moment is the end of a window, end of day if no time
    const d = p.end || (p.timed ? p.start : p.start + 86399e3);
    return { kind: 'deadline', at: new Date(d).toISOString(), timed: p.timed };
  }
  return { kind: 'event', at: new Date(p.start).toISOString(), end: p.end ? new Date(p.end).toISOString() : null, timed: p.timed || p.startTimed };
}
function parseOpps() {
  const c = store.contentMeta('opportunities.md');
  if (!c) return { updated: null, items: [] };
  const text = c.body;
  const refYear = new Date().getUTCFullYear();
  const items = []; let section = 'main'; let header = null, rawHeader = null; const slugs = new Set();
  const slugify = (t) => { let b = (t || 'opportunity').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'opportunity';
    let s = b, n = 2; while (slugs.has(s)) s = `${b}-${n++}`; slugs.add(s); return s; };
  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line)) { section = /watch/i.test(line) ? 'watchlist' : line.replace(/^##\s+/, '').trim(); header = rawHeader = null; continue; }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) { rawHeader = cells; header = cells.map(c => c.toLowerCase()); continue; }
    const get = (k) => { const i = header.findIndex(h => h.includes(k)); return i >= 0 ? cells[i] || '' : ''; };
    const name = get('name'), dateText = get('deadline'), status = get('status');
    const links = (get('link').match(/https?:\/\/[^\s)|,]+/g) || []);
    items.push({
      slug: slugify(name), columns: rawHeader.map((h, i) => ({ label: h, value: cells[i] || '' })),
      name, link: links[0] || null, links, date_text: dateText, category: get('category'), status, notes: get('notes'),
      section, when: section === 'watchlist' ? null : parseDates(dateText, refYear),
      expired: /expired|closed|passed/i.test(status),
    });
  }
  return { updated: c.updated_at, items }; // when content-sync last pushed a changed file
}

// ---------- routes ----------
module.exports = function mount(app) {
  app.get('/api/curriculum', (req, res) => res.set('Cache-Control', 'no-store').json(curriculumWithStatus()));
  app.get('/api/progress', (req, res) => res.set('Cache-Control', 'no-store').json(summary()));
  app.get('/api/lessons/:id', (req, res) => {
    const cur = curriculumWithStatus();
    const l = flatLessons(cur).find(x => x.id === req.params.id);
    const parsed = parseLesson(req.params.id);
    if (!l && !parsed) return res.status(404).json({ error: 'not found' });
    const unit = cur.months.flatMap(m => m.units.map(u => ({ ...u, month: m }))).find(u => u.lessons.some(x => x.id === req.params.id));
    const flat = flatLessons(cur), idx = flat.findIndex(x => x.id === req.params.id);
    res.set('Cache-Control', 'no-store').json({
      id: req.params.id, title: (parsed && parsed.meta.title) || (l && l.title), minutes: (parsed && parsed.minutes) || (l && l.minutes),
      xp: (parsed && parsed.xp) || 20, status: l ? l.status : 'locked', n: l ? l.n : null, available: !!parsed,
      unit: unit ? { id: unit.id, title: unit.title, month: unit.month.id, month_title: unit.month.title, color: unit.month.color } : null,
      body: parsed ? parsed.body : null, quiz: parsed ? parsed.quiz : [], submit: parsed ? parsed.submit : null,
      completed: l && l.status === 'done' ? { date: l.completed_at, score: l.score, total: l.total } : null,
      next: idx >= 0 && flat[idx + 1] ? { id: flat[idx + 1].id, title: flat[idx + 1].title } : null,
    });
  });
  app.post('/api/lessons/:id/complete', async (req, res) => {
    const cur = loadCurriculum();
    const l = flatLessons(cur).find(x => x.id === req.params.id);
    if (!l) return res.status(404).json({ error: 'not found' });
    const parsed = parseLesson(l.id);
    const total = parsed ? parsed.quiz.length : 0;
    const score = Math.max(0, Math.min(total, parseInt(req.body && req.body.score, 10) || 0));
    const p = loadProgress();
    const prev = p.completed[l.id];
    const base = (parsed && parsed.xp) || 20;
    let gained;
    if (!prev) { gained = base + QUIZ_BONUS * score; p.completed[l.id] = { date: dayKey(), at: new Date().toISOString(), score, total, xp: gained }; }
    else {
      gained = Math.max(0, QUIZ_BONUS * (score - (prev.score || 0)));
      prev.score = Math.max(prev.score || 0, score); prev.total = total; prev.xp = (prev.xp || 0) + gained; prev.last_at = new Date().toISOString();
    }
    if (!p.activity_days.includes(dayKey())) p.activity_days.push(dayKey());
    const s = await saveProgress(p, cur);
    res.json({ ok: true, xp_gained: gained, first_time: !prev, progress: s });
  });
  app.post('/api/quiz-answer', async (req, res) => {
    const { lesson, q, correct } = req.body || {};
    if (typeof lesson !== 'string') return res.status(400).json({ error: 'lesson required' });
    const p = loadProgress();
    p.answers.push({ lesson, q: Number(q) || 0, correct: !!correct, at: new Date().toISOString() });
    if (p.answers.length > 2000) p.answers = p.answers.slice(-2000);
    if (!p.activity_days.includes(dayKey())) p.activity_days.push(dayKey());
    res.json({ ok: true, progress: await saveProgress(p) });
  });
  app.get('/api/opps', (req, res) => res.set('Cache-Control', 'no-store').json(parseOpps()));
};
module.exports.parseOpps = parseOpps;
module.exports.parseLesson = parseLesson;
module.exports.summary = summary;
module.exports.loadCurriculum = loadCurriculum;
module.exports.flatLessons = flatLessons;
