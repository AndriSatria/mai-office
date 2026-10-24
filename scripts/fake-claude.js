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
(async () => {
  out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), tools: ['Bash', 'Read'] });
  await wait(600);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } });
  await wait(1200);
  out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'files' }] } });
  await wait(600);
  if (/fail/i.test(prompt)) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Simulated Claude failure: the build exploded.', session_id: sid }); return; }
  const text = `(fake claude, ${ri >= 0 ? 'resumed ' + sid : 'new session ' + sid}, cwd ${process.cwd()}) You said: ${prompt}`;
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
})();
