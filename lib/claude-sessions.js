'use strict';
// Read-only access to local Claude Code sessions: <claude dir>/projects/<encoded cwd>/<session id>.jsonl
const fs = require('fs');
const os = require('os');
const path = require('path');
const { summarize } = require('./adapters/claude');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TITLE_MAX = 80;
const TEXT_MAX = 4000;

function claudeDir() {
  return process.env.HARNESS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const oneLine = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// slash-command echoes and other harness notes Claude Code writes as "user" lines
const isNoise = (t) => /^\s*<(command-|local-command-|system-reminder)/.test(t) || /^Caveat: The messages below were generated/.test(t);

/** user content -> typed text, or '' for tool results / images / meta lines */
function userText(line) {
  if (line.isMeta) return '';
  const c = line.message && line.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
  return isNoise(t) ? '' : t.trim();
}

/** every line -> transcript entries {role:'user'|'assistant'|'tool', text, ts}; bad JSON lines are skipped */
function parse(raw) {
  const out = { cwd: null, summary: null, msgs: [] };
  for (const s of raw.split('\n')) {
    if (!s.trim()) continue;
    let l;
    try { l = JSON.parse(s); } catch (_) { continue; }
    if (!l || typeof l !== 'object') continue;
    if (l.type === 'summary' && typeof l.summary === 'string') { if (!out.summary) out.summary = l.summary; continue; }
    if (l.isSidechain) continue;
    if (!out.cwd && typeof l.cwd === 'string') out.cwd = l.cwd;
    const ts = Date.parse(l.timestamp) || 0;
    if (l.type === 'user') { const t = userText(l); if (t) out.msgs.push({ role: 'user', text: t.slice(0, TEXT_MAX), ts }); }
    else if (l.type === 'assistant' && l.message && Array.isArray(l.message.content)) {
      for (const b of l.message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.msgs.push({ role: 'assistant', text: b.text.trim().slice(0, TEXT_MAX), ts });
        else if (b && b.type === 'tool_use' && b.name) out.msgs.push({ role: 'tool', text: `${b.name}: ${summarize(b.name, b.input)}`, ts });
      }
    }
  }
  return out;
}

const cache = new Map();   // file -> { key, info }
function readSession(file, st) {
  const key = st.mtimeMs + ':' + st.size, hit = cache.get(file);
  if (hit && hit.key === key) return hit.info;
  const p = parse(fs.readFileSync(file, 'utf8'));
  const firstUser = p.msgs.find((m) => m.role === 'user');
  const info = {
    id: path.basename(file, '.jsonl'), cwd: p.cwd, file,
    title: oneLine(p.summary || (firstUser ? firstUser.text : '') || '(no messages)', TITLE_MAX),
    mtime: st.mtimeMs, count: p.msgs.filter((m) => m.role !== 'tool').length, msgs: p.msgs,
  };
  cache.set(file, { key, info });
  return info;
}

const safeDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };

/** all sessions with a known cwd and at least one message, newest first */
function listSessions() {
  const root = path.join(claudeDir(), 'projects'), out = [];
  for (const p of safeDir(root)) {
    if (!p.isDirectory()) continue;
    for (const f of safeDir(path.join(root, p.name))) {
      // agent-*.jsonl are subagent sidechains, not resumable sessions
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-') || !ID_RE.test(f.name.slice(0, -6))) continue;
      const file = path.join(root, p.name, f.name);
      try {
        const info = readSession(file, fs.statSync(file));
        if (info.cwd && info.count) out.push(info);
      } catch (_) { /* unreadable file: leave it out */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const publicInfo = ({ id, cwd, title, mtime, count }) => ({ id, cwd, title, mtime, count });

/** one session by id (with its parsed messages) or null */
function findSession(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  return listSessions().find((s) => s.id === id) || null;
}

module.exports = { claudeDir, listSessions, findSession, publicInfo, parse };
