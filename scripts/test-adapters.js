'use strict';
// Exercises claude / cursor / mock agents through the real server using the stand-in CLIs.
// Usage: node scripts/test-adapters.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { MGR_SLOT, MAX_AGENTS } = require('../lib/harness');
const { makeFakeClaudeDir } = require('./fake-claude-dir');
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

  // ---------- team collaboration: roles, existing people as helpers, inferred peer talk, huddle ----------
  const lastAgent = (id) => log.filter((m) => m.type === 'agent' && m.agent.id === id).at(-1).agent;
  const agentsNow = () => Object.fromEntries([...new Set(log.filter((m) => m.type === 'agent').map((m) => m.agent.id))].map((id) => [id, lastAgent(id)]));
  await waitFor(() => Object.values(agentsNow()).every((a) => a.state === 'idle' || a.state === 'done' || a.state === 'error'), 20000);
  await sleep(4500 + 1500);   // let released helpers from the earlier tests become free again
  mark = log.length;
  const before = new Set(Object.keys(agentsNow()));
  ws.send(JSON.stringify({ type: 'send', id: ids.Cla.id, text: '/code-review the auth change' }));
  await waitFor(() => log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'start').length === 4, 20000);
  const cstarts = log.slice(mark).filter((m) => m.type === 'subagent' && m.op === 'start');
  assert(cstarts.map((m) => m.sub.role).join() === 'security,performance,tests,style', 'roles derived from subagent_type/description: ' + cstarts.map((m) => m.sub.role).join());
  const hids = cstarts.map((m) => m.sub.helperId);
  assert(hids.every(Boolean) && new Set(hids).size === 4 && !hids.includes(ids.Cla.id), 'each helper job is given to a different EXISTING/colleague person (not the lead)');
  const hired = hids.filter((id) => !before.has(id));
  assert(hired.length <= 1 && hired.every((id) => log.some((m) => m.type === 'agent' && m.isNew && m.enter && m.agent.id === id && m.agent.helping)), 'only when nobody was idle a new person is hired (enter=true, already helping): ' + hired.length);
  assert(hids.every((id, i) => { const ag = log.slice(mark).filter((m) => m.type === 'agent' && m.agent.id === id && m.agent.helping).at(0); return ag && ag.agent.helping.parentName === 'Cla' && ag.agent.helping.role === cstarts[i].sub.role; }), 'helpers get a "helping Cla" status with their role');
  // a real user message to a person who is helping waits (queued) until the helper job ends
  ws.send(JSON.stringify({ type: 'send', id: hids[0], text: 'hello helper, when you are free' }));
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === hids[0] && m.agent.queued >= 1 && m.agent.helping), 3000);
  assert(log.slice(mark).filter((m) => m.type === 'agent' && m.agent.id === hids[0] && m.agent.helping).every((m) => m.agent.state === 'idle'), 'helper keeps idle state while helping; user message is queued (queued pill), not run');
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === ids.Cla.id && m.agent.state === 'done'), 30000);
  await waitFor(() => log.slice(mark).some((m) => m.type === 'agent' && m.agent.id === hids[0] && m.agent.state === 'done'), 30000);
  assert(true, 'queued message to the helper runs after the helper job ended');
  const team = log.slice(mark).filter((m) => m.type === 'team' && m.id === ids.Cla.id && m.entry).map((m) => m.entry);
  const kinds = team.map((e) => e.kind);
  assert(kinds[0] === 'plan' && kinds.filter((k) => k === 'handoff').length === 4 && kinds.at(-1) === 'huddle', 'team feed: plan first, 4 handoffs, huddle last: ' + kinds.join());
  assert(team.some((e) => e.kind === 'peer' && e.inferred && /shared (auth|api)\.js/.test(e.text) && e.from.helperId && e.to.helperId), 'inferred peer talk: helpers touching the same file within the window (flagged inferred)');
  assert(team.filter((e) => e.kind === 'peer').length <= 6 && team.filter((e) => e.kind === 'peer').length >= 1, 'peer bubbles are throttled (<= 6 per run): ' + team.filter((e) => e.kind === 'peer').length);
  assert(team.some((e) => e.kind === 'mention' && e.inferred && e.from.role === 'security' && e.to.role === 'tests'), 'inferred letter: security result mentioning tests -> tests helper');
  assert(team.filter((e) => e.kind === 'peer' || e.kind === 'mention').every((e) => e.inferred === true) && team.filter((e) => e.kind === 'handoff' || e.kind === 'plan').every((e) => !e.inferred), 'only the inferred interactions are marked inferred');
  const hand = team.filter((e) => e.kind === 'handoff');
  assert(hand.find((e) => e.from.role === 'security').short === 'found 3 issues' && hand.find((e) => e.from.role === 'style').ok === false, 'handoff carries a short summary ("found 3 issues") and ok flag (style helper failed)');
  assert(/4 reports in, 1 failed/.test(team.at(-1).text), 'huddle summary: ' + team.at(-1).text);
  const sys = log.slice(mark).filter((m) => m.type === 'msg' && m.id === hids[1] && m.msg.role === 'system' && /^helped Cla: Performance analysis/.test(m.msg.text));
  assert(sys.length === 1 && !log.slice(mark).some((m) => m.type === 'msg' && m.id === hids[1] && m.msg.role === 'sub'), "helper's own transcript only gets a 'helped Cla: …' system line (no sub lines)");
  assert(hids.every((id) => lastAgent(id).helping === null), 'helpers are released afterwards (helping=null)');
  assert(log.slice(mark).filter((m) => m.type === 'team' && m.reset).length >= 1, 'team feed resets per run');

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

  // ---------- manager desk (main agent), permission modes, plan mode ----------
  {
    assert(snap.mgrSlot === MGR_SLOT && ids.Cur.main === true && ids.Cur.slot === MGR_SLOT && !ids.Cla.main && !ids.Moc.main && ids.Cla.slot < MGR_SLOT && ids.Moc.slot < MGR_SLOT, `first hire is the main agent and sits at the manager desk (slot ${MGR_SLOT}), the others at regular desks: ` + ['Cur', 'Cla', 'Moc'].map((n) => n + ':' + ids[n].slot).join());
    const latest = (id) => log.filter((m) => m.type === 'agent' && m.agent.id === id).map((m) => m.agent).at(-1);
    const planStates = (id, from) => log.slice(from).filter((m) => m.type === 'agent' && m.agent.id === id).map((m) => m.agent.plan ? m.agent.plan.state : null);
    // claude hired in plan mode -> --permission-mode plan -> init permissionMode 'plan' -> planning, then ExitPlanMode -> ready (+summary), then cleared after the hold
    for (const a of Object.values(agentsNow())) if (![ids.Cur.id, ids.Cla.id, ids.Moc.id].includes(a.id)) ws.send(JSON.stringify({ type: 'fire', id: a.id }));   // make room (helpers were auto-hired)
    await sleep(500);
    let mk = log.length;
    ws.send(JSON.stringify({ type: 'hire', name: 'Pla', cwd: '/tmp', agentType: 'claude', permissionMode: 'plan' }));
    const pla = (await waitFor(() => log.slice(mk).find((m) => m.type === 'agent' && m.isNew && m.agent.name === 'Pla'))).agent;
    assert(pla.permissionMode === 'plan' && !pla.main, 'hire with permissionMode=plan is stored on the agent');
    ws.send(JSON.stringify({ type: 'send', id: pla.id, text: 'add dark mode' }));
    await waitFor(() => planStates(pla.id, mk).includes('ready'), 20000);
    const seq = planStates(pla.id, mk).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    assert(seq[0] === null && seq.includes('planning') && seq.indexOf('planning') < seq.indexOf('ready'), 'claude plan mode: planning -> ready: ' + seq.join('>'));
    const ready = log.slice(mk).map((m) => m.agent).filter((a) => a && a.id === pla.id && a.plan && a.plan.state === 'ready')[0];
    assert(/Plan: add dark mode/.test(ready.plan.summary) && /Read the entry points/.test(ready.plan.summary), 'ExitPlanMode plan text becomes the summary: ' + ready.plan.summary);
    assert(log.slice(mk).some((m) => m.type === 'msg' && m.id === pla.id && m.msg.role === 'system' && /gathering at the round table/.test(m.msg.text)), 'transcript notes the gathering');
    await waitFor(() => latest(pla.id).state === 'done', 10000);
    assert(latest(pla.id).plan && latest(pla.id).plan.state === 'ready', 'the plan check stays up right after the run ends (hold)');
    await waitFor(() => latest(pla.id).plan === null, 15000);
    assert(true, 'plan is cleared after the hold -> everybody walks back');
    // no ExitPlanMode: the result still counts as the plan being ready
    mk = log.length;
    ws.send(JSON.stringify({ type: 'send', id: pla.id, text: 'noexit please' }));
    await waitFor(() => planStates(pla.id, mk).includes('ready'), 20000);
    assert(true, 'plan mode without ExitPlanMode: ready is raised when the run ends');
    await waitFor(() => latest(pla.id).plan === null, 15000);
    // permission toggle + persistence message + mock /plan
    mk = log.length;
    ws.send(JSON.stringify({ type: 'permission', id: ids.Moc.id, mode: 'plan' }));
    await waitFor(() => latest(ids.Moc.id).permissionMode === 'plan');
    ws.send(JSON.stringify({ type: 'permission', id: ids.Moc.id, mode: 'default' }));
    await waitFor(() => latest(ids.Moc.id).permissionMode === 'default');
    ws.send(JSON.stringify({ type: 'permission', id: ids.Moc.id, mode: 'bogus' }));
    await sleep(200);
    assert(latest(ids.Moc.id).permissionMode === 'default', 'permission toggles plan<->default, unknown modes are ignored');
    mk = log.length;
    ws.send(JSON.stringify({ type: 'send', id: ids.Moc.id, text: '/plan add dark mode' }));
    await waitFor(() => planStates(ids.Moc.id, mk).includes('ready'), 30000);
    const mseq = planStates(ids.Moc.id, mk).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    assert(mseq.includes('planning') && mseq.indexOf('planning') < mseq.indexOf('ready'), 'mock /plan: planning -> ready: ' + mseq.join('>'));
    assert(log.slice(mk).some((m) => m.type === 'msg' && m.id === ids.Moc.id && m.msg.role === 'tool' && /^Read/.test(m.msg.text)), 'mock plan mode explores read-only first (Read tool)');
    assert(!log.slice(mk).some((m) => m.type === 'msg' && m.id === ids.Moc.id && m.msg.role === 'tool' && /^(Edit|Write|Bash)/.test(m.msg.text)), 'mock plan mode does not edit or run commands');
    assert(latest(ids.Moc.id).permissionMode === 'default', '/plan is a one-shot plan run (permission mode unchanged)');
    await waitFor(() => latest(ids.Moc.id).plan === null, 25000);
    // promote: swaps desks with the current main
    mk = log.length;
    const before = { moc: latest(ids.Moc.id).slot, cur: latest(ids.Cur.id).slot };
    ws.send(JSON.stringify({ type: 'promote', id: ids.Moc.id }));
    await waitFor(() => latest(ids.Moc.id).main === true);
    await sleep(150);
    assert(latest(ids.Moc.id).slot === MGR_SLOT && latest(ids.Cur.id).slot === before.moc && latest(ids.Cur.id).main === false, `promote: manager desk swapped (Moc ${before.moc}->${MGR_SLOT}, Cur ${MGR_SLOT}->${before.moc})`);
    // fire the main: another agent is promoted automatically
    mk = log.length;
    ws.send(JSON.stringify({ type: 'fire', id: ids.Moc.id }));
    await waitFor(() => log.slice(mk).some((m) => m.type === 'agent' && m.agent.main && m.agent.id !== ids.Moc.id));
    const nm = log.slice(mk).filter((m) => m.type === 'agent' && m.agent.main && m.agent.id !== ids.Moc.id).at(-1).agent;
    assert(nm.slot === MGR_SLOT, 'firing the main agent promotes another one to the manager desk (' + nm.name + ')');
    ws.send(JSON.stringify({ type: 'fire', id: pla.id }));
    await sleep(200);
  }
  ws.close(); await sleep(500); srv.kill('SIGTERM'); await sleep(500);

  // ---------- in-process: office full -> helper job waits; freed person picks it up ----------
  {
    const { Harness } = require('../lib/harness');
    const stub = { defaultType: 'mock', types: { mock: { id: 'mock', label: 'Mock', available: true, adapter: { run() { return { cancel() {} }; } } } } };
    const h = new Harness({ dataFile: path.join(os.tmpdir(), `mai-office-unit-${Date.now()}.json`), registry: stub });
    const names = ['P', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, MAX_AGENTS);
    const ag = names.map((n) => h.hire({ name: n, cwd: '/tmp', agentType: 'mock' }));
    const evs = []; h.on('event', (e) => evs.push(e));
    for (const a of ag.slice(1)) h.send(a.id, 'busy');           // everybody but the lead is working: nobody idle, office full (6 desks + manager desk)
    h.send(ag[0].id, 'lead'); const lead = h.agents.get(ag[0].id);
    h._onEvent(lead, lead.run, { type: 'subagent_start', subId: 's1', label: 'security review', kind: 'security-reviewer' });
    const st = evs.find((e) => e.type === 'subagent' && e.op === 'start');
    assert(st && st.sub.helperId === null && st.sub.role === 'security', 'office full + nobody idle: helper job is pending (no helper yet)');
    assert(evs.some((e) => e.type === 'team' && e.entry && e.entry.kind === 'note' && /waiting for a free colleague/.test(e.entry.text)), 'pending job is shown in the team feed');
    h.interrupt(ag[3].id);                                       // somebody becomes free
    await sleep(100);
    const asg = evs.find((e) => e.type === 'subagent' && e.op === 'assign');
    assert(asg && asg.sub.helperId === ag[3].id && h.agents.get(ag[3].id).helping.parentName === 'P', 'a freed-up person picks up the pending job');
    h._onEvent(lead, lead.run, { type: 'subagent_end', subId: 's1', ok: true, text: 'Found 1 issue' });
    assert(h.agents.get(ag[3].id).helping === null, 'helper released at job end');
    h.shutdown();
  }

  // persistence of type
  srv = startServer({ HARNESS_MODE: 'mock' }); await sleep(1000);
  ({ ws, snap } = await client());
  const byName = Object.fromEntries(snap.agents.map((a) => [a.name, a.type]));
  assert(snap.defaultType === 'mock' && byName.Cur === 'cursor' && byName.Cla === 'claude' && !('Moc' in byName), 'agent types persisted across restart (Moc was fired): ' + JSON.stringify(byName));
  const cur2 = snap.agents.find((a) => a.name === 'Cur'), cla2 = snap.agents.find((a) => a.name === 'Cla');
  assert(cur2.main && cur2.slot === MGR_SLOT && !cla2.main && cla2.slot === 0 && snap.mgrSlot === MGR_SLOT, 'main agent / manager desk persisted across restart: ' + snap.agents.map((a) => a.name + ':' + a.slot + (a.main ? '*' : '')).join());
  ws.close(); srv.kill('SIGTERM'); await sleep(500);
  try { fs.unlinkSync(DATA); } catch (_) {}

  // ---------- old 9-desk data file: manager slot 8 -> MGR_SLOT, overflow kept in a .bak ----------
  {
    const { Harness } = require('../lib/harness');
    const stub = { defaultType: 'mock', types: { mock: { id: 'mock', label: 'Mock', available: true, adapter: { run() { return { cancel() {} }; } } } } };
    const f = path.join(os.tmpdir(), `mai-office-legacy-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ version: 1, agents: Array.from({ length: 9 }, (_, i) => ({ id: 'L' + i, name: 'L' + i, cwd: '/tmp', slot: i, look: {}, type: 'mock', transcript: [] })) }));
    const h = new Harness({ dataFile: f, registry: stub });
    const slots = [...h.agents.values()].map((a) => a.slot).sort((x, y) => x - y);
    assert(h.agents.size === MAX_AGENTS && h.agents.get('L8') && h.agents.get('L8').slot === MGR_SLOT && JSON.stringify(slots) === JSON.stringify([...Array(MAX_AGENTS).keys()]), `legacy file: old manager keeps the manager desk, ${MAX_AGENTS} unique desks: ${slots.join(',')}`);
    assert(fs.existsSync(f + '.bak') && JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).agents.length === 9, 'legacy file with more agents than desks is backed up before trimming');
    h.shutdown();
    for (const x of [f, f + '.bak']) try { fs.unlinkSync(x); } catch (_) {}
  }

  // ---------- local Claude Code sessions: list, history, resume with --resume in the session cwd ----------
  {
    const fake = makeFakeClaudeDir();
    const filesBefore = () => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8'); } }; walk(fake.dir); walk(fake.cursorDir); return JSON.stringify(out); };
    const before = filesBefore();
    srv = startServer({ HARNESS_MODE: 'mock', HARNESS_DATA: DATA + '.sess', HARNESS_CLAUDE_DIR: fake.dir, HARNESS_CURSOR_DIR: fake.cursorDir }); await sleep(1000);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/claude/sessions`), body = await res.json();
    const list = body.sessions || [];
    assert(res.ok && body.dir === fake.dir + '/projects' && list.map((x) => x.id).join() === [fake.ids.rate, fake.ids.tests, fake.ids.blog].join(), 'sessions endpoint lists the 3 real sessions newest first (sidechain + summary-only files skipped)');
    const rate = list.find((x) => x.id === fake.ids.rate), tests = list.find((x) => x.id === fake.ids.tests);
    assert(rate.title === 'Add rate limiting to the checkout API' && rate.cwd === fake.cwds.shop && rate.count === 3, `summary line is the title, cwd comes from the lines, the malformed line is skipped (count ${rate.count})`);
    assert(tests.title === 'Why is the orders test flaky on CI?' && tests.count === 2, 'no summary: the first real user message is the title (meta + /command lines ignored)');
    const bad = await new Promise((resolve) => require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/claude/sessions', headers: { host: 'evil.example:' + PORT } }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert(bad === 403, 'sessions endpoint refuses a non-loopback Host header (DNS rebinding)');

    ({ ws, log } = await client());
    ws.send(JSON.stringify({ type: 'resume', sessionId: fake.ids.rate }));
    const ra = await waitFor(() => log.find((m) => m.type === 'agent' && m.isNew));
    const tx = ra.transcript.map((m) => m.role + ':' + m.text);
    assert(ra.agent.type === 'claude' && ra.agent.cwd === fake.cwds.shop && ra.agent.sessionId === fake.ids.rate && ra.agent.name === 'shop-api', 'resume: a claude agent with the session id and cwd sits at a free desk');
    assert(tx.includes('user:Add rate limiting to POST /checkout, 10 requests a minute per user.') && tx.includes('tool:Read: src/routes/checkout.js') && tx.some((t) => t.startsWith('assistant:Added a token bucket')) && !tx.some((t) => /module.exports = router|broken/.test(t)), 'resume: recent history (user, assistant, tool lines) is in the chat, tool results skipped');
    ws.send(JSON.stringify({ type: 'send', id: ra.agent.id, text: 'carry on' }));
    const reply = await waitFor(() => log.find((m) => (m.type === 'msg' && m.id === ra.agent.id && m.msg.role === 'assistant' && /fake claude/.test(m.msg.text)) || (m.type === 'msg_update' && m.id === ra.agent.id && /fake claude/.test(m.text))), 15000);
    const rt = reply.msg ? reply.msg.text : reply.text;
    assert(rt.includes(`resumed ${fake.ids.rate}, cwd ${fake.cwds.shop}`), 'next message runs claude --resume <id> in the session cwd: ' + rt.slice(0, 120));

    // "/" commands: read-only scan of the fake claude dir, the project folder and the init event
    const cmds = async (id) => (await (await fetch(`http://127.0.0.1:${PORT}/api/agents/${id}/commands`)).json()).commands || [];
    const cl = await cmds(ra.agent.id), by = Object.fromEntries(cl.map((c) => [c.name, c]));
    assert(by['frontend:component'] && by['frontend:component'].source === 'user' && by['frontend:component'].description === 'Scaffold a React component with tests' && by['frontend:component'].hint === '<Name> [--size sm|lg]', 'commands: sub folder -> frontend:component, frontmatter description + argument-hint');
    assert(by['review-pr'] && by['review-pr'].description === 'Review the open pull request for bugs', 'commands: no frontmatter -> first line is the description');
    assert(by.changelog && by.changelog.description === 'Summarize the changelog since the last tag', 'commands: malformed frontmatter -> no fields, body line is the description');
    assert(by['release-notes'] && by['release-notes'].kind === 'skill' && !by['hidden-helper'], 'skills: SKILL.md listed, user-invocable: false hidden');
    assert(by['db:migrate'] && by['db:migrate'].source === 'project' && by['seed-data'] && by['seed-data'].source === 'project', 'project .claude/commands and .claude/skills listed as project');
    assert(by['deploy-kit:ship'] && by['deploy-kit:rollback'] && by['deploy-kit:ship'].source === 'plugin' && !cl.some((c) => /other-repo/.test(c.name)), 'plugins: installed_plugins.json -> deploy-kit:ship / deploy-kit:rollback, other-project installs skipped');
    assert(by.compact && by.compact.source === 'session' && !by.clear && !by.model && by.plan && by.plan.source === 'app', 'init slash_commands merged as session, interactive-only ones (clear, model) dropped, /plan is the office built-in');
    const badc = await new Promise((resolve) => require('http').get({ host: '127.0.0.1', port: PORT, path: `/api/agents/${ra.agent.id}/commands`, headers: { host: 'evil.example:' + PORT } }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert(badc === 403, 'commands endpoint refuses a non-loopback Host header');

    // permission modes: Shift+Tab order, persisted, reaches the CLI as --permission-mode
    const latestA = (id) => log.filter((m) => m.type === 'agent' && m.agent.id === id).map((m) => m.agent).at(-1);
    assert(ra.agent.permissionMode === 'acceptEdits' && ra.agent.modes.join() === 'default,acceptEdits,plan' && rt.includes('mode acceptEdits'), 'claude agents start in acceptEdits and pass --permission-mode acceptEdits: ' + (ra.agent.modes || []).join());
    const replyAfter = async (text, from, re = /fake claude/) => { ws.send(JSON.stringify({ type: 'send', id: ra.agent.id, text })); const r = await waitFor(() => log.slice(from).find((m) => (m.type === 'msg' && m.id === ra.agent.id && m.msg.role === 'assistant' && re.test(m.msg.text)) || (m.type === 'msg_update' && m.id === ra.agent.id && re.test(m.text))), 15000); await waitFor(() => latestA(ra.agent.id).state === 'done', 15000); return r.msg ? r.msg.text : r.text; };
    for (const mode of ['plan', 'default']) {
      ws.send(JSON.stringify({ type: 'permission', id: ra.agent.id, mode }));
      await waitFor(() => latestA(ra.agent.id).permissionMode === mode);
      const t = await replyAfter('next ' + mode, log.length, mode === 'plan' ? /## Plan: next plan/ : /fake claude/);
      assert(mode === 'plan' || t.includes('mode ' + mode), `mode ${mode} -> claude gets --permission-mode ${mode}`);
    }
    ws.send(JSON.stringify({ type: 'permission', id: ra.agent.id, mode: 'bypassPermissions' }));
    await sleep(200);
    assert(latestA(ra.agent.id).permissionMode === 'default', 'bypassPermissions is refused without HARNESS_ALLOW_BYPASS=1');
    const vt = await replyAfter('/frontend:component Button --size lg', log.length);
    assert(vt.includes('You said: /frontend:component Button --size lg'), 'a slash prompt reaches claude -p verbatim: ' + vt.slice(-60));
    ws.send(JSON.stringify({ type: 'permission', id: ra.agent.id, mode: 'acceptEdits' }));
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(DATA + '.sess', 'utf8')).agents.find((x) => x.id === ra.agent.id).permissionMode === 'acceptEdits'; } catch (_) { return false; } }, 5000);
    assert(true, 'the mode is saved per agent in the data file');
    let mk0 = log.length;
    ws.send(JSON.stringify({ type: 'hire', name: 'CurCmd', cwd: fake.cwds.shop, agentType: 'cursor' }));
    const cc = (await waitFor(() => log.slice(mk0).find((m) => m.type === 'agent' && m.isNew && m.agent.name === 'CurCmd'))).agent;
    const cn = (await cmds(cc.id)).map((c) => c.source + ':' + c.name);
    assert(['project:lint', 'user:explain', 'project:api-docs', 'user:tidy-imports', 'user:review-pr', 'project:seed-data', 'app:plan'].every((x) => cn.includes(x)) && !cn.some((x) => /db:migrate|frontend:component|deploy-kit|compact/.test(x)),
      'cursor: .cursor + .claude commands (flat) and skills, project + user; no sub folders, plugins or session names: ' + cn.join());
    assert(cc.modes.join() === 'default,plan,ask' && cc.permissionMode === 'default', 'cursor modes: default, plan, ask (force needs HARNESS_ALLOW_BYPASS=1): ' + cc.modes.join());
    const curReply = async (text, from) => { ws.send(JSON.stringify({ type: 'send', id: cc.id, text })); const r = await waitFor(() => log.slice(from).find((m) => (m.type === 'msg' && m.id === cc.id && m.msg.role === 'assistant' && /fake cursor-agent/.test(m.msg.text)) || (m.type === 'msg_update' && m.id === cc.id && /fake cursor-agent/.test(m.text))), 15000); await waitFor(() => latestA(cc.id).state === 'done', 15000); return r.msg ? r.msg.text : r.text; };
    assert((await curReply('look around', log.length)).includes('default: edits proposed only'), 'cursor default mode passes neither --mode nor --force');
    ws.send(JSON.stringify({ type: 'permission', id: cc.id, mode: 'force' }));
    await sleep(200);
    assert(latestA(cc.id).permissionMode === 'default', 'cursor force (--force) is refused without HARNESS_ALLOW_BYPASS=1');
    for (const mode of ['ask', 'plan']) {
      ws.send(JSON.stringify({ type: 'permission', id: cc.id, mode }));
      await waitFor(() => latestA(cc.id).permissionMode === mode);
      const from = log.length, t = await curReply('next ' + mode, from);
      assert(t.includes('mode ' + mode), `cursor ${mode} mode -> --mode ${mode}: ` + t.slice(0, 90));
      if (mode === 'plan') assert(log.slice(from).some((m) => m.type === 'agent' && m.agent.id === cc.id && m.agent.plan), 'cursor plan mode still starts the round-table gathering');
    }

    // Cursor CLI chats: meta.json + transcript, broken entries skipped, resume with agent --resume in the chat's folder
    const cres = await fetch(`http://127.0.0.1:${PORT}/api/cursor/sessions`), cbody = await cres.json(), cl2 = cbody.sessions || [];
    assert(cres.ok && cbody.dir === fake.cursorDir + '/chats' && cl2.map((x) => x.id).join() === [fake.cursorIds.cart, fake.cursorIds.theme, fake.cursorIds.empty].join(),
      'cursor sessions: 3 chats newest first; broken meta, missing meta, subagent, unused and moved-folder chats skipped: ' + cl2.map((x) => x.title).join(' | '));
    const [cart, theme, empty] = cl2;
    assert(cart.title === 'Fix rounding in cart totals' && cart.cwd === fake.cwds.shop && cart.count === 3, 'cursor: meta.json title + cwd, malformed transcript line skipped (count ' + cart.count + ')');
    assert(theme.title === 'Add a dark theme toggle to the header.' && theme.count === 2, 'cursor: placeholder "New Agent" title -> first question; legacy flat transcript path read');
    assert(empty.hasTranscript === false && empty.count === 0, 'cursor: a chat without a transcript is listed with no history');
    const cbad = await new Promise((resolve) => require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/cursor/sessions', headers: { host: 'evil.example:' + PORT } }, (r) => { r.resume(); resolve(r.statusCode); }));
    assert(cbad === 403, 'cursor sessions endpoint refuses a non-loopback Host header');
    mk0 = log.length;
    ws.send(JSON.stringify({ type: 'resume', sessionId: fake.cursorIds.cart, source: 'cursor' }));
    const cra = await waitFor(() => log.slice(mk0).find((m) => m.type === 'agent' && m.isNew));
    const ctx = cra.transcript.map((m) => m.role + ':' + m.text);
    assert(cra.agent.type === 'cursor' && cra.agent.cwd === fake.cwds.shop && cra.agent.sessionId === fake.cursorIds.cart, 'cursor resume: a cursor agent with the chat id and cwd');
    assert(ctx.includes('user:Cart totals are off by a cent for some coupons. Fix it.') && ctx.includes('tool:Read: src/cart/totals.js') && !ctx.some((t) => /user_info|broken/.test(t)), 'cursor resume: history shown, <user_query> unwrapped, context tags dropped');
    ws.send(JSON.stringify({ type: 'send', id: cra.agent.id, text: 'carry on' }));
    const crr = await waitFor(() => log.find((m) => (m.type === 'msg' && m.id === cra.agent.id && m.msg.role === 'assistant' && /fake cursor-agent/.test(m.msg.text)) || (m.type === 'msg_update' && m.id === cra.agent.id && /fake cursor-agent/.test(m.text))), 15000);
    const crt = crr.msg ? crr.msg.text : crr.text;
    assert(crt.includes(`resumed ${fake.cursorIds.cart}`) && crt.includes(`cwd ${fake.cwds.shop}`), 'next message runs agent --resume <id> in the chat folder (the fake looks it up under md5(cwd)): ' + crt.slice(0, 120));
    ws.send(JSON.stringify({ type: 'resume', sessionId: fake.cursorIds.cart, source: 'cursor' }));
    await waitFor(() => log.some((m) => m.type === 'error' && /already has this session open/.test(m.message) && /shop-api/.test(m.message)), 5000);
    assert(true, 'resuming an open Cursor chat again points at its agent');
    ws.send(JSON.stringify({ type: 'fire', id: cra.agent.id }));
    await waitFor(() => log.some((m) => m.type === 'removed' && m.id === cra.agent.id), 5000);
    ws.send(JSON.stringify({ type: 'fire', id: cc.id }));
    ws.send(JSON.stringify({ type: 'resume', sessionId: fake.ids.rate }));
    await waitFor(() => log.some((m) => m.type === 'error' && /already has this session open/.test(m.message)), 5000);
    assert(true, 'resuming the same session twice points at the agent that has it');
    ws.send(JSON.stringify({ type: 'resume', sessionId: '../../etc/passwd' }));
    await waitFor(() => log.some((m) => m.type === 'error' && /not found/.test(m.message)), 5000);
    assert(true, 'unknown / malformed session ids are rejected');
    await waitFor(() => log.some((m) => m.type === 'removed' && m.id === cc.id), 5000);
    mk0 = log.length;
    for (let i = 1; i < MAX_AGENTS; i++) ws.send(JSON.stringify({ type: 'hire', name: 'F' + i, cwd: '/tmp', agentType: 'mock' }));
    await waitFor(() => log.slice(mk0).filter((m) => m.type === 'agent' && m.isNew).length === MAX_AGENTS - 1);
    ws.send(JSON.stringify({ type: 'resume', sessionId: fake.ids.blog }));
    const full = await waitFor(() => log.find((m) => m.type === 'error' && /office is full/.test(m.message)), 5000);
    assert(/Fire someone/.test(full.message), 'full office: resume gives a clear message: ' + full.message);
    assert(filesBefore() === before, 'the Claude folder is untouched (read-only)');
    ws.close(); srv.kill('SIGTERM');
    for (const x of [DATA + '.sess']) try { fs.unlinkSync(x); } catch (_) {}
    fs.rmSync(fake.base, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
