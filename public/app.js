'use strict';
// study app: Today · Roadmap · Lessons · Chat · Inbox (Updates | Opportunities). Vanilla JS, client-side routing.
// Branding + bot roster come from kit.config.json via /kit.js (window.KIT).
const KIT = window.KIT || { title: 'hey studu', student_name: 'there', field: '', timezone: 'UTC', chat_bot: 'chat', feedback_bot: 'coach', bots: [], chat_suggestions: [] };
const CHAT_BOT = KIT.chat_bot || 'chat';
const FEEDBACK_BOT = KIT.feedback_bot || 'coach';
const BOTS = (KIT.bots || []).map(b => b.id).filter(id => id !== CHAT_BOT);
const COLORS = Object.fromEntries((KIT.bots || []).filter(b => b.color).map(b => [b.id, b.color]));
// display names are app-only: data keeps the raw bot id that bots post with
const NAMES = Object.fromEntries((KIT.bots || []).filter(b => b.name).map(b => [b.id, b.name]));
const ABOUT = Object.fromEntries((KIT.bots || []).filter(b => b.about).map(b => [b.id, b.about]));
const dn = (bot) => NAMES[bot] || (bot ? bot.charAt(0).toUpperCase() + bot.slice(1) : 'Bot');
const PALETTE = ['#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16'];
const TZ = KIT.timezone || 'UTC';
const QUIZ_BONUS = 5;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const icon = (id, cls = '') => `<svg${cls ? ` class="${cls}"` : ''}><use href="#i-${id}"/></svg>`;
// ---------- session (round 9) ----------
// Any 401 from our own API (other than token-only bot endpoints) means the session is gone: go to the login page.
const toLogin = () => { if (toLogin.done) return; toLogin.done = true; location.replace('/login' + (location.pathname !== '/' ? '?next=' + encodeURIComponent(location.pathname) : '')); };
{
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const r = await nativeFetch(input, init);
    if (r.status === 401) {
      const u = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (u.origin === location.origin && !/^\/(login|logout)\b/.test(u.pathname)) toLogin();
    }
    return r;
  };
}
async function signOut() {
  try { // this device stops getting notifications once signed out
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    const sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
    if (sub) { await fetch('/api/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  } catch {}
  await fetch('/logout', { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {});
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  toLogin.done = true; location.replace('/login');
}
function settingsSheet() {
  sheet('Settings', `<p>You’re signed in on this device. Signing out also turns off notifications here.</p>`, [['Sign out', signOut], ['Close', null, true]]);
}

const S = { messages: [], msgLoaded: false, chat: null, chatSending: [], cur: null, prog: null, opps: null, lessons: {}, filter: localStorage.getItem('filter') || 'all', bell: { show: false, on: false }, justDone: null };
let quiz = null; // { id, i, picks: [] }

function color(bot) {
  if (COLORS[bot]) return COLORS[bot];
  let h = 0; for (const c of bot) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const avatar = (bot, sm) => `<span class="avatar${sm ? ' sm' : ''}" style="background:${color(bot)}" aria-hidden="true">${esc((dn(bot).trim()[0] || '?'))}</span>`;

// ---------- dates (in KIT.timezone) ----------
const fmt = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o });
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const ymd = (d) => ymdFmt.format(d); // YYYY-MM-DD in TZ
const timeFmt = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const weekdayFmt = fmt({ weekday: 'long' });
const longDateFmt = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const shortDateFmt = fmt({ day: 'numeric', month: 'short' });
const headDateFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fullFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const hourFmt = fmt({ hour: 'numeric', hour12: false });
const daysBetween = (a, b) => Math.round((Date.parse(ymd(b)) - Date.parse(ymd(a))) / 864e5);
function dayLabel(d) {
  const n = daysBetween(d, new Date());
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n > 1 && n < 7) return weekdayFmt.format(d);
  return longDateFmt.format(d);
}
const keyDate = (k) => longDateFmt.format(new Date(k + 'T12:00:00Z'));

// ---------- api ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
function toast(t) {
  const el = $('#toast'); el.innerHTML = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 2600);
}
async function loadMessages() {
  try {
    const m = await api('/api/messages');
    const changed = JSON.stringify(m) !== JSON.stringify(S.messages) || !S.msgLoaded;
    S.messages = m; S.msgLoaded = true; return changed;
  } catch { if (!S.msgLoaded) toast(navigator.onLine ? 'Could not load messages' : 'Offline'); return false; }
}
async function loadStudy() {
  try {
    const c = await api('/api/curriculum');
    const changed = JSON.stringify(c) !== JSON.stringify(S.cur);
    S.cur = c; S.prog = c.progress; return changed;
  } catch { return false; }
}
async function loadOpps() {
  try { const o = await api('/api/opps'); const ch = JSON.stringify(o) !== JSON.stringify(S.opps); S.opps = o; return ch; } catch { return false; }
}
async function loadAll() {
  const r = await Promise.all([loadMessages(), loadStudy(), loadOpps(), loadChat()]);
  if (r.some(Boolean)) render('data');
}

// ---------- curriculum helpers ----------
function allLessons() {
  if (!S.cur) return [];
  const out = [];
  for (const m of S.cur.months) for (const u of m.units) for (const l of u.lessons) out.push({ ...l, unitObj: u, monthObj: m });
  return out;
}
const currentLesson = () => allLessons().find(l => l.status === 'current') || null;
function predictStreak() {
  const p = S.prog; if (!p) return 1;
  if (p.active_today) return p.streak;
  return p.streak > 0 ? p.streak + 1 : 1;
}

// ---------- shared header bits ----------
function stats() {
  const p = S.prog;
  const xp = p ? p.xp : '–', st = p ? p.streak : '–';
  const on = p && p.streak > 0, today = p && p.active_today;
  return `<button class="stats" type="button" aria-label="XP and streak">
    <span class="stat xp">${icon('bolt')}<b>${xp}</b></span>
    <span class="stat streak${on ? ' on' : ''}${today ? ' today' : ''}">${icon('flame')}<b>${st}</b></span></button>`;
}
const bellBtn = () => S.bell.show ? `<button class="icon-btn bell-btn${S.bell.on ? ' on' : ''}" aria-label="${S.bell.on ? 'Notifications on' : 'Enable notifications'}">${icon('bell')}</button>` : '';
function topbar(title, { extra = '', actions = '', sub = '' } = {}) {
  return `<header class="topbar" id="topbar"><div class="bar"><h1>${title}${extra}</h1><div class="actions">${actions}${stats()}</div></div>${sub}</header>`;
}
function backbar(label = '', right = stats()) {
  return `<header class="topbar detail-bar" id="topbar"><button id="back" class="icon-btn" aria-label="Back">${icon('back')}</button><div class="bar-title">${label}</div><div class="actions">${right}</div></header>`;
}
const unreadCount = () => S.messages.filter(m => !m.read).length;
function updateBadges() {
  const n = unreadCount(), b = $('#tab-badge');
  b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
  if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
function card(m) {
  const d = new Date(m.created_at);
  return `<a class="card ${m.read ? '' : 'unread'}" href="/m/${m.id}">
    ${avatar(m.bot)}
    <div class="c-main">
      <div class="c-top"><span class="c-bot">${esc(dn(m.bot))}</span><span class="c-time">${dayLabel(d) === 'Today' ? '' : esc(dayLabel(d)) + ' · '}${timeFmt.format(d)}</span>${m.read ? '' : '<span class="udot" aria-label="unread"></span>'}</div>
      <div class="c-title">${esc(m.title)}</div>
      <div class="c-prev">${esc(plain(m.body).slice(0, 160))}</div>
    </div></a>`;
}

// ---------- opportunities ----------
function rel(d) {
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d <= 45) return `in ${d} days`;
  return `in ${Math.round(d / 30)} months`;
}
function oppInfo(o) {
  const now = new Date(), w = o.when;
  if (o.section === 'watchlist') return { group: 'watch', label: 'Not open yet', tone: 'muted' };
  if (!w) return o.expired ? { group: 'past', label: 'Closed', tone: 'past', sort: 0 } : { group: 'rolling', label: 'Anytime', tone: 'muted' };
  const at = new Date(w.at), end = w.end ? new Date(w.end) : null;
  if (w.kind === 'deadline') {
    if (o.expired || at < now) return { group: 'past', label: 'Closed', tone: 'past', sort: -at };
    const d = daysBetween(now, at);
    return { group: 'soon', sort: +at, days: d, kind: 'deadline', tone: d <= 3 ? 'hot' : d <= 7 ? 'warm' : 'cool',
      label: `Due ${rel(d)}${w.timed && d <= 1 ? ' · ' + timeFmt.format(at) : ''}` };
  }
  if ((end && now > end) || (!end && daysBetween(now, at) < 0)) return { group: 'past', label: 'Ended', tone: 'past', sort: -at };
  if (at <= now) return { group: 'soon', sort: +(end || at), days: 0, kind: 'event', tone: 'live', label: end ? `On now · ends ${rel(daysBetween(now, end))}` : 'Today' };
  const d = daysBetween(now, at);
  return { group: 'soon', sort: +at, days: d, kind: 'event', tone: d <= 3 ? 'warm' : 'cool', label: `Starts ${rel(d)}${w.timed && d <= 1 ? ' · ' + timeFmt.format(at) : ''}` };
}
const CAT = [[/hack/i, '#f97316'], [/intern/i, '#3b82f6'], [/course/i, '#14b8a6'], [/fellow/i, '#ec4899'], [/scholar/i, '#ca8a04'], [/credit|tools/i, '#10b981'], [/ambassador|community/i, '#6366f1'], [/event|conf/i, '#8b5cf6'], [/program/i, '#0ea5e9']];
const catColor = (c) => (CAT.find(([re]) => re.test(c)) || [0, '#8a8f99'])[1];
function oppStatus(o) {
  const st = (o.status || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
  const tone = o.expired ? 'past' : /appl|regist|submit|joined|done/.test(st) ? 'ok' : /new/.test(st) ? 'new' : st ? 'other' : 'none';
  return { text: st ? st.charAt(0).toUpperCase() + st.slice(1) : '', tone };
}
const oppBy = (slug) => S.opps && S.opps.items.find(o => o.slug === slug);
function oppCard(o, info) {
  const st = oppStatus(o);
  return `<a class="card ocard${info.tone === 'past' ? ' past' : ''}" href="/opps/${esc(o.slug)}">
    <div class="c-main">
      <div class="c-top"><span class="o-cat" style="--c:${catColor(o.category)}">${esc(o.category || 'Other')}</span><span class="c-fill"></span>${st.tone !== 'none' ? `<span class="sdot ${st.tone}" title="${esc(st.text)}" aria-label="Status: ${esc(st.text)}"></span>` : ''}</div>
      <div class="o-title">${esc(o.name)}</div>
      <div class="o-when"><span class="pill ${info.tone}">${icon(info.kind === 'event' ? 'calendar' : info.group === 'watch' ? 'star' : 'clock')}${esc(info.label)}</span></div>
    </div></a>`;
}
function seg(active) {
  const n = unreadCount(), up = S.opps ? S.opps.items.filter(o => oppInfo(o).group === 'soon').length : 0;
  return `<nav class="seg" aria-label="Inbox sections"><a href="/inbox"${active === 'inbox' ? ' aria-current="page"' : ''}>Updates${n ? `<em>${n}</em>` : ''}</a><a href="/opps"${active === 'opps' ? ' aria-current="page"' : ''}>Opportunities${up ? `<em>${up}</em>` : ''}</a></nav>`;
}
function nextDeadline() {
  if (!S.opps) return null;
  return S.opps.items.map(o => ({ o, info: oppInfo(o) })).filter(x => x.info.group === 'soon' && x.info.kind === 'deadline').sort((a, b) => a.info.sort - b.info.sort)[0] || null;
}

// ---------- views ----------
const V = {};

V.today = () => {
  const now = new Date(), h = +hourFmt.format(now);
  const greet = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const p = S.prog, cl = currentLesson();
  let html = `<header class="topbar hello" id="topbar"><div class="bar"><div><div class="eyebrow">${esc(headDateFmt.format(now))}</div><h1>${greet}, ${esc(KIT.student_name || 'there')}</h1></div><div class="actions">${stats()}<button id="settings" class="icon-btn" aria-label="Settings">${icon('gear')}</button></div></div></header><main class="page">`;
  if (!S.cur) html += '<div class="skel big"></div><div class="skel"></div>';
  else if (cl) {
    const m = cl.monthObj;
    html += `<a class="continue" href="/lessons/${cl.id}" style="--mc:${m.color || 'var(--accent)'}">
      <div class="ct-eyebrow">${esc(m.title)} · ${esc(cl.unitObj.title)}</div>
      <div class="ct-label">${p && p.lessons_done ? 'Continue' : 'Start here'}</div>
      <div class="ct-title">${esc(cl.title)}</div>
      <div class="ct-meta"><span>${icon('book')}Lesson ${cl.n}</span><span>${icon('clock')}${cl.minutes} min</span><span>${icon('bolt')}+20 XP</span></div>
      <span class="ct-btn">${cl.available ? 'Start lesson' : 'Preview'}${icon('play')}</span>
    </a>`;
  } else html += `<div class="continue done-all"><div class="ct-title">Roadmap complete 🎉</div></div>`;

  if (p) {
    const best = p.best_streak > p.streak ? `best ${p.best_streak}` : (p.active_today ? 'done today' : 'study today to start');
    html += `<div class="tiles">
      <div class="tile"><span class="ti-ico flame${p.streak ? ' on' : ''}">${icon('flame')}</span><b>${p.streak}</b><span>day streak</span><small>${esc(p.streak && !p.active_today ? 'keep it today' : best)}</small></div>
      <div class="tile"><span class="ti-ico xp">${icon('bolt')}</span><b>${p.xp}</b><span>total XP</span><small>${p.lessons_done} lesson${p.lessons_done === 1 ? '' : 's'} done</small></div>
      <a class="tile" href="/roadmap"><span class="ti-ico path">${icon('route')}</span><b>${p.lessons_done}<i>/${p.lessons_total}</i></b><span>lessons</span><small>see roadmap</small></a>
    </div>`;
  }
  if (S.cur && cl) {
    const m = cl.monthObj, pct = Math.round(100 * m.done / m.total);
    html += `<section class="panel month-panel"><div class="p-head"><span class="p-title">${esc(m.icon || '')} ${esc(m.title)} progress</span><span class="p-num">${m.done}/${m.total} · ${pct}%</span></div>
      <div class="bar-track"><span style="width:${Math.max(pct, 2)}%;background:${m.color}"></span></div>
      <div class="units-mini">${m.units.map(u => `<span class="um ${u.done === u.total ? 'full' : u.lessons.some(l => l.status === 'current') ? 'cur' : ''}"><i>${esc(u.icon || '')}</i>${esc(u.title)} <em>${u.done}/${u.total}</em></span>`).join('')}</div></section>`;
  }
  const unread = S.messages.filter(m => !m.read).slice(0, 3);
  html += `<section class="sect"><div class="s-head"><h2>Unread updates</h2><a href="/inbox" class="s-more">Inbox${icon('chev')}</a></div>`;
  if (!S.msgLoaded) html += '<div class="skel"></div>';
  else if (!unread.length) html += `<div class="quiet">${icon('check')} You're all caught up</div>`;
  else html += `<div class="cards">${unread.map(card).join('')}</div>`;
  html += '</section>';
  const nd = nextDeadline();
  html += `<section class="sect"><div class="s-head"><h2>Next deadline</h2><a href="/opps" class="s-more">All opps${icon('chev')}</a></div>`;
  if (!S.opps) html += '<div class="skel"></div>';
  else if (!nd) html += `<div class="quiet">No upcoming deadlines</div>`;
  else {
    const soon = S.opps.items.map(oppInfo).filter(i => i.group === 'soon' && i.days <= 7).length;
    html += `<a class="deadline" href="/opps"><div class="dl-days ${nd.info.tone}"><b>${nd.info.days === 0 ? 'Today' : nd.info.days === 1 ? '1' : nd.info.days}</b>${nd.info.days > 0 ? `<span>${nd.info.days === 1 ? 'day' : 'days'}</span>` : ''}</div>
      <div class="dl-main"><div class="dl-name">${esc(nd.o.name)}</div><div class="dl-sub">${esc(nd.info.label)} · ${esc(nd.o.category)}</div></div>${icon('chev')}</a>
      ${soon > 1 ? `<div class="dl-more">${soon} things happening in the next 7 days</div>` : ''}`;
  }
  html += '</section></main>';
  return html;
};

// zig-zag path offsets (px from centre)
const WAVE = [0, 52, 84, 52, 0, -52, -84, -52];
V.roadmap = () => {
  let html = topbar('Roadmap') + '<main class="page roadmap">';
  if (!S.cur) return html + '<div class="skel big"></div></main>';
  let gi = 0;
  for (const m of S.cur.months) {
    const pct = Math.round(100 * m.done / m.total);
    html += `<section class="month" style="--mc:${m.color}">
      <div class="m-banner"><div class="m-txt"><div class="m-eyebrow">${esc(m.title)}</div><div class="m-name">${esc(m.name)}</div>
        <div class="m-prog"><div class="m-track"><span style="width:${Math.max(pct, 3)}%"></span></div><span>${m.done}/${m.total}</span></div></div>
        <div class="m-icon">${esc(m.icon || '')}</div></div>`;
    for (const u of m.units) {
      html += `<div class="unit-label"><span>${esc(u.icon || '')} ${esc(u.title)}</span><em>${u.done}/${u.total}</em></div><div class="path">`;
      const pts = [], ys = []; let top = 0;
      u.lessons.forEach((l, i) => {
        const off = WAVE[gi++ % WAVE.length], cur = l.status === 'current', h = cur ? 128 : 92; // current row is taller: room for the Start bubble
        pts.push(off); ys.push(top + h - 46); top += h;
        const side = off > 0 ? 'left' : 'right';
        const inner = l.status === 'done' ? icon('tick') : l.status === 'current' ? icon('play') : (l.available ? `<b>${l.n}</b>` : icon('lock'));
        const isTest = l.type === 'test';
        html += `<div class="node-row${cur ? ' cur' : ''}"><a class="node ${l.status}${isTest ? ' test' : ''}${S.justDone === l.id ? ' pop' : ''}" href="/lessons/${l.id}" style="--x:${off}px" aria-label="${isTest ? 'Module test' : 'Lesson'} ${l.n}: ${esc(l.title)}${l.status === 'locked' ? ' (locked)' : ''}">
          ${l.status === 'current' ? `<span class="start-bubble">${isTest ? 'Test' : 'Start'}</span>` : ''}
          <span class="n-face">${inner}</span>${l.status === 'done' ? `<span class="n-star">${icon('star')}</span>` : ''}
          <span class="n-cap ${side}"><span class="n-num">${l.n}</span>${esc(l.title)}${isTest ? '<span class="test-badge">Module test</span>' : ''}</span></a></div>`;
      });
      // dotted trail behind the nodes
      let d = `M ${pts[0]} ${ys[0]}`;
      for (let i = 1; i < pts.length; i++) { const m = (ys[i] - ys[i - 1]) / 2; d += ` C ${pts[i - 1]} ${ys[i - 1] + m}, ${pts[i]} ${ys[i] - m}, ${pts[i]} ${ys[i]}`; }
      html += `<svg class="trail" style="height:${top}px" viewBox="-195 0 390 ${top}" preserveAspectRatio="xMidYMin meet"><path d="${d}"/></svg></div>`;
    }
    html += '</section>';
  }
  return html + '<div class="finish">🏁 Job-ready</div></main>';
};

V.lessons = () => {
  let html = topbar('Lessons') + '<main class="page">';
  if (!S.cur) return html + '<div class="skel big"></div></main>';
  for (const m of S.cur.months) {
    html += `<div class="l-month" style="--mc:${m.color}"><div><span class="l-mt">${esc(m.title)}</span><span class="l-mn">${esc(m.name)}</span></div><span class="l-mp">${m.done}/${m.total}</span></div>`;
    for (const u of m.units) {
      html += `<section class="l-unit-card"><div class="lu-head"><span>${esc(u.icon || '')} ${esc(u.title)}</span><em>${u.done}/${u.total}</em></div>`;
      for (const l of u.lessons) {
        const ic = l.status === 'done' ? icon('tick') : l.status === 'current' ? icon('play') : l.available ? `<b>${l.n}</b>` : icon('lock');
        const isTest = l.type === 'test';
        const quizMeta = (l.quiz_total != null) ? ` · quiz ${l.quiz_score}/${l.quiz_total}` : (l.status === 'done' && l.total ? ` · ${l.score}/${l.total}` : '');
        html += `<a class="l-row ${l.status}${isTest ? ' test' : ''}" href="/lessons/${l.id}" style="--mc:${m.color}"><span class="lr-ico">${ic}</span>
          <span class="lr-main"><span class="lr-title">${esc(l.title)}${isTest ? '<span class="test-badge">Module test</span>' : ''}</span><span class="lr-meta">${isTest ? 'Module test' : 'Lesson'} ${l.n} · ${l.minutes} min${l.status === 'done' && l.completed_at ? ` · done ${esc(shortDateFmt.format(new Date(l.completed_at + 'T12:00:00Z')))}` : ''}${quizMeta}</span></span>
          ${l.available ? '' : '<span class="soon-tag">soon</span>'}${icon('chev', 'lr-chev')}</a>`;
      }
      html += '</section>';
    }
  }
  return html + '</main>';
};

V.inbox = () => {
  const bots = [...new Set([...BOTS, ...S.messages.map(m => m.bot)])];
  const unread = (b) => S.messages.filter(m => !m.read && (b === 'all' || m.bot === b)).length;
  if (S.filter !== 'all' && !bots.includes(S.filter)) S.filter = 'all';
  const chips = `<nav class="chips" aria-label="Filter by bot">${['all', ...bots].map(b => {
    const n = unread(b);
    return `<button class="chip${b === 'all' ? ' all' : ''}" data-bot="${esc(b)}" aria-pressed="${b === S.filter}">${b === 'all' ? 'All' : `<span class="sw" style="background:${color(b)}"></span>${esc(dn(b))}`}${n ? `<span class="n">${n}</span>` : ''}</button>`;
  }).join('')}</nav>`;
  const total = unread('all');
  let html = topbar('Inbox', { extra: total ? `<span class="count">${total}</span>` : '', actions: `${bellBtn()}<button id="read-all" class="icon-btn" aria-label="Mark all read">${icon('checks')}</button>`, sub: seg('inbox') + chips });
  html += '<div id="ptr" class="ptr"><span></span></div><main class="list page">';
  const list = S.messages.filter(m => S.filter === 'all' || m.bot === S.filter);
  let cur = null;
  for (const m of list) {
    const label = dayLabel(new Date(m.created_at));
    if (label !== cur) { if (cur !== null) html += '</div>'; html += `<div class="day">${label}</div><div class="cards">`; cur = label; }
    html += card(m).replace(/<span class="c-time">[^<]*<\/span>/, `<span class="c-time">${timeFmt.format(new Date(m.created_at))}</span>`);
  }
  if (cur !== null) html += '</div>';
  if (S.msgLoaded && !list.length) html += `<div class="empty">${icon('inbox')}<p>All quiet</p></div>`;
  return html + '</main>';
};

V.message = (r) => {
  const m = S.messages.find(x => x.id === r.id);
  let html = backbar('', m ? `<button id="delete" class="icon-btn danger" aria-label="Delete">${icon('trash')}</button>` : '');
  if (!m) return html + `<article class="detail">${S.msgLoaded ? '<p class="notfound">Message not found</p>' : ''}</article>`;
  if (!m.read) { m.read = true; api(`/api/messages/${m.id}/read`, { method: 'POST', body: '{}' }).catch(() => {}); }
  const d = new Date(m.created_at);
  return html + `<article class="detail">
    <div class="d-from">${avatar(m.bot, true)}<span>${esc(dn(m.bot))}</span></div>
    <h1 class="d-title">${esc(m.title)}</h1>
    <div class="d-date">${esc(fullFmt.format(d))}</div>
    <div class="d-body prose">${md(m.body)}</div>
    ${m.link ? `<a class="d-link" href="${esc(safeUrl(m.link))}" target="_blank" rel="noopener">Open link${icon('ext')}</a>` : ''}</article>`;
};

V.opps = () => {
  let html = topbar('Inbox', { sub: seg('opps') }) + '<main class="list page">';
  if (!S.opps) return html + '<div class="skel big"></div></main>';
  const items = S.opps.items.map(o => ({ o, info: oppInfo(o) }));
  const groups = [
    ['soon', 'Coming up', (a, b) => a.info.sort - b.info.sort],
    ['rolling', 'Anytime', null],
    ['watch', 'Watchlist', null],
    ['past', 'Closed', (a, b) => a.info.sort - b.info.sort],
  ];
  const wk = items.filter(x => x.info.group === 'soon' && x.info.days <= 7).length;
  html += `<div class="opp-sum"><span><b>${items.filter(x => x.info.group === 'soon').length}</b> upcoming</span><span><b>${wk}</b> this week</span><span class="src">updated ${esc(shortDateFmt.format(new Date(S.opps.updated)))}</span></div>`;
  for (const [g, title, sort] of groups) {
    const list = items.filter(x => x.info.group === g);
    if (!list.length) continue;
    if (sort) list.sort(sort);
    html += `<div class="day">${title}<em>${list.length}</em></div><div class="cards">${list.map(x => oppCard(x.o, x.info)).join('')}</div>`;
  }
  return html + '</main>';
};

// split on sentence ends followed by a capital/opening char, never inside "quotes" (e.g. "experience? no problem")
function sentences(t) {
  const out = []; let cur = '', q = false;
  const parts = t.split(/(?<=[.!?…]["”')]?)\s+/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    cur = cur ? cur + ' ' + p : p;
    q = ((cur.match(/["“”]/g) || []).length % 2) === 1;
    const next = parts[i + 1];
    if (!q && (next === undefined || /^[A-Z0-9(*“"]/.test(next))) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
const linkify = (v) => v.replace(/https?:\/\/[^\s)|,]+/g, (u) => { try { const x = new URL(u); return `[${(x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').slice(0, 48)}](${u})`; } catch { return u; } });
function oppBody(o) {
  let notes = (o.notes || '').trim(), stretch = false;
  notes = notes.replace(/^\*\*STRETCH\.?\*\*\s*/i, () => { stretch = true; return ''; });
  const ss = sentences(notes);
  const summary = ss.shift() || '';
  let out = '';
  if (stretch) out += '**Stretch goal.** ';
  out += summary ? summary + '\n\n' : (stretch ? '\n\n' : '');
  const cols = (o.columns || []).filter(c => !/^(name|notes)$/i.test(c.label) && c.value);
  if (cols.length) out += '## Details\n\n' + cols.map(c => `- **${c.label.replace(/\//g, ' / ')}:** ${/link/i.test(c.label) ? linkify(c.value) : c.value}`).join('\n') + '\n\n';
  if (ss.length) out += '## Notes\n\n' + (ss.length >= 3 ? ss.map(x => '- ' + x).join('\n') : ss.join(' ')) + '\n';
  return out;
}
const dayFullFmt = fmt({ weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
function oppDateLine(o, info) {
  const w = o.when;
  if (!w) return `${o.date_text || 'No fixed date'} · ${info.label}`;
  const at = new Date(w.at), end = w.end ? new Date(w.end) : null;
  let d = dayFullFmt.format(at) + (w.timed ? ', ' + timeFmt.format(at) : '');
  if (end && ymd(end) !== ymd(at)) d += ' – ' + dayFullFmt.format(end);
  return `${d} · ${info.label}`;
}
V.opp = (r) => {
  const o = oppBy(r.slug);
  let html = backbar('', '');
  if (!o) return html + `<article class="detail">${S.opps ? '<p class="notfound">Opportunity not found</p>' : ''}</article>`;
  const info = oppInfo(o), st = oppStatus(o);
  return html + `<article class="detail opp-detail">
    <div class="d-from"><span class="o-cat lg" style="--c:${catColor(o.category)}">${esc(o.category || 'Other')}</span>${st.text ? `<span class="d-status ${st.tone}"><i class="sdot ${st.tone}"></i>${esc(st.text)}</span>` : ''}</div>
    <h1 class="d-title">${esc(o.name)}</h1>
    <div class="d-date"><span class="pill ${info.tone}">${icon(info.kind === 'event' ? 'calendar' : info.group === 'watch' ? 'star' : 'clock')}${esc(info.label)}</span><span class="dd-full">${esc(oppDateLine(o, info).replace(/ · [^·]*$/, ''))}</span></div>
    <div class="d-body prose">${md(oppBody(o))}</div>
    ${o.link ? `<a class="d-link" href="${esc(safeUrl(o.link))}" target="_blank" rel="noopener">Open link${icon('ext')}</a>` : ''}</article>`;
};

// ---------- chat with the chat bot ----------
const SUGGEST = (KIT.chat_suggestions && KIT.chat_suggestions.length ? KIT.chat_suggestions : ['What should I study today?', 'Explain the last lesson again', 'What deadlines are coming up?']).slice(0, 4);
const CHAT_NAME = dn(CHAT_BOT);
const chatMsgs = () => (S.chat ? S.chat.messages : []).concat(S.chatSending);
const awaitingMsg = () => { const m = chatMsgs().filter(x => x.role === 'user'); const last = m[m.length - 1]; return last && (last.status === 'sent' || last.status === 'sending') ? last : null; };
// server chat state; pending.age_ms is server-measured -> convert to a local start time (immune to phone clock skew)
const chatKey = (c) => c ? JSON.stringify({ ...c, pending: c.pending && { ...c.pending, age_ms: 0 } }) : '';
function setChat(c) {
  const ch = chatKey(c) !== chatKey(S.chat);
  S.chat = { conversation_id: c.conversation_id, messages: c.messages, awaiting: c.awaiting, pending: c.pending || null, webhook_configured: c.webhook_configured };
  if (c.pending) { const st = Date.now() - c.pending.age_ms; if (!S.pendStart || S.pendStart.id !== c.pending.message_id || S.pendStart.since !== c.pending.since) S.pendStart = { id: c.pending.message_id, since: c.pending.since, at: st }; }
  else S.pendStart = null;
  return ch;
}
// typing bubble: null | {id, stale}. 'sending' (optimistic) and server-pending both show the dots;
// after pending.stale_after_ms (3 min) with no reply it becomes "Still thinking… Retry".
function typingState() {
  const w = awaitingMsg(); if (!w) return null;
  if (w.status === 'sending') return { id: w.id, stale: false };
  const p = S.chat && S.chat.pending, ps = S.pendStart;
  if (p && p.message_id === w.id && ps) return { id: w.id, stale: Date.now() - ps.at > p.stale_after_ms };
  return { id: w.id, stale: Date.now() - Date.parse(w.last_attempt_at || w.created_at) > 180e3 };
}
async function loadChat() {
  try {
    const c = await api('/api/chat');
    const ch = setChat(c);
    if (ch) chatDot();
    return ch;
  } catch { return false; }
}
function chatDot() {
  const last = S.chat && [...S.chat.messages].reverse().find(m => m.role === 'bot');
  const seen = +localStorage.getItem('chatSeen') || 0;
  if (route().name === 'chat' && last) localStorage.setItem('chatSeen', last.id);
  const d = $('#chat-dot'); if (d) d.hidden = !(last && last.id > seen && route().name !== 'chat');
}
const elapsed = (from) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(from)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function chatListHtml() {
  const msgs = chatMsgs();
  if (!msgs.length) {
    return `<div class="c-empty"><span class="avatar xl" style="background:${color(CHAT_BOT)}">${esc(CHAT_NAME.trim()[0] || '?')}</span><h2>Ask ${esc(CHAT_NAME)}</h2>
      <p>${esc(ABOUT[CHAT_BOT] || 'Knows your roadmap, lessons and upcoming deadlines.')}</p>
      <div class="suggest">${SUGGEST.map(q => `<button class="sug" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
  }
  let html = '', day = null, prevRole = null;
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  for (const m of msgs) {
    const d = new Date(m.created_at), label = dayLabel(d);
    if (label !== day) { html += `<div class="c-day">${esc(label)}</div>`; day = label; prevRole = null; }
    const cont = prevRole === m.role; prevRole = m.role;
    if (m.role === 'bot') {
      html += `<div class="msg bot${cont ? ' cont' : ''}">${cont ? '<span class="av-sp"></span>' : avatar(CHAT_BOT, true)}<div class="bubble prose">${md(m.text)}<span class="b-time">${timeFmt.format(d)}</span></div></div>`;
    } else {
      const st = m.status === 'undelivered' ? `<div class="undeliv">${esc(CHAT_NAME)} is offline, will retry<button class="retry" data-id="${m.id}">${icon('retry')}Retry</button></div>`
        : m === lastUser && m.status !== 'answered' ? `<div class="m-meta">${m.status === 'sending' ? 'Sending…' : 'Delivered'} · ${timeFmt.format(d)}</div>` : '';
      html += `<div class="msg user${cont ? ' cont' : ''}${m.status === 'undelivered' ? ' failed' : ''}">${attHtml(m.attachments)}${m.text ? `<div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div>` : ''}${st}</div>`;
    }
  }
  const ty = typingState();
  if (ty && !ty.stale) html += `<div class="msg bot typing" id="typing" aria-live="polite">${avatar(CHAT_BOT, true)}<div class="bubble"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="t-label">${esc(CHAT_NAME)} is typing…</span></div></div>`;
  else if (ty) html += `<div class="msg bot typing stale" id="typing" aria-live="polite">${avatar(CHAT_BOT, true)}<div class="bubble"><span class="t-label">Still thinking…</span><button class="retry t-retry" data-id="${ty.id}">${icon('retry')}Retry</button></div></div>`;
  return html;
}
V.chat = () => {
  const draft = localStorage.getItem('chatDraft') || '';
  return `<header class="topbar chat-top" id="topbar"><div class="bar"><h1>${avatar(CHAT_BOT, true)}${esc(CHAT_NAME)}</h1><div class="actions">${stats()}</div></div></header>
    <main class="page chat-page" id="chat-list">${S.chat || S.chatSending.length ? chatListHtml() : '<div class="skel"></div>'}</main>
    <form class="composer" id="composer" autocomplete="off"><div class="att-chips c-chips" id="chips-chat">${chipsHtml('chat')}</div><button type="button" class="c-clip" data-pick="chat" aria-label="Attach images or files">${icon('clip')}</button><textarea id="chat-input" rows="1" placeholder="Message ${esc(CHAT_NAME)}" enterkeyhint="send" aria-label="Message ${esc(CHAT_NAME)}">${esc(draft)}</textarea><button class="send" id="send" type="submit" aria-label="Send"${draft.trim() || pendState('chat').ids.length ? '' : ' disabled'}>${icon('send')}</button></form>`;
};
const nearBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 140;
const toBottom = () => scrollTo(0, document.documentElement.scrollHeight);
function refreshChat(force) {
  const el = $('#chat-list'); if (!el) return;
  const stick = force || nearBottom();
  el.innerHTML = chatListHtml(); afterRender();
  if (stick) toBottom();
}
function growInput() { const t = $('#chat-input'); if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; const P = pendState('chat'); $('#send').disabled = P.busy || P.err || (!t.value.trim() && !P.ids.length); document.documentElement.style.setProperty('--composerh', $('#composer').offsetHeight + 'px'); }
async function sendChat(text) {
  text = text.trim();
  const P = pendState('chat'), items = pend('chat').filter(p => p.status === 'done');
  if (P.busy || P.err) return toast(P.busy ? 'Still uploading…' : 'Remove the failed file first');
  if (!text && !P.ids.length) return;
  const tmp = { id: 'tmp' + Date.now(), role: 'user', text, created_at: new Date().toISOString(), status: 'sending',
    attachments: items.map(p => ({ ...p.up, url: p.preview || p.up.url })) };
  S.chatSending.push(tmp); localStorage.removeItem('chatDraft'); PEND.chat = []; paintChips('chat');
  const t = $('#chat-input'); if (t) { t.value = ''; growInput(); }
  refreshChat(true); pollChat();
  try {
    const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text, attachments: P.ids }) });
    S.chatSending = S.chatSending.filter(x => x !== tmp);
    setChat(res);
  } catch {
    S.chatSending = S.chatSending.filter(x => x !== tmp);
    if (t && !t.value) { t.value = text; growInput(); }
    if (!pend('chat').length && items.length) { PEND.chat = items; paintChips('chat'); }
    toast(navigator.onLine ? 'Couldn’t send' : 'You’re offline');
  }
  refreshChat(true); pollChat();
}
async function retryChat(id) {
  const m = S.chat && S.chat.messages.find(x => x.id === id); if (!m) return;
  m.status = 'sending'; refreshChat(); pollChat();
  try { const res = await api(`/api/chat/${id}/retry`, { method: 'POST', body: '{}' }); setChat(res); }
  catch { m.status = 'undelivered'; toast('Retry failed'); }
  refreshChat(); pollChat();
}
let chatTimer = null, autoRetried = new Set();
function pollChat() {
  clearTimeout(chatTimer);
  const fast = !!awaitingMsg();
  chatTimer = setTimeout(async () => {
    if (document.visibilityState === 'visible') {
      const ch = await loadChat();
      if (ch && route().name === 'chat') refreshChat();
    }
    pollChat();
  }, fast ? 2500 : 30000);
}
let lastTyping = '';
setInterval(() => { // flip typing -> "still thinking" at 3 min without waiting for a poll
  const ty = typingState(), k = ty ? `${ty.id}:${ty.stale}` : '';
  if (k !== lastTyping) { const was = lastTyping; lastTyping = k; if (was && route().name === 'chat' && $('#chat-list')) refreshChat(); }
}, 1000);
function maybeAutoRetry() { // "will retry": one automatic retry per undelivered message when the chat is opened
  const last = S.chat && [...S.chat.messages].reverse().find(m => m.role === 'user');
  if (last && last.status === 'undelivered' && !autoRetried.has(last.id) && navigator.onLine) { autoRetried.add(last.id); retryChat(last.id); }
}
document.addEventListener('input', (e) => { if (e.target.id === 'chat-input') { localStorage.setItem('chatDraft', e.target.value); growInput(); } });
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'chat-input' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  if (matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendChat(e.target.value); }
});
document.addEventListener('submit', (e) => { if (e.target.id === 'composer') { e.preventDefault(); sendChat($('#chat-input').value); $('#chat-input').focus(); } });

// ---------- attachments (chat composer + lesson submissions) ----------
// Files upload as soon as they're picked; the message/submission then carries the upload ids.
const ATT_EXT = /\.(jpe?g|png|webp|gif|heic|heif|txt|log|md|py|js|ts|json|csv|ps1|sh|pdf)$/i;
const ATT_MAX = 10 * 1024 * 1024, ATT_N = 5;
const PEND = {}; // ctx ('chat' | 'sub:<lesson>') -> [{key, name, size, type, isImg, preview, status, up, err}]
const pend = (ctx) => PEND[ctx] || (PEND[ctx] = []);
const pendState = (ctx) => { const l = pend(ctx); return { busy: l.some(p => p.status === 'uploading'), err: l.some(p => p.status === 'error'), ids: l.filter(p => p.status === 'done').map(p => p.up.id) }; };
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const isImgType = (t, name) => /^image\//.test(t || '') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name || '');
function chipsHtml(ctx) {
  return pend(ctx).map(p => `<div class="chip-att${p.isImg && p.preview ? ' img' : ''}${p.status === 'error' ? ' err' : ''}${p.status === 'uploading' ? ' busy' : ''}">`
    + (p.isImg && p.preview ? `<img src="${p.preview}" alt="" onerror="this.parentNode.classList.remove('img');this.remove()">` : '')
    + `<span class="ca-file">${icon('file')}<span class="ca-txt"><span class="ca-name">${esc(p.name)}</span><span class="ca-size">${p.status === 'error' ? esc(p.err) : fmtSize(p.size)}</span></span></span>`
    + (p.status === 'uploading' ? '<span class="ca-spin" aria-label="Uploading"></span>' : '')
    + `<button type="button" class="ca-x" data-ctx="${esc(ctx)}" data-key="${p.key}" aria-label="Remove ${esc(p.name)}">${icon('x')}</button></div>`).join('');
}
function paintChips(ctx) {
  const el = document.getElementById(ctx === 'chat' ? 'chips-chat' : 'chips-sub');
  if (el && (ctx === 'chat' || ctx === 'sub:' + route().id)) el.innerHTML = chipsHtml(ctx);
  if (ctx === 'chat') growInput(); else subUpdate();
}
let pickCtx = null;
function pickFiles(ctx) { pickCtx = ctx; const i = $('#file-pick'); i.value = ''; i.click(); }
function addFiles(ctx, files) {
  const list = pend(ctx);
  for (const f of files) {
    if (list.length >= ATT_N) { toast(`Up to ${ATT_N} files per message`); break; }
    const name = f.name || 'image';
    if (!ATT_EXT.test(name) && !/^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/.test(f.type)) { toast(`Can’t attach ${esc(name)}`); continue; }
    if (f.size > ATT_MAX) { toast(`${esc(name)} is over 10 MB`); continue; }
    const p = { key: Math.random().toString(36).slice(2), name, size: f.size, type: f.type, isImg: isImgType(f.type, name), status: 'uploading' };
    if (p.isImg) p.preview = URL.createObjectURL(f);
    list.push(p); uploadFile(ctx, p, f);
  }
  paintChips(ctx);
}
async function uploadFile(ctx, p, f) {
  try {
    const r = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(p.name) }, body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 413 ? 'Over 10 MB' : j.error || 'Upload failed');
    p.up = j; p.status = 'done';
  } catch (e) { p.status = 'error'; p.err = navigator.onLine ? (e.message || 'Upload failed') : 'Offline'; }
  if (pend(ctx).includes(p)) paintChips(ctx);
}
function removePend(ctx, key) {
  const l = pend(ctx), i = l.findIndex(p => p.key === key); if (i < 0) return;
  if (l[i].preview) URL.revokeObjectURL(l[i].preview);
  l.splice(i, 1); paintChips(ctx);
}
// attachments inside a bubble / submission: images inline (tap to view), other files as cards
function attHtml(list) {
  if (!list || !list.length) return '';
  return `<div class="atts">${list.map(a => {
    const img = a.kind === 'image' || isImgType(a.type, a.name);
    const card = `<span class="att-f">${icon('file')}<span class="ca-txt"><span class="ca-name">${esc(a.name)}</span><span class="ca-size">${a.size ? fmtSize(a.size) : ''}</span></span></span>`;
    return img ? `<a class="att img" href="${esc(a.url)}" target="_blank" rel="noopener" data-view-img><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" onerror="this.parentNode.classList.add('broken')">${card}</a>`
      : `<a class="att file" href="${esc(a.url)}" target="_blank" rel="noopener">${card}</a>`;
  }).join('')}</div>`;
}
function viewImage(src, alt) {
  const o = document.createElement('div'); o.className = 'lightbox';
  o.innerHTML = `<img src="${esc(src)}" alt="${esc(alt || '')}"><button class="lb-x" aria-label="Close">${icon('x')}</button>`;
  o.addEventListener('click', () => o.remove()); document.body.appendChild(o);
}
document.addEventListener('change', (e) => { if (e.target.id === 'file-pick' && pickCtx) { addFiles(pickCtx, [...e.target.files]); e.target.value = ''; } });
document.addEventListener('click', (e) => {
  const x = e.target.closest('.ca-x'); if (x) { e.preventDefault(); return removePend(x.dataset.ctx, x.dataset.key); }
  const pk = e.target.closest('[data-pick]'); if (pk) { e.preventDefault(); return pickFiles(pk.dataset.pick === 'chat' ? 'chat' : 'sub:' + route().id); }
  const im = e.target.closest('a.att.img'); if (im && !im.classList.contains('broken')) { e.preventDefault(); e.stopPropagation(); return viewImage(im.getAttribute('href'), im.querySelector('img').alt); }
}, true);
document.addEventListener('paste', (e) => { // pasting a screenshot into either field attaches it
  const id = e.target.id; if (id !== 'chat-input' && id !== 'sub-input') return;
  const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (!files.length) return;
  e.preventDefault(); addFiles(id === 'chat-input' ? 'chat' : 'sub:' + route().id, files);
});

// ---------- lesson submissions ("Your work" box) ----------
S.subs = {}; S.subJust = null;
let subSending = false, subScrolled = null;
const subTimeFmt = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
function submitBoxHtml(L) {
  const draft = localStorage.getItem('subDraft:' + L.id) || '';
  return `<section class="submit-box" id="submit-box" data-lesson="${L.id}"><div class="sb-head"><span class="sb-ic">${icon('pen')}</span><div><h2>Your work</h2><p>${inline(L.submit.prompt)}</p></div></div>
    <div class="sb-field"><textarea id="sub-input" class="sb-input" wrap="off" rows="6" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" placeholder="${esc(L.submit.placeholder || 'Paste here')}" aria-label="Your work">${esc(draft)}</textarea>
      <div class="att-chips" id="chips-sub">${chipsHtml('sub:' + L.id)}</div>
      <div class="sb-bar"><button type="button" class="sb-clip" data-pick="sub" aria-label="Attach images or files">${icon('clip')}</button><span class="sb-count" id="sb-count"></span><button type="button" class="btn primary sb-send" id="sub-send" disabled>${icon('send')}Send to Coach</button></div></div>
    <div class="sb-list" id="sb-list">${subListHtml(L.id)}</div></section>`;
}
function subListHtml(id) {
  const subs = S.subs[id]; if (!subs || !subs.length) return '';
  return `<h3 class="sb-lh">Your submissions <span>${subs.length}</span></h3>` + subs.map(s => {
    const st = s.status === 'undelivered' ? `<span class="sb-st bad">Not delivered, Coach is offline</span><button class="sb-retry" data-sub="${s.id}">${icon('retry')}Retry</button>`
      : s.status === 'reviewed' ? `<span class="sb-st ok">${icon('check')}Reviewed</span>` : `<span class="sb-st ok">${icon('check')}Sent to Coach</span>`;
    const fb = (s.feedback || []).map(f => `<div class="sb-fb"><div class="sb-fbh">${avatar(FEEDBACK_BOT, true)}<b>${esc(f.by || dn(FEEDBACK_BOT))}</b><span>${subTimeFmt.format(new Date(f.at))}</span></div><div class="prose">${md(f.text)}</div></div>`).join('');
    const wait = s.status === 'sent' && !fb ? '<p class="sb-wait">Coach’s feedback will show up here.</p>' : '';
    return `<article class="sb-item${S.subJust === s.id ? ' just' : ''}" id="sub-${s.id}"><div class="sb-meta">${st}<span class="sb-time">${subTimeFmt.format(new Date(s.created_at))}</span></div>
      ${s.text ? `<pre class="sb-pre">${esc(s.text)}</pre>` : ''}${attHtml(s.attachments)}${wait}${fb}</article>`;
  }).join('');
}
async function loadSubs(id) {
  try { const r = await api(`/api/lessons/${id}/submissions`); const ch = JSON.stringify(r.submissions) !== JSON.stringify(S.subs[id]); S.subs[id] = r.submissions; return ch; } catch { return false; }
}
function paintSubs(id) {
  const el = $('#sb-list'); if (!el || route().id !== id) return;
  el.innerHTML = subListHtml(id);
  const h = location.hash.slice(1); // push links to /lessons/<id>#sub-<sid>
  if (h && h !== subScrolled && document.getElementById(h)) { subScrolled = h; document.getElementById(h).scrollIntoView({ block: 'center' }); }
}
function subUpdate() {
  const t = $('#sub-input'); if (!t) return;
  t.style.height = 'auto'; t.style.height = Math.min(Math.max(t.scrollHeight + 2, 132), 1400) + 'px';
  const P = pendState('sub:' + route().id), b = $('#sub-send');
  b.disabled = subSending || P.busy || P.err || (!t.value.trim() && !P.ids.length);
  const n = t.value.trim() ? t.value.replace(/\s+$/, '').split('\n').length : 0, f = pend('sub:' + route().id).length;
  $('#sb-count').textContent = [n ? `${n} line${n > 1 ? 's' : ''}` : '', f ? `${f} file${f > 1 ? 's' : ''}` : '', P.busy ? 'uploading…' : ''].filter(Boolean).join(' · ');
}
async function sendSub() {
  const id = route().id, t = $('#sub-input'), ctx = 'sub:' + id, P = pendState(ctx);
  if (!t || subSending || P.busy || P.err) return;
  const text = t.value.replace(/\s+$/, ''); if (!text.trim() && !P.ids.length) return;
  subSending = true; const b = $('#sub-send'); b.innerHTML = 'Sending…'; subUpdate();
  try {
    const r = await api(`/api/lessons/${id}/submissions`, { method: 'POST', body: JSON.stringify({ text, attachments: P.ids }) });
    S.subs[id] = r.submissions; S.subJust = r.submission.id;
    localStorage.removeItem('subDraft:' + id); PEND[ctx] = [];
    if (route().id === id) {
      t.value = ''; t.blur(); paintChips(ctx); paintSubs(id);
      const card = document.getElementById('sub-' + r.submission.id); if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    toast(r.submission.status === 'undelivered' ? 'Saved. Coach is offline, retry below' : 'Sent to Coach ✓');
  } catch { toast(navigator.onLine ? 'Couldn’t send' : 'You’re offline'); }
  subSending = false; const b2 = $('#sub-send'); if (b2) b2.innerHTML = `${icon('send')}Send to Coach`; subUpdate();
}
async function retrySub(sid) {
  const id = route().id;
  try { const r = await api(`/api/submissions/${sid}/retry`, { method: 'POST', body: '{}' }); S.subs[id] = r.submissions; paintSubs(id); toast(r.submission.status === 'undelivered' ? 'Still offline' : 'Sent to Coach ✓'); }
  catch { toast('Retry failed'); }
}
document.addEventListener('input', (e) => { if (e.target.id === 'sub-input') { localStorage.setItem('subDraft:' + route().id, e.target.value); subUpdate(); } });
document.addEventListener('click', (e) => {
  const b = e.target.closest('#sub-send, .sb-retry'); if (!b) return;
  e.stopPropagation(); if (b.id === 'sub-send') sendSub(); else retrySub(b.dataset.sub);
}, true);
setInterval(async () => { // new feedback shows up while the lesson is open
  const r = route(); if (r.name !== 'lesson' || document.visibilityState !== 'visible' || !(S.lessons[r.id] && S.lessons[r.id].submit)) return;
  if (await loadSubs(r.id)) paintSubs(r.id);
}, 20000);

// tray height for padding/toasts; skipped while the keyboard hides the tray (it would read 0)
function measureTray() { const tray = $('.tray'); if (tray && !tray.offsetHeight && document.body.classList.contains('kb-open')) return; document.documentElement.style.setProperty('--trayh', tray ? tray.offsetHeight + 'px' : '0px'); }
// ---------- on-screen keyboard (iOS standalone) ----------
// While a text field is focused or the visual viewport is shrunk by the keyboard: hide the tab bar,
// drop the safe-area padding and dock the composer to the keyboard top via --kb.
const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
  (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i.test(el.type)));
let kbStick = false, kbBlurT = null;
function kbUpdate(stick = true) {
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  const focused = isTextField(document.activeElement);
  const open = focused || kb > 80;
  const root = document.documentElement;
  root.style.setProperty('--kb', (open ? kb : 0) + 'px');
  if (document.body.classList.contains('kb-open') !== open) { document.body.classList.toggle('kb-open', open); if (!open) measureTray(); }
  if (open && stick && kbStick && route().name === 'chat') toBottom();
}
function kbFocus(e) {
  if (!isTextField(e.target)) return;
  clearTimeout(kbBlurT);
  kbStick = e.target.id === 'chat-input' ? nearBottom() : false;
  kbUpdate();
  // iOS animates the keyboard in; re-measure as it settles
  [60, 250, 500].forEach(ms => setTimeout(kbUpdate, ms));
}
// delayed so focus moving between fields does not flash the nav
function kbBlur() { clearTimeout(kbBlurT); kbBlurT = setTimeout(() => { kbStick = false; kbUpdate(); }, 120); }
document.addEventListener('focusin', kbFocus);
document.addEventListener('focusout', kbBlur);
if (window.visualViewport) { visualViewport.addEventListener('resize', () => kbUpdate()); visualViewport.addEventListener('scroll', () => kbUpdate(false)); }
// keep the keyboard up when tapping send (don't let the button steal focus)
document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('#send, .ca-x') && document.activeElement && document.activeElement.id === 'chat-input') e.preventDefault(); });
// iOS: stop the page behind from rubber-banding when dragging the composer itself
document.addEventListener('touchmove', (e) => { if (document.body.classList.contains('kb-open') && e.target.closest && e.target.closest('#composer') && e.target.id !== 'chat-input') e.preventDefault(); }, { passive: false });

// the service worker asks which screen is showing before it displays a chat push
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'route?' && e.ports[0]) e.ports[0].postMessage({ path: location.pathname, visible: document.visibilityState === 'visible' });
});

// ---------- presence: tell the server which screen is up ('chat' / 'lesson:<id>') so pushes for it are skipped ----------
let presenceT = null, presenceView = null;
function presenceSend(view, visible) {
  const body = JSON.stringify({ view, visible });
  if (!visible && navigator.sendBeacon) { try { if (navigator.sendBeacon('/api/presence', new Blob([body], { type: 'text/plain' }))) return; } catch {} }
  fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).catch(() => {});
}
function presenceTick() {
  clearTimeout(presenceT);
  const r = route(), vis = document.visibilityState === 'visible';
  const view = !vis ? null : r.name === 'chat' ? 'chat' : r.name === 'lesson' ? 'lesson:' + r.id : null;
  if (presenceView && presenceView !== view) presenceSend(presenceView, false);
  if (view) { presenceSend(view, true); presenceT = setTimeout(presenceTick, 10000); }
  presenceView = view;
}
document.addEventListener('visibilitychange', presenceTick);
addEventListener('pagehide', () => { if (presenceView) { clearTimeout(presenceT); presenceSend(presenceView, false); presenceView = null; } });
addEventListener('pageshow', presenceTick);

// ---------- lesson reader + quiz ----------
function lessonHead(L) {
  const u = L.unit;
  const isTest = L.type === 'test';
  const qAttempt = L.quiz_attempt;
  const awaitReview = isTest && !L.completed && qAttempt;
  return `<div class="l-hero" style="--mc:${(u && u.color) || 'var(--accent)'}">
    ${u ? `<div class="l-crumb">${esc(u.month_title)} · ${esc(u.title)}</div>` : ''}
    ${isTest ? '<span class="test-badge">Module test</span>' : ''}
    <h1 class="l-title">${esc(L.title)}</h1>
    <div class="l-meta">${L.n ? `<span>${icon('book')}${isTest ? 'Module test' : 'Lesson'} ${L.n}</span>` : ''}${L.minutes ? `<span>${icon('clock')}${L.minutes} min</span>` : ''}<span>${icon('bolt')}+${L.xp} XP</span>${L.quiz.length ? `<span>${icon('quiz')}${L.quiz.length} questions</span>` : ''}${isTest && L.pass_mark != null ? `<span>Pass mark ${L.pass_mark}%</span>` : ''}</div>
    ${L.completed ? `<div class="l-done">${icon('tick')}${isTest ? 'Passed' : 'Completed'} ${esc(keyDate(L.completed.date))}${L.completed.total ? ` · quiz ${L.completed.score}/${L.completed.total}` : ''}</div>` : awaitReview ? `<div class="l-await">${icon('quiz')}Objective score ${qAttempt.score}/${qAttempt.total}. Submit the Practical below — Coach marks pass/fail.</div>` : L.status === 'locked' && L.available ? `<div class="l-ahead">${icon('lock')}Reading ahead: finish the current lesson first for the streak</div>` : ''}
  </div>`;
}
function renderLesson(L) {
  const v = $('#view');
  if (quiz && quiz.id === L.id) return renderQuiz(L);
  let html = backbar(L.n ? `Lesson ${L.n}` : '');
  html += `<article class="lesson">${lessonHead(L)}`;
  if (!L.available) {
    html += `<div class="soon">${icon('pen')}<h2>Coming soon</h2><p>${esc(dn(FEEDBACK_BOT))} is writing it.</p></div></article>
      <div class="tray"><a class="btn big" href="/roadmap">Back to roadmap</a></div>`;
  } else {
    html += `<div class="prose">${md(L.body)}</div>${L.submit ? submitBoxHtml(L) : ''}</article><div class="tray">`;
    const isTest = L.type === 'test';
    if (L.quiz.length) html += `<button class="btn big primary" id="quiz-start">${L.completed || L.quiz_attempt ? 'Retake quiz' : (isTest ? 'Start objective' : 'Start quiz')} · ${L.quiz.length} questions${icon('play')}</button>`;
    else if (!L.completed && !isTest) html += `<button class="btn big primary" id="quiz-complete">Complete lesson · +${L.xp} XP</button>`;
    else if (L.completed) html += L.next ? `<a class="btn big primary" href="/lessons/${L.next.id}">Next: ${esc(L.next.title)}</a>` : `<a class="btn big" href="/roadmap">Back to roadmap</a>`;
    else if (isTest) html += `<a class="btn big" href="/roadmap">Back to roadmap</a>`;
    html += '</div>';
  }
  v.innerHTML = html; afterRender();
  if (L.available && L.submit) { subUpdate(); loadSubs(L.id).then(() => paintSubs(L.id)); }
}
function dots(L) {
  return `<div class="q-dots">${L.quiz.map((q, i) => {
    const p = quiz.picks[i]; const cls = p ? (p === q.answer ? 'ok' : 'bad') : i === quiz.i ? 'cur' : '';
    return `<span class="${cls}"></span>`;
  }).join('')}</div>`;
}
function renderQuiz(L) {
  const v = $('#view');
  if (quiz.i >= L.quiz.length) return renderResults(L);
  const q = L.quiz[quiz.i], picked = quiz.picks[quiz.i], ok = picked === q.answer;
  let html = `<header class="topbar detail-bar quiz-bar" id="topbar"><button id="quiz-close" class="icon-btn" aria-label="Leave quiz">${icon('x')}</button>${dots(L)}<div class="actions">${stats()}</div></header>`;
  html += `<main class="quiz"><div class="q-count">Question ${quiz.i + 1} of ${L.quiz.length}</div><h2 class="q-text">${inline(q.question)}</h2>
    ${q.code ? codeCard(q.code, q.lang) : ''}
    <div class="opts">${q.options.map(o => {
      const cls = picked ? (o.key === q.answer ? 'right' : o.key === picked ? 'wrong' : 'dim') : '';
      return `<button class="opt ${cls}" data-key="${o.key}" ${picked ? 'disabled' : ''}><span class="opt-k">${o.key}</span><span class="opt-t">${inline(o.text)}</span>${cls === 'right' ? icon('tick', 'opt-i') : cls === 'wrong' ? icon('x', 'opt-i') : ''}</button>`;
    }).join('')}</div></main><div class="tray quiz-tray">`;
  if (!picked) html += `<div class="ans-grid">${q.options.map(o => `<button class="ans" data-key="${o.key}">${o.key}</button>`).join('')}</div>`;
  else html += `<div class="fb ${ok ? 'ok' : 'bad'}"><div class="fb-h">${icon(ok ? 'tick' : 'x')}<b>${ok ? `Correct! +${QUIZ_BONUS} XP` : `Not quite. The answer is ${q.answer}.`}</b></div>
      ${q.explain ? `<div class="fb-t">${inline(q.explain)}</div>` : ''}
      <button class="btn big ${ok ? 'ok' : 'bad'}" id="quiz-next">${quiz.i + 1 < L.quiz.length ? 'Continue' : 'See results'}</button></div>`;
  html += '</div>';
  v.innerHTML = html; afterRender();
}
function renderResults(L) {
  const v = $('#view');
  const score = L.quiz.filter((q, i) => quiz.picks[i] === q.answer).length, total = L.quiz.length;
  const prev = L.completed ? (L.completed.score || 0) : null;
  const xp = prev === null ? L.xp + QUIZ_BONUS * score : Math.max(0, QUIZ_BONUS * (score - prev));
  const pct = Math.round(100 * score / total);
  const head = pct === 100 ? 'Perfect score!' : pct >= 75 ? 'Nice work!' : pct >= 50 ? 'Good effort' : 'Keep practising';
  const isTest = L.type === 'test';
  const saveLabel = isTest ? (L.quiz_attempt ? 'Update objective score' : 'Save objective score') : (L.completed ? 'Save score' : 'Complete lesson');
  const xpLabel = isTest ? 'XP on pass' : `XP${prev !== null ? (xp ? ' (improved)' : ' (already earned)') : ''}`;
  let html = `<header class="topbar detail-bar quiz-bar" id="topbar"><button id="quiz-close" class="icon-btn" aria-label="Close">${icon('x')}</button>${dots(L)}<div class="actions">${stats()}</div></header>
  <main class="results"><div class="ring" style="--p:${pct}"><div><b>${score}/${total}</b><span>correct</span></div></div>
    <h1>${head}</h1><p class="r-sub">${esc(L.title)}${isTest ? ' · Objective' : ''}</p>
    <div class="r-stats"><div class="rs xp">${icon('bolt')}<b>+${isTest ? L.xp + QUIZ_BONUS * score : xp}</b><span>${xpLabel}</span></div>
      <div class="rs streak">${icon('flame')}<b>${quiz.saved ? S.prog.streak : predictStreak()}</b><span>day streak</span></div></div>
    <ol class="r-review">${L.quiz.map((q, i) => `<li class="${quiz.picks[i] === q.answer ? 'ok' : 'bad'}">${icon(quiz.picks[i] === q.answer ? 'tick' : 'x')}<span>${inline(q.question)}</span></li>`).join('')}</ol>
    ${pct < 100 ? '<button class="linkbtn" id="quiz-retry">Retry quiz</button>' : ''}
  </main><div class="tray stack">
    <button class="btn big primary" id="quiz-complete">${saveLabel}</button>
    <a class="btn big ghost" href="/roadmap">Back to roadmap</a></div>`;
  v.innerHTML = html; afterRender();
}
async function completeLesson(L, score) {
  const btn = $('#quiz-complete'); if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/lessons/${L.id}/complete`, { method: 'POST', body: JSON.stringify({ score }) });
    S.prog = r.progress; quiz = null; delete S.lessons[L.id];
    await loadStudy();
    if (r.awaiting_review) {
      toast(`Objective saved · <b>${(r.quiz && r.quiz.score) ?? score}/${(r.quiz && r.quiz.total) ?? (L.quiz.length || 0)}</b> — submit Practical for Coach`);
      return go(`/lessons/${L.id}`);
    }
    S.justDone = L.id;
    toast(r.first_time ? `Lesson complete · <b>+${r.xp_gained} XP</b>` : r.xp_gained ? `Score saved · <b>+${r.xp_gained} XP</b>` : 'Score saved');
    go('/roadmap');
  } catch { if (btn) btn.disabled = false; toast('Could not save. Try again.'); }
}
const typingIn = (id) => document.activeElement && document.activeElement.id === 'sub-input' && $('#submit-box') && $('#submit-box').dataset.lesson === id;
async function viewLesson(r) {
  const v = $('#view');
  const cached = S.lessons[r.id];
  if (typingIn(r.id)) { /* keep what's on screen */ }
  else if (cached) renderLesson(cached);
  else { v.innerHTML = backbar('') + '<article class="lesson"><div class="skel big"></div><div class="skel"></div></article>'; afterRender(); }
  try {
    const L = await api(`/api/lessons/${r.id}`);
    const changed = JSON.stringify(L) !== JSON.stringify(cached);
    S.lessons[r.id] = L;
    // don't rebuild under his fingers while he's typing in the work box (draft + files survive a rebuild anyway)
    if (route().id === r.id && changed && !(quiz && quiz.id === r.id) && !typingIn(r.id)) renderLesson(L);
  } catch { if (!cached) { v.innerHTML = backbar('') + '<p class="notfound">Lesson not found</p>'; afterRender(); } }
}

// ---------- routing ----------
function route() {
  const p = location.pathname.replace(/\/+$/, '') || '/'; let m;
  if (p === '/roadmap') return { name: 'roadmap', tab: 'roadmap' };
  if (p === '/lessons') return { name: 'lessons', tab: 'lessons' };
  if ((m = p.match(/^\/lessons\/([a-z0-9-]+)$/))) return { name: 'lesson', tab: 'lessons', id: m[1], detail: true };
  if (p === '/inbox') return { name: 'inbox', tab: 'inbox' };
  if ((m = p.match(/^\/m\/(\d+)$/))) return { name: 'message', tab: 'inbox', id: +m[1], detail: true };
  if (p === '/opps') return { name: 'opps', tab: 'inbox' };
  if ((m = p.match(/^\/opps\/([a-z0-9-]+)$/))) return { name: 'opp', tab: 'inbox', slug: m[1], detail: true };
  if (p === '/chat') return { name: 'chat', tab: 'chat' };
  return { name: 'today', tab: 'today' };
}
const scrolls = {};
function afterRender() {
  const tb = $('#topbar'); if (tb) document.documentElement.style.setProperty('--hh', tb.offsetHeight + 'px');
  measureTray();
}
function render(reason = 'nav') {
  const r = route();
  updateBadges();
  if (reason === 'data') {
    if (r.name === 'lesson') { $$('#view .stats').forEach(el => { el.outerHTML = stats(); }); return; }
    if (r.name === 'message' && $('#view .d-title')) return;
    if (r.name === 'opp' && $('#view .d-title')) return;
    if (r.name === 'chat' && $('#chat-list')) { $$('#view .stats').forEach(el => { el.outerHTML = stats(); }); refreshChat(); chatDot(); return; }
  }
  document.body.dataset.view = r.name;
  presenceTick();
  $('#tabbar').hidden = !!r.detail;
  $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === r.tab));
  if (r.name === 'lesson') return viewLesson(r);
  $('#view').innerHTML = V[r.name](r);
  afterRender();
  chatDot();
  if (r.name === 'chat') { growInput(); maybeAutoRetry(); }
  kbUpdate();
}
function go(path) {
  saveScroll();
  history.pushState({ inApp: true }, '', path);
  render('nav');
  const cur = route().name === 'roadmap' && $('.node.current, .node.pop');
  if (cur) scrollToNode(); else if (route().name === 'chat') restoreChatScroll(); else scrollTo(0, 0);
}
function saveScroll() {
  scrolls[location.pathname] = scrollY;
  if (route().name === 'chat') { const n = chatMsgs().length; sessionStorage.setItem('chatScroll', JSON.stringify({ y: scrollY, n, bottom: nearBottom() })); }
}
function restoreChatScroll() { // persist scroll: back where you were, unless new messages arrived (then the latest)
  let s = null; try { s = JSON.parse(sessionStorage.getItem('chatScroll')); } catch {}
  if (s && !s.bottom && s.n === chatMsgs().length) scrollTo(0, s.y); else toBottom();
}
addEventListener('pagehide', saveScroll);
function scrollToNode() {
  const n = $('.node.pop') || $('.node.current'); if (!n) return;
  const r = n.getBoundingClientRect();
  const fits = scrollY + r.bottom < innerHeight * 0.72; // already comfortably on screen from the top: keep the month banner visible
  scrollTo(0, fits ? 0 : Math.max(0, scrollY + r.top - innerHeight * 0.42));
  setTimeout(() => { S.justDone = null; }, 1500);
}
function back() {
  if (history.state && history.state.inApp) history.back();
  else { const r = route(); history.replaceState(null, '', r.name === 'message' ? '/inbox' : r.name === 'opp' ? '/opps' : r.name === 'lesson' ? '/roadmap' : '/'); render('nav'); scrollTo(0, 0); }
}
addEventListener('popstate', () => {
  quiz = null; render('nav');
  const y = scrolls[location.pathname];
  requestAnimationFrame(() => route().name === 'chat' ? restoreChatScroll() : scrollTo(0, y || 0));
});

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target;
  const a = t.closest('a[href]');
  if (a && !a.target && a.origin === location.origin && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (a.pathname === location.pathname) {
      if (a.closest('#tabbar')) { quiz = null; render('nav'); if (route().name === 'chat') toBottom(); else scrollTo({ top: 0, behavior: 'smooth' }); }
      return;
    }
    go(a.pathname); return;
  }
  const btn = t.closest('button'); if (!btn) return;
  if (btn.classList.contains('sug')) return sendChat(btn.dataset.q);
  if (btn.classList.contains('retry')) return retryChat(+btn.dataset.id);
  if (btn.id === 'settings') return settingsSheet();
  const r = route(), L = r.name === 'lesson' ? S.lessons[r.id] : null;
  if (btn.classList.contains('copy')) {
    const txt = codeText(btn.closest('.code'));
    try { await navigator.clipboard.writeText(txt); } catch {
      const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    btn.classList.add('done'); btn.querySelector('span').textContent = 'Copied'; setTimeout(() => { btn.classList.remove('done'); btn.querySelector('span').textContent = 'Copy'; }, 1500);
    return;
  }
  if (btn.classList.contains('stats')) return statsSheet();
  if (btn.classList.contains('bell-btn')) return bellClick();
  if (btn.classList.contains('chip') && btn.dataset.bot) {
    S.filter = btn.dataset.bot; localStorage.setItem('filter', S.filter);
    const x = $('.chips').scrollLeft; render('nav'); $('.chips').scrollLeft = x; return;
  }
  switch (btn.id) {
    case 'back': return back();
    case 'read-all':
      if (!S.messages.some(m => !m.read)) return toast('Nothing unread');
      S.messages.forEach(m => m.read = true); render('nav'); toast('All marked read');
      return api('/api/read-all', { method: 'POST', body: '{}' }).catch(() => loadMessages().then(() => render('data')));
    case 'delete': {
      if (!confirm('Delete this message?')) return;
      try { await api(`/api/messages/${r.id}`, { method: 'DELETE' }); } catch { return toast('Delete failed'); }
      S.messages = S.messages.filter(x => x.id !== r.id); toast('Deleted'); return back();
    }
    case 'quiz-start': quiz = { id: L.id, i: 0, picks: [] }; renderQuiz(L); return scrollTo(0, 0);
    case 'quiz-close':
      if (quiz && quiz.picks.length && quiz.i < L.quiz.length && !confirm('Leave the quiz? Your answers won’t be saved.')) return;
      quiz = null; renderLesson(L); return scrollTo(0, 0);
    case 'quiz-next': quiz.i++; renderQuiz(L); return scrollTo(0, 0);
    case 'quiz-retry': quiz = { id: L.id, i: 0, picks: [] }; renderQuiz(L); return scrollTo(0, 0);
    case 'quiz-complete': {
      const score = quiz ? L.quiz.filter((q, i) => quiz.picks[i] === q.answer).length : 0;
      return completeLesson(L, score);
    }
  }
  if ((btn.classList.contains('opt') || btn.classList.contains('ans')) && quiz && L) {
    if (quiz.picks[quiz.i]) return;
    const q = L.quiz[quiz.i], key = btn.dataset.key;
    quiz.picks[quiz.i] = key;
    if (navigator.vibrate) navigator.vibrate(key === q.answer ? 20 : [30, 40, 30]);
    api('/api/quiz-answer', { method: 'POST', body: JSON.stringify({ lesson: L.id, q: quiz.i, correct: key === q.answer }) })
      .then(res => { S.prog = res.progress; const s = $('.stats'); if (s) s.outerHTML = stats(); }).catch(() => {});
    renderQuiz(L);
  }
});
function statsSheet() {
  const p = S.prog; if (!p) return;
  sheet('Your progress', `<div class="sh-stats"><div>${icon('bolt', 'xp')}<b>${p.xp}</b><span>XP</span></div><div>${icon('flame', p.streak ? 'flame on' : 'flame')}<b>${p.streak}</b><span>day streak</span></div><div>${icon('tick', 'ok')}<b>${p.lessons_done}</b><span>lessons</span></div></div>
    <p>Earn <b>XP</b> by finishing lessons (+20) and getting quiz answers right (+5 each). Your <b>streak</b> grows each day you answer a quiz question or finish a lesson. Days count in São Tomé time.</p>
    ${p.activity_days.length ? `<p class="muted">Last studied ${esc(keyDate(p.activity_days[p.activity_days.length - 1]))}${p.best_streak ? ` · best streak ${p.best_streak}` : ''}</p>` : ''}`, [['Close', null, true]]);
}

