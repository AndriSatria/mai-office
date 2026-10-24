/* mAI office - ISOMETRIC (2:1 dimetric) procedural pixel-art renderer. This is the default view
 * (add ?view=flat for the old top-down one in office-flat.js).
 *
 * No assets: everything is drawn with fillRect / scan-line polygons on a small logical canvas
 * (400x264) that is blitted to the visible canvas with integer scaling and smoothing disabled.
 * World = a 12x12 tile grid. Tile (x,y) -> screen: sx = OX + (x-y)*16, sy = OY + (x+y)*8 - z.
 *   +x runs down-right ("SE"), +y runs down-left ("SW"); the two back walls are the planes y=0 and x=0.
 * Facings (4): 0 = SE (+x), 1 = SW (+y), 2 = NW (-x), 3 = NE (-y). SW/NW are mirrors of SE/NE.
 * Depth sorting is a footprint-aware painter's algorithm (topological, not just x+y).
 * Text (names, badges, tool chips, speech bubbles) is drawn on the visible canvas at native res. */
(function () {
  'use strict';
  const F = window.OfficeFlat;
  const { R, shade, rnd, disc, line, stateIcon, drawTalk, pillText, measurePill, drawBubble, TYPE_BADGE, STATE_COL } = F.shared;

  const W = 400, H = 264, OX = 200, OY = 62, GX = 12, GY = 12, WH = 56;
  const SEAT = 8, DESKZ = 13, MAX_SLOTS = 8, SPEED = 2.6; // SPEED in tiles/second
  const sx = (x, y) => OX + Math.round((x - y) * 16);
  const sy = (x, y, z) => OY + Math.round((x + y) * 8) - (z || 0);
  const A = (x, y, z) => [sx(x, y), sy(x, y, z)];
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // ---------- layout ----------
  // 8 desks: two rows (x) of four (y). Chair on the -x side, desk 1x2 tiles, character faces +x (SE).
  const SLOTS = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const row = i >> 2, col = i & 3, dx = row ? 5 : 2, dy = 1 + 3 * col;
    SLOTS.push({ i, row, col, dx, dy, seat: { x: dx - 0.5, y: dy + 1 } });
  }
  const COUNTER = { x0: 8, y0: 0, x1: 12, y1: 1 };
  const PLANTS = [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 11, y: 5 }, { x: 11, y: 11 }, { x: 0, y: 11 }, { x: 7, y: 11 }];
  const RUG = { x0: 8, y0: 1, x1: 11, y1: 4 };
  // standing spots (tile centres) near the coffee corner + the direction they face
  const SPOTS = {
    coffee: [{ x: 9.5, y: 1.5, face: 1 }],
    chat: [{ x: 8.5, y: 3.5, face: 0 }, { x: 9.5, y: 3.5, face: 2 }],
  };

  // blocked[y][x]: furniture the pathfinder must avoid
  const blocked = Array.from({ length: GY }, () => Array(GX).fill(false));
  const block = (x0, y0, x1, y1) => { for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) blocked[y][x] = true; };
  for (const s of SLOTS) { block(s.dx, s.dy, s.dx + 1, s.dy + 2); block(s.dx - 1, s.dy, s.dx, s.dy + 2); }
  block(COUNTER.x0, COUNTER.y0, COUNTER.x1, COUNTER.y1);
  for (const p of PLANTS) block(p.x, p.y, p.x + 1, p.y + 1);
  const isBlocked = (tx, ty) => tx < 0 || ty < 0 || tx >= GX || ty >= GY || blocked[ty][tx];

  /** Tile-grid path (4-neighbour BFS, so it never cuts through furniture) from a desk to a spot.
   *  Returns waypoints [{x,y}] in world (tile) coords: seat, ..., spot. Collinear points are merged. */
  function walkPath(slot, spot) {
    const s = SLOTS[slot];
    const key = (x, y) => y * GX + x;
    const prev = new Map(), q = [];
    for (const [x, y] of [[s.dx - 1, s.dy], [s.dx - 1, s.dy + 1]]) { prev.set(key(x, y), -1); q.push([x, y]); }
    const gx = Math.floor(spot.x), gy = Math.floor(spot.y);
    const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let found = false;
    while (q.length) {
      const [x, y] = q.shift();
      if (x === gx && y === gy) { found = true; break; }
      for (const [dx, dy] of D) {
        const nx = x + dx, ny = y + dy;
        if (isBlocked(nx, ny) || prev.has(key(nx, ny))) continue;
        prev.set(key(nx, ny), key(x, y)); q.push([nx, ny]);
      }
    }
    const tiles = [];
    if (found) { for (let k = key(gx, gy); k !== -1; k = prev.get(k)) tiles.unshift([k % GX, Math.floor(k / GX)]); }
    const pts = [{ x: s.seat.x, y: s.seat.y }];
    for (const [x, y] of tiles) pts.push({ x: x + 0.5, y: y + 0.5 });
    pts[pts.length - 1] = { x: spot.x, y: spot.y };
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) { // drop collinear middles
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 1e-6) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // ---------- raster helpers ----------
  /** Fill a polygon; a pixel is inside when its centre is, so neighbouring polygons never leave gaps. */
  function poly(c, pts, col) {
    c.fillStyle = col;
    let mn = Infinity, mx = -Infinity;
    for (const p of pts) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; }
    const n = pts.length;
    for (let y = Math.ceil(mn - 0.5); y <= Math.floor(mx - 0.5); y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.ceil(xs[i] - 0.5), xb = Math.ceil(xs[i + 1] - 0.5);
        if (xb > xa) c.fillRect(xa, y, xb - xa, 1);
      }
    }
  }
  const inPoly = (p, x, y) => { // point in convex/concave polygon (even-odd)
    let ins = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) ins = !ins;
    }
    return ins;
  };
  /** Axis-aligned iso box. cols: {top, se, sw, hi?, dk?}. se = face at x=x1, sw = face at y=y1. */
  function box(c, x0, y0, x1, y1, z0, z1, cols) {
    poly(c, [A(x0, y0, z1), A(x1, y0, z1), A(x1, y1, z1), A(x0, y1, z1)], cols.top);
    poly(c, [A(x1, y0, z1), A(x1, y1, z1), A(x1, y1, z0), A(x1, y0, z0)], cols.se);
    poly(c, [A(x0, y1, z1), A(x1, y1, z1), A(x1, y1, z0), A(x0, y1, z0)], cols.sw);
    if (cols.hi) { // highlight along the two front top edges
      const a = A(x0, y1, z1), b = A(x1, y1, z1), d = A(x1, y0, z1);
      line(c, a[0], a[1], b[0], b[1], cols.hi, 1); line(c, b[0], b[1], d[0], d[1], cols.hi, 1);
    }
    if (cols.dk) { const b = A(x1, y1, z1), e = A(x1, y1, z0); line(c, b[0], b[1], e[0], e[1] - 1, cols.dk, 1); }
  }
  const boxHex = (x0, y0, x1, y1, z0, z1) => [A(x0, y0, z1), A(x1, y0, z1), A(x1, y0, z0), A(x1, y1, z0), A(x0, y1, z0), A(x0, y1, z1)];
  /** Rect drawn on a vertical wall-like plane. (px0,py0) = screen position of the plane's floor-level start vertex,
   *  dir +1 for planes that run down-right (y = const), -1 for planes running down-left (x = const),
   *  a = pixels along the plane, v = height above the floor. */
  function pr(c, px0, py0, dir, a0, a1, v0, v1, col) {
    c.fillStyle = col;
    for (let k = a0; k < a1; k++) c.fillRect(dir > 0 ? px0 + k : px0 - 1 - k, py0 + ((k + 1) >> 1) - v1, 1, v1 - v0);
  }

  // ---------- static background ----------
  function window3(c, px0, py0, dir, a0, w, v0, h) {
    pr(c, px0, py0, dir, a0 - 2, a0 + w + 2, v0 - 1, v0 + h + 2, '#2b3149');
    pr(c, px0, py0, dir, a0 - 1, a0 + w + 1, v0 + h, v0 + h + 1, '#aab4d2');
    pr(c, px0, py0, dir, a0, a0 + w, v0, v0 + h, '#8ec9ff');
    pr(c, px0, py0, dir, a0, a0 + w, v0, v0 + 7, '#b4e0ff');
    pr(c, px0, py0, dir, a0 + 3, a0 + 10, v0 + h - 7, v0 + h - 5, '#fff'); pr(c, px0, py0, dir, a0 + 5, a0 + 9, v0 + h - 5, v0 + h - 3, '#fff');
    pr(c, px0, py0, dir, a0 + w - 10, a0 + w - 3, v0 + 8, v0 + 10, '#fff');
    pr(c, px0, py0, dir, a0 + (w >> 1) - 1, a0 + (w >> 1) + 1, v0, v0 + h, '#eef1f8');
    pr(c, px0, py0, dir, a0, a0 + w, v0 + (h >> 1), v0 + (h >> 1) + 1, '#eef1f8');
    pr(c, px0, py0, dir, a0 - 3, a0 + w + 3, v0 - 3, v0 - 1, '#cdd3e6'); pr(c, px0, py0, dir, a0 - 3, a0 + w + 3, v0 - 4, v0 - 3, '#7a84a6');
  }
  const GLYPH = { C: ['###', '#..', '#..', '#..', '###'], A: ['###', '#.#', '###', '#.#', '#.#'], F: ['###', '#..', '##.', '#..', '#..'], E: ['###', '#..', '##.', '#..', '###'] };
  function plant(c, x, y) { // drawn dynamically so characters can pass in front / behind
    const cx = sx(x + 0.5, y + 0.5), by = sy(x + 0.5, y + 0.5, 0);
    box(c, x + 0.28, y + 0.28, x + 0.72, y + 0.72, 0, 7, { top: '#6b3f1c', se: '#9a5a22', sw: '#b5702e', hi: '#d28a3a' });
    box(c, x + 0.24, y + 0.24, x + 0.76, y + 0.76, 7, 9, { top: '#4a2c14', se: '#a85f26', sw: '#c47f38' });
    for (const [dx, dy, r, col] of [[-6, -13, 5, '#2f8f4e'], [6, -13, 5, '#2f8f4e'], [0, -20, 6, '#3fae60'], [-4, -18, 5, '#3fae60'], [5, -18, 4, '#3fae60'], [0, -13, 5, '#2f8f4e']]) disc(c, cx + dx, by + dy, r, col);
    for (const [dx, dy] of [[-3, -22], [3, -17], [-7, -15], [1, -12]]) R(c, cx + dx, by + dy, 2, 2, '#7be39b');
    R(c, cx - 1, by - 11, 2, 3, '#1f6b3a');
  }

  function buildBackground() {
    const bg = mk(W, H), c = bg.getContext('2d');
    // floor slab edges (visible thickness on the two front sides)
    poly(c, [A(12, 0, 0), A(12, 12, 0), A(12, 12, -7), A(12, 0, -7)], '#5e4f3b');
    poly(c, [A(0, 12, 0), A(12, 12, 0), A(12, 12, -7), A(0, 12, -7)], '#7a6a52');
    // diamond tile floor, checkerboard
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) poly(c, [A(i, j), A(i + 1, j), A(i + 1, j + 1), A(i, j + 1)], (i + j) % 2 ? '#d9cdb4' : '#cfc3a9');
    for (let i = 0; i <= GX; i++) { const a = A(i, 0), b = A(i, GY); line(c, a[0], a[1], b[0], b[1], 'rgba(90,72,45,.14)', 1); }
    for (let j = 0; j <= GY; j++) { const a = A(0, j), b = A(GX, j); line(c, a[0], a[1], b[0], b[1], 'rgba(90,72,45,.14)', 1); }
    // edge highlight on the slab
    let a = A(0, 12), b = A(12, 12), d = A(12, 0);
    line(c, a[0], a[1], b[0], b[1], '#a89676', 1); line(c, b[0], b[1], d[0], d[1], '#8a7a5c', 1);

    // floor shadows under furniture
    for (const s of SLOTS) {
      poly(c, [A(s.dx, s.dy + 0.05), A(s.dx + 1.35, s.dy + 0.05), A(s.dx + 1.35, s.dy + 2.15), A(s.dx, s.dy + 2.15)], 'rgba(40,30,15,.17)');
      poly(c, [A(s.dx - 0.95, s.dy + 0.5), A(s.dx - 0.1, s.dy + 0.5), A(s.dx - 0.1, s.dy + 1.6), A(s.dx - 0.95, s.dy + 1.6)], 'rgba(40,30,15,.12)');
    }
    // rug under the coffee corner
    const rp = (i) => (x0, y0, x1, y1, col) => poly(c, [A(x0, y0), A(x1, y0), A(x1, y1), A(x0, y1)], col);
    const rug = rp();
    rug(RUG.x0, RUG.y0, RUG.x1, RUG.y1, '#6e343b');
    rug(RUG.x0 + 0.12, RUG.y0 + 0.12, RUG.x1 - 0.12, RUG.y1 - 0.12, '#a45560');
    rug(RUG.x0 + 0.38, RUG.y0 + 0.38, RUG.x1 - 0.38, RUG.y1 - 0.38, '#8d4650');
    for (let k = 0; k < 6; k++) rug(RUG.x0 + 0.5 + k * 0.4, RUG.y0 + 0.5, RUG.x0 + 0.62 + k * 0.4, RUG.y1 - 0.5, '#a45560');
    rug(RUG.x0 + 0.62, RUG.y0 + 0.62, RUG.x1 - 0.62, RUG.y0 + 0.74, '#d9a86b'); rug(RUG.x0 + 0.62, RUG.y1 - 0.74, RUG.x1 - 0.62, RUG.y1 - 0.62, '#d9a86b');

    // ----- back walls -----
    const RW = [OX, OY, 1], LW = [OX, OY, -1];
    poly(c, [A(0, 0, WH), A(12, 0, WH), A(12, 0, 0), A(0, 0, 0)], '#7886b0');
    poly(c, [A(0, 0, WH), A(0, 12, WH), A(0, 12, 0), A(0, 0, 0)], '#65729a');
    for (const [P, dark, wain, hi] of [[RW, '#6b79a3', '#56638a', '#98a5cb'], [LW, '#5a668c', '#4a5679', '#8693b9']]) {
      for (let k = 0; k < 192; k += 32) pr(c, P[0], P[1], P[2], k, k + 1, 14, WH - 3, dark);       // panel seams
      pr(c, P[0], P[1], P[2], 0, 192, 0, 14, wain);                                                    // wainscot
      pr(c, P[0], P[1], P[2], 0, 192, 14, 15, hi);                                                     // chair rail
      pr(c, P[0], P[1], P[2], 0, 192, 0, 3, '#2f3752');                                                // baseboard
      for (let k = 16; k < 192; k += 32) pr(c, P[0], P[1], P[2], k, k + 1, 3, 14, shade(wain, -14)); // wainscot seams
    }
    // wall top trims (give the walls some thickness)
    const trim = { top: '#aab4d2', se: '#59648a', sw: '#8d99be' };
    box(c, 0, -0.25, 12, 0, WH - 3, WH, trim);
    box(c, -0.25, 0, 0, 12, WH - 3, WH, trim);
    box(c, -0.25, -0.25, 0, 0, WH - 3, WH, trim);
    // windows
    window3(c, ...RW, 20, 30, 20, 26); window3(c, ...RW, 62, 30, 20, 26);
    window3(c, ...LW, 20, 30, 20, 26); window3(c, ...LW, 62, 30, 20, 26);
    // poster (right wall) + whiteboard & poster (left wall)
    pr(c, ...RW, 104, 124, 22, 46, '#2b3149'); pr(c, ...RW, 105, 123, 23, 45, '#f2e6c8');
    pr(c, ...RW, 108, 120, 34, 42, '#3e8ef7'); pr(c, ...RW, 110, 114, 34, 38, '#30a46c'); pr(c, ...RW, 115, 119, 36, 41, '#f5a524');
    pr(c, ...RW, 108, 120, 30, 31, '#6b5b3a'); pr(c, ...RW, 108, 116, 27, 28, '#6b5b3a'); pr(c, ...RW, 108, 118, 25, 26, '#6b5b3a');
    pr(c, ...LW, 128, 146, 22, 46, '#2b3149'); pr(c, ...LW, 129, 145, 23, 45, '#f2e6c8');
    pr(c, ...LW, 132, 142, 31, 42, '#e93d82'); pr(c, ...LW, 134, 140, 34, 39, '#f5c542'); pr(c, ...LW, 132, 142, 26, 27, '#6b5b3a'); pr(c, ...LW, 132, 139, 28, 29, '#6b5b3a');
    pr(c, ...LW, 152, 190, 22, 48, '#cdd3e6'); pr(c, ...LW, 153, 189, 23, 47, '#f7f8fc');
    pr(c, ...LW, 156, 176, 40, 41, '#e5484d'); pr(c, ...LW, 156, 168, 36, 37, '#3e8ef7'); pr(c, ...LW, 156, 182, 32, 33, '#30a46c'); pr(c, ...LW, 170, 184, 27, 28, '#8e4ec6');
    pr(c, ...LW, 152, 190, 20, 22, '#9aa0b4');
    // clock (left wall): circle on the wall plane
    const clock = (P, ca, cv, rx, rv) => {
      for (const [r2x, r2v, col] of [[rx + 1, rv + 1, '#2b3149'], [rx, rv, '#f5f5f0']]) {
        for (let da = -r2x; da <= r2x; da++) {
          const hh = Math.round(r2v * Math.sqrt(Math.max(0, 1 - (da * da) / (r2x * r2x))));
          pr(c, P[0], P[1], P[2], ca + da, ca + da + 1, cv - hh, cv + hh + 1, col);
        }
      }
      pr(c, P[0], P[1], P[2], ca, ca + 1, cv, cv + 6, '#222'); pr(c, P[0], P[1], P[2], ca, ca + 5, cv, cv + 1, '#222'); pr(c, P[0], P[1], P[2], ca, ca + 1, cv, cv + 1, '#e5484d');
      for (const [da, dv] of [[0, 7], [0, -7], [6, 0], [-6, 0]]) pr(c, P[0], P[1], P[2], ca + da, ca + da + 1, cv + dv, cv + dv + 1, '#8a93b0');
    };
    clock(LW, 108, 36, 7, 8);
    // shelf + cups + sign above the coffee counter (right wall)
    pr(c, ...RW, 134, 188, 34, 37, '#5e3d27'); pr(c, ...RW, 134, 188, 36, 37, '#7d5a3d');
    pr(c, ...RW, 138, 143, 37, 42, '#f5f5f0'); pr(c, ...RW, 143, 144, 38, 41, '#f5f5f0'); pr(c, ...RW, 148, 153, 37, 42, '#e93d82'); pr(c, ...RW, 153, 154, 38, 41, '#e93d82');
    pr(c, ...RW, 172, 178, 37, 44, '#12a594'); pr(c, ...RW, 180, 185, 37, 42, '#f5a524');
    pr(c, ...RW, 146, 178, 44, 53, '#2b3149'); pr(c, ...RW, 147, 177, 45, 52, '#f5c542');
    'CAFE'.split('').forEach((ch, n) => GLYPH[ch].forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] === '#') pr(c, ...RW, 156 + n * 4 + i, 157 + n * 4 + i, 46 + (4 - j), 47 + (4 - j), '#7a5236'); }));

    // coffee counter (static: nobody can stand behind it)
    box(c, COUNTER.x0, COUNTER.y0, COUNTER.x1, COUNTER.y1, 0, 14, { top: '#ead2a8', se: '#5e3d27', sw: '#7a5236', hi: '#fff0d2', dk: '#4a2f1d' });
    const cp = [sx(COUNTER.x0, COUNTER.y1), sy(COUNTER.x0, COUNTER.y1, 0)];
    pr(c, cp[0], cp[1], 1, 0, 64, 0, 2, '#4a2f1d');
    for (let k = 0; k < 4; k++) { pr(c, cp[0], cp[1], 1, k * 16 + 2, k * 16 + 14, 3, 11, '#6a452e'); pr(c, cp[0], cp[1], 1, k * 16 + 3, k * 16 + 13, 4, 10, '#8a6040'); pr(c, cp[0], cp[1], 1, k * 16 + 7, k * 16 + 10, 8, 9, '#e5c07a'); }
    // coffee machine
    box(c, 9.0, 0.12, 9.8, 0.86, 14, 31, { top: '#555c70', se: '#2a2e3b', sw: '#3a3f4f', hi: '#6a7188' });
    const mp = [sx(9.0, 0.86), sy(9.0, 0.86, 0)];
    pr(c, mp[0], mp[1], 1, 1, 11, 25, 29, '#242833'); pr(c, mp[0], mp[1], 1, 2, 4, 26, 28, '#ff5a5a'); pr(c, mp[0], mp[1], 1, 6, 8, 26, 28, '#5ff2a5');
    pr(c, mp[0], mp[1], 1, 2, 10, 18, 22, '#1b1e27'); pr(c, mp[0], mp[1], 1, 5, 7, 14, 18, '#999');
    pr(c, mp[0], mp[1], 1, 4, 8, 14, 19, '#f5f5f0'); pr(c, mp[0], mp[1], 1, 4, 8, 17, 19, '#5b3a1e');
    // kettle + mugs on the counter
    box(c, 10.2, 0.2, 10.6, 0.6, 14, 24, { top: '#e6e9f2', se: '#9aa0b4', sw: '#c8ccd8', hi: '#fff' });
    box(c, 10.9, 0.3, 11.15, 0.55, 14, 18, { top: '#ff8b8f', se: '#a8262c', sw: '#e5484d' });
    box(c, 11.3, 0.45, 11.55, 0.7, 14, 18, { top: '#8fb8ff', se: '#2a5fb8', sw: '#3e8ef7' });
    return bg;
  }

  // ---------- furniture ----------
  function drawMonitor(c, s, state, t, ph, led) {
    const { dx, dy } = s, ym = dy + 1.625, x0 = dx + 0.125, x1 = dx + 0.875;
    const px0 = sx(x0, ym), py0 = sy(x0, ym, 0);
    pr(c, px0, py0, 1, 4, 8, 13, 16, '#3a3f4f'); pr(c, px0, py0, 1, 2, 10, 13, 14, '#2b2f3b');       // stand + foot
    pr(c, sx(x1, ym - 0.125), sy(x1, ym - 0.125, 0), -1, 0, 2, 16, 27, '#1b1e27');                    // right side of the case
    pr(c, px0, py0, 1, 0, 12, 16, 27, '#2b2f3b'); pr(c, px0, py0, 1, 0, 12, 26, 27, '#4a4f61');      // bezel
    const Rr = (a0, a1, v0, v1, col) => pr(c, px0, py0, 1, a0, a1, v0, v1, col);
    if (state === 'working') {
      Rr(1, 11, 17, 26, '#0e1f1a');
      const tick = Math.floor(t * 6 + ph * 5);
      for (let i = 0; i < 4; i++) { const w = 3 + Math.floor(rnd(tick + i * 7) * 7); Rr(2 + (i % 2), 2 + (i % 2) + Math.min(w, 8), 24 - i * 2, 25 - i * 2, i % 2 ? '#7fd6ff' : '#5ff2a5'); }
      if (Math.floor(t * 18 + ph) % 6 === 0) Rr(1, 11, 17, 26, '#244d3f');
    } else if (state === 'thinking') {
      Rr(1, 11, 17, 26, '#1d2a44');
      const k = Math.floor(t * 3) % 4;
      for (let i = 0; i < 3; i++) Rr(2 + i * 3, 4 + i * 3, 20, 22, i < k ? '#b7a8ff' : '#33446a');
    } else if (state === 'done') {
      Rr(1, 11, 17, 26, '#143d2a');
      [[3, 20], [4, 19], [5, 18], [6, 19], [7, 20], [8, 21], [9, 22]].forEach(([a, v]) => Rr(a, a + 1, v, v + 2, '#6be39b'));
    } else if (state === 'error') {
      Rr(1, 11, 17, 26, Math.floor(t * 4) % 2 ? '#4a1218' : '#6a1a22'); Rr(5, 7, 21, 25, '#fff'); Rr(5, 7, 18, 20, '#fff');
    } else if (state === 'off') {
      Rr(1, 11, 17, 26, '#10131c'); Rr(2, 6, 24, 25, '#2a3040'); Rr(2, 4, 23, 24, '#2a3040');
    } else {
      Rr(1, 11, 17, 26, '#1d2a44');
      [[0, 6], [1, 4], [2, 7]].forEach(([i, w]) => Rr(2, 2 + w, 24 - i * 3, 25 - i * 3, '#3a5a8a'));
      if (Math.floor(t * 1.6 + ph) % 2) Rr(2, 4, 17.5 | 0, 19, '#9fe8ff');
    }
    Rr(10, 11, 16, 17, led || '#5ff2a5');
  }

  function drawDesk(c, s, ag, t) {
    const { dx, dy } = s, x0 = dx, x1 = dx + 1, y0 = dy, y1 = dy + 2;
    box(c, x0, y0, x1, y1, 0, DESKZ, { top: '#cfa56a', se: '#8f6538', sw: '#a77a46', hi: '#ecca94', dk: '#6e4b28' });
    const p = [sx(x0, y1), sy(x0, y1, 0)];                       // SW face: drawers
    pr(c, p[0], p[1], 1, 0, 16, 0, 2, '#5e3f22'); pr(c, p[0], p[1], 1, 0, 16, 10, 12, '#bc8e58');
    for (const [v0, v1] of [[2, 6], [6, 10]]) { pr(c, p[0], p[1], 1, 2, 14, v0, v1, '#6e4724'); pr(c, p[0], p[1], 1, 3, 13, v0 + 1, v1, '#8d5f33'); pr(c, p[0], p[1], 1, 7, 9, v0 + 2, v0 + 3, '#e5c07a'); }
    const q = [sx(x1, y0), sy(x1, y0, 0)];                       // SE face: side panel + name plate
    pr(c, q[0], q[1], -1, 0, 32, 0, 2, '#5e3f22'); pr(c, q[0], q[1], -1, 0, 32, 10, 12, '#a9794a');
    pr(c, q[0], q[1], -1, 15, 17, 2, 10, '#7a502a');
    if (ag) { pr(c, q[0], q[1], -1, 21, 29, 5, 8, ag.look.shirt); pr(c, q[0], q[1], -1, 21, 29, 7, 8, shade(ag.look.shirt, 35)); }
    // glow on the desk while working
    if (ag && !ag.away && ag.state === 'working') poly(c, [A(dx + 0.05, dy + 0.4, DESKZ), A(dx + 0.7, dy + 0.4, DESKZ), A(dx + 0.7, dy + 1.5, DESKZ), A(dx + 0.05, dy + 1.5, DESKZ)], 'rgba(127,214,255,.14)');
    // keyboard
    poly(c, [A(dx + 0.12, dy + 0.62, DESKZ), A(dx + 0.46, dy + 0.62, DESKZ), A(dx + 0.46, dy + 1.3, DESKZ), A(dx + 0.12, dy + 1.3, DESKZ)], '#d6dae6');
    const k1 = A(dx + 0.46, dy + 0.62, DESKZ), k2 = A(dx + 0.46, dy + 1.3, DESKZ), k3 = A(dx + 0.12, dy + 1.3, DESKZ);
    line(c, k1[0], k1[1], k2[0], k2[1], '#9aa0b4', 1); line(c, k2[0], k2[1], k3[0], k3[1], '#9aa0b4', 1);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) { const kp = A(dx + 0.2 + i * 0.1, dy + 0.74 + j * 0.13, DESKZ); R(c, kp[0], kp[1], 1, 1, '#8a90a6'); }
    // mug, papers, lamp
    box(c, dx + 0.62, dy + 0.18, dx + 0.82, dy + 0.38, DESKZ, DESKZ + 4, { top: '#5b3a1e', se: '#c9c9c0', sw: '#f5f5f0' });
    const mh = A(dx + 0.84, dy + 0.28, DESKZ + 2); R(c, mh[0], mh[1], 1, 2, '#f5f5f0');
    poly(c, [A(dx + 0.56, dy + 0.62, DESKZ), A(dx + 0.86, dy + 0.62, DESKZ), A(dx + 0.86, dy + 1.0, DESKZ), A(dx + 0.56, dy + 1.0, DESKZ)], '#f4f1e6');
    const pa = A(dx + 0.7, dy + 0.8, DESKZ); R(c, pa[0] - 2, pa[1], 4, 1, '#c9c2a8');
    if (s.i % 2 === 0) { // desk lamp
      box(c, dx + 0.7, dy + 0.05, dx + 0.82, dy + 0.15, DESKZ, DESKZ + 1, { top: '#2b2f3b', se: '#1b1e27', sw: '#2b2f3b' });
      const lp = A(dx + 0.76, dy + 0.1, DESKZ + 1); R(c, lp[0], lp[1] - 7, 1, 7, '#2b2f3b'); R(c, lp[0] - 3, lp[1] - 9, 5, 2, '#f5c542'); R(c, lp[0] - 2, lp[1] - 7, 3, 1, '#fff3b0');
    }
    drawMonitor(c, s, ag ? (ag.away ? 'idle' : ag.state) : 'off', t, ag ? ag.phase : 0, ag && ag.look.shirt);
  }

  function drawChair(c, s) {
    const { dx, dy } = s, cs = { top: '#4d5575', se: '#2f3550', sw: '#3b4260', hi: '#6a739a' };
    box(c, dx - 0.55, dy + 0.95, dx - 0.45, dy + 1.05, 0, 6, { top: '#555a6a', se: '#2b2f3b', sw: '#3a3f4f' });
    poly(c, [A(dx - 0.9, dy + 0.98, 1), A(dx - 0.1, dy + 0.98, 1), A(dx - 0.1, dy + 1.02, 1), A(dx - 0.9, dy + 1.02, 1)], '#2b2f3b');
    poly(c, [A(dx - 0.52, dy + 0.55, 1), A(dx - 0.48, dy + 0.55, 1), A(dx - 0.48, dy + 1.45, 1), A(dx - 0.52, dy + 1.45, 1)], '#2b2f3b');
    box(c, dx - 0.95, dy + 0.55, dx - 0.8, dy + 1.45, 8, 23, cs);
    box(c, dx - 0.9, dy + 0.6, dx - 0.1, dy + 1.4, 6, 9, cs);
  }

  // ---------- characters ----------
  const spr = mk(80, 80), sc = spr.getContext('2d'), flp = mk(80, 80), fc = flp.getContext('2d'), sil = mk(80, 80), silc = sil.getContext('2d');
  const ORX = 40, ORY = 64;
  const armCol = (look) => shade(look.shirt, -22);

  /** two-bone arm from shoulder to hand (elbow solved so it bends downwards / outwards) */
  function limb(c, s0x, s0y, hx, hy, look, side, far) {
    const L = 7.5; let dx = hx - s0x, dy = hy - s0y, d = Math.hypot(dx, dy) || 0.01;
    if (d > 2 * L - 0.6) { const k = (2 * L - 0.6) / d; hx = s0x + dx * k; hy = s0y + dy * k; dx = hx - s0x; dy = hy - s0y; d = Math.hypot(dx, dy); }
    const mx = (s0x + hx) / 2, my = (s0y + hy) / 2, h = Math.sqrt(Math.max(0, L * L - (d / 2) * (d / 2)));
    let best = null;
    for (const sg of [1, -1]) {
      const nx = (-dy / d) * sg, ny = (dx / d) * sg, score = ny + 0.7 * side * nx;
      if (!best || score > best.score) best = { nx, ny, score };
    }
    const ex = mx + best.nx * h, ey = my + best.ny * h, col = far ? shade(look.shirt, -36) : armCol(look);
    line(c, s0x, s0y, ex, ey, col, 2); line(c, ex, ey, hx, hy, col, 2);
    R(c, Math.round(hx) - 1, Math.round(hy) - 1, 2, 2, look.skin);
  }

  function head(c, look, hy, front, o) {
    o = o || {};
    const skin = look.skin, dark = shade(skin, -38), hair = look.hair, hairD = shade(hair, -28), hairL = shade(hair, 34), st = look.hairStyle;
    const mood = o.mood || 'normal', lk = o.lk || 0;
    if (front) {
      if (st === 'long') R(c, -6, hy + 1, 7, 12, hairD);
      R(c, -4, hy, 9, 9, skin); R(c, 5, hy + 5, 1, 1, skin); R(c, -3, hy + 8, 7, 1, shade(skin, -14));
      const E = '#222';
      if (mood === 'yawn') { R(c, 0, hy + 5, 2, 1, E); R(c, 3, hy + 5, 2, 1, E); R(c, 1, hy + 6, 3, 3, '#5a1a1a'); R(c, 2, hy + 8, 1, 1, '#c0544a'); }
      else if (mood === 'read') { R(c, 0, hy + 5, 1, 1, E); R(c, 3, hy + 5, 1, 1, E); R(c, 0, hy + 4, 1, 1, dark); R(c, 3, hy + 4, 1, 1, dark); R(c, 1, hy + 7, 2, 1, '#8a4a3a'); }
      else if (mood === 'happy') { R(c, 0, hy + 4, 2, 1, E); R(c, 0, hy + 5, 1, 1, E); R(c, 3, hy + 4, 2, 1, E); R(c, 4, hy + 5, 1, 1, E); R(c, 1, hy + 7, 3, 1, '#7a2a2a'); R(c, 0, hy + 6, 1, 1, '#7a2a2a'); R(c, 4, hy + 6, 1, 1, '#7a2a2a'); }
      else if (mood === 'worried') { R(c, 0, hy + 4, 1, 3, E); R(c, 3, hy + 4, 1, 3, E); R(c, 0, hy + 2, 2, 1, E); R(c, 3, hy + 2, 2, 1, E); R(c, 2, hy + 7, 2, 2, '#5a1a1a'); }
      else if (o.blink) { R(c, 0 + lk, hy + 5, 1, 1, E); R(c, 3 + lk, hy + 5, 1, 1, E); R(c, 1 + lk, hy + 7, 2, 1, '#8a4a3a'); }
      else { R(c, 0 + lk, hy + 4, 1, 2, E); R(c, 3 + lk, hy + 4, 1, 2, E); R(c, 1 + lk, hy + 7, 2, 1, '#8a4a3a'); }
      R(c, -1, hy + 6, 1, 1, '#e8907f');
      switch (st) {
        case 'long': R(c, -5, hy - 1, 11, 3, hair); R(c, -6, hy + 2, 3, 11, hair); R(c, 5, hy + 2, 1, 8, hair); R(c, -3, hy - 1, 4, 1, hairL); R(c, 1, hy + 2, 4, 1, hair); break;
        case 'spiky': R(c, -5, hy - 1, 11, 3, hair); R(c, -5, hy + 2, 3, 4, hair); R(c, -5, hy - 3, 2, 2, hair); R(c, -2, hy - 4, 2, 3, hair); R(c, 1, hy - 3, 2, 2, hair); R(c, 4, hy - 2, 2, 1, hair); R(c, -3, hy - 1, 3, 1, hairL); break;
        case 'bun': R(c, -5, hy - 1, 11, 3, hair); R(c, -5, hy + 2, 3, 5, hair); R(c, -5, hy - 4, 4, 3, hair); R(c, -4, hy - 4, 2, 1, hairL); R(c, 2, hy + 2, 3, 1, hair); break;
        case 'cap': R(c, -5, hy - 2, 11, 4, look.shirt); R(c, -4, hy - 2, 4, 1, shade(look.shirt, 40)); R(c, 3, hy + 1, 6, 2, shade(look.shirt, -35)); R(c, -5, hy + 2, 3, 5, hair); break;
        default: R(c, -5, hy - 1, 11, 3, hair); R(c, -5, hy + 2, 3, 6, hair); R(c, 4, hy + 2, 1, 2, hair); R(c, -3, hy - 1, 4, 1, hairL); R(c, 0, hy + 2, 4, 1, hair);
      }
    } else { // back of the head
      const bot = st === 'long' ? 13 : 9;
      R(c, -5, hy - 1, 11, bot + 1, hair); R(c, -3, hy, 3, 1, hairL); R(c, -5, hy + bot - 1, 11, 1, hairD);
      if (st === 'spiky') { R(c, -5, hy - 3, 2, 2, hair); R(c, -2, hy - 4, 2, 3, hair); R(c, 1, hy - 3, 2, 2, hair); R(c, 4, hy - 2, 2, 1, hair); }
      if (st === 'bun') { R(c, -2, hy - 4, 4, 3, hair); R(c, -1, hy - 4, 2, 1, hairL); }
      if (st === 'cap') { R(c, -5, hy - 2, 11, 5, look.shirt); R(c, -4, hy - 2, 4, 1, shade(look.shirt, 40)); R(c, -5, hy + 3, 11, 1, shade(look.shirt, -35)); }
      R(c, 5, hy + 4, 1, 2, skin);
    }
  }

  const shoes = '#222';
  function torso(c, look, top, h, front, pants) {
    R(c, -4, top, 8, h, look.shirt); R(c, 2, top, 2, h, shade(look.shirt, -16)); R(c, -4, top + h - 1, 8, 1, shade(look.shirt, -30));
    R(c, -4, top, 8, 1, shade(look.shirt, 22));
    if (front) R(c, -1, top - 1, 3, 2, look.skin); else R(c, -1, top - 1, 3, 1, shade(look.skin, -25));
  }

  function drawSeated(c, ag, t, face) {
    const look = ag.look, st = ag.state, ph = ag.phase, act = ag.act, ap = ag.actP || 0, front = face < 2;
    let mood = st === 'error' ? 'worried' : st === 'done' ? 'happy' : 'normal', k = 0;
    if (act === 'stretch') { k = Math.min(ap / 0.5, 1) * (ap < 2.4 ? 1 : Math.max(0, (2.9 - ap) / 0.5)); if (k > 0.5) mood = 'yawn'; }
    if (act === 'read') mood = 'read';
    let by = 0;
    if (st === 'idle') by = Math.sin(t * 2.2 + ph * 6) >= 0 ? 1 : 0;
    else if (st === 'done') by = -Math.floor(Math.abs(Math.sin(t * 6)) * 2);
    else if (st === 'working') by = Math.floor(t * 6 + ph) % 4 === 0 ? 1 : 0;
    else if (st === 'thinking') by = Math.sin(t * 1.5 + ph * 6) >= 0.4 ? 1 : 0;
    if (act === 'stretch') by = -Math.round(k);
    if (act === 'read') by = 1;
    const blink = ((t * 1000 + ph * 3600) % 3600) < 140;
    // legs: thigh forward, shin down
    if (face === 0 || face === 1) { R(c, -3, -3, 10, 4, look.pants); R(c, 4, 0, 4, 9, look.pants); R(c, 4, 9, 6, 2, shoes); R(c, -3, -3, 10, 1, shade(look.pants, 18)); }
    else { R(c, -3, -4, 9, 3, look.pants); }
    torso(c, look, -11 + by, 11 - by, front, look.pants);
    head(c, look, -22 + by, front, { blink, mood, lk: 0 });
    const S1 = [-4, -9 + by], S2 = [4, -9 + by];
    let N = [6, 1], Fh = [11, -1.5];                                  // hands on the keyboard
    if (face !== 0) { N = [-3, -1]; Fh = [5, -1]; }
    else if (st === 'working') {
      const f = Math.floor(t * 10 + ph * 3);
      N = [6 - (f % 3 === 0 ? 1 : 0), 1 + (f % 2)]; Fh = [11 + (f % 3 === 1 ? 1 : 0), -1.5 + ((f + 1) % 2)];
    } else if (st === 'thinking') Fh = [3, -12 + by];
    else if (st === 'done') { const b = Math.floor(Math.abs(Math.sin(t * 6)) * 3); N = [-9, -27 - b]; Fh = [9, -27 - b]; }
    else if (st === 'error') { const j = Math.floor(t * 8) % 2; N = [-6 - j, -21]; Fh = [6 + j, -21]; }
    if (act === 'stretch') { N = [N[0] + (-10 - N[0]) * k, N[1] + (-31 - N[1]) * k]; Fh = [Fh[0] + (10 - Fh[0]) * k, Fh[1] + (-31 - Fh[1]) * k]; }
    else if (act === 'read') { N = [-3, -6]; Fh = [5, -7]; }
    limb(c, S2[0], S2[1], Fh[0], Fh[1], look, 1, true);
    limb(c, S1[0], S1[1], N[0], N[1], look, -1, false);
    if (act === 'read') { // open book held in front of the chest
      const cov = ['#8e4ec6', '#3e8ef7', '#e5484d', '#30a46c'][ag.slot % 4], by2 = by;
      R(c, -7, -12 + by2, 14, 9, cov); R(c, -6, -11 + by2, 6, 6, '#fffbe8'); R(c, 0, -11 + by2, 6, 6, '#fffbe8'); R(c, -1, -11 + by2, 2, 6, '#d9cfa8');
      const pg = Math.floor(ap / 2.2) % 3;
      for (let i = 0; i < 3; i++) { R(c, -5, -10 + by2 + i * 2, 3 + ((i + pg) % 2), 1, '#9a8f6a'); R(c, 1, -10 + by2 + i * 2, 4 - ((i + pg) % 2), 1, '#9a8f6a'); }
      R(c, -7, -3 + by2, 14, 1, shade(cov, -40));
      R(c, -5, -6 + by2, 2, 2, look.skin); R(c, 4, -6 + by2, 2, 2, look.skin);
    }
  }

  function drawStanding(c, ag, t, face, ret) {
    const look = ag.look, walking = ag.mode === 'walk', front = face < 2;
    const fr = walking ? Math.floor(t * 7 + ag.phase * 3) % 4 : 0, bob = walking && (fr & 1) ? 1 : 0;
    const la = fr === 1 ? 2 : 0, lb = fr === 3 ? 2 : 0;
    const mood = ag.state === 'error' ? 'worried' : (ag.mode === 'drink' || ag.mode === 'chat') ? 'happy' : 'normal';
    const blink = ((t * 1000 + ag.phase * 3600) % 3600) < 140;
    R(c, -3, -10, 3, 8 - la, look.pants); R(c, 1, -10, 3, 8 - lb, look.pants);
    R(c, -4, -2 - la, 4, 2, shoes); R(c, 0, -2 - lb, 4, 2, shoes);
    torso(c, look, -20 - bob, 10 + bob, front, look.pants);
    const nod = ag.mode === 'chat' && ag.talk == null && Math.floor(t * 3) % 4 === 0 ? 1 : 0;
    head(c, look, -30 - bob + nod, front, { blink, mood });
    const sw = walking ? (fr === 1 ? 1 : fr === 3 ? -1 : 0) : 0;
    let N = [-5, -9 + sw * 2], Fh = [5, -9 - sw * 2];
    if (ag.mode === 'drink') { const sip = Math.floor(t * 1.5) % 2; Fh = [4, -17 - (sip ? 3 : 0)]; N = [-5, -9]; ret.mug = [Fh[0], Fh[1] - 6]; }
    else if (ag.mode === 'chat') { if (ag.talk != null) { const g = Math.floor(t * 4) % 2; Fh = [ag.talkDir > 0 ? 8 : 6, -19 - g * 3]; } N = [-5, -9]; }
    limb(c, 4, -18 - bob, Fh[0], Fh[1], look, 1, true);
    limb(c, -4, -18 - bob, N[0], N[1], look, -1, false);
    if (ag.mode === 'drink') { const hx = Fh[0], hy = Fh[1]; R(c, hx - 2, hy - 5, 5, 5, '#f5f5f0'); R(c, hx + 3, hy - 4, 1, 3, '#f5f5f0'); R(c, hx - 2, hy - 5, 5, 1, '#5b3a1e'); }
  }

  /** composite the sprite buffer with a 1px dark outline (and optional horizontal mirror) */
  function blit(c, ax, ay, flip) {
    let src = spr;
    if (flip) { fc.clearRect(0, 0, 80, 80); fc.save(); fc.translate(80, 0); fc.scale(-1, 1); fc.drawImage(spr, 0, 0); fc.restore(); src = flp; }
    silc.globalCompositeOperation = 'source-over'; silc.clearRect(0, 0, 80, 80); silc.drawImage(src, 0, 0);
    silc.globalCompositeOperation = 'source-in'; silc.fillStyle = '#161827'; silc.fillRect(0, 0, 80, 80);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) c.drawImage(sil, ax - ORX + dx, ay - ORY + dy);
    c.drawImage(src, ax - ORX, ay - ORY);
  }
  const FLIP = [false, true, true, false];     // facings 1 (SW) and 2 (NW) are mirrored sprites
  const LOOK_SEQ = [0, 1, 1, 0, 3, 3];         // swivel sequence while "looking around" at the desk
  const seatFace = (e) => (e.act === 'look' ? LOOK_SEQ[Math.floor((e.actP || 0) / 0.9) % 6] : 0);
  const faceOf = (e) => (e.away ? (e.face || 0) : seatFace(e));

  function renderPerson(c, e, t, seated) {
    const face = faceOf(e), ret = {};
    let ax, ay;
    if (seated) { const s = SLOTS[e.slot]; ax = sx(s.seat.x, s.seat.y); ay = sy(s.seat.x, s.seat.y, SEAT); }
    else {
      ax = sx(e.x, e.y); ay = sy(e.x, e.y, 0);
      for (let dy = -3; dy <= 3; dy++) { const w = Math.round(9 * Math.sqrt(1 - (dy * dy) / 12.25)); R(c, ax - w, ay + dy, w * 2, 1, 'rgba(40,30,15,.28)'); }
    }
    sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, 80, 80); sc.setTransform(1, 0, 0, 1, ORX, ORY);
    if (seated) drawSeated(sc, e, t, face); else drawStanding(sc, e, t, face, ret);
    sc.setTransform(1, 0, 0, 1, 0, 0);
    blit(c, ax, ay, FLIP[face]);
    if (ret.mug) { const mx = ax + (FLIP[face] ? -ret.mug[0] : ret.mug[0]), s2 = Math.floor(t * 4) % 2; c.globalAlpha = 0.8; R(c, mx - 1 + s2, ay + ret.mug[1] - 3, 1, 2, '#fff'); R(c, mx + 1 - s2, ay + ret.mug[1] - 6, 1, 2, '#fff'); c.globalAlpha = 1; }
  }

  // ---------- scene: objects, depth sorting ----------
  function buildObjects(entries, t) {
    const bySlot = {}; entries.forEach((e) => { bySlot[e.slot] = e; });
    const objs = [];
    for (const s of SLOTS) {
      const ag = bySlot[s.i] || null, res = ag ? { id: ag.id } : { slot: s.i };
      const cx0 = s.dx - 0.95, cy0 = s.dy + 0.55, cx1 = s.dx - 0.05, cy1 = s.dy + 1.45;
      objs.push({ x0: cx0, y0: cy0, x1: cx1, y1: cy1, h: 24, pad: 0, ord: 0, draw: (c) => drawChair(c, s), hit: (lx, ly) => inPoly(boxHex(cx0, cy0, cx1, cy1, 0, 23), lx, ly), res });
      const mon = [sx(s.dx + 0.125, s.dy + 1.625), sy(s.dx + 0.125, s.dy + 1.625, 28), 12];
      objs.push({ x0: s.dx, y0: s.dy, x1: s.dx + 1, y1: s.dy + 2, h: 29, pad: 0, ord: 2, draw: (c) => drawDesk(c, s, ag, t),
        hit: (lx, ly) => inPoly(boxHex(s.dx, s.dy, s.dx + 1, s.dy + 2, 0, DESKZ), lx, ly) || (lx >= mon[0] && lx < mon[0] + mon[2] && ly >= mon[1] && ly < mon[1] + 15), res });
    }
    for (const p of PLANTS) objs.push({ x0: p.x + 0.2, y0: p.y + 0.2, x1: p.x + 0.8, y1: p.y + 0.8, h: 34, pad: 8, ord: 0, draw: (c) => plant(c, p.x, p.y), hit: null });
    for (const e of entries) {
      let x, y; const seated = !e.away;
      if (seated) { const s = SLOTS[e.slot]; x = s.seat.x; y = s.seat.y; } else { x = e.x; y = e.y; }
      const ax = sx(x, y), ay = sy(x, y, seated ? SEAT : 0), top = seated ? 26 : 34;
      objs.push({ x0: x - 0.22, y0: y - 0.22, x1: x + 0.22, y1: y + 0.22, h: top, pad: 10, ord: 1, draw: (c) => renderPerson(c, e, t, seated),
        hit: (lx, ly) => lx >= ax - 8 && lx <= ax + 8 && ly >= ay - top + (seated ? 1 : 0) && ly <= ay + 3, res: { id: e.id }, person: true });
    }
    return objs;
  }
  /** Footprint-aware painter's algorithm: A is drawn before B if A lies entirely behind B along x or y. */
  function sortObjs(objs) {
    const n = objs.length, e = 1e-4;
    for (const o of objs) { o.bx0 = sx(o.x0, o.y1) - o.pad; o.bx1 = sx(o.x1, o.y0) + o.pad; o.by0 = sy(o.x0, o.y0, o.h); o.by1 = sy(o.x1, o.y1, 0) + 3; o.cs = (o.x0 + o.x1 + o.y0 + o.y1) / 2; }
    const behind = objs.map(() => []);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = objs[i], b = objs[j];
      if (a.bx1 <= b.bx0 || b.bx1 <= a.bx0 || a.by1 <= b.by0 || b.by1 <= a.by0) continue;   // screen boxes don't overlap
      const aB = a.x1 <= b.x0 + e || a.y1 <= b.y0 + e, bA = b.x1 <= a.x0 + e || b.y1 <= a.y0 + e;
      let aFirst;
      if (aB && !bA) aFirst = true; else if (bA && !aB) aFirst = false;
      else aFirst = Math.abs(a.cs - b.cs) > 1e-3 ? a.cs < b.cs : a.ord <= b.ord;
      if (aFirst) behind[j].push(i); else behind[i].push(j);
    }
    const order = objs.map((_, i) => i).sort((p, q) => objs[p].cs - objs[q].cs);
    const seen = new Array(n).fill(false), out = [];
    const visit = (i) => { if (seen[i]) return; seen[i] = true; for (const j of behind[i]) visit(j); out.push(objs[i]); };
    order.forEach(visit);
    return out;
  }

  // ---------- selection / hover outlines (iso diamond for desks, ellipse for walkers) ----------
  function dline(c, x0, y0, x1, y1, col, off, thick) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), stx = x0 < x1 ? 1 : -1, sty = y0 < y1 ? 1 : -1;
    let err = dx + dy, i = 0; c.fillStyle = col;
    for (;;) {
      if ((((i++ + off) >> 1) & 1) === 0) c.fillRect(x0, y0, 1, thick || 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += stx; }
      if (e2 <= dx) { err += dx; y0 += sty; }
    }
  }
  function podRing(c, s, col, t, thick) {
    const x0 = Math.max(s.dx - 1.15, 0.15), y0 = Math.max(s.dy - 0.2, 0.15), x1 = Math.min(s.dx + 1.3, GX - 0.15), y1 = Math.min(s.dy + 2.2, GY - 0.15);
    const P = [A(x0, y0), A(x1, y0), A(x1, y1), A(x0, y1)];
    const off = t ? Math.floor(t * 8) : 0;
    for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; dline(c, a[0], a[1], b[0], b[1], col, off + i * 3, thick); }
  }
  function ellipseRing(c, ax, ay, rx, ry, col, t, thick) {
    const off = t ? Math.floor(t * 8) : 0; c.fillStyle = col; const N = 96; const seen = new Set();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, x = ax + Math.round(rx * Math.cos(a)), y = ay + Math.round(ry * Math.sin(a));
      if (((i + off) >> 1) % 2 !== 0 || seen.has(x * 1000 + y)) continue; seen.add(x * 1000 + y);
      c.fillRect(x, y, 1, thick || 1);
    }
  }

  // ---------- main ----------
  const bg = buildBackground();
  const logical = mk(W, H), lc = logical.getContext('2d');
  const labelPt = (e) => { const s = SLOTS[e.slot !== undefined ? e.slot : e.i]; return [sx(s.dx - 0.45, s.dy + 1.75), sy(s.dx - 0.45, s.dy + 1.75, 0) + 6]; };
  const personAnchor = (e) => { if (!e.away) { const s = SLOTS[e.slot]; return { ax: sx(s.seat.x, s.seat.y), ay: sy(s.seat.x, s.seat.y, SEAT), head: sy(s.seat.x, s.seat.y, SEAT) - 24 }; } return { ax: sx(e.x, e.y), ay: sy(e.x, e.y, 0), head: sy(e.x, e.y, 0) - 32 }; };

  /** scene: {t, entries:[{id,name,type,slot,look,state,tool,phase,away,x,y,face,mode,bubble,act,actP,talk,talkDir,queued}], selectedId, hoverId, hoverSlot} */
  function render(canvas, S, U, scene) {
    const t = scene.t, entries = scene.entries;
    lc.clearRect(0, 0, W, H);
    lc.drawImage(bg, 0, 0);
    const bySlot = {}; entries.forEach((e) => { bySlot[e.slot] = e; });
    // floor-level outlines first so furniture and people cover them where they should
    for (const e of entries) {
      const s = SLOTS[e.slot];
      if (e.id === scene.selectedId) { podRing(lc, s, '#f5c542', t, 1); if (e.away) { const p = personAnchor(e); ellipseRing(lc, p.ax, p.ay, 13, 6, '#f5c542', t, 1); } }
      else if (e.id === scene.hoverId) { podRing(lc, s, 'rgba(255,255,255,.8)', 0, 1); if (e.away) { const p = personAnchor(e); ellipseRing(lc, p.ax, p.ay, 13, 6, 'rgba(255,255,255,.8)', 0, 1); } }
    }
    if (scene.hoverSlot != null && !bySlot[scene.hoverSlot]) podRing(lc, SLOTS[scene.hoverSlot], 'rgba(95,242,165,.9)', 0, 1);
    // steam over the coffee machine
    for (let i = 0; i < 3; i++) {
      const p = (t * 8 + i * 4) % 12, bx = sx(9.4, 0.5), by = sy(9.4, 0.5, 32);
      lc.globalAlpha = 0.6 * (1 - p / 12); R(lc, bx + Math.sin(t * 2 + i * 2) * 1.5 - 1 + i * 2, by - p, 2, 2, '#fff');
    }
    lc.globalAlpha = 1;
    for (const o of sortObjs(buildObjects(entries, t))) o.draw(lc);
    // state icons + chat bubbles sit above everything
    for (const e of entries) {
      const p = personAnchor(e);
      if (!e.away) stateIcon(lc, p.ax, p.head, e.state, t);
      else { stateIcon(lc, p.ax, p.head + 2, e.state, t); if (e.mode === 'chat' && e.talk != null) drawTalk(lc, p.ax + e.talkDir * 6, p.head - 2, e.talk, e.talkDir); }
    }

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(logical, 0, 0, W * S, H * S);

    // text overlays
    for (const e of entries) {
      const s = SLOTS[e.slot], p = personAnchor(e), lp = labelPt(e);
      const sel = e.id === scene.selectedId, labY = lp[1] * S, labX = lp[0];
      const dotCol = STATE_COL[e.state] || '#999', tb = TYPE_BADGE[e.type];
      const nameTxt = '   ' + e.name;
      const nw = measurePill(ctx, nameTxt, U, sel), bw = tb ? measurePill(ctx, tb.text, U * 0.8, true) : 0, gap = tb ? Math.round(3 * U) : 0;
      const left = labX * S - (nw + gap + bw) / 2;
      pillText(ctx, nameTxt, left + nw / 2, labY, U, sel ? '#14151f' : '#fff', sel ? '#f5c542' : 'rgba(20,21,31,.85)', sel);
      ctx.fillStyle = dotCol; ctx.fillRect(Math.round(left + 5 * U), Math.round(labY - 3 * U), Math.round(5 * U), Math.round(5 * U));
      if (tb) pillText(ctx, tb.text, left + nw + gap + bw / 2, labY, U * 0.8, tb.fg, tb.bg, true);
      // tool chip floats just above the head (over the monitor it would cover the face)
      if (!e.away && e.state === 'working') pillText(ctx, e.tool || 'typing…', p.ax * S, (p.head - 5) * S, U * 0.9, '#0e1f1a', '#5ff2a5', true);
      if (e.queued) pillText(ctx, '+' + e.queued + ' queued', labX * S, (lp[1] + 11) * S, U * 0.85, '#14151f', '#f5c542', true);
      if (e.bubble) drawBubble(ctx, e.bubble, p.ax * S, (p.head - 18) * S, S, U, canvas.width);
    }
    for (const s of SLOTS) if (!bySlot[s.i] && scene.hoverSlot === s.i) { const lp = labelPt(s); pillText(ctx, '＋ hire', lp[0] * S, lp[1] * S, U, '#0e1f1a', '#5ff2a5', true); }
  }

  /** logical-pixel hit test: front-most object first (same order as drawing). -> {id} | {slot} | null */
  function hitTest(lx, ly, entries) {
    const list = sortObjs(buildObjects(entries, 0));
    for (let i = list.length - 1; i >= 0; i--) { const o = list[i]; if (o.hit && o.hit(lx, ly)) return o.res; }
    return null;
  }

  window.OfficeIso = {
    W, H, SLOTS, MAX_SLOTS, render, hitTest, walkPath, SPOTS, SPEED, STEP: 1,
    drawAvatar: F.drawAvatar, GX, GY, isBlocked, project: (x, y, z) => [sx(x, y), sy(x, y, z || 0)],
    deskPoint: (slot) => { const s = SLOTS[slot]; return [sx(s.dx + 0.5, s.dy + 1), sy(s.dx + 0.5, s.dy + 1, DESKZ)]; },
    labelPoint: labelPt,
  };
})();
