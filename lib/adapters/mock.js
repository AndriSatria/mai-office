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
