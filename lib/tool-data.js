'use strict';
// The slice of tool inputs/results the chat panel draws (paths, commands, diffs, todos, line counts), size-capped so transcripts stay small.
const CAP = 2000;
const cap = (s, n = CAP) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '\n…' : s) : undefined);
const num = (v) => (Number.isFinite(v) ? v : undefined);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return Object.keys(o).length ? o : null; };

/** tool_use input -> the fields the chat renders */
function toolInput(input) {
  const i = input && typeof input === 'object' ? input : {};
  const todos = Array.isArray(i.todos) ? i.todos.slice(0, 30).map((t) => ({ content: cap(String((t && t.content) || ''), 200), status: String((t && t.status) || 'pending'), activeForm: cap(t && t.activeForm, 200) })) : undefined;
  const edits = Array.isArray(i.edits) ? i.edits.slice(0, 10).map((e) => ({ old_string: cap(e && e.old_string) || '', new_string: cap(e && e.new_string) || '' })) : undefined;
  return clean({
    file_path: cap(i.file_path || i.filePath || i.path, 300), command: cap(i.command, 600), pattern: cap(i.pattern || i.globPattern, 300), url: cap(i.url, 300), query: cap(i.query, 300),
    description: cap(i.description, 300), old_string: cap(i.old_string), new_string: cap(i.new_string), content: cap(i.content || i.fileText), replace_all: i.replace_all || undefined,
    offset: num(i.offset), limit: num(i.limit), todos, edits,
  });
}

/** Claude's structured tool_use_result (FileReadOutput, FileEditOutput, GlobOutput, ...) -> counts and the patch */
function toolResult(r) {
  if (!r || typeof r !== 'object') return null;
  const f = r.file && typeof r.file === 'object' ? r.file : {};
  let left = 300;
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch.slice(0, 20).map((h) => {
    const lines = Array.isArray(h.lines) ? h.lines.slice(0, Math.max(0, left)).map((l) => cap(String(l), 400)) : [];
    left -= lines.length;
    return { oldStart: num(h.oldStart), newStart: num(h.newStart), lines };
  }).filter((h) => h.lines.length) : undefined;
  return clean({ numLines: num(f.numLines) ?? num(r.numLines), totalLines: num(f.totalLines) ?? num(r.totalLines), startLine: num(f.startLine), numFiles: num(r.numFiles),
    kind: r.type === 'create' || r.type === 'update' ? r.type : undefined, patch: patch && patch.length ? patch : undefined });
}

/** a `result` event -> {durationMs, turns, costUsd} when the CLI sent them */
function runMeta(o) {
  return clean({ durationMs: num(o.duration_ms), turns: num(o.num_turns), costUsd: num(o.total_cost_usd) });
}

module.exports = { toolInput, toolResult, runMeta, cap };
