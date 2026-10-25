'use strict';
// Shared by screenshots.js / screenshots-hd.js: the mock /code-review scenario. The lead hands out the plan, EXISTING colleagues (plus an
// auto-hired one when nobody is idle) walk over, one screenshot per beat: helpers working, a peer-conversation moment (inferred), a result
// handoff in mid-air and the team huddle.  shots = { mid, peer, handoff, huddle } (async callbacks).
module.exports = async function teamShots(page, parentName, shots, sleep) {
  const pid = await page.evaluate((n) => { const a = [...window.harness.agents.values()].find((x) => x.name === n); window.harness.select(a.id); return a.id; }, parentName);
  await page.fill('#input', '/code-review'); await page.press('#input', 'Enter');
  const done = { mid: false, peer: false, handoff: false, huddle: false };
  const t0 = Date.now();
  while (Date.now() - t0 < 70000 && !(done.mid && done.peer && done.handoff && done.huddle)) {
    const s = await page.evaluate((id) => {
      const H = window.harness, ppl = [...H.agents.values()];
      const work = ppl.filter((a) => (H.help(a.id) || {}).phase === 'work' && H.help(a.id).tool && H.help(a.id).mode === 'help');
      return { work: work.length, peer: ppl.some((a) => (H.help(a.id) || {}).peer), back: H.flights().some((f) => f.kind === 'back'), huddle: H.huddle(id) };
    }, pid);
    if (!done.mid && s.work >= 4) { done.mid = true; await sleep(400); await shots.mid(); continue; }
    if (done.mid && !done.peer && s.peer) { done.peer = true; await sleep(450); await shots.peer(); continue; }
    if (!done.handoff && s.back) { done.handoff = true; await sleep(380); await shots.handoff(); continue; }
    if (!done.huddle && s.huddle) { done.huddle = true; await sleep(900); await shots.huddle(); continue; }
    await sleep(40);
  }
  if (!(done.mid && done.peer && done.handoff && done.huddle)) throw new Error('team shots missed a beat: ' + JSON.stringify(done));
  await page.waitForFunction((n) => ['done', 'idle'].includes(window.harness.states().find((a) => a.name === n).state), parentName, { timeout: 60000 });
  await page.waitForFunction(() => window.harness.states().every((a) => !a.helping && a.home), null, { timeout: 40000 });
  await sleep(300);
};
