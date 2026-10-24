'use strict';
// Exercises claude / cursor / mock agents through the real server using the stand-in CLIs.
// Usage: node scripts/test-adapters.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..');
const PORT = 3131;
const DATA = path.join(os.tmpdir(), `vh-adapters-${Date.now()}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };

function startServer(extraEnv) {
  return spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, HARNESS_DATA: DATA, HARNESS_CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), HARNESS_CURSOR_BIN: path.join(__dirname, 'fake-cursor-agent.js'), ...extraEnv } });
}
function client() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const log = []; let snap;
    ws.on('message', (d) => { const m = JSON.parse(d); log.push(m); if (m.type === 'snapshot') { snap = m; resolve({ ws, log, snap }); } });
  });
}
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); } throw new Error('timeout'); };

(async () => {
  let srv = startServer({ HARNESS_MODE: 'cursor', HARNESS_PARTIAL: process.env.HARNESS_PARTIAL || '' });
  await sleep(1000);
  let { ws, log, snap } = await client();
  assert(snap.defaultType === 'cursor', 'default type follows HARNESS_MODE=cursor');
  assert(snap.types.every((t) => t.available), 'all types reported available with stand-ins');
  const ids = {};
  for (const [name, agentType] of [['Cur', undefined], ['Cla', 'claude'], ['Moc', 'mock']]) ws.send(JSON.stringify({ type: 'hire', name, cwd: '/tmp', agentType }));
  await waitFor(() => log.filter((m) => m.type === 'agent' && m.isNew).length === 3);
  for (const m of log.filter((x) => x.type === 'agent' && x.isNew)) ids[m.agent.name] = m.agent;
  assert(ids.Cur.type === 'cursor' && ids.Cla.type === 'claude' && ids.Moc.type === 'mock', 'types assigned (default + explicit)');

  for (const n of ['Cur', 'Cla']) ws.send(JSON.stringify({ type: 'send', id: ids[n].id, text: 'hello ' + n }));
  await waitFor(() => ['Cur', 'Cla'].every((n) => log.some((m) => m.type === 'agent' && m.agent.id === ids[n].id && m.agent.state === 'done')), 20000);
  for (const n of ['Cur', 'Cla']) {
    const states = log.filter((m) => m.type === 'agent' && m.agent.id === ids[n].id).map((m) => m.agent.state + (m.agent.tool ? ':' + m.agent.tool : ''));
    console.log(' ', n, [...new Set(states)].join(' > '));
    assert(states.includes('thinking') && states.some((s) => s.startsWith('working:')) && states.includes('done'), `${n}: thinking -> working(tool) -> done`);
  }
  assert(log.some((m) => m.type === 'msg' && m.msg.role === 'tool' && /^Read: src\/index.js/.test(m.msg.text)), 'cursor tool_call -> "Read: src/index.js"');
  assert(log.some((m) => m.type === 'msg' && m.msg.role === 'tool' && /^Shell: npm test/.test(m.msg.text)), 'cursor tool_call -> "Shell: npm test"');
  assert(log.filter((m) => m.type === 'msg' && m.msg.role === 'assistant' && /fake cursor-agent/.test(m.msg.text)).length >= 1 || log.some((m) => m.type === 'msg_update' && /fake cursor-agent/.test(m.text)), 'cursor reply received');

  // resume continuity
  ws.send(JSON.stringify({ type: 'send', id: ids.Cur.id, text: 'again' }));
  await waitFor(() => log.some((m) => (m.type === 'msg' && /resumed chat-/.test(m.msg.text)) || (m.type === 'msg_update' && /resumed chat-/.test(m.text))), 20000);
  assert(true, 'cursor --resume used on the 2nd message');
  await sleep(300);
  // error path
  ws.send(JSON.stringify({ type: 'send', id: ids.Cla.id, text: 'please fail' }));
  ws.send(JSON.stringify({ type: 'send', id: ids.Moc.id, text: 'mock hi' }));
  await waitFor(() => log.some((m) => m.type === 'agent' && m.agent.id === ids.Cla.id && m.agent.state === 'error'), 20000);
  assert(true, 'claude error -> error state');
  await waitFor(() => log.some((m) => m.type === 'agent' && m.agent.id === ids.Moc.id && m.agent.state === 'done'), 20000);
  assert(true, 'mock agent works alongside');
  ws.send(JSON.stringify({ type: 'send', id: ids.Cur.id, text: 'please fail' }));
  await waitFor(() => log.filter((m) => m.type === 'agent' && m.agent.id === ids.Cur.id && m.agent.state === 'error').length >= 1, 20000);
  assert(true, 'cursor non-zero exit -> error state');
  ws.close(); await sleep(500); srv.kill('SIGTERM'); await sleep(500);

  // persistence of type
  srv = startServer({ HARNESS_MODE: 'mock' }); await sleep(1000);
  ({ ws, snap } = await client());
  const byName = Object.fromEntries(snap.agents.map((a) => [a.name, a.type]));
  assert(snap.defaultType === 'mock' && byName.Cur === 'cursor' && byName.Cla === 'claude' && byName.Moc === 'mock', 'agent types persisted across restart: ' + JSON.stringify(byName));
  ws.close(); srv.kill('SIGTERM');
  try { fs.unlinkSync(DATA); } catch (_) {}
})().catch((e) => { console.error(e); process.exit(1); });
