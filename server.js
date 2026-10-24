'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Harness } = require('./lib/harness');
const { createRegistry } = require('./lib/adapters');

const PORT = Number(process.env.PORT) || 3000;
// Loopback by default: this server can run commands via Claude Code in arbitrary dirs.
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.HARNESS_DATA || path.join(__dirname, 'data', 'agents.json');

const registry = createRegistry();
const harness = new Harness({ dataFile: DATA_FILE, registry });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true, defaultType: registry.defaultType, types: Object.fromEntries(Object.values(registry.types).map((t) => [t.id, t.available])), agents: harness.agents.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Reject cross-origin websockets (a random web page must not drive local agents).
  verifyClient: ({ req }) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
  },
});

const sendJson = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
harness.on('event', (ev) => { const s = JSON.stringify(ev); for (const c of wss.clients) if (c.readyState === 1) c.send(s); });

wss.on('connection', (ws) => {
  sendJson(ws, harness.snapshot());
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }
    try {
      switch (m.type) {
        case 'hire': harness.hire(m); break;
        case 'fire': harness.fire(m.id); break;
        case 'send': harness.send(m.id, m.text); break;
        case 'interrupt': harness.interrupt(m.id); break;
        default: break;
      }
    } catch (e) {
      sendJson(ws, { type: 'error', message: e.message });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Virtual Harness running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (default agent type: ${registry.defaultType})`);
  console.log('Available agent types: ' + Object.values(registry.types).map((t) => `${t.id}${t.available ? '' : ' (CLI not found)'}`).join(', '));
  if (registry.defaultType === 'mock') console.log('Mock default: new agents are simulated. Install Claude Code / Cursor CLI or set HARNESS_MODE to use the real thing.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { harness.shutdown(); process.exit(0); });
