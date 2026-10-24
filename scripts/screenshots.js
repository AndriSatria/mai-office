'use strict';
// Starts the server in mock mode on a scratch port + data file, drives the UI with
// Playwright (hire, chat, wander) and saves screenshots to ./screenshots.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = process.env.SHOT_PORT || 3111;
const DATA = path.join(os.tmpdir(), `vh-shots-${Date.now()}.json`);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, HARNESS_MODE: 'mock', HARNESS_DATA: DATA, HARNESS_DEFAULT_CWD: ROOT }, stdio: 'inherit' });
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
    for (const [name, cwd] of [['Ada', ROOT], ['Linus', ROOT], ['Grace', ROOT], ['Ken', ROOT]]) {
      await page.click('#hireBtn');
      await page.fill('#hireName', name); await page.fill('#hireCwd', cwd);
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
    console.log('final states', JSON.stringify(await states()));
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
    try { fs.unlinkSync(DATA); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
