'use strict';
/**
 * Claude Code adapter (headless). NOTE: written against the documented CLI
 * flags; it has NOT been tested against a real `claude` binary on the machine
 * this prototype was built on (none installed there).
 *
 * Per message we run:
 *   claude -p --output-format stream-json --verbose [--include-partial-messages]
 *          [--permission-mode <mode>] [--resume <session_id>] [extra args] -- "<message>"
 * with cwd = the agent's working directory, and parse newline-delimited JSON:
 *   {type:'system', subtype:'init', session_id}          -> remember session id
 *   {type:'assistant', message:{content:[text|tool_use]}} -> chat reply / working + tool label
 *   {type:'user', message:{content:[tool_result]}}        -> back to thinking
 *   {type:'stream_event', event:{delta:{text_delta}}}     -> streamed text (partial mode)
 *   {type:'result', result, is_error, session_id}         -> done / error
 *
 * Env knobs:
 *   HARNESS_PERMISSION_MODE  default "acceptEdits" (headless can't prompt; "default" denies
 *                            unapproved tools; "bypassPermissions" is dangerous)
 *   HARNESS_PARTIAL=1        add --include-partial-messages for token streaming
 *   HARNESS_CLAUDE_ARGS      extra args, whitespace separated (e.g. "--model sonnet --allowedTools Bash,Read")
 */
const { spawn } = require('child_process');

function summarize(name, input) {
  input = input || {};
  const pick = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description;
  let s = pick ? String(pick) : JSON.stringify(input);
  s = s.replace(/\s+/g, ' ');
  return s.length > 90 ? s.slice(0, 87) + '...' : s;
}

/** Claude Code spawns a subagent with the Task tool (newer builds also call it "Agent"). */
const isTaskTool = (name) => /^(Task|Agent)$/.test(name || '');

/** tool_use input of a Task call -> { label, kind } */
function describeTask(input) {
  input = input || {};
  const kind = String(input.subagent_type || input.subagentType || 'general-purpose');
  const label = String(input.description || input.subagent_type || input.prompt || 'helper').replace(/\s+/g, ' ').trim();
  return { label: label.length > 32 ? label.slice(0, 31) + '…' : label, kind };
}

/** tool_result.content (string | [{type:'text',text}]) -> plain text */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ');
  return '';
}

function create(bin) {
  return {
    mode: 'claude',
    run({ agent, text, emit }) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (process.env.HARNESS_PARTIAL === '1') args.push('--include-partial-messages');
      const perm = process.env.HARNESS_PERMISSION_MODE || 'acceptEdits';
      if (perm !== 'none') args.push('--permission-mode', perm);
      if (agent.sessionId) args.push('--resume', agent.sessionId);
      if (process.env.HARNESS_CLAUDE_ARGS) args.push(...process.env.HARNESS_CLAUDE_ARGS.split(/\s+/).filter(Boolean));
      args.push('--', text); // "--" so messages starting with "-" aren't parsed as flags

      let child;
      let finished = false;
      let stderr = '';
      let buf = '';
      let cancelled = false;
      const finish = (ev) => { if (!finished) { finished = true; emit(ev); } };
      const subs = new Set();   // tool_use ids of running Task (subagent) calls

      try {
        child = spawn(bin, args, { cwd: agent.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      } catch (e) {
        setImmediate(() => finish({ type: 'error', message: 'Failed to spawn claude: ' + e.message }));
        return { cancel() {} };
      }
      emit({ type: 'state', state: 'thinking' });

      const handle = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o.session_id && o.type !== 'result') emit({ type: 'session', id: o.session_id });
        switch (o.type) {
          case 'assistant': {
            const content = (o.message && o.message.content) || [];
            const parent = o.parent_tool_use_id;   // set on everything a subagent does
            for (const b of Array.isArray(content) ? content : []) {
              if (parent) { // subagent activity: shown on the helper, not as the parent's own work
                if (b.type === 'tool_use') emit({ type: 'subagent_activity', subId: parent, tool: b.name, summary: summarize(b.name, b.input) });
                continue;
              }
              if (b.type === 'text' && b.text) emit({ type: 'assistant_text', text: b.text });
              else if (b.type === 'tool_use' && isTaskTool(b.name)) {
                const d = describeTask(b.input);
                subs.add(b.id);
                emit({ type: 'subagent_start', subId: b.id, label: d.label, kind: d.kind });
                emit({ type: 'state', state: 'working', tool: 'Task', summary: d.label });
              }
              else if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, summary: summarize(b.name, b.input) });
              else if (b.type === 'thinking') emit({ type: 'state', state: 'thinking' });
            }
            break;
          }
          case 'user': {
            if (o.parent_tool_use_id) break;       // a subagent's own tool results
            const content = (o.message && o.message.content) || [];
            const results = Array.isArray(content) ? content.filter((b) => b.type === 'tool_result') : [];
            let other = false;
            for (const b of results) {
              if (subs.has(b.tool_use_id)) { subs.delete(b.tool_use_id); emit({ type: 'subagent_end', subId: b.tool_use_id, ok: !b.is_error, text: resultText(b.content) }); }
              else other = true;
            }
            // back to "thinking" unless other helpers are still running
            if (results.length && (other || subs.size === 0)) emit({ type: 'tool_result' });
            break;
          }
          case 'stream_event': {
            if (o.parent_tool_use_id) break;       // partial text of a subagent
            const d = o.event && o.event.delta;
            if (d && d.type === 'text_delta' && d.text) emit({ type: 'assistant_delta', text: d.text });
            break;
          }
          case 'result': {
            if (o.session_id) emit({ type: 'session', id: o.session_id });
            const isError = !!o.is_error || (o.subtype && o.subtype !== 'success');
            finish({ type: 'result', text: typeof o.result === 'string' ? o.result : '', isError });
            break;
          }
          default: break;
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { handle(JSON.parse(line)); } catch (_) { /* non-JSON noise */ }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
      child.on('error', (e) => finish({ type: 'error', message: 'claude failed to start: ' + e.message }));
      child.on('close', (code, sig) => {
        if (cancelled) return;
        if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch (_) {} }
        if (/No conversation found/i.test(stderr)) emit({ type: 'session', id: null });
        if (code === 0) finish({ type: 'result', text: '', isError: false });
        else finish({ type: 'error', message: `claude exited with ${code === null ? sig : 'code ' + code}${stderr ? ': ' + stderr.trim().slice(-500) : ''}` });
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

module.exports = { create, summarize, isTaskTool, describeTask };
