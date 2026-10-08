const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const core = require('../dist/index.cjs');
const root = path.resolve(__dirname, '..');

// Coordinator admission, external outcomes and compatibility
{
function fixture(t, kind) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-outcomes-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plan.md');
  let plan = core.initialize({ title: 'External outcomes', steps: [
    { id: 'code', title: 'Existing code', status: 'completed' },
    { id: 'review', title: 'Inspect code', kind: 'review', depends_on: ['code'], checks: ['Check compatibility'] },
    { id: 'later', title: 'Unselected implementation' },
  ] });
  plan.execution_owner = 'coordinator';
  plan = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'requested', operations: [],
    ...(kind === 'code' ? { intent: 'implement', selected_step_ids: ['review'] }
      : { intent: 'review', review_mode: 'independent', target_step_ids: ['code', 'later'] }) })[0];
  if (kind === 'code') plan = core.checkpoint(plan, plan.revision, 'review', 'in_progress', 'Review started')[0];
  core.saveMarkdown(file, plan);
  const legacy = path.join(dir, '.hyperion-dispatch', 'plan.md', 'ledger.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  // Terminal historical evidence must remain readable without recertifying artifacts.
  const record = { schema_version: 1, assignment: { assignment_id: 'old', plan_path: file, plan_id: plan.plan_id, role: 'review', owner: { host: 'pi', native_id: 'coordinator' } },
    attempt_id: 'old-attempt', phase: 'settled', history: [], review: { old_schema: true },
    handle: { assignment_id: 'old', session: { host: 'pi', native_id: 'old-reviewer' } },
    result: { assignment_id: 'old', session: { host: 'pi', native_id: 'old-reviewer' }, outcome: 'succeeded',
      quiescence: { state: 'verified', evidence: ['Historical settlement'] } } };
  fs.writeFileSync(legacy, JSON.stringify({ schema_version: 1, plan_path: file, records: [record] }));
  const history = fs.readFileSync(legacy, 'utf8');
  return { dir, file, plan, legacy, history };
}
function cli(f, actor, args) {
  return spawnSync(process.execPath, [path.join(root, 'dist/plan.cjs'), ...args, '--plan', f.file, '--task-id', actor], { encoding: 'utf8' });
}

for (const route of ['service', 'CLI']) for (const kind of ['code', 'plan']) {
  test(`coordinator records external ${kind} review via ${route}, preserving legacy history and authority`, async t => {
    const f = fixture(t, kind), before = f.plan;
    const update = { request_id: 'requested', state: 'completed', task_id: 'external-reviewer', report_path: path.join(f.dir, 'external-report.md'),
      note: 'Coordinator inspected external report; no machine certification. Runtime checks not performed.',
      findings: [{ step_ids: ['later'], text: 'Rollback needs a decision', resolution: 'needs_input', reason: 'Retain the unresolved decision' }] };
    if (kind === 'code') {
      if (route === 'service') await core.mutatePlan(f.file, 'coordinator', p => core.checkpoint(p, p.revision, 'review', 'completed', 'Coordinator inspected external compatibility report'));
      else { const r = cli(f, 'coordinator', ['checkpoint', '--base-revision', String(before.revision), '--step-id', 'review', '--status', 'completed', '--note', 'Coordinator inspected external compatibility report']); assert.equal(r.status, 0, r.stderr); }
    } else {
      if (route === 'service') await core.mutatePlan(f.file, 'coordinator', p => core.updatePlanReview(p, p.revision, update));
      else {
        const input = path.join(f.dir, 'update.json'); fs.writeFileSync(input, JSON.stringify(update));
        const r = cli(f, 'coordinator', ['plan-review', '--base-revision', String(before.revision), '--input', input]); assert.equal(r.status, 0, r.stderr);
      }
    }
    const after = (await core.loadPlanSnapshot(f.file)).plan;
    assert.equal(kind === 'code' ? after.steps[1].status : after.plan_reviews[0].state, 'completed');
    if (kind === 'plan') {
      assert.deepEqual(after.plan_reviews[0].findings, update.findings);
      assert.equal(after.plan_reviews[0].revision, before.plan_reviews[0].revision);
      assert.deepEqual(after.steps, before.steps);
    }
    assert.deepEqual(after.execution, before.execution);
    assert.equal(after.steps[2].status, 'pending');
    assert.equal(after.execution_owner, 'coordinator');
    assert.equal(fs.readFileSync(f.legacy, 'utf8'), f.history);
  });
}
for (const fault of ['owner', 'revision', 'evidence']) test(`external review checkpoint rejects wrong ${fault}`, async t => {
  const f = fixture(t, 'code'), bytes = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(core.mutatePlan(f.file, fault === 'owner' ? 'other' : 'coordinator', p =>
    core.checkpoint(p, fault === 'revision' ? p.revision - 1 : p.revision, 'review', 'completed', fault === 'evidence' ? '' : 'Inspected report')));
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), f.history);
});
test('unresolved legacy review is preserved rather than recovered or certified', async t => {
  const f = fixture(t, 'code');
  const data = JSON.parse(f.history); data.records[0].phase = 'uncertain';
  fs.writeFileSync(f.legacy, JSON.stringify(data));
  const bytes = fs.readFileSync(f.legacy, 'utf8');
  const call = await planTool(f);
  await assert.rejects(call({ action: 'checkpoint', plan_id: f.plan.plan_id, base_revision: f.plan.revision,
    update: JSON.stringify({ execution_request_id: 'requested', step_id: 'review', status: 'completed', note: 'Cannot certify unresolved history' }) }), /Unresolved legacy dispatch/);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), bytes);
});
async function planTool(f, actor = 'coordinator', entries = []) {
  let tool, sequence = 0;
  const extension = (await import(pathToFileURL(path.join(root, 'dist/hyperion-plan-pi.js')))).default;
  extension({ on() { return () => {}; }, registerTool(t) { if (t.name === 'hyperion_plan') tool = t; }, registerCommand() {}, registerMessageRenderer() {} });
  const ctx = { cwd: f.dir, mode: 'json', sessionManager: { getSessionId: () => actor, getBranch: () => entries } };
  return async (params, id = `provider/call:${++sequence}`) => (await tool.execute(id, { path: f.file, ...params }, undefined, undefined, ctx)).details;
}

