'use strict';
const fs = require('fs');
const path = require('path');

/** Find an executable on PATH (returns absolute path or null). */
function findBinary(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Pick the adapter. HARNESS_MODE=claude|mock forces one; otherwise `claude`
 * if the binary is on PATH, else `mock`.
 *
 * An adapter is { mode, run({agent, text, emit}) -> { cancel() } }.
 * Adapter events passed to emit():
 *   {type:'session', id}                    Claude session id (for --resume)
 *   {type:'state', state:'thinking'|'working', tool?}
 *   {type:'assistant_delta', text}          streamed chunk
 *   {type:'assistant_text', text}           a complete assistant text block
 *   {type:'tool', name, summary}            tool_use
 *   {type:'tool_result'}                    tool finished -> thinking again
 *   {type:'result', text, isError}          run finished
 *   {type:'error', message}                 run failed
 */
function createAdapter() {
  const requested = (process.env.HARNESS_MODE || '').toLowerCase();
  const bin = process.env.HARNESS_CLAUDE_BIN || findBinary('claude');
  let mode = requested;
  if (mode !== 'claude' && mode !== 'mock') {
    if (requested) console.warn(`Unknown HARNESS_MODE="${requested}", auto-detecting.`);
    mode = bin ? 'claude' : 'mock';
  }
  if (mode === 'claude' && !bin) {
    console.warn('HARNESS_MODE=claude but no `claude` binary found on PATH (set HARNESS_CLAUDE_BIN). Falling back to mock.');
    mode = 'mock';
  }
  if (mode === 'claude') return require('./claude').create(bin);
  return require('./mock').create();
}

module.exports = { createAdapter, findBinary };
