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
  const SEAT = 8, DESKZ = 13, MAX_SLOTS = 7, MGR = 6, SPEED = 2.6; // SPEED in tiles/second; slot 6 = the manager desk (main agent)
  const AISLE = 3.55, FRONT1 = 6.55;      // desk-to-desk dotted lanes: the aisle between the rows / the strip in front of row 1
  const sx = (x, y) => OX + Math.round((x - y) * 16);
  const sy = (x, y, z) => OY + Math.round((x + y) * 8) - (z || 0);
  const A = (x, y, z) => [sx(x, y), sy(x, y, z)];
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // ---------- layout ----------
  // 6 regular desks: two rows (x) of three (y). Chair on the -x side, desk 1x2 tiles, the character faces +x (SE) and the monitor stands
  // in front of them on the desk (its back to the camera; the screen faces the person).
  // Slot 6 = the MANAGER desk (main agent): a bigger desk against the back wall, the manager sits with their back to the camera
  // (facing NE) so the two monitors face the camera AND the manager.
  // Per slot: seat (chair position), start (tiles the person steps onto when leaving), pad/gapY (dotted-lane anchors), ring (selection rect), lab (name pill).
  const SLOTS = [];
  for (let i = 0; i < MGR; i++) {
    const row = Math.floor(i / 3), col = i % 3, dx = row ? 5 : 2, dy = 1 + 3 * col;
    SLOTS.push({ i, row, col, dx, dy, seat: { x: dx - 0.5, y: dy + 1 }, start: [[dx - 1, dy], [dx - 1, dy + 1]],
      px: row ? FRONT1 : AISLE, py: dy + 1, gapY: col < 2 ? dy + 2.5 : dy - 0.5,
      ring: { x0: Math.max(dx - 1.15, 0.15), y0: Math.max(dy - 0.2, 0.15), x1: Math.min(dx + 1.3, GX - 0.15), y1: Math.min(dy + 2.2, GY - 0.15) },
      lab: { x: dx - 0.45, y: dy + 1.75 }, desk: { x: dx + 0.5, y: dy + 1 } });
  }
  const MD = { x0: 6.1, x1: 9.0, y0: 0, y1: 1 };            // manager desk footprint (2.9 tiles wide, 1 deep), a free tile (x=9) before the coffee counter
  const MS = { x: 8.5, y: 1.5 };                            // the manager's seat
  SLOTS.push({ i: MGR, row: 1, col: 4, dx: MD.x0, dy: 0, mgr: true, seat: MS, start: [[7, 1], [8, 2]],
    px: FRONT1, py: 2.45, gapY: 3.5, ring: { x0: 5.9, y0: 0.15, x1: 9.1, y1: 2.35 }, lab: { x: 8.9, y: 2.25 }, desk: { x: 7.5, y: 0.5 } });
  const COUNTER = { x0: 10, y0: 0, x1: 12, y1: 1 };
  const PLANTS = [{ x: 0, y: 0 }, { x: 11, y: 5 }, { x: 11, y: 11 }, { x: 0, y: 11 }, { x: 7, y: 11 }];
  // round meeting table in the open area (plan mode: everybody gathers here)
  const TABLE = { x: 9, y: 7.5, r: 1.2, h: 15 };
  const SEATS = [   // stools around the table, front-facing (camera sees the face) first; face = direction the person looks (towards the table)
    [-1.31, -1.31, 0], [0, -1.85, 1], [-1.85, 0, 0], [1.31, -1.31, 1], [-1.31, 1.31, 0], [1.85, 0, 2], [0, 1.85, 3], [1.31, 1.31, 3],
  ].map(([ox, oy, face], i) => ({ i, x: TABLE.x + ox, y: TABLE.y + oy, face }));
  const RUG = { x0: 9.1, y0: 1.1, x1: 11.9, y1: 4 };
  // standing spots (tile centres) near the coffee corner + the direction they face
  const SPOTS = {
    coffee: [{ x: 10.5, y: 1.5, face: 1 }],
    chat: [{ x: 9.5, y: 3.5, face: 0 }, { x: 10.5, y: 3.5, face: 2 }],
    door: { x: 0.5, y: 4.7, face: 0 },
  };

  // blocked[y][x]: furniture the pathfinder must avoid
  const blocked = Array.from({ length: GY }, () => Array(GX).fill(false));
  const block = (x0, y0, x1, y1) => { for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) blocked[y][x] = true; };
  for (const s of SLOTS) { if (s.mgr) continue; block(s.dx, s.dy, s.dx + 1, s.dy + 2); block(s.dx - 1, s.dy, s.dx, s.dy + 2); }
  block(MD.x0, MD.y0, MD.x1, MD.y1); block(8, 1, 9, 2);        // manager desk + chair
  block(8, 6, 10, 9);                                           // round table
  for (const st of SEATS) block(st.x - 0.1, st.y - 0.1, st.x + 0.1, st.y + 0.1);   // stools (a stool tile is only walkable as a destination)
  block(COUNTER.x0, COUNTER.y0, COUNTER.x1, COUNTER.y1);
  for (const p of PLANTS) block(p.x, p.y, p.x + 1, p.y + 1);
  const isBlocked = (tx, ty) => tx < 0 || ty < 0 || tx >= GX || ty >= GY || blocked[ty][tx];

  /** Tile-grid path (4-neighbour BFS, so it never cuts through furniture) from a desk to a spot.
   *  Returns waypoints [{x,y}] in world (tile) coords: seat, ..., spot. Collinear points are merged. */
  function walkPath(slot, spot) {
    const s = SLOTS[slot];
    const key = (x, y) => y * GX + x;
    const prev = new Map(), q = [];
    for (const [x, y] of s.start) { prev.set(key(x, y), -1); q.push([x, y]); }
    const gx = Math.floor(spot.x), gy = Math.floor(spot.y);
    const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let found = false;
    while (q.length) {
      const [x, y] = q.shift();
      if (x === gx && y === gy) { found = true; break; }
      for (const [dx, dy] of D) {
        const nx = x + dx, ny = y + dy;
        if ((isBlocked(nx, ny) && !(nx === gx && ny === gy && nx >= 0 && ny >= 0 && nx < GX && ny < GY)) || prev.has(key(nx, ny))) continue;
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

  /** Path between two arbitrary world points over the tile grid (start tile may be furniture, e.g. a chair). */
  function walkBetween(from, to) {
    const key = (x, y) => y * GX + x;
    const sx0 = Math.max(0, Math.min(GX - 1, Math.floor(from.x))), sy0 = Math.max(0, Math.min(GY - 1, Math.floor(from.y)));
    const gx = Math.floor(to.x), gy = Math.floor(to.y);
    const prev = new Map([[key(sx0, sy0), -1]]), q = [[sx0, sy0]];
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
    const pts = [{ x: from.x, y: from.y }];
    for (const [x, y] of tiles) pts.push({ x: x + 0.5, y: y + 0.5 });
    pts.push({ x: to.x, y: to.y });
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.05) continue;
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
  const GLYPH = { M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'], G: ['###', '#..', '#.#', '#.#', '###'], R: ['###', '#.#', '###', '##.', '#.#'], C: ['###', '#..', '#..', '#..', '###'], A: ['###', '#.#', '###', '#.#', '#.#'], F: ['###', '#..', '##.', '#..', '#..'], E: ['###', '#..', '##.', '#..', '###'] };
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
      if (s.mgr) continue;
      poly(c, [A(s.dx, s.dy + 0.05), A(s.dx + 1.35, s.dy + 0.05), A(s.dx + 1.35, s.dy + 2.15), A(s.dx, s.dy + 2.15)], 'rgba(40,30,15,.17)');
      poly(c, [A(s.dx - 0.95, s.dy + 0.5), A(s.dx - 0.1, s.dy + 0.5), A(s.dx - 0.1, s.dy + 1.6), A(s.dx - 0.95, s.dy + 1.6)], 'rgba(40,30,15,.12)');
    }
    // manager desk + round table: floor shadows and the meeting rug
    poly(c, [A(MD.x0 - 0.1, MD.y0), A(MD.x1 + 0.35, MD.y0), A(MD.x1 + 0.35, MD.y1 + 0.2), A(MD.x0 - 0.1, MD.y1 + 0.2)], 'rgba(40,30,15,.17)');
    poly(c, [A(8.05, 1.1), A(8.95, 1.1), A(8.95, 1.95), A(8.05, 1.95)], 'rgba(40,30,15,.12)');
    const ring = (cx, cy, r, col, z) => poly(c, Array.from({ length: 56 }, (_, k) => A(cx + r * Math.cos((k / 56) * Math.PI * 2), cy + r * Math.sin((k / 56) * Math.PI * 2), z || 0)), col);
    ring(TABLE.x, TABLE.y, 2.55, '#3a4766'); ring(TABLE.x, TABLE.y, 2.43, '#4c5b82'); ring(TABLE.x, TABLE.y, 2.12, '#3f4d71'); ring(TABLE.x, TABLE.y, 2.0, '#566794');
    ring(TABLE.x + 0.18, TABLE.y + 0.18, 1.5, 'rgba(25,20,10,.18)');
    for (const st of SEATS) ring(st.x + 0.08, st.y + 0.08, 0.34, 'rgba(25,20,10,.2)');
    // rug under the coffee corner
    const rp = (i) => (x0, y0, x1, y1, col) => poly(c, [A(x0, y0), A(x1, y0), A(x1, y1), A(x0, y1)], col);
    const rug = rp();
    rug(RUG.x0, RUG.y0, RUG.x1, RUG.y1, '#6e343b');
    rug(RUG.x0 + 0.12, RUG.y0 + 0.12, RUG.x1 - 0.12, RUG.y1 - 0.12, '#a45560');
    rug(RUG.x0 + 0.38, RUG.y0 + 0.38, RUG.x1 - 0.38, RUG.y1 - 0.38, '#8d4650');
    for (let k = 0; k < 5; k++) rug(RUG.x0 + 0.5 + k * 0.4, RUG.y0 + 0.5, RUG.x0 + 0.62 + k * 0.4, RUG.y1 - 0.5, '#a45560');
    rug(0.05, 4.1, 0.95, 5.3, '#4a3a33'); rug(0.12, 4.18, 0.88, 5.22, '#6b5448');
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
    window3(c, ...LW, 20, 30, 20, 26);
    // entrance door (left wall): where auto-hired people walk in
    pr(c, ...LW, 60, 88, 0, 47, '#2b2018'); pr(c, ...LW, 62, 86, 0, 45, '#8b5a34'); pr(c, ...LW, 62, 74, 0, 45, '#7a4e2c');
    pr(c, ...LW, 65, 83, 25, 41, '#a06a3e'); pr(c, ...LW, 65, 83, 5, 21, '#a06a3e'); pr(c, ...LW, 66, 82, 26, 40, '#935f37'); pr(c, ...LW, 66, 82, 6, 20, '#935f37');
    pr(c, ...LW, 80, 83, 21, 24, '#f5c542');
    // poster (right wall) + whiteboard & poster (left wall)
    // brass "MANAGER" sign above the manager desk (right wall)
    pr(c, ...RW, 102, 140, 33, 48, '#2b3149'); pr(c, ...RW, 103, 139, 34, 47, '#caa24a'); pr(c, ...RW, 103, 139, 46, 47, '#f0d98a'); pr(c, ...RW, 103, 139, 34, 35, '#8f6f22');
    'MANAGER'.split('').forEach((ch, n) => GLYPH[ch].forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] === '#') pr(c, ...RW, 108 + n * 4 + i, 109 + n * 4 + i, 37 + (4 - j), 38 + (4 - j), '#3a2a0b'); }));
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
    pr(c, ...RW, 162, 190, 34, 37, '#5e3d27'); pr(c, ...RW, 162, 190, 36, 37, '#7d5a3d');
    pr(c, ...RW, 164, 169, 37, 42, '#f5f5f0'); pr(c, ...RW, 169, 170, 38, 41, '#f5f5f0'); pr(c, ...RW, 172, 177, 37, 42, '#e93d82'); pr(c, ...RW, 177, 178, 38, 41, '#e93d82');
    pr(c, ...RW, 180, 184, 37, 44, '#12a594'); pr(c, ...RW, 185, 189, 37, 42, '#f5a524');
    pr(c, ...RW, 160, 190, 44, 53, '#2b3149'); pr(c, ...RW, 161, 189, 45, 52, '#f5c542');
    'CAFE'.split('').forEach((ch, n) => GLYPH[ch].forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] === '#') pr(c, ...RW, 168 + n * 4 + i, 169 + n * 4 + i, 46 + (4 - j), 47 + (4 - j), '#7a5236'); }));

    // coffee counter (static: nobody can stand behind it)
    box(c, COUNTER.x0, COUNTER.y0, COUNTER.x1, COUNTER.y1, 0, 14, { top: '#ead2a8', se: '#5e3d27', sw: '#7a5236', hi: '#fff0d2', dk: '#4a2f1d' });
    const cp = [sx(COUNTER.x0, COUNTER.y1), sy(COUNTER.x0, COUNTER.y1, 0)];
    pr(c, cp[0], cp[1], 1, 0, 32, 0, 2, '#4a2f1d');
    for (let k = 0; k < 2; k++) { pr(c, cp[0], cp[1], 1, k * 16 + 2, k * 16 + 14, 3, 11, '#6a452e'); pr(c, cp[0], cp[1], 1, k * 16 + 3, k * 16 + 13, 4, 10, '#8a6040'); pr(c, cp[0], cp[1], 1, k * 16 + 7, k * 16 + 10, 8, 9, '#e5c07a'); }
    // coffee machine
    box(c, 10.0, 0.12, 10.8, 0.86, 14, 31, { top: '#555c70', se: '#2a2e3b', sw: '#3a3f4f', hi: '#6a7188' });
    const mp = [sx(10.0, 0.86), sy(10.0, 0.86, 0)];
    pr(c, mp[0], mp[1], 1, 1, 11, 25, 29, '#242833'); pr(c, mp[0], mp[1], 1, 2, 4, 26, 28, '#ff5a5a'); pr(c, mp[0], mp[1], 1, 6, 8, 26, 28, '#5ff2a5');
    pr(c, mp[0], mp[1], 1, 2, 10, 18, 22, '#1b1e27'); pr(c, mp[0], mp[1], 1, 5, 7, 14, 18, '#999');
    pr(c, mp[0], mp[1], 1, 4, 8, 14, 19, '#f5f5f0'); pr(c, mp[0], mp[1], 1, 4, 8, 17, 19, '#5b3a1e');
    // kettle + mugs on the counter
    box(c, 11.0, 0.2, 11.35, 0.55, 14, 24, { top: '#e6e9f2', se: '#9aa0b4', sw: '#c8ccd8', hi: '#fff' });
    box(c, 11.5, 0.25, 11.72, 0.47, 14, 18, { top: '#ff8b8f', se: '#a8262c', sw: '#e5484d' });
    box(c, 11.5, 0.6, 11.72, 0.82, 14, 18, { top: '#8fb8ff', se: '#2a5fb8', sw: '#3e8ef7' });
    return bg;
  }

  // ---------- furniture ----------
  /** colour/strength of the screen light for a state (null = monitor off) */
  function screenGlow(state, t, ph) {
    switch (state) {
      case 'working': { const k = Math.floor(t * 8 + ph * 5); return { col: k % 3 ? '#5ff2a5' : '#7fd6ff', a: k % 2 ? 0.55 : 0.85 }; }
      case 'thinking': return { col: '#b7a8ff', a: 0.45 + 0.25 * Math.sin(t * 3 + ph * 6) };
      case 'done': return { col: '#6be39b', a: 0.7 };
      case 'error': return { col: Math.floor(t * 4) % 2 ? '#ff5a5a' : '#b0303c', a: 0.8 };
      case 'off': return null;
      default: return { col: '#6a8fd0', a: 0.28 };
    }
  }

  /** Regular desks: the monitor stands on the desk IN FRONT of the person (x = dx+0.6..0.74), the screen faces the person (-x), so the camera
   *  sees its back. The screen state is told by the light leaking round the case (halo), the status light + light bar on the back, the glow
   *  on the desk and on the person's face, and the tool chip over the head. */
  function drawMonitor(c, s, state, t, ph) {
    const { dx, dy } = s, x0 = dx + 0.6, x1 = dx + 0.74, y0 = dy + 0.45, y1 = dy + 1.45, zb = 16, zt = 29;
    const g = screenGlow(state, t, ph), q = [sx(x1, y0), sy(x1, y0, 0)];     // the back plane (x = x1) runs down-left from here, a = pixels along +y
    if (g) { c.globalAlpha = g.a * 0.45; pr(c, q[0], q[1], -1, -3, 19, zb - 3, zt + 3, g.col); c.globalAlpha = g.a * 0.65; pr(c, q[0], q[1], -1, -1, 17, zb - 1, zt + 1, g.col); c.globalAlpha = 1; }
    box(c, dx + 0.52, dy + 0.78, dx + 0.82, dy + 1.12, DESKZ, DESKZ + 1, { top: '#3a3f4f', se: '#1b1e27', sw: '#2b2f3b' });            // foot
    box(c, dx + 0.63, dy + 0.9, dx + 0.71, dy + 1.0, DESKZ + 1, zb, { top: '#555a6a', se: '#2b2f3b', sw: '#3a3f4f' });                 // stand
    box(c, x0, y0, x1, y1, zb, zt, { top: '#454b5e', se: '#2a2e3a', sw: '#1b1e27', hi: '#5a6078' });
    pr(c, q[0], q[1], -1, 1, 15, zb + 1, zt - 1, '#323746'); pr(c, q[0], q[1], -1, 2, 14, zb + 2, zt - 2, '#2a2e3a');                  // back panel
    for (let i = 0; i < 3; i++) pr(c, q[0], q[1], -1, 3, 8, zb + 4 + i * 2, zb + 5 + i * 2, '#1e222d');                                 // vents
    pr(c, q[0], q[1], -1, 9, 13, zt - 6, zt - 4, '#4a5068');                                                                           // logo
    if (g) { pr(c, q[0], q[1], -1, 11, 13, zb + 2, zb + 3, g.col); c.globalAlpha = g.a * 0.7; pr(c, q[0], q[1], -1, 1, 15, zb, zb + 1, g.col); c.globalAlpha = 1; }
    else pr(c, q[0], q[1], -1, 11, 13, zb + 2, zb + 3, '#10131c');
  }

  /** a screen facing +y (the camera): the manager's monitors. xl = left x, w = width in px (16 px = 1 tile), ym = the plane's y. */
  function drawScreenSW(c, xl, ym, w, state, t, ph, tall) {
    const px0 = sx(xl, ym), py0 = sy(xl, ym, 0), mid = w >> 1, o = (w - 12) >> 1, dv = tall ? 3 : 0, top = 27 + dv;
    const Rr = (a0, a1, v0, v1, col) => pr(c, px0, py0, 1, a0, a1, v0, v1, col);
    const Rc = (a0, a1, v0, v1, col) => Rr(a0 + o, a1 + o, v0 + dv, v1 + dv, col);
    Rr(mid - 2, mid + 2, 13, 16, '#3a3f4f'); Rr(mid - 5, mid + 5, 13, 14, '#2b2f3b');                                        // stand + foot
    pr(c, sx(xl + w / 16, ym - 0.125), sy(xl + w / 16, ym - 0.125, 0), -1, 0, 2, 16, top, '#1b1e27');                           // right side of the case
    Rr(0, w, 16, top, '#2b2f3b'); Rr(0, w, top - 1, top, '#4a4f61');                                                            // bezel
    const inner = (col) => Rr(1, w - 1, 17, top - 1, col);
    if (state === 'working') {
      inner('#0e1f1a');
      const tick = Math.floor(t * 6 + ph * 5);
      for (let i = 0; i < 4; i++) { const ww = 3 + Math.floor(rnd(tick + i * 7) * 7); Rc(2 + (i % 2), 2 + (i % 2) + Math.min(ww, 8), 24 - i * 2, 25 - i * 2, i % 2 ? '#7fd6ff' : '#5ff2a5'); }
      if (Math.floor(t * 18 + ph) % 6 === 0) inner('#244d3f');
    } else if (state === 'thinking') {
      inner('#1d2a44');
      const k = Math.floor(t * 3) % 4;
      for (let i = 0; i < 3; i++) Rc(2 + i * 3, 4 + i * 3, 20, 22, i < k ? '#b7a8ff' : '#33446a');
    } else if (state === 'done') {
      inner('#143d2a');
      [[3, 20], [4, 19], [5, 18], [6, 19], [7, 20], [8, 21], [9, 22]].forEach(([a, v]) => Rc(a, a + 1, v, v + 2, '#6be39b'));
    } else if (state === 'error') {
      inner(Math.floor(t * 4) % 2 ? '#4a1218' : '#6a1a22'); Rc(5, 7, 21, 25, '#fff'); Rc(5, 7, 18, 20, '#fff');
    } else if (state === 'off') {
      inner('#10131c'); Rc(2, 6, 24, 25, '#2a3040'); Rc(2, 4, 23, 24, '#2a3040');
    } else {
      inner('#1d2a44');
      [[0, 6], [1, 4], [2, 7]].forEach(([i, ww]) => Rc(2, 2 + ww, 24 - i * 3, 25 - i * 3, '#3a5a8a'));
      if (Math.floor(t * 1.6 + ph) % 2) Rc(2, 4, 17.5 | 0, 19, '#9fe8ff');
    }
    const g = screenGlow(state, t, ph); Rr(w - 2, w - 1, 16, 17, g ? g.col : '#10131c');
  }

  function drawDesk(c, s, ag, t) {
    if (s.mgr) return drawMgrDesk(c, s, ag, t);
    const { dx, dy } = s, x0 = dx, x1 = dx + 1, y0 = dy, y1 = dy + 2;
    const st = ag ? (ag.away ? 'idle' : ag.state) : 'off', ph = ag ? ag.phase : 0, g = screenGlow(st, t, ph);
    box(c, x0, y0, x1, y1, 0, DESKZ, { top: '#cfa56a', se: '#8f6538', sw: '#a77a46', hi: '#ecca94', dk: '#6e4b28' });
    const p = [sx(x0, y1), sy(x0, y1, 0)];                       // SW face: drawers
    pr(c, p[0], p[1], 1, 0, 16, 0, 2, '#5e3f22'); pr(c, p[0], p[1], 1, 0, 16, 10, 12, '#bc8e58');
    for (const [v0, v1] of [[2, 6], [6, 10]]) { pr(c, p[0], p[1], 1, 2, 14, v0, v1, '#6e4724'); pr(c, p[0], p[1], 1, 3, 13, v0 + 1, v1, '#8d5f33'); pr(c, p[0], p[1], 1, 7, 9, v0 + 2, v0 + 3, '#e5c07a'); }
    const q = [sx(x1, y0), sy(x1, y0, 0)];                       // SE face: side panel + name plate
    pr(c, q[0], q[1], -1, 0, 32, 0, 2, '#5e3f22'); pr(c, q[0], q[1], -1, 0, 32, 10, 12, '#a9794a');
    pr(c, q[0], q[1], -1, 15, 17, 2, 10, '#7a502a');
    if (ag) { pr(c, q[0], q[1], -1, 21, 29, 5, 8, ag.look.shirt); pr(c, q[0], q[1], -1, 21, 29, 7, 8, shade(ag.look.shirt, 35)); }
    // the screen lights up the desk in front of it (keyboard side), in the state colour
    if (g) { c.globalAlpha = Math.min(0.22, g.a * 0.2); poly(c, [A(dx + 0.05, dy + 0.4, DESKZ), A(dx + 0.6, dy + 0.4, DESKZ), A(dx + 0.6, dy + 1.5, DESKZ), A(dx + 0.05, dy + 1.5, DESKZ)], g.col); c.globalAlpha = 1; }
    // keyboard
    poly(c, [A(dx + 0.12, dy + 0.62, DESKZ), A(dx + 0.46, dy + 0.62, DESKZ), A(dx + 0.46, dy + 1.3, DESKZ), A(dx + 0.12, dy + 1.3, DESKZ)], '#d6dae6');
    const k1 = A(dx + 0.46, dy + 0.62, DESKZ), k2 = A(dx + 0.46, dy + 1.3, DESKZ), k3 = A(dx + 0.12, dy + 1.3, DESKZ);
    line(c, k1[0], k1[1], k2[0], k2[1], '#9aa0b4', 1); line(c, k2[0], k2[1], k3[0], k3[1], '#9aa0b4', 1);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) { const kp = A(dx + 0.2 + i * 0.1, dy + 0.74 + j * 0.13, DESKZ); R(c, kp[0], kp[1], 1, 1, '#8a90a6'); }
    // mug (front corner), papers (behind the keyboard), lamp
    box(c, dx + 0.3, dy + 1.62, dx + 0.5, dy + 1.82, DESKZ, DESKZ + 4, { top: '#5b3a1e', se: '#c9c9c0', sw: '#f5f5f0' });
    const mh = A(dx + 0.52, dy + 1.72, DESKZ + 2); R(c, mh[0], mh[1], 1, 2, '#f5f5f0');
    poly(c, [A(dx + 0.12, dy + 0.06, DESKZ), A(dx + 0.42, dy + 0.06, DESKZ), A(dx + 0.42, dy + 0.4, DESKZ), A(dx + 0.12, dy + 0.4, DESKZ)], '#f4f1e6');
    const pa = A(dx + 0.27, dy + 0.24, DESKZ); R(c, pa[0] - 2, pa[1], 4, 1, '#c9c2a8');
    if (s.i % 2 === 0) { // desk lamp
      box(c, dx + 0.7, dy + 0.05, dx + 0.82, dy + 0.15, DESKZ, DESKZ + 1, { top: '#2b2f3b', se: '#1b1e27', sw: '#2b2f3b' });
      const lp = A(dx + 0.76, dy + 0.1, DESKZ + 1); R(c, lp[0], lp[1] - 7, 1, 7, '#2b2f3b'); R(c, lp[0] - 3, lp[1] - 9, 5, 2, '#f5c542'); R(c, lp[0] - 2, lp[1] - 7, 3, 1, '#fff3b0');
    }
    drawMonitor(c, s, st, t, ph);
  }

  /** the manager's desk: big walnut desk against the back wall, leather blotter, brass star plate, two monitors facing the camera and the manager */
  function drawMgrDesk(c, s, ag, t) {
    const st = ag ? (ag.away ? 'idle' : ag.state) : 'off', ph = ag ? ag.phase : 0, g = screenGlow(st, t, ph);
    box(c, MD.x0, MD.y0, MD.x1, MD.y1, 0, DESKZ, { top: '#a3703f', se: '#5a3a20', sw: '#74492a', hi: '#dcb072', dk: '#43291a' });
    const L = Math.round((MD.x1 - MD.x0) * 16), p = [sx(MD.x0, MD.y1), sy(MD.x0, MD.y1, 0)];   // front face (+y): pedestals with drawers + a panel
    pr(c, p[0], p[1], 1, 0, L, 0, 2, '#3d2514'); pr(c, p[0], p[1], 1, 0, L, 11, 13, '#c4935a'); pr(c, p[0], p[1], 1, 0, L, 10, 11, '#4a2d19');
    pr(c, p[0], p[1], 1, 15, L - 15, 2, 10, '#5e3b22'); pr(c, p[0], p[1], 1, 17, L - 17, 3, 9, '#7b4e2d'); pr(c, p[0], p[1], 1, 19, L - 19, 4, 8, '#6a4226');
    for (const k0 of [1, L - 15]) for (const [v0, v1] of [[2, 6], [6, 10]]) { pr(c, p[0], p[1], 1, k0, k0 + 14, v0, v1, '#6e4724'); pr(c, p[0], p[1], 1, k0 + 1, k0 + 13, v0 + 1, v1, '#8d5f33'); pr(c, p[0], p[1], 1, k0 + 6, k0 + 8, v0 + 2, v0 + 3, '#f0cf7a'); }
    const q = [sx(MD.x1, MD.y0), sy(MD.x1, MD.y0, 0)];
    pr(c, q[0], q[1], -1, 0, 16, 0, 2, '#3d2514'); pr(c, q[0], q[1], -1, 0, 16, 11, 13, '#a9794a'); pr(c, q[0], q[1], -1, 3, 13, 3, 10, '#6e4724');
    // leather blotter + keyboard (the glow of the screens falls on the blotter)
    const bl = (x0, y0, x1, y1, col) => poly(c, [A(x0, y0, DESKZ), A(x1, y0, DESKZ), A(x1, y1, DESKZ), A(x0, y1, DESKZ)], col);
    bl(7.9, 0.56, 8.96, 0.98, '#d6b25e'); bl(7.92, 0.58, 8.94, 0.96, '#2f5a48');
    if (g) { c.globalAlpha = Math.min(0.3, g.a * 0.28); bl(7.92, 0.58, 8.94, 0.96, g.col); c.globalAlpha = 1; }
    bl(8.05, 0.65, 8.75, 0.9, '#d6dae6');
    const k1 = A(8.75, 0.65, DESKZ), k2 = A(8.75, 0.9, DESKZ), k3 = A(8.05, 0.9, DESKZ);
    line(c, k1[0], k1[1], k2[0], k2[1], '#9aa0b4', 1); line(c, k2[0], k2[1], k3[0], k3[1], '#9aa0b4', 1);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) { const kp = A(8.13 + i * 0.1, 0.69 + j * 0.1, DESKZ); R(c, kp[0], kp[1], 1, 1, '#8a90a6'); }
    // brass star plate (front left), mug, papers
    box(c, 6.5, 0.74, 6.95, 0.84, DESKZ, DESKZ + 6, { top: '#f0d98a', se: '#8f6f22', sw: '#caa24a', hi: '#fff3b0' });
    const sp = A(6.73, 0.84, DESKZ + 3);
    for (const [dx2, dy2] of [[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [-1, 2], [1, 2]]) R(c, sp[0] + dx2, sp[1] + dy2, 1, 1, '#3a2a0b');
    box(c, 7.2, 0.82, 7.37, 0.95, DESKZ, DESKZ + 4, { top: '#5b3a1e', se: '#c9c9c0', sw: '#f5f5f0' });
    bl(8.85, 0.25, 8.97, 0.5, '#f4f1e6');
    drawScreenSW(c, 6.25, 0.5, 14, st, t, ph + 0.37, false);
    drawScreenSW(c, 7.875, 0.5, 14, st, t, ph, true);
  }

  function drawChair(c, s) {
    if (s.mgr) return drawMgrChair(c, s);
    const { dx, dy } = s, cs = { top: '#4d5575', se: '#2f3550', sw: '#3b4260', hi: '#6a739a' };
    box(c, dx - 0.55, dy + 0.95, dx - 0.45, dy + 1.05, 0, 6, { top: '#555a6a', se: '#2b2f3b', sw: '#3a3f4f' });
    poly(c, [A(dx - 0.9, dy + 0.98, 1), A(dx - 0.1, dy + 0.98, 1), A(dx - 0.1, dy + 1.02, 1), A(dx - 0.9, dy + 1.02, 1)], '#2b2f3b');
    poly(c, [A(dx - 0.52, dy + 0.55, 1), A(dx - 0.48, dy + 0.55, 1), A(dx - 0.48, dy + 1.45, 1), A(dx - 0.52, dy + 1.45, 1)], '#2b2f3b');
    box(c, dx - 0.95, dy + 0.55, dx - 0.8, dy + 1.45, 8, 23, cs);
    box(c, dx - 0.9, dy + 0.6, dx - 0.1, dy + 1.4, 6, 9, cs);
  }

  const LEA = { top: '#8a3340', se: '#4f1e26', sw: '#69272f', hi: '#b8505f' }, ARM = { top: '#2b2f3b', se: '#1b1e27', sw: '#2b2f3b' };
  /** the manager's chair: leather seat, arm rests, gas-lift star base (the back rest is a separate object, drawn after the person) */
  function drawMgrChair(c) {
    const cx = MS.x;
    poly(c, [A(cx - 0.4, 1.46, 1), A(cx + 0.4, 1.46, 1), A(cx + 0.4, 1.54, 1), A(cx - 0.4, 1.54, 1)], '#22252f'); poly(c, [A(cx - 0.04, 1.1, 1), A(cx + 0.04, 1.1, 1), A(cx + 0.04, 1.9, 1), A(cx - 0.04, 1.9, 1)], '#22252f');
    box(c, cx - 0.05, 1.45, cx + 0.05, 1.55, 1, 6, { top: '#555a6a', se: '#2b2f3b', sw: '#3a3f4f' });
    box(c, cx - 0.4, 1.1, cx + 0.4, 1.9, 6, 9, LEA);
    box(c, cx - 0.48, 1.15, cx - 0.38, 1.75, 9, 12, ARM); box(c, cx + 0.38, 1.15, cx + 0.48, 1.75, 9, 12, ARM);
  }
  function drawMgrBack(c) {
    const cx = MS.x;
    box(c, cx - 0.43, 1.8, cx + 0.43, 1.92, 9, 14, LEA);
    box(c, cx - 0.43, 1.8, cx - 0.33, 1.92, 14, 23, LEA); box(c, cx + 0.33, 1.8, cx + 0.43, 1.92, 14, 23, LEA);      // tall wings left and right of the sitter
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
    if (ag.help) { // role lanyard + ID card (the person keeps their own look)
      const rc = roleCol(ag.help.role);
      if (front) { R(c, -2, -11 + by, 1, 4, rc); R(c, 2, -11 + by, 1, 4, rc); R(c, -1, -8 + by, 3, 1, rc); R(c, -1, -7 + by, 3, 3, '#fff'); R(c, -1, -7 + by, 3, 1, rc); }
      else R(c, -3, -11 + by, 7, 1, rc);
    }
    head(c, look, -22 + by, front, { blink, mood, lk: 0 });
    const S1 = [-4, -9 + by], S2 = [4, -9 + by];
    let N = [6, 1], Fh = [11, -1.5];                                  // hands on the keyboard
    if (ag.meet) { N = [5, -4]; Fh = [9, -5]; if (st === 'thinking') Fh = [3, -12 + by]; else if (st === 'working') { const f = Math.floor(t * 10 + ph * 3); Fh = [9 + (f % 3 === 1 ? 1 : 0), -5 - (f % 2)]; } }   // hands on the table
    else if (face === 3) {                                             // the manager: back to us, hands forward on the keyboard
      N = [5, -4]; Fh = [9, -4.5];
      if (st === 'working') { const f = Math.floor(t * 10 + ph * 3); N = [5 - (f % 3 === 0 ? 1 : 0), -4 - (f % 2)]; Fh = [9 + (f % 3 === 1 ? 1 : 0), -4.5 - ((f + 1) % 2)]; }
      else if (st === 'thinking') Fh = [3, -12 + by];
    }
    else if (face !== 0) { N = [-3, -1]; Fh = [5, -1]; }
    else if (st === 'working' && face === 0) {
      const f = Math.floor(t * 10 + ph * 3);
      N = [6 - (f % 3 === 0 ? 1 : 0), 1 + (f % 2)]; Fh = [11 + (f % 3 === 1 ? 1 : 0), -1.5 + ((f + 1) % 2)];
    } else if (st === 'thinking') Fh = [3, -12 + by];
    else if (st === 'done') { const b = Math.floor(Math.abs(Math.sin(t * 6)) * 3); N = [-9, -27 - b]; Fh = [9, -27 - b]; }
    else if (st === 'error') { const j = Math.floor(t * 8) % 2; N = [-6 - j, -21]; Fh = [6 + j, -21]; }
    if ((ag.meet || face === 3) && st === 'done') { const b = Math.floor(Math.abs(Math.sin(t * 6)) * 3); N = [-9, -27 - b]; Fh = [9, -27 - b]; }
    else if ((ag.meet || face === 3) && st === 'error') { const j = Math.floor(t * 8) % 2; N = [-6 - j, -21]; Fh = [6 + j, -21]; }
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
    const look = ag.look, walking = ag.mode === 'walk', front = face < 2, hp = ag.help || null;
    const pose = hp && ag.mode === 'help' ? hp.pose : null;      // 'work' | 'cheer' | 'worry' | 'wait'
    const fr = walking ? Math.floor(t * 7 + ag.phase * 3) % 4 : 0;
    const hop = pose === 'cheer' ? Math.floor(Math.abs(Math.sin(t * 7 + ag.phase)) * 2) : 0;
    const bob = (walking && (fr & 1) ? 1 : 0) + hop;
    const la = fr === 1 ? 2 : 0, lb = fr === 3 ? 2 : 0;
    const mood = ag.state === 'error' || pose === 'worry' ? 'worried' : (ag.mode === 'drink' || ag.mode === 'chat' || pose === 'cheer') ? 'happy' : 'normal';
    const blink = ((t * 1000 + ag.phase * 3600) % 3600) < 140;
    R(c, -3, -10, 3, 8 - la, look.pants); R(c, 1, -10, 3, 8 - lb, look.pants);
    R(c, -4, -2 - la, 4, 2, shoes); R(c, 0, -2 - lb, 4, 2, shoes);
    torso(c, look, -20 - bob, 10 + bob, front, look.pants);
    if (hp) { // role lanyard + ID card (the person keeps their own look)
      const rc = roleCol(hp.role);
      if (front) { R(c, -2, -20 - bob, 1, 4, rc); R(c, 2, -20 - bob, 1, 4, rc); R(c, -1, -17 - bob, 3, 1, rc); R(c, -1, -16 - bob, 3, 3, '#fff'); R(c, -1, -16 - bob, 3, 1, rc); R(c, 0, -14 - bob, 1, 1, '#555'); }
      else R(c, -3, -20 - bob, 7, 1, rc);
    }
    const f = Math.floor(t * 8 + ag.phase * 5);
    if (pose === 'work' && front) { // little tablet with a live screen
      R(c, -5, -18, 10, 7, '#161827'); R(c, -4, -17, 8, 5, '#0e2a3a');
      for (let i = 0; i < 3; i++) R(c, -3, -16 + i * 2 - (i === 2 ? 1 : 0), 2 + ((f + i * 2) % 4), 1, i === 1 ? '#5ff2a5' : '#6cb6ff');
    }
    const nod = (ag.mode === 'chat' || pose === 'work') && ag.talk == null && Math.floor(t * 3) % 4 === 0 ? 1 : 0;
    head(c, look, -30 - bob + nod, front, { blink, mood });
    const sw = walking ? (fr === 1 ? 1 : fr === 3 ? -1 : 0) : 0;
    let N = [-5, -9 + sw * 2], Fh = [5, -9 - sw * 2];
    if (ag.mode === 'drink') { const sip = Math.floor(t * 1.5) % 2; Fh = [4, -17 - (sip ? 3 : 0)]; N = [-5, -9]; ret.mug = [Fh[0], Fh[1] - 6]; }
    else if (ag.mode === 'chat') { if (ag.talk != null) { const g = Math.floor(t * 4) % 2; Fh = [ag.talkDir > 0 ? 8 : 6, -19 - g * 3]; } N = [-5, -9]; }
    else if (pose === 'cheer') { N = [-9, -32 - hop]; Fh = [9, -32 - hop]; }
    else if (pose === 'worry') { const j = Math.floor(t * 8) % 2; N = [-6, -10 - j]; Fh = [6, -10 + j]; }
    else if (pose === 'work') {
      if (front) { N = [-5, -12]; Fh = [5, -12]; } else { N = [-4, -12 + (f % 2)]; Fh = [4, -12 + ((f + 1) % 2)]; }
      if (ag.talk != null) { const g = Math.floor(t * 4) % 2; Fh = [ag.talkDir > 0 ? 8 : 6, -19 - g * 3]; }
    } else if (pose === 'wait' && ag.talk != null) { const g = Math.floor(t * 4) % 2; Fh = [ag.talkDir > 0 ? 8 : 6, -19 - g * 3]; }
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
  const MGR_LOOK = [3, 2, 2, 3, 0, 0];         // the manager swivels the other way (their default is back to the camera)
  const seatFace = (e) => (e.faceOv != null ? e.faceOv : e.act === 'look' ? (e.slot === MGR ? MGR_LOOK : LOOK_SEQ)[Math.floor((e.actP || 0) / 0.9) % 6] : e.slot === MGR ? 3 : 0);
  const faceOf = (e) => (e.meet ? e.face || 0 : e.away ? (e.face || 0) : seatFace(e));
  const sitting = (e) => !e.away || !!e.meet;          // on a chair (at the desk) or on a stool (meeting table)
  const seatAt = (e) => (e.meet ? { x: e.x, y: e.y } : SLOTS[e.slot].seat);

  function renderPerson(c, e, t, seated) {
    const face = faceOf(e), ret = {};
    let ax, ay;
    if (seated) { const s = seatAt(e); ax = sx(s.x, s.y); ay = sy(s.x, s.y, SEAT); }
    else {
      ax = sx(e.x, e.y); ay = sy(e.x, e.y, 0);
      for (let dy = -3; dy <= 3; dy++) { const w = Math.round(9 * Math.sqrt(1 - (dy * dy) / 12.25)); R(c, ax - w, ay + dy, w * 2, 1, 'rgba(40,30,15,.28)'); }
    }
    sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, 80, 80); sc.setTransform(1, 0, 0, 1, ORX, ORY);
    if (seated) drawSeated(sc, e, t, face); else drawStanding(sc, e, t, face, ret);
    sc.setTransform(1, 0, 0, 1, 0, 0);
    if (seated && !e.meet && face === 0 && e.slot !== MGR && !e.help) {      // the screen in front of them lights their face + chest in the state colour
      const g = screenGlow(e.state, t, e.phase);
      if (g) { sc.globalCompositeOperation = 'source-atop'; sc.globalAlpha = Math.min(0.3, g.a * 0.3); sc.fillStyle = g.col; sc.fillRect(ORX - 2, ORY - 31, 10, 24); sc.globalAlpha = 1; sc.globalCompositeOperation = 'source-over'; }
    }
    blit(c, ax, ay, FLIP[face]);
    if (ret.mug) { const mx = ax + (FLIP[face] ? -ret.mug[0] : ret.mug[0]), s2 = Math.floor(t * 4) % 2; c.globalAlpha = 0.8; R(c, mx - 1 + s2, ay + ret.mug[1] - 3, 1, 2, '#fff'); R(c, mx + 1 - s2, ay + ret.mug[1] - 6, 1, 2, '#fff'); c.globalAlpha = 1; }
  }


  // ---------- team collaboration: roles, helper spots, handoff icons, dotted links ----------
  const ROLE_COL = { security: '#ff6b6b', performance: '#ffb02e', tests: '#5ff2a5', style: '#c49bff', docs: '#6cb6ff', architecture: '#ff8fa3', explore: '#4dd0e1', general: '#cfd6e6' };
  const ROLE_ICO = {
    security: ['..###..', '.#####.', '#######', '#######', '.#####.', '..###..', '...#...'],
    performance: ['....##.', '...##..', '..##...', '.#####.', '...##..', '..##...', '.##....'],
    tests: ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
    style: ['...#...', '...#...', '.#####.', '..###..', '.#####.', '...#...', '...#...'],
    docs: ['.#####.', '.#...#.', '.#####.', '.#...#.', '.#####.', '.#...#.', '.#####.'],
    architecture: ['...#...', '..###..', '..#.#..', '.#####.', '.#...#.', '#######', '#.....#'],
    explore: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
    general: ['..#.#..', '.#####.', '##...##', '.#...#.', '##...##', '.#####.', '..#.#..'],
  };
  const roleCol = (r) => ROLE_COL[r] || ROLE_COL.general;
  const kindCol = roleCol;
  function roleBadge(c, x, y, role) { // 9x9 role icon, top-left at x,y
    const col = roleCol(role), ico = ROLE_ICO[role] || ROLE_ICO.general;
    R(c, x, y, 9, 9, '#161827'); R(c, x + 1, y + 1, 7, 7, col); R(c, x + 1, y + 1, 7, 1, shade(col, 35));
    for (let r = 0; r < 7; r++) for (let q = 0; q < 7; q++) if (ico[r][q] === '#') R(c, x + 1 + q, y + 1 + r, 1, 1, '#161827');
  }
  function clipboardIcon(c, x, y, t) { // clipboard with ticking lines (the lead announcing the plan)
    x = Math.round(x); y = Math.round(y);
    R(c, x - 6, y - 8, 13, 17, '#161827'); R(c, x - 5, y - 7, 11, 15, '#c9a26b'); R(c, x - 4, y - 5, 9, 12, '#fffbe8'); R(c, x - 2, y - 9, 5, 3, '#8b90ad'); R(c, x - 1, y - 9, 3, 1, '#161827');
    const k = Math.floor(t * 2) % 4;
    for (let i = 0; i < 3; i++) { R(c, x - 3, y - 3 + i * 4, 1, 1, i < k ? '#30a46c' : '#9a8f6a'); R(c, x - 1, y - 3 + i * 4, 5, 1, '#9a8f6a'); }
  }
  const faceToward = (fx, fy, tx, ty) => { const dx = tx - fx, dy = ty - fy; return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3); };

  /** Floor route (tile coordinates) between two desks, along the aisles / gaps between the desks, so dotted lines and flying papers never cross
   *  furniture. `off` separates parallel lanes so several helpers' lines do not lie on top of each other. */
  function deskRoute(sa, sb, off) {
    const A0 = SLOTS[sa], B0 = SLOTS[sb], T = AISLE + off, F = (s) => s.px + off, gap = (s) => s.gapY + off, y0 = (s) => s.py;
    let pts;
    if (A0.row === B0.row) pts = [[F(A0), y0(A0)], [F(A0), y0(B0)], [F(B0), y0(B0)]];
    else if (A0.row) pts = [[F(A0), y0(A0)], [F(A0), gap(A0)], [T, gap(A0)], [T, y0(B0)]];
    else pts = [[T, y0(A0)], [T, gap(B0)], [F(B0), gap(B0)], [F(B0), y0(B0)]];
    return pts.filter((q, i) => !i || Math.abs(q[0] - pts[i - 1][0]) > 1e-6 || Math.abs(q[1] - pts[i - 1][1]) > 1e-6);
  }
  /** same route as screen points (z = floor height of the line) */
  const routeScreen = (sa, sb, off, z) => deskRoute(sa, sb, off).map(([x, y]) => A(x, y, z || 0));
  function pointAlong(pts, q) {
    let tot = 0; const L = [];
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); L.push(d); tot += d; }
    let d = Math.max(0, Math.min(1, q)) * tot;
    for (let i = 0; i < L.length; i++) { if (d <= L[i] || i === L.length - 1) { const f = L[i] ? d / L[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; } d -= L[i]; }
    return pts[0];
  }
  function sparkles(c, cx, cy, t, ph) { // little celebration stars around a head
    for (let i = 0; i < 6; i++) {
      const a = t * 2.4 + i * 1.05 + ph, r = 13 + 3 * Math.sin(t * 5 + i), x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r * 0.6), k = Math.floor(t * 6 + i) % 2;
      R(c, x - 1 - k, y, 3 + k * 2, 1, '#ffd84a'); R(c, x, y - 1 - k, 1, 3 + k * 2, '#ffd84a');
    }
  }

  // pixel icons for the handoffs
  function paperIcon(c, x, y, f) {
    x = Math.round(x); y = Math.round(y); const w = f % 2 ? 2 : 3;
    R(c, x - w - 1, y - 4, w * 2 + 2, 8, '#161827'); R(c, x - w, y - 3, w * 2, 6, '#fffbe8');
    R(c, x - w + 1, y - 2, Math.max(1, w * 2 - 2), 1, '#9a8f6a'); R(c, x - w + 1, y, Math.max(1, w * 2 - 2), 1, '#9a8f6a');
  }
  function envelopeIcon(c, x, y, seal) {
    x = Math.round(x); y = Math.round(y);
    R(c, x - 6, y - 4, 12, 9, '#161827'); R(c, x - 5, y - 3, 10, 7, '#fffbe8');
    for (let i = 0; i < 4; i++) { R(c, x - 5 + i, y - 3 + i, 1, 1, '#b0a77c'); R(c, x + 4 - i, y - 3 + i, 1, 1, '#b0a77c'); }
    R(c, x - 1, y, 2, 2, seal);
  }
  function msgBubble(c, cx, cy, glyph) { // small speech bubble with an envelope ('env') or '!' ('err')
    cx = Math.round(cx); cy = Math.round(cy);
    R(c, cx - 8, cy - 6, 16, 12, '#161827'); R(c, cx - 7, cy - 7, 14, 14, '#161827'); R(c, cx - 7, cy - 6, 14, 12, '#fff'); R(c, cx - 6, cy - 7, 12, 14, '#fff');
    R(c, cx - 4, cy + 6, 4, 3, '#161827'); R(c, cx - 3, cy + 6, 2, 2, '#fff');
    if (glyph === 'err') { R(c, cx - 1, cy - 4, 2, 5, '#e5484d'); R(c, cx - 1, cy + 3, 2, 2, '#e5484d'); }
    else { R(c, cx - 5, cy - 3, 10, 7, '#3a3f52'); R(c, cx - 4, cy - 2, 8, 5, '#fffbe8'); for (let i = 0; i < 4; i++) { R(c, cx - 4 + i, cy - 2 + i, 1, 1, '#9a8f6a'); R(c, cx + 3 - i, cy - 2 + i, 1, 1, '#9a8f6a'); } R(c, cx - 1, cy, 2, 2, '#30a46c'); }
  }
  /** dotted line along a Bresenham path; dots march forward with `ph` */
  function dotLine(c, x0, y0, x1, y1, col, ph, on) {
    on = on || 1;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), stx = x0 < x1 ? 1 : -1, sty = y0 < y1 ? 1 : -1;
    let err = dx + dy, i = 0; c.fillStyle = col;
    for (;;) {
      if ((((i++ - ph) % (on === 1 ? 4 : on * 2)) + (on === 1 ? 4 : on * 2)) % (on === 1 ? 4 : on * 2) < on) c.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += stx; }
      if (e2 <= dx) { err += dx; y0 += sty; }
    }
  }

  // ---------- scene: objects, depth sorting ----------
  function stool(c, st, occupied) {
    const tt = { top: '#3d4a6f', se: '#232c47', sw: '#2e3856', hi: '#5a6a9a' };
    box(c, st.x - 0.05, st.y - 0.05, st.x + 0.05, st.y + 0.05, 0, 6, { top: '#555a6a', se: '#2b2f3b', sw: '#3a3f4f' });
    poly(c, [A(st.x - 0.24, st.y - 0.03, 1), A(st.x + 0.24, st.y - 0.03, 1), A(st.x + 0.24, st.y + 0.03, 1), A(st.x - 0.24, st.y + 0.03, 1)], '#2b2f3b');
    poly(c, [A(st.x - 0.03, st.y - 0.24, 1), A(st.x + 0.03, st.y - 0.24, 1), A(st.x + 0.03, st.y + 0.24, 1), A(st.x - 0.03, st.y + 0.24, 1)], '#2b2f3b');
    box(c, st.x - 0.26, st.y - 0.26, st.x + 0.26, st.y + 0.26, 6, 8, tt);
  }
  function drawTable(c, t, plan) {
    const { x, y, r } = TABLE, N = 40, rim = (z, rr) => Array.from({ length: N }, (_, k) => A(x + rr * Math.cos((k / N) * Math.PI * 2), y + rr * Math.sin((k / N) * Math.PI * 2), z));
    box(c, x - 0.12, y - 0.12, x + 0.12, y + 0.12, 0, 11, { top: '#555a6a', se: '#2b2f3b', sw: '#3a3f4f' });
    poly(c, rim(1, 0.55), '#2b2f3b'); poly(c, rim(1.5, 0.45), '#3a3f4f');
    // the round top: a rim (thickness) under the lit surface
    for (let z = 12; z <= 14; z++) poly(c, rim(z, r), z === 12 ? '#6e4724' : '#8a5a31');
    poly(c, rim(15, r), '#b98650'); poly(c, rim(15, r - 0.07), '#d6a76c'); poly(c, rim(15, r - 0.5), '#cf9d62');
    const hi = A(x - 0.35, y - 0.55, 15); R(c, hi[0] - 4, hi[1], 8, 1, 'rgba(255,240,200,.45)');
    // paper pads in front of every chair + a speaker puck (it is a meeting table)
    for (const st of SEATS) { const px = x + (st.x - x) * 0.58, py = y + (st.y - y) * 0.58, q = A(px, py, 15); R(c, q[0] - 2, q[1] - 1, 4, 2, '#f4f1e6'); R(c, q[0] - 1, q[1], 2, 1, '#c9c2a8'); }
    const sp = A(x, y, 15); R(c, sp[0] - 4, sp[1] - 2, 8, 4, '#2b2f3b'); R(c, sp[0] - 3, sp[1] - 3, 6, 1, '#3a3f4f'); R(c, sp[0] - 1, sp[1] - 2, 2, 1, plan ? (plan.state === 'ready' ? '#6be39b' : '#ffd84a') : '#4a5068');
  }

  function buildObjects(entries, t, plan) {
    const bySlot = {}; entries.forEach((e) => { bySlot[e.slot] = e; });
    const objs = [];
    for (const s of SLOTS) {
      const ag = bySlot[s.i] || null, res = ag ? { id: ag.id } : { slot: s.i };
      if (s.mgr) {
        objs.push({ x0: MS.x - 0.4, y0: 1.1, x1: MS.x + 0.4, y1: 1.78, h: 14, pad: 2, ord: 0, tag: 'chair' + s.i, draw: (c) => drawMgrChair(c), hit: (lx, ly) => inPoly(boxHex(MS.x - 0.4, 1.1, MS.x + 0.4, 1.9, 0, 12), lx, ly), res });
        objs.push({ x0: MS.x - 0.43, y0: 1.8, x1: MS.x + 0.43, y1: 1.92, h: 24, pad: 2, ord: 3, tag: 'back' + s.i, draw: (c) => drawMgrBack(c), hit: (lx, ly) => inPoly(boxHex(MS.x - 0.43, 1.8, MS.x + 0.43, 1.92, 0, 23), lx, ly), res });
        const m1 = [sx(6.25, 0.5), sy(6.25, 0.5, 27), 14], m2 = [sx(7.875, 0.5), sy(7.875, 0.5, 30), 14];
        objs.push({ x0: MD.x0, y0: MD.y0, x1: MD.x1, y1: MD.y1, h: 32, pad: 2, ord: 2, tag: 'desk' + s.i, draw: (c) => drawDesk(c, s, ag, t),
          hit: (lx, ly) => inPoly(boxHex(MD.x0, MD.y0, MD.x1, MD.y1, 0, DESKZ), lx, ly) || [m1, m2].some((m) => lx >= m[0] && lx < m[0] + m[2] && ly >= m[1] && ly < m[1] + 15), res });
        continue;
      }
      const cx0 = s.dx - 0.95, cy0 = s.dy + 0.55, cx1 = s.dx - 0.05, cy1 = s.dy + 1.45;
      objs.push({ x0: cx0, y0: cy0, x1: cx1, y1: cy1, h: 24, pad: 0, ord: 0, tag: 'chair' + s.i, draw: (c) => drawChair(c, s), hit: (lx, ly) => inPoly(boxHex(cx0, cy0, cx1, cy1, 0, 23), lx, ly), res });
      const mon = [sx(s.dx + 0.74, s.dy + 1.45), sy(s.dx + 0.74, s.dy + 1.45, 29), 14];
      objs.push({ x0: s.dx, y0: s.dy, x1: s.dx + 1, y1: s.dy + 2, h: 29, pad: 0, ord: 2, tag: 'desk' + s.i, draw: (c) => drawDesk(c, s, ag, t),
        hit: (lx, ly) => inPoly(boxHex(s.dx, s.dy, s.dx + 1, s.dy + 2, 0, DESKZ), lx, ly) || (lx >= mon[0] && lx < mon[0] + mon[2] && ly >= mon[1] && ly < mon[1] + 15), res });
    }
    for (const p of PLANTS) objs.push({ x0: p.x + 0.2, y0: p.y + 0.2, x1: p.x + 0.8, y1: p.y + 0.8, h: 34, pad: 8, ord: 0, draw: (c) => plant(c, p.x, p.y), hit: null });
    objs.push({ x0: TABLE.x - 1.0, y0: TABLE.y - 1.0, x1: TABLE.x + 1.0, y1: TABLE.y + 1.0, h: 20, pad: 10, ord: 0, tag: 'table', draw: (c) => drawTable(c, t, plan), hit: null });
    for (const st of SEATS) objs.push({ x0: st.x - 0.27, y0: st.y - 0.27, x1: st.x + 0.27, y1: st.y + 0.27, h: 9, pad: 2, ord: 0, tag: 'stool' + st.i, draw: (c) => stool(c, st), hit: null });
    for (const e of entries) {
      let x, y; const seated = sitting(e);
      if (seated) { const q = seatAt(e); x = q.x; y = q.y; } else { x = e.x; y = e.y; }
      const ax = sx(x, y), ay = sy(x, y, seated ? SEAT : 0), top = seated ? 26 : 34;
      objs.push({ x0: x - 0.22, y0: y - 0.22, x1: x + 0.22, y1: y + 0.22, h: top, pad: 10, ord: 1, tag: 'person:' + e.id, draw: (c) => renderPerson(c, e, t, seated),
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
    const x0 = s.ring.x0, y0 = s.ring.y0, x1 = s.ring.x1, y1 = s.ring.y1;
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

  // ---------- the plan document floating over the round table ----------
  const planDocPos = () => [sx(TABLE.x, TABLE.y), sy(TABLE.x, TABLE.y, 84)];   // high enough to clear the head on the back stool
  function planDoc(c, plan, t) {
    const [cx0, cy0] = planDocPos(), bob = Math.round(Math.sin(t * 2.4)), ready = plan.state === 'ready', x = cx0, y = cy0 + bob;
    const ts = A(TABLE.x, TABLE.y, TABLE.h);                       // shadow on the table top
    c.globalAlpha = 0.25; R(c, ts[0] - 6, ts[1] - 1, 12, 3, '#000'); c.globalAlpha = 1;
    for (let yy = ts[1] - 3, i = 0; yy > y + 12; yy -= 4, i++) { c.globalAlpha = 0.35 + 0.35 * ((Math.floor(t * 6) + i) % 3 === 0 ? 1 : 0); R(c, x, yy, 1, 2, ready ? '#6be39b' : '#ffd84a'); }
    c.globalAlpha = 1;
    R(c, x - 8, y - 11, 17, 22, '#161827'); R(c, x - 7, y - 10, 15, 20, ready ? '#fffbe8' : '#f6efd2'); R(c, x - 7, y - 10, 15, 3, ready ? '#6be39b' : '#ffd84a');
    R(c, x + 4, y - 10, 4, 4, '#161827'); R(c, x + 5, y - 9, 2, 2, '#c9c2a8');
    const k = ready ? 5 : 1 + Math.floor(t * 2) % 5;
    for (let i = 0; i < 5; i++) if (i < k) { R(c, x - 5, y - 4 + i * 3, 2, 2, ready || i < k - 1 ? '#30a46c' : '#9a8f6a'); R(c, x - 2, y - 4 + i * 3, 7 - (i % 2) * 2, 1, '#9a8f6a'); }
    if (ready) { R(c, x + 4, y + 5, 8, 8, '#161827'); R(c, x + 5, y + 6, 6, 6, '#30a46c'); [[6, 9], [7, 10], [8, 9], [9, 8], [10, 7]].forEach(([a, b]) => R(c, x + a, y + b - 1, 1, 2, '#fff')); }
    else for (let i = 0; i < 3; i++) { const f = (t * 2 + i * 0.33) % 1; c.globalAlpha = 1 - f; R(c, x - 12 + i * 12, y - 15 - Math.round(f * 3), 2, 2, '#ffd84a'); c.globalAlpha = 1; }
  }

  // ---------- main ----------
  const bg = buildBackground();
  const logical = mk(W, H), lc = logical.getContext('2d');
  const labelPt = (e) => { const s = SLOTS[e.slot !== undefined ? e.slot : e.i]; return [sx(s.lab.x, s.lab.y), sy(s.lab.x, s.lab.y, 0) + 6]; };
  const personAnchor = (e) => { if (sitting(e)) { const s = seatAt(e); return { ax: sx(s.x, s.y), ay: sy(s.x, s.y, SEAT), head: sy(s.x, s.y, SEAT) - 24 }; } return { ax: sx(e.x, e.y), ay: sy(e.x, e.y, 0), head: sy(e.x, e.y, 0) - 32 }; };

  /** scene: {t, entries:[{id,name,type,slot,look,state,tool,phase,away,x,y,face,mode,bubble,act,actP,talk,talkDir,queued}], selectedId, hoverId, hoverSlot} */
  function render(canvas, S, U, scene) {
    const t = scene.t, entries = scene.entries;
    lc.clearRect(0, 0, W, H);
    lc.drawImage(bg, 0, 0);
    const bySlot = {}; entries.forEach((e) => { bySlot[e.slot] = e; });
    // meeting: a glowing ring on the floor around the round table while a plan is being made
    const plan = scene.plan || null;
    if (plan) {
      const tx = sx(TABLE.x, TABLE.y), ty = sy(TABLE.x, TABLE.y, 0), col = plan.state === 'ready' ? '#6be39b' : '#ffd84a';
      lc.globalAlpha = 0.12 + 0.06 * Math.sin(t * 4); poly(lc, Array.from({ length: 48 }, (_, k) => A(TABLE.x + 2.35 * Math.cos(k / 48 * Math.PI * 2), TABLE.y + 2.35 * Math.sin(k / 48 * Math.PI * 2), 0)), col); lc.globalAlpha = 1;
      ellipseRing(lc, tx, ty, Math.round(22.6 * 2.4), Math.round(11.3 * 2.4), col, t, 1);
    }
    // floor-level outlines first so furniture and people cover them where they should
    for (const e of entries) {
      const s = SLOTS[e.slot];
      if (e.id === scene.selectedId) { podRing(lc, s, '#f5c542', t, 1); if (e.away || e.meet) { const p = personAnchor(e); ellipseRing(lc, p.ax, p.ay - (e.meet ? SEAT : 0), 13, 6, '#f5c542', t, 1); } }
      else if (e.id === scene.hoverId) { podRing(lc, s, 'rgba(255,255,255,.8)', 0, 1); if (e.away) { const p = personAnchor(e); ellipseRing(lc, p.ax, p.ay, 13, 6, 'rgba(255,255,255,.8)', 0, 1); } }
    }
    if (scene.hoverSlot != null && !bySlot[scene.hoverSlot]) podRing(lc, SLOTS[scene.hoverSlot], 'rgba(95,242,165,.9)', 0, 1);
    // dotted isometric lines lead desk -> every helper desk (along the aisles), the glowing desk pads, the wrap-up rings, inferred peer lines
    const byId = {}; entries.forEach((e) => { byId[e.id] = e; });
    const ph8 = Math.floor(t * 8), lane = {}, byLead = {};
    for (const e of entries) if (e.help) (byLead[e.help.parentId] = byLead[e.help.parentId] || []).push(e);
    for (const k in byLead) byLead[k].sort((p, q) => p.slot - q.slot).forEach((e, i) => { lane[e.id] = (i - (byLead[k].length - 1) / 2) * 0.1; });
    const pad = (sl, col, al) => { const s = SLOTS[sl], x = s.px, y = s.py; lc.globalAlpha = al; poly(lc, [A(x - 0.4, y - 0.4, 0), A(x + 0.4, y - 0.4, 0), A(x + 0.4, y + 0.4, 0), A(x - 0.4, y + 0.4, 0)], col); lc.globalAlpha = 1; };
    const polyDots = (pts, col, ph) => { for (let i = 1; i < pts.length; i++) dotLine(lc, Math.round(pts[i - 1][0]), Math.round(pts[i - 1][1]), Math.round(pts[i][0]), Math.round(pts[i][1]), col, ph + i * 2, 2); };
    for (const e of entries) {
      if (e.huddle != null && !e.away) podRing(lc, SLOTS[e.slot], '#f5c542', t, 1);
      const h = e.help; if (!h || !h.desk) continue;
      const pe = byId[h.parentId]; if (!pe || pe.away) continue;
      const rc = roleCol(h.role), fade = h.pose === 'work' ? 1 : 0.5, lanes = lane[e.id] || 0;
      pad(e.slot, rc, (0.16 + 0.08 * Math.sin(t * 5 + e.phase * 6)) * fade); pad(pe.slot, rc, 0.1 * fade);
      lc.globalAlpha = fade; polyDots(routeScreen(pe.slot, e.slot, lanes), rc, ph8); lc.globalAlpha = 1;
      if (h.celebrate != null) podRing(lc, SLOTS[e.slot], '#f5c542', t, 1);
      if (h.peerWith && e.id < h.peerWith && byId[h.peerWith] && h.desk) { // inferred peer line between the two helper desks
        const o = byId[h.peerWith];
        lc.globalAlpha = 0.95; polyDots(routeScreen(e.slot, o.slot, 0.32), '#ffffff', ph8 + 1); lc.globalAlpha = 1;
      }
    }
    // steam over the coffee machine
    for (let i = 0; i < 3; i++) {
      const p = (t * 8 + i * 4) % 12, bx = sx(10.4, 0.5), by = sy(10.4, 0.5, 32);
      lc.globalAlpha = 0.6 * (1 - p / 12); R(lc, bx + Math.sin(t * 2 + i * 2) * 1.5 - 1 + i * 2, by - p, 2, 2, '#fff');
    }
    lc.globalAlpha = 1;
    for (const o of sortObjs(buildObjects(entries, t, plan))) o.draw(lc);
    // state icons, role badges, talk bubbles sit above everything
    for (const e of entries) {
      const p = personAnchor(e), h = e.help;
      if (h) {
        roleBadge(lc, p.ax - 17, p.ay - (e.away ? 31 : 28), h.role);
        if (h.desk && h.celebrate != null) sparkles(lc, p.ax, p.head + 4, t, e.phase * 6);
        const st = h.say ? null : h.desk ? (e.state === 'done' || e.state === 'error' ? e.state : null) : h.pose === 'cheer' ? 'done' : h.pose === 'worry' ? 'error' : null;
        if (st) stateIcon(lc, p.ax, h.desk ? p.head : p.head + 2, st, t);
        if (e.talk != null) drawTalk(lc, p.ax + e.talkDir * 6, p.head - 2, e.talk, e.talkDir);
        continue;
      }
      if (e.meet) {                                    // at the round table: thinking bubbles in turn while the plan is being made
        if (plan && plan.state === 'planning' && e.id !== plan.ownerId) { const k = Math.floor(t * 0.7 + e.phase * 9 + e.slot) % 3; if (k < 2) drawTalk(lc, p.ax + 6, p.head - 2, k ? 2 : 0, 1); }
        else if (plan && plan.state === 'ready') { if (Math.floor(t * 0.8 + e.slot) % 2) drawTalk(lc, p.ax + 6, p.head - 2, 1, 1); }
        else stateIcon(lc, p.ax, p.head, e.state, t);
        continue;
      }
      if (!e.away) stateIcon(lc, p.ax, p.head, e.state, t);
      else { stateIcon(lc, p.ax, p.head + 2, e.state, t); if (e.mode === 'chat' && e.talk != null) drawTalk(lc, p.ax + e.talkDir * 6, p.head - 2, e.talk, e.talkDir); }
    }
    for (const e of entries) if (e.planAge != null && !e.away) { const p = personAnchor(e); clipboardIcon(lc, p.ax + 17, p.head + 1 + Math.round(Math.sin(t * 3)), t); }
    if (plan) planDoc(lc, plan, t);
    for (const f of scene.flights || []) {
      if (f.p < 0 || f.p > 1) continue;
      let sa, sb, off, kc = '#6cb6ff', draw;
      if (f.kind === 'letter') {
        const fe = byId[f.pid], te = byId[f.toId]; if (!fe || !te) continue;
        sa = fe.slot; sb = te.slot; off = 0.32; draw = (x, y) => envelopeIcon(lc, x, y, '#6cb6ff');
      } else {
        const pe = byId[f.pid], he = byId[f.hid]; if (!pe || !he) continue;
        kc = roleCol(he.help ? he.help.role : f.role); off = lane[he.id] || 0;
        if (f.kind === 'out') { sa = pe.slot; sb = he.slot; draw = (x, y) => paperIcon(lc, x, y, Math.floor(t * 10)); }
        else { sa = he.slot; sb = pe.slot; draw = (x, y) => envelopeIcon(lc, x, y, f.ok === false ? '#e5484d' : '#30a46c'); }
      }
      // the paper / envelope glides along the dotted line, hovering a little above the floor, with a short trail
      const rt = routeScreen(sa, sb, off, 0);
      const pos = (q) => { const z = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2, pt = pointAlong(rt, z); return [pt[0], pt[1] - 13 - Math.sin(Math.PI * Math.min(1, Math.max(0, q))) * 4]; };
      for (let k = 3; k >= 1; k--) { const q = f.p - k * 0.05; if (q < 0) continue; const tp = pos(q); lc.globalAlpha = 0.7 / k; R(lc, Math.round(tp[0]), Math.round(tp[1]), 2, 2, kc); }
      lc.globalAlpha = 1;
      const pp = pos(f.p); draw(pp[0], pp[1]);
    }
    for (const e of entries) if (e.rcv && e.rcv.age >= 0 && e.rcv.age < 2.4 * (scene.slow || 1)) {
      const p = personAnchor(e), bob = Math.floor(Math.sin(e.rcv.age * 8) * 1.2), pop = e.rcv.age < 0.15 ? 0.5 : 1, life = 2.4 * (scene.slow || 1);
      lc.globalAlpha = e.rcv.age > life - 0.4 ? Math.max(0, 1 - (e.rcv.age - (life - 0.4)) / 0.4) : pop;
      msgBubble(lc, p.ax + 15, p.head - 5 + bob, e.rcv.ok === false ? 'err' : 'env');
      lc.globalAlpha = 1;
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
      if (!e.away && e.huddle != null) pillText(ctx, 'team wrap-up', p.ax * S, (p.head - 5) * S, U * 0.9, '#2a1f00', '#f5c542', true);
      else if (!e.away && e.waiting > 0) pillText(ctx, 'waiting on ' + e.waiting + ' helper' + (e.waiting > 1 ? 's' : '') + '.'.repeat(1 + Math.floor(t * 2) % 3), p.ax * S, (p.head - 5) * S, U * 0.9, '#2a1f00', '#f5c542', true);
      else if ((!e.away || e.meet) && e.state === 'working') pillText(ctx, e.tool || 'typing…', p.ax * S, (p.head - 5) * S, U * 0.9, '#0e1f1a', '#5ff2a5', true);
      if (e.help && !e.away && e.help.desk) {       // "helping <lead>" tag under the name pill
        pillText(ctx, 'helping ' + e.help.parentName + ' · ' + e.help.role, labX * S, (lp[1] + 11) * S, U * 0.72, '#14151f', roleCol(e.help.role), true);
      }
      if (e.help && e.away) {
        const hp = e.help;
        pillText(ctx, e.name + ' · ' + hp.role, p.ax * S, (p.ay + 10) * S, U * 0.72, '#14151f', roleCol(hp.role), true);
        
      }
      if (e.queued) pillText(ctx, '+' + e.queued + ' queued', labX * S, (lp[1] + (e.help && !e.away && e.help.desk ? 21 : 11)) * S, U * 0.85, '#14151f', '#f5c542', true);
      // (speech bubbles are drawn after the loop so overlapping ones can be stacked)
    }
    const bubs = [];
    for (const e of entries) { const bub = e.help && e.help.say ? e.help.say : e.bubble; if (bub) bubs.push({ e, bub, p: personAnchor(e), w: Math.min(Math.max(120 * U, 46 * S) + 12 * U, bub.length * 6.6 * U + 14 * U) }); }
    if (plan) {
      const dp = planDocPos(), pw = (plan.state === 'ready' ? 'PLAN READY' : 'planning…');
      pillText(ctx, plan.state === 'ready' ? '✓ PLAN READY' : pw, dp[0] * S, (dp[1] - 25) * S, U * 0.95, plan.state === 'ready' ? '#0e2a1a' : '#2a1f00', plan.state === 'ready' ? '#6be39b' : '#ffd84a', true);
      const psum = plan.summary && plan.summary.length > 72 ? plan.summary.slice(0, 69) + '…' : plan.summary;
      if (psum && plan.state === 'ready') bubs.push({ e: null, bub: psum, p: { ax: dp[0], head: dp[1] - 15 }, w: Math.min(Math.max(120 * U, 46 * S) + 12 * U, psum.length * 6.6 * U + 14 * U) });
    }
    bubs.sort((a, b) => a.p.ax - b.p.ax);
    const placed = [];
    for (const b of bubs) {
      const cx = b.p.ax * S; let bottom = (b.p.head - 18) * S;
      for (let k = 0; k < 12; k++) {
        const r = drawBubble(ctx, b.bub, cx, bottom, S, U, canvas.width, true), m = 3 * U;
        if (!placed.some((q) => r.x < q.x + q.w + m && r.x + r.w + m > q.x && r.y < q.y + q.h + m && r.y + r.h + m > q.y)) { placed.push(r); break; }
        bottom -= 8 * U;
      }
      drawBubble(ctx, b.bub, cx, bottom, S, U, canvas.width);
    }
    for (const s of SLOTS) if (!bySlot[s.i] && scene.hoverSlot === s.i) { const lp = labelPt(s); pillText(ctx, '＋ hire', lp[0] * S, lp[1] * S, U, '#0e1f1a', '#5ff2a5', true); }
  }

  /** logical-pixel hit test: front-most object first (same order as drawing). -> {id} | {slot} | null */
  function hitTest(lx, ly, entries) {
    const list = sortObjs(buildObjects(entries, 0, null));
    for (let i = list.length - 1; i >= 0; i--) { const o = list[i]; if (o.hit && o.hit(lx, ly)) return o.res; }
    return null;
  }

  window.OfficeIso = {
    W, H, SLOTS, MAX_SLOTS, render, hitTest, walkPath, SPOTS, SPEED, STEP: 1,
    drawAvatar: F.drawAvatar, GX, GY, isBlocked, project: (x, y, z) => [sx(x, y), sy(x, y, z || 0)],
    deskPoint: (slot) => { const s = SLOTS[slot]; return [sx(s.desk.x, s.desk.y), sy(s.desk.x, s.desk.y, DESKZ)]; },
    TABLE, SEATS, MGR, MD, COUNTER, PLANTS, tablePoint: () => [sx(TABLE.x, TABLE.y), sy(TABLE.x, TABLE.y, TABLE.h)],
    labelPoint: labelPt,
    deskRoute, kindCol, roleCol, roleBadge, ROLE_COL, walkBetween,
    drawOrder: (entries) => sortObjs(buildObjects(entries, 0, null)).map((o) => o.tag || 'other'),   // for tests
  };
})();