test('native explicit submit and checkpoint preserve scope, pause/cancel and coordinator evidence', async t => {
  const f = fixture(t, 'code'), call = await planTool(f);
  const checkpoint = async update => {
    const { plan } = await core.loadPlanSnapshot(f.file);
    return call({ action: 'checkpoint', plan_id: plan.plan_id, base_revision: plan.revision,
      update: JSON.stringify({ execution_request_id: plan.execution.request_id, ...update }) });
  };
  await assert.rejects(checkpoint({ step_id: 'later', status: 'in_progress' }), /outside/);
  await checkpoint({ execution_state: 'paused' });
  await assert.rejects(checkpoint({ step_id: 'review', status: 'completed', note: 'Cannot accept while paused' }), /paused/);
  await checkpoint({ execution_state: 'cancelled' });
  await assert.rejects(checkpoint({ step_id: 'review', status: 'in_progress' }), /cancelled/);
  let { plan } = await core.loadPlanSnapshot(f.file);
  const request = { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'current-user-run', intent: 'implement', operations: [], selected_step_ids: ['review'] };
  const admitted = await call({ action: 'submit', request: JSON.stringify(request) });
  assert.equal(admitted.plan.execution.state, 'approved');
  assert.equal(admitted.plan.steps[2].status, 'pending');
  await assert.rejects(checkpoint({ step_id: 'review', status: 'completed' }), /evidence/);
  const done = await checkpoint({ step_id: 'review', status: 'completed', note: 'Coordinator inspected the external report' });
  assert.equal(done.plan.steps[1].status, 'completed');
  assert.equal(done.plan.steps[2].status, 'pending');
  const replay = await call({ action: 'submit', request: JSON.stringify(request) });
  assert.equal(replay.changed, false);
});

test('native request admission enforces prerequisites and tool-derived retry IDs are valid/stable', async t => {
  const f = fixture(t, 'code'), call = await planTool(f);
  let { plan } = await core.loadPlanSnapshot(f.file);
  const edit = { action: 'edit', plan_id: plan.plan_id, base_revision: plan.revision,
    operations: JSON.stringify([{ type: 'update_step', step_id: 'later', fields: { depends_on: ['review'] } }]) };
  const changed = await call(edit, 'unsafe:provider/tool_call+123');
  assert.equal((await call(edit, 'unsafe:provider/tool_call+123')).changed, false);
  plan = changed.plan;
  await assert.rejects(call({ action: 'submit', request: JSON.stringify({ plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: 'missing-prerequisite', intent: 'implement', operations: [], selected_step_ids: ['later'] }) }), /prerequisite/i);
});

for (const fault of ['uncertain', 'missing-settlement', 'missing-identity', 'missing-history', 'unreconciled-wave', 'malformed', 'missing-ledger', 'dangling-link']) {
  test(`native execution holds ${fault} legacy history without mutation or relaunch`, async t => {
    const f = fixture(t, 'code'), call = await planTool(f), data = JSON.parse(f.history);
    if (fault === 'uncertain') data.records[0].phase = 'uncertain';
    if (fault === 'missing-settlement') delete data.records[0].result.quiescence;
    if (fault === 'missing-identity') delete data.records[0].assignment.assignment_id;
    if (fault === 'missing-history') delete data.records[0].history;
    if (fault === 'unreconciled-wave') data.waves = [{ closed: true, plan_id: f.plan.plan_id }];
    fs.writeFileSync(f.legacy, fault === 'malformed' ? '{invalid' : JSON.stringify(data));
    if (fault === 'missing-ledger') { fs.unlinkSync(f.legacy); fs.mkdirSync(path.join(path.dirname(f.legacy), 'orphan-assignment')); }
    if (fault === 'dangling-link') { fs.unlinkSync(f.legacy); fs.symlinkSync(path.join(f.dir, 'absent'), f.legacy); }
    const bytes = fs.readFileSync(f.file, 'utf8');
    const request = { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'next-run', intent: 'implement', operations: [], selected_step_ids: ['review'] };
    await assert.rejects(call({ action: 'submit', request: JSON.stringify(request) }));
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
    assert.equal((await call({ action: 'show' })).plan_id, f.plan.plan_id, 'inspection stays available');
  });
}

test('native independent outcome preserves reviewer identity, revision and implementation isolation', async t => {
  const f = fixture(t, 'plan'), call = await planTool(f);
  const recorded = await call({ action: 'plan-review', plan_id: f.plan.plan_id, base_revision: f.plan.revision,
    update: JSON.stringify({ request_id: 'requested', state: 'completed', task_id: 'external', report_path: '/report.md', note: 'Inspected external report; runtime checks unavailable', findings: [] }) });
  assert.equal(recorded.plan.plan_reviews[0].state, 'completed');
  assert.deepEqual(recorded.plan.execution, f.plan.execution);
  assert.deepEqual(recorded.plan.steps, f.plan.steps);
});

