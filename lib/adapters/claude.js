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
 *   {type:'system', subtype:'init', session_id, slash_commands, skills} -> remember session id + the "/" names
 *   {type:'assistant', message:{content:[text|tool_use]}} -> chat reply / working + tool label
 *   {type:'user', message:{content:[tool_result]}}        -> back to thinking
 *   {type:'stream_event', event:{delta:{text_delta}}}     -> streamed text (partial mode)
 *   {type:'result', result, is_error, session_id}         -> done / error
 *
 * Subagents (shapes from the Agent SDK sdk.d.ts / sdk-tools.d.ts and the CLI bundle; see README):
 *   assistant tool_use name Task|Agent                     -> subagent_start (subId = tool_use id)
 *   system task_started {task_id, tool_use_id, ...}         -> maps task_id to the helper (starts one if no tool_use was seen)
 *   user tool_result + tool_use_result.status 'async_launched' (text "Async agent launched...") -> background: the helper keeps working
 *   system task_progress {last_tool_name, summary}          -> subagent_activity
 *   system task_notification {status, summary} / task_updated {patch.status} / a user "<task-notification>" message -> subagent_end
 *   a `result` while background helpers are still out is held; the run ends at the next result or when the CLI exits.
 *   HARNESS_DEBUG_EVENTS=1 copies the raw lines to data/debug/ (lib/debug-events.js).
 *
 * Env knobs:
 *   agent.permissionMode     passed as --permission-mode (default | acceptEdits | plan | bypassPermissions);
 *                            HARNESS_PERMISSION_MODE only picks the mode new agents start in
 *
 * Plan mode (agent.permissionMode === 'plan', or `--permission-mode plan` in HARNESS_CLAUDE_ARGS, or an init event reporting
 * permissionMode 'plan'): emits {type:'plan', phase:'start'}; the ExitPlanMode tool_use (input.plan = the plan, markdown) emits
 * {type:'plan', phase:'ready', summary}; if the run ends in plan mode without ExitPlanMode, the final text is the plan.
 * (Only exercised against scripts/fake-claude.js; the real CLI's event shapes for plan mode are from the docs.)
 *   HARNESS_PARTIAL=1        add --include-partial-messages for token streaming
 *   HARNESS_CLAUDE_ARGS      extra args, whitespace separated (e.g. "--model sonnet --allowedTools Bash,Read")
 */
const { spawn } = require('child_process');
const { planSummary } = require('../roles');
const { capture } = require('../debug-events');

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
  return { label: label.length > 32 ? label.slice(0, 31) + '…' : label, kind, hint: String(input.prompt || '').slice(0, 200) };
}

/** the immediate placeholder result of a background Agent call, not its real result */
const isAsyncLaunch = (o, text) => /^(async_launched|remote_launched|teammate_spawned)$/.test((o.tool_use_result && o.tool_use_result.status) || '') || /^Async agent launched/i.test(text);

