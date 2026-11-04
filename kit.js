'use strict';
// Kit config: who the app is for and which bots post to it. One file, kit.config.json (path: KIT_CONFIG),
// with env overrides so a Render service can be re-branded without a commit:
//   KIT_TITLE, KIT_SHORT_NAME, KIT_STUDENT_NAME, KIT_FIELD, KIT_ACCENT, KIT_TIMEZONE, KIT_CHAT_BOT,
//   KIT_FEEDBACK_BOT, KIT_BOTS (JSON array of {id,name,color?,about?}), KIT_CHAT_SUGGESTIONS (JSON array).
// Nothing here is secret: it is served to the signed-in app as /kit.js.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  title: 'hey studu', short_name: 'study', student_name: 'there', field: 'your field', accent: '#4f46e5', timezone: 'UTC',
  chat_bot: 'chat', feedback_bot: 'coach',
  bots: [{ id: 'coach', name: 'Coach' }, { id: 'chat', name: 'Chat' }],
  chat_suggestions: ['What should I study today?', "Explain today's lesson simply", 'What deadlines are coming up?'],
};
const PALETTE = ['#6366f1', '#f97316', '#14b8a6', '#3b82f6', '#ec4899', '#8b5cf6', '#10b981', '#f59e0b'];

const str = (v, max, d) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);
const json = (k) => { const v = process.env[k]; if (!v) return undefined; try { return JSON.parse(v); } catch { console.error(`kit: ${k} is not valid JSON, ignored`); return undefined; } };
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : d);
const botId = (v) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : '');
function validTz(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

function load() {
  let file = {};
  const p = process.env.KIT_CONFIG || path.join(__dirname, 'kit.config.json');
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error('kit: cannot read', p, e.message); }
  const E = process.env, c = { ...DEFAULTS, ...file };
  const bots0 = json('KIT_BOTS') || c.bots;
  const bots = (Array.isArray(bots0) ? bots0 : DEFAULTS.bots).map((b, i) => ({
    id: botId(b && b.id), name: str(b && b.name, 30, ''), color: hex(b && b.color, PALETTE[i % PALETTE.length]), about: str(b && b.about, 120, ''),
  })).filter(b => b.id && b.name).slice(0, 20);
  const tz = str(E.KIT_TIMEZONE, 60, str(c.timezone, 60, 'UTC'));
  const sugg = json('KIT_CHAT_SUGGESTIONS') || c.chat_suggestions;
  const kit = {
    title: str(E.KIT_TITLE, 40, str(c.title, 40, DEFAULTS.title)),
    short_name: str(E.KIT_SHORT_NAME, 14, str(c.short_name, 14, DEFAULTS.short_name)),
    student_name: str(E.KIT_STUDENT_NAME, 40, str(c.student_name, 40, DEFAULTS.student_name)),
    field: str(E.KIT_FIELD, 60, str(c.field, 60, DEFAULTS.field)),
    accent: hex(E.KIT_ACCENT, hex(c.accent, DEFAULTS.accent)),
    timezone: validTz(tz) ? tz : 'UTC',
    chat_bot: botId(E.KIT_CHAT_BOT) || botId(c.chat_bot) || 'chat',
    feedback_bot: botId(E.KIT_FEEDBACK_BOT) || botId(c.feedback_bot) || 'coach',
    bots,
    chat_suggestions: (Array.isArray(sugg) ? sugg : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 80)).slice(0, 4),
  };
  if (!bots.some(b => b.id === kit.chat_bot)) bots.push({ id: kit.chat_bot, name: 'Chat', color: kit.accent, about: '' });
  return kit;
}

const KIT = load();
const NAMES = Object.fromEntries(KIT.bots.map(b => [b.id, b.name]));
const displayName = (bot) => NAMES[bot] || (bot ? bot.charAt(0).toUpperCase() + bot.slice(1) : 'Bot');
const chatName = () => displayName(KIT.chat_bot);
const feedbackName = () => displayName(KIT.feedback_bot);
// what the browser gets (window.KIT)
const publicKit = () => ({ ...KIT });
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { KIT, NAMES, displayName, chatName, feedbackName, publicKit, esc };
