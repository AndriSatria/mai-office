/* Claude Code style chat formatting: a tiny markdown parser, line diffs and per-message DOM builders.
   Model text only ever reaches the page through textContent / createTextNode, never innerHTML. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.ChatFmt = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- markdown ----------
  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

  /** markdown text -> block list; blocks hold inline node lists */
  function parse(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n'), out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push({ t: 'p', c: inline(para.join('\n')) }); para = []; } };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if ((m = FENCE.exec(l))) {
        flush();
        const body = [], close = new RegExp('^\\s*' + m[1][0] + '{' + m[1].length + ',}\\s*$');
        for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
        out.push({ t: 'code', lang: m[2] || '', v: body.join('\n') });
        continue;
      }
      if (!l.trim()) { flush(); continue; }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { flush(); out.push({ t: 'h', level: m[1].length, c: inline(m[2]) }); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push({ t: 'hr' }); continue; }
      if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush();
        const head = cells(l).map(inline), rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]).map(inline));
        i--;
        out.push({ t: 'table', head, rows });
        continue;
      }
      if (/^\s{0,3}>/.test(l)) {
        flush();
        const q = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i--;
        out.push({ t: 'quote', c: parse(q.join('\n')) });
        continue;
      }
      if ((m = LIST.exec(l))) {
        flush();
        const ordered = /\d/.test(m[2]), items = [];
        for (; i < lines.length; i++) {
          const k = LIST.exec(lines[i]);
          if (k && /\d/.test(k[2]) === ordered) items.push({ depth: Math.min(4, Math.floor(k[1].replace(/\t/g, '  ').length / 2)), n: ordered ? parseInt(k[2], 10) : 0, raw: k[3] });
          else if (k) break;
          else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1].raw += '\n' + lines[i].trim();
          else break;
        }
        i--;
        out.push({ t: 'list', ordered, items: items.map((x) => { const tm = /^\[([ xX])\]\s+(.*)$/s.exec(x.raw); return { depth: x.depth, n: x.n, task: tm ? (tm[1] !== ' ') : null, c: inline(tm ? tm[2] : x.raw) }; }) });
        continue;
      }
      para.push(l);
    }
    flush();
    return out;
  }

  /** inline markdown -> nodes {t:'text'|'code'|'b'|'i'|'s'|'a'|'br'} */
  function inline(s) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
    for (let i = 0; i < s.length;) {
      const c = s[i], rest = s.slice(i), prev = s[i - 1] || '';
      let m;
      if (c === '\\' && /[\\`*_[\]()#+\-.!|>~]/.test(s[i + 1] || '')) { buf += s[i + 1]; i += 2; continue; }
      if (c === '\n') { flush(); out.push({ t: 'br' }); i++; continue; }
      if (c === '`' && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { flush(); out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') }); i += m[0].length; continue; }
      if (c === '[' && (m = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) { flush(); out.push({ t: 'a', href: m[2], c: inline(m[1]) }); i += m[0].length; continue; }
      if ((c === 'h' || c === 'H') && !/\w/.test(prev) && (m = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_`]/i.exec(rest))) { flush(); out.push({ t: 'a', href: m[0], c: [{ t: 'text', v: m[0] }] }); i += m[0].length; continue; }
      if ((c === '*' || c === '_') && (m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)) && (c === '*' || !/\w/.test(prev))) { flush(); out.push({ t: 'b', c: inline(m[2]) }); i += m[0].length; continue; }
      if ((c === '*' || c === '_') && (m = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_\w])/.exec(rest)) && (c === '*' || !/\w/.test(prev))) { flush(); out.push({ t: 'i', c: inline(m[2]) }); i += m[0].length; continue; }
      if (c === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { flush(); out.push({ t: 's', c: inline(m[1]) }); i += m[0].length; continue; }
      buf += c; i++;
    }
    flush();
    return out;
  }

  /** only absolute http(s) links become anchors */
  function safeHref(href) {
    try { const u = new URL(String(href)); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch (_) { return null; }
  }

  // ---------- DOM ----------
  function h(doc, tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function inlineDom(doc, nodes, parent) {
    for (const n of nodes) {
      if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
      else if (n.t === 'br') parent.appendChild(doc.createElement('br'));
      else if (n.t === 'code') parent.appendChild(h(doc, 'code', 'md-ic', n.v));
      else if (n.t === 'a') {
        const href = safeHref(n.href);
        if (!href) { inlineDom(doc, n.c, parent); continue; }
        const a = h(doc, 'a', 'md-a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        inlineDom(doc, n.c, a); parent.appendChild(a);
      } else { const e = h(doc, n.t === 'b' ? 'strong' : n.t === 'i' ? 'em' : 'del'); inlineDom(doc, n.c, e); parent.appendChild(e); }
    }
    return parent;
  }
  function codeBlock(doc, code, lang) {
    const w = h(doc, 'div', 'md-code');
    if (lang) w.appendChild(h(doc, 'div', 'md-lang', lang));
    const pre = h(doc, 'pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', (lang ? lang + ' ' : '') + 'code block');
    pre.appendChild(h(doc, 'code', null, code)); w.appendChild(pre);
    return w;
  }
  function blocksDom(doc, blocks, parent) {
    for (const b of blocks) {
      if (b.t === 'p') parent.appendChild(inlineDom(doc, b.c, h(doc, 'p', 'md-p')));
      else if (b.t === 'h') { const e = inlineDom(doc, b.c, h(doc, 'div', 'md-h md-h' + b.level)); e.setAttribute('role', 'heading'); e.setAttribute('aria-level', String(Math.min(6, b.level + 2))); parent.appendChild(e); }
      else if (b.t === 'hr') parent.appendChild(h(doc, 'hr', 'md-hr'));
      else if (b.t === 'code') parent.appendChild(codeBlock(doc, b.v, b.lang));
      else if (b.t === 'quote') parent.appendChild(blocksDom(doc, b.c, h(doc, 'blockquote', 'md-quote')));
      else if (b.t === 'list') {
        const l = h(doc, b.ordered ? 'ol' : 'ul', 'md-list');
        for (const it of b.items) {
          const li = h(doc, 'li', 'md-li'); li.style.marginLeft = (it.depth * 2) + 'ch';
          li.appendChild(h(doc, 'span', 'md-mark', it.task != null ? (it.task ? '☒ ' : '☐ ') : b.ordered ? it.n + '. ' : '• ')).setAttribute('aria-hidden', 'true');
          if (b.ordered) li.value = it.n;
          parent.appendChild(l).appendChild(li).appendChild(inlineDom(doc, it.c, h(doc, 'span', 'md-lt')));
        }
      } else if (b.t === 'table') {
        const w = h(doc, 'div', 'md-table'); w.tabIndex = 0; w.setAttribute('role', 'region'); w.setAttribute('aria-label', 'table');
        const t = h(doc, 'table'), hr = h(doc, 'tr');
        for (const c of b.head) hr.appendChild(inlineDom(doc, c, h(doc, 'th')));
        t.appendChild(h(doc, 'thead')).appendChild(hr);
        const tb = t.appendChild(h(doc, 'tbody'));
        for (const r of b.rows) { const tr = h(doc, 'tr'); b.head.forEach((_, j) => tr.appendChild(inlineDom(doc, r[j] || [], h(doc, 'td')))); tb.appendChild(tr); }
        w.appendChild(t); parent.appendChild(w);
      }
    }
    return parent;
  }
  const renderMarkdown = (doc, text) => blocksDom(doc, parse(text), h(doc, 'div', 'md'));

  // ---------- diffs ----------
  /** structuredPatch hunks -> rows {k:'+'|'-'|' '|'gap', o, n, v} with real file line numbers */
  function patchRows(patch) {
    const rows = [];
    (patch || []).forEach((hk, i) => {
      if (i) rows.push({ k: 'gap' });
      let o = hk.oldStart || 1, n = hk.newStart || 1;
      for (const raw of hk.lines || []) {
        const k = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' ', v = k === ' ' && raw[0] !== ' ' ? raw : raw.slice(1);
        if (raw[0] === '\\') continue;   // "\ No newline at end of file"
        rows.push({ k, o: k === '+' ? null : o, n: k === '-' ? null : n, v });
        if (k !== '+') o++;
        if (k !== '-') n++;
      }
    });
    return rows;
  }
  /** old/new strings -> rows via line LCS; no file offsets are known, so no line numbers */
  function lineDiff(a, b) {
    const A = String(a || '').split('\n'), B = String(b || '').split('\n');
    if (A.length * B.length > 40000) return A.map((v) => ({ k: '-', v })).concat(B.map((v) => ({ k: '+', v })));
    const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const rows = [];
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { rows.push({ k: ' ', v: A[i] }); i++; j++; }
      else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) rows.push({ k: '-', v: A[i++] });
      else rows.push({ k: '+', v: B[j++] });
    }
    return rows;
  }
  /** the diff a tool message shows, or null */
  function toolDiff(m) {
    const inp = m.input || {}, meta = m.meta || {};
    if (meta.patch && meta.patch.length) return patchRows(meta.patch);
    if (/^(Edit|MultiEdit|StrReplace|edit|Update)$/i.test(m.tool || '')) {
      const eds = inp.edits && inp.edits.length ? inp.edits : inp.old_string != null || inp.new_string != null ? [inp] : [];
      if (!eds.length) return null;
      return eds.reduce((acc, e, i) => acc.concat(i ? [{ k: 'gap' }] : [], lineDiff(e.old_string, e.new_string)), []);
    }
    if (/^(Write|write)$/.test(m.tool || '') && typeof inp.content === 'string') return inp.content.split('\n').map((v, i) => ({ k: '+', n: i + 1, v }));
    return null;
  }

  // ---------- tool lines ----------
  const NAMES = { TodoWrite: 'Update Todos', todoWrite: 'Update Todos' };
  const rel = (p, cwd) => { p = String(p || ''); return cwd && p.startsWith(cwd.replace(/\/$/, '') + '/') ? p.slice(cwd.replace(/\/$/, '').length + 1) : p; };
  const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  /** "Read(src/app.js)" style argument for a tool message */
  function toolArg(m, cwd) {
    const i = m.input || {}, name = m.tool || '';
    if (/todo/i.test(name)) return '';
    if (i.file_path) return rel(i.file_path, cwd);
    if (i.command) return clip(i.command, 140);
    if (i.pattern) return clip(i.pattern, 100);
    if (i.url) return clip(i.url, 120);
    if (i.query) return clip(i.query, 100);
    if (i.description) return clip(i.description, 100);
    const t = String(m.text || ''), k = t.indexOf(': ');
    return k > 0 && t.slice(0, k) === name ? clip(t.slice(k + 2), 140) : '';
  }
  const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  /** the dim result line under a tool, plus extra output lines when there is more */
  function toolResult(m, cwd, diff) {
    const meta = m.meta || {}, out = String(m.out || '').replace(/\s+$/, ''), name = m.tool || '';
    if (m.status === 'running') return { text: /^(Bash|Shell|shell)$/.test(name) ? 'Running…' : 'Working…', more: [] };
    if (m.status === 'stopped') return { text: 'Interrupted', more: [] };
    if (m.status === 'error') { const ls = out ? out.split('\n') : ['Failed']; return { text: ls[0], more: ls.slice(1) }; }
    if (m.status !== 'ok') return null;     // history without results, or a run that ended without one
    if (/todo/i.test(name) && (m.input || {}).todos) return null;
    if (diff) {
      const add = diff.filter((r) => r.k === '+').length, del = diff.filter((r) => r.k === '-').length, p = rel((m.input || {}).file_path, cwd);
      if (/write/i.test(name) && !del) return { text: `Wrote ${count(add, 'line')} to ${p}`, more: [] };
      return { text: `Updated ${p} with ${count(add, 'addition')} and ${count(del, 'removal')}`, more: [] };
    }
    if (meta.numLines != null && /read/i.test(name)) return { text: `Read ${count(meta.numLines, 'line')}`, more: [] };
    if (meta.numFiles != null) return { text: `Found ${count(meta.numFiles, 'file')}`, more: out ? out.split('\n') : [] };
    if (!out) return { text: meta.numLines != null ? count(meta.numLines, 'line') : 'Done', more: [] };
    const ls = out.split('\n');
    return { text: ls[0], more: ls.slice(1) };
  }

  const SHOW = 3, DIFF_SHOW = 12;
  /** "… +N lines" that expands in place; a real button so it works from the keyboard */
  function expander(doc, hidden, renderRow, parent, label) {
    if (!hidden.length) return;
    const b = h(doc, 'button', 'cc-more', `… +${count(hidden.length, 'line')}`);
    b.type = 'button'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', `Show ${count(hidden.length, 'more line')}${label ? ' of ' + label : ''}`);
    b.addEventListener('click', () => { const f = doc.createDocumentFragment(); hidden.forEach((r) => f.appendChild(renderRow(r))); b.replaceWith(f); });
    parent.appendChild(b);
  }
  function diffDom(doc, rows, parent) {
    const box = h(doc, 'div', 'cc-diff'), nums = rows.some((r) => r.o != null || r.n != null);
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'diff');
    if (!nums) box.classList.add('nonum');
    const row = (r) => {
      if (r.k === 'gap') return h(doc, 'div', 'cc-dl gap', '⋮');
      const d = h(doc, 'div', 'cc-dl ' + (r.k === '+' ? 'add' : r.k === '-' ? 'del' : 'ctx'));
      if (nums) d.appendChild(h(doc, 'span', 'cc-ln', String(r.k === '-' ? r.o : r.n != null ? r.n : r.o != null ? r.o : '')));
      d.appendChild(h(doc, 'span', 'cc-sign', r.k === ' ' ? ' ' : r.k)).setAttribute('aria-label', r.k === '+' ? 'added' : r.k === '-' ? 'removed' : 'unchanged');
      d.appendChild(h(doc, 'span', 'cc-dt', r.v === '' ? ' ' : r.v));
      return d;
    };
    rows.slice(0, DIFF_SHOW).forEach((r) => box.appendChild(row(r)));
    expander(doc, rows.slice(DIFF_SHOW), row, box, 'the diff');
    parent.appendChild(box);
  }
  const TODO_MARK = { completed: '☒', in_progress: '▣', pending: '☐' };
  function todosDom(doc, todos, parent) {
    const ul = h(doc, 'ul', 'cc-todos'); ul.setAttribute('aria-label', 'todo list');
    for (const t of todos) {
      const st = TODO_MARK[t.status] ? t.status : 'pending', li = h(doc, 'li', 'cc-todo ' + st);
      li.appendChild(h(doc, 'span', 'cc-box', TODO_MARK[st])).setAttribute('aria-hidden', 'true');
      li.appendChild(h(doc, 'span', 'cc-tt', t.content));
      li.setAttribute('aria-label', `${t.content}: ${st.replace('_', ' ')}`);
      ul.appendChild(li);
    }
    parent.appendChild(ul);
  }

  /** "● Name(args)" head line used by tools and helpers */
  function headLine(doc, name, arg, extra) {
    const hd = h(doc, 'div', 'cc-head');
    hd.appendChild(h(doc, 'span', 'cc-dot', '●')).setAttribute('aria-hidden', 'true');
    hd.appendChild(h(doc, 'span', 'cc-name', name));
    if (arg) { hd.appendChild(doc.createTextNode('(')); hd.appendChild(h(doc, 'span', 'cc-arg', arg)); hd.appendChild(doc.createTextNode(')')); }
    if (extra) hd.appendChild(extra);
    return hd;
  }
  function resLine(doc, text, cls) {
    const r = h(doc, 'div', 'cc-res' + (cls ? ' ' + cls : ''));
    r.appendChild(h(doc, 'span', 'cc-elbow', '⎿')).setAttribute('aria-hidden', 'true');
    r.appendChild(h(doc, 'span', 'cc-rt', text));
    return r;
  }

  function fillTool(doc, el, m, cwd) {
    el.textContent = '';
    el.className = 'msg tool cc ' + (m.status || 'done');
    const name = NAMES[m.tool] || m.tool || String(m.text || 'Tool').split(':')[0], arg = toolArg(m, cwd);
    el.appendChild(headLine(doc, name, arg));
    el.setAttribute('aria-label', `${name}${arg ? ' ' + arg : ''}${m.status === 'running' ? ', running' : m.status === 'error' ? ', failed' : ''}`);
    const todos = /todo/i.test(m.tool || '') && m.input && Array.isArray(m.input.todos) ? m.input.todos : null;
    if (todos) { todosDom(doc, todos, el); return el; }
    const diff = m.status === 'error' || m.status === 'running' ? null : toolDiff(m);
    const r = toolResult(m, cwd, diff);
    if (r) {
      el.appendChild(resLine(doc, r.text, m.status === 'error' ? 'err' : ''));
      const box = h(doc, 'div', 'cc-out' + (m.status === 'error' ? ' err' : ''));
      const row = (v) => h(doc, 'div', 'cc-ol', v === '' ? ' ' : v);
      r.more.slice(0, SHOW - 1).forEach((v) => box.appendChild(row(v)));
      expander(doc, r.more.slice(SHOW - 1), row, box, name + ' output');
      if (box.childNodes.length) el.appendChild(box);
    }
    if (diff && diff.length) diffDom(doc, diff, el);
    return el;
  }

  const SUB_STATUS = { running: 'running', finished: 'done', failed: 'failed', lost: 'interrupted' };
  /** a helper (subagent): "● Agent(label)" with the colleague's name, expandable to its steps */
  function fillSub(doc, el, m, cwd) {
    const sb = m.sub || { label: '?', status: 'running', log: [] }, open = el.open;
    el.textContent = '';
    el.className = 'msg sub cc ' + sb.status + (sb.bg ? ' bg' : '');
    const sum = h(doc, 'summary');
    const tag = sb.bg ? h(doc, 'span', 'cc-tag', 'background') : null;
    sum.appendChild(headLine(doc, 'Agent', sb.label, tag));
    const who = [sb.helper ? sb.helper : 'waiting for a colleague', sb.role || sb.kind, SUB_STATUS[sb.status] || sb.status, sb.log.length ? count(sb.log.length, 'step') : ''].filter(Boolean).join(' · ');
    sum.appendChild(resLine(doc, who, sb.status === 'failed' || sb.status === 'lost' ? 'err' : ''));
    el.appendChild(sum);
    const log = h(doc, 'div', 'cc-sublog');
    for (const l of sb.log) log.appendChild(headLine(doc, l.tool, l.summary ? rel(l.summary, cwd) : ''));
    if (!sb.log.length) log.appendChild(h(doc, 'div', 'cc-note', 'No activity reported yet'));
    if (sb.result) log.appendChild(resLine(doc, sb.result, sb.status === 'failed' ? 'err' : ''));
    el.appendChild(log);
    el.open = open;
    return el;
  }

  /** one transcript message -> its element (reuses `el` on updates) */
  function renderMsg(doc, m, opts, el) {
    const cwd = (opts && opts.cwd) || '';
    if (m.role === 'sub') return fillSub(doc, el || doc.createElement('details'), m, cwd);
    if (m.role === 'thinking') {
      el = el || doc.createElement('details'); const open = el.open; el.textContent = ''; el.className = 'msg thinking cc';
      const s = h(doc, 'summary', null); s.appendChild(h(doc, 'span', 'cc-star', '✻')).setAttribute('aria-hidden', 'true'); s.appendChild(doc.createTextNode(' Thinking…'));
      el.appendChild(s); el.appendChild(h(doc, 'div', 'cc-think', m.text)); el.open = open;
      return el;
    }
    el = el || doc.createElement('div');
    el.textContent = '';
    if (m.role === 'tool') return fillTool(doc, el, m, cwd);
    el.className = 'msg ' + m.role + ' cc' + (m.streaming ? ' streaming' : '');
    if (m.role === 'user') { el.appendChild(h(doc, 'span', 'cc-prompt', '> ')).setAttribute('aria-hidden', 'true'); el.appendChild(h(doc, 'span', 'cc-ut', m.text)); }
    else if (m.role === 'assistant') { el.appendChild(h(doc, 'span', 'cc-dot', '●')).setAttribute('aria-hidden', 'true'); el.appendChild(renderMarkdown(doc, m.text)); }
    else if (m.role === 'error') { el.appendChild(h(doc, 'span', 'cc-dot', '●')).setAttribute('aria-hidden', 'true'); el.appendChild(h(doc, 'span', 'cc-et', m.text)); }
    else el.textContent = m.text;     // system and meta lines stay plain
    return el;
  }

  return { parse, inline, safeHref, renderMarkdown, patchRows, lineDiff, toolDiff, toolArg, toolResult, renderMsg };
});
