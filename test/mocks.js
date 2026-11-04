'use strict';
// Test doubles: the chat bot's webhook (HTTP) and a Web Push service (HTTPS, self-signed). Records to JSONL.
// usage: node test/mocks.js <dir> <webhook_port> <push_port>   (dir has cert.pem/key.pem)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const [dir, wp, pp] = process.argv.slice(2);
const rec = (f, o) => fs.appendFileSync(path.join(dir, f), JSON.stringify(o) + '\n');
const body = (req) => new Promise(r => { const b = []; req.on('data', c => b.push(c)); req.on('end', () => r(Buffer.concat(b))); });
http.createServer(async (req, res) => {
  const b = await body(req); let j = null; try { j = JSON.parse(b); } catch {}
  rec('webhook.jsonl', { at: Date.now(), path: req.url, auth_ok: req.headers.authorization === `Bearer ${process.env.MOCK_HOOK_KEY}`, type: j && j.type, payload: j });
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
}).listen(+wp, '127.0.0.1');
https.createServer({ cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')) }, async (req, res) => {
  const b = await body(req);
  const gone = req.url.includes('/gone');
  rec('push.jsonl', { at: Date.now(), path: req.url, bytes: b.length, encoding: req.headers['content-encoding'], vapid: /^vapid t=/.test(req.headers.authorization || ''), ttl: req.headers.ttl, status: gone ? 410 : 201 });
  res.writeHead(gone ? 410 : 201).end();
}).listen(+pp, '127.0.0.1');
console.log('mocks up');
