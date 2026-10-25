'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { deriveRole, targetOf, shortSummary, mentionedRoles } = require('./roles');

const MAX_AGENTS = 8;            // desk slots in the office
const MAX_TRANSCRIPT = 300;
const DONE_HOLD_MS = 4500 * Math.max(0.2, +process.env.HARNESS_SLOW || 1);       // how long the "done" celebration state lasts
// demo pacing: HARNESS_SLOW=2 stretches the helper release / inference timers (the mock adapter reads the same variable)
const SLOW = Math.max(0.2, +process.env.HARNESS_SLOW || 1);
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
    for (const a of (raw && raw.agents) || []) {
      if (!a || !a.id || !a.name) continue;
      this.agents.set(a.id, this._runtime({
        id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look,
        type: this.registry.types[a.type] ? a.type : this.registry.defaultType,
        sessionId: a.sessionId || null, transcript: Array.isArray(a.transcript) ? a.transcript : [],
      }));
    }
  }

  _runtime(a) {
    a.state = 'idle'; a.tool = null; a.toolSummary = null;
    a.queue = []; a.run = null; a.curAsst = null; a.runHadText = false; a.doneTimer = null;
    a.subs = new Map();   // subId -> running helper (subagent) of this agent's current run
    a.teamSubs = new Map(); a.team = []; a.teamRun = { planned: false, total: 0, ok: 0, failed: 0, peers: 0, lastPeer: 0, pairs: new Map() };
    a.helping = null;     // {parentId, parentName, subId, label, role, kind}: this person is currently helping a colleague's run
    a.helpCount = 0; a.freeAt = 0; a._hold = false;
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
      version: 1,
      agents: [...this.agents.values()].map((a) => ({
        id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look, type: a.type, sessionId: a.sessionId,
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
      hasSession: !!a.sessionId,
      subs: [...a.subs.values()].map((x) => ({ subId: x.subId, label: x.label, kind: x.kind, role: x.role, tool: x.tool, summary: x.summary, helperId: x.helperId || null })),
      helping: a.helping, autoHired: !!a.autoHired,
    };
  }

  snapshot() {
    return {
      type: 'snapshot', mode: this.registry.defaultType, defaultType: this.registry.defaultType,
      types: Object.values(this.registry.types).map((t) => ({ id: t.id, label: t.label, available: t.available })), maxAgents: MAX_AGENTS, defaultCwd: this.defaultCwd,
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
  hire({ name, cwd, agentType }, opts) {
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
    let slot = 0; while (taken.has(slot)) slot++;
    const used = [...this.agents.values()].map((a) => a.look.shirt);
    const shirt = SHIRTS.find((s) => !used.includes(s)) || pick(SHIRTS, rnd(99));
    const look = {
      shirt, hair: pick(HAIRS, rnd(99)), hairStyle: pick(STYLES, slot + rnd(2) * 2 + 1),
      skin: pick(SKINS, rnd(99)), pants: pick(PANTS, rnd(99)),
    };
    const id = 'a' + Date.now().toString(36) + rnd(1296).toString(36);
    const a = this._runtime({ id, name, cwd: dir, slot, look, type, sessionId: null, transcript: [] });
    this.agents.set(id, a);
    const t = this.registry.types[type];
    this._addMsg(a, 'system', `${name} (${t.label}) joined the office. Working directory: ${dir}${t.available ? '' : `\nWarning: the ${t.label} CLI was not found on PATH; messages will fail until it is installed (or set HARNESS_${type.toUpperCase()}_BIN).`}`);
    if (opts.auto) { a.autoHired = true; a.helping = opts.helping || null; if (a.helping) a.helpCount++; this._addMsg(a, 'system', `Hired automatically to help ${(opts.helping && opts.helping.parentName) || 'a colleague'} (no idle colleague was free).`); }
    this._save();
    this.emit('event', { type: 'agent', agent: this.pub(a), transcript: a.transcript, isNew: true, enter: !!opts.auto });
    return a;
  }

  fire(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    if (a.run) a.run.cancel();
    clearTimeout(a.doneTimer);
    a.run = null; a.queue = [];
    this._closeSubs(a, false);
    this.agents.delete(id);
    this._pending = (this._pending || []).filter((q) => q.parentId !== id);
    this.saveNow();
    this.emit('event', { type: 'removed', id });
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
    this._addMsg(a, 'system', 'Interrupted.');
    this._setState(a, 'idle');
  }

  _start(a, text) {
    clearTimeout(a.doneTimer);
    a.curAsst = null; a.runHadText = false;
    a.team = []; a.teamSubs = new Map(); a.teamRun = { planned: false, total: 0, ok: 0, failed: 0, peers: 0, lastPeer: 0, pairs: new Map() };
    this.emit('event', { type: 'team', id: a.id, reset: true });
    this._setState(a, 'thinking');
    const token = { cancel() {} };
    a.run = token;
    const handle = (this.registry.types[a.type] || this.registry.types[this.registry.defaultType]).adapter.run({
      agent: { id: a.id, name: a.name, cwd: a.cwd, sessionId: a.sessionId },
      text,
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
      case 'subagent_start': this._subStart(a, ev); break;
      case 'subagent_activity': this._subActivity(a, ev); break;
      case 'subagent_end': this._subEnd(a, ev); break;
      case 'result': {
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
        this._closeSubs(a, false);
        this._addMsg(a, 'error', ev.message || 'Unknown error');
        this._endRun(a, 2000);
        this._setState(a, 'error');
        break;
      default: break;
    }
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
    const c = [...this.agents.values()].filter((b) => b !== parent && !b.helping && !b.run && !b._pendingNext && !b._hold && !b.queue.length && (b.state === 'idle' || b.state === 'done') && now >= b.freeAt);
    c.sort((x, y) => x.helpCount - y.helpCount || x.slot - y.slot);
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
    // (c) everyone is back: team huddle around the lead
    if (!a.subs.size && !(this._pending || []).some((q) => q.parentId === a.id) && a.teamRun.total >= 2) {
      const r = a.teamRun;
      this._team(a, { kind: 'huddle', text: `Huddle: ${r.ok + r.failed} reports in${r.failed ? `, ${r.failed} failed` : ''} — lead merges them`, from: { name: a.name, lead: true },
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

module.exports = { Harness, MAX_AGENTS };
