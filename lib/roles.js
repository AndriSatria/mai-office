'use strict';
// Role derivation + stream-based inference helpers for "team collaboration" visuals.
// Claude subagents cannot really talk to each other, so peer talk is INFERRED from the event stream and always labelled so.

const ROLES = ['security', 'performance', 'tests', 'style', 'docs', 'architecture', 'explore', 'general'];

const ROLE_RE = [
  ['security', /secur|auth|vuln|crypto|xss|inject|owasp|secret|permission|csrf/i],
  ['performance', /perf|speed|latenc|optimi[sz]|slow|memory|bench|throughput/i],
  ['tests', /test|coverage|spec\b|\bqa\b|assert|jest|fixture|mocha|pytest/i],
  ['style', /style|lint|format|prettier|eslint|readab|naming|convention|clean/i],
  ['docs', /\bdocs?\b|readme|comment|changelog|jsdoc|documentation/i],
  ['architecture', /architect|design|structure|dependenc|module|pattern|layering/i],
  ['explore', /explor|search|investigat|research|locate|survey|\bfind\b/i],
];

/** role from the Task input: subagent_type first, then description, then (weakest) the prompt text */
function deriveRole(kind, label, hint) {
  for (const src of [kind, label, hint]) {
    const s = String(src || '');
    for (const [role, re] of ROLE_RE) if (re.test(s)) return role;
  }
  return 'general';
}

const PATH_RE = /(?:[\w.-]+\/)*[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|json|md|css|html|yml|yaml|sh|toml)\b/i;

/** the thing a tool call touches: a file path (by basename) or a search pattern; null when unknown */
function targetOf(tool, summary) {
  const s = String(summary || '').trim();
  if (!s) return null;
  const m = PATH_RE.exec(s);
  if (m) { const base = m[0].split('/').pop().toLowerCase(); return { key: base, text: base }; }
  if (/^(Grep|Glob)$/i.test(tool || '') && s.length > 3) return { key: 'pat:' + s.toLowerCase(), text: s.length > 24 ? s.slice(0, 23) + '…' : s };
  return null;
}

/** "found 3 issues" style bubble text for a finished helper */
function shortSummary(text, ok) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /(\d+)\s+(issues?|problems?|findings?|vulnerabilit\w+|warnings?|suggestions?|failures?|errors?|violations?|regressions?)/i.exec(t);
  if (m) return `found ${m[1]} ${m[2].toLowerCase()}`;
  if (!ok) return 'failed: ' + (t ? t.slice(0, 24) : 'no result');
  if (!t) return 'all done';
  const first = t.split(/[.!;:]/)[0].trim();
  return first.length > 30 ? first.slice(0, 29) + '…' : first || 'all done';
}

const MENTION_RE = {
  security: /\bsecurity|vulnerab|\bauth\b/i, performance: /\bperformance|latency|\bslow\b/i, tests: /\btests?\b|coverage/i,
  style: /\bstyle|\blint/i, docs: /\bdocs?\b|readme/i, architecture: /\barchitect|\bdesign\b/i,
};
/** roles other than `own` that the result text talks about */
function mentionedRoles(text, own) {
  const out = [];
  for (const r of Object.keys(MENTION_RE)) if (r !== own && MENTION_RE[r].test(text || '')) out.push(r);
  return out;
}

/** first lines of a plan (markdown) as one short line for the bubble over the round table */
function planSummary(t) {
  const lines = String(t || '').split(/\r?\n/).map((x) => x.replace(/^[#>*\-\d.)\s`]+/, '').replace(/[*`_]/g, '').trim()).filter(Boolean);
  let s = ''; lines.slice(0, 3).forEach((l, i) => { s += (i ? (/[:：]$/.test(lines[i - 1]) ? ' ' : ' · ') : '') + l; });
  return s.length > 150 ? s.slice(0, 147) + '…' : s;
}

module.exports = { planSummary, ROLES, deriveRole, targetOf, shortSummary, mentionedRoles };
