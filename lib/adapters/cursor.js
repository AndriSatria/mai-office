'use strict';
/**
 * Cursor CLI agent adapter (headless). NOTE: written against Cursor's documented CLI/stream-json
 * format (cursor.com/docs/cli); it has NOT been tested against a real `cursor-agent` binary
 * (none installed where this prototype was built).
 *
 * Per message we run (cwd = the agent's working directory):
 *   cursor-agent -p --output-format stream-json [--stream-partial-output] [--mode plan|ask | --force] [--trust]
 *                [--resume <chatId>] [extra args] -- "<message>"
 *
 * Documented NDJSON events:
 *   {type:'system', subtype:'init', session_id, model, cwd}       -> remember chat id
 *   {type:'user', message}                                         -> ignored (our own prompt)
 *   {type:'assistant', message:{content:[{type:'text',text}]}}     -> chat reply (one per message segment)
 *   {type:'tool_call', subtype:'started'|'completed', call_id,
 *     tool_call:{shellToolCall:{args:{command}} | readToolCall:{args:{path}} | ...}}
 *                                                                  -> working + tool label / back to thinking
 *   {type:'result', subtype:'success'|'error', is_error, result, session_id} -> done / error
 * With --stream-partial-output, only `assistant` events that have `timestamp_ms` and no
 * `model_call_id` carry new text deltas; the others are duplicates and are skipped.
 *
 * Env knobs:
 *   HARNESS_CURSOR_BIN    path to the binary (default: `cursor-agent`, then `agent`, on PATH)
 *   HARNESS_CURSOR_ARGS   extra whitespace-separated args, e.g. "--model gpt-5 --force"
 *                         (headless runs can't prompt; --force lets the agent run commands unprompted - dangerous)
 *
 * Modes (flags from `agent --help` 2026.10.22): default = no flag (edits are only proposed, per cursor.com/docs/cli/headless),
 * force = --force, plan = --mode plan, ask = --mode ask. A plan run emits {type:'plan',phase:'start'};
 * shortcut: a tool call named like *plan* or the final text marking the plan ready is a guess, not checked against a logged-in CLI.
 *   HARNESS_PARTIAL=1     add --stream-partial-output for live token streaming
 */
const { spawn } = require('child_process');
const { toolInput, runMeta, cap } = require('../tool-data');
const { planSummary } = require('../roles');
const { capture } = require('../debug-events');

const NICE = { shell: 'Shell', read: 'Read', edit: 'Edit', write: 'Write', delete: 'Delete', grep: 'Grep', ls: 'Ls', glob: 'Glob', todo: 'Todo', semSearch: 'Search', webSearch: 'WebSearch', webFetch: 'WebFetch', readLints: 'Lints' };

/** {shellToolCall:{args}} -> {name:'Shell', summary:'npm test'} */
function describeToolCall(tc) {
  tc = tc || {};
  const key = Object.keys(tc)[0];
  if (!key) return { name: 'Tool', summary: '' };
  const body = tc[key] || {};
  let name;
  if (key === 'function') name = (body.name || 'Tool'); // generic / MCP style: {function:{name, arguments}}
  else {
    const base = key.replace(/ToolCall$/, '');
    name = NICE[base] || base.charAt(0).toUpperCase() + base.slice(1);
  }
  let args = body.args || body.arguments || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = { value: args }; } }
  const pick = args.command || args.path || args.filePath || args.file_path || args.pattern || args.globPattern || args.query || args.url || args.value;
  let s = pick ? String(pick) : (Object.keys(args).length ? JSON.stringify(args) : '');
  s = s.replace(/\s+/g, ' ');
  return { name, summary: s.length > 90 ? s.slice(0, 87) + '...' : s, args };
}

/** Best effort: Cursor's stream-json shape for subagent/task calls is not documented; we treat a tool_call whose
 *  key is task/subagent (e.g. {taskToolCall:{args:{description,subagentType}}}) as a helper. UNTESTED against the real CLI. */
const isTaskCall = (tc) => { const k = Object.keys(tc || {})[0] || ''; return /^(task|subagent|agent)(ToolCall)?$/i.test(k); };
function describeTaskCall(tc) {
  const key = Object.keys(tc)[0], body = tc[key] || {};
  let args = body.args || body.arguments || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = { description: args }; } }
  const raw = String(args.description || args.subagentType || args.subagent_type || args.prompt || 'helper').replace(/\s+/g, ' ').trim();
  return { label: raw.length > 32 ? raw.slice(0, 31) + '…' : raw, kind: String(args.subagentType || args.subagent_type || 'general') };
}

