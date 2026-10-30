'use strict';
// Unit tests for the chat formatter (public/js/chatfmt.js): markdown parsing, link safety, diffs, tool lines.
const C = require('../public/js/chatfmt.js');
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
const flat = (nodes) => nodes.map((n) => n.t === 'text' ? n.v : n.t === 'br' ? '\n' : n.v != null ? n.v : flat(n.c || [])).join('');

const b = C.parse('# Title\n\nSome **bold**, *it*, `x<y>` and [docs](https://example.com/a).\n\n```js\n<script>alert(1)</script>\n```\n\n- one\n  - two\n1. first\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---');
assert(b.map((x) => x.t).join(',') === 'h,p,code,list,list,table,quote,hr', 'block kinds: ' + b.map((x) => x.t).join(','));
assert(b[0].level === 1 && flat(b[0].c) === 'Title', 'heading level + text');
const p = b[1].c;
assert(p.some((n) => n.t === 'b' && flat(n.c) === 'bold') && p.some((n) => n.t === 'i' && flat(n.c) === 'it'), 'bold and italic');
assert(p.some((n) => n.t === 'code' && n.v === 'x<y>'), 'inline code keeps "<" as text');
assert(p.some((n) => n.t === 'a' && n.href === 'https://example.com/a'), 'markdown link');
assert(b[2].lang === 'js' && b[2].v === '<script>alert(1)</script>', 'fenced code: language label + raw text (rendered via textContent)');
assert(b[3].items.map((i) => i.depth).join() === '0,1' && b[4].ordered && b[4].items[0].n === 1, 'nested bullets and ordered list');
assert(b[5].head.length === 2 && flat(b[5].rows[0][1]) === '2', 'table head + cells');
assert(flat(C.inline('2 * 3 * 4')) === '2 * 3 * 4' && !C.inline('snake_case_name').some((n) => n.t === 'i'), 'stray * and snake_case are not italic');
assert(flat(C.inline('\\*not italic\\*')) === '*not italic*', 'backslash escapes');
assert(C.parse('```\nunclosed\nfence')[0].v === 'unclosed\nfence', 'unclosed fence runs to the end');

for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '/relative', '//evil.com', 'file:///etc/passwd'])
  assert(C.safeHref(bad) === null, 'unsafe or relative href dropped: ' + bad);
assert(C.safeHref('https://example.com/x?y=1') === 'https://example.com/x?y=1' && C.safeHref('http://a.b/') === 'http://a.b/', 'http(s) allowed');
assert(C.inline('[x](javascript:alert(1))').every((n) => n.t !== 'a' || C.safeHref(n.href) === null), 'javascript: markdown link never yields a safe href');

const rows = C.patchRows([{ oldStart: 17, newStart: 17, lines: ['  a', '-  b', '+  c', '+  d', '  e'] }, { oldStart: 40, newStart: 41, lines: [' z'] }]);
assert(rows.map((r) => r.k).join('') === ' -++ gap ', 'patch rows: kinds + hunk gap');
assert(rows[1].o === 18 && rows[2].n === 18 && rows[3].n === 19 && rows[4].o === 19 && rows[4].n === 20 && rows[6].o === 40 && rows[6].n === 41, 'patch rows carry old/new line numbers');
const ld = C.lineDiff('a\nb\nc', 'a\nB\nc\nd');
assert(ld.map((r) => r.k + r.v).join('|') === ' a|-b|+B| c|+d', 'LCS line diff: ' + ld.map((r) => r.k + r.v).join('|'));
assert(C.toolDiff({ tool: 'Edit', input: { old_string: 'x', new_string: 'y' } }).length === 2, 'Edit without a patch falls back to old/new diff');
assert(C.toolDiff({ tool: 'Write', input: { content: 'l1\nl2' } }).every((r, i) => r.k === '+' && r.n === i + 1), 'Write shows its content as added lines 1..n');

assert(C.toolArg({ tool: 'Read', input: { file_path: '/w/proj/src/app.js' } }, '/w/proj') === 'src/app.js', 'tool arg: path made relative to the agent cwd');
assert(C.toolArg({ tool: 'Bash', input: { command: 'npm test' } }) === 'npm test' && C.toolArg({ tool: 'Grep', text: 'Grep: TODO' }) === 'TODO', 'tool arg: command, or the summary from old messages');
assert(C.toolResult({ tool: 'Read', status: 'ok', meta: { numLines: 120 } }).text === 'Read 120 lines', 'Read 120 lines');
const r = C.toolResult({ tool: 'Bash', status: 'ok', out: 'l1\nl2\nl3\nl4\nl5' });
assert(r.text === 'l1' && r.more.length === 4, 'Bash: first output line + the rest for "… +N lines"');
assert(C.toolResult({ tool: 'Bash', status: 'running' }).text === 'Running…' && C.toolResult({ tool: 'Bash', status: 'done' }) === null, 'running and no-result states');
const ed = C.toolDiff({ tool: 'Edit', input: { file_path: '/p/x.js' }, meta: { patch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b', '+c'] }] } });
assert(C.toolResult({ tool: 'Edit', status: 'ok', input: { file_path: '/p/x.js' } }, '/p', ed).text === 'Updated x.js with 2 additions and 1 removal', 'Edit result line counts additions/removals');

// resumed Claude sessions draw the same components: tool input, result status/patch and thinking survive the history parse
const { parse } = require('../lib/claude-sessions');
const jl = [
  { type: 'user', cwd: '/p', timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'fix it' } },
  { type: 'assistant', timestamp: '2026-10-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'check the loop' }, { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.js', old_string: 'a', new_string: 'b' } }] } },
  { type: 'user', timestamp: '2026-10-01T00:00:02Z', toolUseResult: { filePath: '/p/a.js', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'updated' }] } },
].map((o) => JSON.stringify(o)).join('\n');
const hm = parse(jl).msgs;
const he = hm.find((m) => m.role === 'tool');
assert(hm.map((m) => m.role).join() === 'user,thinking,tool', 'history roles: ' + hm.map((m) => m.role).join());
assert(he.tool === 'Edit' && he.input.old_string === 'a' && he.status === 'ok' && he.meta.patch[0].oldStart === 3, 'history tool msg carries input, ok status and the structuredPatch');
