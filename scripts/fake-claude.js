#!/usr/bin/env node
// Tiny stand-in for the `claude` CLI that emits stream-json in the documented shape.
// Used to exercise the claude adapter without a real install:
//   HARNESS_MODE=claude HARNESS_CLAUDE_BIN=$PWD/scripts/fake-claude.js npm start
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const prompt = sep >= 0 ? args.slice(sep + 1).join(' ') : '';
const ri = args.indexOf('--resume');
const sid = ri >= 0 ? args[ri + 1] : 'fake-session-' + Math.random().toString(36).slice(2, 8);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Parallel subagents the way Claude Code streams them: one assistant message with several `Task` tool_use blocks,
// subagent activity tagged with parent_tool_use_id, and a tool_result per Task in the parent's next user message.
async function team() {
  const tasks = [['toolu_a', 'explore repo', 'Explore'], ['toolu_b', 'run tests', 'general-purpose'], ['toolu_c', 'review diff', 'code-reviewer']];
  const failC = /fail/i.test(prompt);
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Splitting this into three helpers.' },
    ...tasks.map(([id, description, subagent_type]) => ({ type: 'tool_use', id, name: 'Task', input: { description, subagent_type, prompt: description + ' for: ' + prompt } }))] } });
  await wait(500);
  const act = (id, name, input) => out({ type: 'assistant', session_id: sid, parent_tool_use_id: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sub_' + id + name, name, input }] } });
  act('toolu_a', 'Glob', { pattern: '**/*.js' }); act('toolu_b', 'Bash', { command: 'npm test' }); act('toolu_c', 'Read', { file_path: 'src/utils.js' });
  await wait(700);
  out({ type: 'user', session_id: sid, parent_tool_use_id: 'toolu_a', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sub_toolu_aGlob', content: 'a.js b.js' }] } });
  act('toolu_a', 'Read', { file_path: 'src/index.js' }); act('toolu_c', 'Grep', { pattern: 'console.log' });
  await wait(600);
  // partial text of a subagent must be ignored
  out({ type: 'stream_event', session_id: sid, parent_tool_use_id: 'toolu_b', event: { delta: { type: 'text_delta', text: 'SUBAGENT-NOISE' } } });
  out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'explored: 12 files' }] }] } });
  await wait(600);
  out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'tests ok' }] } });
  await wait(400);
  out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c', is_error: failC, content: failC ? 'reviewer crashed' : 'no issues' }] } });
  await wait(500);
  const text = `(fake claude team) three helpers reported back. You said: ${prompt}`;
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
}

// `/code-review` the way current Claude Code runs it: 4 `Agent` calls that run in the background (shapes from the Agent SDK sdk.d.ts and
// the CLI bundle). Each launch gets task_started plus an immediate "Async agent launched" tool_result (tool_use_result.status
// 'async_launched'); progress comes as task_progress; the first `result` arrives while all 4 are still out; each real completion is a
// task_notification (one arrives only as a "<task-notification>" user message, one also as task_updated), then a follow-up turn and a
// second `result`. "exit-early" in the prompt exits after the first result, like older -p builds did.
async function codeReviewBg() {
  const tasks = [
    ['toolu_sec', 'a1sec', 'Security review of auth changes', 'security-reviewer', 'src/auth.js'], ['toolu_perf', 'a2perf', 'Performance analysis of the API layer', 'performance-analyst', 'src/api.js'],
    ['toolu_test', 'a3test', 'Check test coverage of changed files', 'test-runner', 'test/auth.test.js'], ['toolu_style', 'a4style', 'Style and lint check', 'style-linter', 'src/'],
  ];
  const slow = Number(process.env.FAKE_CLAUDE_BG_MS || 700);
  const sys = (subtype, o) => out({ type: 'system', subtype, uuid: 'u' + Math.random().toString(36).slice(2), session_id: sid, ...o });
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Launching four reviewers in the background.' },
    ...tasks.map(([id, , description, subagent_type]) => ({ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type, prompt: description + '. Review the diff of this branch.', run_in_background: true } }))] } });
  for (const [id, aid, description, subagent_type] of tasks) {
    sys('task_started', { task_id: aid, tool_use_id: id, description, subagent_type, task_type: 'local_agent', is_backgrounded: true });
    out({ type: 'user', session_id: sid, parent_tool_use_id: null, tool_use_result: { status: 'async_launched', agentId: aid, description, prompt: description, outputFile: `/tmp/fake/tasks/${aid}.output` },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${aid} (internal ID - do not mention to user. Use SendMessage with to: '${aid}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.` }] }] } });
  }
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Waiting for 4 background agents to finish.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Waiting for 4 background agents to finish.', session_id: sid });
  if (/exit-early/i.test(prompt)) return;
  const prog = (i, tool, what) => { const [id, aid, description, subagent_type] = tasks[i]; sys('task_progress', { task_id: aid, tool_use_id: id, description, subagent_type, last_tool_name: tool, summary: what, usage: { total_tokens: 900 * (i + 1), tool_uses: 2, duration_ms: 1500 } }); };
  const note = (i, status, summary) => { const [id, aid] = tasks[i]; sys('task_notification', { task_id: aid, tool_use_id: id, status, output_file: `/tmp/fake/tasks/${aid}.output`, summary, usage: { total_tokens: 4000, tool_uses: 6, duration_ms: 9000 } }); };
  await wait(slow);
  tasks.forEach(([, , , , file], i) => prog(i, i === 3 ? 'Bash' : 'Read', (i === 3 ? 'Running npx eslint ' : 'Reading ') + file));
  await wait(slow);
  prog(0, 'Grep', 'Searching for token|secret'); prog(1, 'Read', 'Reading src/db.js'); prog(2, 'Bash', 'Running npm test');
  await wait(slow);
  sys('task_updated', { task_id: 'a4style', patch: { status: 'failed', error: 'eslint config missing, could not lint', end_time: Date.now() } });
  note(3, 'failed', 'Agent "Style and lint check" failed: eslint config missing');
  await wait(slow);
  note(1, 'completed', 'Found 2 issues: N+1 query in src/api.js.');
  await wait(slow);
  note(2, 'completed', 'Found 1 issue: no test for token expiry.');
  await wait(slow);
  // the security agent's completion only shows up as the queued task-notification prompt
  out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: '<task-notification>\n<task-id>a1sec</task-id>\n<tool-use-id>toolu_sec</tool-use-id>\n<status>completed</status>\n<summary>Agent "Security review of auth changes" completed</summary>\n<result>Found 3 issues: token never expires in src/auth.js. The tests reviewer should cover that.</result>\n</task-notification>' } });
  await wait(300);
  const text = '(fake claude background code-review) Security 3 issues, performance 2, tests 1, style failed.';
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
}

