const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/index.cjs');

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
        for (const key of views++ === 0 ? keys : ['q']) screen.handleInput(key);
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
  const h = await fixture(t, { keys: name === 'missing prerequisite' ? ['j', ' ', 'r'] : [' ', 'r'], prepare });
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
  const h = await fixture(t, { idle: false, keys: [' ', 'r'], prepare: p => core.applyRequest(p, {
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

for (const [key, phrase] of [['n', 'add'], ['e', 'edit'], ['m', 'note'], ['a', 'asks about'], ['x', 'Remove planned'], ['d', 'Decompose']]) {
  test(`${key} is a plan-only natural-language request, including while busy`, async t => {
    const h = await fixture(t, { idle: false, keys: [key] });
    const before = h.bytes(); await h.open();
    assert.deepEqual(h.bytes(), before);
    assert.equal(h.messages.length, 1, h.notices.join('\n'));
    assert.match(h.messages[0].content, new RegExp(phrase));
    assert.match(h.messages[0].content, /no implementation|do not implement|Do not revert code or execute/i);
  });
}

test('Ask preserves conflicting drafts as context without requiring Save or granting execution', async t => {
  const h = await fixture(t, { keys: ['a'] });
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
  const h = await fixture(t, { idle: false, keys: [' ', 'r'] });
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
