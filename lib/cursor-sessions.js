'use strict';
const { toolInput } = require('./tool-data');
// Read-only access to local Cursor CLI chats (layout read from the cursor-agent 2026.10.22 bundle):
//   <config dir>/chats/<md5(cwd)>/<chat id>/meta.json   {title, createdAtMs, updatedAtMs, hasConversation, isSubagent, cwd}
//   <data dir>/projects/<slug(cwd)>/agent-transcripts/<id>/<id>.jsonl   {role, message:{content:[text | tool_use]}} per line
// store.db (SQLite + protobuf blobs) is not opened: meta.json and the transcript carry what the office shows.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TITLE_MAX = 80, TEXT_MAX = 4000;

// HARNESS_CURSOR_DIR stands in for ~/.cursor everywhere (tests, screenshots)
const homeCursor = () => process.env.HARNESS_CURSOR_DIR || path.join(os.homedir(), '.cursor');
function configDir() {
  if (process.env.HARNESS_CURSOR_DIR) return process.env.HARNESS_CURSOR_DIR;
  if (process.env.CURSOR_CONFIG_DIR && process.env.CURSOR_CONFIG_DIR.trim()) return process.env.CURSOR_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()) return path.join(process.env.XDG_CONFIG_HOME, 'cursor');
  return homeCursor();
}
const dataDir = () => process.env.HARNESS_CURSOR_DIR || (process.env.CURSOR_DATA_DIR && process.env.CURSOR_DATA_DIR.trim()) || homeCursor();
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
const md5 = (s) => crypto.createHash('md5').update(path.resolve(s)).digest('hex');

const oneLine = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const safeDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };

/** what the user typed sits in <user_query>; the rest of a user turn is context Cursor adds */
function userText(t) {
  const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(t);
  return (m ? m[1] : /^\s*</.test(t) ? '' : t).trim();
}
function toolLine(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  const pick = a.command || a.path || a.filePath || a.file_path || a.pattern || a.globPattern || a.query || a.url || '';
  return `${name}: ${oneLine(pick || (Object.keys(a).length ? JSON.stringify(a) : ''), 90)}`.replace(/: $/, '');
}

/** transcript JSONL -> [{role, text}]; bad lines and turn markers are skipped */
function parse(raw) {
  const msgs = [];
  for (const s of raw.split('\n')) {
    if (!s.trim()) continue;
    let l;
    try { l = JSON.parse(s); } catch (_) { continue; }
    const c = l && l.message && l.message.content;
    if (!l || !Array.isArray(c) || (l.role !== 'user' && l.role !== 'assistant')) continue;
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        const t = l.role === 'user' ? userText(b.text) : b.text.trim();
        if (t) msgs.push({ role: l.role, text: t.slice(0, TEXT_MAX), ts: 0 });
      } else if (b && b.type === 'tool_use' && b.name) msgs.push({ role: 'tool', text: toolLine(b.name, b.input), ts: 0, tool: b.name, input: toolInput(b.input), status: 'done' });
    }
  }
  return msgs;
}

function transcriptFile(cwd, id) {
  const dir = path.join(dataDir(), 'projects', slug(cwd), 'agent-transcripts'), enc = encodeURIComponent(id).replace(/%/g, '_');
  return [path.join(dir, enc, enc + '.jsonl'), path.join(dir, enc + '.jsonl')].find((f) => fs.existsSync(f)) || null;
}

const cache = new Map();   // meta.json path -> { key, info }
function readChat(dir, id) {
  const metaFile = path.join(dir, 'meta.json'), st = fs.statSync(metaFile);
  const meta = readJson(metaFile);
  // chats without meta.json (older builds) don't name their folder, so they can't be resumed in the right place
  if (!meta || typeof meta.cwd !== 'string' || !meta.cwd || meta.isSubagent || meta.hasConversation === false) return null;
  const tf = transcriptFile(meta.cwd, id), tst = tf ? fs.statSync(tf) : null;
  const key = st.mtimeMs + ':' + (tst ? tst.mtimeMs + ':' + tst.size : '-'), hit = cache.get(metaFile);
  if (hit && hit.key === key) return hit.info;
  const msgs = tf ? parse(fs.readFileSync(tf, 'utf8')) : [];
  const firstUser = msgs.find((m) => m.role === 'user');
  const info = {
    id, cwd: meta.cwd, file: tf, source: 'cursor',
    title: oneLine((typeof meta.title === 'string' && meta.title !== 'New Agent' && meta.title) || (firstUser ? firstUser.text : '') || '(untitled chat)', TITLE_MAX),
    mtime: Number(meta.updatedAtMs) || Number(meta.createdAtMs) || st.mtimeMs,
    count: msgs.filter((m) => m.role !== 'tool').length, msgs, hasTranscript: !!tf,
    // `agent --resume` looks the chat up under md5(cwd); a mismatch means it won't be found from that folder
    resumable: path.basename(path.dirname(dir)) === md5(meta.cwd),
  };
  cache.set(metaFile, { key, info });
  return info;
}

/** CLI chats with a known folder, newest first (Cursor IDE chats live in state.vscdb and are not listed) */
function listSessions() {
  const root = path.join(configDir(), 'chats'), out = [];
  for (const h of safeDir(root)) {
    if (!h.isDirectory()) continue;
    for (const c of safeDir(path.join(root, h.name))) {
      if (!c.isDirectory() || !ID_RE.test(c.name)) continue;
      try { const info = readChat(path.join(root, h.name, c.name), c.name); if (info && info.resumable) out.push(info); } catch (_) { /* unreadable chat: leave it out */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function findSession(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  return listSessions().find((s) => s.id === id) || null;
}

module.exports = { configDir, dataDir, homeCursor, listSessions, findSession, parse, slug, md5 };
