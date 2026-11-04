'use strict';
// Tiny stand-in for the Render API (only what scripts/setup/render.js uses). Logs every request to <dir>/render.jsonl.
// usage: node test/mock-render.js <dir> <port> <service-url>
const http = require('http'), fs = require('fs');
const [dir, port, svcUrl] = process.argv.slice(2);
const services = []; let n = 0;
const log = (o) => fs.appendFileSync(dir + '/render.jsonl', JSON.stringify(o) + '\n');
http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const body = b ? JSON.parse(b) : null;
    log({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body });
    const send = (c, j) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== 'Bearer ' + process.env.MOCK_RENDER_KEY) return send(401, { message: 'unauthorized' });
    let m;
    if (req.method === 'GET' && u.pathname === '/v1/owners') return send(200, [{ cursor: 'c', owner: { id: 'tea-mock', name: 'Student', type: 'user' } }]);
    if (req.method === 'GET' && u.pathname === '/v1/services') return send(200, services.filter(s => s.name === u.searchParams.get('name')).map(service => ({ cursor: 'c', service })));
    if (req.method === 'POST' && u.pathname === '/v1/services') {
      if (body.serviceDetails.plan !== 'free') return send(400, { message: 'plan' });
      const s = { id: 'svc-mock' + (++n), name: body.name, ownerId: body.ownerId, repo: body.repo, suspended: 'not_suspended', dashboardUrl: 'https://dashboard.example/svc', serviceDetails: { ...body.serviceDetails, url: svcUrl }, env: Object.fromEntries(body.envVars.map(e => [e.key, e.value])) };
      services.push(s); return send(201, { service: s, deployId: 'dep-1' });
    }
    if ((m = u.pathname.match(/^\/v1\/services\/([^/]+)(\/.*)?$/))) {
      const s = services.find(x => x.id === m[1]); if (!s) return send(404, { message: 'not found' });
      if (!m[2] && req.method === 'GET') return send(200, s);
      let k; if (req.method === 'PUT' && (k = (m[2] || '').match(/^\/env-vars\/(.+)$/))) { s.env[decodeURIComponent(k[1])] = body.value; return send(200, { key: k[1], value: body.value }); }
      if (req.method === 'POST' && m[2] === '/deploys') return send(201, { id: 'dep-' + Date.now(), status: 'build_in_progress' });
      if (req.method === 'GET' && m[2] === '/deploys') return send(200, [{ deploy: { id: 'dep-1', status: 'live' } }]);
    }
    send(404, { message: 'no route' });
  });
}).listen(+port, '127.0.0.1');
