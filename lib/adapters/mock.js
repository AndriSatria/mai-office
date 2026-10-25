'use strict';
const path = require('path');
const { planSummary } = require('../roles');

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
// "/code-review" scenario: 4 role helpers, overlapping files (auth.js: security+tests, api.js: security+performance), different durations, one failure
const REVIEW = [
  { label: 'security review', kind: 'security-reviewer', gap: 1700, ok: true, text: 'Found 3 issues: the token never expires in src/auth.js. The tests helper should cover the expiry path.',
    steps: [['Grep', 'password|token|secret'], ['Read', 'src/auth.js'], ['Read', 'src/api.js'], ['Grep', 'jwt.sign']] },
  { label: 'performance check', kind: 'performance-analyst', gap: 1500, ok: true, text: 'Found 2 issues: N+1 query in src/api.js, cache never invalidated.',
    steps: [['Read', 'src/api.js'], ['Bash', 'node bench/run.js'], ['Read', 'src/cache.js']] },
  { label: 'test coverage', kind: 'test-runner', gap: 1900, ok: true, text: 'Found 1 issue: no test for token expiry in src/auth.js.',
    steps: [['Bash', 'npm test --silent'], ['Read', 'test/auth.test.js'], ['Read', 'src/auth.js']] },
  { label: 'style & lint', kind: 'style-linter', gap: 1600, ok: false, text: 'eslint config missing, could not lint (simulated failure).',
    steps: [['Bash', 'npx eslint src'], ['Read', '.eslintrc.json']] },
];
// plan mode ("/plan <task>" or a plan-mode agent): explore read-only, write a plan, then ExitPlanMode -> plan ready
const PLAN_STEPS = [['Read', (d) => `${d}/README.md`], ['Glob', () => 'src/**/*.js'], ['Grep', () => 'TODO|FIXME'], ['Read', (d) => `${d}/src/index.js`]];
const planText = (task) => `Plan: ${task}\n\n1. Read the entry points.\n2. Make the change in small steps.\n3. Add tests, run the suite, update the docs.`;
const TEAM_RE = /^\/team\b|\b(in parallel|parallel helpers|team task|use helpers|subagents?)\b/i;

const rand = (a, b) => a + Math.random() * (b - a);
const SLOW = Math.max(0.2, +process.env.HARNESS_SLOW || 1);   // demo pacing (see lib/harness.js)

/** Simulated agent: emits thinking -> tool use -> streamed reply -> result. */
function create() {
  return {
    mode: 'mock',
    run({ agent, text, emit }) {
      const timers = [];
      let cancelled = false;
      const at = (ms, fn) => timers.push(setTimeout(() => { if (!cancelled) fn(); }, ms * SLOW));
      const dir = path.basename(agent.cwd) || agent.cwd;

      if (!agent.sessionId) emit({ type: 'session', id: 'mock-' + agent.id });
      emit({ type: 'state', state: 'thinking' });

      // plan mode: the whole office gathers at the round table while this agent explores and writes the plan (no edits)
      if (agent.permissionMode === 'plan') {
        const task = text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'the task';
        let t = 700;
        at(0, () => emit({ type: 'plan', phase: 'start' }));
        for (const [name, mk] of PLAN_STEPS) {
          at(t, () => emit({ type: 'tool', name, summary: mk(dir) })); t += rand(1300, 1900);
          at(t, () => emit({ type: 'tool_result' })); t += rand(350, 600);
        }
        const plan = planText(task);
        at(t, () => emit({ type: 'state', state: 'working' }));
        let acc = '';
        for (const w of plan.split(/(\s+)/)) { t += rand(18, 40); acc += w; const chunk = w; at(t, () => emit({ type: 'assistant_delta', text: chunk })); }
        t += 400; const full = acc;
        at(t, () => emit({ type: 'assistant_text', text: full }));
        t += 700;
        at(t, () => { emit({ type: 'tool', name: 'ExitPlanMode', summary: `plan: ${task.slice(0, 50)}` }); emit({ type: 'plan', phase: 'ready', summary: planSummary(full) }); });
        t += 900;
        at(t, () => emit({ type: 'tool_result' }));
        at(t + 500, () => emit({ type: 'result', text: full + '\n\nPlan ready. Say "go ahead" (with plan mode off) to implement it.', isError: false }));
        return { cancel() { cancelled = true; timers.forEach(clearTimeout); } };
      }

      // "/team <task>" (or a message asking for parallel helpers; ~12% of long messages too) spawns 2-3 helpers;
      // "/code-review" spawns 4 role helpers (security, performance, tests, style) with overlapping files and one failure
      const review = /^\/code-review\b/i.test(text);
      const team = review || TEAM_RE.test(text) || (text.length > 40 && Math.random() < 0.12);
      if (team) {
        const task = text.replace(/^\/(team|code-review)\s*/i, '').trim() || (review ? 'the current diff' : 'the task');
        let plan;
        if (review) plan = REVIEW;
        else {
          const n = /^\/team\b/i.test(text) ? 3 : 2 + Math.floor(Math.random() * 2);
          const failLast = /\b(error|fail|crash|break)\b/i.test(task);
          plan = [...HELPERS].sort(() => Math.random() - 0.5).slice(0, n).map(([label, kind, steps], i) => {
            const ok = !(failLast && i === n - 1);
            return { label, kind, steps, gap: rand(1000, 1500), ok, text: ok ? `${label}: nothing blocking, 2 suggestions.` : `${label}: failed (simulated).` };
          });
        }
        const n = plan.length, failed = plan.filter((p) => !p.ok).length;
        let tt = rand(900, 1300);
        at(tt, () => emit({ type: 'state', state: 'thinking' }));
        tt += 900;
        const intro = review ? `Reviewing ${task}: I'll ask ${n} specialists (security, performance, tests, style) and merge their findings.` : `I'll split "${task.slice(0, 60)}" across ${n} helpers and merge what they find.`;
        at(tt, () => emit({ type: 'assistant_text', text: intro }));
        let lastEnd = 0;
        plan.forEach((h, i) => {
          const t0 = tt + 700 + i * (review ? 800 : 450);
          const id = `mock-sub-${agent.id}-${Date.now().toString(36)}-${i}`;
          at(t0, () => { emit({ type: 'subagent_start', subId: id, label: h.label, kind: h.kind }); emit({ type: 'state', state: 'working', tool: 'Task', summary: `${n} helpers` }); });
          let tc = t0 + 1300;
          for (const [tool, summary] of h.steps) { at(tc, () => emit({ type: 'subagent_activity', subId: id, tool, summary })); tc += h.gap; }
          const endAt = tc + 300 + (review ? 0 : i * 500);
          at(endAt, () => emit({ type: 'subagent_end', subId: id, ok: h.ok, text: h.text }));
          lastEnd = Math.max(lastEnd, endAt);
        });
        let t = lastEnd + 1500;
        at(lastEnd + 200, () => emit({ type: 'tool_result' }));
        const reply = review
          ? `Code review done. ${n} reviewers reported back.\n\n- security: 3 issues (token never expires in src/auth.js)\n- performance: 2 issues (N+1 query in src/api.js)\n- tests: 1 issue (no token-expiry test)\n- style: reviewer failed (eslint config missing), so I skipped it\n\nWant me to fix the security issues first?`
          : `All ${n} helpers reported back.\n\n- explored the code, ran the checks and reviewed the diff\n- merged their notes into one summary${failed ? '\n- one helper failed, so I flagged it' : ''}\n\nWant me to apply the changes?`;
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
