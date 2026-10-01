// F1 regressions: actual locks/files with simulated Pi tool callbacks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('../dist/index.cjs');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = []; let tool;
  const pi = { registerTool(v) { if (v.name === 'hyperion_plan') tool = v; }, registerCommand() {}, registerMessageRenderer() {},
    on() { return () => {}; }, appendEntry(customType, data) { entries.push({ customType, data }); } };
  (await import('../dist/hyperion-plan-pi.js')).default(pi);
  const ctx = { cwd: dir, mode: 'json', isIdle: () => false,
    sessionManager: { getSessionId: () => 'cancel-test', getBranch: () => entries }, ui: { notify() {} } };
  return { dir, entries, call: (params, signal) => tool.execute('cancel-test-request', params, signal, undefined, ctx) };
}
function files(dir) {
  const result = {};
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith('.lockdir')) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(dir, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(dir); return result;
}
async function queued(file, run, whileWaiting) {
  const entered = deferred(), release = deferred();
  const holder = core.withLock(file, () => { entered.resolve(); return release.promise; });
  await entered.promise;
  let operation, settled = false;
  try {
    operation = run().then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    // Explicit-path reads are synchronous behind an async API. Drain their
    // microtasks before aborting; the held lock is the remaining async boundary.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'operation must still be waiting for the held lock');
    await whileWaiting();
  } finally {
    release.resolve();
    await holder;
  }
  return operation;
}

test('cancelled create waiting for a lock writes no plan/history/export and does not bind', { timeout: 10000 }, async t => {
  const h = await harness(t), file = path.join(h.dir, 'cancelled.md'), controller = new AbortController();
  const before = files(h.dir);
  const result = await queued(file,
    () => h.call({ action: 'create', path: file, title: 'Cancelled', demo: true }, controller.signal),
    () => controller.abort());
  assert.equal(result.error?.name, 'AbortError');
  assert.deepEqual(files(h.dir), before);
  assert.deepEqual(h.entries, []);
  // Lock was released and an explicitly new call can still create normally.
  const created = await h.call({ action: 'create', path: file, title: 'New request' });
  assert.equal(created.details.changed, true);
  assert.equal(h.entries.length, 1);
});

test('cancellation observed after a committed create prevents binding, without pretending to roll back files', async t => {
  const h = await harness(t), file = path.join(h.dir, 'committed.md'), controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  controller.signal.throwIfAborted = () => {
    // Deterministically abort at the first signal check after the synchronous
    // commit, which completes before the asynchronous lock release settles.
    if (fs.existsSync(file)) controller.abort();
    check();
  };
  await assert.rejects(h.call({ action: 'create', path: file, title: 'Committed' }, controller.signal), { name: 'AbortError' });
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(h.entries, []);
});

for (const action of ['edit', 'finish', 'reopen']) for (const external of [false, true]) {
  test(`cancelled ${action} waiting for a lock preserves all bytes${external ? ', including unrefreshed external Markdown' : ''}`, { timeout: 10000 }, async t => {
    const h = await harness(t), file = path.join(h.dir, 'plan.md'), controller = new AbortController();
    const plan = core.initialize({ title: 'Original', steps: [{ id: 'a', title: 'Unchanged' }] });
    if (action === 'reopen') plan.lifecycle = 'finished';
    core.saveMarkdown(file, plan);
    const params = { action, path: file, plan_id: plan.plan_id, base_revision: plan.revision,
      ...(action === 'edit' ? { operations: JSON.stringify([{ type: 'update_step', step_id: 'a', fields: { title: 'Cancelled edit' } }]) } : {}) };
    let before;
    const result = await queued(file, () => h.call(params, controller.signal), () => {
      if (external) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('# Original', '# External title'));
      before = files(h.dir); controller.abort();
    });
    assert.equal(result.error?.name, 'AbortError');
    assert.deepEqual(files(h.dir), before, 'Markdown, sidecar, recovery and exports must remain untouched');
    assert.deepEqual(h.entries, []);
    const current = await core.loadPlanSnapshot(file);
    assert.equal(current.refresh_required, external);
    assert.equal(current.plan.steps[0].title, 'Unchanged');
    assert.equal(current.plan.lifecycle, plan.lifecycle);
  });
}

test('createPlan beforeWrite guard executes under the lock before any canonical files exist', { timeout: 10000 }, async t => {
  const h = await harness(t), file = path.join(h.dir, 'guarded.md');
  let calls = 0;
  const result = await queued(file, () => core.createPlan(file, 'Guarded', { beforeWrite() {
    calls++;
    assert.equal(fs.existsSync(file + '.lockdir'), true);
    assert.equal(fs.existsSync(file), false);
    throw new Error('Guard rejected');
  } }), () => assert.equal(calls, 0));
  assert.match(result.error?.message ?? '', /Guard rejected/);
  assert.equal(calls, 1);
  assert.deepEqual(files(h.dir), {});
});
