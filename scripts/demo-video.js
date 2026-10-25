'use strict';
// Records demo videos of the real running app (mock mode) with Playwright's recordVideo -> H.264/yuv420p MP4 via ffmpeg.
//   npm run demo:video              -> demo/mai-office-demo.mp4              (hire, idle life, /team with 3 helpers)
//   npm run demo:video:codereview   -> demo/mai-office-demo-codereview.mp4   (/code-review: colleagues walk over, peer talk, huddle)
//   npm run demo:videos             -> both
// Pacing: everything runs at DEMO_SLOW x slower (default 2): the server timers (HARNESS_SLOW), the page's walk speed / bubble lifetimes
// (?slow=) and the script's own pauses.  Every beat gets a bottom-bar caption that stays up >= 2.6 s.
// (the code-review story runs the server timers 1.6x slower again so the working phase is long enough to read.)
// Env: DEMO_PORT (3113), DEMO_W/DEMO_H (video size, 1920x1080), DEMO_VW (page viewport width, 1280), DEMO_SLOW (2).
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'demo');
const PORT = process.env.DEMO_PORT || 3113;
const W = +process.env.DEMO_W || 1920, H = +process.env.DEMO_H || 1080;          // video size
const VW = +process.env.DEMO_VW || 1280, VH = Math.round(VW * H / W);          // page viewport: recorded at this size and upscaled to the video size, so text/bubbles come out 1.5x bigger
const SLOW = +process.env.DEMO_SLOW || 2;
const which = process.argv[2] === 'codereview' ? 'codereview' : 'basic';
const OUT = path.join(OUT_DIR, which === 'codereview' ? 'mai-office-demo-codereview.mp4' : 'mai-office-demo.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (ms) => sleep(ms * SLOW / 2);        // authored for SLOW=2; scales with DEMO_SLOW

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.error('ffmpeg not found. Install it (e.g. `apt-get install ffmpeg`, `brew install ffmpeg`) and re-run.'); process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// bottom-bar caption overlay living inside the page (so it is part of the recording); captions queue, each stays >= minMs
const CAPTION_JS = (minMs) => {
  const bar = document.createElement('div');
  bar.id = 'demoCap';
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:11px 16px 13px;text-align:center;font:600 20px/1.25 "Courier New",monospace;color:#fff6d8;' +
    'background:linear-gradient(0deg,rgba(8,10,20,.94),rgba(8,10,20,.78));border-top:2px solid #f4c542;letter-spacing:.3px;transition:opacity .25s;opacity:0;pointer-events:none';
  document.body.appendChild(bar);
  const q = []; let busy = false;
  const next = () => {
    if (!q.length) { busy = false; return; }
    busy = true; const t = q.shift(); bar.textContent = t; bar.style.opacity = 1;
    setTimeout(() => { if (!q.length) { next(); return; } next(); }, minMs);
  };
  window.__cap = (t) => { if (q.length && q.length > 1) q.splice(0, q.length - 1); q.push(t); if (!busy) next(); };   // never fall more than one caption behind
  window.__capOff = () => { q.length = 0; bar.style.opacity = 0; };
};

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-demo-'));
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, HARNESS_MODE: 'mock', HARNESS_DATA: path.join(TMP, 'data.json'), HARNESS_DEFAULT_CWD: ROOT, HARNESS_SLOW: String(which === 'codereview' ? SLOW * 1.6 : SLOW) }, stdio: 'inherit' });
  await sleep(1300);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, recordVideo: { dir: TMP, size: { width: VW, height: VH } } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  const t0 = Date.now(); const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  const cap = async (text) => { log('caption: ' + text); await page.evaluate((t) => window.__cap(t), text); };
  const by = (n) => page.evaluate((x) => [...window.harness.agents.values()].find((a) => a.name === x).id, n);
  const states = () => page.evaluate(() => window.harness.states());
  const until = (fn, arg, ms = 90000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });

  async function hire(crew, firstCaption) {
    await cap(firstCaption); await pause(1200);
    for (const [i, name] of crew.entries()) {
      await page.click('#hireBtn'); await pause(i ? 700 : 1300);
      await page.fill('#hireName', ''); await page.type('#hireName', name, { delay: i ? 90 : 160 });
      await page.fill('#hireCwd', ROOT); await pause(i ? 500 : 1000);
      await page.click('#hireOk');
      await page.waitForFunction((n) => window.harness.states().some((a) => a.name === n), name);
      if (i === 0) await cap(`${name} is hired and takes the first desk`);
      else if (i === 1) await cap('Colleagues join the office, one by one');
      await pause(i ? 1800 : 2600);
    }
  }

  try {
    await page.goto(`http://localhost:${PORT}/?wander=off&slow=${SLOW}`);
    await page.waitForSelector('#conn.on');
    await page.evaluate(CAPTION_JS, 2600);

    await cap('mAI office: every AI agent is a person in a pixel office'); await pause(5200);
    const crew = ['Ada', 'Linus', 'Grace', 'Ken'];
    await hire(crew, 'Hire agents with the Hire button');
    await page.evaluate(() => window.harness.select(null));
    const id = { Ada: await by('Ada'), Linus: await by('Linus'), Grace: await by('Grace'), Ken: await by('Ken') };

    if (which === 'basic') {
      await cap('Idle agents stretch, read and chat at the coffee machine');
      await page.evaluate((i) => { window.harness.forceActivity(i.Ada, 'stretch'); window.harness.forceActivity(i.Ken, 'read'); window.harness.forceActivity(i.Linus, 'chat', i.Grace); }, id);
      await pause(11000);
      await page.evaluate((i) => window.harness.select(i), id.Ada);
      await cap('Select Ada and type a task for her'); await pause(2200);
      await page.click('#input');
      await page.type('#input', '/team refactor the auth module', { delay: 130 });
      await pause(1800);
      await page.press('#input', 'Enter');
      await cap('Ada receives the task: thinking, then working with a tool chip');
      await until((i) => window.harness.states().find((a) => a.id === i).state !== 'idle', id.Ada);
      await until((i) => window.harness.help(i) === null && window.harness.states().filter((a) => a.helping).length >= 1, id.Ada, 60000).catch(() => {});
      await cap('She delegates to 3 helpers: colleagues walk over with a role badge');
      await until(() => window.harness.states().filter((a) => a.helping === 'work').length >= 3, null, 60000).catch(() => {});
      await cap('Helpers work in parallel; dotted lines show who helps whom'); await pause(6000);
      await until(() => window.harness.flights().some((f) => f.kind === 'back'), null, 90000).catch(() => {});
      await cap('Results come back as envelopes: "Helper \u2192 Ada"');
      await pause(5000);
      const sub = page.locator('details.msg.sub').first();
      if (await sub.count()) { await sub.locator('summary').click(); }
      await cap('Helpers walk back to their own desks');
      await until((i) => window.harness.states().find((a) => a.id === i).state === 'done', id.Ada, 90000);
      await cap('Ada is done: check mark and a reply bubble'); await pause(6500);
      await until(() => window.harness.states().every((a) => !a.helping && a.home), null, 60000).catch(() => {});
      await pause(3500);
    } else {
      await cap('Four colleagues, all idle. Now a multi-agent task: /code-review');
      await pause(3600);
      await page.evaluate((i) => window.harness.select(i), id.Ada);
      await pause(1600);
      await page.click('#input');
      await page.type('#input', '/code-review', { delay: 150 });
      await pause(1800);
      await page.press('#input', 'Enter');
      await cap('Ada receives /code-review and starts thinking');
      const seen = new Set();
      const once = async (k, text, cond, arg) => { if (!seen.has(k) && await page.evaluate(cond, arg)) { seen.add(k); await cap(text); return true; } return false; };
      const t1 = Date.now();
      while (Date.now() - t1 < 240000) {
        const done = await page.evaluate((i) => { const s = window.harness.states(); return s.find((a) => a.id === i).state === 'done' && s.every((a) => !a.helping && a.home); }, id.Ada);
        if (done && seen.has('huddle')) break;
        await once('plan', 'Ada announces the plan: one task paper per helper (inferred)', (i) => window.harness.team(i).some((e) => e.kind === 'plan'), id.Ada);
        await once('go', 'Idle colleagues walk over to help (temporary "helping Ada" status)', () => window.harness.states().some((a) => a.helping === 'go'), null);
        await once('hire', 'Nobody left idle: a new colleague is hired and walks in through the door', () => window.harness.states().some((a) => a.helping === 'go' && a.name !== 'Linus' && a.name !== 'Grace' && a.name !== 'Ken'), null);
        await once('work', 'Helpers work in parallel: role badge + tool chip + dotted line to Ada', () => window.harness.states().filter((a) => a.helping === 'work').length >= 3, null);
        await once('peer', 'Two helpers touched the same file: they turn and compare notes (inferred)', () => [...window.harness.agents.values()].some((a) => (window.harness.help(a.id) || {}).peer), null);
        await once('back', 'Results are handed back to Ada as envelopes (one helper reports a failure)', () => window.harness.flights().some((f) => f.kind === 'back'), null);
        await once('letter', 'A result mentions another role: a letter is passed on (inferred)', () => window.harness.flights().some((f) => f.kind === 'letter'), null);
        await once('huddle', 'Team huddle: Ada merges the findings into one review', (i) => window.harness.huddle(i), id.Ada);
        if (seen.has('huddle') && !seen.has('home') && await page.evaluate(() => window.harness.states().some((a) => a.helping === 'back' || (a.helping === null && !a.home)))) { seen.add('home'); await cap('Helpers walk back to their own desks and go idle'); }
        await sleep(100);
      }
      const sub = page.locator('details.msg.sub').first();
      if (await sub.count()) { await sub.locator('summary').click(); }
      await cap('Ada replies with the consolidated review; Team activity lists every step'); await pause(8000);
      await page.evaluate(() => { const t = document.getElementById('teamBox'); if (t) t.open = true; });
      await pause(4000);
    }
    await cap('mAI office \u2014 agents that work together'); await pause(3200);
    await page.evaluate(() => window.__capOff());
    await pause(800);
  } catch (e) { console.error('DEMO FAILED', e); process.exitCode = 1; }
  const vpath = await page.video().path();
  await ctx.close(); await browser.close(); srv.kill();
  if (process.exitCode) return;
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vpath, '-ss', '0.4', '-vf', `scale=${W}:${H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-r', '30', '-an', OUT], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('ffmpeg failed'); process.exitCode = 1; return; }
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT]).stdout.toString().trim();
  console.log(`saved ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB, ${(+dur).toFixed(1)} s)`);
  fs.rmSync(TMP, { recursive: true, force: true });
})();