for (const uncertain of ['native', 'legacy']) test(`review fix F2: completed independent outcomes hold ${uncertain} activity but allow limitation recording`, async t => {
  const f = fixture(t, 'plan');
  const entries = uncertain === 'native' ? [{ type: 'custom', customType: 'hyperion.agent', data: { id: 'unsettled', native_id: 'external', transcript_path: '/fixture-session.jsonl', state: 'running', settled: false } }] : [];
  if (uncertain === 'legacy') {
    const data = JSON.parse(f.history); data.records[0].phase = 'uncertain'; fs.writeFileSync(f.legacy, JSON.stringify(data));
  }
  const call = await planTool(f, 'coordinator', entries), history = fs.readFileSync(f.legacy, 'utf8');
  const update = { request_id: 'requested', state: 'completed', task_id: 'external', report_path: '/report.md', note: 'Inspected report', findings: [] };
  const artifacts = () => [f.file, core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8'));
  const before = artifacts();
  await assert.rejects(call({ action: 'plan-review', plan_id: f.plan.plan_id, base_revision: f.plan.revision, update: JSON.stringify(update) }), /[Uu]nsettled|[Uu]nresolved|[Uu]nknown/);
  assert.deepEqual(artifacts(), before);
  const limited = await call({ action: 'plan-review', plan_id: f.plan.plan_id, base_revision: f.plan.revision,
    update: JSON.stringify({ ...update, state: 'blocked', note: 'Runtime settlement remains unverified' }) });
  assert.equal(limited.plan.plan_reviews[0].state, 'blocked');
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), history);
});

for (const [name, runtime, accepted] of [
  ['absent', undefined, true], ['ready', { phase: 'ready', quiescence: { state: 'verified', evidence: ['Settled'] } }, true],
  ['failed', { phase: 'failed', quiescence: { state: 'verified', evidence: ['Settled'] } }, true],
  ['null', null, false], ['false', false, false], ['zero', 0, false], ['empty-string', '', false],
  ['array', [], false], ['empty-object', {}, false], ['unfinished', { phase: 'started' }, false],
  ['invalid-json', '{invalid', false],
]) test(`review fix F4: legacy handover runtime ${name} is distinguished from absence`, async t => {
  const f = fixture(t, 'code');
  let p = f.plan;
  [p] = core.applyRequest(p, { plan_id: p.plan_id, base_revision: p.revision, request_id: 'transfer', intent: 'handover', operations: [], target_step_ids: [], handover_reason: 'Fixture transfer' });
  [p] = core.updateHandover(p, p.revision, { request_id: 'transfer', state: 'prepared', brief_path: '/brief.md', summary: 'Fixture', next_action: 'Inspect', code_state: 'Disposable' }, 'coordinator');
  [p] = core.updateHandover(p, p.revision, { request_id: 'transfer', state: 'transferred', destination_task_id: 'destination' }, 'coordinator');
  core.saveMarkdown(f.file, p);
  const dir = path.join(path.dirname(f.legacy), 'handovers', 'transfer'); fs.mkdirSync(dir, { recursive: true });
  const settled = { state: 'verified', evidence: ['Terminal fixture'] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schema_version: 1, plan_id: p.plan_id, plan_path: f.file,
    request_id: 'transfer', source_id: 'coordinator', phase: 'transferred', destination: { native_id: 'destination' }, source_settlement: settled, settlement: settled }));
  const runtimePath = path.join(dir, 'runtime.json');
  if (runtime !== undefined) fs.writeFileSync(runtimePath, name === 'invalid-json' ? runtime : JSON.stringify(runtime));
  const before = fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath, 'utf8') : undefined;
  const call = await planTool(f, 'destination');
  const pending = call({ action: 'submit', request: JSON.stringify({ plan_id: p.plan_id, base_revision: p.revision, request_id: 'next-run', intent: 'implement', operations: [], selected_step_ids: ['review'] }) });
  if (accepted) assert.equal((await pending).plan.execution.request_id, 'next-run');
  else await assert.rejects(pending, /legacy/);
  assert.equal(fs.existsSync(runtimePath) ? fs.readFileSync(runtimePath, 'utf8') : undefined, before);
});

for (const action of ['submit', 'checkpoint', 'plan-review']) test(`review fix F5: ${action} rejects replacement before implicit refresh writes`, async t => {
  const f = fixture(t, action === 'plan-review' ? 'plan' : 'code'), call = await planTool(f);
  const lockfile = require('proper-lockfile'), original = lockfile.lock;
  let entered, resume;
  const waiting = new Promise(r => { entered = r; }), released = new Promise(r => { resume = r; });
  lockfile.lock = async (...args) => { entered(); await released; return original(...args); };
  let pending;
  try {
    const params = action === 'submit' ? { action, request: JSON.stringify({ plan_id: f.plan.plan_id, base_revision: f.plan.revision,
      request_id: 'next-run', intent: 'implement', operations: [], selected_step_ids: ['review'] }) }
      : { action, plan_id: f.plan.plan_id, base_revision: f.plan.revision, update: JSON.stringify(action === 'checkpoint'
        ? { execution_request_id: 'requested', step_id: 'review', status: 'completed', note: 'Inspected report' }
        : { request_id: 'requested', state: 'completed', task_id: 'external', report_path: '/report.md', note: 'Inspected report', findings: [] }) };
    pending = call(params).then(() => null, e => e);
    await waiting;
    fs.unlinkSync(f.file); fs.unlinkSync(core.markdownStatePath(f.file));
    const replacement = core.initialize({ title: 'Replacement', steps: [{ id: 'review', title: 'Other work' }] });
    core.saveMarkdown(f.file, replacement);
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('# Replacement', '# External replacement'));
    const capture = dir => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name); return e.isDirectory() ? Object.entries(capture(p)) : [[p, fs.readFileSync(p, 'utf8')]];
    }));
    const before = capture(f.dir);
    resume(); assert.match(String(await pending), /replaced|identity/i);
    assert.deepEqual(capture(f.dir), before, 'canonical, sidecar, exports and recovery artifacts must be untouched');
  } finally { resume(); await pending; lockfile.lock = original; }
});

