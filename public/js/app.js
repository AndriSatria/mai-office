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
    const tb = $('chatType'); tb.textContent = (TYPE_INFO[a.type] || [a.type])[0]; tb.className = 'typebadge ' + a.type;
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
        act: a.act ? a.act.kind : null, actP: a.act ? (now - a.act.t0) / 1000 : 0, talk, talkDir: a.chatSide === 0 ? 1 : -1 };
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
    update(dt, now);
    Office.render(canvas, S, U, { t: now / 1000, entries: entries(), selectedId, hoverId, hoverSlot });
    requestAnimationFrame(frame);
  }

  // handy for tests / debugging in the console
  window.harness = {
    agents, select, send, view: VIEW, get selected() { return selectedId; }, get hover() { return { id: hoverId, slot: hoverSlot }; },
    states: () => [...agents.values()].map((a) => ({ id: a.id, name: a.name, type: a.type, state: a.state, tool: a.tool, away: a.away, mode: a.mode, act: a.act && a.act.kind })),
    // kind: coffee | chat (needs partnerId) | stretch | read | look   (ignores timers/eligibility; for demos & tests)
    forceActivity: (id, kind, partnerId) => { const a = agents.get(id); if (a && !a.away) startActivity(a, kind, partnerId ? agents.get(partnerId) : null); },
    forceWander: (id) => { const a = agents.get(id); if (a && !a.away) startActivity(a, 'coffee'); },
  };

  resize(); connect(); requestAnimationFrame(frame);
})();
