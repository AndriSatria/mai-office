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
const DATA = path.join(os.tmpdir(), `mai-office-adapters-${Date.now()}.json`);
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

  // ---------- subagents / helpers ----------
  const subEvents = (id, op) => log.filter((m) => m.type === 'subagent' && m.id === id && (!op || m.op === op));
  // claude: 3 parallel Task tool_use blocks, activity tagged with parent_tool_use_id, tool_results end them (one is_error)
  let mark = log.length;
  ws.send(JSON.stringify({ type: 'send', id: ids.Cla.id, text: 'run these in parallel team' }));
  await waitFor(() => subEvents(ids.Cla.id, 'end').length >= 3, 20000);
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === ids.Cla.id && m.agent.state === 'done'), 20000);
  let ev = log.slice(mark).filter((m) => m.type === 'subagent' && m.id === ids.Cla.id);
  const starts = ev.filter((m) => m.op === 'start'), firstEnd = ev.findIndex((m) => m.op === 'end');
  assert(starts.length === 3 && starts.map((m) => m.sub.label).join() === 'explore repo,run tests,review diff', 'claude: 3 Task tool_use blocks -> 3 subagent_start with labels');
  assert(starts[0].sub.kind === 'Explore' && starts[2].sub.kind === 'code-reviewer', 'claude: subagent_type becomes the helper kind');
  assert(ev.findIndex((m) => m.op === 'end') > ev.map((m) => m.op).lastIndexOf('start'), 'claude: helpers run concurrently (all started before the first ended)');
  const acts = ev.filter((m) => m.op === 'activity');
  assert(acts.length >= 5 && acts.every((m) => starts.some((s) => s.sub.subId === m.sub.subId)) && acts.some((m) => m.sub.tool === 'Glob') && acts.some((m) => m.sub.tool === 'Bash'), 'claude: parent_tool_use_id events -> subagent_activity of the right helper (' + acts.length + ')');
  assert(ev.filter((m) => m.op === 'end').length === 3 && ev.filter((m) => m.op === 'end').every((m) => m.sub.ok), 'claude: matching tool_results -> subagent_end ok');
  const parentTools = log.slice(mark).filter((m) => m.type === 'msg' && m.id === ids.Cla.id && m.msg.role === 'tool');
  assert(parentTools.length === 0, 'claude: helper tool calls and Task itself are not parent tool lines');
  const parentStates = log.slice(mark).filter((m) => m.type === 'agent' && m.agent.id === ids.Cla.id).map((m) => m.agent.state + (m.agent.tool ? ':' + m.agent.tool : ''));
  assert(parentStates.includes('working:Task') && parentStates.at(-1) === 'done', 'claude: parent shows working:Task while helpers run, then done');
  assert(log.slice(mark).filter((m) => m.type === 'agent' && m.agent.id === ids.Cla.id).some((m) => m.agent.subs.length === 3) && log.slice(mark).filter((m) => m.type === 'agent' && m.agent.id === ids.Cla.id).at(-1).agent.subs.length === 0, 'agent snapshot lists running helpers (3) and is empty afterwards');
  assert(!log.slice(mark).some((m) => (m.type === 'msg' && /SUBAGENT-NOISE/.test(m.msg.text)) || (m.type === 'msg_update' && /SUBAGENT-NOISE/.test(m.text))), 'claude: subagent partial text is not mixed into the parent reply');
  const subLines = log.slice(mark).filter((m) => m.type === 'msg' && m.id === ids.Cla.id && m.msg.role === 'sub');
  const lastUpd = (mid) => log.slice(mark).filter((m) => m.type === 'sub_update' && m.mid === mid).at(-1);
  assert(subLines.length === 3 && subLines.every((m) => lastUpd(m.msg.mid).sub.status === 'finished') && lastUpd(subLines[0].msg.mid).sub.log.length >= 2 && /explored: 12 files/.test(lastUpd(subLines[0].msg.mid).sub.result), 'transcript: one expandable "sub" line per helper with its log + result');
  // failing helper
  mark = log.length;
  ws.send(JSON.stringify({ type: 'send', id: ids.Cla.id, text: 'parallel team, this one should fail' }));
  await waitFor(() => log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'end').length >= 3, 20000);
  const ends = log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'end');
  assert(ends.filter((m) => !m.sub.ok).length === 1 && ends.filter((m) => m.sub.ok).length === 2, 'claude: tool_result with is_error -> subagent_end ok:false (1 of 3)');
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === ids.Cla.id && m.agent.state === 'done'), 20000);

  // cursor (best effort stream shape): two task tool_calls
  mark = log.length;
  ws.send(JSON.stringify({ type: 'send', id: ids.Cur.id, text: 'team parallel please' }));
  await waitFor(() => log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'end').length >= 2, 20000);
  assert(log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'start').map((m) => m.sub.label).join() === 'explore repo,run tests', 'cursor: taskToolCall started/completed -> subagent_start/end (best effort)');
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === ids.Cur.id && m.agent.state === 'done'), 20000);

  // mock: /team spawns 3 parallel helpers with activity
  mark = log.length;
  ws.send(JSON.stringify({ type: 'send', id: ids.Moc.id, text: '/team tidy the repo' }));
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === ids.Moc.id && m.agent.state === 'done'), 30000);
  ev = log.slice(mark).filter((m) => m.type === 'subagent' && m.id === ids.Moc.id);
  assert(ev.filter((m) => m.op === 'start').length === 3 && ev.filter((m) => m.op === 'end').length === 3 && ev.filter((m) => m.op === 'activity').length >= 5, 'mock: /team -> 3 parallel helpers with activity and results');
  assert(ev.map((m) => m.op).indexOf('end') > ev.map((m) => m.op).lastIndexOf('start'), 'mock: helpers overlap in time');
  // interrupt closes running helpers
  mark = log.length;
  ws.send(JSON.stringify({ type: 'send', id: ids.Moc.id, text: '/team stop me halfway' }));
  await waitFor(() => log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'start').length >= 2, 10000);
  ws.send(JSON.stringify({ type: 'interrupt', id: ids.Moc.id }));
  await waitFor(() => log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'end').length >= 2, 5000);
  await sleep(300);
  assert(log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'end').every((m) => !m.sub.ok) && log.slice(mark).filter((m) => m.type === 'agent' && m.agent.id === ids.Moc.id).at(-1).agent.subs.length === 0, 'interrupt ends running helpers (ok:false) and clears the list');

  // agent-to-agent message
  mark = log.length;
  ws.send(JSON.stringify({ type: 'relay', from: ids.Moc.id, to: ids.Cur.id, text: 'can you review my diff?' }));
  await waitFor(() => log.slice(mark).some((m) => m.type === 'msg' && m.id === ids.Cur.id && m.msg.role === 'user' && m.msg.text === '[from Moc] can you review my diff?'), 5000);
  assert(log.slice(mark).some((m) => m.type === 'relay' && m.from === ids.Moc.id && m.to === ids.Cur.id), 'relay: visual relay event emitted for both agents');
  assert(log.slice(mark).some((m) => m.type === 'msg' && m.id === ids.Moc.id && m.msg.role === 'system' && /Sent to Cur/.test(m.msg.text)), 'relay: sender transcript notes "Sent to Cur"');
  ws.send(JSON.stringify({ type: 'relay', from: ids.Moc.id, to: ids.Moc.id, text: 'self' }));
  await waitFor(() => log.slice(mark).some((m) => m.type === 'error' && /different agent/.test(m.message)), 5000);
  assert(true, 'relay: sending to yourself is rejected');
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === ids.Cur.id && m.agent.state === 'done'), 20000);
  ws.close(); await sleep(500); srv.kill('SIGTERM'); await sleep(500);

  // persistence of type
  srv = startServer({ HARNESS_MODE: 'mock' }); await sleep(1000);
  ({ ws, snap } = await client());
  const byName = Object.fromEntries(snap.agents.map((a) => [a.name, a.type]));
  assert(snap.defaultType === 'mock' && byName.Cur === 'cursor' && byName.Cla === 'claude' && byName.Moc === 'mock', 'agent types persisted across restart: ' + JSON.stringify(byName));
  ws.close(); srv.kill('SIGTERM');
  try { fs.unlinkSync(DATA); } catch (_) {}
})().catch((e) => { console.error(e); process.exit(1); });