test('historical source tags never fence ordinary Pi tools or user bash', async t => {
  const f = fixture(t, 'code'), handlers = new Map();
  const extension = (await import(pathToFileURL(path.join(root, 'dist/hyperion-plan-pi.js')))).default;
  extension({ on(name, handler) { const all = handlers.get(name) ?? []; all.push(handler); handlers.set(name, all); return () => {}; }, registerTool() {}, registerCommand() {}, registerMessageRenderer() {} });
  const tag = { type: 'custom', customType: 'hyperion.handover-source', data: { plan_path: f.file, plan_id: f.plan.plan_id } };
  const ctx = { sessionManager: { getSessionId: () => 'old-source', getEntries: () => [tag], getBranch: () => [] } };
  const results = await Promise.all((handlers.get('tool_call') ?? []).map(h => h({}, ctx)));
  assert.ok(results.every(r => !r?.block));
  for (const handler of handlers.get('user_bash') ?? []) await handler({}, ctx);
});
test('production boundaries separate footer presentation with no reverse core or handler plan imports', () => {
  assert.deepEqual(fs.readdirSync(path.join(root, 'src/pi')).sort(), ['context.ts', 'executor.ts', 'extension.ts', 'footer.ts', 'subagents.ts', 'ui.ts']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tests')).filter(f => /^pi.*\.test\.cjs$/.test(f)).sort(),
    ['pi-context.test.cjs', 'pi-executor.test.cjs', 'pi-footer.test.cjs', 'pi-intent.test.cjs', 'pi-subagents.test.cjs', 'pi-ui.test.cjs']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tests/pi')).sort(), ['fixture.ts', 'terminal-smoke.cjs', 'terminal-workflow.cjs']);
  for (const file of ['service.ts', 'cli.ts']) assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', file), 'utf8'), /from ["']\.\/pi\//);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/pi/subagents.ts'), 'utf8'), /from ["']\.\.\/(model|service|transitions|execution-policy)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/pi/executor.ts'), 'utf8'), /from ["']\.\/ui/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/pi/ui.ts'), 'utf8'), /createAgentSession|mutatePlan|session\.prompt|switchSession/);
});
test('optional delegation can be disabled without changing the required plan surface', async () => {
  const before = process.env.HYPERION_DISABLE_AGENTS;
  try {
    process.env.HYPERION_DISABLE_AGENTS = '1';
    const extension = (await import(pathToFileURL(path.join(root, 'dist/hyperion-plan-pi.js')))).default, tools = [];
    extension({ on() { return () => {}; }, registerTool(t) { tools.push(t.name); }, registerCommand() {}, registerMessageRenderer() {} });
    assert.deepEqual(tools, ['hyperion_plan']);
  } finally { if (before === undefined) delete process.env.HYPERION_DISABLE_AGENTS; else process.env.HYPERION_DISABLE_AGENTS = before; }
});
test('retired review launch/setup exports and tools are absent', async () => {
  for (const bundle of ['pi-runner.js', 'pi-handover-journal.js', 'pi-handover-navigation.js', 'pi-handover-readiness.js']) assert.equal(fs.existsSync(path.join(root, 'dist', bundle)), false);
  const extension = (await import(pathToFileURL(path.join(root, 'dist/hyperion-plan-pi.js')))).default;
  const tools = [];
  extension({ on() { return () => {}; }, registerTool(t) { tools.push(t.name); }, registerCommand() {}, registerMessageRenderer() {} });
  assert.deepEqual(tools.sort(), ['hyperion_agent', 'hyperion_plan']);
});
}