/** `<task-notification>` text -> { taskId, toolUseId, status, summary, result } or null */
function parseNotification(text) {
  if (!/<task-notification>/.test(text)) return null;
  const tag = (t) => { const m = text.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : ''; };
  return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status'), summary: tag('summary'), result: tag('result') };
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
      args.push('--permission-mode', agent.permissionMode || 'default');
      if (agent.sessionId) args.push('--resume', agent.sessionId);
      if (process.env.HARNESS_CLAUDE_ARGS) args.push(...process.env.HARNESS_CLAUDE_ARGS.split(/\s+/).filter(Boolean));
      const pi = args.lastIndexOf('--permission-mode');
      let planMode = false, planReady = false, lastText = '';
      const launchedPlan = pi >= 0 && args[pi + 1] === 'plan';
      args.push('--', text); // "--" so messages starting with "-" aren't parsed as flags

      let child;
      let finished = false;
      let stderr = '';
      let buf = '';
      let cancelled = false;
      const finish = (ev) => { if (!finished) { finished = true; emit(ev); } };
      const subs = new Map();   // subId (tool_use id) -> { bg } for running subagents
      const tasks = new Map();  // task_id / agentId -> subId
      let heldResult = null;    // a result that arrived while background helpers were still out
      const dbg = capture(agent, 'claude');
      const subOf = (taskId, toolUseId) => (toolUseId && subs.has(toolUseId) ? toolUseId : tasks.get(taskId)) || (subs.has(taskId) ? taskId : null);
      const subStart = (subId, d) => { subs.set(subId, { bg: false }); emit({ type: 'subagent_start', subId, label: d.label, kind: d.kind, hint: d.hint }); };
      const subEnd = (subId, ok, txt) => {
        if (!subId || !subs.has(subId)) return;
        subs.delete(subId);
        emit({ type: 'subagent_end', subId, ok, text: txt || '' });
        if (heldResult) waiting();
      };
      const waiting = () => {
        const n = [...subs.values()].filter((x) => x.bg).length;
        if (n) emit({ type: 'state', state: 'working', tool: 'Agent', summary: `waiting for ${n} background agent${n > 1 ? 's' : ''}` });
        else if (!subs.size) emit({ type: 'state', state: 'thinking' });
      };

      try {
        child = spawn(bin, args, { cwd: agent.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      } catch (e) {
        setImmediate(() => finish({ type: 'error', message: 'Failed to spawn claude: ' + e.message }));
        return { cancel() {} };
      }
      emit({ type: 'state', state: 'thinking' });
      const planStart = () => { if (!planMode) { planMode = true; emit({ type: 'plan', phase: 'start' }); } };
      const planDone = (summary) => { planStart(); if (!planReady) { planReady = true; emit({ type: 'plan', phase: 'ready', summary }); } };
      if (launchedPlan) planStart();

      const handle = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o.session_id && o.type !== 'result') emit({ type: 'session', id: o.session_id });
        if (o.type === 'system' && o.subtype === 'init' && o.permissionMode === 'plan') planStart();
        if (o.type === 'system' && o.subtype === 'init' && Array.isArray(o.slash_commands)) {
          emit({ type: 'commands', names: [...new Set(o.slash_commands.concat(Array.isArray(o.skills) ? o.skills : []).filter((x) => typeof x === 'string'))] });
        }
        switch (o.type) {
          case 'assistant': {
            const content = (o.message && o.message.content) || [];
            const parent = o.parent_tool_use_id;   // set on everything a subagent does
            for (const b of Array.isArray(content) ? content : []) {
              if (parent) { // subagent activity: shown on the helper, not as the parent's own work
                if (b.type === 'tool_use') emit({ type: 'subagent_activity', subId: parent, tool: b.name, summary: summarize(b.name, b.input) });
                continue;
              }
              if (b.type === 'text' && b.text) { lastText = b.text; emit({ type: 'assistant_text', text: b.text }); }
              else if (b.type === 'tool_use' && isTaskTool(b.name)) {
                const d = describeTask(b.input);
                subStart(b.id, d);
                emit({ type: 'state', state: 'working', tool: 'Task', summary: d.label });
              }
              else if (b.type === 'tool_use' && b.name === 'ExitPlanMode') {
                const plan = String((b.input && b.input.plan) || lastText || '');
                emit({ type: 'tool', name: 'ExitPlanMode', summary: planSummary(plan).slice(0, 90) });
                planDone(planSummary(plan));
              }
              else if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, summary: summarize(b.name, b.input) });
              else if (b.type === 'thinking') emit({ type: 'state', state: 'thinking' });
            }
            break;
          }
          case 'user': {
            if (o.parent_tool_use_id) break;       // a subagent's own tool results
            const content = (o.message && o.message.content) || [];
            const n = parseNotification(typeof content === 'string' ? content : resultText(content));
            if (n) { subEnd(subOf(n.taskId, n.toolUseId), n.status === 'completed', n.result || n.summary); break; }
            const results = Array.isArray(content) ? content.filter((b) => b.type === 'tool_result') : [];
            let other = false;
            for (const b of results) {
              const x = subs.get(b.tool_use_id), txt = resultText(b.content);
              if (!x) { other = true; continue; }
              if (!b.is_error && isAsyncLaunch(o, txt)) {
                x.bg = true;
                const id = (o.tool_use_result && (o.tool_use_result.agentId || o.tool_use_result.taskId)) || (txt.match(/agentId:\s*(\S+)/) || [])[1];
                if (id) tasks.set(String(id), b.tool_use_id);
              } else subEnd(b.tool_use_id, !b.is_error, txt);
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
          case 'system': {
            const t = String(o.task_id || '');
            if (!t || o.ambient || o.skip_transcript) break;
            if (o.subtype === 'task_started') {
              let id = subOf(t, o.tool_use_id);
              if (!id && !o.parent_task_id && (o.task_type === 'local_agent' || o.subagent_type)) {
                id = String(o.tool_use_id || t);
                subStart(id, describeTask({ description: o.description, subagent_type: o.subagent_type, prompt: o.prompt }));
              }
              if (id) { tasks.set(t, id); if (o.is_backgrounded) subs.get(id).bg = true; }
            } else if (o.subtype === 'task_progress') {
              const id = subOf(t, o.tool_use_id);
              if (id && (o.last_tool_name || o.summary)) emit({ type: 'subagent_activity', subId: id, tool: String(o.last_tool_name || 'Agent'), summary: summarize('', { description: o.summary || o.description || '' }) });
            } else if (o.subtype === 'task_updated') {
              const id = subOf(t), p = o.patch || {};
              if (id && p.is_backgrounded) subs.get(id).bg = true;
              if (id && /^(completed|failed|killed)$/.test(p.status || '')) subEnd(id, p.status === 'completed', p.error || '');
            } else if (o.subtype === 'task_notification') {
              subEnd(subOf(t, o.tool_use_id), o.status === 'completed', o.summary || '');
            }
            break;
          }
          case 'result': {
            if (o.session_id) emit({ type: 'session', id: o.session_id });
            const isError = !!o.is_error || (o.subtype && o.subtype !== 'success');
            if (planMode && !planReady && !isError) planDone(planSummary(typeof o.result === 'string' && o.result ? o.result : lastText));
            const ev = { type: 'result', text: typeof o.result === 'string' ? o.result : '', isError };
            // background agents still out: the CLI reports back in a later turn, so keep the run open
            if (!isError && [...subs.values()].some((x) => x.bg)) { heldResult = ev; waiting(); break; }
            finish(ev);
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
          dbg.line(line);
          try { handle(JSON.parse(line)); } catch (_) { /* non-JSON noise */ }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
      child.on('error', (e) => finish({ type: 'error', message: 'claude failed to start: ' + e.message }));
      child.on('close', (code, sig) => {
        if (buf.trim()) { dbg.line(buf.trim()); }
        dbg.end();
        if (cancelled) return;
        if (buf.trim()) { try { handle(JSON.parse(buf.trim())); } catch (_) {} }
        if (/No conversation found/i.test(stderr)) emit({ type: 'session', id: null });
        const held = heldResult; heldResult = null;
        for (const id of [...subs.keys()]) subEnd(id, false, 'Claude exited before this agent reported back.');
        if (code === 0) finish(held || { type: 'result', text: '', isError: false });
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
