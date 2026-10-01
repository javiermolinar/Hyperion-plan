const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/index.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(t, steps = [{ id: 'a', title: 'Selected work', status: 'pending' }], actionType = 'run') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-pi-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plan.md');
  core.saveMarkdown(file, core.initialize({ title: 'Race regression', steps }));
  const entries = [], notices = [], messages = [], handlers = new Map(), attempting = deferred();
  let command, idle = true, watchIdle = false, views = 0;
  const pi = {
    registerTool() {}, registerMessageRenderer() {}, registerCommand(_name, value) { command = value; },
    on(name, fn) {
      const list = handlers.get(name) ?? []; handlers.set(name, list); list.push(fn);
      return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
    },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage(content, options) { assert.equal(options?.deliverAs, 'followUp', 'explicit requests survive busy races without steering active work'); messages.push(content); },
  };
  (await import('../dist/hyperion-plan-pi.js')).default(pi);
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const ctx = {
    cwd: dir, mode: 'tui',
    isIdle() { if (watchIdle) attempting.resolve(); return idle; },
    sessionManager: { getSessionId: () => 'race-session', getBranch: () => entries },
    ui: {
      notify(message) { notices.push(message); },
      custom: async factory => {
        let action;
        const screen = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, value => { action = value; });
        if (views++ === 0) {
          if (actionType === 'run') {
            if (steps[0].id !== 'a') screen.handleInput('j');
            screen.handleInput(' ');
          }
          screen.handleInput({ run: 'r', save: 's', refresh: 'g' }[actionType]);
          assert.equal(action?.type, actionType, 'fixture action must be available before the race');
          watchIdle = true;
        } else screen.handleInput('q');
        return action;
      },
    },
  };
  return {
    file, entries, notices, messages, ctx, attempting,
    setIdle(value) { idle = value; },
    async emit(name) { for (const fn of [...(handlers.get(name) ?? [])]) await fn({}, ctx); },
    open: () => command.handler(file, ctx),
    read: () => core.loadPlanSnapshot(file),
  };
}
test('native Run selects a ready code review and delegates only that explicit review capability', async t => {
  const h = await harness(t, [
    { id: 'pre', title: 'Completed implementation', status: 'completed' },
    { id: 'a', title: 'Inspect implementation', kind: 'review', status: 'pending', depends_on: ['pre'], checks: ['Inspect actual behavior'] },
  ]);
  await h.open();
  assert.equal(h.messages.length, 1, h.notices.join('\n'));
  assert.match(h.messages[0], /invoke hyperion_review/);
  assert.match(h.messages[0], /findings do not authorize fixes/);
  assert.deepEqual((await h.read()).plan.execution.selected_step_ids, ['a']);
  assert.equal((await h.read()).plan.steps[1].status, 'pending', 'selection does not fabricate review progress');
});

for (const mode of ['new','legacy','sequential','auto','parallel']) test(`native Run preserves ${mode} execution preference and advertises bounded, not automatic, dispatch`, async t => {
  const h = await harness(t);
  if (mode !== 'new') {
    let p = (await h.read()).plan;
    p = core.applyRequest(p, { plan_id:p.plan_id, base_revision:p.revision, request_id:'earlier-selection', intent:'implement', operations:[], selected_step_ids:['a'], ...(mode === 'legacy' ? {} : {execution_mode:mode}) })[0];
    core.saveMarkdown(h.file,p);
  }
  await h.open();
  assert.equal((await h.read()).plan.execution.execution_mode,mode === 'new' ? 'auto' : mode === 'legacy' ? 'sequential' : mode);
  assert.equal((await h.read()).plan.steps[0].status,'pending');
  assert.match(h.messages[0],/bounded hyperion_wave/); assert.match(h.messages[0],/user separately prohibits worker sessions/);
  assert.match(h.messages[0],/checkpoint each completion or blocker, then reconcile/);
});

async function holdLock(file) {
  const entered = deferred(), exit = deferred();
  const done = core.withLock(file, () => { entered.resolve(); return exit.promise; });
  await entered.promise;
  return { release: exit.resolve, done };
}
const files = file => [file, core.markdownStatePath(file), core.notesPath(file)].map(location =>
  fs.existsSync(location) ? fs.readFileSync(location) : null);
function edit(plan, operations, extra = {}) {
  return core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: 'concurrent-edit', intent: 'edit', operations, ...extra })[0];
}

for (const barrier of ['handover', 'review', 'independent review']) {
  test(`Run revalidates a newly introduced ${barrier} under the lock`, { timeout: 10000 }, async t => {
    const h = await harness(t, [
      { id: 'pre', title: 'Earlier work', status: 'completed' },
      { id: 'a', title: 'Selected work', status: 'pending' },
    ]);
    const lock = await holdLock(h.file);
    let opened;
    try {
      opened = h.open();
      await h.attempting.promise; // The adapter already read its latest snapshot and is now waiting for the lock.
      const plan = (await h.read()).plan;
      const changed = barrier === 'independent review'
        ? edit(plan, [], { intent: 'review', review_mode: 'independent', target_step_ids: ['a'] })
        : edit(plan, [{ type: 'add_step', step_id: 'barrier', title: 'New boundary', kind: barrier,
          after_step_id: barrier === 'handover' ? 'a' : 'pre',
          depends_on: [barrier === 'handover' ? 'a' : 'pre'],
          ...(barrier === 'review' ? { checks: ['Inspect earlier work'] } : {}) }]);
      core.saveMarkdown(h.file, changed);
      const before = files(h.file);
      lock.release(); await lock.done; await opened;
      assert.equal(h.messages.length, 1);
      if (barrier === 'review') {
        assert.deepEqual((await h.read()).plan.execution.selected_step_ids, ['a'], 'unselected unrelated review is not a blanket barrier');
      } else {
        assert.deepEqual(files(h.file), before, 'deferred admission must not fabricate approval');
        assert.match(h.messages[0], /current user intent/);
        assert.match(h.messages[0], /reconciliation_reason/);
        assert.equal((await h.read()).plan.execution, undefined);
      }
    } finally { lock.release(); await lock.done; await opened; }
  });
}

