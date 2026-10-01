const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
async function fixture(t, confirm = async () => true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-setup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'setup.mjs');
  await require('esbuild').build({ entryPoints: [path.resolve(__dirname, '../src/pi/review-setup.ts')], outfile: entry, bundle: true, format: 'esm', platform: 'node' });
  const { ReviewSetup } = await import(pathToFileURL(entry));
  const events = new Map(), tools = new Map(), messages = [];
  const pi = { on: (event, fn) => events.set(event, fn), registerTool: tool => tools.set(tool.name, tool), sendUserMessage: (...args) => messages.push(args) };
  const source = path.join(root, 'project'); fs.mkdirSync(source); execFileSync('git', ['init', '-q', source]);
  const abort = new AbortController(); let actor = 'fixture-owner', confirmations = 0;
  const ctx = { cwd: source, hasUI: true, signal: abort.signal, sessionManager: { getSessionId: () => actor }, ui: { confirm: async (...args) => { confirmations++; return confirm(...args); } } };
  const setup = new ReviewSetup(pi); setup.register();
  const suites = { required: ['.:node'], tests: {}, resources: [], setupProblems: ['Dependencies missing'] };
  const offer = (force = false, guard = async () => {}) => setup.offer(ctx, source, [], suites, guard, abort.signal, force);
  const call = args => tools.get('hyperion_review_setup').execute('fixture-call', args, abort.signal, undefined, ctx);
  const token = () => messages[0][0].match(/token=([a-f0-9-]+)/)[1];
  return { root, source, events, messages, ctx, abort, setup, suites, offer, call, token, confirmations: () => confirmations, actor: value => actor = value };
}
test('consent queues one scoped current-agent task, no review, no repeated prompt', async t => {
  const f = await fixture(t);
  assert.equal((await f.offer()).details.setup, 'queued');
  assert.equal((await f.offer()).details.review_started, false);
  assert.equal(f.confirmations(), 1); assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0][1], { deliverAs: 'followUp', expandPromptTemplates: false });
  assert.match(f.messages[0][0], /Do not install\/download/);
  assert.match(f.messages[0][0], /fresh user review request/);
  assert.equal((await f.call({ operation: 'status', token: f.token() })).details.authorized_for_setup, true);
});
test('decline stays quiet until explicitly reconfigured', async t => {
  const f = await fixture(t, async () => false);
  assert.equal((await f.offer()).details.setup, 'declined'); await f.offer();
  assert.equal(f.confirmations(), 1); assert.equal(f.messages.length, 0);
  await f.offer(true); assert.equal(f.confirmations(), 2);
});
test('ready and noninteractive environments do not send setup tasks', async t => {
  const f = await fixture(t);
  f.suites.setupProblems = [];
  assert.equal(await f.offer(), undefined);
  f.suites.setupProblems = ['missing']; f.ctx.hasUI = false;
  assert.equal((await f.offer()).details.setup, 'needs-permission');
  assert.equal(f.confirmations(), 0); assert.equal(f.messages.length, 0);
});
for (const event of ['session_start', 'session_tree', 'session_shutdown', 'session_before_switch', 'session_before_fork', 'abort', 'identity']) {
  test('pending confirmation cannot survive ' + event, async t => {
    let resolve; const f = await fixture(t, () => new Promise(r => resolve = r));
    const pending = f.offer(); await new Promise(r => setImmediate(r));
    if (event === 'abort') f.abort.abort(); else if (event === 'identity') f.actor('other'); else await f.events.get(event)();
    resolve(true); await assert.rejects(pending, /abort|consent/i); assert.equal(f.messages.length, 0);
  });
  test('queued receipt cannot survive ' + event, async t => {
    const f = await fixture(t); await f.offer(); const token = f.token();
    if (event === 'abort') f.abort.abort(); else if (event === 'identity') f.actor('other'); else await f.events.get(event)();
    await assert.rejects(f.call({ operation: 'save', token, resources: {} }), /abort|consent/i);
  });
}
test('recheck current authority after consent, before delivery', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.offer(false, async () => { if (++calls > 1) throw Error('revoked'); }), /revoked/);
  assert.equal(f.messages.length, 0);
});
test('saving uses private project-keyed configuration, rejects paths/commands and consumes consent', async t => {
  const f = await fixture(t); const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(f.root, 'agent');
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  await f.offer(); const token = f.token();
  await assert.rejects(f.call({ operation: 'save', token, resources: { CHROMIUM_EXECUTABLE: 'relative' } }), /absolute/);
  await assert.rejects(f.call({ operation: 'save', token, resources: { command: 'touch forbidden' } }), /Unsupported/);
  const result = (await f.call({ operation: 'save', token, resources: { CHROMIUM_EXECUTABLE: process.execPath } })).details;
  assert.ok(result.config_path.startsWith(process.env.PI_CODING_AGENT_DIR)); assert.equal(result.review_started, false);
  assert.equal(fs.statSync(result.config_path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(result.config_path)).CHROMIUM_EXECUTABLE, process.execPath);
  assert.equal(fs.existsSync(path.join(f.source, '.pi')), false);
  await assert.rejects(f.call({ operation: 'save', token, resources: {} }), /consent/);
});
test('session change during initial admission prevents even a confirmation', async t => {
  const f = await fixture(t); let release;
  const pending = f.offer(false, () => new Promise(resolve => release = resolve));
  await new Promise(r => setImmediate(r)); await f.events.get('session_start')(); release();
  await assert.rejects(pending, /context changed/); assert.equal(f.confirmations(), 0);
});
test('revocation after delivery rejects setup receipt use', async t => {
  const f = await fixture(t); let revoked = false;
  await f.offer(false, async () => { if (revoked) throw Error('revoked'); });
  revoked = true;
  await assert.rejects(f.call({ operation: 'save', token: f.token(), resources: {} }), /revoked/);
});
test('reconfiguration needs a current user request and validates resource shapes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ operation: 'request', files: ['package.json'] }), /Current explicit/);
  await f.offer();
  await assert.rejects(f.call({ operation: 'save', token: f.token(), resources: { PLAYWRIGHT_MODULE: f.root } }), /missing|inaccessible/);
  await assert.rejects(f.call({ operation: 'save', token: f.token(), resources: { CHROMIUM_EXECUTABLE: f.root } }), /executable file/);
  assert.equal(f.messages.length, 1);
});
test('forged or expired receipts never grant setup authority', async t => {
  const f = await fixture(t); await assert.rejects(f.call({ operation: 'status', token: 'forged' }), /consent/);
  await f.offer(); const now = Date.now;
  try { Date.now = () => now() + 31 * 60_000; await assert.rejects(f.call({ operation: 'status', token: f.token() }), /consent/); }
  finally { Date.now = now; }
});
