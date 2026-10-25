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
  // demo pacing: ?slow=2 stretches walking, bubbles, handoffs and holds (used for the demo videos)
  const TS = Math.max(0.5, Math.min(4, +params.get('slow') || 1));
  const BUBBLE_TTL = 14000 * TS;
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
    a.help = null; a.pendingHelp = null; a.huddle = null; a.planAt = 0; a.rcv = null; a.turn = null; a.subs = a.subs || []; a.team = a.team || [];
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
          agents.set(a.id, na); syncHelp(na, true);
        }
        for (const id of [...agents.keys()]) if (!seen.has(id)) agents.delete(id);
        if (selectedId && !agents.has(selectedId)) selectedId = null;
        renderChat(true);
        break;
      }
      case 'agent': {
        const { agent, transcript, isNew } = m;
        let a = agents.get(agent.id);
        if (!a) {
          a = decorate(Object.assign({}, agent, { transcript: transcript || [] })); agents.set(a.id, a);
          if (isNew && pendingSelect && !m.enter) { select(a.id); pendingSelect = false; }
          syncHelp(a, false, !!m.enter);
        } else {
          const prev = a.state;
          Object.assign(a, agent);
          if (prev !== a.state && a.state === 'thinking') a.bubble = null;
          syncHelp(a, false);
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
        const now = performance.now(), hid = m.sub.helperId, hp = hid && agents.get(hid);
        if (m.op === 'activity') { if (hp && hp.help && hp.help.subId === m.sub.subId) hp.help.tool = m.sub.tool; }
        else if (m.op === 'end') { if (hp && hp.help && hp.help.subId === m.sub.subId) endHelp(hp, m.sub.ok !== false, m.sub.short, now); }
        break;
      }
      case 'team': {
        const a = agents.get(m.id); if (!a) break;
        if (m.reset) { a.team = []; a.huddle = null; a.planAt = 0; } else { a.team.push(m.entry); if (a.team.length > 60) a.team.shift(); onTeamEntry(a, m.entry, performance.now()); }
        if (m.id === selectedId) renderTeam();
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
        flights.push({ kind: 'letter', pid: m.from, toId: m.to, t0: now, dur: 1500 * TS });
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
    renderTeam();
    updateHead();
  }

  function updateHead() {
    const a = agents.get(selectedId); if (!a) return;
    $('chatName').textContent = a.name;
    const tb = $('chatType'); tb.textContent = (TYPE_INFO[a.type] || [a.type])[0]; tb.className = 'typebadge ' + a.type;
    $('chatCwd').textContent = a.cwd; $('chatCwd').title = a.cwd;
    const st = $('chatState');
    if (a.helping) { st.textContent = 'helping ' + a.helping.parentName + ' · ' + a.helping.role; st.className = 'pill helping'; }
    else { st.textContent = a.state === 'working' && a.tool ? 'working · ' + a.tool : a.state; st.className = 'pill ' + a.state; }
    $('stopBtn').hidden = !(a.state === 'thinking' || a.state === 'working');
    $('queueInfo').textContent = a.queued ? `${a.queued} message(s) queued${a.helping ? ` until the helper job ends` : ''}` : (a.helping ? `helping ${a.helping.parentName}: new messages wait` : a.hasSession ? 'session active' : '');
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
    el.querySelector('summary').textContent = `↳ helper '${sb.label}' ${SUB_STATUS[sb.status] || sb.status}` + (sb.role ? ` · ${sb.role}` : sb.kind ? ` · ${sb.kind}` : '') + (sb.helper ? ` · ${sb.helper}` : '') + (sb.log.length ? ` · ${sb.log.length} step${sb.log.length > 1 ? 's' : ''}` : '');
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

  // ---------- team activity feed (per lead) ----------
  const TEAM_ICON = { plan: '📋', assign: '➜', note: '…', peer: '💬', handoff: '📨', mention: '✉', huddle: '👥' };
  function teamLine(e) {
    const d = document.createElement('div'); d.className = 'te ' + e.kind + (e.ok === false ? ' bad' : '');
    const ic = document.createElement('span'); ic.className = 'ti'; ic.textContent = TEAM_ICON[e.kind] || '•';
    const tx = document.createElement('span'); tx.className = 'tt'; tx.textContent = e.text;
    d.append(ic, tx);
    if (e.inferred) { const g = document.createElement('span'); g.className = 'inf'; g.textContent = 'inferred'; g.title = 'Guessed from the event stream' + (e.why ? ': ' + e.why : '') + '. The CLIs do not report real agent-to-agent messages.'; d.appendChild(g); d.title = g.title; }
    return d;
  }
  function renderTeam() {
    const a = agents.get(selectedId), box = $('teamBox'), log = $('teamLog');
    log.textContent = '';
    if (!a || !a.team || !a.team.length) { box.hidden = true; return; }
    box.hidden = false; $('teamCount').textContent = a.team.length + ' event' + (a.team.length > 1 ? 's' : '');
    for (const e of a.team) log.appendChild(teamLine(e));
    log.scrollTop = log.scrollHeight;
  }

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
        const beat = Math.floor((now - a.chatStart) / (1700 * TS));
        if (beat % 2 === a.chatSide) talk = Math.floor(beat / 2 + a.chatSide * 2) % 5;
      }
      let helpV = null, htalk = null, htalkDir = 1;
      if (a.help) {
        const h = a.help;
        const pose = h.phase === 'go' ? 'walk' : h.phase === 'work' ? 'work' : h.phase === 'back' ? 'walk'
          : (h.phase === 'failed' ? 'worry' : (now < h.endAt + 2600 * TS || (h.cheerUntil && now < h.cheerUntil)) ? 'cheer' : 'wait');
        const pe = h.peer && now < h.peer.until ? agents.get(h.peer.withId) : null;
        if (pe) {
          const beat = Math.floor((now - h.peer.t0) / (1100 * TS));
          if (beat % 2 === h.peer.side) htalk = ({ '?': 2, '!': 1, '...': 0 })[['?', '!', '...'][(h.peer.g + Math.floor(beat / 2)) % 3]];
          htalkDir = (pe.x - pe.y) >= (a.x - a.y) ? 1 : -1;
        }
        helpV = { role: h.role, label: h.label, tool: h.tool, phase: h.phase, pose, parentId: h.parentId, say: h.say && now < h.sayUntil ? h.say : null, peerWith: pe ? pe.id : null };
      }
      return { id: a.id, name: a.name, type: a.type, slot: a.slot, look: a.look, state: a.state, tool: a.tool, queued: a.queued,
        phase: a.phase, away: a.away, x: a.x, y: a.y, face: a.face || 0, mode: a.mode, bubble,
        act: a.act ? a.act.kind : null, actP: a.act ? (now - a.act.t0) / 1000 : 0,
        talk: htalk != null ? htalk : talk, talkDir: htalk != null ? htalkDir : (a.chatSide === 0 ? 1 : -1),
        help: helpV, waiting: (a.subs || []).length,
        planAge: a.planAt && now - a.planAt < 3200 * TS ? (now - a.planAt) / 1000 : null,
        huddle: a.huddle && now < a.huddle.until ? (now - a.huddle.t0) / 1000 : null,
        faceOv: a.turn && now < a.turn.until && !a.away ? a.turn.face : null,
        rcv: a.rcv ? { age: (now - a.rcv.t0) / 1000, ok: a.rcv.ok } : null };
    });
  }
  const flightsView = (now) => flights.map((f) => ({ kind: f.kind, pid: f.pid, hid: f.hid, toId: f.toId, ok: f.ok, p: (now - f.t0) / f.dur }));

  // ---------- helpers (subagents) = EXISTING colleagues ----------
  // The server assigns every sub-task to an existing person (idle first, otherwise a new regular agent is hired and walks in through the
  // door). That person gets `helping`; here they walk to the lead's desk, show a role badge + tool chip while working, take a paper from the lead,
  // hand an envelope (with a short summary bubble) back when done, wait for the team huddle and walk home to their own desk.
  const flights = [];                // in-flight papers/envelopes/letters
  const peerQ = [];                  // inferred peer events waiting for both helpers to have arrived
  const tileKey = (x, y) => Math.floor(x) * 100 + Math.floor(y);
  function allocSpot(parent) {
    const taken = [];
    for (const b of agents.values()) if (b.help && b.help.spot) taken.push(b.help.spot);
    const free = (Office.helperSpots ? Office.helperSpots(parent.slot) : []).filter((sp) => !taken.some((t) => tileKey(t.x, t.y) === tileKey(sp.x, sp.y)));
    // best score, but spread people out: a tile next to somebody already standing there costs extra
    let best = null, bs = Infinity;
    for (const sp of free) {
      const near = taken.reduce((n, t) => Math.max(n, 2 - Math.max(Math.abs(t.x - sp.x), Math.abs(t.y - sp.y))), 0);
      const sc = (sp.score || 0) + near * 0.9;
      if (sc < bs) { bs = sc; best = sp; }
    }
    return best;
  }
  function turnToward(a, x, y, ms, now) {
    const s = Office.SLOTS && Office.SLOTS[a.slot];
    if (s && s.seat && !a.away) a.turn = { face: faceOf(x - s.seat.x, y - s.seat.y), until: now + ms };
  }
  const seatOf = (a) => Office.SLOTS[a.slot].seat;
  function beginHelp(a, hp, now, o) {
    o = o || {};
    if (a.help && a.help.subId === hp.subId) return;
    if (a.help) { a.pendingHelp = hp; if (a.help.phase !== 'back') departHelp(a, now); return; }   // still walking home from the last job
    const h = { subId: hp.subId, parentId: hp.parentId, parentName: hp.parentName, label: hp.label, role: hp.role, kind: hp.kind, phase: 'go', tool: null, t0: now, endAt: 0,
      say: null, sayUntil: 0, peer: null, spot: null, ended: null, cheerUntil: 0 };
    a.help = h;
    const parent = agents.get(hp.parentId);
    const spot = parent && !parent.away && Office.walkBetween ? allocSpot(parent) : null;
    h.spot = spot;
    if (a.act) { a.act = null; }
    if (!spot) { h.phase = 'work'; h.seated = true; h.arrivedAt = now; return; }   // flat view / no room: help from their own desk
    a.partner = null; a.chatStart = 0;
    if (o.instant) {                        // reconnect: just stand there
      a.away = true; a.x = spot.x; a.y = spot.y; a.face = spot.face; a.spot = spot; a.mode = 'help'; a.dest = 'help'; h.phase = 'work'; h.arrivedAt = now - 4000; return;
    }
    const from = o.enter ? Office.SPOTS.door : a.away ? { x: a.x, y: a.y } : seatOf(a);
    a.pts = Office.walkBetween(from, spot); a.idx = 0; a.x = a.pts[0].x; a.y = a.pts[0].y;
    a.spot = spot; a.face = o.enter ? Office.SPOTS.door.face : (a.face || 0); a.away = true; a.mode = 'walk'; a.dest = 'help'; a.dir = 1; a.target = Math.min(1, a.pts.length - 1);
    if (a.pts.length === 1) arriveHelp(a, now);
  }
  function arriveHelp(a, now) {
    const h = a.help; if (!h) return;
    a.mode = 'help'; if (h.spot) a.face = h.spot.face; h.arrivedAt = now;
    const parent = agents.get(h.parentId);
    if (h.ended) { h.phase = 'work'; endHelp(a, h.ended.ok, h.ended.short, now); return; }
    h.phase = 'work';
    if (parent) { flights.push({ kind: 'out', pid: parent.id, hid: a.id, t0: now + 200, dur: 1000 * TS }); turnToward(parent, a.x, a.y, 1500 * TS, now); }
  }
  function endHelp(a, ok, short, now) {
    const h = a.help; if (!h || h.phase === 'ok' || h.phase === 'failed' || h.phase === 'back') return;
    if (h.phase === 'go') { h.ended = { ok, short }; return; }     // result arrived while still walking over: hand it over on arrival
    h.phase = ok ? 'ok' : 'failed'; h.endAt = now; h.tool = null; h.say = short || (ok ? 'done' : 'failed'); h.sayUntil = now + 3400 * TS;
    const parent = agents.get(h.parentId);
    if (parent && !h.seated) { flights.push({ kind: 'back', pid: parent.id, hid: a.id, ok, t0: now, dur: 1100 * TS }); turnToward(parent, a.x, a.y, 1200 * TS, now); }
  }
  function departHelp(a, now) {
    const h = a.help; if (!h) return;
    if (h.phase === 'work' || h.phase === 'go') { h.phase = 'back'; }
    h.phase = 'back'; h.say = null; h.peer = null;
    if (h.seated || !a.away || !a.spot || !Office.walkPath) { finishHome(a, now); return; }
    a.pts = Office.walkPath(a.slot, a.spot); a.idx = a.pts.length - 1; a.target = Math.max(0, a.idx - 1); a.dir = -1; a.mode = 'walk';
  }
  function finishHome(a, now) {
    a.help = null; a.away = false; a.mode = 'sit'; a.partner = null; endAct(a, now);
    if (a.pendingHelp) { const hp = a.pendingHelp; a.pendingHelp = null; beginHelp(a, hp, now); }
  }
  function onTeamEntry(a, e, now) {
    if (e.kind === 'plan') a.planAt = now;
    else if (e.kind === 'peer') peerQ.push({ e, t: now });
    else if (e.kind === 'mention') {
      const f = agents.get(e.from && e.from.helperId), t = agents.get(e.to && e.to.helperId);
      if (f && t && f.help && t.help && f.mode === 'help' && t.mode === 'help') flights.push({ kind: 'letter', pid: f.id, toId: t.id, t0: now + 600 * TS, dur: 1400 * TS });
    } else if (e.kind === 'huddle') {
      a.huddle = { t0: now, until: now + 3000 * TS }; a.bubble = e.text; a.bubbleAt = now;
      for (const b of agents.values()) if (b.help && b.help.parentId === a.id && (b.help.phase === 'ok' || b.help.phase === 'failed')) b.help.cheerUntil = a.huddle.until;
    }
  }
  /** make local state match the server (reconnect / late joiner / missed events) */
  function syncHelp(a, full, enter) {
    const now = performance.now();
    if (a.helping) beginHelp(a, a.helping, now, { instant: full && !a.help, enter: !!enter });
    else if (a.help && (a.help.phase === 'go' || a.help.phase === 'work') && full) { a.help.ended = a.help.ended || { ok: true, short: '' }; if (a.help.phase === 'work') endHelp(a, true, '', now); }
  }
  function updateHelp(now) {
    for (const a of agents.values()) {
      if (a.turn && now > a.turn.until) a.turn = null;
      if (a.huddle && now > a.huddle.until + 500) a.huddle = null;
      const h = a.help; if (!h) continue;
      if (h.say && now > h.sayUntil) h.say = null;
      if (h.peer) {
        const o = agents.get(h.peer.withId);
        if (now < h.peer.until && o && a.mode === 'help') a.face = faceOf(o.x - a.x, o.y - a.y); else { h.peer = null; if (h.spot && a.mode === 'help') a.face = h.spot.face; }
      } else if (a.mode === 'help' && h.spot && h.phase !== 'back') {      // finished helpers look at the lead
        const parent = agents.get(h.parentId);
        if (parent && (h.phase !== 'work')) a.face = faceOf(seatOf(parent).x - a.x, seatOf(parent).y - a.y); else a.face = h.spot.face;
      }
      if (h.phase === 'ok' || h.phase === 'failed') {
        const parent = agents.get(h.parentId);
        const others = [...agents.values()].some((b) => b !== a && b.help && b.help.parentId === h.parentId && (b.help.phase === 'go' || b.help.phase === 'work'));
        const huddling = parent && parent.huddle && now < parent.huddle.until;
        if (!parent || now > h.endAt + 7500 * TS || (now > h.endAt + 2600 * TS && !others && !huddling)) departHelp(a, now);
        else if (h.seated && now > h.endAt + 1500 * TS) departHelp(a, now);
      }
    }
    for (let i = peerQ.length - 1; i >= 0; i--) {
      const q = peerQ[i], e = q.e, A = agents.get(e.from && e.from.helperId), B = agents.get(e.to && e.to.helperId);
      if (!A || !B || now - q.t > 10000 * TS) { peerQ.splice(i, 1); continue; }
      if (A.mode === 'help' && B.mode === 'help' && A.help && B.help && A.help.phase === 'work' && B.help.phase === 'work') {
        const g = Math.max(0, ['?', '!', '...'].indexOf(e.glyph)), until = now + 3600 * TS;
        A.help.peer = { withId: B.id, t0: now, until, side: 0, g, why: e.text }; B.help.peer = { withId: A.id, t0: now, until, side: 1, g, why: e.text };
        peerQ.splice(i, 1);
      }
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
    canvas.title = hoverId ? tooltip(agents.get(hoverId)) : '';
  });
  function tooltip(a) {
    if (!a) return '';
    const h = a.help;
    if (!h) return a.name + ' · ' + a.state;
    let t = `${a.name} is helping ${h.parentName}: ${h.label} (${h.role})`;
    if (h.peer && performance.now() < h.peer.until) { const o = agents.get(h.peer.withId); t += `\ncomparing notes with ${o ? o.name : 'a colleague'} (inferred: ${h.peer.why})`; }
    return t;
  }
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
  const wantsHome = (a) => a.help && a.help.phase !== 'back' ? false : (a.state !== 'idle' && a.state !== 'done') || a.id === selectedId;
  const socialBusy = () => { for (const a of agents.values()) if (a.away) return true; return false; };
  const canStart = (a) => !a.away && !a.act && !a.help && !a.pendingHelp && !a.helping && a.state === 'idle' && a.id !== selectedId;
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
    const dur = { stretch: 3300 * TS, read: rand(7000, 11000) * TS, look: 5400 * TS }[kind];
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
    if (a.mode === 'help') return;
    if (a.mode === 'drink') { if (now > a.drinkUntil || wantsHome(a)) leave(a); return; }
    if (a.mode === 'chat') {
      const p = agents.get(a.partner);
      const partnerHere = p && p.away && p.partner === a.id && p.mode === 'chat';
      if (partnerHere && !a.chatStart) { a.chatStart = p.chatStart = now; a.until = p.until = now + (WANDER_FAST ? 7000 : rand(8000, 13000)) * TS; }
      if (!p || !p.away || p.partner !== a.id || wantsHome(a) || (a.chatStart && now > a.until) || (!a.chatStart && now - a.waitSince > 25000)) leave(a);
      return;
    }
    if (wantsHome(a) && a.dir === 1) { a.dir = -1; a.target = a.idx; a.partner = null; }
    const p = a.pts[a.target]; const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
    const stepLen = SPEED * dt / TS;
    if (d <= stepLen) {
      a.x = p.x; a.y = p.y; a.idx = a.target;
      if (a.dir === 1) {
        if (a.target === a.pts.length - 1) {
          if (a.spot && a.spot.face !== undefined) a.face = a.spot.face;
          if (a.dest === 'help') arriveHelp(a, now);
          else if (a.dest === 'drink') { a.mode = 'drink'; a.drinkUntil = now + (WANDER_FAST ? 4000 : rand(5000, 10000)) * TS; }
          else { a.mode = 'chat'; a.waitSince = now; }
        } else a.target++;
      } else if (a.target === 0) { if (a.help && a.help.phase === 'back') finishHome(a, now); else { a.away = false; a.mode = 'sit'; a.partner = null; endAct(a, now); } }
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
    update(dt, now); updateHelp(now);
    Office.render(canvas, S, U, { slow: TS, t: now / 1000, entries: entries(), selectedId, hoverId, hoverSlot, flights: flightsView(now) });
    requestAnimationFrame(frame);
  }

  // handy for tests / debugging in the console
  window.harness = {
    agents, select, send, view: VIEW, get selected() { return selectedId; }, get hover() { return { id: hoverId, slot: hoverSlot }; },
    states: () => [...agents.values()].map((a) => ({ id: a.id, name: a.name, type: a.type, state: a.state, tool: a.tool, away: a.away, mode: a.mode, act: a.act && a.act.kind, subs: (a.subs || []).length, helping: a.help ? a.help.phase : null, home: !a.away })),
    help: (id) => { const a = agents.get(id); return a && a.help ? { phase: a.help.phase, parentId: a.help.parentId, role: a.help.role, label: a.help.label, tool: a.help.tool, say: a.help.say, x: a.x, y: a.y, mode: a.mode, away: a.away, spot: a.help.spot, peer: !!a.help.peer, tile: Math.floor(a.x) + ',' + Math.floor(a.y) } : null; },
    team: (id) => { const a = agents.get(id); return a ? a.team.slice() : []; },
    huddle: (id) => { const a = agents.get(id); return !!(a && a.huddle && performance.now() < a.huddle.until); },
    tooltip: (id) => tooltip(agents.get(id)),
    flights: () => flights.map((f) => ({ kind: f.kind, pid: f.pid, hid: f.hid, toId: f.toId })),
    slow: TS,
    // kind: coffee | chat (needs partnerId) | stretch | read | look   (ignores timers/eligibility; for demos & tests)
    forceActivity: (id, kind, partnerId) => { const a = agents.get(id); if (a && !a.away) startActivity(a, kind, partnerId ? agents.get(partnerId) : null); },
    forceWander: (id) => { const a = agents.get(id); if (a && !a.away) startActivity(a, 'coffee'); },
  };

  resize(); connect(); requestAnimationFrame(frame);
})();
