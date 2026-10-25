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

const TYPE_LABELS = { claude: 'Claude Code', cursor: 'Cursor', mock: 'Mock' };

/**
 * Build the adapter registry. Every agent has a `type` (claude | cursor | mock) and uses that adapter.
 *
 * An adapter is { mode, run({agent, text, emit}) -> { cancel() } }.
 * Adapter events passed to emit():
 *   {type:'session', id}                    CLI session/chat id (for --resume)
 *   {type:'state', state:'thinking'|'working', tool?}
 *   {type:'assistant_delta', text}          streamed chunk
 *   {type:'assistant_text', text}           a complete assistant text block
 *   {type:'tool', name, summary}            tool call started
 *   {type:'tool_result'}                    tool finished -> thinking again
 *   {type:'subagent_start', subId, label, kind}   a helper/subagent was spawned by this agent
 *   {type:'subagent_activity', subId, tool, summary}  what that helper is doing
 *   {type:'subagent_end', subId, ok, text}  the helper reported back
 *   {type:'plan', phase:'start'}            the run is in plan mode (the office gathers at the round table)
 *   {type:'plan', phase:'ready', summary}   the plan was produced (ExitPlanMode / final text): summary bubble + check, then everyone walks back
 *   {type:'result', text, isError}          run finished
 *   {type:'error', message}                 run failed
 *
 * Default type: HARNESS_MODE (claude|cursor|mock) if valid and usable, otherwise auto-detect
 * (claude, then cursor, then mock).
 */
function createRegistry() {
  const claudeBin = process.env.HARNESS_CLAUDE_BIN || findBinary('claude');
  // The Cursor CLI installs as `cursor-agent` (newer builds also expose `agent`).
  const cursorBin = process.env.HARNESS_CURSOR_BIN || findBinary('cursor-agent') || findBinary('agent');
  const types = {
    claude: { id: 'claude', label: TYPE_LABELS.claude, available: !!claudeBin, bin: claudeBin, adapter: require('./claude').create(claudeBin || 'claude') },
    cursor: { id: 'cursor', label: TYPE_LABELS.cursor, available: !!cursorBin, bin: cursorBin, adapter: require('./cursor').create(cursorBin || 'cursor-agent') },
    mock: { id: 'mock', label: TYPE_LABELS.mock, available: true, bin: null, adapter: require('./mock').create() },
  };
  const requested = (process.env.HARNESS_MODE || '').toLowerCase();
  let def = requested;
  if (!types[def]) {
    if (requested) console.warn(`Unknown HARNESS_MODE="${requested}", auto-detecting.`);
    def = claudeBin ? 'claude' : cursorBin ? 'cursor' : 'mock';
  } else if (!types[def].available) {
    console.warn(`HARNESS_MODE=${def} but its CLI was not found on PATH (set HARNESS_${def.toUpperCase()}_BIN). Falling back to mock.`);
    def = 'mock';
  }
  return { defaultType: def, types };
}

module.exports = { createRegistry, findBinary, TYPE_LABELS };
