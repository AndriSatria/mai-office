'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { deriveRole, targetOf, shortSummary, mentionedRoles, planSummary } = require('./roles');
const claudeSessions = require('./claude-sessions');
const cursorSessions = require('./cursor-sessions');
const SESSION_SOURCES = { claude: { mod: claudeSessions, label: 'Claude Code session', cmd: 'claude --resume' }, cursor: { mod: cursorSessions, label: 'Cursor CLI chat', cmd: 'agent --resume' } };
const slashCommands = require('./slash-commands');

const MGR_SLOT = 6;              // the manager desk (main agent); slots 0-5 are the regular desks
const MAX_AGENTS = 7;            // 6 regular desks + the manager desk
const HISTORY_MAX = 40;          // messages shown from a resumed Claude Code session
const MAX_TRANSCRIPT = 300;
const DONE_HOLD_MS = 4500 * Math.max(0.2, +process.env.HARNESS_SLOW || 1);       // how long the "done" celebration state lasts
// demo pacing: HARNESS_SLOW=2 stretches the helper release / inference timers (the mock adapter reads the same variable)
const SLOW = Math.max(0.2, +process.env.HARNESS_SLOW || 1);
const PLAN_HOLD_MS = 6000 * SLOW;  // the "plan ready" check stays up this long after the plan-mode run ends, then everybody walks back
// Shift+Tab order, as in the Claude Code CLI; bypassPermissions only when the owner opts in
// Cursor print mode (agent --help): no flag only proposes edits, --force applies them and runs commands, --mode plan|ask are read-only
const bypassOk = () => process.env.HARNESS_ALLOW_BYPASS === '1';
const modesFor = (type) => type === 'cursor' ? ['default'].concat(bypassOk() ? ['force'] : [], ['plan', 'ask'])
  : ['default', 'acceptEdits', 'plan'].concat(bypassOk() ? ['bypassPermissions'] : []);
