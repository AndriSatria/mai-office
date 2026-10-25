'use strict';
// Starts the server in mock mode on a scratch port + data file, drives the UI with
// Playwright (hire, chat, wander) and saves screenshots to ./screenshots.
// The default view is isometric; the last shot uses ?view=flat.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = process.env.SHOT_PORT || 3111;
const DATA = path.join(os.tmpdir(), `mai-office-shots-${Date.now()}.json`);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teamShots = require('./team-shots');

(async () => {
  // claude/cursor agents use the stand-in CLIs in scripts/ so every agent type can be demoed without installs
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, HARNESS_MODE: 'mock', HARNESS_DATA: DATA, HARNESS_DEFAULT_CWD: ROOT,
    HARNESS_CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), HARNESS_CURSOR_BIN: path.join(__dirname, 'fake-cursor-agent.js') }, stdio: 'inherit' });
  await sleep(1200);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name) }); console.log('saved', name); };
  const states = () => page.evaluate(() => window.harness.states());
  const waitState = (name, want, ms = 15000) => page.waitForFunction(([n, w]) => window.harness.states().some((a) => a.name === n && a.state === w), [name, want], { timeout: ms });
  const sendTo = async (name, text) => {
    await page.evaluate((n) => { const a = [...window.harness.agents.values()].find((x) => x.name === n); window.harness.select(a.id); }, name);
    await page.fill('#input', text); await page.press('#input', 'Enter');
  };

  try {
    await page.goto(`http://localhost:${PORT}/?wander=off`);
    await page.waitForSelector('#conn.on');
    await sleep(500);
    await shot('01-empty-office.png');

    // Hire agents through the real dialog
    for (const [name, cwd, type] of [['Ada', ROOT, 'mock'], ['Linus', ROOT, 'cursor'], ['Grace', ROOT, 'claude'], ['Ken', ROOT, 'mock']]) {
      await page.click('#hireBtn');
      await page.fill('#hireName', name); await page.fill('#hireCwd', cwd);
      await page.click(`.typeopt:has(input[value=${type}])`);
      if (name === 'Linus') await shot('12-hire-dialog-agent-type.png'); // dialog with the agent-type picker
      await page.click('#hireOk');
      await page.waitForFunction((n) => window.harness.states().some((a) => a.name === n), name);
    }
    await sleep(700);
    await shot('02-hired-idle.png');

    // Ada & Linus get work; Grace gets a task that fails; Ken stays idle
    await sendTo('Grace', 'please fail the build');
    await sendTo('Linus', 'Write a haiku about the office coffee machine.');
    await sendTo('Ada', 'Refactor src/utils.js and run the tests, then summarise.');
    await sleep(600);
    await shot('03-thinking.png');
    await waitState('Ada', 'working');
    await sleep(700);
    await shot('04-working-chat-open.png');
    await waitState('Grace', 'error');
    await sleep(500);
    await shot('05-error.png');
    // streamed reply + done
    await waitState('Ada', 'done', 25000);
    await page.evaluate((n) => { const a = [...window.harness.agents.values()].find((x) => x.name === n); window.harness.select(a.id); }, 'Ada');
    await sleep(500);
    await shot('06-done-with-reply-bubble.png');

    // Idle agent walks to the coffee corner
    await waitState('Linus', 'idle', 25000);
    await page.evaluate(() => { const a = [...window.harness.agents.values()].find((x) => x.name === 'Ken'); window.harness.forceWander(a.id); });
    await sleep(2200);
    await shot('07-wandering.png');
    await page.waitForFunction(() => window.harness.states().some((a) => a.name === 'Ken' && a.mode === 'drink'), null, { timeout: 15000 });
    await sleep(600);
    await shot('08-coffee-break.png');

    // Fire an agent
    await page.evaluate((n) => { const a = [...window.harness.agents.values()].find((x) => x.name === n); window.harness.select(a.id); }, 'Grace');
    await page.click('#fireBtn');
    await page.waitForFunction(() => !window.harness.states().some((a) => a.name === 'Grace'));
    await sleep(500);
    await shot('09-after-fire.png');
    // hovering an empty desk: green isometric outline + "hire" pill (real mouse through the canvas)
    {
      const box = await page.locator('#office').boundingBox();
      const [mx, my] = await page.evaluate((box) => { const O = window.Office; const [x, y] = O.deskPoint(5); return [box.x + (x / O.W) * box.width, box.y + (y / O.H) * box.height]; }, box);
      await page.mouse.move(mx, my); await sleep(300);
      await shot('14-hover-empty-desk.png');
      await page.mouse.move(5, 5);
    }

    // Team task: a parent spawns 3 parallel helpers (mock /team); then the result handoff in mid-air
    await page.evaluate(() => window.harness.select(null));
    await page.waitForFunction(() => window.harness.states().every((a) => !a.away && a.state !== 'working' && a.state !== 'thinking'), null, { timeout: 20000 });
    await teamShots(page, 'Ada', { mid: () => shot('15-team-code-review-4-helpers.png'), peer: () => shot('16-team-peer-conversation.png'),
      handoff: () => shot('18-team-result-handoff.png'), huddle: () => shot('17-team-huddle.png') }, sleep);
    // agent-to-agent: a letter flies from Ada to Ken
    await page.selectOption('#relayTo', { label: '→ Ken' });
    await page.fill('#input', 'can you review my diff?'); await page.press('#input', 'Enter');
    await page.waitForFunction(() => window.harness.flights().some((f) => f.kind === 'letter'), null, { timeout: 5000 });
    await sleep(520);
    await shot('19-agent-to-agent-letter.png');
    await waitState('Ken', 'done', 25000);
    await page.evaluate(() => window.harness.select(null));
    await sleep(500);

    // Idle variety: stretching, reading, looking around at the desks
    await page.evaluate(() => window.harness.select(null));
    await page.waitForFunction(() => window.harness.states().every((a) => !a.away), null, { timeout: 20000 });
    await page.evaluate(() => {
      const by = (n) => [...window.harness.agents.values()].find((x) => x.name === n).id;
      window.harness.forceActivity(by('Ada'), 'stretch'); window.harness.forceActivity(by('Linus'), 'read'); window.harness.forceActivity(by('Ken'), 'look');
    });
    await sleep(1300);
    await shot('10-idle-stretch-read-look.png');
    await page.waitForFunction(() => window.harness.states().every((a) => !a.act), null, { timeout: 20000 });

    // Two idle agents meet by the coffee machine and chat
    await page.evaluate(() => {
      const by = (n) => [...window.harness.agents.values()].find((x) => x.name === n).id;
      window.harness.forceActivity(by('Ada'), 'chat', by('Linus'));
    });
    await page.waitForFunction(() => window.harness.states().filter((a) => a.mode === 'chat').length === 2, null, { timeout: 20000 });
    await sleep(900);
    await shot('11-idle-chat-at-coffee.png');
    await sleep(1700);
    await shot('11b-idle-chat-reply.png');
    // The old top-down view is still available with ?view=flat
    const flat = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await flat.goto(`http://localhost:${PORT}/?wander=off&view=flat`);
    await flat.waitForSelector('#conn.on'); await sleep(800);
    await flat.screenshot({ path: path.join(OUT, '13-flat-view-fallback.png') }); console.log('saved 13-flat-view-fallback.png');
    await flat.close();
    console.log('final states', JSON.stringify(await states()));
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
    try { fs.unlinkSync(DATA); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