for (const change of ['busy', 'busy-then-idle', 'session_tree', 'session_shutdown']) {
  test(`Run handles ${change} while awaiting the lock without crossing session authority`,  { timeout: 10000 }, async t => {
    const h = await harness(t), lock = await holdLock(h.file);
    let opened;
    try {
      opened = h.open(); await h.attempting.promise;
      fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('# Race regression', '# External title'));
      const before = files(h.file);
      if (change.startsWith('busy')) {
        h.setIdle(false); await h.emit('agent_start');
        if (change === 'busy-then-idle') { h.setIdle(true); await h.emit('agent_settled'); }
      } else await h.emit(change);
      lock.release(); await lock.done; await opened;
      if (change === 'busy-then-idle') {
        assert.deepEqual((await h.read()).plan.execution.selected_step_ids, ['a']);
        assert.equal(h.messages.length, 1);
      } else {
        assert.deepEqual(files(h.file), before, 'no writes without a valid idle canonical boundary');
        assert.equal((await h.read()).plan.execution, undefined);
        assert.equal(h.messages.length, change === 'busy' ? 1 : 0);
        if (change === 'busy') assert.match(h.messages[0], /current user intent/);
        else assert.ok(h.notices.some(text => /screen\/session changed/.test(text)), h.notices.join('\n'));
      }
    } finally { lock.release(); await lock.done; await opened; }
  });
}

for (const action of ['save']) {
  test(`${action} rechecks busy state under the lock and preserves session drafts`, { timeout: 10000 }, async t => {
    const h = await harness(t, undefined, action), snapshot = await h.read();
    const draft = { path: snapshot.path, plan_id: snapshot.plan.plan_id,
      base_revision: snapshot.plan.revision, base_digest: snapshot.source_digest, base_plan: snapshot.plan,
      operations: [{ type: 'update_step', step_id: 'a', fields: { title: 'Unsent edit' } }] };
    h.entries.push({ type: 'custom', customType: 'hyperion-plan.draft', data: draft });
    const lock = await holdLock(h.file);
    let opened;
    try {
      opened = h.open(); await h.attempting.promise;
      fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('# Race regression', '# External title'));
      const before = files(h.file);
      h.setIdle(false); await h.emit('agent_start');
      lock.release(); await lock.done; await opened;
      assert.deepEqual(files(h.file), before);
      assert.equal(h.messages.length, 1);
      assert.match(h.messages[0], /Save the submitted draft edits/);
      const intent = h.entries.find(entry => entry.customType === 'hyperion-plan.intent').data;
      assert.deepEqual(intent.draft.operations, draft.operations, 'submitted draft is retained for the coordinator');
    } finally { lock.release(); await lock.done; await opened; }
  });
}

test('a turn starting during lock release receives the saved request as one follow-up',  { timeout: 10000 }, async t => {
  const h = await harness(t);
  const lockfile = require('proper-lockfile'), originalLock = lockfile.lock;
  const saved = deferred(), release = deferred();
  lockfile.lock = async (...args) => {
    const unlock = await originalLock(...args);
    return async () => { saved.resolve(); await release.promise; await unlock(); };
  };
  let opened;
  try {
    opened = h.open(); await saved.promise;
    assert.deepEqual((await h.read()).plan.execution.selected_step_ids, ['a']);
    h.setIdle(false); await h.emit('agent_start');
    release.resolve(); await opened;
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0], /Do not apply this request a second time/);
    assert.ok(!h.notices.some(text => /submit a fresh request/.test(text)));
  } finally { release.resolve(); await opened; lockfile.lock = originalLock; }
});

for (const change of ['unrelated edit', 'selected completion']) {
  test(`safe stale Run reconciliation still handles ${change}`, { timeout: 10000 }, async t => {
    const h = await harness(t, [
      { id: 'a', title: 'Selected work', status: 'pending' },
      { id: 'other', title: 'Unselected work', status: 'pending' },
    ]);
    const lock = await holdLock(h.file);
    let opened;
    try {
      opened = h.open(); await h.attempting.promise;
      const plan = (await h.read()).plan;
      core.saveMarkdown(h.file, edit(plan, [change === 'unrelated edit'
        ? { type: 'update_step', step_id: 'other', fields: { title: 'Updated unrelated work' } }
        : { type: 'set_status', step_id: 'a', status: 'completed' }]));
      lock.release(); await lock.done; await opened;
      const selected = (await h.read()).plan.execution.selected_step_ids;
      assert.deepEqual(selected, change === 'unrelated edit' ? ['a'] : []);
      assert.equal(h.messages.length, change === 'unrelated edit' ? 1 : 0);
      if (h.messages.length) assert.match(h.messages[0], /authorized Run for these step IDs only: a\./);
    } finally { lock.release(); await lock.done; await opened; }
  });
}
