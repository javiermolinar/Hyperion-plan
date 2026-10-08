const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const core = require('../dist/index.cjs');
const root = path.resolve(__dirname, '..');

// Legacy natural-language transport receipts and failed delivery. The current
// menu only emits Run/close/agents; inject retired intents at the controller boundary.
{
async function fixture(t, { steps, idle = true, text = 'Add coverage for cancellation', keys = ['n'], prepare } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plan.md');
  let plan = core.initialize({ title: 'Intent test', steps: steps ?? [
    { id: 'a', title: 'Selected', status: 'pending' }, { id: 'b', title: 'Unselected', status: 'pending' },
  ] });
  if (prepare) plan = prepare(plan);
  core.saveMarkdown(file, plan);
  const entries = [], messages = [], notices = [], events = new Map();
  let command, actor = 'intent-session', views = 0;
  const pi = {
    registerTool() {}, registerMessageRenderer() {}, registerCommand(_name, value) { command = value; },
    on(name, fn) { const list = events.get(name) ?? []; events.set(name, list); list.push(fn); return () => list.splice(list.indexOf(fn), 1); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage(content, options) { messages.push({ content, options }); },
  };
  (await import('../dist/hyperion-plan-pi.js')).default(pi);
  const ctx = { cwd: dir, mode: 'tui', isIdle: () => idle,
    sessionManager: { getSessionId: () => actor, getBranch: () => entries },
    ui: {
      notify(text) { notices.push(text); }, input: async () => text,
      confirm: async () => assert.fail('no second confirmation'),
      editor: async () => assert.fail('natural-language actions must not require JSON'),
      custom: async factory => {
        let action;
        const screen = factory({ requestRender() {}, terminal: { rows: 42 } },
          { fg: (_, s) => s, bg: (_, s) => s, bold: s => s }, {}, a => { action = a; });
        for (const key of views++ === 0 ? keys : ['\x1b']) {
          const stepId = screen.state.focusedStepId;
          const legacy = { n: { type: 'add', afterStepId: stepId }, e: { type: 'edit', stepId },
            m: { type: 'note', stepId }, '?': { type: 'ask', stepId }, x: { type: 'remove', stepId }, d: { type: 'decompose', stepId }, g: { type: 'refresh' } };
          if (legacy[key]) action = legacy[key]; else screen.handleInput(key);
        }
        assert.ok(action, 'screen must permit this request');
        return action;
      },
    },
  };
  return { pi, ctx, file, entries, messages, notices,
    changeSession: () => { actor = 'other-session'; },
    open: () => command.handler(file, ctx),
    read: () => core.loadPlanSnapshot(file),
    bytes: () => [file, core.markdownStatePath(file)].map(f => fs.readFileSync(f)),
    intent: () => entries.find(e => e.customType === 'hyperion-plan.intent')?.data,
  };
}

for (const [name, prepare] of [
  ['saved blocker', p => { p.steps[0].blocked_by = 'Awaiting fresh review evidence'; return p; }],
  ['missing prerequisite', p => { p.steps[0].depends_on = ['b']; p.steps.reverse(); return p; }],
  ['finished plan', p => core.setLifecycle(p, p.revision, 'finished')[0]],
  ['different owner', p => { p.execution_owner = 'other-owner'; return p; }],
  ['active independent review', p => core.applyRequest(p, { plan_id: p.plan_id, base_revision: p.revision,
    request_id: 'old-review', intent: 'review', review_mode: 'independent', target_step_ids: ['a'], operations: [] })[0]],
]) test(`Run with ${name} reaches the coordinator without fabricating canonical readiness`, async t => {
  const h = await fixture(t, { keys: name === 'missing prerequisite' ? ['\x1b[B', ' ', '\r'] : [' ', '\r'], prepare });
  const before = h.bytes(); await h.open();
  assert.deepEqual(h.bytes(), before);
  assert.equal(h.messages.length, 1, h.notices.join('\n'));
  assert.deepEqual(h.messages[0].options, { deliverAs: 'followUp' });
  assert.deepEqual(h.intent().request.selected_step_ids, ['a']);
  assert.deepEqual(h.intent().displayed_steps.map(s => s.id), ['a']);
  assert.match(h.messages[0].content, /current user intent/);
  assert.match(h.messages[0].content, /do not ask for another Run/);
  assert.match(h.messages[0].content, /Missing real unselected prerequisites remain outside authority/);
});

test('busy Run queues once without replacing active canonical authority', async t => {
  const h = await fixture(t, { idle: false, keys: [' ', '\r'], prepare: p => core.applyRequest(p, {
    plan_id: p.plan_id, base_revision: p.revision, request_id: 'active-run', intent: 'implement', operations: [], selected_step_ids: ['b'],
  })[0] });
  const before = h.bytes(); await h.open();
  assert.deepEqual(h.bytes(), before);
  assert.deepEqual((await h.read()).plan.execution.selected_step_ids, ['b']);
  assert.deepEqual(h.intent().request.selected_step_ids, ['a']);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].options, { deliverAs: 'followUp' });
  assert.match(h.messages[0].content, /First drain\/reconcile any existing execution/);
});

