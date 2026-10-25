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
    assert(snap.mgrSlot === 8 && ids.Cur.main === true && ids.Cur.slot === 8 && !ids.Cla.main && !ids.Moc.main && ids.Cla.slot < 8 && ids.Moc.slot < 8, 'first hire is the main agent and sits at the manager desk (slot 8), the others at regular desks: ' + ['Cur', 'Cla', 'Moc'].map((n) => n + ':' + ids[n].slot).join());
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
    assert(latest(ids.Moc.id).slot === 8 && latest(ids.Cur.id).slot === before.moc && latest(ids.Cur.id).main === false, `promote: manager desk swapped (Moc ${before.moc}->8, Cur 8->${before.moc})`);
    // fire the main: another agent is promoted automatically
    mk = log.length;
    ws.send(JSON.stringify({ type: 'fire', id: ids.Moc.id }));
    await waitFor(() => log.slice(mk).some((m) => m.type === 'agent' && m.agent.main && m.agent.id !== ids.Moc.id));
    const nm = log.slice(mk).filter((m) => m.type === 'agent' && m.agent.main && m.agent.id !== ids.Moc.id).at(-1).agent;
    assert(nm.slot === 8, 'firing the main agent promotes another one to the manager desk (' + nm.name + ')');
    ws.send(JSON.stringify({ type: 'fire', id: pla.id }));
    await sleep(200);
  }
  ws.close(); await sleep(500); srv.kill('SIGTERM'); await sleep(500);

  // ---------- in-process: office full -> helper job waits; freed person picks it up ----------
  {
    const { Harness } = require('../lib/harness');
    const stub = { defaultType: 'mock', types: { mock: { id: 'mock', label: 'Mock', available: true, adapter: { run() { return { cancel() {} }; } } } } };
    const h = new Harness({ dataFile: path.join(os.tmpdir(), `mai-office-unit-${Date.now()}.json`), registry: stub });
    const names = ['P', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const ag = names.map((n) => h.hire({ name: n, cwd: '/tmp', agentType: 'mock' }));
    const evs = []; h.on('event', (e) => evs.push(e));
    for (const a of ag.slice(1)) h.send(a.id, 'busy');           // everybody but the lead is working: nobody idle, office full (8 desks + manager desk = 9)
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
  assert(cur2.main && cur2.slot === 8 && !cla2.main && cla2.slot === 0 && snap.mgrSlot === 8, 'main agent / manager desk persisted across restart: ' + snap.agents.map((a) => a.name + ':' + a.slot + (a.main ? '*' : '')).join());
  ws.close(); srv.kill('SIGTERM');
  try { fs.unlinkSync(DATA); } catch (_) {}
})().catch((e) => { console.error(e); process.exit(1); });