// Plan tool, progress observation and lifecycle
{
async function harness(t, mode = "tui") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pi-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, "plan.md");
  const plan = core.initialize({ title: "Tool plan", steps: [
    { id: "a", title: "First", status: "pending", reasoning_effort: "medium" },
    { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  ] });
  core.saveMarkdown(planPath, plan);
  const entries = [], notifications = [], events = new Map(), handlers = new Map(), screens = [], messages = [], widgets = new Map();
  let tool, idle = false, session = "tool-session", counter = 0;
  const pi = {
    registerCommand(_name, value) { this.command = value; },
    registerTool(value) { if (value.name === 'hyperion_plan') tool = value; },
    registerMessageRenderer() {},
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      const list = handlers.get(name); list.push(handler);
      events.set(name, async (...args) => { for (const fn of [...list]) await fn(...args); });
      return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
    },
    sendMessage(message, options) {
      assert.deepEqual(options, { triggerTurn: false });
      messages.push(message);
      entries.push({ type: 'custom_message', ...message });
    },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage() { assert.fail("Plan management must not submit implementation work"); },
  };
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const ctx = {
    cwd: dir, mode, isIdle: () => idle,
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      setWidget(key, factory, options) {
        assert.deepEqual(options, factory ? { placement: 'aboveEditor' } : undefined);
        widgets.get(key)?.dispose?.();
        if (factory) widgets.set(key, factory({ requestRender() {} }, theme));
        else widgets.delete(key);
      },
      input: () => assert.fail("Prompt tools must not ask for paths through a dialog"),
      confirm: () => assert.fail("Prompt tools must not create implicitly"),
      custom: async factory => {
        const screen = factory({ requestRender() {}, terminal: { rows: 42 } }, theme, {}, () => {});
        screens.push(screen.render(120).join("\n"));
        return { type: "close" };
      },
    },
  };
  (await import("../dist/hyperion-plan-pi.js")).default(pi);
  t.after(() => events.get('session_shutdown')?.({}, ctx));
  return {
    dir, planPath, plan, entries, notifications, events, screens, messages, widgets, ctx, tool, command: pi.command,
    setIdle: value => { idle = value; },
    call: (params, signal, id = `call-${++counter}`) => tool.execute(id, params, signal, undefined, ctx),
    read: () => core.loadPlanSnapshot(planPath),
    setSession: value => { session = value; },
    settle: async () => {
      idle = true;
      await events.get("agent_settled")({}, ctx);
      // The UI is intentionally detached from the settlement event promise.
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}
function mutation(snapshot, fields = {}) {
  return { action: "edit", path: snapshot.path, plan_id: snapshot.plan.plan_id,
    base_revision: snapshot.plan.revision, operations: JSON.stringify([
      { type: "update_step", step_id: "a", fields: { title: "Renamed" } },
    ]), ...fields };
}

test("registers a discoverable sequential tool; show is read-only and supports focused steps", async t => {
  const h = await harness(t);
  assert.equal(h.tool.name, "hyperion_plan");
  assert.equal(h.tool.executionMode, "sequential");
  assert.deepEqual(h.tool.parameters.properties.action.anyOf.map(s => s.const),
    ['discover', 'open', 'show', 'create', 'edit', 'finish', 'reopen', 'submit', 'checkpoint', 'plan-review']);
  const files = [h.planPath, core.markdownStatePath(h.planPath)];
  const before = files.map(file => fs.readFileSync(file));
  const shown = await h.call({ action: "show", path: "plan.md" });
  assert.equal(shown.details.plan_id, h.plan.plan_id);
  assert.equal(shown.details.path, h.planPath);
  const focused = await h.call({ action: "show", path: "plan.md", step_id: "a" });
  assert.equal(focused.details.step.id, "a");
  assert.equal(focused.details.plan, undefined);
  await assert.rejects(h.call({ action: "show", path: "plan.md", step_id: "absent" }), /absent/);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
  assert.deepEqual(h.entries, []);
});

test("open binds the selected plan and opens an editable screen only after settlement", async t => {
  const h = await harness(t);
  const opened = await h.call({ action: "open", path: "plan.md" });
  assert.equal(opened.details.screen, "queued");
  assert.equal(h.screens.length, 0);
  assert.equal(h.entries.at(-1).data.path, h.planPath);
  assert.equal((await h.call({ action: "show" })).details.plan_id, h.plan.plan_id);
  assert.equal((await h.read()).plan.execution, undefined);
  await h.settle();
  assert.equal(h.screens.length, 1);
  assert.doesNotMatch(h.screens[0], /VIEW ONLY|Pi busy/);
  assert.equal((await h.read()).plan.execution, undefined);
  await h.settle();
  assert.equal(h.screens.length, 1);
});

test("an empty workspace and missing explicit paths fail without creating files", async t => {
  const h = await harness(t);
  fs.rmSync(h.planPath); fs.rmSync(core.markdownStatePath(h.planPath));
  await assert.rejects(h.call({ action: "open" }), /No compatible active Hyperion plan/);
  await assert.rejects(h.call({ action: "open", path: "missing.md" }), /ENOENT/);
  await assert.rejects(h.call({ action: "open", path: "  " }), /blank/);
  assert.equal(fs.existsSync(path.join(h.dir, "missing.md")), false);
  assert.deepEqual(h.entries, []);
});

test("non-TUI open reports the limitation; show and edits remain usable", async t => {
  for (const mode of ["rpc", "json", "print"]) {
    const h = await harness(t, mode);
    assert.equal((await h.call({ action: "open", path: "plan.md" })).details.screen, "unavailable");
    const saved = await h.call(mutation(await h.read(), { path: undefined }));
    assert.equal(saved.details.plan.steps[0].title, "Renamed");
    await h.settle();
    assert.equal(h.screens.length, 0);
  }
});

test("edits use exact revision checks, durable retry receipts and no execution approval", async t => {
  const h = await harness(t);
  const request = mutation(await h.read(), { request_id: "stable-edit" });
  const result = await h.call(request);
  assert.equal(result.details.changed, true);
  assert.equal(result.details.plan.steps[0].title, "Renamed");
  assert.equal(result.details.plan.execution, undefined);
  assert.match(fs.readFileSync(core.notesPath(h.planPath), "utf8"), /Renamed/);
  const retried = await h.call(request);
  assert.equal(retried.details.changed, false);
  assert.equal(retried.details.revision, result.details.revision);
  await assert.rejects(h.call({ ...request, request_id: "stale-edit" }), /Stale plan/);
  await assert.rejects(h.call({ ...request, operations: JSON.stringify([{ type: "remove_step", step_id: "b" }]) }), /reused/);
  await assert.rejects(h.call({ action: "edit", path: h.planPath, operations: request.operations }), /plan_id and base_revision/);
});

test("Pi rejects invalid edits but a stale coordinator owner cannot block ordinary edits", async t => {
  const h = await harness(t);
  let snapshot = await h.read();
  const before = fs.readFileSync(h.planPath);
  for (const operations of ["bad JSON", "{}", "[]", '[{"type":"remove_step","step_id":"a"}]',
    '[{"type":"update_step","step_id":"a","fields":{"status":"completed"}}]']) {
    await assert.rejects(h.call(mutation(snapshot, { operations })));
    assert.deepEqual(fs.readFileSync(h.planPath), before);
  }
  snapshot.plan.execution_owner = "someone-else";
  core.saveMarkdown(h.planPath, snapshot.plan);
  await h.call(mutation(await h.read()));
  assert.equal((await h.read()).plan.steps[0].title, "Renamed");
  assert.equal((await h.read()).plan.execution_owner, undefined);
});

for (const blocked of [false, true]) test(`ordinary Pi Run retires a ${blocked ? 'blocked' : 'prepared'} legacy handoff without transferring ownership`, async t => {
  const h = await harness(t);
  let plan = { ...h.plan, execution_owner: 'old-source' };
  [plan] = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: 'legacy-handoff', intent: 'handover', operations: [] });
  [plan] = core.updateHandover(plan, plan.revision, { request_id: 'legacy-handoff', state: 'prepared',
    destination_task_id: 'old-destination', brief_path: '/historical/brief.md', summary: 'Source finished',
    next_action: 'Wait for transfer', code_state: 'Historical checkout' }, 'old-source');
  if (blocked) [plan] = core.updateHandover(plan, plan.revision,
    { request_id: 'legacy-handoff', state: 'blocked', note: 'Waiting for readiness message' }, 'old-source');
  core.saveMarkdown(h.planPath, plan);
  const files = [h.planPath, core.markdownStatePath(h.planPath)];
  const before = files.map(f => fs.readFileSync(f));
  await h.call({ action: 'show', path: h.planPath });
  assert.deepEqual(files.map(f => fs.readFileSync(f)), before, 'inspection must not retire bookkeeping');
  const request = { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'current-user-run',
    intent: 'implement', operations: [], selected_step_ids: ['a'], execution_mode: 'sequential' };
  await assert.rejects(h.call({ action: 'submit', path: h.planPath,
    request: JSON.stringify({ ...request, base_revision: plan.revision - 1 }) }), /Stale plan/);
  assert.deepEqual(files.map(f => fs.readFileSync(f)), before, 'failed admission leaves the entire history intact');
  const result = await h.call({ action: 'submit', path: h.planPath, request: JSON.stringify(request) });
  assert.equal(result.details.plan.execution_owner, undefined);
  assert.equal(result.details.revision, plan.revision + 1);
  assert.deepEqual(result.details.plan.execution.selected_step_ids, ['a']);
  assert.equal(result.details.plan.steps[0].status, 'pending', 'request acceptance never starts work');
  const event = result.details.plan.handovers[0], prior = plan.handovers[0];
  assert.equal(event.state, 'cancelled');
  assert.match(event.note, /Retired legacy Pi coordinator ownership handshake/);
  for (const key of ['source_task_id', 'destination_task_id', 'brief_path', 'context_digest']) assert.equal(event[key], prior[key]);
  assert.equal(event.transferred_at, undefined);
  const retry = await h.call({ action: 'submit', path: h.planPath, request: JSON.stringify(request) });
  assert.equal(retry.details.changed, false);
  assert.equal(retry.details.revision, result.details.revision);
  h.setSession('another-resumed-session');
  await h.call(mutation(await h.read()));
  assert.equal((await h.read()).plan.steps[0].title, 'Renamed');
});

