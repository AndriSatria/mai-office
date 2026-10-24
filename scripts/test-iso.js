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
      // all 8 desks occupied: the person (head) and the desk top each resolve to that agent
      const all = Array.from({ length: 8 }, (_, i) => mk(i));
      for (let i = 0; i < 8; i++) {
        const s = O.SLOTS[i], [px, py] = O.project(s.seat.x, s.seat.y, 8 + 14);
        const head = O.hitTest(px, py, all), [dx, dy] = O.deskPoint(i), desk = O.hitTest(dx, dy, all);
        out.seated.push(head && head.id === 'a' + i && desk && desk.id === 'a' + i);
      }
      // a walker standing right in front of desk 1 is drawn on top of it and must win the hit test
      const s1 = O.SLOTS[1], wx = s1.dx + 1.5, wy = s1.dy + 1.1;
      const walker = { id: 'w', slot: 7, away: true, x: wx, y: wy, face: 1 };
      const list = all.slice(0, 7).concat([walker]);
      const [fx, fy] = O.project(wx, wy, 14);
      out.front = O.hitTest(fx, fy, list);
      // the same pixel with the walker standing far behind the desk must hit the desk instead
      const back = { id: 'w', slot: 7, away: true, x: s1.dx - 0.5 - 1, y: 5.5, face: 0 };
      out.behind = O.hitTest(fx, fy, all.slice(0, 7).concat([back]));
      // chair hits belong to that slot's agent
      const [cx, cy] = O.project(s1.dx - 0.5, s1.dy + 1.0, 4); out.chair = O.hitTest(cx, cy, all);
      return out;
    });
    assert(r.empty.every(Boolean), 'empty desks are hittable at their projected desk tops (8/8)');
    assert(r.outside === null, 'floor outside any object is not a hit');
    assert(r.seated.every(Boolean), 'seated agents + their desks resolve to the right agent (8/8)');
    assert(r.front && r.front.id === 'w', 'a walker in front of a desk is picked before the desk (front-most first)');
    assert(r.behind && r.behind.id === 'a1', 'the desk is picked when the walker is behind it');
    assert(r.chair && r.chair.id === 'a1', 'chair hit resolves to the seated agent');

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
      // depth: walking along every path (with all 8 desks occupied) the hit at the walker's torso is the walker itself
      // unless a desk/plant that is genuinely in front covers that pixel
      const all = Array.from({ length: 7 }, (_, i) => ({ id: 'a' + i, slot: i, away: false, x: 0, y: 0 }));
      let own = 0, other = 0;
      for (const [x, y] of samples) {
        const [px, py] = O.project(x, y, 16);
        const h = O.hitTest(px, py, all.concat([{ id: 'w', slot: 7, away: true, x, y, face: 0 }]));
        if (h && h.id === "w") own++; else { other++; (window.__miss = window.__miss || []).push([x.toFixed(2), y.toFixed(2), JSON.stringify(h)]); }
      }
      return { n, bad: bad.slice(0, 5), axis, own, other, miss: (window.__miss || []).slice(0, 12) };
    });
    assert(p.n === 8 * 3 && p.bad.length === 0, `${p.n} paths (8 desks x coffee/chat spots) never touch blocked tiles ${p.bad.length ? JSON.stringify(p.bad) : ''}`);
    if (p.miss.length) console.log('  misses:', JSON.stringify(p.miss));
    assert(p.axis, 'path segments follow the tile grid (axis aligned)');
    assert(p.own / (p.own + p.other) > 0.97, `walker torso is the front-most hit along paths (${p.own}/${p.own + p.other})`);

    // ---- real mouse through the canvas ----
    for (const n of ['Ada', 'Linus']) { await page.evaluate((n) => window.harness.send({ type: 'hire', name: n, cwd: '/tmp' }), n); await sleep(250); }
    await sleep(500);
    const box = await page.locator('#office').boundingBox();
    const toPage = async (fn) => page.evaluate(([fn, box]) => { const O = window.Office; const [x, y] = eval(fn); return [box.x + (x / O.W) * box.width, box.y + (y / O.H) * box.height]; }, [fn, box]);
    const [hx, hy] = await toPage('O.project(O.SLOTS[1].seat.x, O.SLOTS[1].seat.y, 20)');
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
    // integer pixel scale
    const sc = await page.evaluate(() => { const c = document.getElementById('office'); return [c.width / window.Office.W, c.height / window.Office.H]; });
    assert(Number.isInteger(sc[0]) && sc[0] === sc[1], `canvas is scaled by an integer factor (x${sc[0]})`);
  } finally {
    await browser.close(); srv.kill('SIGTERM');
  }
})().catch((e) => { console.error(e); process.exit(1); });
