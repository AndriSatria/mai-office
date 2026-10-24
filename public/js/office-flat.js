/* mAI office - FLAT (top-down) procedural pixel-art renderer, used with ?view=flat.
 * (The default view is the isometric renderer in office-iso.js.)
 * Everything is drawn with fillRect on a small logical canvas (384x240) and then
 * blitted to the visible canvas with integer scaling and smoothing disabled.
 * Text (names, tool chips, speech bubbles) is drawn on the visible canvas at native res. */
(function () {
  'use strict';
  const W = 384, H = 240;
  const COLS = [48, 125, 202, 279];
  const ROWS = [94, 178];
  const SLOTS = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) SLOTS.push({ cx: COLS[c], cy: ROWS[r], row: r, col: c });
  const AISLE = [132, 214];
  const COFFEE = { x: 350, y: 100 };
  const MAX_SLOTS = SLOTS.length;

  // ---------- tiny helpers ----------
  const R = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); };
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
  }
  const rnd = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  function disc(c, cx, cy, r, col) {
    c.fillStyle = col;
    for (let y = -r; y <= r; y++) { const w = Math.floor(Math.sqrt(r * r - y * y + 0.5)); c.fillRect(cx - w, cy + y, w * 2 + 1, 1); }
  }
  function line(c, x0, y0, x1, y1, col, size = 2) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    c.fillStyle = col;
    for (;;) {
      c.fillRect(x0, y0, size, size);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // ---------- static background ----------
  function plant(c, x, y) {
    R(c, x + 1, y + 10, 10, 8, '#b5651d'); R(c, x, y + 9, 12, 2, '#d28a3a'); R(c, x + 1, y + 16, 10, 2, '#8a4a14');
    R(c, x + 4, y, 4, 10, '#2f8f4e'); R(c, x, y + 3, 5, 6, '#3fae60'); R(c, x + 7, y + 2, 5, 7, '#3fae60');
    R(c, x + 5, y + 1, 1, 7, '#64d98a'); R(c, x + 1, y + 4, 1, 3, '#64d98a'); R(c, x + 9, y + 3, 1, 4, '#64d98a');
  }

  function buildBackground() {
    const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
    const c = bg.getContext('2d');
    // floor
    for (let ty = 0; ty < 13; ty++) for (let tx = 0; tx < 24; tx++) {
      const y = 40 + ty * 16;
      R(c, tx * 16, y, 16, 16, (tx + ty) % 2 ? '#d6cbb5' : '#cdc1a9');
      R(c, tx * 16, y, 16, 1, '#bdb199'); R(c, tx * 16, y, 1, 16, '#bdb199');
    }
    R(c, 0, 40, W, 4, 'rgba(0,0,0,.18)'); R(c, 0, 44, W, 2, 'rgba(0,0,0,.08)');
    // wall
    R(c, 0, 0, W, 40, '#6c7aa3'); R(c, 0, 0, W, 4, '#4b5675');
    for (let x = 0; x < W; x += 16) R(c, x, 4, 1, 24, '#6574a0');
    R(c, 0, 28, W, 1, '#8f9cc2'); R(c, 0, 29, W, 9, '#4f5b80'); R(c, 0, 38, W, 2, '#2b3149');
    for (let x = 0; x < W; x += 16) R(c, x, 29, 1, 9, '#47527a');
    // windows
    for (const x of [20, 108, 196]) {
      R(c, x - 1, 7, 42, 26, '#2b3149'); R(c, x, 8, 40, 24, '#eef1f8');
      R(c, x + 2, 10, 17, 20, '#8ec9ff'); R(c, x + 21, 10, 17, 20, '#8ec9ff');
      R(c, x + 2, 24, 17, 6, '#a9dcff'); R(c, x + 21, 24, 17, 6, '#a9dcff');
      R(c, x + 4, 14, 7, 2, '#fff'); R(c, x + 6, 12, 5, 2, '#fff'); R(c, x + 25, 17, 8, 2, '#fff'); R(c, x + 27, 15, 5, 2, '#fff');
      R(c, x - 2, 33, 44, 3, '#cdd3e6'); R(c, x - 2, 36, 44, 1, '#8a93b0');
    }
    // clock
    disc(c, 278, 16, 8, '#2b3149'); disc(c, 278, 16, 7, '#f5f5f0');
    R(c, 278, 11, 1, 6, '#222'); R(c, 278, 16, 4, 1, '#222'); R(c, 278, 16, 1, 1, '#e5484d');
    // poster
    R(c, 296, 7, 20, 24, '#2b3149'); R(c, 297, 8, 18, 22, '#f2e6c8');
    R(c, 299, 10, 14, 8, '#3e8ef7'); R(c, 301, 13, 4, 5, '#30a46c'); R(c, 306, 12, 5, 6, '#f5a524');
    R(c, 299, 21, 14, 1, '#6b5b3a'); R(c, 299, 24, 10, 1, '#6b5b3a'); R(c, 299, 27, 12, 1, '#6b5b3a');
    // shelf with cups above coffee
    R(c, 326, 24, 54, 3, '#5e3d27'); R(c, 326, 27, 54, 1, '#3a2515');
    R(c, 330, 19, 5, 5, '#f5f5f0'); R(c, 335, 20, 1, 3, '#f5f5f0'); R(c, 340, 19, 5, 5, '#e93d82'); R(c, 345, 20, 1, 3, '#e93d82');
    R(c, 362, 17, 6, 7, '#12a594'); R(c, 370, 19, 5, 5, '#f5a524');
    // rug under coffee corner
    R(c, 318, 76, 66, 36, '#7d3f46'); R(c, 320, 78, 62, 32, '#a45560'); R(c, 324, 82, 54, 24, '#8d4650');
    for (let x = 326; x < 376; x += 6) R(c, x, 84, 3, 20, '#a45560');
    // coffee counter
    R(c, 324, 46, 58, 6, '#ead2a8'); R(c, 324, 46, 58, 1, '#fff0d2'); R(c, 324, 52, 58, 19, '#7a5236'); R(c, 324, 70, 58, 2, '#4a2f1d');
    for (const x of [324, 343, 362, 381]) R(c, x, 54, 1, 15, '#5e3d27');
    R(c, 330, 58, 3, 1, '#e5c07a'); R(c, 349, 58, 3, 1, '#e5c07a'); R(c, 368, 58, 3, 1, '#e5c07a');
    // coffee machine
    R(c, 331, 28, 20, 4, '#242833'); R(c, 332, 32, 18, 15, '#3a3f4f'); R(c, 332, 32, 18, 1, '#555c70');
    R(c, 335, 35, 3, 3, '#ff5a5a'); R(c, 340, 35, 3, 3, '#5ff2a5');
    R(c, 337, 40, 8, 3, '#1b1e27'); R(c, 340, 43, 2, 3, '#999');
    R(c, 336, 46, 10, 1, '#1b1e27'); R(c, 340, 43, 5, 5, '#f5f5f0');
    // kettle + mugs
    R(c, 355, 36, 9, 10, '#c8ccd8'); R(c, 355, 36, 9, 2, '#e6e9f2'); R(c, 364, 38, 2, 5, '#9aa0b4'); R(c, 357, 34, 5, 2, '#444');
    R(c, 369, 42, 5, 4, '#e5484d'); R(c, 375, 42, 5, 4, '#3e8ef7');
    // plants
    plant(c, 6, 50); plant(c, 6, 220); plant(c, 368, 218); plant(c, 306, 48);
    // sign
    R(c, 346, 8, 22, 9, '#2b3149'); R(c, 347, 9, 20, 7, '#f5c542');
    R(c, 350, 11, 6, 4, '#7a5236'); R(c, 356, 12, 2, 2, '#7a5236'); R(c, 360, 11, 1, 4, '#7a5236'); R(c, 362, 11, 3, 1, '#7a5236'); R(c, 362, 13, 3, 1, '#7a5236');
    return bg;
  }

  // ---------- characters ----------
  function drawHead(c, cx, top, look, face) {
    face = face || {};
    const skin = look.skin, dark = shade(skin, -40);
    const hair = look.hair, hairD = shade(hair, -25);
    const style = look.hairStyle;
    if (style === 'long') R(c, cx - 8, top + 1, 16, 12, hairD); // back hair
    R(c, cx - 6, top, 12, 11, skin);
    R(c, cx - 7, top + 4, 1, 3, dark); R(c, cx + 6, top + 4, 1, 3, dark);
    const m = face.mood || 'normal';
    const lk = face.look || 0;
    if (m === 'yawn') { R(c, cx - 3, top + 6, 2, 1, '#222'); R(c, cx + 1, top + 6, 2, 1, '#222'); R(c, cx - 4, top + 5, 1, 1, '#222'); R(c, cx + 3, top + 5, 1, 1, '#222'); }
    else if (m === 'read') { R(c, cx - 3, top + 7, 2, 1, '#222'); R(c, cx + 1, top + 7, 2, 1, '#222'); R(c, cx - 3, top + 6, 2, 1, shade(skin, -30)); R(c, cx + 1, top + 6, 2, 1, shade(skin, -30)); }
    else if (face.blink && m === 'normal') { R(c, cx - 3 + lk, top + 6, 2, 1, '#222'); R(c, cx + 1 + lk, top + 6, 2, 1, '#222'); }
    else if (m === 'happy') { R(c, cx - 3, top + 5, 2, 1, '#222'); R(c, cx - 4, top + 6, 1, 1, '#222'); R(c, cx - 2, top + 6, 1, 1, '#222');
      R(c, cx + 1, top + 5, 2, 1, '#222'); R(c, cx, top + 6, 1, 1, '#222'); R(c, cx + 3, top + 6, 1, 1, '#222'); }
    else if (m === 'worried') { R(c, cx - 3, top + 5, 2, 3, '#222'); R(c, cx + 1, top + 5, 2, 3, '#222'); R(c, cx - 3, top + 3, 3, 1, '#222'); R(c, cx + 1, top + 3, 3, 1, '#222'); }
    else { R(c, cx - 3 + lk, top + 5, 2, 2, '#222'); R(c, cx + 1 + lk, top + 5, 2, 2, '#222'); R(c, cx - 3 + lk, top + 5, 1, 1, '#fff'); R(c, cx + 1 + lk, top + 5, 1, 1, '#fff'); }
    R(c, cx - 5, top + 8, 2, 1, shade('#e07a6a', 0)); R(c, cx + 3, top + 8, 2, 1, '#e07a6a'); // blush
    if (m === 'happy') { R(c, cx - 2, top + 9, 4, 1, '#7a2a2a'); R(c, cx - 3, top + 8, 1, 1, '#7a2a2a'); R(c, cx + 2, top + 8, 1, 1, '#7a2a2a'); }
    else if (m === 'worried') { R(c, cx - 1, top + 8, 2, 2, '#5a1a1a'); }
    else if (m === 'yawn') { R(c, cx - 2, top + 8, 4, 3, '#5a1a1a'); R(c, cx - 1, top + 10, 2, 1, '#c0544a'); }
    else if (m === 'read') R(c, cx - 1, top + 9, 2, 1, '#8a4a3a');
    else R(c, cx - 1 + lk, top + 9, 2, 1, '#8a4a3a');
    // hair on top
    switch (style) {
      case 'long':
        R(c, cx - 7, top - 2, 14, 5, hair); R(c, cx - 7, top + 3, 2, 12, hair); R(c, cx + 5, top + 3, 2, 12, hair);
        R(c, cx - 6, top + 2, 6, 2, hair); R(c, cx - 5, top - 2, 4, 1, shade(hair, 35)); break;
      case 'spiky':
        R(c, cx - 7, top - 1, 14, 4, hair); R(c, cx - 7, top + 3, 1, 3, hair); R(c, cx + 6, top + 3, 1, 3, hair);
        for (const sx of [-7, -3, 1, 5]) R(c, cx + sx, top - 4, 2, 3, hair); R(c, cx - 2, top - 5, 2, 1, hair); R(c, cx - 3, top - 1, 3, 1, shade(hair, 35)); break;
      case 'bun':
        R(c, cx - 7, top - 2, 14, 5, hair); R(c, cx - 7, top + 3, 2, 3, hair); R(c, cx + 5, top + 3, 2, 3, hair);
        R(c, cx - 3, top - 6, 6, 4, hair); R(c, cx - 2, top - 5, 2, 1, shade(hair, 35)); R(c, cx - 6, top + 2, 5, 1, hair); break;
      case 'cap':
        R(c, cx - 7, top - 3, 14, 6, look.shirt); R(c, cx - 5, top - 3, 5, 1, shade(look.shirt, 40));
        R(c, cx - 9, top + 2, 18, 2, shade(look.shirt, -35)); R(c, cx - 7, top + 3, 1, 4, hair); R(c, cx + 6, top + 3, 1, 4, hair); break;
      default: // short
        R(c, cx - 7, top - 2, 14, 5, hair); R(c, cx - 7, top + 3, 2, 3, hair); R(c, cx + 5, top + 3, 2, 3, hair);
        R(c, cx - 6, top + 2, 5, 1, hair); R(c, cx - 5, top - 2, 5, 1, shade(hair, 35));
    }
  }

  // arm: shoulder -> elbow -> hand; the last bit is skin
  function arm(c, sx, sy, hx, hy, look, side) {
    const ex = sx + side * 2, ey = (sy + hy) / 2 + 2;
    const ac = shade(look.shirt, -22);
    line(c, sx, sy, ex, ey, ac, 2);
    line(c, ex, ey, hx, hy - 1, ac, 2);
    R(c, hx - 1, hy - 1, 3, 3, look.skin);
  }

  function bmp(c, x, y, rows, col) {
    c.fillStyle = col;
    rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') c.fillRect(x + i, y + j, 1, 1); });
  }
  const SYMS = [
    null, // dots (drawn with rects)
    { rows: ['..#..', '..#..', '..#..', '..#..', '.....', '..#..'], col: '#e5484d' },
    { rows: ['.###.', '#...#', '...#.', '..#..', '.....', '..#..'], col: '#3e8ef7' },
    { rows: ['.#.#.', '#####', '#####', '.###.', '..#..'], col: '#e93d82' },
    { rows: ['...##', '...#.', '...#.', '##.#.', '##...'], col: '#8e4ec6' },
  ];
  /** Small speech-bubble icon (used while two idle agents chat). */
  function drawTalk(c, x, y, sym, dir) {
    const o = '#2b2f3b';
    R(c, x - 7, y - 11, 14, 11, o); R(c, x - 8, y - 10, 16, 9, o); R(c, x - 6, y - 10, 12, 9, '#fff'); R(c, x - 7, y - 9, 14, 7, '#fff');
    R(c, x - 2 + dir * 2, y, 3, 2, o); R(c, x - 1 + dir * 2, y - 1, 1, 2, '#fff');
    if (sym === 0) { for (let i = 0; i < 3; i++) R(c, x - 5 + i * 4, y - 6, 2, 2, o); }
    else { const d = SYMS[sym]; bmp(c, x - 2, y - 9 + (d.rows.length < 6 ? 1 : 0), d.rows, d.col); }
  }

  function stateIcon(c, cx, top, state, t) {
    if (state === 'thinking') {
      R(c, cx - 11, top - 14, 22, 11, '#2b2f3b'); R(c, cx - 12, top - 13, 24, 9, '#2b2f3b');
      R(c, cx - 10, top - 13, 20, 9, '#fff'); R(c, cx - 11, top - 12, 22, 7, '#fff');
      R(c, cx - 3, top - 4, 4, 3, '#2b2f3b'); R(c, cx - 2, top - 4, 2, 2, '#fff'); R(c, cx - 1, top - 2, 2, 2, '#2b2f3b');
      const k = Math.floor(t * 3) % 4;
      for (let i = 0; i < 3; i++) R(c, cx - 6 + i * 5, top - 10, 3, 3, i < k ? '#5b4bc4' : '#c3bde8');
    } else if (state === 'done') {
      const b = Math.floor(Math.abs(Math.sin(t * 6)) * 3);
      const y = top - 9 - b;
      disc(c, cx, y, 6, '#1f5a3d'); disc(c, cx, y, 5, '#30a46c');
      const ck = [[-3, 0], [-2, 1], [-1, 2], [0, 1], [1, 0], [2, -1], [3, -2], [4, -3]];
      for (const [dx, dy] of ck) R(c, cx + dx - 1, y + dy - 0, 2, 2, '#fff');
      const ph = Math.floor(t * 5) % 2;
      for (const [dx, dy] of [[-14, -2], [14, -4], [-12, 8], [13, 9]]) {
        const s = ph ? 1 : 0; const x = cx + dx, yy = top + dy;
        R(c, x - 1 - s, yy, 3 + s * 2, 1, '#ffd84a'); R(c, x, yy - 1 - s, 1, 3 + s * 2, '#ffd84a');
      }
    } else if (state === 'error') {
      const j = Math.floor(t * 6) % 2;
      R(c, cx - 6, top - 16 - j, 12, 14, '#7a1a20'); R(c, cx - 5, top - 15 - j, 10, 12, '#fff');
      R(c, cx - 1, top - 13 - j, 3, 6, '#e5484d'); R(c, cx - 1, top - 6 - j, 3, 2, '#e5484d');
      R(c, cx - 1, top - 3 - j, 2, 2, '#7a1a20');
    }
  }

  function drawMonitor(c, cx, cy, state, t, ph, color) {
    const x0 = cx + 12, y0 = cy - 23;
    R(c, cx + 11, cy - 24, 16, 14, '#2b2f3b'); R(c, cx + 11, cy - 24, 16, 1, '#4a4f61');
    R(c, cx + 17, cy - 10, 4, 4, '#3a3f4f'); R(c, cx + 14, cy - 7, 10, 2, '#2b2f3b');
    if (state === 'working') {
      R(c, x0, y0, 14, 12, '#0e1f1a');
      const tick = Math.floor(t * 6 + ph * 5);
      for (let i = 0; i < 4; i++) {
        const w = 3 + Math.floor(rnd(tick + i * 7) * 9);
        R(c, x0 + 1 + (i % 2), y0 + 1 + i * 3, Math.min(w, 11), 1, i % 2 ? '#7fd6ff' : '#5ff2a5');
      }
      if (Math.floor(t * 18 + ph) % 6 === 0) R(c, x0, y0, 14, 12, 'rgba(255,255,255,.18)');
      c.globalAlpha = 0.16; R(c, cx + 8, cy - 7, 20, 13, '#7fd6ff'); c.globalAlpha = 1;
    } else if (state === 'thinking') {
      R(c, x0, y0, 14, 12, '#1d2a44');
      const k = Math.floor(t * 3) % 4;
      for (let i = 0; i < 3; i++) R(c, x0 + 3 + i * 3, y0 + 5, 2, 2, i < k ? '#b7a8ff' : '#33446a');
    } else if (state === 'done') {
      R(c, x0, y0, 14, 12, '#143d2a');
      for (const [dx, dy] of [[3, 6], [4, 7], [5, 8], [6, 7], [7, 6], [8, 5], [9, 4]]) R(c, x0 + dx, y0 + dy - 1, 2, 2, '#6be39b');
    } else if (state === 'error') {
      R(c, x0, y0, 14, 12, Math.floor(t * 4) % 2 ? '#4a1218' : '#6a1a22');
      R(c, x0 + 6, y0 + 2, 2, 5, '#fff'); R(c, x0 + 6, y0 + 8, 2, 2, '#fff');
    } else if (state === 'off') {
      R(c, x0, y0, 14, 12, '#10131c'); R(c, x0 + 1, y0 + 1, 4, 1, '#2a3040'); R(c, x0 + 1, y0 + 2, 2, 1, '#2a3040');
    } else { // idle
      R(c, x0, y0, 14, 12, '#1d2a44');
      for (const [i, w] of [[0, 8], [1, 5], [2, 9]]) R(c, x0 + 1, y0 + 1 + i * 3, w, 1, '#3a5a8a');
      if (Math.floor(t * 1.6 + ph) % 2) R(c, x0 + 1, y0 + 10, 2, 1, '#9fe8ff');
    }
    R(c, cx + 25, cy - 11, 1, 1, color || '#5ff2a5'); // power led
  }

  function drawSeat(c, slot, ag, t) {
    const { cx, cy } = slot;
    R(c, cx - 9, cy - 28, 18, 18, '#343a50'); R(c, cx - 8, cy - 27, 16, 2, '#4d5575'); R(c, cx - 9, cy - 10, 18, 3, '#2a2f42');
    const here = ag && !ag.away;
    const st = ag ? ag.state : 'off';
    const ph = ag ? ag.phase : 0;
    let mood = st === 'error' ? 'worried' : st === 'done' ? 'happy' : 'normal';
    const act = here && st === 'idle' && ag.act ? ag.act : null;
    const ap = ag && ag.actP || 0;
    let lk = 0, k = 0;
    if (act === 'look') lk = [0, -1, -1, 0, 1, 1][Math.floor(ap / 0.9) % 6];
    if (act === 'stretch') { k = Math.min(ap / 0.5, 1) * (ap < 2.4 ? 1 : Math.max(0, (2.9 - ap) / 0.5)); if (k > 0.5) mood = 'yawn'; }
    if (act === 'read') mood = 'read';
    let by = 0;
    if (here) {
      if (st === 'idle') by = Math.sin(t * 2.2 + ph * 6) >= 0 ? 1 : 0;
      else if (st === 'done') by = -Math.floor(Math.abs(Math.sin(t * 6)) * 2);
      else if (st === 'working') by = Math.floor(t * 6 + ph) % 4 === 0 ? 1 : 0;
      else if (st === 'thinking') by = Math.sin(t * 1.5 + ph * 6) >= 0.4 ? 1 : 0;
      if (act === 'stretch') by = -Math.round(k);
      if (act === 'read') by = 1;
      const blink = ((t * 1000 + ph * 3600) % 3600) < 140;
      const look = ag.look;
      R(c, cx - 7, cy - 24 + by, 14, 20, look.shirt); R(c, cx - 7, cy - 14 + by, 14, 1, shade(look.shirt, -30));
      R(c, cx - 2, cy - 25 + by, 4, 2, shade(look.skin, -25));
      drawHead(c, cx + lk, cy - 35 + by, look, { blink, mood, look: lk });
    }
    // desk
    R(c, cx - 28, cy - 7, 56, 14, '#b98a56'); R(c, cx - 28, cy - 7, 56, 1, '#dcae74'); R(c, cx - 28, cy + 6, 56, 1, '#8c6339');
    R(c, cx - 28, cy + 7, 56, 12, '#8c6339'); R(c, cx - 28, cy + 7, 56, 1, '#6e4b28');
    R(c, cx - 28, cy + 19, 3, 3, '#5e3f22'); R(c, cx + 25, cy + 19, 3, 3, '#5e3f22');
    R(c, cx - 6, cy + 9, 12, 8, '#7a5230'); R(c, cx - 5, cy + 10, 10, 6, '#946236'); R(c, cx - 1, cy + 12, 2, 1, '#e5c07a');
    R(c, cx - 28, cy + 22, 56, 2, 'rgba(0,0,0,.14)');
    if (ag) R(c, cx - 24, cy + 10, 9, 3, ag.look.shirt);
    // keyboard + mug
    R(c, cx - 8, cy - 1, 16, 5, '#cfd3df'); R(c, cx - 8, cy + 3, 16, 1, '#9aa0b4');
    for (let i = 0; i < 7; i++) { R(c, cx - 7 + i * 2, cy, 1, 1, '#8a90a6'); R(c, cx - 7 + i * 2, cy + 2, 1, 1, '#8a90a6'); }
    R(c, cx - 24, cy - 4, 5, 5, '#f5f5f0'); R(c, cx - 19, cy - 3, 1, 3, '#f5f5f0'); R(c, cx - 24, cy - 4, 5, 1, '#5b3a1e');
    if (here && (st === 'working' || st === 'thinking') && ag.slot % 2 === 0) { /* steam */
      const s = Math.floor(t * 3) % 2; R(c, cx - 22 + s, cy - 7, 1, 2, 'rgba(255,255,255,.7)'); }
    if (!ag) R(c, cx - 25, cy - 3, 8, 1, 'rgba(0,0,0,.0)');
    if (here) {
      const look = ag.look;
      const kb = { lx: cx - 4, rx: cx + 4, y: cy + 2 };
      let L = [kb.lx, kb.y], Rr = [kb.rx, kb.y];
      if (st === 'working') {
        const f = Math.floor(t * 10 + ph * 3);
        L = [kb.lx - (f % 3 === 0 ? 1 : 0), kb.y + (f % 2)]; Rr = [kb.rx + (f % 3 === 1 ? 1 : 0), kb.y + ((f + 1) % 2)];
      } else if (st === 'thinking') { Rr = [cx + 3, cy - 21 + by]; }
      else if (st === 'done') { const b = Math.floor(Math.abs(Math.sin(t * 6)) * 3); L = [cx - 12, cy - 32 - b]; Rr = [cx + 12, cy - 32 - b]; }
      else if (st === 'error') { const j = Math.floor(t * 8) % 2; L = [cx - 8 - j, cy - 30]; Rr = [cx + 8 + j, cy - 30]; }
      if (act === 'stretch') {
        L = [kb.lx + (cx - 13 - kb.lx) * k, kb.y + (cy - 39 - kb.y) * k]; Rr = [kb.rx + (cx + 13 - kb.rx) * k, kb.y + (cy - 39 - kb.y) * k];
      } else if (act === 'read') { L = [cx - 9, cy - 11]; Rr = [cx + 9, cy - 11]; }
      arm(c, cx - 7, cy - 21 + by, L[0], L[1], look, -1);
      arm(c, cx + 6, cy - 21 + by, Rr[0], Rr[1], look, 1);
      if (act === 'read') {
        const cov = ['#8e4ec6', '#3e8ef7', '#e5484d', '#30a46c'][ag.slot % 4], by2 = by;
        R(c, cx - 8, cy - 20 + by2, 16, 11, cov); R(c, cx - 7, cy - 19 + by2, 7, 8, '#fffbe8'); R(c, cx, cy - 19 + by2, 7, 8, '#fffbe8');
        R(c, cx - 1, cy - 19 + by2, 2, 8, '#d9cfa8');
        const pg = Math.floor(ap / 2.2) % 3;
        for (let i = 0; i < 3; i++) { R(c, cx - 6, cy - 18 + by2 + i * 2 + 1, 4 + ((i + pg) % 2), 1, '#9a8f6a'); R(c, cx + 2, cy - 18 + by2 + i * 2 + 1, 4 - ((i + pg) % 2), 1, '#9a8f6a'); }
        if ((ap % 2.2) < 0.25) { R(c, cx + 1, cy - 19 + by2, 3, 8, '#e9e0bd'); R(c, cx + 3, cy - 20 + by2, 1, 9, '#cfc59a'); }
        R(c, cx - 8, cy - 10 + by2, 16, 1, shade(cov, -40));
      }
    }
    drawMonitor(c, cx, cy, ag ? (ag.away ? 'idle' : st) : 'off', t, ph, ag && ag.look.shirt);
    if (here) stateIcon(c, cx, cy - 35 + by, st, t);
  }

  function drawStanding(c, ag, t) {
    const x = Math.round(ag.x), fy = Math.round(ag.y), look = ag.look;
    const walking = ag.mode === 'walk';
    const ph = walking ? Math.floor(t * 6) % 2 : 0;
    R(c, x - 7, fy - 1, 14, 2, 'rgba(0,0,0,.18)');
    R(c, x - 5, fy - 10, 4, 9 - (ph ? 1 : 0), look.pants); R(c, x + 1, fy - 10, 4, 9 - (ph ? 0 : 1), look.pants);
    R(c, x - 5, fy - 2 - (ph ? 1 : 0), 5, 2, '#222'); R(c, x + 1, fy - 2 - (ph ? 0 : 1), 5, 2, '#222');
    R(c, x - 7, fy - 24, 14, 15, look.shirt); R(c, x - 7, fy - 11, 14, 1, shade(look.shirt, -30));
    R(c, x - 2, fy - 25, 4, 2, shade(look.skin, -25));
    const blink = ((t * 1000 + ag.phase * 3600) % 3600) < 140;
    const mood = ag.state === 'error' ? 'worried' : (ag.mode === 'drink' || ag.mode === 'chat') ? 'happy' : 'normal';
    const nod = ag.mode === 'chat' && ag.talk == null && Math.floor(t * 3) % 4 === 0 ? 1 : 0;
    drawHead(c, x, fy - 36 + nod, look, { blink, mood });
    const sw = walking ? (ph ? 1 : -1) : 0;
    if (ag.mode === 'drink') {
      const sip = Math.floor(t * 1.5) % 2;
      arm(c, x - 7, fy - 22, x - 9, fy - 12, look, -1);
      const hx = x + 6, hy = fy - 22 - (sip ? 3 : 0);
      arm(c, x + 6, fy - 22, hx, hy, look, 1);
      R(c, hx - 2, hy - 5, 5, 5, '#f5f5f0'); R(c, hx + 3, hy - 4, 1, 3, '#f5f5f0'); R(c, hx - 2, hy - 5, 5, 1, '#5b3a1e');
      const s = Math.floor(t * 4) % 2; R(c, hx - 1 + s, hy - 8, 1, 2, 'rgba(255,255,255,.8)');
    } else if (ag.mode === 'chat' && ag.talk != null) {
      const g = Math.floor(t * 4) % 2;
      arm(c, x - 7, fy - 22, x - 9, fy - 12, look, -1);
      arm(c, x + 6, fy - 22, x + 9 + (ag.talkDir > 0 ? 1 : -3), fy - 28 - g * 2, look, 1);
    } else {
      arm(c, x - 7, fy - 22, x - 9, fy - 12 + sw, look, -1);
      arm(c, x + 6, fy - 22, x + 8, fy - 12 - sw, look, 1);
    }
    stateIcon(c, x, fy - 36, ag.state, t);
    if (ag.mode === 'chat' && ag.talk != null) drawTalk(c, x + ag.talkDir * 6, fy - 40, ag.talk, ag.talkDir);
  }

  function dashedRect(c, x, y, w, h, col, t) {
    const off = Math.floor(t * 8);
    c.fillStyle = col;
    for (let i = 0; i < w; i++) if (((i + off) >> 1) % 2 === 0) { c.fillRect(x + i, y, 1, 1); c.fillRect(x + w - 1 - i, y + h - 1, 1, 1); }
    for (let i = 0; i < h; i++) if (((i + off) >> 1) % 2 === 0) { c.fillRect(x, y + h - 1 - i, 1, 1); c.fillRect(x + w - 1, y + i, 1, 1); }
  }

  // ---------- overlay text ----------
  const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  function wrap(ctx, text, maxW) {
    const out = []; let cur = '';
    for (const word of text.split(/\s+/)) {
      if (!word) continue;
      const test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width <= maxW) { cur = test; continue; }
      if (cur) out.push(cur);
      let w = word;
      while (ctx.measureText(w).width > maxW) { let i = w.length; while (i > 1 && ctx.measureText(w.slice(0, i)).width > maxW) i--; out.push(w.slice(0, i)); w = w.slice(i); }
      cur = w;
    }
    if (cur) out.push(cur);
    return out;
  }

  function pillText(ctx, text, x, y, U, fg, bg, bold) {
    ctx.font = `${bold ? 'bold ' : ''}${Math.round(11 * U)}px ${FONT}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const w = Math.ceil(ctx.measureText(text).width);
    const h = Math.round(15 * U), pad = Math.round(5 * U);
    ctx.fillStyle = bg; ctx.fillRect(Math.round(x - w / 2 - pad), Math.round(y - h / 2), w + pad * 2, h);
    ctx.fillStyle = fg; ctx.fillText(text, Math.round(x - w / 2), Math.round(y + U * 0.5));
    return w + pad * 2;
  }

  function measurePill(ctx, text, U, bold) {
    ctx.font = `${bold ? 'bold ' : ''}${Math.round(11 * U)}px ${FONT}`;
    return Math.ceil(ctx.measureText(text).width) + Math.round(5 * U) * 2;
  }
  const TYPE_BADGE = {
    claude: { text: 'Claude', bg: '#d97757', fg: '#2a1208' },
    cursor: { text: 'Cursor', bg: '#e6e8f5', fg: '#14151f' },
    mock: { text: 'Mock', bg: '#5a5f7a', fg: '#fff' },
  };

  function drawBubble(ctx, text, cx, bottom, S, U, W2) {
    ctx.font = `${Math.round(11 * U)}px ${FONT}`;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const maxW = Math.max(120 * U, 46 * S);
    let lines = wrap(ctx, text, maxW);
    const maxLines = 4;
    if (lines.length > maxLines) { lines = lines.slice(-maxLines); lines[0] = '…' + lines[0]; }
    const lh = Math.round(14 * U), pad = Math.round(6 * U), bw2 = Math.round(2 * U);
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2;
    const h = lines.length * lh + pad * 2;
    let x = Math.round(cx - w / 2); x = Math.max(4, Math.min(W2 - w - 4, x));
    const y = Math.round(bottom - h);
    ctx.fillStyle = '#2b2f3b'; ctx.fillRect(x - bw2, y - bw2, w + bw2 * 2, h + bw2 * 2);
    ctx.fillStyle = '#fffbe8'; ctx.fillRect(x, y, w, h);
    // blocky tail
    const tx = Math.round(Math.max(x + 8 * U, Math.min(x + w - 12 * U, cx)));
    for (let i = 0; i < 3; i++) {
      const tw = Math.round((6 - i * 2) * U);
      ctx.fillStyle = '#2b2f3b'; ctx.fillRect(tx - tw / 2 - bw2, y + h + i * bw2 * 1.5, tw + bw2 * 2, bw2 * 1.5 + 1);
      ctx.fillStyle = '#fffbe8'; ctx.fillRect(tx - tw / 2, y + h + i * bw2 * 1.5 - (i === 0 ? bw2 : 0), tw, bw2 * 1.5 + (i === 0 ? bw2 : 0));
    }
    ctx.fillStyle = '#2b2f3b';
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * lh));
  }

  const STATE_COL = { idle: '#8b90ad', thinking: '#b7a8ff', working: '#7fd6ff', done: '#6be39b', error: '#ff6b70' };

  // ---------- main ----------
  const bg = buildBackground();
  const logical = document.createElement('canvas'); logical.width = W; logical.height = H;
  const lc = logical.getContext('2d');

  /** scene: {t, entries:[{id,name,slot,look,state,tool,phase,away,x,y,mode,bubble}], selectedId, hoverId, hoverSlot} */
  function render(canvas, S, U, scene) {
    const t = scene.t;
    lc.drawImage(bg, 0, 0);
    // steam over the coffee machine
    for (let i = 0; i < 3; i++) {
      const p = ((t * 8 + i * 4) % 12);
      lc.globalAlpha = 0.6 * (1 - p / 12); R(lc, 341 + Math.sin(t * 2 + i * 2) * 1.5, 38 - p, 2, 2, '#fff');
    }
    lc.globalAlpha = 1;
    const bySlot = {}; scene.entries.forEach((e) => { bySlot[e.slot] = e; });
    for (let i = 0; i < MAX_SLOTS; i++) drawSeat(lc, SLOTS[i], bySlot[i] || null, t);
    const away = scene.entries.filter((e) => e.away).sort((a, b) => a.y - b.y);
    for (const e of away) drawStanding(lc, e, t);
    // selection / hover outlines
    for (const e of scene.entries) {
      const s = SLOTS[e.slot];
      if (e.id === scene.selectedId) dashedRect(lc, s.cx - 33, s.cy - 42, 66, 70, '#f5c542', t);
      else if (e.id === scene.hoverId) dashedRect(lc, s.cx - 33, s.cy - 42, 66, 70, 'rgba(255,255,255,.7)', 0);
    }
    if (scene.hoverSlot != null && !bySlot[scene.hoverSlot]) { const s = SLOTS[scene.hoverSlot]; dashedRect(lc, s.cx - 33, s.cy - 42, 66, 70, 'rgba(95,242,165,.85)', 0); }

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(logical, 0, 0, W * S, H * S);

    // overlays
    for (const e of scene.entries) {
      const s = SLOTS[e.slot];
      const px = e.away ? e.x : s.cx, headTop = e.away ? e.y - 36 : s.cy - 35;
      const sel = e.id === scene.selectedId;
      const labY = (s.cy + 28) * S;
      const dotCol = STATE_COL[e.state] || '#999';
      const tb = TYPE_BADGE[e.type];
      const nameTxt = '   ' + e.name;
      const nw = measurePill(ctx, nameTxt, U, sel);
      const bw = tb ? measurePill(ctx, tb.text, U * 0.8, true) : 0;
      const gap = tb ? Math.round(3 * U) : 0;
      const left = s.cx * S - (nw + gap + bw) / 2;
      const w = pillText(ctx, nameTxt, left + nw / 2, labY, U, sel ? '#14151f' : '#fff', sel ? '#f5c542' : 'rgba(20,21,31,.85)', sel);
      ctx.fillStyle = dotCol; ctx.fillRect(Math.round(left + 5 * U), Math.round(labY - 3 * U), Math.round(5 * U), Math.round(5 * U));
      if (tb) pillText(ctx, tb.text, left + nw + gap + bw / 2, labY, U * 0.8, tb.fg, tb.bg, true);
      if (e.state === 'working' && e.tool) pillText(ctx, e.tool, (s.cx + 20) * S, (s.cy - 29) * S, U * 0.9, '#0e1f1a', '#5ff2a5', true);
      else if (e.state === 'working') pillText(ctx, 'typing…', (s.cx + 20) * S, (s.cy - 29) * S, U * 0.9, '#0e1f1a', '#5ff2a5', true);
      if (e.queued) pillText(ctx, '+' + e.queued + ' queued', s.cx * S, (s.cy + 38) * S, U * 0.85, '#14151f', '#f5c542', true);
      if (e.bubble) drawBubble(ctx, e.bubble, px * S, (headTop - 18) * S, S, U, canvas.width);
    }
    for (let i = 0; i < MAX_SLOTS; i++) if (!bySlot[i] && scene.hoverSlot === i) pillText(ctx, '＋ hire', SLOTS[i].cx * S, (SLOTS[i].cy + 28) * S, U, '#0e1f1a', '#5ff2a5', true);
  }

  function hitTest(lx, ly, entries) {
    const away = entries.filter((e) => e.away).sort((a, b) => b.y - a.y);
    for (const e of away) if (lx >= e.x - 10 && lx <= e.x + 10 && ly >= e.y - 38 && ly <= e.y + 2) return { id: e.id };
    for (let i = 0; i < MAX_SLOTS; i++) {
      const s = SLOTS[i];
      if (lx >= s.cx - 30 && lx <= s.cx + 30 && ly >= s.cy - 40 && ly <= s.cy + 24) {
        const e = entries.find((x) => x.slot === i);
        return e ? { id: e.id } : { slot: i };
      }
    }
    return null;
  }

  // Standing spots near the coffee machine: one sipper, or two chatters side by side.
  const SPOTS = { coffee: [{ x: COFFEE.x, y: COFFEE.y }], chat: [{ x: 336, y: 108 }, { x: 362, y: 108 }] };
  /** Path from a desk to a spot: out the side gap, along the aisle, then up to the spot. */
  function walkPath(slot, spot) {
    const s = SLOTS[slot], ay = AISLE[s.row];
    return [{ x: s.cx + 33, y: s.cy + 2 }, { x: s.cx + 38, y: ay }, { x: spot.x, y: ay }, { x: spot.x, y: spot.y }];
  }

  function drawAvatar(canvas, look) {
    const c = canvas.getContext('2d'); c.clearRect(0, 0, canvas.width, canvas.height);
    R(c, 3, 20, 14, 8, look.shirt); R(c, 8, 19, 4, 2, shade(look.skin, -25));
    drawHead(c, 10, 8, look, { mood: 'happy' });
  }

  window.OfficeFlat = { W, H, SLOTS, MAX_SLOTS, render, hitTest, walkPath, SPOTS, drawAvatar, COFFEE, AISLE,
    SPEED: 40, STEP: 0.5, // walking speed in world units/s (px here) and canvas scale step
    // helpers re-used by the isometric renderer
    shared: { R, shade, rnd, disc, line, bmp, stateIcon, drawTalk, pillText, measurePill, drawBubble, TYPE_BADGE, STATE_COL, dashedRect } };
})();
