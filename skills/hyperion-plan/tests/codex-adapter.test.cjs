const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../dist/index.cjs');
const baseline = require('./fixtures/codex-prompts.json');

function runtime(bridge) {
  const listeners = new Map();
  return {
    openai: bridge,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    emit(draft) { listeners.get('openai:set_globals')?.({ detail: { globals: { widgetState: draft } } }); },
  };
}
function submission(request = baseline.fixtures[0].request) {
  return { ...baseline.config, request, title: 'Test request' };
}

for (const {request, sha256} of baseline.fixtures) {
  test(`Codex ${request.request_id} prompt matches the pre-extraction browser verbatim`, () => {
    assert.equal(crypto.createHash('sha256').update(api.codexPrompt(submission(request))).digest('hex'), sha256);
  });
}

test('delivery retains request identity and does not fabricate canonical acceptance', async () => {
  let delivered;
  const host = runtime({ sendFollowUpMessage: async message => { delivered = message; } });
  const adapter = api.createCodexUiAdapter(host);
  const input = submission();
  const before = structuredClone(input);
  const result = await adapter.submit(input);
  assert.deepEqual(result, { phase: 'delivered', request_id: input.request.request_id });
  assert.deepEqual(input, before);
  assert.equal(delivered.title, input.title);
  assert.equal(delivered.prompt, api.codexPrompt(input));
  assert.equal(result.snapshot, undefined);
});

test('failure preserves the caller draft and permits an identical retry', async () => {
  let fail = true;
  const calls = [];
  const draft = { modelContent: {kind:'plan-companion', ui_version:3, plan_id:'p', base_revision:2, operations:[]} };
  const host = runtime({ widgetState: draft, sendFollowUpMessage: async message => {
    calls.push(message);
    if (fail) throw Error('not confirmed');
  } });
  const adapter = api.createCodexUiAdapter(host);
  await assert.rejects(adapter.submit(submission()), /not confirmed/);
  assert.equal(adapter.readDraft(), draft);
  fail = false;
  await adapter.submit(submission());
  assert.deepEqual(calls[0], calls[1]);
});

test('late host availability and draft notifications remain dynamic and unsubscribe cleanly', async () => {
  const host = runtime(undefined);
  const adapter = api.createCodexUiAdapter(host);
  assert.equal(adapter.capabilities().submission.mode, 'unsupported');
  await assert.rejects(adapter.submit(submission()), /inside Codex/);
  let stored;
  host.openai = { widgetState: { privateContent: { expanded: ['a'] } }, setWidgetState: async value => { stored = value; }, sendFollowUpMessage: async () => {} };
  assert.equal(adapter.capabilities().submission.mode, 'native');
  assert.deepEqual(adapter.readDraft(), host.openai.widgetState);
  const draft = { privateContent: { questions: {a:'Question'}, request_ids:{ask:'same-id'} } };
  await adapter.saveDraft(draft);
  assert.equal(stored, draft);
  const received = [];
  const unsubscribe = adapter.onDraft(value => received.push(value));
  host.emit(draft);
  unsubscribe();
  host.emit({});
  assert.deepEqual(received, [draft]);
});

test('navigation preserves native IDs and does not construct cross-host links', () => {
  const adapter = api.createCodexUiAdapter(runtime({}));
  assert.equal(adapter.sessionLink({host:'codex',native_id:'task/a b'}), 'codex://threads/task%2Fa%20b');
  assert.equal(adapter.sessionLink({host:'pi',native_id:'task/a b'}), undefined);
  assert.equal(adapter.capabilities().workers.mode, 'agent-mediated');
});

test('browser frontend no longer owns host calls, native link format or instruction prose', () => {
  const browser = fs.readFileSync(path.join(__dirname, '../src/browser.ts'), 'utf8');
  assert.doesNotMatch(browser, /window\.openai|openai:set_globals|codex:\/\/threads|sendFollowUpMessage|const instruction =/);
  const instructions = fs.readFileSync(path.join(__dirname, '../src/instructions.ts'), 'utf8');
  assert.doesNotMatch(instructions, /Codex|window\.|@earendil|cmux/);
});