for (const [key, phrase] of [['n', 'add'], ['e', 'edit'], ['m', 'note'], ['?', 'asks about'], ['x', 'Remove planned'], ['d', 'Decompose']]) {
  test(`legacy ${key} intent remains plan-only, including while busy`, async t => {
    const h = await fixture(t, { idle: false, keys: [key] });
    const before = h.bytes(); await h.open();
    assert.deepEqual(h.bytes(), before);
    assert.equal(h.messages.length, 1, h.notices.join('\n'));
    assert.match(h.messages[0].content, new RegExp(phrase));
    assert.match(h.messages[0].content, /no implementation|do not implement|Do not revert code or execute/i);
  });
}

test('Ask preserves conflicting drafts as context without requiring Save or granting execution', async t => {
  const h = await fixture(t, { keys: ['?'] });
  const snapshot = await h.read();
  const draft = { path: snapshot.path, plan_id: snapshot.plan.plan_id, base_plan: snapshot.plan,
    base_revision: snapshot.plan.revision, base_digest: snapshot.source_digest,
    operations: [{ type: 'update_step', step_id: 'a', fields: { title: 'Unsent title' } }] };
  h.entries.push({ type: 'custom', customType: 'hyperion-plan.draft', data: draft });
  const updated = core.clone(snapshot.plan); updated.revision++; updated.steps[1].title = 'Changed outside';
  core.saveMarkdown(h.file, updated);
  const before = h.bytes(); await h.open();
  assert.deepEqual(h.bytes(), before);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.intent().draft.operations, draft.operations);
  assert.deepEqual(h.entries.filter(e => e.customType === 'hyperion-plan.draft').at(-1).data, draft);
  assert.match(h.messages[0].content, /draft edits are context only/);
});

test('session replacement during input does not send intent or approval to the replacement', async t => {
  const h = await fixture(t);
  h.ctx.ui.input = async () => { h.changeSession(); return 'Add new work'; };
  const before = h.bytes(); await h.open();
  assert.deepEqual(h.bytes(), before);
  assert.equal(h.messages.length, 0);
  assert.equal(h.intent(), undefined);
  assert.ok(h.notices.some(n => /screen\/session changed/.test(n)));
});

test('transport failure retains submitted draft context without claiming delivery or auto-replaying', async t => {
  const h = await fixture(t, { idle: false, keys: [' ', '\r'] });
  h.pi.sendUserMessage = () => { throw new Error('transport unavailable'); };
  const before = h.bytes(); await h.open();
  assert.deepEqual(h.bytes(), before);
  assert.ok(h.intent());
  assert.equal(h.entries.some(e => e.customType === 'hyperion-plan.intent-delivered'), false);
  assert.equal(h.messages.length, 0);
  assert.ok(h.notices.some(n => /transport unavailable/.test(n)));
});

test('manual refresh is read-only even when canonical Markdown needs reconciliation', async t => {
  const h = await fixture(t, { idle: false, keys: ['g'] });
  fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('# Intent test', '# External change'));
  const before = h.bytes(); await h.open();
  assert.deepEqual(h.bytes(), before);
  assert.equal(h.messages.length, 0);
  assert.equal((await h.read()).refresh_required, true);
});
}

