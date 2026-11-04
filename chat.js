'use strict';
// Chat with the chat bot. Messages live in Postgres (chat_messages; cached in store.S.chat); the SERVER (never
// the browser) forwards each user message to the bot's webhook (env CHAT_WEBHOOK_URL/KEY); the bot answers via
// POST /api/chat/reply (box/chat-reply.sh). Roles: 'user' (the student) and 'bot'.
const store = require('./store');
const CONV = 'main';
const { hookConfig, postHook, sameOrigin, viewActive, mountPresence } = require('./hook');
const uploads = require('./uploads');
const context = require('./context');
const kit = require('./kit');
const STALE_MS = 180000; // no reply 3 min after delivery -> UI offers a retry

const chat = store.S.chat; // { nextId, messages } — same object for the process lifetime
function outbox(msg, reason) { // undelivered: goes to the Render log (the disk is ephemeral); never contains the key
  console.log('chat-outbox ' + JSON.stringify({ at: new Date().toISOString(), message_id: msg.id, conversation_id: CONV, reason, chars: (msg.text || '').length, attachments: (msg.attachments || []).map(a => a.url) }));
}

// one try, 8 s timeout (hook.js)
async function deliver(msg) {
  msg.attempts = (msg.attempts || 0) + 1; msg.last_attempt_at = new Date().toISOString();
  let ctx = null; try { ctx = context.build({ excludeMessageId: msg.id }); } catch (e) { console.error('context build failed', e.message); }
  const reason = await postHook({ type: 'chat', conversation_id: CONV, message_id: msg.id, text: msg.text, attachments: uploads.forHook(msg.attachments), context: ctx });
  const m = chat.messages.find(x => x.id === msg.id); if (!m) return;
  if (m.status === 'answered') return; // the bot replied before we noticed
  if (reason) { m.status = 'undelivered'; m.error = reason; outbox(m, reason); }
  else { m.status = 'sent'; m.delivered_at = new Date().toISOString(); delete m.error; }
  await store.saveChat(m);
}

const view = () => {
  const msgs = chat.messages;
  const awaiting = msgs.filter(m => m.role === 'user' && m.status === 'sent').map(m => m.id);
  // typing indicator state lives here (not in the browser) so it survives reloads: the latest user message
  // that was delivered and hasn't been answered yet. age_ms is server-measured, so phone clock skew doesn't matter.
  const last = [...msgs].reverse().find(m => m.role === 'user');
  let pending = null;
  if (last && last.status === 'sent') {
    const since = last.last_attempt_at || last.created_at, age = Math.max(0, Date.now() - Date.parse(since));
    pending = { message_id: last.id, since, age_ms: age, stale: age > STALE_MS, stale_after_ms: STALE_MS };
  }
  return { conversation_id: CONV, messages: msgs, awaiting, pending, webhook_configured: !!hookConfig() };
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

module.exports = function mount(app, { authOk, pushPayload, plainText, clip }) {
  mountPresence(app);

  // the chat bot's state snapshot (same payload as `context` in the webhook); same-origin/local callers only
  app.get('/api/context', (req, res) => {
    if (!sameOrigin(req) || ['cross-site', 'same-site'].includes(req.get('sec-fetch-site'))) return res.status(403).json({ error: 'cross-origin' });
    res.set('Cache-Control', 'no-store').json(context.build());
  });

  app.get('/api/chat', (req, res) => res.set('Cache-Control', 'no-store').json(view()));

  app.post('/api/chat', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin' });
    const text = str(req.body && req.body.text, 8000);
    const att = uploads.resolve(req.body && req.body.attachments);
    if (att.error) return res.status(400).json({ error: att.error });
    if (!text && !att.list.length) return res.status(400).json({ error: 'text or attachments required' });
    const msg = { id: chat.nextId++, conversation_id: CONV, role: 'user', text, created_at: new Date().toISOString(), status: 'sent' };
    if (att.list.length) msg.attachments = att.list;
    chat.messages.push(msg); await store.addChat(msg);
    await deliver(msg);
    res.status(201).json({ ok: true, message: chat.messages.find(m => m.id === msg.id), ...view() });
  });

  app.post('/api/chat/:id/retry', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-origin' });
    const m = chat.messages.find(x => x.id === Number(req.params.id) && x.role === 'user');
    if (!m) return res.status(404).json({ error: 'not found' });
    if (m.status === 'answered') return res.json({ ok: true, message: m, ...view() });
    m.status = 'sent'; await store.saveChat(m);
    await deliver(m);
    res.json({ ok: true, message: chat.messages.find(x => x.id === m.id), ...view() });
  });

  app.post('/api/chat/reply', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const text = str(req.body && req.body.text, 40000);
    const replyTo = req.body && req.body.reply_to != null ? Number(req.body.reply_to) : null;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const q = replyTo != null ? chat.messages.find(m => m.id === replyTo && m.role === 'user') : null;
    if (replyTo != null && !q) return res.status(404).json({ error: `reply_to ${replyTo} not found` });
    const msg = { id: chat.nextId++, conversation_id: CONV, role: 'bot', bot: kit.KIT.chat_bot, text, created_at: new Date().toISOString(), reply_to: replyTo, status: 'delivered' };
    chat.messages.push(msg);
    if (q) { q.status = 'answered'; q.answered_at = msg.created_at; delete q.error; }
    await store.addChat(msg); if (q) await store.saveChat(q);
    const first = plainText((text.split('\n').find(l => l.trim()) || text));
    let push = null;
    if (viewActive('chat')) push = { skipped: 'chat-open', sent: 0 };
    else try {
      push = await pushPayload(JSON.stringify({ title: `${kit.chatName()}: ${clip(first, 80)}`, body: clip(plainText(text), 120), url: '/chat', tag: 'chat', quiet_path: '/chat' }));
    } catch (e) { console.error(e); }
    res.status(201).json({ ok: true, message: msg, push });
  });

  // admin: remove one message by id (token required)
  app.delete('/api/chat/:id', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id), n = chat.messages.length;
    const gone = chat.messages.find(m => m.id === id);
    if (gone && gone.attachments) for (const a of gone.attachments) await uploads.removeUnused(a.id, gone); // files go with the message
    chat.messages = chat.messages.filter(m => m.id !== id);
    if (chat.messages.length === n) return res.status(404).json({ error: 'not found' });
    await store.deleteChat(id); res.json({ ok: true, removed: id });
  });

  // admin: wipe the conversation (token required)
  app.delete('/api/chat', async (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const n = chat.messages.length; chat.nextId = 1; chat.messages = []; await store.wipeChat();
    res.json({ ok: true, removed: n });
  });
};
