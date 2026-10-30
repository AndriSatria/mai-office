'use strict';
// HARNESS_DEBUG_EVENTS=1: copy every raw stdout line of a CLI run to data/debug/<agent>-<time>.jsonl (may contain code and prompts).
const fs = require('fs');
const path = require('path');

const dir = () => process.env.HARNESS_DEBUG_DIR || path.join(__dirname, '..', 'data', 'debug');

/** -> { line(s), end() } that writes nothing unless HARNESS_DEBUG_EVENTS=1 */
function capture(agent, tool) {
  if (process.env.HARNESS_DEBUG_EVENTS !== '1') return { line() {}, end() {} };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const who = String((agent && (agent.name || agent.id)) || 'agent').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
    const file = path.join(dir(), `${who}-${tool}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const out = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    out.on('error', () => {});   // a full disk must not break the run
    return { file, line(s) { out.write(s + '\n'); }, end() { out.end(); } };
  } catch (_) { return { line() {}, end() {} }; }
}

module.exports = { capture };
