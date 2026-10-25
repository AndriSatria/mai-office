'use strict';
// Records a ~35 s demo of the real running app (mock mode) with Playwright's recordVideo, then converts it to
// H.264 / yuv420p MP4 with ffmpeg -> demo/mai-office-demo.mp4.   Usage: npm run demo:video
// Env: DEMO_PORT (3113), DEMO_W/DEMO_H (1920x1080), DEMO_SLOW (pause multiplier, default 1; 1.5 = slower).
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'demo');
const OUT = path.join(OUT_DIR, 'mai-office-demo.mp4');
const PORT = process.env.DEMO_PORT || 3113;
const W = +process.env.DEMO_W || 1920, H = +process.env.DEMO_H || 1080;
const SLOW = +process.env.DEMO_SLOW || 1;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-demo-'));
const DATA = path.join(TMP, 'data.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg not found. Install it (e.g. `apt-get install ffmpeg`, `brew install ffmpeg`) and re-run.'); process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, HARNESS_MODE: 'mock', HARNESS_DATA: DATA, HARNESS_DEFAULT_CWD: ROOT }, stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: TMP, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  const by = (n) => page.evaluate((x) => [...window.harness.agents.values()].find((a) => a.name === x).id, n);
  const t0 = Date.now(); const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  try {
    // 1. empty office
    await page.goto(`http://localhost:${PORT}/?wander=off`);
    await page.waitForSelector('#conn.on');
    log('empty office'); await sleep(2200);

    // 2. hire 4 agents through the real dialog (first one typed slowly)
    const crew = ['Ada', 'Linus', 'Grace', 'Ken'];
    for (const [i, name] of crew.entries()) {
      await page.click('#hireBtn'); await sleep(i ? 250 : 700);
      await page.fill('#hireName', ''); await page.type('#hireName', name, { delay: i ? 40 : 140 });
      await page.fill('#hireCwd', ROOT); await sleep(i ? 150 : 600);
      await page.click('#hireOk');
      await page.waitForFunction((n) => window.harness.states().some((a) => a.name === n), name);
      log('hired ' + name); await sleep(i ? 600 : 1300);
    }
    await sleep(700);

    // 3. idle life: stretch, read, coffee-machine chat
    await page.evaluate(() => window.harness.select(null));
    const id = { Ada: await by('Ada'), Linus: await by('Linus'), Grace: await by('Grace'), Ken: await by('Ken') };
    await page.evaluate((i) => { window.harness.forceActivity(i.Ada, 'stretch'); window.harness.forceActivity(i.Ken, 'read'); window.harness.forceActivity(i.Linus, 'chat', i.Grace); }, id);
    log('idle activities'); await sleep(6000);

    // 4. talk to Ada: typing -> thinking -> working with tool chip -> helpers
    await page.evaluate((i) => window.harness.select(i), id.Ada);
    await sleep(1200);
    await page.click('#input');
    await page.type('#input', '/team refactor the auth module', { delay: 85 });
    await sleep(900);
    await page.press('#input', 'Enter');
    log('sent /team');
    await page.waitForFunction((i) => window.harness.helpers(i).length === 3, id.Ada, { timeout: 30000 });
    log('3 helpers up');
    await sleep(3800);                       // helpers working, dotted lines + handoffs
    await page.waitForFunction((i) => window.harness.flights().some((f) => f.kind === 'back'), id.Ada, { timeout: 30000 }).catch(() => {});
    await sleep(2200);                       // results flying back
    const sub = page.locator('details.msg.sub').first();
    if (await sub.count()) { await sub.locator('summary').click(); }
    await page.waitForFunction((i) => window.harness.states().find((a) => a.id === i).state === 'done', id.Ada, { timeout: 40000 });
    log('Ada done'); await sleep(3500);      // check mark + reply bubble
  } catch (e) { console.error('DEMO FAILED', e); process.exitCode = 1; }
  const vpath = await page.video().path();
  await ctx.close(); await browser.close(); srv.kill();
  if (process.exitCode) return;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vpath, '-ss', '0.4', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-r', '30', '-an', OUT], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('ffmpeg failed'); process.exitCode = 1; return; }
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT]).stdout.toString().trim();
  console.log(`saved ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB, ${(+dur).toFixed(1)} s)`);
  fs.rmSync(TMP, { recursive: true, force: true });
})();