test('retiring a legacy handoff never clears unknown assignment writers', async t => {
  const h = await harness(t);
  let [plan] = core.applyRequest(h.plan, { plan_id: h.plan.plan_id, base_revision: h.plan.revision,
    request_id: 'legacy-handoff', intent: 'handover', operations: [] });
  plan.execution_owner = 'old-source';
  core.saveMarkdown(h.planPath, plan);
  h.entries.push({ type: 'custom', customType: 'hyperion.agent', data: {
    id: 'unknown-worker', state: 'unknown', settled: false, native_id: 'native', transcript_path: '/missing', context_digest: 'historical',
  } });
  const before = fs.readFileSync(h.planPath);
  await assert.rejects(h.call(mutation(await h.read())), /unknown writers/);
  assert.deepEqual(fs.readFileSync(h.planPath), before);
});

test('explicit handover checkpoints are not silently retired', async t => {
  const h = await harness(t);
  let plan = { ...h.plan, title: 'Explicit boundary', steps: [
    { id: 'pre', title: 'Done', status: 'completed' }, { id: 'handoff', title: 'Boundary', kind: 'handover', status: 'pending' },
    { id: 'after', title: 'Later work', status: 'pending' },
  ] };
  [plan] = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'boundary',
    intent: 'handover', target_step_ids: ['handoff'], operations: [] });
  plan.execution_owner = 'old-source';
  core.saveMarkdown(h.planPath, plan);
  const before = fs.readFileSync(h.planPath);
  await assert.rejects(h.call({ action: 'submit', path: h.planPath, request: JSON.stringify({
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'later', intent: 'implement', operations: [], selected_step_ids: ['after'],
  }) }), /handover/);
  assert.deepEqual(fs.readFileSync(h.planPath), before);
});

test("scope edits preserve partial progress while revoking changed approval", async t => {
  const h = await harness(t);
  let plan = h.plan;
  [plan] = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: "prior-run", intent: "implement", operations: [], selected_step_ids: ["a", "b"] });
  [plan] = core.checkpoint(plan, plan.revision, "a", "in_progress", "Observed partial work");
  core.saveMarkdown(h.planPath, plan);
  const result = await h.call(mutation(await h.read()));
  assert.equal(result.details.plan.steps[0].status, "in_progress");
  assert.equal(result.details.plan.steps[0].progress_note, "Observed partial work");
  assert.equal(result.details.plan.steps[0].needs_replanning, true);
  assert.deepEqual(result.details.plan.execution.selected_step_ids, ["b"]);
  assert.equal(result.details.plan.steps[1].review_state, "needs_review");
});

test("finish and reopen preserve work and never restore implementation approval", async t => {
  const h = await harness(t);
  const finished = await h.call(mutation(await h.read(), { action: "finish", operations: undefined }));
  assert.equal(finished.details.plan.lifecycle, "finished");
  assert.equal(finished.details.plan.steps.length, 2);
  await assert.rejects(h.call(mutation(await h.read())), /finished/);
  const opened = await h.call(mutation(await h.read(), { action: "reopen", operations: undefined }));
  assert.equal(opened.details.plan.lifecycle, "active");
  assert.ok(!opened.details.plan.execution?.selected_step_ids?.length);
  assert.equal(h.screens.length, 0);
});