// pull to refresh (main tabs)
(() => {
  let y0 = null, dy = 0;
  addEventListener('touchstart', (e) => { y0 = (!route().detail && scrollY <= 0) ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', (e) => { if (y0 === null) return; dy = e.touches[0].clientY - y0; const p = $('#ptr'); if (p && dy > 0) p.style.height = Math.min(dy / 2.5, 52) + 'px'; }, { passive: true });
  addEventListener('touchend', async () => {
    const p = $('#ptr');
    if (y0 !== null && dy > 120) { if (p) { p.classList.add('loading'); p.style.height = '52px'; } await loadAll(); }
    if (p) { p.classList.remove('loading'); p.style.height = '0'; } y0 = null; dy = 0;
  });
})();
addEventListener('resize', afterRender);
setInterval(() => { if (document.visibilityState === 'visible') loadMessages().then(c => c && render('data')); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadAll(); });

// ---------- sheet ----------
function sheet(title, bodyHtml, actions) {
  $('#sheet-title').textContent = title; $('#sheet-body').innerHTML = bodyHtml;
  const box = $('#sheet-actions'); box.innerHTML = '';
  actions.forEach(([label, fn, primary]) => {
    const b = document.createElement('button'); b.textContent = label; if (primary) b.className = 'primary';
    b.onclick = () => { closeSheet(); fn && fn(); }; box.appendChild(b);
  });
  $('#sheet').hidden = $('#sheet-backdrop').hidden = false;
}
function closeSheet() { $('#sheet').hidden = $('#sheet-backdrop').hidden = true; }
$('#sheet-backdrop').addEventListener('click', closeSheet);
const IOS_HELP = `<p>On iPhone, notifications work only from the home-screen app:</p>
  <ol><li>Tap <strong>Share</strong> in Safari</li><li>Choose <strong>Add to Home Screen</strong></li><li>Open <strong>inbox</strong> from your home screen and tap the bell</li></ol>`;

// ---------- push ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToU8 = (b64) => { const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); };
function setBell(on) {
  S.bell = { show: true, on };
  $$('.bell-btn').forEach(b => { b.classList.toggle('on', on); b.setAttribute('aria-label', on ? 'Notifications on' : 'Enable notifications'); });
  if (!$('.bell-btn') && route().name === 'inbox') render('nav');
}
async function initBell() {
  if (!pushSupported) { if (isIOS) setBell(false); return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const on = !!sub && Notification.permission === 'granted';
  if (on) api('/api/subscribe', { method: 'POST', body: JSON.stringify(sub) }).catch(() => {});
  setBell(on);
}
async function subscribe() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'blocked' : 'not granted');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/vapid-public-key');
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
    await api('/api/subscribe', { method: 'POST', body: JSON.stringify(sub) });
    setBell(true); toast('Notifications on');
  } catch (e) {
    const blocked = e.message === 'blocked' || Notification.permission === 'denied';
    sheet('Couldn’t enable notifications',
      (isIOS && !standalone) ? IOS_HELP : blocked ? '<p>Notifications are blocked for this site. Allow them in your browser or system settings, then tap the bell again.</p>' : `<p>${esc(e.message)}</p>` + (isIOS ? IOS_HELP : ''),
      [['OK']]);
  }
}
async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('/api/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  setBell(false); toast('Notifications off');
}
function bellClick() {
  if (!pushSupported || (isIOS && !standalone)) return sheet('Turn on notifications', IOS_HELP, [['Got it', null, true]]);
  if (S.bell.on) return sheet('Notifications are on', '<p>You’ll get a notification when a bot posts.</p>', [['Turn off', unsubscribe], ['Keep on', null, true]]);
  subscribe(); // direct user gesture
}

// ---------- start ----------
(() => { const q = Number(new URLSearchParams(location.search).get('m')); if (q) history.replaceState(null, '', `/m/${q}`); })(); // legacy /?m=<id>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'refresh') {
    Promise.all([loadMessages(), loadChat()]).then(() => render('data'));
    const r = route(); if (r.name === 'lesson' && S.lessons[r.id] && S.lessons[r.id].submit) loadSubs(r.id).then(ch => ch && paintSubs(r.id));
  } });
}
render('nav');
loadAll().then(() => { if (route().name === 'roadmap') scrollToNode(); if (route().name === 'chat') { toBottom(); maybeAutoRetry(); } pollChat(); });
initBell().catch(() => {});
