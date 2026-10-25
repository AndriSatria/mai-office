#!/usr/bin/env node
// Tiny stand-in for the Cursor CLI (`cursor-agent`) emitting its documented stream-json events.
//   HARNESS_CURSOR_BIN=$PWD/scripts/fake-cursor-agent.js npm start
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const prompt = sep >= 0 ? args.slice(sep + 1).join(' ') : (args.filter((a) => !a.startsWith('-')).pop() || '');
const ri = args.indexOf('--resume');
const sid = ri >= 0 ? args[ri + 1] : 'chat-' + Math.random().toString(36).slice(2, 10);
const partial = args.includes('--stream-partial-output');
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), model: 'Fake Model', permissionMode: 'default' });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
  await wait(700);
  if (/parallel|team/i.test(prompt)) { // best-effort guess of how Cursor reports task/subagent tool calls
    out({ type: 'tool_call', subtype: 'started', call_id: 't1', tool_call: { taskToolCall: { args: { description: 'explore repo', subagentType: 'explore' } } } });
    out({ type: 'tool_call', subtype: 'started', call_id: 't2', tool_call: { taskToolCall: { args: { description: 'run tests', subagentType: 'shell' } } } });
    await wait(900);
    out({ type: 'tool_call', subtype: 'completed', call_id: 't1', tool_call: { taskToolCall: { args: { description: 'explore repo' }, result: { success: 'ok' } } } });
    await wait(500);
    out({ type: 'tool_call', subtype: 'completed', call_id: 't2', tool_call: { taskToolCall: { args: { description: 'run tests' }, result: { success: 'ok' } } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: '(fake cursor team) done', session_id: sid });
    return;
  }
  const intro = 'Looking at the code first.';
  if (partial) { for (const w of intro.split(/(\s+)/)) { out({ type: 'assistant', timestamp_ms: Date.now(), message: { role: 'assistant', content: [{ type: 'text', text: w }] } }); await wait(20); }
    out({ type: 'assistant', timestamp_ms: Date.now(), model_call_id: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: intro }] } }); }
  else out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: intro }] } });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'src/index.js' } } } });
  await wait(900);
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: 'src/index.js' }, result: { success: {} } } } });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { shellToolCall: { args: { command: 'npm test' } } } });
  await wait(1200);
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { shellToolCall: { args: { command: 'npm test' }, result: {} } } });
  await wait(500);
  if (/fail/i.test(prompt)) { process.stderr.write('fake cursor-agent: simulated crash\n'); process.exit(2); }
  const text = `(fake cursor-agent, ${ri >= 0 ? 'resumed ' + sid : 'new chat ' + sid}, cwd ${process.cwd()}) You said: ${prompt}`;
  if (partial) { for (const w of text.split(/(\s+)/)) { out({ type: 'assistant', timestamp_ms: Date.now(), message: { role: 'assistant', content: [{ type: 'text', text: w }] } }); await wait(15); }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); }
  else out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 3300, result: intro + text, session_id: sid });
})();