test("create requires an explicit new Markdown path, adds no tasks and binds it", async t => {
  const h = await harness(t);
  await assert.rejects(h.call({ action: "create", path: "new.md" }), /title/);
  await assert.rejects(h.call({ action: "create", path: "new.json", title: "New" }), /\.md/);
  await assert.rejects(h.call({ action: "create", path: "plan.md", title: "Overwrite" }), /already exists/);
  const created = await h.call({ action: "create", path: "new.md", title: "New" });
  assert.deepEqual(created.details.plan.steps, []);
  assert.equal(created.details.plan.execution, undefined);
  assert.equal((await h.call({ action: "show" })).details.path, path.join(h.dir, "new.md"));
  await assert.rejects(h.call({ action: "create", title: "No explicit path" }), /explicit/);
});

test("abort, session changes and shutdown discard queued openings", async t => {
  for (const action of ["abort", "session_start", "session_tree", "session_shutdown", "identity"]) {
    const h = await harness(t), controller = new AbortController();
    await h.call({ action: "open", path: "plan.md" }, controller.signal);
    if (action === "abort") controller.abort();
    else if (action === "identity") h.setSession("another-session");
    else await h.events.get(action)({}, h.ctx);
    await h.settle();
    assert.equal(h.screens.length, 0, action);
  }
  const h = await harness(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call(mutation(await h.read()), controller.signal), /abort/i);
  assert.equal((await h.read()).plan.steps[0].title, "First");
});

test("replaced bound paths cannot silently open or mutate a different plan", async t => {
  const h = await harness(t);
  await h.call({ action: "open", path: "plan.md" });
  fs.rmSync(h.planPath);
  fs.rmSync(core.markdownStatePath(h.planPath));
  const replacement = core.initialize({ title: "Replacement", steps: [] });
  core.saveMarkdown(h.planPath, replacement);
  await assert.rejects(h.call({ action: "show" }), /different plan/);
  await assert.rejects(h.call({ action: "finish", plan_id: replacement.plan_id, base_revision: replacement.revision }), /different plan/);
  await h.settle();
  assert.equal(h.screens.length, 0);
  assert.ok(h.notifications.some(item => /Specify the path explicitly/.test(item.message)));
});

test("canonical tool edits preserve unsent UI drafts and surface stale conflicts", async t => {
  const h = await harness(t), snapshot = await h.read();
  h.entries.push({ type: "custom", customType: "hyperion-plan.draft", data: {
    path: h.planPath, plan_id: h.plan.plan_id, base_revision: h.plan.revision,
    base_digest: snapshot.source_digest, base_plan: h.plan,
    operations: [{ type: "update_step", step_id: "a", fields: { title: "Unsent UI draft" } }],
  } });
  await h.call(mutation(snapshot));
  await h.call({ action: "open", path: "plan.md" });
  await h.settle();
  assert.match(h.screens[0], /STALE DRAFT/);
  assert.match(h.screens[0], /Unsent UI draft/);
  assert.equal((await h.read()).plan.steps[0].title, "Renamed");
});

test('footer observes canonical changes without transcript messages, focus, or execution authority', async t => {
  const h = await harness(t);
  await h.call({ action: 'open', path: 'plan.md' });
  const observe = () => h.events.get('tool_result')({}, h.ctx);
  const footer = () => h.widgets.get('hyperion-plan')?.render(120).join('\n') ?? '';
  await observe();
  assert.match(footer(), /0\/2/);
  assert.match(footer(), /Next a First/);
  await observe();
  await h.events.get('session_start')({}, h.ctx);
  await observe();
  assert.equal(h.messages.length, 0, 'progress must never enter the transcript');
  let plan = (await h.read()).plan;
  [plan] = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: 'test-approval', intent: 'implement', operations: [], selected_step_ids: ['a'] });
  [plan] = core.checkpoint(plan, plan.revision, 'a', 'in_progress', 'Test work started');
  core.saveMarkdown(h.planPath, plan);
  const before = fs.readFileSync(h.planPath);
  await observe();
  assert.match(footer(), /Current a First/);
  assert.match(footer(), /\[░{10}\] 0\/2/);
  assert.doesNotMatch(footer(), /ETA|◷/);
  assert.deepEqual(fs.readFileSync(h.planPath), before);
  [plan] = core.checkpoint(plan, plan.revision, 'a', 'completed', 'Test completion evidence');
  core.saveMarkdown(h.planPath, plan);
  await h.events.get('turn_end')({}, h.ctx);
  assert.match(footer(), /1\/2/);
  assert.match(footer(), /Next b Second/);
  await h.call(mutation(await h.read(), { action: 'finish', operations: undefined }));
  await observe();
  assert.equal(footer(), '', 'finished plan stays quiet');
  assert.equal(h.messages.length, 0);
  assert.equal(h.screens.length, 0);
});

test('overlay opened while busy becomes editable after settlement and retains local selection', async t => {
  const h = await harness(t);
  let screen, close;
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  h.ctx.ui.custom = factory => new Promise(resolve => {
    close = resolve;
    screen = factory({ requestRender() {}, terminal: { rows: 42 } }, theme, {}, resolve);
  });
  const opened = h.command.handler(h.planPath, h.ctx);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(screen.render(120).join('\n'), /Pi busy · requests queue/);
  await h.settle();
  assert.doesNotMatch(screen.render(120).join('\n'), /Pi busy · requests queue/);
  screen.handleInput(' ');
  assert.match(screen.render(120).join('\n'), /1 selected/);
  assert.equal((await h.read()).plan.execution, undefined);
  h.setIdle(false);
  await h.events.get('agent_start')({}, h.ctx);
  assert.match(screen.render(120).join('\n'), /Pi busy · requests queue/);
  close({ type: 'close' });
  await opened;
});

