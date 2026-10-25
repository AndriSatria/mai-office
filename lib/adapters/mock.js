'use strict';
const path = require('path');

const TOOLS = [
  ['Read', (d) => `${d}/src/index.js`],
  ['Grep', () => 'TODO|FIXME'],
  ['Bash', () => 'npm test --silent'],
  ['Edit', (d) => `${d}/src/utils.js`],
  ['Glob', () => '**/*.test.js'],
  ['Write', (d) => `${d}/NOTES.md`],
];

const REPLIES = [
  (m, d) => `Got it. I looked around ${d} and here's my take on "${m}":\n\n1. The relevant code lives in src/ and looks healthy.\n2. I tidied a helper and ran the tests - all green.\n\nWant me to go deeper?`,
  (m, d) => `Done! Regarding "${m}" - I made the change in ${d}, ran the checks, and everything passes. Let me know what's next.`,
  (m) => `Sure thing. I investigated "${m}", found two spots worth changing, patched them, and left notes in NOTES.md.`,
];

// Helpers a mock "team task" can spawn: [label, kind, [[tool, summary]...]]
const HELPERS = [
  ['explore repo', 'Explore', [['Glob', '**/*.js'], ['Read', 'src/index.js'], ['Grep', 'TODO|FIXME']]],
  ['run tests', 'Bash', [['Bash', 'npm test --silent'], ['Read', 'test/report.txt']]],
  ['review diff', 'code-reviewer', [['Read', 'src/utils.js'], ['Grep', 'console.log'], ['Read', 'src/api.js']]],
  ['check docs', 'docs', [['Grep', 'README'], ['Read', 'README.md']]],
  ['write fixtures', 'general-purpose', [['Write', 'test/fixtures.json'], ['Edit', 'test/setup.js']]],
];
const TEAM_RE = /^\/team\b|\b(in parallel|parallel helpers|team task|use helpers|subagents?)\b/i;

const rand = (a, b) => a + Math.random() * (b - a);

/** Simulated agent: emits thinking -> tool use -> streamed reply -> result. */
function create() {
  return {
    mode: 'mock',
    run({ agent, text, emit }) {
      const timers = [];
      let cancelled = false;
      const at = (ms, fn) => timers.push(setTimeout(() => { if (!cancelled) fn(); }, ms));
      const dir = path.basename(agent.cwd) || agent.cwd;

      if (!agent.sessionId) emit({ type: 'session', id: 'mock-' + agent.id });
      emit({ type: 'state', state: 'thinking' });

      // "/team <task>" (or a message that asks for parallel helpers; ~12% of long messages too) spawns 2-3 helpers
      const team = TEAM_RE.test(text) || (text.length > 40 && Math.random() < 0.12);
      if (team) {
        const task = text.replace(/^\/team\s*/i, '').trim() || 'the task';
        const n = /^\/team\b/i.test(text) ? 3 : 2 + Math.floor(Math.random() * 2);
        const picks = [...HELPERS].sort(() => Math.random() - 0.5).slice(0, n);
        const failLast = /\b(error|fail|crash|break)\b/i.test(task);
        let tt = rand(900, 1300);
        at(tt, () => emit({ type: 'state', state: 'thinking' }));
        tt += 900;
        at(tt, () => emit({ type: 'assistant_text', text: `I'll split "${task.slice(0, 60)}" across ${n} helpers and merge what they find.` }));
        let lastEnd = 0;
        picks.forEach(([label, kind, tools], i) => {
          const t0 = tt + 500 + i * 450;
          const id = `mock-sub-${agent.id}-${Date.now().toString(36)}-${i}`;
          at(t0, () => { emit({ type: 'subagent_start', subId: id, label, kind }); emit({ type: 'state', state: 'working', tool: 'Task', summary: `${n} helpers` }); });
          let tc = t0 + 900;
          for (const [tool, summary] of tools) { at(tc, () => emit({ type: 'subagent_activity', subId: id, tool, summary })); tc += rand(1000, 1500); }
          const ok = !(failLast && i === n - 1);
          at(tc + 300 + i * 500, () => emit({ type: 'subagent_end', subId: id, ok, text: ok ? `${label}: nothing blocking, 2 suggestions.` : `${label}: failed (simulated).` }));
          lastEnd = Math.max(lastEnd, tc + 300 + i * 500);
        });
        let t = lastEnd + 1500;
        at(lastEnd + 200, () => emit({ type: 'tool_result' }));
        const reply = `All ${n} helpers reported back.\n\n- explored the code, ran the checks and reviewed the diff\n- merged their notes into one summary${failLast ? '\n- one helper failed, so I flagged it' : ''}\n\nWant me to apply the changes?`;
        at(t, () => emit({ type: 'state', state: 'working' }));
        let acc = '';
        for (const w of reply.split(/(\s+)/)) { t += rand(20, 50); acc += w; const chunk = w; at(t, () => emit({ type: 'assistant_delta', text: chunk })); }
        t += 250; const full = acc;
        at(t, () => emit({ type: 'assistant_text', text: full }));
        at(t + 100, () => emit({ type: 'result', text: full, isError: false }));
        return { cancel() { cancelled = true; timers.forEach(clearTimeout); } };
      }

      let t = rand(900, 1600);
      const fail = /\b(error|fail|crash|break)\b/i.test(text);
      const n = fail ? 1 : 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const [name, mk] = TOOLS[Math.floor(Math.random() * TOOLS.length)];
        const summary = mk(dir);
        at(t, () => emit({ type: 'tool', name, summary }));
        t += rand(1500, 2600);
        at(t, () => emit({ type: 'tool_result' }));
        t += rand(400, 800);
      }

      if (fail) {
        at(t, () => emit({ type: 'error', message: 'Simulated failure: the build exploded (mock mode).' }));
      } else {
        const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)](text.slice(0, 80), dir);
        const words = reply.split(/(\s+)/);
        let acc = '';
        at(t, () => emit({ type: 'state', state: 'working' }));
        for (const w of words) {
          t += rand(25, 70);
          acc += w;
          const chunk = w;
          at(t, () => emit({ type: 'assistant_delta', text: chunk }));
        }
        t += 250;
        const full = acc;
        at(t, () => emit({ type: 'assistant_text', text: full }));
        at(t + 100, () => emit({ type: 'result', text: full, isError: false }));
      }

      return { cancel() { cancelled = true; timers.forEach(clearTimeout); } };
    },
  };
}

module.exports = { create };
