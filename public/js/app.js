/* Virtual Harness frontend: websocket client, chat panel, animation state. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('office');
  const agents = new Map();          // id -> agent (server fields + client anim fields)
  let mode = '?', defaultCwd = '', selectedId = null, hoverId = null, hoverSlot = null;
  let ws = null, connected = false;
  const params = new URLSearchParams(location.search);
  const WANDER = params.get('wander') !== 'off';
  const WANDER_FAST = params.get('wander') === 'fast';
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
    a.nextWander = performance.now() + (WANDER_FAST ? 3000 : 20000 + Math.random() * 40000);
    a.bubble = a.bubble || null; a.bubbleAt = a.bubbleAt || 0;
    return a;
  }

  function onServer(m) {
    switch (m.type) {
      case 'snapshot': {
        mode = m.mode; defaultCwd = m.defaultCwd;
        $('modeBadge').textContent = m.mode + ' mode'; $('modeBadge').className = 'badge ' + m.mode;
        const seen = new Set();
        for (const a of m.agents) {
          seen.add(a.id);
          const old = agents.get(a.id);
          agents.set(a.id, old ? Object.assign(old, a) : decorate(a));
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
    $('chatCwd').textContent = a.cwd; $('chatCwd').title = a.cwd;
    const st = $('chatState'); st.textContent = a.state === 'working' && a.tool ? 'working · ' + a.tool : a.state; st.className = 'pill ' + a.state;
    $('stopBtn').hidden = !(a.state === 'thinking' || a.state === 'working');
    $('queueInfo').textContent = a.queued ? `${a.queued} message(s) queued` : (a.hasSession ? 'session active' : '');
  }

  function appendMsg(m, noScroll) {
    const near = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 60;
    const el = document.createElement('div');
    el.className = 'msg ' + m.role + (m.streaming ? ' streaming' : '');
    el.textContent = m.role === 'tool' ? '▸ ' + m.text : m.text;
    tr.appendChild(el); msgEls.set(m.mid, el);
    if (!noScroll && near) tr.scrollTop = tr.scrollHeight;
  }
  function updateMsgEl(m) {
    const el = msgEls.get(m.mid); if (!el) return;
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
    send({ type: 'send', id: selectedId, text }); $('input').value = '';
  });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('stopBtn').addEventListener('click', () => selectedId && send({ type: 'interrupt', id: selectedId }));

  // ---------- hire / fire ----------
  let pendingSelect = false;
  function openHire() {
    const used = new Set([...agents.values()].map((a) => a.name.toLowerCase()));
    $('hireName').value = NAMES.find((n) => !used.has(n.toLowerCase())) || '';
    $('hireCwd').value = defaultCwd;
    $('hireDlg').showModal(); $('hireName').select();
  }
  $('hireBtn').addEventListener('click', openHire);
  $('hireCancel').addEventListener('click', () => $('hireDlg').close());
  $('hireForm').addEventListener('submit', () => {
    send({ type: 'hire', name: $('hireName').value, cwd: $('hireCwd').value }); pendingSelect = true;
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
      return { id: a.id, name: a.name, slot: a.slot, look: a.look, state: a.state, tool: a.tool, queued: a.queued,
        phase: a.phase, away: a.away, x: a.x, y: a.y, mode: a.mode, bubble };
    });
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

  // ---------- wandering (idle agents stroll to the coffee corner) ----------
  const SPEED = 40;
  function coffeeBusy() { for (const a of agents.values()) if (a.away) return true; return false; }
  function startWander(a) {
    a.pts = Office.coffeePath(a.slot); a.idx = 0; a.x = a.pts[0].x; a.y = a.pts[0].y;
    a.away = true; a.mode = 'walk'; a.dir = 1; a.target = 1; a.drinkUntil = 0;
  }
  function stepWalker(a, dt, now) {
    if (a.mode === 'drink') { if (now > a.drinkUntil || a.state !== 'idle') { a.mode = 'walk'; a.dir = -1; a.target = a.pts.length - 2; } return; }
    const wantHome = a.state !== 'idle' && a.state !== 'done';
    if (wantHome && a.dir === 1) { a.dir = -1; a.target = a.idx; }
    const p = a.pts[a.target]; const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    const stepLen = SPEED * dt;
    if (d <= stepLen) {
      a.x = p.x; a.y = p.y; a.idx = a.target;
      if (a.dir === 1) {
        if (a.target === a.pts.length - 1) { a.mode = 'drink'; a.drinkUntil = now + (WANDER_FAST ? 4000 : 5000 + Math.random() * 5000); }
        else a.target++;
      } else if (a.target === 0) { a.away = false; a.mode = 'sit'; a.nextWander = now + (WANDER_FAST ? 8000 : 25000 + Math.random() * 45000); }
      else a.target--;
    } else { a.x += (dx / d) * stepLen; a.y += (dy / d) * stepLen; }
  }
  function update(dt, now) {
    for (const a of agents.values()) {
      if (a.away) { stepWalker(a, dt, now); continue; }
      if (WANDER && a.state === 'idle' && now > a.nextWander && !coffeeBusy() && a.id !== hoverId) startWander(a);
      else if (now > a.nextWander) a.nextWander = now + 5000;
    }
  }

  // ---------- main loop ----------
  function resize() {
    const stage = $('stage'); const dpr = window.devicePixelRatio || 1;
    const aw = stage.clientWidth * dpr, ah = stage.clientHeight * dpr;
    // integer scale when it fits nicely, otherwise half steps (nearest-neighbour either way)
    S = Math.max(1, Math.floor(Math.min(aw / Office.W, ah / Office.H) * 2) / 2); U = dpr;
    canvas.width = Math.round(Office.W * S); canvas.height = Math.round(Office.H * S);
    canvas.style.width = (canvas.width / dpr) + 'px'; canvas.style.height = (canvas.height / dpr) + 'px';
  }
  window.addEventListener('resize', resize);
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    update(dt, now);
    Office.render(canvas, S, U, { t: now / 1000, entries: entries(), selectedId, hoverId, hoverSlot });
    requestAnimationFrame(frame);
  }

  // handy for tests / debugging in the console
  window.harness = {
    agents, select, send,
    states: () => [...agents.values()].map((a) => ({ id: a.id, name: a.name, state: a.state, tool: a.tool, away: a.away, mode: a.mode })),
    forceWander: (id) => { const a = agents.get(id); if (a && !a.away) startWander(a); },
  };

  resize(); connect(); requestAnimationFrame(frame);
})();