test("tool rejects execution actions and irrelevant mutation fields", async t => {
  const h = await harness(t);
  for (const params of [
    { action: "implement", path: "plan.md" },
    { action: "open", path: "plan.md", operations: "[]" },
    { action: "show", path: "plan.md", base_revision: 1 },
    { action: "finish", path: "plan.md", step_id: "a" },
  ]) await assert.rejects(h.call(params));
  assert.equal((await h.read()).plan.execution, undefined);
});
}

// Cancellation at real filesystem lock boundaries
{
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
}

// Shared service compatibility at the Pi boundary
{
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function samplePlan(steps = [
  { id: "a", title: "First", status: "pending", description: "Foundation" },
  { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  { id: "c", title: "Independent", status: "pending" },
]) {
  return core.initialize({ title: "Pi integration", steps });
}
function savedPlan(dir, steps) {
  const planPath = path.join(dir, "plan.md");
  const plan = samplePlan(steps);
  core.saveMarkdown(planPath, plan);
  return { planPath, plan };
}

test("the selected path is explicit, supports session-relative resolution, and creates only there", async (t) => {
  const cwd = scratch(t);
  const expected = path.join(cwd, "tasks", "selected.md");
  assert.equal(core.selectedPlanPath("tasks/selected.md", cwd), expected);
  const snapshot = await core.createPlan("tasks/selected.md", "Selected task", { cwd });
  assert.equal(snapshot.path, expected);
  assert.equal(snapshot.plan.title, "Selected task");
  assert.deepEqual(snapshot.plan.steps, []);
  assert.equal((await core.loadPlanSnapshot("tasks/selected.md", { cwd })).refresh_required, false);
  assert.equal(fs.existsSync(path.join(cwd, "plan.md")), false);
});

test("external Markdown changes require an explicit refresh before writes", async (t) => {
  const dir = scratch(t), { planPath } = savedPlan(dir);
  const initial = await core.loadPlanSnapshot(planPath);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8").replace("# Pi integration", "# Updated from editor"));
  const stale = await core.loadPlanSnapshot(planPath);
  assert.equal(stale.refresh_required, true);
  assert.equal(stale.plan.title, "Updated from editor");
  assert.equal(stale.plan.revision, initial.plan.revision + 1);

  const refreshed = await core.loadPlanSnapshot(planPath, { refresh: true, actorId: "pi-session" });
  assert.equal(refreshed.refresh_required, false);
  assert.equal(refreshed.plan.revision, stale.plan.revision);
  const request = {
    plan_id: refreshed.plan.plan_id,
    base_revision: refreshed.plan.revision,
    request_id: "pi-edit-test",
    intent: "edit",
    operations: [{ type: "update_step", step_id: "b", fields: { title: "Revised second" } }],
  };
  const result = await core.mutatePlan(planPath, "pi-session", plan => core.applyRequest(plan, request));
  assert.equal(result.plan.revision, refreshed.plan.revision + 1);
  assert.equal(result.plan.steps[1].title, "Revised second");
  assert.equal(result.plan.execution, undefined);
  assert.match(fs.readFileSync(core.notesPath(planPath), "utf8"), /Revised second/);
});

test("refresh and mutation check execution ownership before persisting external edits", async (t) => {
  const dir = scratch(t), { planPath, plan } = savedPlan(dir);
  plan.execution_owner = "owner-session";
  core.saveMarkdown(planPath, plan);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8").replace("# Pi integration", "# External change"));
  const before = [planPath, core.markdownStatePath(planPath)].map(file => fs.readFileSync(file));
  await assert.rejects(core.loadPlanSnapshot(planPath, { refresh: true, actorId: "other-session" }), /belongs to task owner-session/);
  await assert.rejects(core.mutatePlan(planPath, "other-session", current => [current, false]), /belongs to task owner-session/);
  assert.deepEqual([planPath, core.markdownStatePath(planPath)].map(file => fs.readFileSync(file)), before);
  const ownerRead = await core.loadPlanSnapshot(planPath, { refresh: true, actorId: "owner-session" });
  assert.equal(ownerRead.refresh_required, false);
  assert.equal(ownerRead.plan.title, "External change");
});

test("JSON mutations refuse to overwrite a file changed during the operation", async (t) => {
  const dir = scratch(t), planPath = path.join(dir, "plan.json"), plan = samplePlan();
  core.atomicWrite(planPath, plan);
  const request = {
    plan_id: plan.plan_id,
    base_revision: plan.revision,
    request_id: "json-race",
    intent: "edit",
    operations: [{ type: "update_step", step_id: "a", fields: { title: "Hyperion write" } }],
  };
  await assert.rejects(core.mutatePlan(planPath, "actor", current => {
    fs.writeFileSync(planPath, JSON.stringify({ ...current, title: "External JSON write" }, null, 2));
    return core.applyRequest(current, request);
  }), /changed during this operation/);
  assert.equal(JSON.parse(fs.readFileSync(planPath, "utf8")).title, "External JSON write");
});

test("update_step uses null to clear optional fields through the shared validator", () => {
  const plan = samplePlan([
    { id: "a", title: "First", status: "pending", short_title: "F" },
    { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  ]);
  const [updated] = core.applyRequest(plan, {
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: "clear-optional-fields", intent: "edit",
    operations: [{ type: "update_step", step_id: "a", fields: { short_title: null } },
      { type: "update_step", step_id: "b", fields: { depends_on: null } }],
  });
  assert.equal(Object.hasOwn(updated.steps[0], "short_title"), false);
  assert.equal(Object.hasOwn(updated.steps[1], "depends_on"), false);
});

}