// new agents start in HARNESS_PERMISSION_MODE; headless Claude can't ask, so acceptEdits unless told otherwise
const defaultMode = (type) => { const m = modesFor(type), e = process.env.HARNESS_PERMISSION_MODE; return m.includes(e) ? e : m.includes('acceptEdits') ? 'acceptEdits' : 'default'; };
const MODE_LABEL = { default: 'Default mode', acceptEdits: 'Accept edits', plan: 'Plan mode', bypassPermissions: 'Bypass permissions', force: 'Run everything (--force)', ask: 'Ask mode (read-only answers)' };
const FREE_MS = 6000 * SLOW;     // a released helper is not handed new work while it is still walking back
const HOLD_MS = 2200 * SLOW;     // messages typed to a helper wait this long after its job ends (handoff animation)
const PEER_WINDOW = 25000 * SLOW, PEER_PAIR_GAP = 12000 * SLOW, PEER_GAP = 5000 * SLOW, PEER_MAX = 6;
const AUTO_NAMES = ['Bo', 'Cy', 'Di', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lou', 'Mia'];

const SHIRTS = ['#e5484d', '#3e8ef7', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#ff7b00'];
const HAIRS = ['#2b1d14', '#6b3f1d', '#d9a441', '#1c1c24', '#a23b2a', '#8a8f98', '#3c2a6e', '#0f4c5c'];
const SKINS = ['#f1c9a0', '#e0a97a', '#c68b5c', '#8d5a3b', '#f6d6b8'];
const STYLES = ['short', 'long', 'spiky', 'bun', 'cap'];
const PANTS = ['#2f3b52', '#3b3b3b', '#4a3b2f', '#27483f'];

const pick = (arr, n) => arr[n % arr.length];
const rnd = (n) => Math.floor(Math.random() * n);

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

class Harness extends EventEmitter {
  constructor({ dataFile, registry }) {
    super();
    this.dataFile = dataFile;
    this.registry = registry;
    this.agents = new Map();
    this._saveTimer = null;
    this._load();
  }

  get defaultCwd() { return process.env.HARNESS_DEFAULT_CWD || process.cwd(); }

  // ---------- persistence ----------
  _load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')); } catch (_) { return; }
    let list = ((raw && raw.agents) || []).filter((a) => a && a.id && a.name);
    // version 1 files had 8 desks with the manager at slot 8
    if (!(raw && raw.version >= 2)) for (const a of list) a.slot = a.slot === 8 ? MGR_SLOT : a.slot >= MGR_SLOT ? null : a.slot;
    if (list.length > MAX_AGENTS) {
      const bak = this.dataFile + '.bak';
      try { fs.copyFileSync(this.dataFile, bak); } catch (_) {}
      list = list.filter((a) => a.slot === MGR_SLOT).concat(list.filter((a) => a.slot !== MGR_SLOT));
      console.warn(`The office has ${MAX_AGENTS} desks: kept ${list.slice(0, MAX_AGENTS).map((a) => a.name).join(', ')}; left out ${list.slice(MAX_AGENTS).map((a) => a.name).join(', ')} (full copy in ${bak}).`);
      list = list.slice(0, MAX_AGENTS);
    }
    for (const a of list) {
      const type = this.registry.types[a.type] ? a.type : this.registry.defaultType;
      // before version 3 'default' meant "HARNESS_PERMISSION_MODE or acceptEdits" for Claude
      const mode = !(raw && raw.version >= 3) && a.permissionMode !== 'plan' ? defaultMode(type) : a.permissionMode;
      this.agents.set(a.id, this._runtime({
        id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look,
        type, sessionId: a.sessionId || null, transcript: Array.isArray(a.transcript) ? a.transcript : [],
        permissionMode: modesFor(type).includes(mode) ? mode : defaultMode(type),
        sessionCommands: Array.isArray(a.sessionCommands) ? a.sessionCommands.slice(0, 200).map(String) : [],
      }));
    }
    // old data files: fix invalid / duplicate slots, then make sure somebody sits at the manager desk (the first hired agent)
    const seen = new Set();
    for (const a of this.agents.values()) {
      if (!Number.isInteger(a.slot) || a.slot < 0 || a.slot > MGR_SLOT || seen.has(a.slot)) { let n = 0; while (seen.has(n) && n < MGR_SLOT) n++; a.slot = n; }
      seen.add(a.slot);
    }
    this._ensureMain();
  }

  /** invariant: whenever anybody works here, the manager desk (MGR_SLOT) is taken. The first hired agent (map order) becomes main by default. */
  _ensureMain() {
    if (!this.agents.size || [...this.agents.values()].some((a) => a.slot === MGR_SLOT)) return null;
    const a = this.agents.values().next().value;
    a.slot = MGR_SLOT;
    return a;
  }

  get main() { return [...this.agents.values()].find((a) => a.slot === MGR_SLOT) || null; }

  /** promote an agent to main: it takes the manager desk, the current main takes its desk */
  setMain(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    if (a.slot === MGR_SLOT) return a;
    const cur = this.main, old = a.slot;
    a.slot = MGR_SLOT; if (cur) cur.slot = old;
    this._addMsg(a, 'system', `${a.name} is now the main agent (manager desk).`);
    if (cur) this._addMsg(cur, 'system', `${a.name} took over as main agent; ${cur.name} moved to a regular desk.`);
    this.saveNow();
    if (cur) this._emitAgent(cur);
    this.emit('event', { type: 'agent', agent: this.pub(a), promoted: true, prevMainId: cur ? cur.id : null });
    return a;
  }

  /** the --permission-mode for this agent's next runs (plan also gathers the team at the round table) */
  setPermissionMode(id, mode) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    if (!modesFor(a.type).includes(mode)) throw new Error(`Unknown permission mode "${mode}".`);
    if (a.permissionMode === mode) return a;
    a.permissionMode = mode;
    this._addMsg(a, 'system', mode === 'plan' ? 'Plan mode on: runs start in plan mode (the team gathers at the round table).' : `${MODE_LABEL[mode]} on.`);
    this._save(); this._emitAgent(a);
    return a;
  }

  /** "/" commands this agent can run (read-only scan of its command / skill folders) */
  commands(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    return slashCommands.listFor(a);
  }

  _runtime(a) {
    a.state = 'idle'; a.tool = null; a.toolSummary = null;
    a.queue = []; a.run = null; a.curAsst = null; a.runHadText = false; a.doneTimer = null;
    a.subs = new Map();   // subId -> running helper (subagent) of this agent's current run
    a.teamSubs = new Map(); a.team = []; a.teamRun = { planned: false, total: 0, ok: 0, failed: 0, peers: 0, lastPeer: 0, pairs: new Map() };
    a.helping = null;     // {parentId, parentName, subId, label, role, kind}: this person is currently helping a colleague's run
    a.helpCount = 0; a.freeAt = 0; a._hold = false;
    a.permissionMode = modesFor(a.type).includes(a.permissionMode) ? a.permissionMode : defaultMode(a.type);
    a.sessionCommands = a.sessionCommands || [];
    a.plan = null; a._planTimer = null;   // {state:'planning'|'ready', summary}: the agent is in plan mode -> everybody idle gathers at the round table
    for (const m of a.transcript) if (m.sub && m.sub.status === 'running') m.sub.status = 'lost'; // process died with the server
    a.nextMid = a.transcript.reduce((m, x) => Math.max(m, x.mid + 1), 1);
    return a;
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    const data = {
      version: 3,
      agents: [...this.agents.values()].map((a) => ({
        id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look, type: a.type, sessionId: a.sessionId, permissionMode: a.permissionMode, sessionCommands: a.sessionCommands,
        transcript: a.transcript.slice(-MAX_TRANSCRIPT),
      })),
    };
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const tmp = this.dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.dataFile);
    } catch (e) { console.error('Failed to persist agents:', e.message); }
  }

  // ---------- views ----------
  pub(a) {
    return {
      id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look, type: a.type,
      state: a.state, tool: a.tool, toolSummary: a.toolSummary, queued: a.queue.length,
      hasSession: !!a.sessionId, sessionId: a.sessionId || null,
      subs: [...a.subs.values()].map((x) => ({ subId: x.subId, label: x.label, kind: x.kind, role: x.role, tool: x.tool, summary: x.summary, helperId: x.helperId || null })),
      helping: a.helping, autoHired: !!a.autoHired,
      main: a.slot === MGR_SLOT, permissionMode: a.permissionMode, modes: modesFor(a.type), plan: a.plan,
    };
  }

  snapshot() {
    return {
      type: 'snapshot', mode: this.registry.defaultType, defaultType: this.registry.defaultType,
      types: Object.values(this.registry.types).map((t) => ({ id: t.id, label: t.label, available: t.available })), maxAgents: MAX_AGENTS, mgrSlot: MGR_SLOT, defaultCwd: this.defaultCwd,
      agents: [...this.agents.values()].map((a) => ({ ...this.pub(a), transcript: a.transcript, team: a.team })),
    };
  }

  _emitAgent(a) { this.emit('event', { type: 'agent', agent: this.pub(a) }); }

  _addMsg(a, role, text, extra) {
    const msg = { mid: a.nextMid++, role, text, ts: Date.now(), ...(extra || {}) };
    a.transcript.push(msg);
    if (a.transcript.length > MAX_TRANSCRIPT * 1.2) a.transcript.splice(0, a.transcript.length - MAX_TRANSCRIPT);
    this.emit('event', { type: 'msg', id: a.id, msg });
    this._save();
    return msg;
  }

  _setMsgText(a, msg, text) {
    msg.text = text;
    this.emit('event', { type: 'msg_update', id: a.id, mid: msg.mid, text });
    this._save();
  }

  // ---------- state machine ----------
  // idle -> thinking -> (working <-> thinking)* -> done -> idle ; any -> error
  _setState(a, state, tool = null, toolSummary = null) {
    if (a.state === state && a.tool === tool && a.toolSummary === toolSummary) return;
    a.state = state; a.tool = tool; a.toolSummary = toolSummary;
    this._emitAgent(a);
    if ((state === 'idle' || state === 'done') && this._pending && this._pending.length) setImmediate(() => this._assignPending());
  }

  // ---------- commands ----------
  hire({ name, cwd, agentType, permissionMode, slot: wantSlot }, opts) {
    opts = opts || {};
    const type = agentType || this.registry.defaultType;
    if (!this.registry.types[type]) throw new Error(`Unknown agent type "${type}".`);
    if (this.agents.size >= MAX_AGENTS) throw new Error(`The office is full (${MAX_AGENTS} desks). Fire someone first.`);
    name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
    if (!name) throw new Error('Agent needs a name.');
    if ([...this.agents.values()].some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already an agent called "${name}".`);
    const dir = path.resolve(expandHome(String(cwd || '').trim() || this.defaultCwd));
    let st;
    try { st = fs.statSync(dir); } catch (_) { throw new Error(`Working directory does not exist: ${dir}`); }
    if (!st.isDirectory()) throw new Error(`Not a directory: ${dir}`);

    const taken = new Set([...this.agents.values()].map((a) => a.slot));
    // the first hired agent becomes the main agent (manager desk); everybody else gets a regular desk (the clicked empty desk when given)
    let slot;
    if (!taken.has(MGR_SLOT) && !opts.auto) slot = MGR_SLOT;
    else if (Number.isInteger(wantSlot) && wantSlot >= 0 && wantSlot < MGR_SLOT && !taken.has(wantSlot)) slot = wantSlot;
    else { slot = 0; while (taken.has(slot)) slot++; if (slot >= MGR_SLOT) { if (!taken.has(MGR_SLOT)) slot = MGR_SLOT; else throw new Error('No free desk.'); } }
    const used = [...this.agents.values()].map((a) => a.look.shirt);
    const shirt = SHIRTS.find((s) => !used.includes(s)) || pick(SHIRTS, rnd(99));
    const look = {
      shirt, hair: pick(HAIRS, rnd(99)), hairStyle: pick(STYLES, slot + rnd(2) * 2 + 1),
      skin: pick(SKINS, rnd(99)), pants: pick(PANTS, rnd(99)),
    };
    let id;   // hires in the same millisecond used to collide and silently replace an agent
    do id = 'a' + Date.now().toString(36) + rnd(1296).toString(36).padStart(2, '0'); while (this.agents.has(id));
    const a = this._runtime({ id, name, cwd: dir, slot, look, type, sessionId: null, transcript: [], permissionMode: modesFor(type).includes(permissionMode) ? permissionMode : defaultMode(type) });
    this.agents.set(id, a);
    const t = this.registry.types[type];
    this._addMsg(a, 'system', `${name} (${t.label}) joined the office. Working directory: ${dir}${t.available ? '' : `\nWarning: the ${t.label} CLI was not found on PATH; messages will fail until it is installed (or set HARNESS_${type.toUpperCase()}_BIN).`}`);
    if (opts.sessionId) {
      a.sessionId = opts.sessionId;
      for (const m of opts.history || []) this._addMsg(a, m.role, m.text, { ts: m.ts || Date.now() });
      this._addMsg(a, 'system', opts.resumeNote);
    }
    if (opts.auto) { a.autoHired = true; a.helping = opts.helping || null; if (a.helping) a.helpCount++; this._addMsg(a, 'system', `Hired automatically to help ${(opts.helping && opts.helping.parentName) || 'a colleague'} (no idle colleague was free).`); }
    this._save();
    this.emit('event', { type: 'agent', agent: this.pub(a), transcript: a.transcript, isNew: true, enter: !!opts.auto });
    return a;
  }

  /** a local Claude Code session or Cursor CLI chat -> an agent at a free desk; its next message resumes it in the session's cwd */
  resume(sessionId, source = 'claude') {
    const src = SESSION_SOURCES[source];
    if (!src) throw new Error('Unknown session source.');
    const open = [...this.agents.values()].find((a) => a.sessionId && a.sessionId === sessionId);
    if (open) throw new Error(`${open.name} already has this session open.`);
    if (this.agents.size >= MAX_AGENTS) throw new Error(`The office is full (${MAX_AGENTS} desks). Fire someone to resume this session.`);
    const s = src.mod.findSession(sessionId);
    if (!s) throw new Error(`That ${src.label} was not found.`);
    const taken = new Set([...this.agents.values()].map((a) => a.name.toLowerCase()));
    const base = (path.basename(s.cwd) || source).slice(0, 20);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    const history = s.msgs.slice(-HISTORY_MAX);
    const shown = s.msgs.length > history.length ? ` (last ${history.length} of ${s.msgs.length} entries shown)` : s.msgs.length ? '' : ' (no local transcript to show)';
    const note = `Resumed ${src.label} ${s.id}${shown}. Your next message continues it with ${src.cmd} in ${s.cwd}.`;
    return this.hire({ name, cwd: s.cwd, agentType: source }, { sessionId: s.id, history, resumeNote: note });
  }

  fire(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    if (a.run) a.run.cancel();
    clearTimeout(a.doneTimer);
    a.run = null; a.queue = [];
    this._closeSubs(a, false);
    clearTimeout(a._planTimer);
    this.agents.delete(id);
    const np = this._ensureMain();      // the main agent left: the longest-serving colleague takes over the manager desk
    this._pending = (this._pending || []).filter((q) => q.parentId !== id);
    this.saveNow();
    this.emit('event', { type: 'removed', id });
    if (np) { this._addMsg(np, 'system', `${np.name} is now the main agent (manager desk).`); this.emit('event', { type: 'agent', agent: this.pub(np), promoted: true, prevMainId: null }); }
  }

  send(id, text) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    text = String(text || '').trim();
    if (!text) return;
    if (text.length > 20000) throw new Error('Message too long.');
    this._addMsg(a, 'user', text);
    if (a.run || a._pendingNext || a.helping || a._hold) {   // busy, or helping a colleague: wait (queued pill) until that job ends
      a.queue.push(text);
      this._emitAgent(a);
    } else {
      this._start(a, text);
    }
  }

  interrupt(id) {
    const a = this.agents.get(id);
    if (!a || !a.run) return;
    a.run.cancel();
    a.run = null; a.queue = []; a.curAsst = null;
    this._closeSubs(a, false);
    this._planClear(a);
    this._addMsg(a, 'system', 'Interrupted.');
    this._setState(a, 'idle');
  }

  _start(a, text) {
    clearTimeout(a.doneTimer);
    a.curAsst = null; a.runHadText = false;
    a.team = []; a.teamSubs = new Map(); a.teamRun = { planned: false, total: 0, ok: 0, failed: 0, peers: 0, lastPeer: 0, pairs: new Map() };
    this.emit('event', { type: 'team', id: a.id, reset: true });
    this._setState(a, 'thinking');
    this._planClear(a);
    // "/plan <task>" = one plan-mode run (any agent type); otherwise the agent's own permission mode decides
    let mode = a.permissionMode, runText = text;
    const pm = /^\/plan\b\s*([\s\S]*)$/i.exec(text);
    if (pm) { mode = 'plan'; runText = pm[1].trim() || 'Plan the next steps for this project.'; }
    const token = { cancel() {} };
    a.run = token;
    const handle = (this.registry.types[a.type] || this.registry.types[this.registry.defaultType]).adapter.run({
      agent: { id: a.id, name: a.name, cwd: a.cwd, sessionId: a.sessionId, permissionMode: mode },
      text: runText,
      emit: (ev) => { if (a.run === token) this._onEvent(a, token, ev); },
    });
    token.cancel = handle.cancel;
  }

  _endRun(a, delay) {
    a.run = null; a.curAsst = null;
    if (a.queue.length) {
      a._pendingNext = true;
      setTimeout(() => {
        a._pendingNext = false;
        if (!this.agents.has(a.id) || a.run) return;
        const next = a.queue.shift();
        if (next !== undefined) this._start(a, next);
      }, delay);
    }
  }

  _onEvent(a, token, ev) {
    switch (ev.type) {
      case 'session':
        if (ev.id !== a.sessionId) { a.sessionId = ev.id; this._save(); this._emitAgent(a); }
        break;
      case 'commands':
        a.sessionCommands = (ev.names || []).slice(0, 200).map(String); this._save();
        break;
      case 'state':
        this._setState(a, ev.state, ev.tool || null, ev.summary || null);
        break;
      case 'assistant_delta': {
        if (!ev.text) break;
        a.runHadText = true;
        if (!a.curAsst) a.curAsst = this._addMsg(a, 'assistant', '', { streaming: true });
        this._setMsgText(a, a.curAsst, a.curAsst.text + ev.text);
        if (a.state === 'thinking') this._setState(a, 'working');
        break;
      }
      case 'assistant_text': {
        if (!ev.text) break;
        a.runHadText = true;
        if (a.curAsst) { this._setMsgText(a, a.curAsst, ev.text); delete a.curAsst.streaming; }
        else this._addMsg(a, 'assistant', ev.text);
        a.curAsst = null;
        if (a.state === 'thinking') this._setState(a, 'working');
        break;
      }
      case 'tool':
        a.curAsst = null;
        this._addMsg(a, 'tool', `${ev.name}${ev.summary ? ': ' + ev.summary : ''}`, { tool: ev.name });
        this._setState(a, 'working', ev.name, ev.summary || null);
        break;
      case 'tool_result':
        this._setState(a, 'thinking');
        break;
      case 'plan': this._planEvent(a, ev); break;
      case 'subagent_start': this._subStart(a, ev); break;
      case 'subagent_activity': this._subActivity(a, ev); break;
      case 'subagent_end': this._subEnd(a, ev); break;
      case 'result': {
        if (a.plan && a.plan.state === 'planning' && !ev.isError) this._planEvent(a, { phase: 'ready', summary: planSummary(ev.text || (a.curAsst && a.curAsst.text) || '') });
        this._planFinish(a, ev.isError);
        this._closeSubs(a, !ev.isError);
        if (a.curAsst) delete a.curAsst.streaming;
        if (ev.text && !a.runHadText) this._addMsg(a, ev.isError ? 'error' : 'assistant', ev.text);
        else if (ev.isError) this._addMsg(a, 'error', 'The run ended with an error.');
        this._endRun(a, 1500);
        if (ev.isError) { this._setState(a, 'error'); break; }
        this._setState(a, 'done');
        a.doneTimer = setTimeout(() => { if (!a.run && a.state === 'done') this._setState(a, 'idle'); }, DONE_HOLD_MS);
        break;
      }
      case 'error':
        this._planClear(a);
        this._closeSubs(a, false);
        this._addMsg(a, 'error', ev.message || 'Unknown error');
        this._endRun(a, 2000);
        this._setState(a, 'error');
        break;
      default: break;
    }
  }

  // ---------- plan mode ----------
  // Adapter events: plan {phase:'start'} (the run is in plan mode) and plan {phase:'ready', summary} (ExitPlanMode / the plan was produced).
  // a.plan drives the client: the agent walks to the round table, idle colleagues join; after the run ends the check stays up for PLAN_HOLD_MS.
  _planEvent(a, ev) {
    clearTimeout(a._planTimer);
    if (ev.phase === 'start') {
      if (a.plan && a.plan.state === 'planning') return;
      a.plan = { state: 'planning', summary: '', t0: Date.now() };
      this._addMsg(a, 'system', 'Plan mode: gathering at the round table to plan.');
    } else if (ev.phase === 'ready') {
      if (!a.plan) a.plan = { state: 'planning', summary: '', t0: Date.now() };
      if (a.plan.state === 'ready') return;
      const summary = String(ev.summary || '').trim() || 'Plan ready for review';
      a.plan = { state: 'ready', summary, t0: a.plan.t0, readyAt: Date.now() };
      this._addMsg(a, 'system', 'Plan ready: ' + summary);
    } else return;
    this._emitAgent(a);
  }
  _planFinish(a, isError) {
    if (!a.plan) return;
    if (isError) return this._planClear(a);
    clearTimeout(a._planTimer);
    a._planTimer = setTimeout(() => { if (a.plan) { a.plan = null; this._emitAgent(a); } }, PLAN_HOLD_MS);
  }
  _planClear(a) {
    clearTimeout(a._planTimer);
    if (a.plan) { a.plan = null; this._emitAgent(a); }
  }

  // ---------- subagents (helpers) ----------
  // Adapter events: subagent_start {subId,label,kind,hint}, subagent_activity {subId,tool,summary}, subagent_end {subId,ok,text}.
  // Each helper job is assigned to an EXISTING colleague (idle first; otherwise a new regular agent is hired and walks in through the door;
  // if the office is full the job waits for someone to free up). That person's `helping` field drives the walk-over / walk-back visuals.
  // Interactions between helpers are INFERRED from the event stream (shared file, result text naming another role) and flagged inferred:true.
  _subView(x) { return { subId: x.subId, label: x.label, kind: x.kind, role: x.role, status: x.status, log: x.log.slice(), result: x.result || '', helper: x.helperName || null, helperId: x.helperId || null }; }

  _team(a, e) {
    const entry = { id: a.team.length ? a.team[a.team.length - 1].id + 1 : 1, t: Date.now(), inferred: false, ...e };
    a.team.push(entry); if (a.team.length > 60) a.team.shift();
    this.emit('event', { type: 'team', id: a.id, entry });
    return entry;
  }

  _pickHelper(parent) {
    const now = Date.now();
    const c = [...this.agents.values()].filter((b) => b !== parent && !b.helping && !b.plan && !b.run && !b._pendingNext && !b._hold && !b.queue.length && (b.state === 'idle' || b.state === 'done') && now >= b.freeAt);
    c.sort((x, y) => (x.slot === MGR_SLOT) - (y.slot === MGR_SLOT) || x.helpCount - y.helpCount || x.slot - y.slot);   // the manager is the last resort
    return c[0] || null;
  }

  _usedNames() { return new Set([...this.agents.values()].map((b) => b.name.toLowerCase())); }

  /** give helper job `x` of `parent` to a person; false when nobody is free and the office is full (job stays pending) */
  _assignHelper(parent, x) {
    let h = this._pickHelper(parent), hired = false;
    const helping = { parentId: parent.id, parentName: parent.name, subId: x.subId, label: x.label, role: x.role, kind: x.kind };
    if (!h && this.agents.size < MAX_AGENTS) {
      const used = this._usedNames();
      let name = AUTO_NAMES.find((n) => !used.has(n.toLowerCase()));
      for (let k = 1; !name; k++) if (!used.has(('helper ' + k))) name = 'Helper ' + k;
      const type = this.registry.types[parent.type] && this.registry.types[parent.type].available ? parent.type : this.registry.defaultType;
      try { h = this.hire({ name, cwd: parent.cwd, agentType: type }, { auto: true, helping }); hired = true; } catch (_) { h = null; }
    }
    if (!h) return false;
    if (!hired) { h.helping = helping; h.helpCount++; this._emitAgent(h); }
    x.helperId = h.id; x.helperName = h.name; x.hired = hired;
    return true;
  }

  _assignPending() {
    for (const q of [...(this._pending || [])]) {
      const parent = this.agents.get(q.parentId), x = parent && parent.subs.get(q.subId);
      if (!x) { this._pending = this._pending.filter((p) => p !== q); continue; }
      if (!this._assignHelper(parent, x)) break;
      this._pending = this._pending.filter((p) => p !== q);
      const m = parent.transcript.find((t) => t.mid === x.mid); if (m) m.sub = this._subView(x);
      this.emit('event', { type: 'subagent', op: 'assign', id: parent.id, sub: { subId: x.subId, helperId: x.helperId } });
      this.emit('event', { type: 'sub_update', id: parent.id, mid: x.mid, sub: this._subView(x) });
    }
  }

  _subStart(a, ev) {
    const subId = String(ev.subId || '');
    if (!subId || a.subs.has(subId)) return;
    const label = String(ev.label || 'helper').replace(/\s+/g, ' ').trim().slice(0, 32) || 'helper';
    const kind = String(ev.kind || 'general').slice(0, 24);
    const x = { subId, label, kind, role: deriveRole(kind, label, ev.hint), status: 'running', log: [], tool: null, summary: null, helperId: null, touch: new Map() };
    const msg = this._addMsg(a, 'sub', `helper '${label}'`, { sub: this._subView(x) });
    x.mid = msg.mid; a.subs.set(subId, x); a.teamSubs.set(subId, x); a.teamRun.total++;
    if (!this._assignHelper(a, x)) { (this._pending = this._pending || []).push({ parentId: a.id, subId }); }
    const m0 = a.transcript.find((t) => t.mid === x.mid); if (m0) m0.sub = this._subView(x);
    this.emit('event', { type: 'subagent', op: 'start', id: a.id, sub: { subId, label, kind, role: x.role, helperId: x.helperId, helper: x.helperName || null, hired: !!x.hired } });
    this.emit('event', { type: 'sub_update', id: a.id, mid: x.mid, sub: this._subView(x) });
    if (!a.teamRun.planned) { a.teamRun.planned = true; this._team(a, { kind: 'plan', text: 'Lead handed out the plan (a task paper per helper)', from: { name: a.name, lead: true } }); }
    if (x.helperId) this._team(a, { kind: 'assign', text: `${x.helperName} helps with ${x.role}${x.hired ? ' (newly hired)' : ''}`, from: { name: a.name, lead: true }, to: { name: x.helperName, helperId: x.helperId, role: x.role, subId } });
    else this._team(a, { kind: 'note', text: `${x.role} job is waiting for a free colleague` });
    this._emitAgent(a);
  }

  _subActivity(a, ev) {
    const x = a.subs.get(String(ev.subId || ''));
    if (!x) return;
    x.tool = ev.tool || 'Tool'; x.summary = ev.summary || null;
    x.log.push({ tool: x.tool, summary: x.summary || '' });
    if (x.log.length > 40) x.log.splice(0, x.log.length - 40);
    const m = a.transcript.find((t) => t.mid === x.mid);
    if (m) m.sub = this._subView(x);
    this.emit('event', { type: 'subagent', op: 'activity', id: a.id, sub: { subId: x.subId, tool: x.tool, summary: x.summary, helperId: x.helperId } });
    this.emit('event', { type: 'sub_update', id: a.id, mid: x.mid, sub: this._subView(x) });
    this._inferPeers(a, x);
    this._emitAgent(a);
    this._save();
  }

  /** (a) two running helpers touching the same file / pattern within a window => they "compare notes" (INFERRED) */
  _inferPeers(a, x) {
    const tg = targetOf(x.tool, x.summary); if (!tg) return;
    const now = Date.now(), run = a.teamRun;
    for (const y of a.subs.values()) {
      if (y === x || !y.helperId || !x.helperId) continue;
      const when = y.touch.get(tg.key);
      if (when === undefined || now - when > PEER_WINDOW) continue;
      const pk = [x.subId, y.subId].sort().join('|');
      if (run.peers >= PEER_MAX || now - run.lastPeer < PEER_GAP || now - (run.pairs.get(pk) || 0) < PEER_PAIR_GAP) continue;
      run.peers++; run.lastPeer = now; run.pairs.set(pk, now);
      this._team(a, { kind: 'peer', inferred: true, text: `${y.role} ↔ ${x.role}: shared ${tg.text}`, why: `both helpers touched ${tg.text} within ${Math.round(PEER_WINDOW / 1000 / SLOW)} s`,
        from: { role: y.role, name: y.helperName, helperId: y.helperId, subId: y.subId }, to: { role: x.role, name: x.helperName, helperId: x.helperId, subId: x.subId }, glyph: ['?', '!', '...'][run.peers % 3] });
    }
    x.touch.set(tg.key, now);
  }

  _subEnd(a, ev) {
    const x = a.subs.get(String(ev.subId || ''));
    if (!x) return;
    const ok = ev.ok !== false;
    x.status = ok ? 'finished' : 'failed'; x.result = String(ev.text || '').replace(/\s+/g, ' ').slice(0, 400);
    a.subs.delete(x.subId); x.tool = null; x.short = shortSummary(x.result, ok);
    a.teamRun[ok ? 'ok' : 'failed']++;
    this._pending = (this._pending || []).filter((q) => q.subId !== x.subId);
    const m = a.transcript.find((t) => t.mid === x.mid);
    if (m) m.sub = this._subView(x);
    this.emit('event', { type: 'subagent', op: 'end', id: a.id, sub: { subId: x.subId, ok, short: x.short, helperId: x.helperId } });
    this.emit('event', { type: 'sub_update', id: a.id, mid: x.mid, sub: this._subView(x) });
    // release the person: their own transcript only gets a one-line system note
    const h = x.helperId && this.agents.get(x.helperId);
    if (h && h.helping && h.helping.subId === x.subId) {
      h.helping = null; h.freeAt = Date.now() + FREE_MS; h._hold = true;
      this._addMsg(h, 'system', `helped ${a.name}: ${x.label} (${ok ? 'finished' : 'failed'})`);
      this._emitAgent(h);
      setTimeout(() => { h._hold = false; if (this.agents.has(h.id) && !h.run && !h._pendingNext && !h.helping && h.queue.length) { const next = h.queue.shift(); this._emitAgent(h); this._start(h, next); } }, HOLD_MS);
    }
    // (b) handoff to the lead, a short summary bubble, and a letter to any helper whose role the result names (INFERRED)
    if (x.helperId) this._team(a, { kind: 'handoff', text: `${x.role} → lead: ${x.short}`, from: { role: x.role, name: x.helperName, helperId: x.helperId, subId: x.subId }, to: { name: a.name, lead: true }, ok, short: x.short });
    let n = 0;
    for (const r of mentionedRoles(x.result, x.role)) {
      const y = [...a.teamSubs.values()].find((q) => q !== x && q.role === r && q.helperId);
      if (!y || n >= 2) continue; n++;
      this._team(a, { kind: 'mention', inferred: true, text: `${x.role} → ${y.role}: result mentions ${r}`, why: `the ${x.role} result text names the ${r} role`,
        from: { role: x.role, name: x.helperName, helperId: x.helperId, subId: x.subId }, to: { role: y.role, name: y.helperName, helperId: y.helperId, subId: y.subId } });
    }
    // (c) everyone is back: wrap-up: every helper celebrates at its own desk, the lead merges
    if (!a.subs.size && !(this._pending || []).some((q) => q.parentId === a.id) && a.teamRun.total >= 2) {
      const r = a.teamRun;
      this._team(a, { kind: 'huddle', text: `Wrap-up: ${r.ok + r.failed} reports in${r.failed ? `, ${r.failed} failed` : ''} — lead merges them`, from: { name: a.name, lead: true },
        reports: [...a.teamSubs.values()].filter((q) => q.status !== 'running').map((q) => ({ helperId: q.helperId, ok: q.status === 'finished' })), ok: !r.failed });
    }
    this._assignPending();
    this._emitAgent(a);
    this._save();
  }

  /** run ended / interrupted: nothing can still be running */
  _closeSubs(a, ok) { for (const id of [...a.subs.keys()]) this._subEnd(a, { subId: id, ok, text: ok ? '' : 'Run ended before this helper reported back.' }); }

  /** Agent-to-agent message: `text` from `fromId` is forwarded as input to `toId`, prefixed with "[from <name>]". */
  relay(fromId, toId, text) {
    const from = this.agents.get(fromId), to = this.agents.get(toId);
    if (!from || !to) throw new Error('No such agent.');
    if (from === to) throw new Error('Pick a different agent to send to.');
    text = String(text || '').trim();
    if (!text) return;
    if (text.length > 20000) throw new Error('Message too long.');
    this._addMsg(from, 'system', `✉ Sent to ${to.name}: ${text.length > 300 ? text.slice(0, 297) + '...' : text}`);
    this.emit('event', { type: 'relay', from: from.id, to: to.id });
    this.send(to.id, `[from ${from.name}] ${text}`);
  }

  shutdown() {
    for (const a of this.agents.values()) { if (a.run) a.run.cancel(); clearTimeout(a.doneTimer); }
    this.saveNow();
  }
}

module.exports = { Harness, MAX_AGENTS, MGR_SLOT, planSummary };
