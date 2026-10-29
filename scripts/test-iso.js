'use strict';
// Geometry tests for the isometric view: projection-aware hit testing (front-most first), pathfinding around
// furniture, depth ordering of walkers, and real mouse hover/click through the canvas.
// Usage: node scripts/test-iso.js   (needs Playwright + chromium, same as the screenshot script)
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const PORT = 3132;
const DATA = path.join(os.tmpdir(), `mai-office-iso-${Date.now()}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, HARNESS_MODE: 'mock', HARNESS_DATA: DATA } });
  await sleep(1000);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e); process.exitCode = 1; });
  try {
    await page.goto(`http://localhost:${PORT}/?wander=off`);
    await page.waitForSelector('#conn.on');
    assert(await page.evaluate(() => window.harness.view === 'iso' && window.Office === window.OfficeIso), 'iso is the default view');

    // ---- hit testing on the projection ----
    const r = await page.evaluate(() => {
      const O = window.Office, out = { empty: [], seated: [], front: null, chair: null, tool: null };
      const mk = (i, extra) => Object.assign({ id: 'a' + i, slot: i, away: false, x: 0, y: 0 }, extra);
      // empty office: every desk top is an empty-slot hit, nothing outside the room is
      for (let i = 0; i < O.MAX_SLOTS; i++) { const [x, y] = O.deskPoint(i); const h = O.hitTest(x, y, []); out.empty.push(h && h.slot === i); }
      out.outside = O.hitTest(5, 5, []);
      // every desk occupied: the person (head) and the desk top each resolve to that agent
      const N = O.MAX_SLOTS, M = O.MGR, all = Array.from({ length: N }, (_, i) => mk(i));
      for (let i = 0; i < N; i++) {
        const s = O.SLOTS[i], [px, py] = O.project(s.seat.x, s.seat.y, 8 + 14);
        const head = O.hitTest(px, py, all), [dx, dy] = O.deskPoint(i), desk = O.hitTest(dx, dy, all);
        out.seated.push(head && head.id === 'a' + i && desk && desk.id === 'a' + i);
      }
      // a walker standing right in front of desk 1 is drawn on top of it and must win the hit test
      const s1 = O.SLOTS[1], wx = s1.dx + 1.5, wy = s1.dy + 1.1;
      const walker = { id: 'w', slot: M - 1, away: true, x: wx, y: wy, face: 1 };
      const list = all.slice(0, M - 1).concat([walker, all[M]]);
      const [fx, fy] = O.project(wx, wy, 14);
      out.front = O.hitTest(fx, fy, list);
      // the same pixel with the walker standing far behind the desk must hit the desk instead
      const back = { id: 'w', slot: M - 1, away: true, x: s1.dx - 0.5 - 1, y: 5.5, face: 0 };
      out.behind = O.hitTest(fx, fy, all.slice(0, M - 1).concat([back, all[M]]));
      // chair hits belong to that slot's agent
      const [cx, cy] = O.project(s1.dx - 0.5, s1.dy + 1.0, 4); out.chair = O.hitTest(cx, cy, all);
      out.n = N; return out;
    });
    assert(r.n === 7 && r.empty.every(Boolean), `empty desks are hittable at their projected desk tops (6 desks + the manager desk, ${r.empty.filter(Boolean).length}/${r.n})`);
    assert(r.outside === null, 'floor outside any object is not a hit');
    assert(r.seated.every(Boolean), `seated agents + their desks resolve to the right agent (${r.seated.filter(Boolean).length}/${r.n}, manager desk included)`);
    assert(r.front && r.front.id === 'w', 'a walker in front of a desk is picked before the desk (front-most first)');
    assert(r.behind && r.behind.id === 'a1', 'the desk is picked when the walker is behind it');
    assert(r.chair && r.chair.id === 'a1', 'chair hit resolves to the seated agent');

    // ---- furniture footprints never overlap (manager desk, cafe counter, desks + chairs, round table + stools, plants) ----
    const ov = await page.evaluate(() => {
      const O = window.Office, T = O.TABLE, R = 2.0, fp = [];
      for (const s of O.SLOTS) if (!s.mgr) fp.push(['desk' + s.i, s.dx - 1, s.dy, s.dx + 1, s.dy + 2]);
      fp.push(['manager desk', O.MD.x0, O.MD.y0, O.MD.x1, O.MD.y1], ['manager chair', O.SLOTS[O.MGR].seat.x - 0.45, 1.1, O.SLOTS[O.MGR].seat.x + 0.45, 1.95]);
      fp.push(['cafe counter', O.COUNTER.x0, O.COUNTER.y0, O.COUNTER.x1, O.COUNTER.y1], ['round table', T.x - R, T.y - R, T.x + R, T.y + R]);
      for (const p of O.PLANTS) fp.push(['plant', p.x + 0.1, p.y + 0.1, p.x + 0.9, p.y + 0.9]);
      const hits = [];
      for (let i = 0; i < fp.length; i++) for (let j = i + 1; j < fp.length; j++) {
        const a = fp[i], b = fp[j];
        if (a[1] < b[3] && b[1] < a[3] && a[2] < b[4] && b[2] < a[4]) hits.push(a[0] + ' x ' + b[0]);
      }
      return { hits, gap: O.COUNTER.x0 - O.MD.x1 };
    });
    assert(ov.hits.length === 0, 'no two pieces of furniture overlap ' + JSON.stringify(ov.hits));
    assert(ov.gap >= 0.9, `a walkable tile separates the manager desk from the cafe counter (gap ${ov.gap} tiles)`);

    // ---- pathfinding avoids furniture; depth order of a walker ----
    const p = await page.evaluate(() => {
      const O = window.Office, bad = [], samples = [];
      let n = 0, axis = true;
      for (const s of O.SLOTS) for (const spot of [...O.SPOTS.coffee, ...O.SPOTS.chat]) {
        const pts = O.walkPath(s.i, spot); n++;
        for (let i = 1; i < pts.length; i++) {
          const first = i === 1; // the first leg starts in the chair, which is furniture by definition
          const a = pts[i - 1], b = pts[i];
          if (a.x !== b.x && a.y !== b.y) axis = false;
          if (first) continue;
          const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)), N = Math.ceil(len * 8);
          for (let k = 0; k <= N; k++) {
            const x = a.x + ((b.x - a.x) * k) / N, y = a.y + ((b.y - a.y) * k) / N;
            // walkers occupy a +-0.2 tile radius
            for (const [ox, oy] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) if (O.isBlocked(Math.floor(x + ox), Math.floor(y + oy))) bad.push([s.i, x.toFixed(2), y.toFixed(2)]);
            if (k % 8 === 0) samples.push([x, y]);
          }
        }
        const last = pts[pts.length - 1];
        if (Math.abs(last.x - spot.x) > 0.6 || Math.abs(last.y - spot.y) > 0.6) bad.push(['end', s.i]);
      }
      // depth: walking along every path (with the regular desks occupied) the hit at the walker's torso is the walker itself
      // unless a desk/plant that is genuinely in front covers that pixel
      const all = Array.from({ length: O.MGR - 1 }, (_, i) => ({ id: 'a' + i, slot: i, away: false, x: 0, y: 0 }));
      let own = 0, other = 0;
      for (const [x, y] of samples) {
        const [px, py] = O.project(x, y, 16);
        const h = O.hitTest(px, py, all.concat([{ id: 'w', slot: O.MGR - 1, away: true, x, y, face: 0 }]));
        if (h && h.id === "w") own++; else { other++; (window.__miss = window.__miss || []).push([x.toFixed(2), y.toFixed(2), JSON.stringify(h)]); }
      }
      return { n, slots: O.SLOTS.length, bad: bad.slice(0, 5), axis, own, other, miss: (window.__miss || []).slice(0, 12) };
    });
    assert(p.n === p.slots * 3 && p.bad.length === 0, `${p.n} paths (${p.slots} desks x coffee/chat spots) never touch blocked tiles ${p.bad.length ? JSON.stringify(p.bad) : ''}`);
    if (p.miss.length) console.log('  misses:', JSON.stringify(p.miss));
    assert(p.axis, 'path segments follow the tile grid (axis aligned)');
    assert(p.own / (p.own + p.other) > 0.97, `walker torso is the front-most hit along paths (${p.own}/${p.own + p.other})`);

    // ---- real mouse through the canvas ----
    // ---- manager desk: hit-test + hire through the dialog; the first hire is the main agent ----
    const mbox0 = await page.locator('#office').boundingBox();
    const [mdx, mdy] = await page.evaluate(([box]) => { const O = window.Office; const [x, y] = O.deskPoint(O.MGR); return [box.x + (x / O.W) * box.width, box.y + (y / O.H) * box.height]; }, [mbox0]);
    await page.mouse.move(mdx, mdy); await sleep(150);
    const MGR = await page.evaluate(() => window.Office.MGR);
    assert((await page.evaluate(() => window.harness.hover.slot)) === MGR, `hovering the (empty) manager desk targets slot ${MGR}`);
    await page.mouse.click(mdx, mdy); await sleep(200);
    assert(await page.evaluate(() => document.getElementById('hireDlg').open && /main/i.test(document.getElementById('hireNote').textContent)), 'clicking the manager desk opens the hire dialog with the "main agent" note');
    await page.fill('#hireName', 'Ada'); await page.click('#hireOk'); await sleep(500);
    const ada0 = await page.evaluate(() => { const a = [...window.harness.agents.values()].find((x) => x.name === 'Ada'); return a && { slot: a.slot, main: a.main }; });
    assert(ada0 && ada0.slot === MGR && ada0.main === true, `hiring at the manager desk makes the first agent main (slot ${MGR})`);
    await page.evaluate(() => window.harness.send({ type: 'hire', name: 'Linus', cwd: '/tmp' })); await sleep(300);
    const lin = await page.evaluate(() => { const a = [...window.harness.agents.values()].find((x) => x.name === 'Linus'); return { slot: a.slot, main: a.main }; });
    assert(lin.slot === 0 && !lin.main, 'the next hire takes a regular desk (slot 0), not the manager desk');
    await sleep(500);
    // the manager at the desk resolves from head, desk and chair-back hits
    const mh = await page.evaluate(() => {
      const O = window.Office, mgr = { id: 'm', slot: O.MGR, away: false, x: 0, y: 0, main: true }, out = {};
      const [hx, hy] = O.project(O.SLOTS[O.MGR].seat.x, O.SLOTS[O.MGR].seat.y, 8 + 14), [dx, dy] = O.deskPoint(O.MGR);
      out.head = O.hitTest(hx, hy, [mgr]); out.desk = O.hitTest(dx, dy, [mgr]);
      return { head: out.head && out.head.id, desk: out.desk && out.desk.id };
    });
    assert(mh.head === 'm' && mh.desk === 'm', 'manager: head and desk both resolve to the main agent');
    const box = await page.locator('#office').boundingBox();
    const toPage = async (fn) => page.evaluate(([fn, box]) => { const O = window.Office; const [x, y] = eval(fn); return [box.x + (x / O.W) * box.width, box.y + (y / O.H) * box.height]; }, [fn, box]);
    const [hx, hy] = await toPage('O.project(O.SLOTS[0].seat.x, O.SLOTS[0].seat.y, 20)');
    await page.mouse.move(hx, hy); await sleep(150);
    const hov = await page.evaluate(() => window.harness.hover);
    const cursor = await page.evaluate(() => document.getElementById('office').style.cursor);
    assert(hov.id && cursor === 'pointer', 'hovering a seated agent highlights them (pointer cursor)');
    await page.mouse.click(hx, hy); await sleep(150);
    const sel = await page.evaluate(() => window.harness.selected);
    assert(sel && sel === hov.id, 'clicking the person selects that agent');
    const [ex, ey] = await toPage('O.deskPoint(5)');
    await page.mouse.move(ex, ey); await sleep(150);
    assert((await page.evaluate(() => window.harness.hover.slot)) === 5, 'hovering an empty desk targets that slot');
    await page.mouse.click(ex, ey); await sleep(200);
    assert(await page.evaluate(() => document.getElementById('hireDlg').open), 'clicking an empty desk opens the hire dialog');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const d = document.getElementById('hireDlg'); if (d.open) d.close(); });

    // ---- desk-to-desk routes for the dotted lines / flying papers never cross furniture ----
    const rt = await page.evaluate(() => {
      const O = window.Office, bad = [], offs = [-0.2, -0.1, 0, 0.1, 0.2, 0.32]; let n = 0;
      for (let a = 0; a < O.MAX_SLOTS; a++) for (let b = 0; b < O.MAX_SLOTS; b++) if (a !== b) for (const off of offs) {
        const pts = O.deskRoute(a, b, off); n++;
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1], q = pts[i], N = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 8));
          for (let k = 0; k <= N; k++) { const x = p[0] + ((q[0] - p[0]) * k) / N, y = p[1] + ((q[1] - p[1]) * k) / N; if (O.isBlocked(Math.floor(x), Math.floor(y))) bad.push([a, b, off, x.toFixed(2), y.toFixed(2)]); }
        }
      }
      return { n, slots: O.MAX_SLOTS, bad: bad.slice(0, 3), nbad: bad.length };
    });
    assert(rt.nbad === 0, `all ${rt.n} desk-to-desk dotted routes (${rt.slots} desks, every pair, every lane) stay on free floor ${JSON.stringify(rt.bad)}`);

    // ---- live /code-review: helpers work at THEIR OWN desks, papers fly along dotted lines, wrap-up at each desk ----
    for (const n of ['Grace', 'Alan']) { await page.evaluate((n) => window.harness.send({ type: 'hire', name: n, cwd: '/tmp' }), n); await sleep(250); }
    await sleep(500);
    const adaId = await page.evaluate(() => [...window.harness.agents.values()].find((a) => a.name === 'Ada').id);
    await page.evaluate((id) => window.harness.select(id), adaId);
    assert(await page.evaluate(() => !document.getElementById('relayTo').hidden), 'chat shows the send-to-agent select');
    // record anybody who appears at the door
    await page.evaluate(() => { window.__first = {}; window.__n0 = window.harness.agents.size; window.__ids0 = new Set(window.harness.agents.keys()); setInterval(() => { for (const a of window.harness.agents.values()) { const h = window.harness.help(a.id); if (!window.__ids0.has(a.id) && !window.__first[a.name] && h) window.__first[a.name] = { x: h.x, y: h.y, mode: h.mode }; } }, 20); });
    await page.fill('#input', '/code-review'); await page.press('#input', 'Enter');
    await page.waitForFunction((id) => window.harness.states().filter((s) => s.helping === 'work').length >= 4, adaId, { timeout: 40000 });
    const live = await page.evaluate((id) => {
      const H = window.harness, ppl = [...H.agents.values()], helpers = ppl.filter((a) => H.help(a.id));
      const tiles = new Set(helpers.map((a) => a.slot));
      const seated = helpers.every((a) => { const h = H.help(a.id); return h.seated && !h.away; });
      const ada = ppl.find((a) => a.id === id);
      return { n: helpers.length, tiles: tiles.size, seated, roles: helpers.map((a) => H.help(a.id).role).sort(), people: ppl.length, n0: window.__n0, first: window.__first, notAda: !H.help(id),
        sub: document.querySelectorAll('#transcript details.msg.sub').length, open: document.querySelectorAll('#transcript details.msg.sub[open]').length,
        team: document.querySelectorAll('#teamLog .te').length, teamVisible: !document.getElementById('teamBox').hidden,
        tip: H.tooltip(helpers[0].id), names: helpers.map((a) => a.name), hired: ppl.filter((a) => a.transcript.some((m) => /Hired automatically/.test(m.text))).map((a) => a.name) };
    }, adaId);
    assert(live.n === 4 && live.tiles === 4 && live.notAda, `/code-review: 4 people (not the lead), each from a different desk (${live.names.join(',')})`);
    assert(live.seated, 'all 4 helpers are SEATED at their own desks while working (nobody standing around the lead)');
    assert(JSON.stringify(live.roles) === JSON.stringify(['performance', 'security', 'style', 'tests']), `helpers carry the 4 derived roles (${live.roles.join(',')})`);
    assert(live.people === live.n0 + 1 && live.hired.length === 1, `office had 3 idle colleagues, so exactly 1 new regular agent was auto-hired (${live.hired.join(',')})`);
    const fp = live.first[live.hired[0]];
    assert(fp && fp.mode === 'walk' && Math.hypot(fp.x - 0.5, fp.y - 4.7) < 0.8, `the auto-hired person first appears walking at the door, not popping in at a desk (${fp ? fp.x.toFixed(2) + ',' + fp.y.toFixed(2) : 'never seen'})`);
    assert(/helping Ada/.test(live.tip), `hover tooltip says who they help ("${live.tip.split('\n')[0]}")`);
    assert(live.sub === 4 && live.open === 0, 'chat: 4 collapsed "↳ helper" lines under the /code-review message');
    assert(live.teamVisible && live.team >= 5, `Team activity feed lists the exchanges (${live.team} lines)`);
    const hid = await page.evaluate((id) => { const H = window.harness; return [...H.agents.values()].filter((a) => H.help(a.id)).map((a) => a.id); }, adaId);
    // a real message typed to a helper waits (queued pill) until the helper job ends
    await page.evaluate(([id]) => window.harness.send({ type: 'send', id, text: 'when you are free: ping me' }), [hid[0]]);
    await sleep(300);
    assert(await page.evaluate((id) => window.harness.agents.get(id).queued >= 1, hid[0]), 'a message to a helping person is queued, not run');
    await page.click('#transcript details.msg.sub summary'); await sleep(200);
    assert(await page.evaluate(() => document.querySelectorAll('#transcript details.msg.sub[open]').length === 1), 'expanding a helper line shows its activity log');
    assert(/helper '[^']+' (started|finished)/.test(await page.evaluate(() => document.querySelector('#transcript details.msg.sub summary').textContent)), 'sub line reads "↳ helper \'label\' started/finished"');
    // flights + inferred interactions during the run
    let kinds = new Set(), sawPeerTalk = false, sawHuddle = false, standing = 0;
    for (let i = 0; i < 700 && !(sawHuddle && kinds.has('back') && kinds.has('out') && sawPeerTalk); i++) {
      const r = await page.evaluate((id) => ({ st: window.harness.states().filter((s) => s.helping === 'work' && !s.seated).length, f: window.harness.flights().map((f) => f.kind), pe: [...window.harness.agents.values()].some((a) => (window.harness.help(a.id) || {}).peer), hu: window.harness.huddle(id) }), adaId);
      standing += r.st; r.f.forEach((k) => kinds.add(k)); sawPeerTalk = sawPeerTalk || r.pe; sawHuddle = sawHuddle || r.hu; await sleep(60);
    }
    assert(standing === 0, 'during the whole run no working helper was ever standing/walking away from their desk');
    assert(kinds.has('out') && kinds.has('back'), 'paper flies lead -> helper and an envelope flies helper -> lead');
    assert(sawPeerTalk, 'two helpers touching the same file talk across their desks via bubbles + a peer line (inferred peer talk), without walking');
    assert(sawHuddle, 'synchronized wrap-up (celebration at every desk + team wrap-up chip) shows when every helper has reported');
    const inf = await page.evaluate((id) => ({ team: window.harness.team(id), tags: [...document.querySelectorAll('#teamLog .te .inf')].map((e) => e.textContent) }), adaId);
    assert(inf.team.filter((e) => e.kind === 'peer').every((e) => e.inferred) && inf.team.some((e) => e.kind === 'peer') && inf.tags.length >= 1, 'peer entries are flagged inferred and tagged "inferred" in the feed');
    assert(inf.team.some((e) => e.kind === 'handoff' && e.ok === false) && inf.team.some((e) => e.kind === 'huddle'), 'one failing helper is reported in the handoffs; huddle entry exists');
    await page.waitForFunction((id) => window.harness.states().find((a) => a.id === id).state === 'done' || window.harness.states().find((a) => a.id === id).state === 'idle', adaId, { timeout: 60000 });
    await page.waitForFunction(() => window.harness.states().every((a) => !a.helping && a.home) && window.harness.flights().length === 0, null, { timeout: 30000 });
    assert(true, 'everybody is released from helper state at their own desk, flights cleaned up');
    const post = await page.evaluate((ids) => ({ sys: ids.map((id) => window.harness.agents.get(id).transcript.some((m) => m.role === 'system' && /^helped Ada: /.test(m.text))),
      ran: window.harness.agents.get(ids[0]).transcript.some((m) => m.role === 'user' && m.text === 'when you are free: ping me'), sub: document.querySelectorAll('#transcript details.msg.sub.finished, #transcript details.msg.sub.failed').length }), hid);
    assert(post.sys.every(Boolean), "each helper's own transcript got a 'helped Ada: …' system line");
    assert(post.ran, 'the queued message ran after the helper job ended');
    assert(post.sub === 4, 'sub lines end as finished/failed');

    // ---- agent-to-agent message: letter flight + forwarded input ----
    await page.selectOption('#relayTo', { label: '→ Linus' });
    await page.fill('#input', 'please look at my diff'); await page.press('#input', 'Enter');
    let sawLetter = false;
    for (let i = 0; i < 20 && !sawLetter; i++) { sawLetter = (await page.evaluate(() => window.harness.flights().map((f) => f.kind))).includes('letter'); await sleep(50); }
    assert(sawLetter, 'sending to another agent flies a letter between the two characters');
    await page.waitForFunction(() => [...window.harness.agents.values()].find((a) => a.name === 'Linus').transcript.some((m) => m.role === 'user' && m.text === '[from Ada] please look at my diff'), null, { timeout: 5000 });
    assert(true, 'target agent receives "[from Ada] …" as input');
    assert(await page.evaluate(() => document.getElementById('relayTo').value === ''), 'send-to select resets to "this agent" after sending');

    // ---- plan mode: the plan owner walks to the round table, idle colleagues join, busy ones stay, then everybody walks home ----
    await page.waitForFunction(() => window.harness.states().every((a) => a.home && !a.helping && a.state !== 'working' && a.state !== 'thinking'), null, { timeout: 40000 });
    const geo = await page.evaluate(() => { const O = window.Office; return { seats: O.SEATS.length, tb: O.tablePoint ? 1 : 0 }; });
    assert(geo.seats >= 6 && geo.seats <= 8, `round table has ${geo.seats} chairs`);
    const ids0 = await page.evaluate(() => Object.fromEntries([...window.harness.agents.values()].map((a) => [a.name, a.id])));
    const total = Object.keys(ids0).length;
    await page.evaluate((id) => window.harness.select(id), ids0.Grace);
    await page.evaluate((id) => window.harness.send({ type: 'send', id, text: 'refactor everything slowly' }), ids0.Linus);   // Linus is busy -> stays at his desk
    await sleep(500);
    await page.fill('#input', '/plan add a dark mode toggle'); await page.press('#input', 'Enter');
    await page.waitForFunction(() => window.harness.plan().state === 'planning', null, { timeout: 10000 });
    assert(true, 'mock "/plan <task>" puts the agent into plan mode (planning)');
    const want = Math.min(total - 1, geo.seats);
    let sawDrink = false, sawChat = false, linusSeated = false;
    const t0 = Date.now(); let pl;
    for (;;) {
      pl = await page.evaluate(() => ({ p: window.harness.plan(), st: window.harness.states() }));
      sawDrink = sawDrink || pl.st.some((a) => a.mode === 'drink'); sawChat = sawChat || pl.st.some((a) => a.mode === 'chat');
      linusSeated = linusSeated || pl.p.seated.includes(ids0.Linus);
      if (pl.p.seated.length >= want || Date.now() - t0 > 30000 || pl.p.state === null) break;
      await sleep(100);
    }
    const lstate = pl.st.find((a) => a.name === 'Linus');
    assert(pl.p.seated.includes(ids0.Grace) && pl.p.owner === ids0.Grace, 'the plan owner sits at the round table');
    assert(pl.p.seated.length >= want, `idle colleagues gathered at the table (${pl.p.seated.length} seated of ${total} people, Linus busy)`);
    assert(!linusSeated && (lstate.home || lstate.state === 'done' || lstate.state === 'idle') && !pl.p.seated.includes(ids0.Linus), 'a working colleague stays at his desk');
    assert(!sawDrink && !sawChat, 'no coffee / chat walks while the team is gathered');
    const seatSet = new Set(await page.evaluate(() => window.harness.states().filter((a) => a.meet).map((a) => a.slot)));
    assert(seatSet.size === pl.p.seated.length, 'every person at the table is in a different chair');
    await page.waitForFunction(() => window.harness.plan().state === 'ready', null, { timeout: 40000 });
    const rdy = await page.evaluate(() => window.harness.plan());
    assert(rdy.summary && rdy.summary.length > 10 && rdy.seated.length >= want - 1, 'plan ready: summary shown over the table, the team is still seated: ' + rdy.summary);
    await page.waitForFunction(() => window.harness.plan().state === null && window.harness.states().every((a) => a.home), null, { timeout: 60000 });
    assert(true, 'after the plan is approved everybody walks back to their own desk');
    const back = await page.evaluate(() => window.harness.states().every((a) => a.home && a.seated));
    assert(back, 'all people are seated at their desks again');

    // ---- promote through the UI: swap desks with the current main ----
    await page.evaluate((id) => window.harness.select(id), ids0.Grace);
    assert(await page.evaluate(() => !document.getElementById('mainBtn').hidden), 'a non-main agent shows the "Make main" button');
    const gs = await page.evaluate((id) => window.harness.states().find((a) => a.id === id).slot, ids0.Grace);
    await page.click('#mainBtn'); await sleep(600);
    const sw = await page.evaluate((ids) => ({ g: window.harness.states().find((a) => a.id === ids.Grace), a: window.harness.states().find((a) => a.id === ids.Ada) }), ids0);
    assert(sw.g.main && sw.g.slot === MGR && !sw.a.main && sw.a.slot === gs && sw.g.home && sw.a.home, `Make main: Grace -> manager desk, Ada -> desk ${gs}`);
    assert(await page.evaluate(() => document.getElementById('mainBtn').hidden && !document.getElementById('mainBadge').hidden), 'the main agent shows the ★ main badge instead of the button');

    // integer pixel scale
    const sc = await page.evaluate(() => { const c = document.getElementById('office'); return [c.width / window.Office.W, c.height / window.Office.H]; });
    assert(Number.isInteger(sc[0]) && sc[0] === sc[1], `canvas is scaled by an integer factor (x${sc[0]})`);
  } finally {
    await browser.close(); srv.kill('SIGTERM');
  }
})().catch((e) => { console.error(e); process.exit(1); });
