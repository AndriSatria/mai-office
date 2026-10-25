/* mAI office frontend: websocket client, chat panel, animation state. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('office');
  const agents = new Map();          // id -> agent (server fields + client anim fields)
  let mode = '?', types = [], defaultCwd = '', selectedId = null, hoverId = null, hoverSlot = null;
  let ws = null, connected = false;
  const params = new URLSearchParams(location.search);
  // ?wander=off disables idle behaviour entirely, ?wander=fast makes it happen every few seconds
  const WANDER = params.get('wander') !== 'off';
  // default view is isometric; ?view=flat switches to the old top-down renderer
  const VIEW = params.get('view') === 'flat' ? 'flat' : 'iso';
  const Office = VIEW === 'flat' ? window.OfficeFlat : window.OfficeIso;
  window.Office = Office;
  const WANDER_FAST = params.get('wander') === 'fast';
  const rand = (a, b) => a + Math.random() * (b - a);
  const TYPE_INFO = {
    claude: ['Claude Code', 'claude -p … --resume'],
    cursor: ['Cursor', 'cursor-agent -p … --resume'],
    mock: ['Mock', 'simulated agent, no CLI needed'],
  };
  const BUBBLE_TTL = 14000;
  const NAMES = ['Ada', 'Linus', 'Grace', 'Alan', 'Margaret', 'Ken', 'Barbara', 'Dennis'];

  // ---------- websocket ----------
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { connected = true; setConn(); };
    ws.onclose = () => { connected = false; setConn(); setTimeout(connect, 1500); };
    ws.onmessage = (e) => { try { onServer(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  }
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  function setConn() { const el = $('conn'); el.textContent = connected ? 'online' : 'offline'; el.className = 'badge ' + (connected ? 'on' : 'off'); }

  function decorate(a) {
    if (a.phase === undefined) a.phase = Math.random();
    a.away = a.away || false; a.mode = a.mode || 'sit';
    a.transcript = a.transcript || [];
    a.nextAct = performance.now() + (WANDER_FAST ? rand(1500, 3500) : rand(5000, 14000));
    a.act = null; a.partner = null;
    a.bubble = a.bubble || null; a.bubbleAt = a.bubbleAt || 0;
    a.helpers = []; a.rcv = null; a.turn = null; a.subs = a.subs || [];
    return a;
  }

  function onServer(m) {
    switch (m.type) {
      case 'snapshot': {
        mode = m.defaultType || m.mode; types = m.types || []; defaultCwd = m.defaultCwd;
        $('modeBadge').textContent = 'default: ' + mode; $('modeBadge').className = 'badge ' + mode;
        const seen = new Set();
        for (const a of m.agents) {
          seen.add(a.id);
          const old = agents.get(a.id);
          const na = old ? Object.assign(old, a) : decorate(a);
          agents.set(a.id, na); syncHelpers(na, true);
        }
        for (const id of [...agents.keys()]) if (!seen.has(id)) agents.delete(id);
        if (selectedId && !agents.has(selectedId)) selectedId = null;
        renderChat(true);
        break;
      }
      case 'agent': {
        const { agent, transcript, isNew } = m;
        let a = agents.get(agent.id);
        if (!a) { a = decorate(Object.assign({}, agent, { transcript: transcript || [] })); agents.set(a.id, a); if (isNew && pendingSelect) { select(a.id); pendingSelect = false; } }
        else {
          const prev = a.state;
          Object.assign(a, agent);
          if (prev !== a.state && a.state === 'thinking') a.bubble = null;
          syncHelpers(a, false);
        }
        if (a.id === selectedId) updateHead();
        break;
      }
      case 'removed':
        agents.delete(m.id); if (selectedId === m.id) selectedId = null; renderChat(true); break;
      case 'msg': {
        const a = agents.get(m.id); if (!a) break;
        a.transcript.push(m.msg);
        if (m.msg.role === 'assistant') { a.bubble = m.msg.text; a.bubbleAt = performance.now(); }
        if (m.msg.role === 'user') a.bubble = null;
        if (m.msg.role === 'error') { a.bubble = m.msg.text; a.bubbleAt = performance.now(); }
        if (m.id === selectedId) appendMsg(m.msg);
        break;
      }
      case 'msg_update': {
        const a = agents.get(m.id); if (!a) break;
        const msg = a.transcript.find((x) => x.mid === m.mid); if (!msg) break;
        msg.text = m.text;
        if (msg.role === 'assistant') { a.bubble = m.text; a.bubbleAt = performance.now(); }
        if (m.id === selectedId) updateMsgEl(msg);
        break;
      }
      case 'subagent': {
        const a = agents.get(m.id); if (!a) break;
        const now = performance.now(), h = a.helpers.find((x) => x.subId === m.sub.subId);
        if (m.op === 'start') addHelper(a, m.sub, now, true);
        else if (m.op === 'activity') { if (h) { h.tool = m.sub.tool; h.summary = m.sub.summary; } }
        else if (m.op === 'end') endHelper(a, m.sub.subId, m.sub.ok, now, true);
        break;
      }
      case 'sub_update': {
        const a = agents.get(m.id); if (!a) break;
        const msg = a.transcript.find((x) => x.mid === m.mid); if (!msg) break;
        msg.sub = m.sub;
        if (m.id === selectedId) updateMsgEl(msg);
        break;
      }
      case 'relay': {
        const now = performance.now();
        flights.push({ kind: 'letter', pid: m.from, toId: m.to, t0: now, dur: 1500 });
        break;
      }
      case 'error': toast(m.message); break;
      default: break;
    }
  }

  // ---------- chat panel ----------
  let msgEls = new Map();
  const tr = $('transcript');
  function select(id) { selectedId = id; renderChat(true); if (id) $('input').focus(); }

  function renderChat(full) {
    const a = agents.get(selectedId);
    $('chatEmpty').hidden = !!a; $('chatBody').hidden = !a;
    $('fireBtn').disabled = !a;
    if (!a) { tr.innerHTML = ''; msgEls.clear(); return; }
    if (full) {
      tr.innerHTML = ''; msgEls.clear();
      for (const m of a.transcript) appendMsg(m, true);
      tr.scrollTop = tr.scrollHeight;
      $('input').placeholder = `Message ${a.name}… (Enter to send, Shift+Enter for newline)`;
      Office.drawAvatar($('avatar'), a.look);
    }
    updateHead();
  }

  function updateHead() {
    const a = agents.get(selectedId); if (!a) return;
    $('chatName').textContent = a.name;
    const tb = $('chatType'); tb.textContent = (TYPE_INFO[a.type] || [a.type])[0]; tb.className = 'typebadge ' + a.type;
    $('chatCwd').textContent = a.cwd; $('chatCwd').title = a.cwd;
    const st = $('chatState'); st.textContent = a.state === 'working' && a.tool ? 'working · ' + a.tool : a.state; st.className = 'pill ' + a.state;
    $('stopBtn').hidden = !(a.state === 'thinking' || a.state === 'working');
    $('queueInfo').textContent = a.queued ? `${a.queued} message(s) queued` : (a.hasSession ? 'session active' : '');
    $('teamBtn').hidden = a.type !== 'mock';
    const rt = $('relayTo'), others = [...agents.values()].filter((b) => b.id !== a.id), sig = a.id + '|' + others.map((b) => b.id + b.name).join(',');
    if (rt.dataset.sig !== sig) {
      rt.dataset.sig = sig; rt.innerHTML = '<option value="">this agent</option>';
      for (const b of others) { const o = document.createElement('option'); o.value = b.id; o.textContent = '→ ' + b.name; rt.appendChild(o); }
      rt.hidden = !others.length; rt.classList.remove('on');
    }
  }

  function appendMsg(m, noScroll) {
    const near = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 60;
    let el;
    if (m.role === 'sub') { el = document.createElement('details'); el.className = 'msg sub'; el.innerHTML = '<summary></summary><div class="subLog"></div><div class="subRes"></div>'; fillSub(el, m); }
    else {
      el = document.createElement('div');
      el.className = 'msg ' + m.role + (m.streaming ? ' streaming' : '');
      el.textContent = m.role === 'tool' ? '▸ ' + m.text : m.text;
    }
    tr.appendChild(el); msgEls.set(m.mid, el);
    if (!noScroll && near) tr.scrollTop = tr.scrollHeight;
  }
  const SUB_STATUS = { running: 'started', finished: 'finished', failed: 'failed', lost: 'interrupted' };
  /** collapsed system line "↳ helper 'explore repo' started / finished", expandable to its activity log */
  function fillSub(el, m) {
    const sb = m.sub || { label: '?', status: 'running', log: [] };
    el.className = 'msg sub ' + sb.status;
    el.querySelector('summary').textContent = `↳ helper '${sb.label}' ${SUB_STATUS[sb.status] || sb.status}` + (sb.kind ? ` · ${sb.kind}` : '') + (sb.log.length ? ` · ${sb.log.length} step${sb.log.length > 1 ? 's' : ''}` : '');
    const log = el.querySelector('.subLog'); log.textContent = '';
    for (const l of sb.log) { const d = document.createElement('div'); d.textContent = '▸ ' + l.tool + (l.summary ? ' ' + l.summary : ''); log.appendChild(d); }
    if (!sb.log.length) { const d = document.createElement('div'); d.textContent = 'no activity reported'; log.appendChild(d); }
    el.querySelector('.subRes').textContent = sb.result ? '→ ' + sb.result : '';
  }
  function updateMsgEl(m) {
    const el = msgEls.get(m.mid); if (!el) return;
    if (m.role === 'sub') { fillSub(el, m); return; }
    const near = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 60;
    el.textContent = m.text;
    const a = agents.get(selectedId);
    // streaming flag is cleared by the server once the block completes; approximate here
    el.classList.toggle('streaming', a && (a.state === 'working' || a.state === 'thinking') && m === a.transcript[a.transcript.length - 1]);
    if (near) tr.scrollTop = tr.scrollHeight;
  }
  setInterval(() => { // drop the streaming cursor once the agent stops
    const a = agents.get(selectedId); if (!a || a.state === 'working' || a.state === 'thinking') return;
    tr.querySelectorAll('.streaming').forEach((e) => e.classList.remove('streaming'));
  }, 500);

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('input').value.trim(); if (!text || !selectedId) return;
    const to = $('relayTo').value;
    if (to) { send({ type: 'relay', from: selectedId, to, text }); $('relayTo').value = ''; $('relayTo').classList.remove('on'); }
    else send({ type: 'send', id: selectedId, text });
    $('input').value = '';
  });
  $('relayTo').addEventListener('change', () => $('relayTo').classList.toggle('on', !!$('relayTo').value));
  $('teamBtn').addEventListener('click', () => { // mock agents: spawn parallel helpers
    if (!selectedId) return;
    const task = $('input').value.trim() || 'Refactor the auth module';
    send({ type: 'send', id: selectedId, text: '/team ' + task }); $('input').value = '';
  });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('stopBtn').addEventListener('click', () => selectedId && send({ type: 'interrupt', id: selectedId }));

  // ---------- hire / fire ----------
  let pendingSelect = false;
  function renderTypeOptions() {
    const box = $('typeOptions'); box.innerHTML = '';
    const list = types.length ? types : [{ id: 'mock', available: true }];
    for (const t of list) {
      const info = TYPE_INFO[t.id] || [t.label || t.id, ''];
      const l = document.createElement('label'); l.className = 'typeopt';
      l.innerHTML = '<input type="radio" name="agentType"><span class="tn"></span><span class="td"></span><span class="ts"></span>';
      const inp = l.querySelector('input'); inp.value = t.id; inp.checked = t.id === mode;
      l.querySelector('.tn').textContent = info[0]; l.querySelector('.td').textContent = info[1];
      const ts = l.querySelector('.ts'); ts.textContent = t.available ? 'ready' : 'CLI not found'; ts.classList.add(t.available ? 'ok' : 'missing');
      box.appendChild(l);
    }
  }
  function openHire() {
    renderTypeOptions();
    const used = new Set([...agents.values()].map((a) => a.name.toLowerCase()));
    $('hireName').value = NAMES.find((n) => !used.has(n.toLowerCase())) || '';
    $('hireCwd').value = defaultCwd;
    $('hireDlg').showModal(); $('hireName').select();
  }
  $('hireBtn').addEventListener('click', openHire);
  $('hireCancel').addEventListener('click', () => $('hireDlg').close());
  $('hireForm').addEventListener('submit', () => {
    const sel = document.querySelector('input[name=agentType]:checked');
    send({ type: 'hire', name: $('hireName').value, cwd: $('hireCwd').value, agentType: sel ? sel.value : undefined }); pendingSelect = true;
  });
  $('fireBtn').addEventListener('click', () => {
    const a = agents.get(selectedId); if (!a) return;
    if (confirm(`Fire ${a.name}? Their desk and transcript will be removed.`)) send({ type: 'fire', id: a.id });
  });

  let toastT;
  function toast(msg) { const el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 4500); }

  // ---------- canvas input ----------
  let S = 3, U = 1;
  function entries() {
    const now = performance.now();
    return [...agents.values()].map((a) => {
      let bubble = null;
      if (a.bubble && (a.state === 'working' || a.state === 'thinking' || now - a.bubbleAt < BUBBLE_TTL)) bubble = a.bubble;
      if (a.state === 'thinking' && now - a.bubbleAt > 2500) bubble = null;
      let talk = null;
      if (a.mode === 'chat' && a.chatStart) {
        const beat = Math.floor((now - a.chatStart) / 1700);
        if (beat % 2 === a.chatSide) talk = Math.floor(beat / 2 + a.chatSide * 2) % 5;
      }
      return { id: a.id, name: a.name, type: a.type, slot: a.slot, look: a.look, state: a.state, tool: a.tool, queued: a.queued,
        phase: a.phase, away: a.away, x: a.x, y: a.y, face: a.face || 0, mode: a.mode, bubble,
        act: a.act ? a.act.kind : null, actP: a.act ? (now - a.act.t0) / 1000 : 0, talk, talkDir: a.chatSide === 0 ? 1 : -1,
        helpers: a.helpers.filter((h) => h.x !== undefined).map((h) => ({ subId: h.subId, label: h.label, kind: h.kind, tool: h.tool, state: h.state, x: h.x, y: h.y, face: h.face, look: h.look, phase: h.phase,
          age: (now - h.born) / 1000, endAge: h.endAt ? (now - h.endAt) / 1000 : -1 })),
        waiting: a.helpers.filter((h) => h.state === 'working').length,
        faceOv: a.turn && now < a.turn.until && !a.away ? a.turn.face : null,
        rcv: a.rcv ? { age: (now - a.rcv.t0) / 1000, ok: a.rcv.ok } : null };
    });
  }
  const flightsView = (now) => flights.map((f) => ({ kind: f.kind, pid: f.pid, toId: f.toId, subId: f.subId, ok: f.ok, p: (now - f.t0) / f.dur }));

  // ---------- helpers (subagents) ----------
  // A helper is a small "junior" next to the parent's desk. Papers fly parent -> helper when it starts and an envelope
  // flies back when it ends; the parent glances over and gets a "result arrived" bubble.
  const flights = [];                // in-flight papers/envelopes/letters
  const SKINS = ['#f1c7a0', '#e0a878', '#c68642', '#8d5524', '#ffdbac'], HAIRS = ['#2b1b10', '#5a3825', '#b5651d', '#e6c27a', '#1c1c1c', '#9b2d30', '#3a3a8a'], STYLES = ['short', 'spiky', 'bun', 'long', 'cap'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const HOLD_OK = () => (Office.HOLD ? Office.HOLD.ok : 1.4) * 1000, HOLD_BAD = () => (Office.HOLD ? Office.HOLD.failed : 2.6) * 1000, FADE = () => (Office.HOLD ? Office.HOLD.fade : 0.7) * 1000;
  function allocSpot(a) {
    const taken = new Set();
    for (const b of agents.values()) for (const h of b.helpers) if (h.x !== undefined) taken.add(Math.floor(h.x) * 100 + Math.floor(h.y));
    return (Office.helperSpots ? Office.helperSpots(a.slot) : []).find((sp) => !taken.has(Math.floor(sp.x) * 100 + Math.floor(sp.y))) || null;
  }
  function turnToward(a, h, ms, now) {
    const s = Office.SLOTS && Office.SLOTS[a.slot];
    if (s && s.seat && h.x !== undefined) a.turn = { face: faceOf(h.x - s.seat.x, h.y - s.seat.y), until: now + ms };
  }
  function addHelper(a, sub, now, animate) {
    if (a.helpers.some((x) => x.subId === sub.subId)) return;
    const h = { subId: sub.subId, label: sub.label, kind: sub.kind, state: 'working', tool: sub.tool || null, summary: null, born: animate ? now : now - 3000, endAt: 0, phase: Math.random(),
      look: { skin: pick(SKINS), hair: pick(HAIRS), hairStyle: pick(STYLES), pants: pick(['#2d3550', '#3b2f2f', '#2f4a3a', '#4a3a5a']), shirt: Office.kindCol ? Office.kindCol(sub.kind) : '#6cb6ff' } };
    a.helpers.push(h); placeHelper(a, h, now, animate);
  }
  function placeHelper(a, h, now, animate) {
    const sp = allocSpot(a);
    if (!sp) return;       // no free tile around the desk: queued until one frees up
    h.x = sp.x; h.y = sp.y; h.face = sp.face; h.born = animate ? now : h.born;
    if (animate) { flights.push({ kind: 'out', pid: a.id, subId: h.subId, t0: now + 150, dur: 900 }); turnToward(a, h, 1300, now); }
  }
  function endHelper(a, subId, ok, now, animate) {
    const h = a.helpers.find((x) => x.subId === subId); if (!h || h.state !== 'working') return;
    h.state = ok === false ? 'failed' : 'ok'; h.endAt = now; h.tool = null;
    if (h.x === undefined) { a.helpers.splice(a.helpers.indexOf(h), 1); return; }
    if (animate) { flights.push({ kind: 'back', pid: a.id, subId, ok: ok !== false, t0: now, dur: 1000 }); turnToward(a, h, 1100, now); }
    else h.endAt = now - 5000;
  }
  /** make local helpers match the server's list of running subagents (reconnect / late joiner) */
  function syncHelpers(a, full) {
    const now = performance.now(), ids = new Set((a.subs || []).map((x) => x.subId));
    for (const sub of a.subs || []) addHelper(a, sub, now, false);
    if (full) for (const h of a.helpers) if (h.state === 'working' && !ids.has(h.subId)) endHelper(a, h.subId, true, now, false);
  }
  function updateHelpers(now) {
    for (const a of agents.values()) {
      if (a.turn && now > a.turn.until) a.turn = null;
      for (const h of a.helpers) if (h.x === undefined && h.state === 'working') placeHelper(a, h, now, true);
      a.helpers = a.helpers.filter((h) => !h.endAt || now - h.endAt < (h.state === 'failed' ? HOLD_BAD() : HOLD_OK()) + FADE() + 120);
    }
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      if (!f.done && (f.kind === 'back' || f.kind === 'letter') && now >= f.t0 + f.dur) {
        f.done = true;
        const r = agents.get(f.kind === 'letter' ? f.toId : f.pid);
        if (r) r.rcv = { t0: now, ok: f.ok !== false };
      }
      if (now > f.t0 + f.dur + 80) flights.splice(i, 1);
    }
  }
  function toLogical(ev) {
    const r = canvas.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * Office.W, ((ev.clientY - r.top) / r.height) * Office.H];
  }
  canvas.addEventListener('mousemove', (ev) => {
    const [x, y] = toLogical(ev); const h = Office.hitTest(x, y, entries());
    hoverId = h && h.id || null; hoverSlot = h && h.slot !== undefined && agents.size < Office.MAX_SLOTS ? h.slot : null;
    canvas.style.cursor = h ? 'pointer' : 'default';
  });
  canvas.addEventListener('mouseleave', () => { hoverId = null; hoverSlot = null; });
  canvas.addEventListener('click', (ev) => {
    const [x, y] = toLogical(ev); const h = Office.hitTest(x, y, entries());
    if (!h) { return; }
    if (h.id) select(h.id); else if (agents.size < Office.MAX_SLOTS) openHire();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('hireDlg').open && document.activeElement !== $('input')) select(null); });

  // ---------- idle behaviour ----------
  // Idle agents (not selected / hovered / busy) occasionally: stretch, read, look around (at the desk),
  // sip coffee, or meet another idle agent by the coffee machine for a chat. Anything non-idle sends them home.
  const SPEED = Office.SPEED;     // world units per second (px in the flat view, tiles in the iso view)
  const faceOf = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3)); // 0 SE 1 SW 2 NW 3 NE
  const wantsHome = (a) => (a.state !== 'idle' && a.state !== 'done') || a.id === selectedId;
  const socialBusy = () => { for (const a of agents.values()) if (a.away) return true; return false; };
  const canStart = (a) => !a.away && !a.act && a.state === 'idle' && a.id !== selectedId;
  const endAct = (a, now) => { a.act = null; a.nextAct = now + (WANDER_FAST ? rand(2000, 4000) : rand(8000, 22000)); };

  function startWalk(a, spot, dest) {
    a.pts = Office.walkPath(a.slot, spot); a.idx = 0; a.x = a.pts[0].x; a.y = a.pts[0].y;
    a.spot = spot; a.face = 0; a.away = true; a.mode = 'walk'; a.dest = dest; a.dir = 1; a.target = 1; a.chatStart = 0; a.waitSince = 0;
  }
  function startActivity(a, kind, partner, now) {
    now = now || performance.now();
    if (kind === 'coffee') return startWalk(a, Office.SPOTS.coffee[0], 'drink');
    if (kind === 'chat' && partner) {
      a.partner = partner.id; partner.partner = a.id; a.chatSide = 0; partner.chatSide = 1;
      if (partner.act) partner.act = null;
      startWalk(a, Office.SPOTS.chat[0], 'chat'); startWalk(partner, Office.SPOTS.chat[1], 'chat');
      return;
    }
    const dur = { stretch: 3300, read: rand(7000, 11000), look: 5400 }[kind];
    if (dur) a.act = { kind, t0: now, until: now + dur };
  }
  function pickActivity(a) {
    const opts = [['stretch', 2], ['read', 3], ['look', 3]];
    const mates = [...agents.values()].filter((b) => b !== a && canStart(b) && b.id !== hoverId);
    if (!socialBusy()) { opts.push(['coffee', 3]); if (mates.length) opts.push(['chat', 3]); }
    let r = Math.random() * opts.reduce((n, o) => n + o[1], 0), kind = opts[0][0];
    for (const [k, w] of opts) { if ((r -= w) < 0) { kind = k; break; } }
    startActivity(a, kind, kind === 'chat' ? mates[Math.floor(Math.random() * mates.length)] : null);
  }
  function leave(a) { a.mode = 'walk'; a.dir = -1; a.target = a.pts.length - 2; a.partner = null; a.chatStart = 0; }

  function stepWalker(a, dt, now) {
    if (a.mode === 'drink') { if (now > a.drinkUntil || wantsHome(a)) leave(a); return; }
    if (a.mode === 'chat') {
      const p = agents.get(a.partner);
      const partnerHere = p && p.away && p.partner === a.id && p.mode === 'chat';
      if (partnerHere && !a.chatStart) { a.chatStart = p.chatStart = now; a.until = p.until = now + (WANDER_FAST ? 7000 : rand(8000, 13000)); }
      if (!p || !p.away || p.partner !== a.id || wantsHome(a) || (a.chatStart && now > a.until) || (!a.chatStart && now - a.waitSince > 25000)) leave(a);
      return;
    }
    if (wantsHome(a) && a.dir === 1) { a.dir = -1; a.target = a.idx; a.partner = null; }
    const p = a.pts[a.target]; const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    const stepLen = SPEED * dt;
    if (d <= stepLen) {
      a.x = p.x; a.y = p.y; a.idx = a.target;
      if (a.dir === 1) {
        if (a.target === a.pts.length - 1) {
          if (a.spot && a.spot.face !== undefined) a.face = a.spot.face;
          if (a.dest === 'drink') { a.mode = 'drink'; a.drinkUntil = now + (WANDER_FAST ? 4000 : rand(5000, 10000)); }
          else { a.mode = 'chat'; a.waitSince = now; }
        } else a.target++;
      } else if (a.target === 0) { a.away = false; a.mode = 'sit'; a.partner = null; endAct(a, now); }
      else a.target--;
    } else { a.x += (dx / d) * stepLen; a.y += (dy / d) * stepLen; a.face = faceOf(dx, dy); }
  }
  function update(dt, now) {
    for (const a of agents.values()) {
      if (a.away) { stepWalker(a, dt, now); continue; }
      if (a.act && (a.state !== 'idle' || a.id === selectedId || now > a.act.until)) endAct(a, now);
      if (WANDER && canStart(a) && now > a.nextAct) {
        if (a.id === hoverId) a.nextAct = now + 3000; else pickActivity(a);
      }
    }
  }

  // ---------- main loop ----------
  function resize() {
    const stage = $('stage'); const dpr = window.devicePixelRatio || 1;
    const aw = stage.clientWidth * dpr, ah = stage.clientHeight * dpr;
    // iso view: strictly integer scale; flat view: integer or half steps (nearest-neighbour either way)
    const step = 1 / Office.STEP;
    S = Math.max(1, Math.floor(Math.min(aw / Office.W, ah / Office.H) * step) / step); U = dpr;
    canvas.width = Math.round(Office.W * S); canvas.height = Math.round(Office.H * S);
    canvas.style.width = (canvas.width / dpr) + 'px'; canvas.style.height = (canvas.height / dpr) + 'px';
  }
  window.addEventListener('resize', resize);
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    update(dt, now); updateHelpers(now);
    Office.render(canvas, S, U, { t: now / 1000, entries: entries(), selectedId, hoverId, hoverSlot, flights: flightsView(now) });
    requestAnimationFrame(frame);
  }

  // handy for tests / debugging in the console
  window.harness = {
    agents, select, send, view: VIEW, get selected() { return selectedId; }, get hover() { return { id: hoverId, slot: hoverSlot }; },
    states: () => [...agents.values()].map((a) => ({ id: a.id, name: a.name, type: a.type, state: a.state, tool: a.tool, away: a.away, mode: a.mode, act: a.act && a.act.kind, helpers: a.helpers.filter((h) => h.state === 'working').length, subs: (a.subs || []).length })),
    helpers: (id) => { const a = agents.get(id); return a ? a.helpers.map((h) => ({ subId: h.subId, label: h.label, kind: h.kind, state: h.state, tool: h.tool, x: h.x, y: h.y })) : []; },
    flights: () => flights.map((f) => ({ kind: f.kind, pid: f.pid, subId: f.subId })),
    // kind: coffee | chat (needs partnerId) | stretch | read | look   (ignores timers/eligibility; for demos & tests)
    forceActivity: (id, kind, partnerId) => { const a = agents.get(id); if (a && !a.away) startActivity(a, kind, partnerId ? agents.get(partnerId) : null); },
    forceWander: (id) => { const a = agents.get(id); if (a && !a.away) startActivity(a, 'coffee'); },
  };

  resize(); connect(); requestAnimationFrame(frame);
})();
