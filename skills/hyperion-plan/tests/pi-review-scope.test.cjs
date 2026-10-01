const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const core = require('../dist/index.cjs');
let loaded;
async function contract() {
  if (!loaded) {
    const host = createRequire(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
    loaded = import(pathToFileURL(host.resolve('jiti')).href).then(({ createJiti }) =>
      createJiti(pathToFileURL(__filename).href).import(path.resolve(__dirname, '../src/pi/review-contract.ts')));
  }
  return loaded;
}
function plan() {
  return core.initialize({ title: 'Scoped review', steps: [
    { id: 'base', title: 'Foundation', status: 'completed', done_when: 'Foundation contract' },
    { id: 'code', title: 'Reviewed implementation', status: 'completed', depends_on: ['base'] },
    { id: 'timing', title: 'Review timing boundary', status: 'completed' },
    { id: 'review', title: 'Review', status: 'in_progress', kind: 'review', depends_on: ['code'], run_after: 'timing', checks: ['Verify the contract'] },
    { id: 'later', title: 'Unrelated future work', status: 'pending' },
  ] });
}
const scoped = { intent: 'code-review', requirements_scope: 'code-review-closure-v1' };

for (const change of ['unrelated edit', 'unrelated addition', 'unrelated removal', 'progress']) test(`new code-review digest ignores ${change}`, async () => {
  const api = await contract(), p = plan(), before = api.reviewContextRequirementsDigest(p, scoped, 'review');
  if (change === 'unrelated edit') p.steps.at(-1).done_when = 'Different unrelated requirement';
  if (change === 'unrelated addition') p.steps.push({ id: 'extra', title: 'New independent work', status: 'pending' });
  if (change === 'unrelated removal') p.steps.pop();
  if (change === 'progress') { p.steps[1].progress_note = 'More coordinator evidence'; p.revision++; }
  assert.equal(api.reviewContextRequirementsDigest(p, scoped, 'review'), before);
});
for (const target of ['base', 'code', 'timing', 'review']) test(`new code-review digest detects ${target} requirement changes`, async () => {
  const api = await contract(), p = plan(), before = api.reviewContextRequirementsDigest(p, scoped, 'review');
  p.steps.find(s => s.id === target).done_when = 'Changed relevant requirement';
  assert.notEqual(api.reviewContextRequirementsDigest(p, scoped, 'review'), before);
});
test('changed dependency closure and removed relevant records invalidate code-review requirements', async () => {
  const api = await contract(), p = plan(), before = api.reviewContextRequirementsDigest(p, scoped, 'review');
  p.steps[1].depends_on = [];
  assert.notEqual(api.reviewContextRequirementsDigest(p, scoped, 'review'), before);
  p.steps = p.steps.filter(s => s.id !== 'code');
  assert.throws(() => api.reviewContextRequirementsDigest(p, scoped, 'review'), /disappeared/);
});
test('legacy captures retain their original whole-plan digest and reject unrelated drift', async () => {
  const api = await contract(), p = plan(), legacy = { intent: 'code-review' };
  const before = api.reviewContextRequirementsDigest(p, legacy, 'review');
  assert.equal(before, api.reviewRequirementsDigest(p));
  assert.notEqual(before, api.reviewContextRequirementsDigest(p, scoped, 'review'));
  p.steps.at(-1).description = 'Unreviewed context';
  assert.notEqual(api.reviewContextRequirementsDigest(p, legacy, 'review'), before);
});
test('unknown digest schemes and scoped independent plan-review contexts are rejected', async () => {
  const api = await contract(), p = plan();
  assert.throws(() => api.reviewContextRequirementsDigest(p, { intent: 'code-review', requirements_scope: 'ignore-everything' }, 'review'), /Unsupported/);
  assert.throws(() => api.reviewContextRequirementsDigest(p, { ...scoped, intent: 'plan-review' }, 'review'), /Unsupported/);
  assert.throws(() => api.reviewContextRequirementsDigest(p, scoped, 'later'), /code-review step/);
});
