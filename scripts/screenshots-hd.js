'use strict';
// HD screenshots of the isometric office: 1920x1080 viewport, deviceScaleFactor 2 -> 3840x2160 PNGs.
// The renderer sizes the canvas backing store in device pixels with a whole-number scale and
// imageSmoothingEnabled = false, so pixels stay sharp (this script asserts that before capturing).
// Usage: npm run screenshots:hd   ->  screenshots/hd/
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'hd');
const PORT = process.env.SHOT_PORT || 3112;
const DATA = path.join(os.tmpdir(), `mai-office-hd-${Date.now()}.json`);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teamShots = require('./team-shots');
const planShots = require('./plan-shots');
const { makeFakeClaudeDir } = require('./fake-claude-dir');
const FAKE = makeFakeClaudeDir();   // sessions browser shot: sample sessions only, never the real ~/.claude

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, HARNESS_MODE: 'mock', HARNESS_DATA: DATA, HARNESS_DEFAULT_CWD: ROOT,
    HARNESS_CLAUDE_DIR: FAKE.dir, HARNESS_CURSOR_DIR: FAKE.cursorDir, HARNESS_CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), HARNESS_CURSOR_BIN: path.join(__dirname, 'fake-cursor-agent.js') } });
  await sleep(1200);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name) }); console.log('saved', name); };
  const id = (n) => page.evaluate((n) => [...window.harness.agents.values()].find((x) => x.name === n).id, n);
  const waitState = (name, want, ms = 25000) => page.waitForFunction(([n, w]) => window.harness.states().some((a) => a.name === n && a.state === w), [name, want], { timeout: ms });
  const sendTo = async (name, text) => {
    await page.evaluate((n) => { const a = [...window.harness.agents.values()].find((x) => x.name === n); window.harness.select(a.id); }, name);
    await page.fill('#input', text); await page.press('#input', 'Enter');
  };
  const idle = (ms = 30000) => page.waitForFunction(() => window.harness.states().every((a) => !a.away && !a.act && (a.state === 'idle' || a.state === 'done')), null, { timeout: ms });

  try {
    await page.goto(`http://localhost:${PORT}/?wander=off`);
    await page.waitForSelector('#conn.on');
    for (const [name, type] of [['Ada', 'mock'], ['Linus', 'cursor'], ['Grace', 'claude'], ['Ken', 'mock'], ['Alan', 'mock']]) {
      await page.evaluate(([n, t, cwd]) => window.harness.send({ type: 'hire', name: n, cwd, agentType: t }), [name, type, ROOT]);
      await page.waitForFunction((n) => window.harness.states().some((a) => a.name === n), name);
      await sleep(150);
    }
    await page.evaluate(() => window.harness.select(null));
    await sleep(600);

    // sharpness check: backing store is in device pixels, scale is a whole number of device pixels
    const info = await page.evaluate(() => {
      const c = document.getElementById('office'), r = c.getBoundingClientRect(), O = window.Office;
      return { dpr: devicePixelRatio, backing: [c.width, c.height], css: [r.width, r.height], scale: c.width / O.W, scaleY: c.height / O.H,
        cssMatchesBacking: Math.abs(r.width * devicePixelRatio - c.width) < 0.5 && Math.abs(r.height * devicePixelRatio - c.height) < 0.5 };
    });
    console.log('canvas', JSON.stringify(info));
    if (!(info.dpr === 2 && Number.isInteger(info.scale) && info.scale === info.scaleY && info.cssMatchesBacking)) throw new Error('canvas is not pixel-exact at DPR 2: ' + JSON.stringify(info));

    // 1) everyone idle with varied activities (stretch / read / look around / coffee trip)
    await page.evaluate(() => {
      const by = (n) => [...window.harness.agents.values()].find((x) => x.name === n).id;
      window.harness.forceActivity(by('Ada'), 'stretch'); window.harness.forceActivity(by('Linus'), 'read');
      window.harness.forceActivity(by('Grace'), 'look'); window.harness.forceActivity(by('Ken'), 'coffee');
    });
    await sleep(1500);
    await shot('01-idle-office-hd.png');
    await page.waitForFunction(() => window.harness.states().every((a) => !a.away && !a.act), null, { timeout: 40000 });

    // 2) one agent working, chat panel open, tool chip over the monitor
    await sendTo('Ada', 'Refactor src/utils.js and run the tests, then summarise.');
    await waitState('Ada', 'working');
    await sleep(500);
    await shot('02-working-chat-tool-chip-hd.png');

    // 3) thinking + done-with-reply-bubble together: Ada finishes while Linus starts thinking
    await waitState('Ada', 'done');
    await sendTo('Linus', 'Write a haiku about the office coffee machine.');
    await page.evaluate((i) => window.harness.select(i), await id('Ada'));
    await waitState('Linus', 'thinking');
    await sleep(350);
    await shot('03-thinking-and-done-reply-bubble-hd.png');

    // 4) two idle agents chat by the coffee machine
    await waitState('Linus', 'done');
    await page.evaluate(() => window.harness.select(null));
    await idle(); await sleep(14500); // let the old reply bubbles expire (BUBBLE_TTL)
    await page.evaluate(() => {
      const by = (n) => [...window.harness.agents.values()].find((x) => x.name === n).id;
      window.harness.forceActivity(by('Grace'), 'chat', by('Alan'));
    });
    await page.waitForFunction(() => window.harness.states().filter((a) => a.mode === 'chat').length === 2, null, { timeout: 30000 });
    await sleep(1000);
    await shot('04-idle-chat-at-coffee-hd.png');

    // 5/6) parent with 3 parallel helpers mid-work, then a result handoff (envelope flying back, dotted links, "waiting on N helpers")
    await page.evaluate(() => window.harness.select(null));
    await idle();
    await teamShots(page, 'Ada', { mid: () => shot('05-team-code-review-4-helpers-hd.png'), peer: () => shot('06-team-peer-conversation-hd.png'),
      handoff: () => shot('08-team-result-handoff-hd.png'), huddle: () => shot('07-team-huddle-hd.png') }, sleep);

    // 9-12) manager desk + round table overview, monitors facing the people (close-up), plan mode gathering, plan ready + summary bubble
    await page.evaluate(() => window.harness.select(null));
    await idle();
    await planShots(page, 'Ken', { overview: () => shot('09-manager-desk-and-round-table-hd.png'),
      monitors: async (clip) => { await page.screenshot({ path: path.join(OUT, '10-monitors-face-the-people-hd.png'), clip }); console.log('saved 10-monitors-face-the-people-hd.png'); },
      gather: () => shot('11-plan-mode-gathering-hd.png'), ready: () => shot('12-plan-ready-summary-hd.png') }, sleep, ROOT);

    // 13) the Claude Code sessions browser (fake sessions), with free desks so "Resume in office" is live
    await idle();
    await page.evaluate(() => { const vs = [...window.harness.agents.values()].filter((a) => !a.main).slice(-2);
      for (const a of vs) window.harness.send({ type: 'fire', id: a.id }); window.harness.select(null); });
    await page.waitForFunction(() => window.harness.agents.size <= 5);
    await page.click('#sessBtn');
    await page.waitForSelector('#sessList .sessRow');
    await sleep(300);
    await shot('13-claude-sessions-browser-hd.png');

    // 16) same browser on the Cursor CLI tab (fake chats from the fake ~/.cursor)
    await page.click('#sessTab-cursor');
    await page.waitForFunction(() => document.querySelector('#sessList .sessRow') && /chats/.test(document.querySelector('#sessDir').textContent));
    await sleep(300);
    await shot('16-cursor-sessions-browser-hd.png');
    await page.click('#sessTab-claude');
    await page.waitForFunction(() => /projects/.test(document.querySelector('#sessDir').textContent) && document.querySelector('#sessList .sessRow'));

    // 14) "/" popup for a Claude agent working in a fake project (commands, skills and a plugin from the fake claude dir)
    await page.keyboard.press('Escape');
    await page.evaluate((cwd) => window.harness.send({ type: 'hire', name: 'Rin', cwd, agentType: 'claude' }), FAKE.cwds.shop);
    await page.waitForFunction(() => window.harness.states().some((a) => a.name === 'Rin'));
    await sendTo('Rin', 'Add a dark mode toggle to the settings page');
    await waitState('Rin', 'done');
    await page.focus('#input');
    await page.keyboard.type('/');
    await page.waitForSelector('#slashPop .slashItem');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await sleep(300);
    await shot('14-slash-commands-popup-hd.png');

    // 15) the mode line under the input: accept edits, then Shift+Tab -> plan, side by side
    await page.keyboard.press('Escape'); await page.fill('#input', '');
    const clipOf = async () => { const c = await page.locator('#chat').boundingBox(), f = await page.locator('#composer').boundingBox(); return { x: c.x, y: f.y - 24, width: c.width, height: f.height + 24 }; };
    const grab = async () => (await page.screenshot({ clip: await clipOf() })).toString('base64');
    const accept = await grab();
    await page.focus('#input'); await page.keyboard.press('Shift+Tab');
    await page.waitForSelector('#modeLine.plan');
    const plan = await grab();
    const cmp = await ctx.newPage();
    await cmp.setViewportSize({ width: 820, height: 200 });
    await cmp.setContent(`<body style="margin:0;background:#14151f;color:#e6e8f5;font:14px monospace;display:flex;gap:20px;padding:20px">
      ${[['Accept edits', accept], ['After Shift+Tab: plan', plan]].map(([t, b]) => `<figure style="margin:0"><figcaption style="margin-bottom:8px">${t}</figcaption><img style="width:380px;display:block" src="data:image/png;base64,${b}"></figure>`).join('')}</body>`);
    await cmp.screenshot({ path: path.join(OUT, '15-permission-mode-line-hd.png'), fullPage: true }); console.log('saved 15-permission-mode-line-hd.png');
    await cmp.close();

    // 17) a Cursor agent's mode line: default, then Shift+Tab -> plan -> ask (real CLI modes)
    await page.evaluate((cwd) => window.harness.send({ type: 'hire', name: 'Cy', cwd, agentType: 'cursor' }), FAKE.cwds.blog);
    await page.waitForFunction(() => window.harness.states().some((a) => a.name === 'Cy'));
    await page.evaluate(() => { const a = window.harness.states().find((x) => x.name === 'Cy'); window.harness.select(a.id); });
    await page.waitForSelector('#modeLine.default');
    const cDef = await grab();
    await page.focus('#input'); await page.keyboard.press('Shift+Tab'); await page.waitForSelector('#modeLine.plan');
    const cPlan = await grab();
    await page.keyboard.press('Shift+Tab'); await page.waitForSelector('#modeLine.ask');
    const cAsk = await grab();
    await page.keyboard.press('Shift+Tab'); await page.waitForSelector('#modeLine.default');   // back to default so the plan gathering isn't left running
    const cmp2 = await ctx.newPage();
    await cmp2.setViewportSize({ width: 1220, height: 200 });
    await cmp2.setContent(`<body style="margin:0;background:#14151f;color:#e6e8f5;font:14px monospace;display:flex;gap:20px;padding:20px">
      ${[['Cursor: default (no flag)', cDef], ['Shift+Tab: plan (--mode plan)', cPlan], ['Shift+Tab: ask (--mode ask)', cAsk]].map(([t, b]) => `<figure style="margin:0"><figcaption style="margin-bottom:8px">${t}</figcaption><img style="width:380px;display:block" src="data:image/png;base64,${b}"></figure>`).join('')}</body>`);
    await cmp2.screenshot({ path: path.join(OUT, '17-cursor-mode-line-hd.png'), fullPage: true }); console.log('saved 17-cursor-mode-line-hd.png');
    await cmp2.close();
  } finally {
    await browser.close(); srv.kill('SIGTERM');
    try { fs.unlinkSync(DATA); } catch (_) {}
    fs.rmSync(FAKE.base, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
