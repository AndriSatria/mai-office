'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_AGENTS = 8;            // desk slots in the office
const MAX_TRANSCRIPT = 300;
const DONE_HOLD_MS = 4500;       // how long the "done" celebration state lasts

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
  constructor({ dataFile, adapter }) {
    super();
    this.dataFile = dataFile;
    this.adapter = adapter;
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
        sessionId: a.sessionId || null, transcript: Array.isArray(a.transcript) ? a.transcript : [],
      }));
    }
  }

  _runtime(a) {
    a.state = 'idle'; a.tool = null; a.toolSummary = null;
    a.queue = []; a.run = null; a.curAsst = null; a.runHadText = false; a.doneTimer = null;
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
        id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look, sessionId: a.sessionId,
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
      id: a.id, name: a.name, cwd: a.cwd, slot: a.slot, look: a.look,
      state: a.state, tool: a.tool, toolSummary: a.toolSummary, queued: a.queue.length,
      hasSession: !!a.sessionId,
    };
  }

  snapshot() {
    return {
      type: 'snapshot', mode: this.adapter.mode, maxAgents: MAX_AGENTS, defaultCwd: this.defaultCwd,
      agents: [...this.agents.values()].map((a) => ({ ...this.pub(a), transcript: a.transcript })),
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
  }

  // ---------- commands ----------
  hire({ name, cwd }) {
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
    const a = this._runtime({ id, name, cwd: dir, slot, look, sessionId: null, transcript: [] });
    this.agents.set(id, a);
    this._addMsg(a, 'system', `${name} joined the office. Working directory: ${dir}`);
    this._save();
    this.emit('event', { type: 'agent', agent: this.pub(a), transcript: a.transcript, isNew: true });
    return a;
  }

  fire(id) {
    const a = this.agents.get(id);
    if (!a) throw new Error('No such agent.');
    if (a.run) a.run.cancel();
    clearTimeout(a.doneTimer);
    a.run = null; a.queue = [];
    this.agents.delete(id);
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
    if (a.run || a._pendingNext) {
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
    this._addMsg(a, 'system', 'Interrupted.');
    this._setState(a, 'idle');
  }

  _start(a, text) {
    clearTimeout(a.doneTimer);
    a.curAsst = null; a.runHadText = false;
    this._setState(a, 'thinking');
    const token = { cancel() {} };
    a.run = token;
    const handle = this.adapter.run({
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
      case 'result': {
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
        this._addMsg(a, 'error', ev.message || 'Unknown error');
        this._endRun(a, 2000);
        this._setState(a, 'error');
        break;
      default: break;
    }
  }

  shutdown() {
    for (const a of this.agents.values()) { if (a.run) a.run.cancel(); clearTimeout(a.doneTimer); }
    this.saveNow();
  }
}

module.exports = { Harness, MAX_AGENTS };
