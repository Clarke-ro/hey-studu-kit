'use strict';
// Compact snapshot of the student's state for the chat bot, sent inside every chat webhook so it rarely has to
// read roadmap/curriculum/lessons/opportunities/progress/messages/chat itself. Rebuilt from the in-memory
// store (mirrors Postgres) on every call. Target < ~3 KB of JSON.
const study = require('./study');
const store = require('./store');

const { KIT, displayName } = require('./kit');
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: KIT.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (iso) => (iso ? DAY_FMT.format(new Date(iso)) : null); // in the student's timezone

function lessons() {
  const cur = study.loadCurriculum(), s = study.summary(undefined, cur);
  const flat = [];
  for (const m of cur.months) for (const u of m.units) for (const l of u.lessons) flat.push({ id: l.id, title: l.title, month: m.title || m.id, unit: u.title || u.id, week: u.week || l.week || null });
  const i = flat.findIndex(l => l.id === s.current);
  const c = i >= 0 ? flat[i] : null;
  return {
    progress: { lessons_done: s.lessons_done, lessons_total: s.lessons_total, xp: s.xp, streak: s.streak, best_streak: s.best_streak, active_today: s.active_today },
    current_lesson: c && { id: c.id, n: i + 1, title: c.title, month: c.month, unit: c.unit, ...(c.week ? { week: c.week } : {}) },
    next_lessons: i >= 0 ? flat.slice(i + 1, i + 4).map(l => l.title) : [],
  };
}

function deadlines(now = Date.now()) {
  const out = [];
  for (const o of study.parseOpps().items) {
    if (o.expired || o.section === 'watchlist' || !o.when) continue;
    // deadlines by their date; events by their start (or end, if it's already running)
    const t = [o.when.at, o.when.end].filter(Boolean).map(Date.parse).find(x => x >= now);
    if (t == null) continue;
    const running = o.when.kind === 'event' && Date.parse(o.when.at) < now;
    out.push({ t, item: { name: cut(o.name, 70), slug: o.slug, kind: running ? 'event ends' : o.when.kind, date: day(new Date(t).toISOString()) } });
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 3).map(x => x.item);
}

function inbox() {
  return [...store.S.messages].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 3)
    .map(m => ({ from: displayName(m.bot), title: cut(m.title, 70), date: day(m.created_at) }));
}

function chatTurns(excludeId) {
  return store.S.chat.messages.filter(m => m.id !== excludeId).slice(-6).map(m => ({
    id: m.id, role: m.role === 'user' ? 'student' : 'bot', at: m.created_at, text: cut(m.text, 160),
    ...(m.attachments && m.attachments.length ? { files: m.attachments.map(a => a.name) } : {}),
  }));
}

function lastSubmission() {
  let best = null;
  for (const s of store.S.submissions.values()) if (!best || s.created_at > best.created_at) best = s;
  return best && { id: best.id, lesson_id: best.lesson_id, lesson_title: cut(best.lesson_title, 60), status: best.status, at: best.created_at,
    has_feedback: !!(best.feedback && best.feedback.length), files: (best.attachments || []).length };
}

function roadmapPosition() {
  const t = store.content('roadmap.md'); if (t == null) return null;
  const m = t.match(/^##\s*Current position\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return m ? cut(m[1], 400) : null;
}

const safe = (f, d) => { try { return f(); } catch (e) { console.error('context:', e.message); return d; } };
function build({ excludeMessageId } = {}) {
  const L = safe(lessons, { progress: null, current_lesson: null, next_lessons: [] });
  return {
    generated_at: new Date().toISOString(), tz: KIT.timezone,
    student: { name: KIT.student_name, field: KIT.field },
    ...L,
    deadlines: safe(deadlines, []),
    recent_updates: safe(inbox, []),
    recent_chat: safe(() => chatTurns(excludeMessageId), []),
    last_submission: safe(lastSubmission, null),
    roadmap_position: safe(roadmapPosition, null),
  };
}

module.exports = { build };