// The older foreground shape: 4 Task calls with typed subagents, overlapping file reads, different durations, one failure.
async function codeReview() {
  const tasks = [
    ['toolu_sec', 'Security review of auth changes', 'security-reviewer'], ['toolu_perf', 'Performance analysis of the API layer', 'performance-analyst'],
    ['toolu_test', 'Check test coverage of changed files', 'test-runner'], ['toolu_style', 'Style and lint check', 'style-linter'],
  ];
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Launching four reviewers in parallel.' },
    ...tasks.map(([id, description, subagent_type]) => ({ type: 'tool_use', id, name: 'Task', input: { description, subagent_type, prompt: description + '. Review the diff of this branch.' } }))] } });
  const act = (id, name, input) => out({ type: 'assistant', session_id: sid, parent_tool_use_id: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sub_' + id + name + Math.random(), name, input }] } });
  const end = (id, content, is_error) => out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!is_error, content: [{ type: 'text', text: content }] }] } });
  await wait(300);
  act('toolu_sec', 'Grep', { pattern: 'token|secret' }); act('toolu_perf', 'Read', { file_path: 'src/api.js' }); act('toolu_test', 'Bash', { command: 'npm test' }); act('toolu_style', 'Bash', { command: 'npx eslint src' });
  await wait(400);
  act('toolu_sec', 'Read', { file_path: 'src/auth.js' }); act('toolu_perf', 'Read', { file_path: 'src/api.js' }); act('toolu_test', 'Read', { file_path: 'src/auth.js' });   // overlaps: sec/test on auth.js, perf/sec on api.js
  await wait(400);
  act('toolu_sec', 'Read', { file_path: 'src/api.js' });
  end('toolu_style', 'eslint config missing, could not lint', true);
  await wait(400);
  end('toolu_perf', 'Found 2 issues: N+1 query in src/api.js.');
  await wait(300);
  end('toolu_test', 'Found 1 issue: no test for token expiry.');
  await wait(300);
  end('toolu_sec', 'Found 3 issues: token never expires in src/auth.js. The tests reviewer should cover that.');
  await wait(300);
  const text = '(fake claude code-review) Security 3 issues, performance 2, tests 1, style failed.';
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
}

// Plan mode (`--permission-mode plan`): read-only exploration, the plan as text, then the ExitPlanMode tool_use (which headless runs get denied), then the result.
async function plan() {
  const plan = '## Plan: ' + prompt.slice(0, 50) + '\n1. Read the entry points.\n2. Change the handler.\n3. Add tests.';
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Exploring first (plan mode, read-only).' }, { type: 'tool_use', id: 'p1', name: 'Read', input: { file_path: 'src/index.js' } }] } });
  await wait(700);
  out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } });
  await wait(500);
  out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: plan }] } });
  await wait(500);
  if (!/noexit/i.test(prompt)) out({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p2', name: 'ExitPlanMode', input: { plan } }] } });
  await wait(500);
  if (!/noexit/i.test(prompt)) out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p2', is_error: true, content: 'Exit plan mode? (needs approval)' }] } });
  const text = '(fake claude plan) ' + plan;
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
}

(async () => {
  const pmi = args.indexOf('--permission-mode'), pmode = pmi >= 0 ? args[pmi + 1] : undefined;
  out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), tools: ['Bash', 'Read'], permissionMode: pmode || 'default',
    slash_commands: ['compact', 'cost', 'clear', 'model', 'security-review', 'frontend:component'], skills: ['pdf'] });
  if (pmode === 'plan') { await plan(); return; }
  if (/code-review/i.test(prompt) && /foreground/i.test(prompt)) { await codeReview(); return; }
  if (/code-review/i.test(prompt)) { await codeReviewBg(); return; }
  if (/parallel|team/i.test(prompt)) { await team(); return; }
  await wait(600);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } });
  await wait(1200);
  out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'files' }] } });
  await wait(600);
  if (/fail/i.test(prompt)) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Simulated Claude failure: the build exploded.', session_id: sid }); return; }
  const text = `(fake claude, ${ri >= 0 ? 'resumed ' + sid : 'new session ' + sid}, cwd ${process.cwd()}, mode ${pmode || 'none'}) You said: ${prompt}`;
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
})();