function create(bin) {
  return {
    mode: 'cursor',
    run({ agent, text, emit }) {
      const partial = process.env.HARNESS_PARTIAL === '1';
      const args = ['-p', '--output-format', 'stream-json'];
      if (partial) args.push('--stream-partial-output');
      const planRun = agent.permissionMode === 'plan';
      if (planRun || agent.permissionMode === 'ask') args.push('--mode', agent.permissionMode);
      else if (agent.permissionMode === 'force') args.push('--force');
      args.push('--trust'); // headless: don't stop on the "trust this workspace?" prompt
      if (agent.sessionId) args.push('--resume', agent.sessionId);
      if (process.env.HARNESS_CURSOR_ARGS) args.push(...process.env.HARNESS_CURSOR_ARGS.split(/\s+/).filter(Boolean));
      args.push('--', text);

      let child, finished = false, stderr = '', buf = '', cancelled = false;
      const finish = (ev) => { if (!finished) { finished = true; emit(ev); } };
      const subs = new Set();
      try {
        child = spawn(bin, args, { cwd: agent.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      } catch (e) {
        setImmediate(() => finish({ type: 'error', message: 'Failed to spawn cursor-agent: ' + e.message }));
        return { cancel() {} };
      }
      emit({ type: 'state', state: 'thinking' });
      let planReady = false, lastText = '';
      if (planRun) emit({ type: 'plan', phase: 'start' });

      const handle = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o.session_id && o.type !== 'result') emit({ type: 'session', id: o.session_id });
        switch (o.type) {
          case 'assistant': {
            const content = (o.message && o.message.content) || [];
            const txt = (Array.isArray(content) ? content : []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
            if (!txt) break;
            lastText = txt;
            if (partial) {
              if (o.timestamp_ms !== undefined && o.model_call_id === undefined) emit({ type: 'assistant_delta', text: txt });
            } else emit({ type: 'assistant_text', text: txt });
            break;
          }
          case 'tool_call': {
            if (isTaskCall(o.tool_call)) {
              const id = o.call_id || JSON.stringify(o.tool_call).slice(0, 40);
              if (o.subtype === 'started') { const d = describeTaskCall(o.tool_call); subs.add(id); emit({ type: 'subagent_start', subId: id, label: d.label, kind: d.kind }); emit({ type: 'state', state: 'working', tool: 'Task', summary: d.label }); }
              else if (o.subtype === 'completed' && subs.has(id)) {
                subs.delete(id);
                const body = o.tool_call[Object.keys(o.tool_call)[0]] || {}, r = body.result || {};
                emit({ type: 'subagent_end', subId: id, ok: !(r.error || r.failure || r.rejected), text: typeof r.success === 'string' ? r.success : '' });
                if (!subs.size) emit({ type: 'tool_result' });
              }
              break;
            }
            if (o.subtype === 'started') {
              const d = describeToolCall(o.tool_call); emit({ type: 'tool', id: o.call_id, name: d.name, summary: d.summary, input: toolInput(d.args) });
              if (/plan/i.test(d.name) && !planReady) { planReady = true; if (!planRun) emit({ type: 'plan', phase: 'start' }); emit({ type: 'plan', phase: 'ready', summary: planSummary(d.summary || lastText) }); }
            }
            else if (o.subtype === 'completed') {
              // documented result shape {success:{stdout|content, totalLines|linesCreated}} or {error}; unverified against a real CLI
              const body = (o.tool_call && o.tool_call[Object.keys(o.tool_call)[0]]) || {}, r = body.result || {}, ok = r.success && typeof r.success === 'object' ? r.success : {};
              const err = r.error || r.failure || r.rejected, out = ok.stdout || ok.content || (err && (err.message || err.stderr || (typeof err === 'string' ? err : ''))) || '';
              const n = Number.isFinite(ok.totalLines) ? ok.totalLines : Number.isFinite(ok.linesCreated) ? ok.linesCreated : undefined;
              emit({ type: 'tool_result', results: [{ id: o.call_id, isError: !!err, text: cap(String(out)), meta: n !== undefined ? { numLines: n } : null }] });
            }
            break;
          }
          case 'result': {
            if (o.session_id) emit({ type: 'session', id: o.session_id });
            const isError = !!o.is_error || (o.subtype && o.subtype !== 'success');
            if (planRun && !planReady && !isError) { planReady = true; emit({ type: 'plan', phase: 'ready', summary: planSummary(typeof o.result === 'string' && o.result ? o.result : lastText) }); }
            finish({ type: 'result', text: typeof o.result === 'string' ? o.result : '', isError, meta: runMeta(o) });
            break;
          }
          default: break; // system/user/thinking/unknown events
        }
      };

      const dbg = capture(agent, 'cursor');
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!ln) continue;
          dbg.line(ln);
          try { handle(JSON.parse(ln)); } catch (_) { /* non-JSON noise */ }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
      child.on('error', (e) => finish({ type: 'error', message: 'cursor-agent failed to start: ' + e.message + ' (set HARNESS_CURSOR_BIN)' }));
      child.on('close', (code, sig) => {
        if (buf.trim()) dbg.line(buf.trim());
        dbg.end();
        if (cancelled) return;
        if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch (_) {} }
        if (/(Failed to resume chat|No chat found|chat not found|invalid chat)/i.test(stderr)) emit({ type: 'session', id: null });
        if (code === 0) finish({ type: 'result', text: '', isError: false });
        else finish({ type: 'error', message: `cursor-agent exited with ${code === null ? sig : 'code ' + code}${stderr ? ': ' + stderr.trim().slice(-500) : ''}` });
      });

      return {
        cancel() {
          cancelled = true;
          try { child.kill('SIGTERM'); } catch (_) {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
        },
      };
    },
  };
}

module.exports = { create, describeToolCall, isTaskCall, describeTaskCall };
