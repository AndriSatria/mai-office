'use strict';
// Shared by screenshots.js / screenshots-hd.js: the manager desk + round table beats.
//   1. overview: manager desk (main agent) and the round table, everybody at their desks
//   2. monitors: several desks working at once, clipped close-up (every screen faces the seated person; back of the monitor shows the status glow)
//   3. plan mode: the owner types "/plan ..." -> the plan owner and every idle colleague gather at the round table
//   4. plan ready: the summary bubble + check over the table
// shots = { overview, monitors, gather, ready }; shots.monitors receives a clip rect {x,y,width,height} in CSS px.
module.exports = async function planShots(page, ownerName, shots, sleep, root) {
  const names = ['Barbara', 'Dennis', 'Edsger', 'Margaret', 'Tim', 'Radia', 'Guido', 'Bjarne'];
  // fill the office: 6 desks + the manager desk
  for (const n of names) {
    const cnt = await page.evaluate(() => window.harness.agents.size);
    if (cnt >= 7) break;
    await page.evaluate(([nm, cwd]) => window.harness.send({ type: 'hire', name: nm, cwd, agentType: 'mock' }), [n, root]);
    await page.waitForFunction((nm) => window.harness.states().some((a) => a.name === nm), n);
    await sleep(120);
  }
  const quiet = (ms = 60000) => page.waitForFunction(() => window.harness.states().every((a) => a.home && !a.act && !a.helping && (a.state === 'idle' || a.state === 'done')), null, { timeout: ms });
  await page.evaluate(() => window.harness.select(null));
  await quiet(); await sleep(14500);   // let old reply bubbles expire
  await shots.overview();

  // monitors: three regular desks busy at once (thinking / working glows on the monitor backs)
  const busy = await page.evaluate(() => [...window.harness.agents.values()].filter((a) => !a.main).slice(0, 4).map((a) => a.id));
  for (const id of busy) await page.evaluate(([i, t]) => window.harness.send({ type: 'send', id: i, text: t }), [id, 'Refactor src/utils.js and run the tests, then summarise.']);
  await page.waitForFunction((n) => window.harness.states().filter((a) => a.state === 'working').length >= n, 3, { timeout: 20000 });
  await sleep(500);
  const clip = await page.evaluate(() => { const O = window.Office, b = document.getElementById('office').getBoundingClientRect(), k = b.width / O.W;
    const x0 = 40, y0 = 62, x1 = 338, y1 = 214; return { x: b.x + x0 * k, y: b.y + y0 * k, width: (x1 - x0) * k, height: (y1 - y0) * k }; });
  await shots.monitors(clip);
  await quiet(90000); await sleep(1500);

  // plan mode: the owner types /plan; idle colleagues gather, then the summary bubble
  await page.evaluate((n) => { const a = [...window.harness.agents.values()].find((x) => x.name === n); window.harness.select(a.id); }, ownerName);
  await page.fill('#input', '/plan add a dark mode toggle to the settings page'); await page.press('#input', 'Enter');
  await page.waitForFunction(() => window.harness.plan().state === 'planning', null, { timeout: 10000 });
  await page.waitForFunction(() => { const p = window.harness.plan(); return p.seated.length >= 6 && p.walking.length === 0; }, null, { timeout: 30000 });
  await sleep(1400);
  await shots.gather();
  await page.waitForFunction(() => window.harness.plan().state === 'ready', null, { timeout: 40000 });
  await sleep(1300);
  await shots.ready();
  await page.waitForFunction(() => window.harness.plan().state === null && window.harness.states().every((a) => a.home), null, { timeout: 60000 });
  await page.evaluate(() => window.harness.select(null));
  await sleep(500);
};