// Canonical admission races and same-session delivery
{
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
  let command, idle = true, watchIdle = false, views = 0, branch = entries;
  const pi = {
    registerTool() {}, registerMessageRenderer() {}, registerCommand(_name, value) { command = value; },
    on(name, fn) {
      const list = handlers.get(name) ?? []; handlers.set(name, list); list.push(fn);
      return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
    },
    appendEntry(customType, data) { branch.push({ type: 'custom', customType, data }); },
    sendUserMessage(content, options) { assert.equal(options?.deliverAs, 'followUp', 'explicit requests survive busy races without steering active work'); messages.push(content); },
  };
  (await import('../dist/hyperion-plan-pi.js')).default(pi);
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const ctx = {
    cwd: dir, mode: 'tui',
    isIdle() { if (watchIdle) attempting.resolve(); return idle; },
    sessionManager: { getSessionId: () => 'race-session', getBranch: () => branch },
    ui: {
      notify(message) { notices.push(message); },
      custom: async factory => {
        let action;
        const screen = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, value => { action = value; });
        if (views++ === 0) {
          if (actionType === 'run') {
            if (steps[0].id !== 'a') screen.handleInput('\x1b[B');
            screen.handleInput(' '); screen.handleInput('\r');
          } else action = { type: actionType }; // Legacy controller receipt, not a hidden shortcut.
          assert.equal(action?.type, actionType, 'fixture action must be available before the race');
          watchIdle = true;
        } else screen.handleInput('\x1b');
        return action;
      },
    },
  };
  return {
    file, entries, notices, messages, ctx, attempting,
    setIdle(value) { idle = value; },
    setBranch(value) { branch = value; },
    async emit(name) { for (const fn of [...(handlers.get(name) ?? [])]) await fn({}, ctx); },
    prependHandler(name, fn) { handlers.set(name, [fn, ...(handlers.get(name) ?? [])]); },
    emitWith(emit, name) {
      return emit.call({ extensions: [{ path: 'fixture', handlers }], createContext: () => ctx,
        isSessionBeforeEvent: () => false, emitError: error => assert.fail(error.error) }, { type: name });
    },
    open: () => command.handler(file, ctx),
    read: () => core.loadPlanSnapshot(file),
  };
}
for (const deferred of [false, true]) test(`native ${deferred ? 'deferred ' : ''}Run offers host-provided external review with read-only Hyperion fallback`, async t => {
  const h = await harness(t, [
    { id: 'pre', title: 'Completed implementation', status: 'completed' },
    { id: 'a', title: 'Inspect implementation', kind: 'review', status: 'pending', depends_on: ['pre'], checks: ['Inspect actual behavior'] },
  ]);
  if (deferred) h.setIdle(false);
  await h.open();
  assert.equal(h.messages.length, 1, h.notices.join('\n'));
  assert.match(h.messages[0], /Prefer an explicitly authorized external fresh reviewer/);
  assert.match(h.messages[0], /available host delegation facility/);
  assert.doesNotMatch(h.messages[0], /\b[a-z]+_start_pi\b/, 'review guidance must not name external session tools');
  assert.match(h.messages[0], /hyperion_agent as the fallback when that path is unavailable and no reviewer has launched/);
  assert.match(h.messages[0], /External reviewers require an in_progress checkpoint before launch/);
  assert.match(h.messages[0], /hyperion_agent run preflights and checkpoints its own start/);
  assert.match(h.messages[0], /write_paths: \[\]/);
  assert.match(h.messages[0], /not parent history or a suggested verdict/);
  assert.match(h.messages[0], /do not automatically return results here/);
  assert.match(h.messages[0], /uncertain launch or settlement never permits switching paths/);
  assert.match(h.messages[0], /fallback cannot run shell commands or tests/);
  assert.match(h.messages[0], /findings do not authorize fixes/i);
  if (deferred) assert.equal((await h.read()).plan.execution, undefined);
  else assert.deepEqual((await h.read()).plan.execution.selected_step_ids, ['a']);
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
  assert.ok(h.messages[0].includes(core.CHECKPOINT_INSTRUCTIONS));
  assert.ok(h.messages[0].includes(core.OWNERSHIP_INSTRUCTIONS));
  assert.match(h.messages[0],/Explicit sequential mode preserves plan order/);
  assert.match(h.messages[0],/hyperion_agent runs one foreground assignment/); assert.match(h.messages[0],/current user restrictions on worker sessions/);
  assert.match(h.messages[0],/verify acceptance before a separate completion checkpoint/);
  assert.match(h.messages[0],/Read only the Pi native screen section/);
  assert.match(h.messages[0],/no separate show\/start checkpoint is needed/);
  assert.match(h.messages[0],/structured rejected result means no native session launched/);
  const requirements = JSON.parse(h.messages[0].split('Selected requirements (data): ')[1].split('\n\n')[0]);
  assert.deepEqual(requirements.map(step => step.id), ['a']);
  assert.equal(requirements[0].title, (await h.read()).plan.steps[0].title);
  assert.doesNotMatch(h.messages[0],/hyperion_wave|hyperion_handover/);
  assert.doesNotMatch(h.messages[0],/For selected code-review steps only/, 'implementation-only Run does not authorize review');
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

for (const action of ['run', 'save']) for (const event of ['session_tree', 'session_shutdown']) test(`review fix F3: ${action} committed before ${event} cannot clear the destination draft`, { timeout: 10000 }, async t => {
  const h = await harness(t, undefined, action), snapshot = await h.read();
  const draft = { path: snapshot.path, plan_id: snapshot.plan.plan_id, base_plan: snapshot.plan, base_revision: snapshot.plan.revision,
    base_digest: snapshot.source_digest, operations: [{ type: 'update_step', step_id: 'a', fields: { title: 'Source draft' } }] };
  h.entries.push({ type: 'custom', customType: 'hyperion-plan.draft', data: draft });
  const destination = [{ type: 'custom', customType: 'hyperion-plan.draft', data: { ...draft,
    operations: [{ type: 'update_step', step_id: 'a', fields: { title: 'Destination draft' } }] } }];
  const before = structuredClone(destination);
  const lockfile = require('proper-lockfile'), original = lockfile.lock, saved = deferred(), release = deferred();
  lockfile.lock = async (...args) => { const unlock = await original(...args); return async () => { saved.resolve(); await release.promise; await unlock(); }; };
  let opened;
  try {
    opened = h.open(); await saved.promise;
    assert.equal((await h.read()).plan.steps[0].title, 'Source draft', 'commit already happened');
    h.setBranch(destination); await h.emit(event); release.resolve(); await opened;
    assert.deepEqual(destination, before, 'no screen-owned persistence on the replacement branch');
    assert.equal(h.messages.length, 0);
    assert.ok(h.notices.some(n => /screen\/session changed/.test(n)));
    assert.equal((await h.read()).plan.steps[0].title, 'Source draft', 'commit is not rolled back');
  } finally { release.resolve(); await opened; lockfile.lock = original; }
});

// The pinned SDK emitter replaces the duplicate serial-mock matrix. Keep each
// distinct invalidation and same-session busy/idle outcome at the host boundary.
for (const event of ['session_tree', 'session_shutdown', 'session_id', 'idle', 'busy']) test(`Discard delivery after ${event} with pinned SDK preserves branch isolation`, async t => {
  const { ExtensionRunner } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
  const h = await harness(t), snapshot = await h.read();
  let dispatch;
  const emit = name => h.emitWith(ExtensionRunner.prototype.emit, name);
  const draft = title => ({ type: 'custom', customType: 'hyperion-plan.draft', data: {
    path: snapshot.path, plan_id: snapshot.plan.plan_id, base_plan: snapshot.plan, base_revision: snapshot.plan.revision,
    base_digest: snapshot.source_digest, operations: [{ type: 'update_step', step_id: 'a', fields: { title } }],
  } });
  h.entries.push(draft('Source draft'));
  const destination = [draft('Destination draft')], sourceBefore = structuredClone(h.entries.filter(e => e.customType === 'hyperion-plan.draft')),
    before = structuredClone(destination), diskBefore = files(h.file);
  h.ctx.ui.custom = factory => new Promise(resolve => {
    const screen = factory({ requestRender() {}, terminal: { rows: 40 } },
      { fg: (_, s) => s, bg: (_, s) => s, bold: s => s }, {}, resolve);
    resolve({ type: 'discard' }); // Legacy receipt: resolve before the controller resumes.
    if (event === 'idle' || event === 'busy') {
      h.setIdle(event === 'idle');
      // The next overlay closes after the valid discard; busy does not prohibit local draft changes.
      h.ctx.ui.custom = async () => ({ type: 'close' });
    } else {
      h.setBranch(destination);
      if (event === 'session_id') {
        h.ctx.sessionManager.getSessionId = () => 'replacement-session';
        h.ctx.ui.custom = async () => ({ type: 'close' });
      } else dispatch = emit(event);
    }
  });
  await h.open(); await dispatch;
  assert.deepEqual(destination, before, 'no destination-branch draft writes');
  assert.deepEqual(files(h.file), diskBefore, 'Discard never mutates canonical storage');
  assert.equal(h.messages.length, 0);
  if (event === 'idle' || event === 'busy') {
    assert.deepEqual(h.entries.filter(e => e.customType === 'hyperion-plan.draft').at(-1).data.operations, []);
    assert.equal(h.entries.filter(e => e.customType === 'hyperion-plan.draft').length, 2);
  } else {
    assert.deepEqual(h.entries.filter(e => e.customType === 'hyperion-plan.draft'), sourceBefore, 'invalidated Discard also preserves the source draft');
    assert.ok(h.notices.some(n => /screen\/session changed/.test(n)));
  }
});

for (const beforeEvent of ['session_before_tree', 'session_before_switch', 'session_before_fork']) test(`postfix fix R1: ${beforeEvent} fences writes while an earlier SDK post-event listener waits`, async t => {
  const { ExtensionRunner } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
  const h = await harness(t), snapshot = await h.read(), entered = deferred(), release = deferred();
  const draft = title => ({ type: 'custom', customType: 'hyperion-plan.draft', data: {
    path: snapshot.path, plan_id: snapshot.plan.plan_id, base_plan: snapshot.plan, base_revision: snapshot.plan.revision,
    base_digest: snapshot.source_digest, operations: [{ type: 'update_step', step_id: 'a', fields: { title } }],
  } });
  h.entries.push(draft('Source draft'));
  const destination = [draft('Destination draft')], before = structuredClone(destination), diskBefore = files(h.file);
  h.prependHandler('session_tree', async () => { entered.resolve(); await release.promise; });
  let dispatch;
  h.ctx.ui.custom = async factory => {
    let action;
    const screen = factory({ requestRender() {}, terminal: { rows: 40 } },
      { fg: (_, s) => s, bg: (_, s) => s, bold: s => s }, {}, value => { action = value; });
    // The pinned host awaits before-events before changing branch, then awaits post-listeners serially.
    await h.emitWith(ExtensionRunner.prototype.emit, beforeEvent);
    action = { type: 'discard' }; h.setBranch(destination);
    dispatch = h.emitWith(ExtensionRunner.prototype.emit, 'session_tree');
    await entered.promise;
    h.ctx.ui.custom = async () => ({ type: 'close' });
    return action;
  };
  try {
    await h.open();
    assert.deepEqual(destination, before, 'validity cannot depend on reaching any Hyperion post-event listener');
    assert.deepEqual(files(h.file), diskBefore);
    assert.deepEqual(h.entries.filter(e => e.customType === 'hyperion-plan.draft').map(e => e.data.operations), [draft('Source draft').data.operations]);
    assert.equal(h.messages.length, 0);
    assert.ok(h.notices.some(n => /screen\/session changed/.test(n)));
  } finally { release.resolve(); await dispatch; }
});

for (const dirty of [false, true]) test(`review fix F1: manual Refresh rejects replacement identity with draft=${dirty}`, async t => {
  const h = await harness(t), original = await h.read();
  if (dirty) h.entries.push({ type: 'custom', customType: 'hyperion-plan.draft', data: {
    path: original.path, plan_id: original.plan.plan_id, base_plan: original.plan, base_revision: original.plan.revision,
    base_digest: original.source_digest, operations: [{ type: 'update_step', step_id: 'a', fields: { title: 'Original draft' } }],
  } });
  const drafts = structuredClone(h.entries); let views = 0, replacementBytes;
  h.ctx.ui.custom = async factory => {
    let action;
    const screen = factory({ requestRender() {}, terminal: { rows: 40 } }, { fg: (_, s) => s, bg: (_, s) => s, bold: s => s }, {}, a => { action = a; });
    if (views++ === 0) {
      screen.handleInput(' ');
      fs.unlinkSync(h.file); fs.unlinkSync(core.markdownStatePath(h.file));
      core.saveMarkdown(h.file, core.initialize({ title: 'Replacement plan', steps: [{ id: 'a', title: 'Replacement work' }] }));
      replacementBytes = files(h.file); action = { type: 'refresh' }; // Legacy receipt.
    } else {
      const frame = screen.render(120).join('\n');
      assert.match(frame, /Race regression/); assert.doesNotMatch(frame, /Replacement plan/);
      assert.match(frame, /1 selected/); if (dirty) assert.match(frame, /Original draft/);
      screen.handleInput('\x1b');
    }
    return action;
  };
  await h.open();
  assert.deepEqual(files(h.file), replacementBytes);
  assert.deepEqual(h.entries.filter(e => e.customType === 'hyperion-plan.draft'), drafts);
  assert.ok(h.notices.some(n => /replaced/i.test(n)));
  assert.equal(h.messages.length, 0);
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
}
