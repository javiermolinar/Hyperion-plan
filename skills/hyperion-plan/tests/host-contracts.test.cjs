const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const api = require('../dist/index.cjs');

test('host capabilities report unsupported behavior rather than pretending to implement it', () => {
  assert.doesNotThrow(() => api.requireHostCapability({ mode: 'native' }));
  assert.doesNotThrow(() => api.requireHostCapability({ mode: 'agent-mediated' }));
  assert.throws(() => api.requireHostCapability({ mode: 'unsupported', reason: 'No fresh-session interface' }), /No fresh-session interface/);
});

test('capability inspection does not change canonical approval or task identity', () => {
  const plan = api.initialize({ title: 'Existing owner', steps: [{ id: 'a', title: 'A' }] });
  plan.execution_owner = 'native-task_123';
  const before = api.clone(plan);
  api.requireHostCapability({ mode: 'agent-mediated' });
  assert.deepEqual(plan, before);
  assert.throws(() => api.assertExecutionOwner(plan, 'codex:native-task_123'), /belongs to task/);
  assert.doesNotThrow(() => api.assertExecutionOwner(plan, 'native-task_123'));
});

test('shared snapshot service preserves canonical state and existing public result shape', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'plan.md');
  const created = await api.createPlan(filename, 'Contracts');
  const snapshot = await api.loadPlanSnapshot(filename);
  assert.equal(snapshot.path, filename);
  assert.equal(snapshot.source_digest, created.source_digest);
  assert.equal(snapshot.plan.plan_id, created.plan.plan_id);
  assert.equal(snapshot.summary.revision, snapshot.plan.revision);
  assert.equal(snapshot.refresh_required, false);
  assert.equal(snapshot.plan.execution, undefined);
});

test('host contract module bundles for browsers without DOM, Node or Pi runtime imports', () => {
  const { buildSync } = require('esbuild');
  const result = buildSync({
    entryPoints: [path.resolve(__dirname, '../src/hosts/contracts.ts')],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true,
  });
  assert.equal(Object.keys(result.metafile.inputs).length, 1);
  assert.doesNotMatch(result.outputFiles[0].text, /window\.openai|@earendil|cmux|node:/);
});
