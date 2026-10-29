'use strict';
// Read-only listing of the "/" commands an agent can run: Claude Code commands, skills and plugins, Cursor commands, app built-ins.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeDir } = require('./claude-sessions');

const READ_MAX = 64 * 1024, DESC_MAX = 160, MAX_DEPTH = 4, MAX_ITEMS = 400;
// names Claude Code reports in its init event that only do something in the interactive terminal
const INTERACTIVE_ONLY = new Set(['clear', 'model', 'config', 'login', 'logout', 'exit', 'quit', 'help', 'resume', 'vim', 'theme', 'permissions',
  'agents', 'mcp', 'ide', 'doctor', 'memory', 'hooks', 'status', 'terminal-setup', 'add-dir', 'upgrade', 'privacy-settings', 'rewind', 'statusline',
  'export', 'bashes', 'plugin', 'plugins', 'reload-plugins', 'reload-skills', 'skills', 'feedback', 'bug', 'output-style', 'keybindings']);
const APP = [{ name: 'plan', hint: '<task>', description: 'Plan this at the round table: one plan-mode run, the team gathers', source: 'app', kind: 'command' }];
const MOCK = [
  { name: 'team', hint: '<task>', description: 'Split the task across 2-3 helpers (simulated)', source: 'mock', kind: 'command' },
  { name: 'review', hint: '[path]', description: 'Pretend to review the latest changes (simulated)', source: 'mock', kind: 'command' },
];

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(READ_MAX); const n = fs.readSync(fd, b, 0, READ_MAX, 0); return b.slice(0, n).toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

const unquote = (v) => { v = v.trim(); return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v; };

/** YAML-ish frontmatter of simple `key: value` lines; like Claude Code, a block that doesn't parse yields no fields */
function frontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { fields: {}, body: raw };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { fields: {}, body: lines.slice(1).join('\n') };
  const fields = {};
  let key = null, ok = true;
  for (const l of lines.slice(1, end)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/.exec(l);
    if (m) { key = m[1]; const v = m[2] || ''; fields[key] = /^[|>][+-]?$/.test(v) ? '' : unquote(v); continue; }
    if (key && /^\s+\S/.test(l)) { fields[key] = (fields[key] ? fields[key] + ' ' : '') + unquote(l); continue; }
    ok = false; break;
  }
  return { fields: ok ? fields : {}, body: lines.slice(end + 1).join('\n') };
}

const oneLine = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1) + '…' : s; };
const firstLine = (body) => (body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l && l !== '---') || '');

function entry(file, name, source, kind) {
  const raw = readHead(file);
  if (raw == null) return null;
  const { fields, body } = frontmatter(raw);
  if (kind === 'skill' && String(fields['user-invocable']).toLowerCase() === 'false') return null;
  if (kind === 'skill') {   // frontmatter name wins over the folder name; a plugin prefix is not doubled
    const base = fields.name && !/[<>]/.test(fields.name) ? fields.name : name.slice(name.lastIndexOf(':') + 1);
    name = base.includes(':') ? base : name.slice(0, name.lastIndexOf(':') + 1) + base;
  }
  return { name, description: oneLine(fields.description || firstLine(body)), hint: oneLine(fields['argument-hint'] || ''), source, kind };
}

const listDir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } };

/** commands/**\/*.md -> name with sub folders joined by ':' (Claude Code's naming), flat when `flat` */
function commandsIn(dir, source, prefix, flat, depth = 0, rel = []) {
  const out = [];
  for (const d of listDir(dir)) {
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory() && !flat && depth < MAX_DEPTH) out.push(...commandsIn(p, source, prefix, flat, depth + 1, rel.concat(d.name)));
    else if (d.isFile() && d.name.endsWith('.md')) {
      const e = entry(p, prefix + rel.concat(d.name.slice(0, -3)).join(':'), source, 'command');
      if (e) out.push(e);
    }
  }
  return out;
}

/** skills/<dir>/SKILL.md -> frontmatter name or the folder name */
function skillsIn(dir, source, prefix) {
  const out = [];
  for (const d of listDir(dir)) {
    if (d.name.startsWith('.') || !(d.isDirectory() || d.isSymbolicLink())) continue;
    const e = entry(path.join(dir, d.name, 'SKILL.md'), prefix + d.name, source, 'skill');
    if (e) out.push(e);
  }
  return out;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

/** installed plugins (plugins/installed_plugins.json): commands and skills namespaced as plugin:name */
function pluginEntries(cdir, cwd) {
  const root = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(cdir, 'plugins');
  const inst = readJson(path.join(root, 'installed_plugins.json'));
  const enabled = (readJson(path.join(cdir, 'settings.json')) || {}).enabledPlugins || {};
  const out = [];
  for (const [key, recs] of Object.entries((inst && inst.plugins) || {})) {
    if (enabled[key] === false) continue;
    const rec = (Array.isArray(recs) ? recs : [recs]).find((r) => r && r.installPath && (!r.projectPath || path.resolve(r.projectPath) === cwd));
    if (!rec) continue;
    const dir = path.resolve(rec.installPath);
    const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
    const name = String(manifest.name || key.split('@')[0]);
    out.push(...skillsIn(path.join(dir, 'skills'), 'plugin', name + ':'), ...commandsIn(path.join(dir, 'commands'), 'plugin', name + ':', true));
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) { const e = entry(path.join(dir, 'SKILL.md'), name + ':' + name, 'plugin', 'skill'); if (e) out.push(e); }
  }
  return out;
}

function claudeEntries(cwd, sessionNames) {
  const cdir = claudeDir(), pdir = path.join(cwd, '.claude');
  const list = [
    ...skillsIn(path.join(cdir, 'skills'), 'user', ''), ...skillsIn(path.join(pdir, 'skills'), 'project', ''),
    ...commandsIn(path.join(cdir, 'commands'), 'user', ''), ...commandsIn(path.join(pdir, 'commands'), 'project', ''),
    ...pluginEntries(cdir, cwd),
  ];
  for (const n of sessionNames || []) {
    const name = String(n).replace(/^\//, '');
    if (name && !INTERACTIVE_ONLY.has(name)) list.push({ name, description: '', hint: '', source: 'session', kind: 'command' });
  }
  return list;
}

function cursorEntries(cwd) {
  const home = process.env.HARNESS_CURSOR_DIR || path.join(os.homedir(), '.cursor');
  return [...commandsIn(path.join(cwd, '.cursor', 'commands'), 'project', '', true), ...commandsIn(path.join(home, 'commands'), 'user', '', true)];
}

/** every command for an agent {type, cwd, sessionCommands}; the first source to claim a name wins */
function listFor(agent) {
  const cwd = path.resolve(agent.cwd || '.');
  const list = APP.concat(agent.type === 'claude' ? claudeEntries(cwd, agent.sessionCommands) : agent.type === 'cursor' ? cursorEntries(cwd) : MOCK);
  const seen = new Set(), out = [];
  for (const e of list) {
    const k = e.name.toLowerCase();
    if (!e.name || seen.has(k)) continue;
    seen.add(k); out.push(e);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

module.exports = { listFor, frontmatter, INTERACTIVE_ONLY };
