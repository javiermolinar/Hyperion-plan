const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('../dist/index.cjs');
const cli = path.resolve(__dirname, '../dist/plan.cjs');
const step = (id, extra = {}) => ({ id, title: id, ...extra });
const request = (plan, intent, operations, extra = {}) => ({
  plan_id: plan.plan_id, base_revision: plan.revision,
  request_id: `${intent}-${plan.revision}`, intent, operations, ...extra,
});

function approvedPlan() {
  const plan = api.initialize({ title: 'Notes and approval', steps: [
    step('a', { comments: [{ id: 'existing', text: 'Original constraint', state: 'pending' }] }),
    step('b', { depends_on: ['a'] }),
    step('c', { depends_on: ['b'] }), step('spare'),
  ] });
  return api.applyRequest(plan, request(plan, 'implement', [], {
    selected_step_ids: ['a', 'b', 'c', 'spare'],
  }))[0];
}

function scratch(t, plan, extension) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'plan.' + extension);
  if (extension === 'md') api.saveMarkdown(p, plan);
  else api.atomicWrite(p, plan);
  return { dir, p };
}
function run(...args) {
  return spawnSync(process.execPath, [cli, ...args.map(String)], { encoding: 'utf8' });
}
function ok(...args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function snapshot(p) {
  return [p, api.markdownStatePath(p), api.notesPath(p)].map(file =>
    fs.existsSync(file) ? fs.readFileSync(file) : null);
}

for (const state of ['approved', 'paused', 'cancelled']) {
  for (const operation of [
    { type: 'add_comment', step_id: 'a', comment_id: 'new', text: 'New constraint' },
    { type: 'remove_comment', step_id: 'a', comment_id: 'existing' },
  ]) test(`${operation.type} revokes changed approval and flags dependents (${state})`, () => {
    const plan = approvedPlan();
    plan.execution.state = state;
    const original = api.clone(plan), edit = request(plan, 'edit', [operation]);
    const [result] = api.applyRequest(plan, edit);
    assert.deepEqual(plan, original);
    assert.equal(result.execution.state, state);
    assert.deepEqual(result.execution.selected_step_ids, ['b', 'c', 'spare']);
    for (const id of ['b', 'c'])
      assert.equal(result.steps.find(s => s.id === id).review_state, 'needs_review');
    assert.deepEqual(result.steps[3], plan.steps[3]);
    assert.deepEqual(api.nextSteps(result).ready_steps.map(s => s.id), state === 'approved' ? ['spare'] : []);
    const [reviewed] = api.reviewStep(result, result.revision, 'a', 'current', 'Checked the new constraint.');
    assert.throws(() => api.checkpoint(reviewed, reviewed.revision, 'a', 'in_progress'), /outside the recorded/);
    assert.deepEqual(api.applyRequest(result, edit), [result, false]);
  });
}

test('final unchanged notes preserve approvals; a fresh selection can approve changed notes', () => {
  const plan = approvedPlan();
  const add = { type: 'add_comment', step_id: 'a', comment_id: 'new', text: 'New constraint' };
  const [unchanged] = api.applyRequest(plan, request(plan, 'edit', [
    add, { type: 'remove_comment', step_id: 'a', comment_id: 'new' },
  ]));
  assert.deepEqual(unchanged.execution, plan.execution);
  assert.deepEqual(unchanged.steps, plan.steps);
  const [selected] = api.applyRequest(plan, request(plan, 'implement', [add], { selected_step_ids: ['a'] }));
  assert.deepEqual(selected.execution.selected_step_ids, ['a']);
  assert.equal(selected.execution.request_id, `implement-${plan.revision}`);
  assert.deepEqual(api.nextSteps(selected).ready_steps.map(s => s.id), ['a']);
  assert.equal(selected.steps[1].review_state, 'needs_review');
});

test('editing notes on multiple prerequisites still invalidates changed dependents', () => {
  const plan = approvedPlan();
  const [result] = api.applyRequest(plan, request(plan, 'edit', ['a', 'b'].map(id => ({
    type: 'add_comment', step_id: id, comment_id: 'note-' + id, text: 'Updated requirements',
  }))));
  assert.deepEqual(result.execution.selected_step_ids, ['c', 'spare']);
  for (const id of ['b', 'c'])
    assert.equal(result.steps.find(s => s.id === id).review_state, 'needs_review');
});

function reviewPlan(status) {
  return api.initialize({ title: 'Preserve review history', steps: [
    step('a', { status: 'completed' }), step('b', { status: 'completed' }),
    step('r', { status, kind: 'review', depends_on: ['a'], run_after: 'a',
      checks: ['Check A'], progress_note: 'Evidence for A' }),
  ] });
}
for (const status of ['in_progress', 'completed']) {
  test(`whole-plan revisions protect ${status} review coverage, checks, timing and kind`, () => {
    const plan = reviewPlan(status), original = api.clone(plan);
    for (const patch of [
      { depends_on: ['b'] }, { checks: ['Check B'] }, { run_after: 'b' },
      { kind: 'implementation', checks: [], run_after: undefined },
    ]) for (const reopen of [false, true]) {
      const replacement = api.clone(plan);
      Object.assign(replacement.steps[2], patch);
      if (reopen) replacement.steps[2].status = 'pending';
      assert.throws(() => api.revise(plan, replacement, plan.revision), /Preserve the scope and timing/);
      assert.deepEqual(plan, original);
    }
    const progress = api.clone(plan);
    progress.steps[2].progress_note = 'Additional evidence for A';
    assert.equal(api.revise(plan, progress, plan.revision).steps[2].progress_note, 'Additional evidence for A');
  });
}

test('a pending review can still change scope and requires fresh approval', () => {
  let plan = reviewPlan('pending');
  [plan] = api.applyRequest(plan, request(plan, 'implement', [], { selected_step_ids: ['r'] }));
  const replacement = api.clone(plan);
  replacement.steps[2].depends_on = ['b'];
  const revised = api.revise(plan, replacement, plan.revision);
  assert.deepEqual(revised.execution.selected_step_ids, []);
  assert.equal(revised.steps[2].review_state, 'needs_review');
});

for (const extension of ['md', 'json']) {
  test(`card note edits persist revoked approval and stale dependents (${extension})`, t => {
    const plan = approvedPlan(), { dir, p } = scratch(t, plan, extension);
    const file = path.join(dir, 'request.json');
    api.atomicWrite(file, request(plan, 'edit', [
      { type: 'add_comment', step_id: 'a', comment_id: 'new', text: 'New constraint' },
    ]));
    ok('apply', '--plan', p, '--request', file);
    assert.deepEqual(api.read(p).execution.selected_step_ids, ['b', 'c', 'spare']);
    assert.deepEqual(ok('next', '--plan', p).ready_steps.map(s => s.id), ['spare']);
    assert.equal(ok('apply', '--plan', p, '--request', file).result, 'already_applied');
  });

  test(`revision rejects rewritten completed review without changing saved evidence (${extension})`, t => {
    const plan = reviewPlan('completed'), { dir, p } = scratch(t, plan, extension);
    const replacement = api.clone(plan), file = path.join(dir, 'revision.json');
    replacement.steps[2].depends_on = ['b'];
    replacement.steps[2].checks = ['Check B'];
    api.atomicWrite(file, replacement);
    const before = snapshot(p);
    for (const flags of [[], ['--dry-run']]) {
      const result = run('revise', '--plan', p, '--input', file, '--base-revision', plan.revision, ...flags);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Preserve the scope and timing/);
      assert.deepEqual(snapshot(p), before);
    }
  });

  test(`dependency updates reject inverted order and retain usable card edits (${extension})`, t => {
    const plan = api.initialize({ title: 'Order', steps: [step('a'), step('b')] });
    const { dir, p } = scratch(t, plan, extension), file = path.join(dir, 'patch.json');
    api.atomicWrite(file, { depends_on: ['b'] });
    const before = snapshot(p);
    for (const flags of [[], ['--dry-run']]) {
      const result = run('step', 'update', '--plan', p, '--step-id', 'a', '--input', file, '--base-revision', 1, ...flags);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Keep “a” after “b”/);
      assert.deepEqual(snapshot(p), before);
    }
    const replacement = api.clone(plan);
    replacement.steps[0].depends_on = ['b'];
    assert.throws(() => api.revise(plan, replacement, 1), /Keep “a” after “b”/);
    replacement.steps.reverse();
    const revised = api.revise(plan, replacement, 1);
    assert.deepEqual(revised.steps.map(s => s.id), ['b', 'a']);

    api.atomicWrite(file, request(plan, 'edit', [{ type: 'add_step', step_id: 'c', title: 'c' }]));
    ok('apply', '--plan', p, '--request', file);
    api.atomicWrite(file, { depends_on: ['a'] });
    ok('step', 'update', '--plan', p, '--step-id', 'b', '--input', file, '--base-revision', 2);
    assert.deepEqual(api.read(p).steps.find(s => s.id === 'b').depends_on, ['a']);
  });
}
