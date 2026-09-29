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
    sendUserMessage(content) { assert.equal(idle, true, 'never dispatch while busy'); messages.push(content); },
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
      assert.deepEqual(files(h.file), before, 'rejected Run must not write approval or receipts');
      assert.deepEqual(h.messages, []);
      assert.ok(h.notices.some(text => /handover|Review barrier|independent plan review/.test(text)), h.notices.join('\n'));
      assert.equal((await h.read()).plan.execution, undefined);
    } finally { lock.release(); await lock.done; await opened; }
  });
}

for (const change of ['busy', 'busy-then-idle', 'session_tree', 'session_shutdown']) {
  test(`a ${change} transition while awaiting the lock cancels Run without refreshing external edits`, { timeout: 10000 }, async t => {
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
      assert.deepEqual(files(h.file), before, 'even sidecar refresh must wait for valid current authorization');
      assert.deepEqual(h.messages, []);
      assert.ok(h.notices.some(text => /not written or queued/.test(text)), h.notices.join('\n'));
      assert.equal((await h.read()).plan.execution, undefined);
    } finally { lock.release(); await lock.done; await opened; }
  });
}

for (const action of ['save', 'refresh']) {
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
      assert.deepEqual(h.entries.filter(entry => entry.customType === 'hyperion-plan.draft').at(-1).data, draft);
      assert.deepEqual(h.messages, []);
      assert.ok(h.notices.some(text => /not written or queued/.test(text)));
    } finally { lock.release(); await lock.done; await opened; }
  });
}

test('a turn starting during lock release is reported as saved but not dispatched', { timeout: 10000 }, async t => {
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
    assert.deepEqual(h.messages, []);
    assert.ok(h.notices.some(text => /saved, but Pi became busy/.test(text)), h.notices.join('\n'));
    assert.ok(!h.notices.some(text => /Pi was asked to execute/.test(text)));
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
