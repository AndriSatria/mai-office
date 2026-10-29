'use strict';
// Builds a throwaway ~/.claude look-alike (projects/<encoded cwd>/<session>.jsonl) for tests and screenshots.
const fs = require('fs');
const os = require('os');
const path = require('path');

const enc = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const line = (o) => JSON.stringify(o);

const md5 = (s) => require('crypto').createHash('md5').update(path.resolve(s)).digest('hex');
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

/** Cursor CLI chats: chats/<md5(cwd)>/<id>/meta.json + projects/<slug>/agent-transcripts/<id>/<id>.jsonl, plus broken ones */
function makeFakeCursorChats(cdir, cwds) {
  const ids = { cart: '5a1b2c3d-1111-4aaa-8bbb-000000000001', theme: '5a1b2c3d-2222-4aaa-8bbb-000000000002', empty: '5a1b2c3d-3333-4aaa-8bbb-000000000003' };
  const now = Date.now(), h = 3600e3;
  const u = (q) => line({ role: 'user', message: { content: [{ type: 'text', text: `<user_info>OS: linux</user_info>\n<user_query>\n${q}\n</user_query>` }] } });
  const a = (...content) => line({ role: 'assistant', message: { content } });
  const meta = (cwd, id, m) => [path.join(cdir, 'chats', md5(cwd), id, 'meta.json'), JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd, ...m })];
  const tr = (cwd, rel) => path.join(cdir, 'projects', slug(cwd), 'agent-transcripts', rel);
  const files = [
    meta(cwds.shop, ids.cart, { title: 'Fix rounding in cart totals', createdAtMs: now - 2 * h, updatedAtMs: now - 0.5 * h }),
    [tr(cwds.shop, `${ids.cart}/${ids.cart}.jsonl`), [
      u('Cart totals are off by a cent for some coupons. Fix it.'),
      a({ type: 'text', text: 'I will read the totals helper first.' }, { type: 'tool_use', name: 'Read', input: { path: 'src/cart/totals.js' } }),
      '{"role":"assistant", broken line',
      a({ type: 'text', text: 'Totals now use integer cents; added a test for the 15% coupon.' }),
      line({ type: 'turn_ended', reason: 'completed' }),
    ].join('\n')],
    // the placeholder title is replaced by the first question; legacy flat transcript path
    meta(cwds.blog, ids.theme, { title: 'New Agent', createdAtMs: now - 5 * h }),
    [tr(cwds.blog, `${ids.theme}.jsonl`), [u('Add a dark theme toggle to the header.'), a({ type: 'text', text: 'Added a toggle that stores the choice in localStorage.' })].join('\n')],
    // listed without history: meta.json but no transcript on disk
    meta(cwds.shop, ids.empty, { title: 'Draft the 2.0 migration guide', createdAtMs: now - 8 * h }),
    // not listed: broken meta.json, no meta.json, a subagent, no conversation, a folder that doesn't match md5(cwd)
    [path.join(cdir, 'chats', md5(cwds.shop), '5a1b2c3d-4444-4aaa-8bbb-000000000004', 'meta.json'), '{"cwd": "/broken'],
    [path.join(cdir, 'chats', md5(cwds.shop), '5a1b2c3d-5555-4aaa-8bbb-000000000005', 'store.db'), 'not opened'],
    meta(cwds.shop, '5a1b2c3d-6666-4aaa-8bbb-000000000006', { title: 'subagent', isSubagent: true, createdAtMs: now }),
    meta(cwds.blog, '5a1b2c3d-7777-4aaa-8bbb-000000000007', { title: 'never used', hasConversation: false, createdAtMs: now }),
    [path.join(cdir, 'chats', md5(cwds.blog), '5a1b2c3d-8888-4aaa-8bbb-000000000008', 'meta.json'), JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd: cwds.shop, title: 'moved folder', createdAtMs: now })],
  ];
  for (const [f, text] of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text + '\n'); }
  return ids;
}

function makeFakeClaudeDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-office-fake-claude-'));
  const dir = path.join(base, 'claude'), work = path.join(base, 'work');
  const cwds = { shop: path.join(work, 'shop-api'), blog: path.join(work, 'pixel-blog') };
  for (const c of Object.values(cwds)) fs.mkdirSync(c, { recursive: true });
  const ids = { rate: '0b6f3c2e-5d1a-4c8e-9f21-7a3b8c9d0e11', tests: '1c7a4d3f-6e2b-4d9f-8a32-8b4c9d0e1f22', blog: '2d8b5e4a-7f3c-4e0a-9b43-9c5d0e1f2a33' };
  const ts = (m) => new Date(Date.UTC(2026, 9, 28, 9, m)).toISOString();
  const user = (cwd, sid, m, content, extra) => line({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.0.0', type: 'user', message: { role: 'user', content }, uuid: 'u' + m, timestamp: ts(m), ...extra });
  const asst = (cwd, sid, m, content) => line({ isSidechain: false, cwd, sessionId: sid, type: 'assistant', message: { id: 'msg' + m, role: 'assistant', content }, uuid: 'a' + m, timestamp: ts(m) });
  const files = {
    [path.join(enc(cwds.shop), ids.rate + '.jsonl')]: [
      line({ type: 'summary', summary: 'Add rate limiting to the checkout API', leafUuid: 'a4' }),
      user(cwds.shop, ids.rate, 1, 'Add rate limiting to POST /checkout, 10 requests a minute per user.'),
      asst(cwds.shop, ids.rate, 2, [{ type: 'text', text: 'I will look at the checkout router first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/routes/checkout.js' } }]),
      user(cwds.shop, ids.rate, 3, [{ type: 'tool_result', tool_use_id: 't1', content: 'module.exports = router;' }]),
      '{"type":"assistant", this line is broken',
      asst(cwds.shop, ids.rate, 4, [{ type: 'text', text: 'Added a token bucket middleware in src/middleware/rateLimit.js and wired it into the checkout route.' }]),
    ],
    [path.join(enc(cwds.shop), ids.tests + '.jsonl')]: [
      user(cwds.shop, ids.tests, 10, 'Caveat: The messages below were generated by the user while running local commands.', { isMeta: true }),
      user(cwds.shop, ids.tests, 11, '<command-name>/clear</command-name>'),
      user(cwds.shop, ids.tests, 12, [{ type: 'text', text: 'Why is the orders test flaky on CI?' }]),
      asst(cwds.shop, ids.tests, 13, [{ type: 'text', text: 'The test depends on the system clock. I will freeze time with a fake timer.' }]),
    ],
    [path.join(enc(cwds.blog), ids.blog + '.jsonl')]: [
      user(cwds.blog, ids.blog, 20, 'Write a post about drawing isometric pixel art.'),
      asst(cwds.blog, ids.blog, 21, [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'posts/isometric.md' } }, { type: 'text', text: 'Drafted posts/isometric.md with the 2:1 grid explained.' }]),
    ],
    // not sessions: a subagent sidechain and a summary-only file
    [path.join(enc(cwds.blog), 'agent-3e9c6f5b.jsonl')]: [asst(cwds.blog, 'x', 30, [{ type: 'text', text: 'sidechain' }])],
    [path.join(enc(cwds.blog), '4f0d7a6c-0000-4000-8000-000000000044.jsonl')]: [line({ type: 'summary', summary: 'orphan summary', leafUuid: 'zz' })],
  };
  const order = [ids.blog, ids.tests, ids.rate];   // oldest -> newest mtime
  for (const [rel, lines] of Object.entries(files)) {
    const f = path.join(dir, 'projects', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const k = order.findIndex((id) => rel.includes(id)), t = new Date(Date.now() - (k < 0 ? 9 : 3 - k) * 3600e3);
    fs.utimesSync(f, t, t);
  }
  // "/" commands: user commands (one in a sub folder, one with broken frontmatter), skills, a plugin, project + Cursor commands
  const cursorDir = path.join(base, 'cursor');
  const plug = path.join(dir, 'plugins', 'cache', 'acme-market', 'deploy-kit', '1.2.0');
  const md = {
    [path.join(dir, 'commands', 'frontend', 'component.md')]: '---\ndescription: Scaffold a React component with tests\nargument-hint: <Name> [--size sm|lg]\n---\nCreate $ARGUMENTS.\n',
    [path.join(dir, 'commands', 'review-pr.md')]: '# Review the open pull request for bugs\n\nLook at the diff.\n',
    [path.join(dir, 'commands', 'changelog.md')]: '---\ndescription Broken frontmatter line without a colon\n---\nSummarize the changelog since the last tag\n',
    [path.join(dir, 'skills', 'release-notes', 'SKILL.md')]: '---\nname: release-notes\ndescription: "Draft release notes from merged PRs"\n---\n# Release notes\n',
    [path.join(dir, 'skills', 'hidden-helper', 'SKILL.md')]: '---\ndescription: Background knowledge only\nuser-invocable: false\n---\n',
    [path.join(plug, '.claude-plugin', 'plugin.json')]: JSON.stringify({ name: 'deploy-kit', version: '1.2.0' }),
    [path.join(plug, 'commands', 'ship.md')]: '---\ndescription: Deploy the current branch to staging\nargument-hint: [env]\n---\n',
    [path.join(plug, 'skills', 'rollback', 'SKILL.md')]: '---\ndescription: Roll back the last deploy\n---\n',
    [path.join(dir, 'plugins', 'installed_plugins.json')]: JSON.stringify({ version: 2, plugins: {
      'deploy-kit@acme-market': [{ scope: 'user', installPath: plug, version: '1.2.0' }],
      'other-repo@acme-market': [{ scope: 'project', projectPath: cwds.blog, installPath: path.join(base, 'nowhere') }],
    } }),
    [path.join(cwds.shop, '.claude', 'commands', 'db', 'migrate.md')]: '---\ndescription: Write and run a database migration\nargument-hint: <change>\n---\n',
    [path.join(cwds.shop, '.claude', 'skills', 'seed-data', 'SKILL.md')]: '---\ndescription: Fill the dev database with sample orders\n---\n',
    [path.join(cwds.shop, '.cursor', 'commands', 'lint.md')]: 'Run the linter and fix what it finds\n',
    [path.join(cursorDir, 'commands', 'explain.md')]: '# Explain the selected code\n',
    [path.join(cwds.shop, '.cursor', 'skills', 'api-docs', 'SKILL.md')]: '---\nname: api-docs\ndescription: Regenerate the OpenAPI docs\n---\n',
    [path.join(cursorDir, 'skills', 'tidy-imports', 'SKILL.md')]: '---\ndescription: Sort and dedupe imports\n---\n',
  };
  for (const [f, text] of Object.entries(md)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  const cursorIds = makeFakeCursorChats(cursorDir, cwds);
  return { base, dir, cwds, ids, cursorDir, cursorIds };
}

module.exports = { makeFakeClaudeDir };
