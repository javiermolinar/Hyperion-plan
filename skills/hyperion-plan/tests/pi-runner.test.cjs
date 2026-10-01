const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const core = require('../dist/index.cjs');
const root = path.resolve(__dirname, '..');
const url = p => pathToFileURL(path.join(root, p)).href;
const load = async () => ({
  sdk: await import(url('node_modules/@earendil-works/pi-coding-agent/dist/index.js')),
  ai: await import(url('node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js')),
  runner: await import(url('dist/pi-runner.js')),
});

async function fixture(t, respond = () => ({ text: 'Assignment done; coordinator must verify.' }), reasoning = false) {
  const { sdk, ai, runner } = await load();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-runner-')));
  let passed = false;
  t.after(() => {
    if (passed && !process.env.HYPERION_KEEP_RUNNER_ARTIFACTS) fs.rmSync(cwd, { force: true, recursive: true });
    else t.diagnostic(`Runner artifacts: ${cwd}`);
  });
  const planPath = path.join(cwd, 'plan.md');
  let plan = core.initialize({ title: 'Runner fixture', steps: [
    { id: 'one', title: 'Write the assigned file', done_when: 'output.txt contains approved', reasoning_effort: 'high' },
    { id: 'other', title: 'Do not run this' },
  ] });
  plan = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'run', intent: 'implement',
    operations: [], selected_step_ids: ['one'], execution_mode: 'sequential' })[0];
  plan = core.checkpoint(plan, plan.revision, 'one', 'in_progress', 'Coordinator starts selected work')[0];
  core.saveMarkdown(planPath, plan);
  const authority = { currentRunAuthorized: true, implementationAllowed: true, requestId: 'run', actorId: 'coordinator' };
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(cwd, 'models'), refreshOnCreate: false, allowModelNetwork: false });
  const requests = [], requestSettings = [];
  runtime.registerProvider('runner-test', { baseUrl: 'http://invalid.test', apiKey: 'offline', api: 'openai-completions',
    models: [{ id: 'scripted', name: 'Offline runner fixture', reasoning, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now() };
        try {
          requests.push(structuredClone(context));
          requestSettings.push(options?.reasoning);
          const answer = await respond(context, { runner, planPath, cwd, authority, runtime, signal: options?.signal });
          options?.signal?.throwIfAborted();
          if (answer.error) throw new Error(answer.error);
          stream.push({ type: 'start', partial: message });
          if (answer.tool) {
            const toolCall = { type: 'toolCall', id: `tool-${requests.length}`, ...answer.tool };
            message.content = [toolCall]; message.stopReason = 'toolUse';
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
          } else {
            message.content = [{ type: 'text', text: answer.text }];
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: answer.text, partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: answer.text, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = 'error'; message.errorMessage = error.message;
          stream.push({ type: 'error', reason: 'error', error: message });
        }
        stream.end();
      });
      return stream;
    },
  });
  const assignment = { schema_version: 1, assignment_id: 'assignment-one', plan_path: planPath, plan_id: plan.plan_id,
    approved_request_id: 'run', step_id: 'one', scope_digest: core.stepFingerprint(plan.steps[0]).scope,
    owner: { host: 'pi', native_id: 'coordinator' }, role: 'implementation', cwd,
    owned_paths: [path.join(cwd, 'output.txt')], acceptance: ['output.txt contains approved'], reasoning_effort: 'high',
    evidence_directory: runner.assignmentDirectory(planPath, 'assignment-one') };
  const options = { assignment, attemptId: 'attempt-one', authority: () => authority, modelRuntime: runtime,
    model: runtime.getModel('runner-test', 'scripted'), thinkingLevel: 'off', tools: ['read', 'write', 'edit'], contextFiles: [] };
  return { cwd, planPath, plan, options, authority, requests, requestSettings, runner, sdk, ai, passed: () => { passed = true; } };
}

function canonicalBytes(f) {
  return [f.planPath, core.markdownStatePath(f.planPath), core.notesPath(f.planPath)].map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
}
function completionCLI(f, actor, command, args) {
  return require('node:child_process').spawnSync(process.execPath, [path.join(root, 'dist/plan.cjs'), command,
    '--plan', f.planPath, ...(actor === undefined ? [] : ['--task-id', actor]), ...args], { encoding: 'utf8' });
}

test('real SDK fresh persisted assignment records intent/handle before model work and cannot complete the plan', { timeout: 30000 }, async t => {
  const f = await fixture(t, (context, { runner, planPath }) => {
    const record = runner.readDispatchLedger(planPath).records[0];
    assert.ok(['launching', 'started'].includes(record.phase));
    assert.ok(record.handle.session.native_id);
    assert.equal(record.result, undefined);
    if (context.messages.at(-1).role === 'toolResult') return { text: 'Verified completion! (untrusted worker claim)' };
    return { tool: { name: 'write', arguments: { path: 'output.txt', content: 'approved' } } };
  });
  // Ambient instructions/extensions would fail or contaminate the provider request.
  fs.mkdirSync(path.join(f.cwd, '.pi/extensions'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.pi/extensions/poison.ts'), 'throw new Error("ambient extension loaded")');
  fs.writeFileSync(path.join(f.cwd, 'AGENTS.md'), 'AMBIENT_SECRET_DO_NOT_LOAD');
  f.options.contextFiles = [{ path: '/curated/requirements.md', content: 'EXPLICIT_REQUIREMENTS_ONLY' }];
  const before = canonicalBytes(f);
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'settled', JSON.stringify(result));
  assert.deepEqual(result.history.map(e => e.phase), ['accepted', 'launching', 'started', 'settled']);
  assert.equal(result.verification, undefined);
  assert.equal(result.result.outcome, 'succeeded');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'output.txt'), 'utf8'), 'approved');
  assert.deepEqual(result.result.changed_paths, [path.join(f.cwd, 'output.txt')]);
  assert.equal(result.result.effort.requested, 'high');
  assert.equal(result.result.effort.actual, 'off');
  assert.match(result.result.effort.limitation, /unsupported; retained off/);
  assert.deepEqual(canonicalBytes(f), before);
  const entries = fs.readFileSync(result.handle.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].id, result.handle.session.native_id);
  assert.equal(entries[0].parentSession, undefined);
  const tag = entries.find(e => e.type === 'custom' && e.customType === 'hyperion.assignment');
  assert.equal(tag.data.assignment_id, 'assignment-one'); assert.equal(tag.data.attempt_id, 'attempt-one');
  assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user').length, 1);
  assert.deepEqual(f.ai.getCurrentTools(f.requests[0].messages).map(t => t.name).sort(), ['edit', 'read', 'write']);
  assert.match(f.ai.getCurrentSystemPrompt(f.requests[0].messages), /EXPLICIT_REQUIREMENTS_ONLY/);
  assert.doesNotMatch(JSON.stringify(f.requests), /AMBIENT_SECRET_DO_NOT_LOAD/);
  const events = fs.readFileSync(result.events_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.every(e => e.session.native_id === result.handle.session.native_id && e.assignment_id === 'assignment-one'));
  assert.ok(events.some(e => e.type === 'agent_settled'));
  assert.equal(JSON.parse(fs.readFileSync(result.result_path)).acceptance_verified, false);
  await assert.rejects(f.runner.verifyDispatch(f.planPath, 'assignment-one', () => ({ ...f.authority, actorId: 'other' }), { acceptance_met: true, integration_checked: true, evidence: ['checked'] }), /coordinator/);
  await assert.rejects(f.runner.verifyDispatch(f.planPath, 'assignment-one', f.options.authority, { acceptance_met: true, integration_checked: false, evidence: ['claim'] }), /Coordinator acceptance/);
  const verified = await f.runner.verifyDispatch(f.planPath, 'assignment-one', f.options.authority, { acceptance_met: true, integration_checked: true, evidence: ['Coordinator read output.txt = approved'] });
  assert.ok(verified.verification);
  assert.deepEqual(canonicalBytes(f), before, 'even verified ledger evidence is not a canonical checkpoint');
  // Restoration inspects native identity/evidence; it does not launch another assignment.
  const restored = f.sdk.SessionManager.open(result.handle.transcript_path);
  assert.equal(restored.getSessionId(), result.handle.session.native_id);
  await assert.rejects(f.runner.runPiAssignment(f.options), /Duplicate dispatch/);
  assert.equal(f.requests.length, 2);
  f.passed();
});

for (const [label, mutate, pattern] of [
  ['missing current authorization', f => { f.authority.currentRunAuthorized = false; }, /Saved approval/],
  ['non-implementation mode', f => { f.authority.implementationAllowed = false; }, /Current mode/],
  ['revoked request', f => { f.authority.requestId = 'new-run'; }, /request changed/],
  ['stale coordinator', f => { f.authority.actorId = 'other'; }, /coordinator changed/],
  ['changed scope', f => { f.options.assignment.scope_digest = 'wrong'; }, /scope changed/],
  ['unselected step', f => { f.options.assignment.step_id = 'other'; }, /outside ready approved scope/],
  ['nested delegation tool', f => { f.options.tools.push('subagent'); }, /Unsupported tool/],
  ['canonical mutation tool', f => { f.options.tools.push('hyperion_plan'); }, /Unsupported tool/],
  ['shell writer', f => { f.options.tools.push('bash'); }, /Unsupported tool/],
  ['canonical file ownership', f => { f.options.assignment.owned_paths.push(f.planPath); }, /canonical plan/],
  ['outside workspace ownership', f => { f.options.assignment.owned_paths.push('/tmp/unowned.txt'); }, /inside the workspace/],
]) test(`runner rejects ${label} before intent or session launch`, { timeout: 30000 }, async t => {
  const f = await fixture(t); mutate(f);
  const before = canonicalBytes(f);
  await assert.rejects(f.runner.runPiAssignment(f.options), pattern);
  assert.deepEqual(canonicalBytes(f), before);
  assert.equal(f.requests.length, 0);
  assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 0);
  f.passed();
});

for (const state of ['paused', 'cancelled']) test(`runner rejects ${state} canonical scope`, async t => {
  const f = await fixture(t);
  f.plan.execution.state = state; core.saveMarkdown(f.planPath, f.plan);
  await assert.rejects(f.runner.runPiAssignment(f.options), new RegExp(state));
  assert.equal(f.requests.length, 0); f.passed();
});

test('runner rejects stale native execution owner and missing start checkpoint', async t => {
  const f = await fixture(t);
  f.plan.execution_owner = 'new-owner'; core.saveMarkdown(f.planPath, f.plan);
  await assert.rejects(f.runner.runPiAssignment(f.options), /belongs to task/);
  delete f.plan.execution_owner; f.plan.steps[0].status = 'pending'; core.saveMarkdown(f.planPath, f.plan);
  await assert.rejects(f.runner.runPiAssignment(f.options), /checkpoint in_progress/);
  assert.equal(f.requests.length, 0); f.passed();
});

for (const name of ['subagent', 'hyperion_plan', 'bash']) test(`provider cannot invoke unexposed ${name}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : { tool: { name, arguments: {} } });
  const before = canonicalBytes(f);
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.equal(result.result.outcome, 'failed');
  assert.deepEqual(canonicalBytes(f), before);
  assert.equal(result.verification, undefined); f.passed();
});

for (const target of ['plan.md', 'unselected.txt', '.hyperion-dispatch/plan.md/ledger.json']) test(`bounded write rejects ${target}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } :
    { tool: { name: 'write', arguments: { path: target, content: 'forbidden' } } });
  const before = canonicalBytes(f);
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.deepEqual(canonicalBytes(f), before);
  assert.deepEqual(result.result.changed_paths, []); f.passed();
});

test('provider failure is recorded separately from SDK settlement and cannot retry', { timeout: 30000 }, async t => {
  const f = await fixture(t, () => ({ error: 'scripted provider failure' }));
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.equal(result.result.outcome, 'failed');
  assert.equal(result.verification, undefined);
  await assert.rejects(f.runner.runPiAssignment(f.options), /Duplicate dispatch/);
  assert.equal(f.requests.length, 1); f.passed();
});

test('concurrent duplicate calls launch once even with changed attempt and assignment IDs', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const second = { ...f.options, attemptId: 'attempt-two', assignment: { ...f.options.assignment, assignment_id: 'assignment-two',
    evidence_directory: f.runner.assignmentDirectory(f.planPath, 'assignment-two') } };
  const results = await Promise.allSettled([f.runner.runPiAssignment(f.options), f.runner.runPiAssignment(second)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /Duplicate dispatch/);
  assert.equal(f.requests.length, 1); assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 1); f.passed();
});

test('current authority revoked during provider work prevents the next file writer', { timeout: 30000 }, async t => {
  const f = await fixture(t, (context, { authority }) => {
    if (context.messages.at(-1).role === 'toolResult') return { text: 'done' };
    authority.currentRunAuthorized = false;
    return { tool: { name: 'write', arguments: { path: 'output.txt', content: 'forbidden' } } };
  });
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(f.cwd, 'output.txt')), false); f.passed();
});

for (const phase of ['accepted', 'launching', 'started', 'uncertain']) test(`restored ${phase} intent prevents a new request from duplicating ambiguous work`, async t => {
  const f = await fixture(t);
  await f.runner.runPiAssignment(f.options);
  const ledger = f.runner.readDispatchLedger(f.planPath);
  const previous = ledger.records[0];
  previous.phase = phase; delete previous.result;
  if (phase === 'accepted') delete previous.handle;
  core.atomicWrite(path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json'), ledger);
  f.plan = core.applyRequest(f.plan, { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'new-run', intent: 'implement',
    operations: [], selected_step_ids: ['one'] })[0];
  core.saveMarkdown(f.planPath, f.plan);
  f.authority.requestId = 'new-run';
  f.options.assignment = { ...f.options.assignment, approved_request_id: 'new-run', assignment_id: 'assignment-two',
    evidence_directory: f.runner.assignmentDirectory(f.planPath, 'assignment-two') };
  f.options.attemptId = 'attempt-two';
  await assert.rejects(f.runner.runPiAssignment(f.options), /active or uncertain/);
  assert.equal(f.requests.length, 1); assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 1); f.passed();
});

test('revocation after durable intent prevents SDK launch and preserves the uncertain handle', async t => {
  const f = await fixture(t);
  let checks = 0;
  f.options.authority = () => ({ ...f.authority, currentRunAuthorized: ++checks === 1 });
  const record = await f.runner.runPiAssignment(f.options);
  assert.equal(record.phase, 'uncertain');
  assert.ok(record.handle.session.native_id);
  assert.equal(fs.existsSync(record.handle.transcript_path), false, 'reserved transcript path is not fabricated persistence');
  assert.equal(record.result, undefined); assert.equal(f.requests.length, 0);
  f.options.authority = () => f.authority;
  await assert.rejects(f.runner.runPiAssignment(f.options), /Duplicate dispatch/); f.passed();
});

test('result persistence failure remains uncertain and forbids automatic retry', async t => {
  const f = await fixture(t, (_context, { runner, planPath }) => {
    const record = runner.readDispatchLedger(planPath).records[0];
    fs.mkdirSync(record.result_path); // Test fault injection, not a worker-exposed tool.
    return { text: 'done' };
  });
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'uncertain'); assert.ok(result.error);
  assert.equal(result.result, undefined); assert.equal(result.verification, undefined);
  await assert.rejects(f.runner.runPiAssignment(f.options), /Duplicate dispatch/);
  assert.equal(f.requests.length, 1); f.passed();
});

test('ledger corruption fails closed rather than replacing dispatch history', async t => {
  const f = await fixture(t);
  const file = path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{truncated');
  await assert.rejects(f.runner.runPiAssignment(f.options));
  assert.equal(fs.readFileSync(file, 'utf8'), '{truncated'); assert.equal(f.requests.length, 0); f.passed();
});

for (const alteration of ['owner', 'scope', 'pause', 'authority']) test(`coordinator verification rechecks current ${alteration}`, async t => {
  const f = await fixture(t);
  await f.runner.runPiAssignment(f.options);
  if (alteration === 'owner') f.plan.execution_owner = 'other-owner';
  if (alteration === 'scope') f.plan.steps[0].description = 'Different scope';
  if (alteration === 'pause') f.plan.execution.state = 'paused';
  if (alteration === 'authority') f.authority.currentRunAuthorized = false;
  core.saveMarkdown(f.planPath, f.plan);
  await assert.rejects(f.runner.verifyDispatch(f.planPath, 'assignment-one', f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['old claim'] }));
  assert.equal(f.runner.readDispatchLedger(f.planPath).records[0].verification, undefined); f.passed();
});

test('symlink and hardlink ownership aliases cannot mutate the canonical plan', async t => {
  const f = await fixture(t);
  const alias = path.join(f.cwd, 'alias.md'); fs.symlinkSync(f.planPath, alias);
  f.options.assignment.owned_paths = [alias];
  await assert.rejects(f.runner.runPiAssignment(f.options), /canonical files/);
  fs.unlinkSync(alias); fs.linkSync(f.planPath, alias);
  await assert.rejects(f.runner.runPiAssignment(f.options), /unaliased file/);
  assert.equal(f.requests.length, 0); f.passed();
});

test('canonical revocation while the runner waits on the plan lock is observed before intent', async t => {
  const f = await fixture(t);
  let release, acquired;
  const held = new Promise(resolve => { acquired = resolve; });
  const lock = core.withLock(f.planPath, async () => { acquired(); await new Promise(resolve => { release = resolve; }); });
  await held;
  const running = f.runner.runPiAssignment(f.options);
  f.plan.execution.state = 'cancelled'; core.saveMarkdown(f.planPath, f.plan);
  release(); await lock;
  await assert.rejects(running, /cancelled/);
  assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 0); assert.equal(f.requests.length, 0); f.passed();
});

test('real SDK read and edit wrappers execute only the owned file and retain correlated evidence', async t => {
  let turn = 0;
  const f = await fixture(t, () => {
    if (++turn === 1) return { tool: { name: 'read', arguments: { path: 'output.txt' } } };
    if (turn === 2) return { tool: { name: 'edit', arguments: { path: 'output.txt', edits: [{ oldText: 'before', newText: 'approved' }] } } };
    return { text: 'edited' };
  });
  fs.writeFileSync(path.join(f.cwd, 'output.txt'), 'before');
  f.options.tools = ['read', 'edit'];
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'settled', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(f.cwd, 'output.txt'), 'utf8'), 'approved');
  assert.deepEqual(result.result.changed_paths, [path.join(f.cwd, 'output.txt')]);
  assert.deepEqual(f.ai.getCurrentTools(f.requests[0].messages).map(t => t.name).sort(), ['edit', 'read']); f.passed();
});

test('canonical pause after launch prevents the next tool without rewriting approval', async t => {
  const f = await fixture(t, async (context, { planPath }) => {
    if (context.messages.at(-1).role === 'toolResult') return { text: 'stopped' };
    await core.mutatePlan(planPath, 'coordinator', plan => {
      plan.execution.state = 'paused'; plan.revision++; return [plan, true];
    });
    return { tool: { name: 'write', arguments: { path: 'output.txt', content: 'forbidden' } } };
  });
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.execution.state, 'paused');
  assert.equal(fs.existsSync(path.join(f.cwd, 'output.txt')), false); f.passed();
});

test('replaced owned-path symlink is revalidated at the writer boundary', async t => {
  const f = await fixture(t, (context, { cwd, planPath }) => {
    if (context.messages.at(-1).role === 'toolResult') return { text: 'stopped' };
    fs.symlinkSync(planPath, path.join(cwd, 'output.txt'));
    return { tool: { name: 'write', arguments: { path: 'output.txt', content: 'forbidden' } } };
  });
  const before = canonicalBytes(f);
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.deepEqual(canonicalBytes(f), before); f.passed();
});

for (const tool of ['write', 'edit']) test(`SDK ${tool} path normalization cannot bypass exact file ownership`, async t => {
  const name = 'owned\u00a0file.txt';
  const f = await fixture(t, context => context.messages.at(-1).role === 'toolResult' ? { text: 'stopped' } :
    { tool: { name: tool, arguments: tool === 'write' ? { path: name, content: 'forbidden' } :
      { path: name, edits: [{ oldText: 'before', newText: 'forbidden' }] } } });
  const owned = path.join(f.cwd, name), unowned = path.join(f.cwd, 'owned file.txt');
  fs.writeFileSync(owned, 'before'); fs.writeFileSync(unowned, 'before');
  f.options.assignment.owned_paths = [owned];
  const result = await f.runner.runPiAssignment(f.options);
  assert.equal(result.phase, 'failed', JSON.stringify(result));
  assert.equal(fs.readFileSync(owned, 'utf8'), 'before');
  assert.equal(fs.readFileSync(unowned, 'utf8'), 'before'); f.passed();
});

for (const [preference, expected] of [['none', 'off'], ['minimal', 'minimal'], ['low', 'low'], ['high', 'high'], ['inherit', 'medium'], ['ultra', 'medium'], ['max', 'medium'], ['xhigh', 'medium']]) {
  test(`child effort ${preference} reaches the actual provider without silent clamping`, async t => {
    const f = await fixture(t, undefined, true);
    f.plan.steps[0].reasoning_effort = preference; core.saveMarkdown(f.planPath, f.plan);
    f.options.assignment.reasoning_effort = preference; f.options.thinkingLevel = 'medium';
    const r = await f.runner.runPiAssignment(f.options);
    assert.equal(r.phase, 'settled', JSON.stringify(r));
    assert.equal(r.effort.actual, expected); assert.equal(r.result.effort.actual, expected);
    assert.equal(f.requestSettings[0] ?? 'off', expected);
    assert.equal(Boolean(r.effort.limitation), ['ultra', 'max', 'xhigh'].includes(preference));
    assert.equal(r.effort.baseline, 'medium'); f.passed();
  });
}

async function coordinatorSession(f) {
  const loader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: f.sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Offline effort test', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  return (await f.sdk.createAgentSession({ cwd: f.cwd, agentDir: path.join(f.cwd, 'coordinator'),
    modelRuntime: f.options.modelRuntime, model: f.options.model, thinkingLevel: 'medium', tools: [], resourceLoader: loader,
    settingsManager: f.sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    sessionManager: f.sdk.SessionManager.inMemory(f.cwd) })).session;
}

test('current SDK coordinator restores original effort after override, failure and cancellation; inherit is original', async t => {
  const f = await fixture(t, undefined, true);
  const session = await coordinatorSession(f); t.after(() => session.dispose());
  const controller = f.runner.createSessionEffortController(session);
  await controller.run('high', () => session.prompt('high'));
  assert.equal(session.thinkingLevel, 'medium');
  await controller.run('inherit', () => session.prompt('inherit'));
  await controller.run('none', () => session.prompt('none'));
  await assert.rejects(controller.run('low', async () => { await session.prompt('low'); throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(session.thinkingLevel, 'medium');
  const abort = new AbortController();
  await assert.rejects(controller.run('high', async () => { await session.prompt('cancel'); abort.abort(); }, abort.signal), /abort/i);
  assert.equal(session.thinkingLevel, 'medium');
  assert.deepEqual(f.requestSettings.map(x => x ?? 'off'), ['high', 'medium', 'off', 'low', 'high']);
  f.passed();
});

test('concurrent SDK effort scopes isolate separate sessions and reject same-session overlap', async t => {
  const f = await fixture(t, undefined, true), g = await fixture(t, undefined, true);
  const one = await coordinatorSession(f), two = await coordinatorSession(g);
  t.after(() => { one.dispose(); two.dispose(); });
  const a = f.runner.createSessionEffortController(one), b = g.runner.createSessionEffortController(two);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = a.run('high', async () => { await gate; await one.prompt('one'); });
  await assert.rejects(a.run('low', () => one.prompt('overlap')), /already owns/);
  await b.run('low', () => two.prompt('two')); release(); await first;
  assert.equal(f.requestSettings[0], 'high'); assert.equal(g.requestSettings[0], 'low');
  assert.equal(one.thinkingLevel, 'medium'); assert.equal(two.thinkingLevel, 'medium'); f.passed(); g.passed();
});

for (const preference of ['xhigh', 'max']) test(`model-advertised ${preference} is applied rather than generically rejected`, async t => {
  const f = await fixture(t, undefined, true);
  f.options.model = { ...f.options.model, thinkingLevelMap: { [preference]: preference } };
  f.plan.steps[0].reasoning_effort = preference; core.saveMarkdown(f.planPath, f.plan);
  f.options.assignment.reasoning_effort = preference;
  const r = await f.runner.runPiAssignment(f.options);
  assert.equal(r.phase, 'settled', JSON.stringify(r)); assert.equal(r.effort.actual, preference);
  assert.equal(f.requestSettings[0], preference); assert.equal(r.effort.limitation, undefined); f.passed();
});

test('active SDK cancellation restores effort only after provider settlement and rejects mid-turn overrides', async t => {
  let started; const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async (_context, { signal }) => {
    started();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    return { text: 'aborted' };
  }, true);
  const session = await coordinatorSession(f); t.after(() => session.dispose());
  const controller = f.runner.createSessionEffortController(session), abort = new AbortController();
  const run = controller.run('high', () => session.prompt('wait'), abort.signal);
  await entered;
  assert.throws(() => f.runner.applySessionEffort(session, 'low', 'medium'), /idle model-turn boundary/);
  abort.abort(); await assert.rejects(run, /abort/i);
  assert.equal(session.isIdle, true); assert.equal(session.thinkingLevel, 'medium');
  assert.equal(f.requestSettings[0], 'high'); f.passed();
});

function waitingProvider() {
  let entered, returned = false;
  const started = new Promise(resolve => { entered = resolve; });
  return { started, get returned() { return returned; }, respond: async (_context, { signal }) => {
    entered();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    returned = true; return { text: 'cancelled' };
  } };
}

for (const stopKind of ['signal', 'deadline', 'paused', 'cancelled', 'finished', 'scope', 'owner']) test(`foreground recovery joins actual SDK cancellation on ${stopKind}`, { timeout: 10000 }, async t => {
  const provider = waitingProvider(), f = await fixture(t, provider.respond);
  const controller = new AbortController(); f.options.signal = controller.signal;
  if (stopKind === 'deadline') f.options.timeoutMs = 100;
  const running = f.runner.runPiAssignment(f.options); await provider.started;
  if (stopKind === 'signal') controller.abort();
  if (!['signal', 'deadline'].includes(stopKind)) await core.mutatePlan(f.planPath, 'coordinator', plan => {
    if (['paused', 'cancelled'].includes(stopKind)) plan.execution.state = stopKind;
    if (stopKind === 'finished') { plan.lifecycle = 'finished'; delete plan.execution; }
    if (stopKind === 'scope') plan.steps[0].description = 'Changed during model work';
    if (stopKind === 'owner') plan.execution_owner = 'new-owner';
    plan.revision++; return [plan, true];
  });
  const r = await running;
  assert.equal(r.phase, 'failed', JSON.stringify(r)); assert.equal(r.result.outcome, 'cancelled');
  assert.equal(r.result.quiescence.state, 'verified'); assert.equal(provider.returned, true);
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.steps[0].status, 'in_progress'); f.passed();
});

test('shutdown supervisor joins all peers after early rejection and never reopens dispatch', async t => {
  const provider = waitingProvider(), f = await fixture(t, (context, env) => context.messages.at(-1).role === 'toolResult'
    ? provider.respond(context, env) : { tool: { name: 'write', arguments: { path: 'output.txt', content: 'partial work' } } }), bad = await fixture(t);
  const supervisor = new f.runner.PiAssignmentSupervisor();
  const running = supervisor.run(f.options); await provider.started;
  bad.authority.currentRunAuthorized = false;
  await assert.rejects(supervisor.run(bad.options), /Saved approval/);
  assert.equal(provider.returned, false, 'one rejection cannot mean peers stopped');
  const stopped = await supervisor.stop('parent shutdown');
  assert.equal(provider.returned, true); assert.equal(supervisor.activeCount, 0);
  assert.equal((await running).result.outcome, 'cancelled');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'output.txt'), 'utf8'), 'partial work', 'cancellation does not roll back the peer writer');
  assert.deepEqual((await running).result.changed_paths, [path.join(f.cwd, 'output.txt')]);
  // Conservative admission failure remains an explicitly unknown observation.
  assert.equal(stopped.state, 'unknown');
  assert.throws(() => supervisor.run(f.options), /supervisor stopped/); f.passed(); bad.passed();
});

test('uncooperative provider timeout stays uncertain even after a late response', { timeout: 10000 }, async t => {
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return { text: 'late response' }; });
  f.options.timeoutMs = 50; f.options.quiescenceTimeoutMs = 50;
  const running = f.runner.runPiAssignment(f.options); await started;
  const r = await running;
  assert.equal(r.phase, 'uncertain', JSON.stringify(r)); assert.equal(r.result, undefined);
  await assert.rejects(f.runner.runPiAssignment(f.options), /Duplicate dispatch/);
  release();
  // Keep this interrupted-runtime fixture rather than remove a workspace whose
  // quiescence the production API explicitly could not establish.
});

test('recorded result before ledger/checkpoint can be recovered idempotently without resuming paused work', async t => {
  const f = await fixture(t); const result = await f.runner.runPiAssignment(f.options);
  const ledger = f.runner.readDispatchLedger(f.planPath); ledger.records[0].phase = 'uncertain'; delete ledger.records[0].result;
  core.atomicWrite(path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json'), ledger);
  f.plan.execution.state = 'paused'; core.saveMarkdown(f.planPath, f.plan); const before = canonicalBytes(f);
  const recovered = await f.runner.recoverPiAssignment(f.planPath, 'assignment-one', f.options.authority);
  assert.equal(recovered.phase, 'settled'); assert.equal(recovered.handle.session.native_id, result.handle.session.native_id);
  assert.equal(recovered.verification, undefined); assert.deepEqual(canonicalBytes(f), before);
  assert.deepEqual(await f.runner.recoverPiAssignment(f.planPath, 'assignment-one', f.options.authority), recovered);
  await assert.rejects(f.runner.verifyDispatch(f.planPath, 'assignment-one', f.options.authority, { acceptance_met: true, integration_checked: true, evidence: ['old success'] }), /paused/);
  assert.equal(f.requests.length, 1); f.passed();
});

for (const fault of ['workspace', 'session', 'attempt', 'missing-result']) test(`recovery refuses ${fault} evidence drift`, async t => {
  const f = await fixture(t), record = await f.runner.runPiAssignment(f.options);
  const ledger = f.runner.readDispatchLedger(f.planPath); ledger.records[0].phase = 'uncertain'; delete ledger.records[0].result;
  if (fault === 'attempt') ledger.records[0].attempt_id = 'wrong-attempt';
  core.atomicWrite(path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json'), ledger);
  if (fault === 'workspace') fs.writeFileSync(path.join(f.cwd, 'output.txt'), 'external change');
  if (fault === 'session') { const data = JSON.parse(fs.readFileSync(record.result_path)); data.session.native_id = 'other'; core.atomicWrite(record.result_path, data); }
  if (fault === 'missing-result') fs.unlinkSync(record.result_path);
  await assert.rejects(f.runner.recoverPiAssignment(f.planPath, 'assignment-one', f.options.authority));
  assert.equal(f.runner.readDispatchLedger(f.planPath).records[0].phase, 'uncertain'); assert.equal(f.requests.length, 1); f.passed();
});

test('SDK retry agent_end is not treated as settlement', async t => {
  let calls = 0;
  const f = await fixture(t, (_context, { runner, planPath }) => {
    assert.equal(runner.readDispatchLedger(planPath).records[0].result, undefined);
    return ++calls === 1 ? { error: '429 rate limit exceeded' } : { text: 'recovered after retry' };
  });
  f.options.runtimeSettings = { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } };
  const r = await f.runner.runPiAssignment(f.options);
  assert.equal(r.phase, 'settled', JSON.stringify(r)); assert.equal(calls, 2);
  const events = fs.readFileSync(r.events_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'auto_retry_start'));
  assert.ok(events.findIndex(e => e.type === 'agent_end') < events.findIndex(e => e.type === 'agent_settled')); f.passed();
});

test('real parent SDK reload stops supervised foreground children before returning', async t => {
  const provider = waitingProvider(), f = await fixture(t, provider.respond), supervisor = new f.runner.PiAssignmentSupervisor();
  const settings = f.sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new f.sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent-agent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => f.runner.bindPiAssignmentLifecycle(pi, supervisor)] });
  await loader.reload();
  const { session: parent } = await f.sdk.createAgentSession({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent-agent'),
    model: f.options.model, modelRuntime: f.options.modelRuntime, thinkingLevel: 'off', tools: [],
    sessionManager: f.sdk.SessionManager.inMemory(f.cwd), settingsManager: settings, resourceLoader: loader });
  t.after(() => parent.dispose());
  await parent.bindExtensions({ mode: 'json' });
  const running = supervisor.run(f.options); await provider.started;
  await parent.reload();
  assert.equal((await running).result.outcome, 'cancelled'); assert.equal(provider.returned, true);
  assert.equal(supervisor.activeCount, 0);
  assert.equal((await supervisor.stop('idempotent shutdown')).state, 'verified');
  assert.throws(() => supervisor.run(f.options), /supervisor stopped/); f.passed();
});

test('session switch lifecycle refuses unknown writers and does not authorize replacement work', async t => {
  const { runner } = await load(); const handlers = new Map();
  const mock = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
  let reason;
  const off = runner.bindPiAssignmentLifecycle(mock, { async stop(value) { reason = value; return { state: 'unknown', reason: 'unjoined writer' }; } });
  assert.deepEqual(await handlers.get('session_before_switch')(), { cancel: true }); assert.equal(reason, 'session switch');
  await handlers.get('session_shutdown')(); assert.equal(reason, 'session shutdown/reload'); off(); assert.equal(handlers.size, 0);
});

test('real SDK compaction recovery attempt does not fabricate successful settlement', async t => {
  let calls = 0;
  const f = await fixture(t, () => ++calls === 1 ? { error: 'maximum context length exceeded' } : { error: 'fixture compaction unavailable' });
  f.options.runtimeSettings = { compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 } };
  const r = await f.runner.runPiAssignment(f.options);
  assert.equal(r.phase, 'failed', JSON.stringify(r)); assert.equal(r.result.outcome, 'failed');
  const events = fs.readFileSync(r.events_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'compaction_start'));
  assert.ok(events.some(e => e.type === 'compaction_end'));
  assert.equal(events.at(-1).type, 'agent_settled'); f.passed();
});

async function reviewFixture(t, intent, respond) {
  const f = await fixture(t, respond);
  const { execFileSync } = require('node:child_process');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.test', ...args], { cwd: f.cwd, stdio: 'pipe' });
  git(['init', '-q', '--template=']);
  fs.writeFileSync(path.join(f.cwd, 'code.txt'), 'baseline'); git(['add', 'code.txt']); git(['commit', '-qm', 'isolated test baseline']);
  fs.writeFileSync(path.join(f.cwd, 'code.txt'), 'staged'); git(['add', 'code.txt']);
  fs.writeFileSync(path.join(f.cwd, 'code.txt'), 'dirty working content');
  fs.writeFileSync(path.join(f.cwd, 'untracked.txt'), 'new untracked content');
  f.plan.steps[0].status = 'completed';
  if (intent === 'code-review') f.plan.steps.push({ id: 'review', title: 'Review captured changes', kind: 'review', status: 'pending',
    depends_on: ['one'], checks: ['Inspect dirty content', 'Inspect untracked addition'], reasoning_effort: 'inherit' });
  const request = { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'review-run', operations: [],
    ...(intent === 'code-review' ? { intent: 'implement', selected_step_ids: ['review'] } :
      { intent: 'review', review_mode: 'independent', target_step_ids: ['one'], review_focus: 'Verify requirements' }) };
  f.plan = core.applyRequest(f.plan, request)[0];
  if (intent === 'code-review') f.plan = core.checkpoint(f.plan, f.plan.revision, 'review', 'in_progress', 'Begin approved review')[0];
  core.saveMarkdown(f.planPath, f.plan); f.authority.requestId = 'review-run';
  f.reviewOptions = { planPath: f.planPath, intent, stepId: intent === 'code-review' ? 'review' : undefined,
    source: f.cwd, files: ['code.txt', 'untracked.txt'], attemptId: 'review-attempt', authority: f.options.authority,
    modelRuntime: f.options.modelRuntime, model: f.options.model, thinkingLevel: 'off' };
  return f;
}
function reviewData(context) {
  const user = context.messages.find(m => m.role === 'user');
  const text = typeof user.content === 'string' ? user.content : user.content.map(c => c.text ?? '').join('');
  return JSON.parse(text.slice(text.indexOf('\n{') + 1));
}
function reportAnswer(context, status = 'passed') {
  const { review } = reviewData(context);
  return { tool: { name: 'report_review', arguments: { snapshot_digest: review.snapshot.digest,
    checks: review.checks.map((_, index) => ({ id: index + 1, status, evidence: `Observed captured content for check ${index + 1}`, blocking: status === 'finding' })) } } };
}
for (const intent of ['code-review', 'plan-review']) test(`fresh ${intent} captures dirty/index/untracked content and returns correlated evidence without canonical completion`, async t => {
  let turn = 0;
  const f = await reviewFixture(t, intent, context => {
    if (++turn === 1) return { tool: { name: 'read', arguments: { path: 'working/code.txt' } } };
    if (turn === 2) return { tool: { name: 'search_review', arguments: { query: 'untracked' } } };
    if (turn === 3) return reportAnswer(context);
    return { text: 'Review evidence returned.' };
  });
  const before = canonicalBytes(f);
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled', JSON.stringify(result)); assert.equal(result.assignment.role, 'review');
  assert.equal(result.review_report.checks.length, intent === 'code-review' ? 2 : 3);
  assert.deepEqual(canonicalBytes(f), before);
  assert.deepEqual(f.ai.getCurrentTools(f.requests[0].messages).map(t => t.name).sort(), ['read', 'report_review', 'search_review', 'test_review']);
  const snap = result.review.snapshot;
  assert.equal(fs.readFileSync(path.join(snap.root, 'baseline/code.txt'), 'utf8'), 'baseline');
  assert.equal(fs.readFileSync(path.join(snap.root, 'index/code.txt'), 'utf8'), 'staged');
  assert.equal(fs.readFileSync(path.join(snap.root, 'working/code.txt'), 'utf8'), 'dirty working content');
  assert.equal(fs.readFileSync(path.join(snap.root, 'working/untracked.txt'), 'utf8'), 'new untracked content');
  assert.notEqual(snap.files['code.txt'].working, snap.files['code.txt'].index);
  assert.equal(snap.files['untracked.txt'].baseline, null);
  const entries = fs.readFileSync(result.handle.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].parentSession, undefined); assert.equal(entries.filter(e => e.type === 'message' && e.message.role === 'user').length, 1);
  assert.deepEqual(await f.runner.runPiReview(f.reviewOptions), result, 'retry inspects existing reviewer, never relaunches');
  assert.equal(f.requests.length, 4);
  const verified = await f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['Fixture coordinator checked captured files and report correlation'] });
  assert.ok(verified.verification); assert.deepEqual(canonicalBytes(f), before);
  fs.writeFileSync(path.join(f.cwd, 'code.txt'), 'drifted after review');
  await assert.rejects(f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['stale review claim'] }), /drifted/); f.passed();
});

test('code-review acceptance survives unrelated plan edits without accepting reviewed requirement drift', async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled');
  assert.equal(result.review.requirements_scope, 'code-review-closure-v1');
  const applied = await core.mutatePlan(f.planPath, f.authority.actorId, plan => core.applyRequest(plan, {
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'unrelated-plan-addition', intent: 'edit',
    operations: [{ type: 'add_step', step_id: 'unrelated', title: 'Future unrelated work' }],
  }));
  assert.deepEqual(applied.plan.execution.selected_step_ids, ['review']);
  const verification = { acceptance_met: true, integration_checked: true, evidence: ['Fixture coordinator checked source, captured requirements and report'] };
  await f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority, verification);
  // Canonical completion must use the same scoped rule, not just verification.
  const completed = await core.mutatePlan(f.planPath, f.authority.actorId,
    plan => core.checkpoint(plan, plan.revision, 'review', 'completed', 'Fixture reviewed scope verified'));
  assert.equal(completed.plan.steps.find(s => s.id === 'review').status, 'completed');
  assert.equal(completed.plan.steps.find(s => s.id === 'unrelated').status, 'pending');
  f.passed();
});

test('independent plan reviews retain whole-plan context requirements', async t => {
  const f = await reviewFixture(t, 'plan-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled');
  assert.equal(result.review.requirements_scope, undefined);
  await core.mutatePlan(f.planPath, f.authority.actorId, plan => core.applyRequest(plan, {
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'changed-plan-context', intent: 'edit',
    operations: [{ type: 'add_step', step_id: 'new-context', title: 'Unreviewed architectural requirement' }],
  }));
  await assert.rejects(f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['Cannot accept changed whole-plan context'] }), /Review requirements changed/);
  f.passed();
});

for (const status of ['finding', 'not-verified']) test(`review ${status} keeps required checks incomplete`,  async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context, status));
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled', JSON.stringify(result));
  await assert.rejects(f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['cannot bypass required checks'] }), /unresolved/);
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.steps.at(-1).status, 'in_progress'); f.passed();
});

for (const name of ['write', 'edit', 'bash', 'hyperion_plan', 'subagent']) test(`reviewer cannot call ${name}`, async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : { tool: { name, arguments: { path: 'working/code.txt', content: 'forbidden' } } });
  const before = canonicalBytes(f), result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'failed', JSON.stringify(result)); assert.deepEqual(canonicalBytes(f), before);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'code.txt'), 'utf8'), 'dirty working content'); f.passed();
});

test('review read cannot escape captured paths or inspect parent session files', async t => {
  const f = await reviewFixture(t, 'code-review', (context, { planPath }) => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } :
    { tool: { name: 'read', arguments: { path: planPath } } });
  const result = await f.runner.runPiReview(f.reviewOptions); assert.equal(result.phase, 'failed', JSON.stringify(result)); f.passed();
});

test('vetted review test runs once in a disposable copy and cannot change captured/source files', async t => {
  let turn = 0, executions = 0;
  const f = await reviewFixture(t, 'code-review', context => {
    if (++turn <= 2) return { tool: { name: 'test_review', arguments: { id: 'fixture-check' } } };
    if (turn === 3) return reportAnswer(context); return { text: 'done' };
  });
  f.reviewOptions.reviewTests = { 'fixture-check': { description: 'Trusted synchronous fixture assertion', async run(cwd, signal) {
    executions++; signal.throwIfAborted(); assert.notEqual(cwd, f.cwd);
    assert.equal(fs.readFileSync(path.join(cwd, 'code.txt'), 'utf8'), 'dirty working content');
    fs.writeFileSync(path.join(cwd, 'test-output.txt'), 'observed');
    return { status: 'passed', evidence: 'Read captured dirty code and wrote isolated test output', quiescence: { state: 'verified', evidence: ['All fixture filesystem operations completed synchronously'] } };
  } } };
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled', JSON.stringify(result)); assert.equal(executions, 1);
  const artifacts = result.controlled_tests['fixture-check'];
  assert.equal(fs.readFileSync(path.join(artifacts.artifact_root, 'test-output.txt'), 'utf8'), 'observed');
  assert.equal(fs.existsSync(path.join(result.review.snapshot.root, 'working/test-output.txt')), false);
  assert.equal(fs.existsSync(path.join(f.cwd, 'test-output.txt')), false);
  f.runner.assertReviewSnapshotCurrent(result.review.snapshot);
  fs.writeFileSync(path.join(artifacts.artifact_root, 'test-output.txt'), 'drifted');
  await assert.rejects(f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['test artifacts must still match'] }), /artifacts drifted/);
  fs.rmSync(artifacts.artifact_root, { recursive: true, force: true }); f.passed();
});

test('unavailable review test is not verified even when reviewer prose overclaims success', async t => {
  let turn = 0;
  const f = await reviewFixture(t, 'code-review', context => {
    if (++turn === 1) return { tool: { name: 'test_review', arguments: { id: 'npm test; arbitrary commands are not IDs' } } };
    if (turn === 2) return reportAnswer(context); return { text: 'All tests passed (untrusted claim)' };
  });
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled'); assert.equal(Object.values(result.controlled_tests)[0].status, 'not-verified');
  await assert.rejects(f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['cannot fabricate executed tests'] }), /tests remain unresolved/); f.passed();
});

test('freshness check request cannot launch an independent plan reviewer', async t => {
  const f = await reviewFixture(t, 'plan-review', () => ({ text: 'must not run' }));
  delete f.plan.plan_reviews; core.saveMarkdown(f.planPath, f.plan);
  await assert.rejects(f.runner.runPiReview(f.reviewOptions), /No active explicitly requested independent plan review/);
  assert.equal(f.requests.length, 0); f.passed();
});

test('interrupted reviewer preserves its identity and retry returns that record without a fresh launch', async t => {
  const provider = waitingProvider(), f = await reviewFixture(t, 'code-review', provider.respond), abort = new AbortController();
  f.reviewOptions.signal = abort.signal;
  const running = f.runner.runPiReview(f.reviewOptions); await provider.started; abort.abort();
  const result = await running; assert.equal(result.result.outcome, 'cancelled');
  delete f.reviewOptions.signal;
  const retry = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(retry.handle.session.native_id, result.handle.session.native_id); assert.equal(f.requests.length, 1); f.passed();
});

for (const fault of ['digest', 'missing-check', 'duplicate-check', 'blocking-pass']) test(`malformed ${fault} review reports cannot settle successfully`, async t => {
  const f = await reviewFixture(t, 'code-review', context => {
    if (context.messages.at(-1).role === 'toolResult') return { text: 'done' };
    const answer = reportAnswer(context), report = answer.tool.arguments;
    if (fault === 'digest') report.snapshot_digest = 'wrong-snapshot';
    if (fault === 'missing-check') report.checks.pop();
    if (fault === 'duplicate-check') report.checks[1].id = 1;
    if (fault === 'blocking-pass') report.checks[0].blocking = true;
    return answer;
  });
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'failed', JSON.stringify(result)); assert.equal(result.review_report, undefined); f.passed();
});

for (const drift of ['manifest', 'index', 'mode', 'requirements', 'report', 'transcript']) test(`review acceptance detects ${drift} drift`, async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled');
  if (drift === 'manifest') fs.writeFileSync(path.join(result.review.snapshot.root, 'manifest.json'), '{}');
  if (drift === 'index') require('node:child_process').execFileSync('git', ['add', 'code.txt'], { cwd: f.cwd });
  if (drift === 'mode') fs.chmodSync(path.join(f.cwd, 'code.txt'), 0o700);
  if (drift === 'requirements') { f.plan.steps[0].done_when = 'New unreviewed acceptance criterion'; core.saveMarkdown(f.planPath, f.plan); }
  if (drift === 'report') { const saved = JSON.parse(fs.readFileSync(result.result_path)); saved.review_report.checks[0].evidence = 'tampered'; fs.writeFileSync(result.result_path, JSON.stringify(saved)); }
  if (drift === 'transcript') { const entries = fs.readFileSync(result.handle.transcript_path, 'utf8').trim().split('\n').map(JSON.parse); entries[0].id = 'wrong-session'; fs.writeFileSync(result.handle.transcript_path, entries.map(JSON.stringify).join('\n')); }
  await assert.rejects(f.runner.verifyDispatch(f.planPath, result.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['stale or inconsistent evidence cannot pass'] }), /drifted|requirements changed|correlation changed/); f.passed();
});

test('capture retains staged deletion, file modes and prototype-named files without losing manifest entries', async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  require('node:child_process').execFileSync('git', ['rm', '-f', 'code.txt'], { cwd: f.cwd });
  fs.writeFileSync(path.join(f.cwd, '__proto__'), 'ordinary source filename'); f.reviewOptions.files.push('__proto__');
  const result = await f.runner.runPiReview(f.reviewOptions);
  assert.equal(result.phase, 'settled', JSON.stringify(result));
  assert.equal(result.review.snapshot.files['code.txt'].working, null); assert.equal(result.review.snapshot.files['code.txt'].index, null);
  assert.equal(result.review.snapshot.files['code.txt'].baseline_mode, '100644');
  assert.ok(Object.hasOwn(result.review.snapshot.files, '__proto__'));
  f.runner.assertReviewSnapshotCurrent(result.review.snapshot); f.passed();
});

test('unknown earlier writers prohibit capture for a new review request', async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  await f.runner.runPiReview(f.reviewOptions);
  const ledger = f.runner.readDispatchLedger(f.planPath); ledger.records[0].phase = 'uncertain'; delete ledger.records[0].result;
  fs.writeFileSync(path.join(path.dirname(f.planPath), '.hyperion-dispatch', path.basename(f.planPath), 'ledger.json'), JSON.stringify(ledger));
  f.plan = core.applyRequest(f.plan, { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'new-review-run', intent: 'implement', operations: [], selected_step_ids: ['review'] })[0];
  core.saveMarkdown(f.planPath, f.plan); f.authority.requestId = 'new-review-run';
  await assert.rejects(f.runner.runPiReview(f.reviewOptions), /Drain earlier writers/); assert.equal(f.requests.length, 2); f.passed();
});

for (const failure of ['duplicate files', 'missing file', 'no current authority']) test(`review preparation recovery: ${failure} allows corrected same-request dispatch`, async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'Report returned' } : reportAnswer(context));
  const supervisor = new f.runner.PiAssignmentSupervisor(), files = [...f.reviewOptions.files];
  if (failure === 'duplicate files') f.reviewOptions.files.push(files[0]);
  if (failure === 'missing file') f.reviewOptions.files.push('absent.txt');
  if (failure === 'no current authority') f.authority.currentRunAuthorized = false;
  await assert.rejects(supervisor.review(f.reviewOptions), error => {
    assert.equal(error.name, 'ReviewPreparationError'); return true;
  });
  assert.equal(f.requests.length, 0, 'no provider request happened');
  assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 0, 'no assignment was admitted');
  f.reviewOptions.files = files; f.authority.currentRunAuthorized = true;
  const result = await supervisor.review(f.reviewOptions);
  assert.equal(result.phase, 'settled', JSON.stringify(result));
  assert.equal(result.assignment.approved_request_id, 'review-run');
  const repeated = await supervisor.review(f.reviewOptions);
  assert.equal(repeated.handle.session.native_id, result.handle.session.native_id);
  assert.equal(f.requests.length, 2); assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 1);
  assert.equal((await supervisor.stop('done')).state, 'verified'); f.passed();
});

test('preparation rejection does not turn a later explicit supervisor stop into an unknown-writer hold', async t => {
  const f = await reviewFixture(t, 'code-review', () => assert.fail('No model work permitted'));
  const supervisor = new f.runner.PiAssignmentSupervisor();
  f.reviewOptions.files.push('absent.txt');
  await assert.rejects(supervisor.review(f.reviewOptions), /does not exist/);
  assert.equal((await supervisor.stop('user cancelled')).state, 'verified');
  f.reviewOptions.files.pop();
  assert.throws(() => supervisor.review(f.reviewOptions), /stopped/);
  assert.equal(f.requests.length, 0); f.passed();
});

test('controlled test with unknown writers leaves an uncertain reviewer and no automatic retry', async t => {
  let turn = 0, copy;
  const f = await reviewFixture(t, 'code-review', context => ++turn === 1 ? { tool: { name: 'test_review', arguments: { id: 'unsafe' } } } : { text: 'done' });
  f.reviewOptions.reviewTests = { unsafe: { description: 'Fixture reports unknown quiescence', async run(cwd) { copy = cwd; return { status: 'not-verified', evidence: 'Unknown writers', quiescence: { state: 'unknown', evidence: ['No settlement proof'] } }; } } };
  t.after(() => { if (copy) fs.rmSync(copy, { recursive: true, force: true }); });
  const supervisor = new f.runner.PiAssignmentSupervisor();
  const result = await supervisor.review(f.reviewOptions);
  assert.equal(result.phase, 'uncertain', JSON.stringify(result)); assert.equal(result.result, undefined);
  assert.throws(() => supervisor.review(f.reviewOptions), /unknown writers/);
  assert.equal((await supervisor.stop('unknown test writers')).state, 'unknown');
  assert.equal((await f.runner.runPiReview(f.reviewOptions)).handle.session.native_id, result.handle.session.native_id); f.passed();
});

test('review result recovery retains structured report and native snapshot correlation', async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const result = await f.runner.runPiReview(f.reviewOptions), ledger = f.runner.readDispatchLedger(f.planPath);
  ledger.records[0].phase = 'uncertain'; delete ledger.records[0].result; delete ledger.records[0].review_report;
  fs.writeFileSync(path.join(path.dirname(f.planPath), '.hyperion-dispatch', path.basename(f.planPath), 'ledger.json'), JSON.stringify(ledger));
  const recovered = await f.runner.recoverPiAssignment(f.planPath, result.assignment.assignment_id, f.options.authority);
  assert.deepEqual(recovered.review_report, result.review_report); assert.equal(recovered.phase, 'settled'); assert.equal(f.requests.length, 2); f.passed();
});

test('native review tool normalizes duplicate files and uses public registry proxy with fresh SDK context and current authority', async t => {
  let f, childRequests = 0;
  f = await reviewFixture(t, 'code-review', context => {
    const names = f.ai.getCurrentTools(context.messages).map(t => t.name);
    if (names.includes('hyperion_review')) {
      if (context.messages.at(-1).role === 'toolResult') return { text: 'Coordinator received evidence without completion.' };
      const user = context.messages.at(-1);
      return { tool: { name: 'hyperion_review', arguments: { plan_path: f.planPath, request_id: 'review-run', intent: 'code-review', step_id: 'review',
        files: ['code.txt', 'untracked.txt', 'code.txt'], current_request_authorized: !JSON.stringify(user).includes('no authority') } } };
    }
    childRequests++;
    assert.doesNotMatch(JSON.stringify(context.messages), /PRIVATE_PARENT_HISTORY/);
    return context.messages.at(-1).role === 'toolResult' ? { text: 'Review report returned' } : reportAnswer(context);
  });
  const extension = (await import(url('dist/hyperion-plan-pi.js'))).default;
  const settings = f.sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new f.sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
  await loader.reload();
  const { session: parent } = await f.sdk.createAgentSession({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent'),
    model: f.options.model, modelRuntime: f.options.modelRuntime, thinkingLevel: 'off', tools: ['hyperion_review'],
    sessionManager: f.sdk.SessionManager.inMemory(f.cwd), settingsManager: settings, resourceLoader: loader });
  t.after(() => parent.dispose()); await parent.bindExtensions({ mode: 'json' });
  const before = canonicalBytes(f);
  await parent.prompt('PRIVATE_PARENT_HISTORY: run the explicitly authorized review-run scope only.');
  const record = f.runner.readDispatchLedger(f.planPath).records[0];
  assert.ok(record, JSON.stringify(parent.messages)); assert.equal(record.phase, 'settled', JSON.stringify(record));
  assert.equal(record.assignment.owner.native_id, parent.sessionId); assert.equal(childRequests, 2);
  assert.deepEqual(Object.keys(record.review.snapshot.files).sort(), ['code.txt', 'untracked.txt']);
  assert.deepEqual(canonicalBytes(f), before);
  await parent.prompt('no authority: do not launch a reviewer from stored approval');
  assert.equal(childRequests, 2);
  assert.ok(parent.messages.some(m => m.role === 'toolResult' && m.isError && JSON.stringify(m).includes('Explicit current review authority')));
  f.passed();
});

for (const outcome of ['pass', 'skip', 'fail']) test(`native fixed suite ${outcome}: actual SDK tool transport, captured execution and completion gate`, async t => {
  let f, turns = 0, artifacts;
  f = await reviewFixture(t, 'code-review', context => {
    if (f.ai.getCurrentTools(context.messages).some(t => t.name === 'hyperion_review')) {
      if (context.messages.at(-1).role === 'toolResult') return { text: 'Evidence received' };
      return { tool: { name: 'hyperion_review', arguments: { plan_path: f.planPath, request_id: 'review-run', intent: 'code-review', step_id: 'review', current_request_authorized: true, files: f.reviewOptions.files } } };
    }
    const data = reviewData(context); assert.deepEqual(data.review.required_test_ids, ['.:node']);
    assert.deepEqual(data.available_test_ids.map(t => t.id), ['.:node']);
    if (++turns <= 2 && outcome !== 'skip') return { tool: { name: 'test_review', arguments: { id: '.:node' } } };
    if (turns === (outcome === 'skip' ? 1 : 3)) return reportAnswer(context);
    return { text: 'Fixture report returned' };
  });
  fs.mkdirSync(path.join(f.cwd, 'tests')); fs.mkdirSync(path.join(f.cwd, 'node_modules'));
  fs.writeFileSync(path.join(f.cwd, 'package.json'), '{"name":"native-fixture","scripts":{"test":"never run this"}}');
  for (const name of ['package-lock.json','node_modules/.package-lock.json']) fs.writeFileSync(path.join(f.cwd, name), '{"lockfileVersion":3,"packages":{}}');
  fs.writeFileSync(path.join(f.cwd, 'tests/real.test.cjs'), `require('node:test').test('captured native test',()=>{${outcome === 'fail' ? "throw Error('fixture failure')" : "console.log('NATIVE_SUITE_ACTUALLY_RAN')"}});`);
  f.reviewOptions.files.push('package.json','package-lock.json','tests/real.test.cjs');
  const extension = (await import(url('dist/hyperion-plan-pi.js'))).default;
  const settings = f.sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new f.sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent'), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
  await loader.reload();
  const {session: parent} = await f.sdk.createAgentSession({ cwd: f.cwd, agentDir: path.join(f.cwd,'parent'), model: f.options.model, modelRuntime: f.options.modelRuntime, thinkingLevel: 'off', tools: ['hyperion_review'], sessionManager: f.sdk.SessionManager.inMemory(f.cwd), settingsManager: settings, resourceLoader: loader });
  t.after(()=>{parent.dispose();if(artifacts)fs.rmSync(artifacts,{recursive:true,force:true});}); await parent.bindExtensions({mode:'json'});
  const before = canonicalBytes(f); await parent.prompt('Explicit fixture review with fixed native tests');
  const record = f.runner.readDispatchLedger(f.planPath).records[0]; assert.ok(record,JSON.stringify(parent.messages)); assert.equal(record.phase,'settled',JSON.stringify(record));
  assert.deepEqual(canonicalBytes(f),before); f.authority.actorId=parent.sessionId;
  const result=record.controlled_tests?.['.:node']; artifacts=result?.artifact_root;
  if (outcome === 'pass') {
    assert.equal(result.status,'passed'); assert.match(fs.readFileSync(path.join(artifacts,'.hyperion-test-results/suite.log'),'utf8'),/NATIVE_SUITE_ACTUALLY_RAN/);
    const calls=fs.readFileSync(record.handle.transcript_path,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.message?.role==='toolResult'&&e.message.toolName==='test_review');assert.equal(calls.length,2);
    assert.equal(JSON.parse(calls[0].message.content[0].text).artifact_root,JSON.parse(calls[1].message.content[0].text).artifact_root,'duplicate IDs reuse one retained run');
    await f.runner.verifyDispatch(f.planPath,record.assignment.assignment_id,f.options.authority,{acceptance_met:true,integration_checked:true,evidence:['Fixture observed actual native captured test log, report and source preservation']});
  } else await assert.rejects(f.runner.verifyDispatch(f.planPath,record.assignment.assignment_id,f.options.authority,{acceptance_met:true,integration_checked:true,evidence:['Overclaim must fail']}),/Required native review suites/);
  if(outcome!=='pass') await assert.rejects(core.mutatePlan(f.planPath,parent.sessionId,p=>core.checkpoint(p,p.revision,'review','completed','Unverified completion')),/verification is required/);
  assert.equal(fs.existsSync(path.join(f.cwd,'.hyperion-test-results')),false); f.runner.assertReviewSnapshotCurrent(record.review.snapshot); f.passed();
});

for (const mode of ['json', 'tui']) test(`one-action native review ${mode}: missing dependencies do not gate source review or grant a false test pass`, async t => {
  let f, childTurns = 0, artifacts;
  f = await reviewFixture(t, 'code-review', context => {
    if (f.ai.getCurrentTools(context.messages).some(t => t.name === 'hyperion_review')) {
      if (context.messages.at(-1).role === 'toolResult') return { text: 'Source review received with explicit test limitations.' };
      return { tool: { name: 'hyperion_review', arguments: { plan_path: f.planPath, request_id: 'review-run', intent: 'code-review', step_id: 'review', current_request_authorized: true, files: f.reviewOptions.files } } };
    }
    if (++childTurns === 1) return { tool: { name: 'test_review', arguments: { id: '.:node' } } };
    if (childTurns === 2) return reportAnswer(context); // Even an overclaimed report cannot pass the test gate.
    return { text: 'Source review report returned.' };
  });
  fs.mkdirSync(path.join(f.cwd, 'tests'));
  fs.writeFileSync(path.join(f.cwd, 'package.json'), '{"name":"setup-fixture"}');
  fs.writeFileSync(path.join(f.cwd, 'tests/missing.test.cjs'), "throw Error('must not execute')");
  f.reviewOptions.files.push('package.json', 'tests/missing.test.cjs');
  const extension = (await import(url('dist/hyperion-plan-pi.js'))).default;
  const settings = f.sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new f.sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent'), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
  await loader.reload();
  const {session: parent} = await f.sdk.createAgentSession({ cwd: f.cwd, agentDir: path.join(f.cwd, 'parent'), model: f.options.model, modelRuntime: f.options.modelRuntime, thinkingLevel: 'off', tools: ['hyperion_review', 'hyperion_review_setup'], sessionManager: f.sdk.SessionManager.inMemory(f.cwd), settingsManager: settings, resourceLoader: loader });
  t.after(() => { parent.dispose(); if (artifacts) fs.rmSync(artifacts, { recursive: true, force: true }); });
  await parent.bindExtensions(mode === 'json' ? { mode } : { mode, uiContext: {
    notify() {}, setStatus() {}, setWidget() {}, confirm: async () => assert.fail('Review must not ask for setup permission'),
  } });
  const before = canonicalBytes(f); await parent.prompt('Run the fixture review once, without a setup detour.');
  const result = parent.messages.find(m => m.role === 'toolResult' && m.toolName === 'hyperion_review');
  assert.equal(result.isError, false, JSON.stringify(result));
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.phase, 'settled'); assert.ok(data.test_environment.limitations.length);
  const record = f.runner.readDispatchLedger(f.planPath).records[0];
  assert.equal(record.assignment.approved_request_id, 'review-run');
  assert.equal(record.assignment.owner.native_id, parent.sessionId);
  assert.equal(record.controlled_tests['.:node'].status, 'not-verified');
  artifacts = record.controlled_tests['.:node'].artifact_root;
  f.authority.actorId = parent.sessionId;
  await assert.rejects(f.runner.verifyDispatch(f.planPath, record.assignment.assignment_id, f.options.authority,
    { acceptance_met: true, integration_checked: true, evidence: ['Overclaim cannot substitute for unavailable tests'] }), /Required native review suites/);
  await parent.prompt('Repeat the same fixture request identity; inspect without duplicate dispatch.');
  assert.equal(childTurns, 3);
  assert.equal(f.runner.readDispatchLedger(f.planPath).records.length, 1);
  assert.equal(parent.messages.filter(m => m.role === 'user').length, 2, 'no injected setup follow-up');
  assert.ok(!parent.messages.some(m => m.role === 'toolResult' && m.toolName === 'hyperion_review_setup'));
  assert.deepEqual(canonicalBytes(f), before); f.passed();
});

async function waveFixture(t, respond, mode = 'auto') {
  const f = await fixture(t, respond);
  f.planPath = path.join(f.cwd, 'wave-plan.md');
  f.plan = core.initialize({ title: 'Actual SDK wave fixture', steps: ['one','two','three'].map(id => ({ id, title: `Write ${id}`, done_when: `output-${id}.txt contains approved`, reasoning_effort: 'inherit' })) });
  f.plan = core.applyRequest(f.plan, { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'wave-run', intent: 'implement', operations: [], selected_step_ids: ['one','two','three'], execution_mode: mode })[0];
  core.saveMarkdown(f.planPath, f.plan); f.authority.requestId = 'wave-run';
  const candidates = f.plan.steps.map(step => ({ assignment: { ...f.options.assignment, assignment_id: `wave-${step.id}`, plan_id: f.plan.plan_id, plan_path: f.planPath, approved_request_id: 'wave-run', step_id: step.id,
    scope_digest: core.stepFingerprint(step).scope, owned_paths: [path.join(f.cwd, `output-${step.id}.txt`)], acceptance: [step.done_when], reasoning_effort: 'inherit',
    evidence_directory: f.runner.assignmentDirectory(f.planPath, `wave-${step.id}`) }, attempt_id: `attempt-${step.id}`, read_paths: [], resources: [], independence_evidence: ['Fixture modules and live inputs are disjoint'] }));
  f.wave = { waveId: 'wave-1', candidates, authority: f.options.authority, modelRuntime: f.options.modelRuntime, model: f.options.model, thinkingLevel: 'off' };
  return f;
}
function waveAnswer(context) {
  if (context.messages.at(-1).role === 'toolResult') return { text: 'Observed owned write; coordinator verifies acceptance.' };
  const data = reviewData(context);
  return { tool: { name: 'write', arguments: { path: data.assignment.owned_paths[0], content: 'approved' } } };
}

const checkedWave = { acceptance_met: true, integration_checked: true, evidence: ['Fixture coordinator read approved owned output and checked integration'] };
for (const route of ['service', 'CLI']) for (const fault of ['actor', 'missing-actor', 'request', 'paused', 'cancelled', 'unselected', 'missing-execution', 'combined-request', 'combined-pause', 'combined-cancel']) {
  test(`wave completion boundary rejects ${fault} via ${route}`, async t => {
    const f = await waveFixture(t, waveAnswer);
    f.wave.candidates = f.wave.candidates.slice(0, 1);
    await f.runner.runPiWave(f.wave);
    await f.runner.verifyDispatch(f.planPath, 'wave-one', f.options.authority, checkedWave);
    let p = (await core.loadPlanSnapshot(f.planPath)).plan;
    assert.equal(p.execution_owner, undefined, 'the assigning actor must be enforced even before handover');
    if (fault === 'request') p = core.applyRequest(p, { plan_id: p.plan_id, base_revision: p.revision, request_id: 'later-wave-run',
      intent: 'implement', operations: [], selected_step_ids: ['one'] })[0];
    if (fault === 'paused' || fault === 'cancelled') p = core.checkpoint(p, p.revision, undefined, undefined, undefined, undefined, fault)[0];
    if (fault === 'unselected') p.execution.selected_step_ids = ['three'];
    if (fault === 'missing-execution') delete p.execution;
    if (['request', 'paused', 'cancelled', 'unselected', 'missing-execution'].includes(fault)) core.saveMarkdown(f.planPath, p);
    const actor = fault === 'actor' ? 'other-coordinator' : fault === 'missing-actor' ? undefined : 'coordinator';
    const state = fault === 'combined-pause' ? 'paused' : fault === 'combined-cancel' ? 'cancelled' : undefined;
    const request = { plan_id: p.plan_id, base_revision: p.revision, request_id: 'wave-completion-attempt',
      intent: fault === 'combined-request' ? 'implement' : 'edit', operations: [{ type: 'set_status', step_id: 'one', status: 'completed' }],
      ...(fault === 'combined-request' ? { selected_step_ids: ['two'] } : {}) };
    const input = path.join(f.cwd, 'completion-request.json'); fs.writeFileSync(input, JSON.stringify(request));
    const before = canonicalBytes(f), ledgerPath = path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json'), ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');
    if (route === 'service') await assert.rejects(core.mutatePlan(f.planPath, actor, plan => state
      ? core.checkpoint(plan, plan.revision, 'one', 'completed', 'Old verification is not permission', undefined, state)
      : core.applyRequest(plan, request)), /assigning coordinator|Wave completion request/);
    else {
      const result = completionCLI(f, actor, state ? 'checkpoint' : 'apply', state
        ? ['--base-revision', String(p.revision), '--step-id', 'one', '--status', 'completed', '--note', 'Old verification is not permission', '--execution-state', state]
        : ['--request', input]);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /assigning coordinator|Wave completion request/);
    }
    assert.deepEqual(canonicalBytes(f), before); assert.equal(fs.readFileSync(ledgerPath, 'utf8'), ledgerBefore);
    assert.equal(f.requests.length, 2, 'completion never launches or resumes work'); f.passed();
  });
}
for (const route of ['service', 'CLI']) for (const mode of ['checkpoint', 'manual-edit']) {
  test(`wave completion boundary accepts current verified ${mode} via ${route}`, async t => {
    const f = await waveFixture(t, waveAnswer); f.wave.candidates = f.wave.candidates.slice(0, 1);
    await f.runner.runPiWave(f.wave); await f.runner.verifyDispatch(f.planPath, 'wave-one', f.options.authority, checkedWave);
    const p = (await core.loadPlanSnapshot(f.planPath)).plan;
    const request = { plan_id: p.plan_id, base_revision: p.revision, request_id: 'verified-manual-completion', intent: 'edit',
      operations: [{ type: 'set_status', step_id: 'one', status: 'completed' }] };
    const input = path.join(f.cwd, 'completion-request.json'); fs.writeFileSync(input, JSON.stringify(request));
    if (route === 'service') await core.mutatePlan(f.planPath, 'coordinator', plan => mode === 'checkpoint'
      ? core.checkpoint(plan, plan.revision, 'one', 'completed', 'Observed current integration') : core.applyRequest(plan, request));
    else {
      const result = completionCLI(f, 'coordinator', mode === 'checkpoint' ? 'checkpoint' : 'apply', mode === 'checkpoint'
        ? ['--base-revision', String(p.revision), '--step-id', 'one', '--status', 'completed', '--note', 'Observed current integration'] : ['--request', input]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const completed = (await core.loadPlanSnapshot(f.planPath)).plan.steps[0];
    assert.equal(completed.status, 'completed'); assert.equal(completed.completion_source, mode === 'checkpoint' ? 'agent' : 'user');
    assert.equal(f.requests.length, 2); f.passed();
  });
}

test('actual SDK wave overlaps two fresh workers, persists claims, never fills spare capacity and requires integration before release', { timeout: 30000 }, async t => {
  let active=0, peak=0, release;
  const both = new Promise(resolve => { release=resolve; });
  const f = await waveFixture(t, async context => {
    if (context.messages.at(-1).role !== 'toolResult') {
      active++; peak=Math.max(peak,active); if(active===2) release(); await both; active--;
    }
    return waveAnswer(context);
  });
  const messages=[]; f.wave.onProgress=m=>messages.push(m);
  const wave = await f.runner.runPiWave(f.wave);
  assert.equal(peak,2); assert.equal(wave.closed,true); assert.equal(wave.outcome.quiescence.state,'verified',JSON.stringify(wave));
  assert.equal(wave.selection.mode,'parallel'); assert.deepEqual(wave.selection.deferred.map(c=>c.step_id),['three']);
  const ledger=f.runner.readDispatchLedger(f.planPath);
  assert.equal(ledger.records.length,2); assert.equal(new Set(ledger.records.map(r=>r.handle.session.native_id)).size,2);
  assert.ok(ledger.records.every(r=>r.phase==='settled' && r.wave_id==='wave-1'));
  assert.equal(fs.existsSync(path.join(f.cwd,'output-three.txt')),false);
  assert.deepEqual((await core.loadPlanSnapshot(f.planPath)).plan.steps.map(s=>s.status),['in_progress','in_progress','pending']);
  assert.equal(messages.filter(m=>m.includes('in_progress saved')).length,2);
  assert.deepEqual(await f.runner.runPiWave(f.wave),wave,'retry inspects, not reexecutes'); assert.equal(f.requests.length,4);
  await assert.rejects(f.runner.reconcilePiWave(f.planPath,'wave-1',f.options.authority,['premature']),/Verify and checkpoint/);
  const beforeVerify=canonicalBytes(f);
  await assert.rejects(core.mutatePlan(f.planPath,'coordinator',p=>core.checkpoint(p,p.revision,'one','completed','Worker says done')),/integration verification/);
  const attempt=require('node:child_process').spawnSync(process.execPath,[path.join(root,'dist/plan.cjs'),'checkpoint','--plan',f.planPath,'--task-id','coordinator','--base-revision',String((await core.loadPlanSnapshot(f.planPath)).plan.revision),'--step-id','one','--status','completed','--note','Worker says done'],{encoding:'utf8'});
  assert.notEqual(attempt.status,0);assert.match(attempt.stderr,/integration verification/);assert.deepEqual(canonicalBytes(f),beforeVerify);
  for (const r of ledger.records) {
    assert.equal(fs.readFileSync(r.assignment.owned_paths[0],'utf8'),'approved');
    fs.writeFileSync(r.assignment.owned_paths[0],'approved\ncoordinator integration');
    await f.runner.verifyDispatch(f.planPath,r.assignment.assignment_id,f.options.authority,{acceptance_met:true,integration_checked:true,evidence:['Coordinator read owned output and inspected disjoint inputs']});
    await core.mutatePlan(f.planPath,'coordinator',p=>core.checkpoint(p,p.revision,r.assignment.step_id,'completed','Coordinator verified owned output and integration'));
  }
  const integrated=ledger.records[0].assignment.owned_paths[0]; fs.writeFileSync(integrated,'drift');
  await assert.rejects(f.runner.reconcilePiWave(f.planPath,'wave-1',f.options.authority,['premature after drift']),/integrated files must still match/);
  fs.writeFileSync(integrated,'approved\ncoordinator integration');
  const released=await f.runner.reconcilePiWave(f.planPath,'wave-1',f.options.authority,['All outputs inspected and both completion checkpoints saved']);
  assert.ok(released.reconciliation);
  const next=await f.runner.runPiWave({...f.wave,waveId:'wave-2',candidates:[f.wave.candidates[2]]});
  assert.equal(next.selection.mode,'sequential'); assert.equal(next.outcome.results[0].record.phase,'settled'); f.passed();
});
for (const mode of ['sequential','shared-write','shared-read','resource','no-assessment']) test(`actual SDK wave labels ${mode} fallback sequential`, async t => {
  const f=await waveFixture(t,waveAnswer,mode==='sequential'?'sequential':'auto');
  f.wave.candidates=f.wave.candidates.slice(0,2);
  if(mode==='shared-write') f.wave.candidates[1].assignment.owned_paths=[...f.wave.candidates[0].assignment.owned_paths];
  if(mode==='shared-read') f.wave.candidates[1].read_paths=[...f.wave.candidates[0].assignment.owned_paths];
  if(mode==='resource') for(const c of f.wave.candidates)c.resources=['generator:shared'];
  if(mode==='no-assessment') f.wave.candidates[1].independence_evidence=[];
  const result=await f.runner.runPiWave(f.wave);
  assert.equal(result.selection.mode,'sequential'); assert.equal(result.outcome.results.length,1); assert.equal(f.requests.length,2);
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.steps[1].status,'pending'); f.passed();
});
test('actual SDK wave collects success and partial failure before reconciliation, without rollback or refill',async t=>{
  let release;const oneSettled=new Promise(resolve=>{release=resolve;});
  const f=await waveFixture(t,async context=>{
    if(reviewData(context).assignment.step_id==='two'&&context.messages.at(-1).role==='toolResult'){await oneSettled;throw new Error('scripted failure after partial write');}
    return waveAnswer(context);
  });
  f.wave.onProgress=m=>{if(m.includes('one: SDK settled'))release();};
  const wave=await f.runner.runPiWave(f.wave), records=f.runner.readDispatchLedger(f.planPath).records;
  assert.deepEqual(records.map(r=>r.phase),['settled','failed']);assert.equal(wave.outcome.quiescence.state,'verified');assert.equal(records.length,2);
  assert.equal(fs.readFileSync(path.join(f.cwd,'output-two.txt'),'utf8'),'approved','partial write remains');
  await f.runner.verifyDispatch(f.planPath,records[0].assignment.assignment_id,f.options.authority,{acceptance_met:true,integration_checked:true,evidence:['Inspected successful output and peer partial change']});
  let p=(await core.loadPlanSnapshot(f.planPath)).plan;p=core.checkpoint(p,p.revision,'one','completed','Output verified centrally')[0];
  p=core.checkpoint(p,p.revision,'two','in_progress','Partial output retained and inspected','Scripted post-write failure')[0];core.saveMarkdown(f.planPath,p);
  assert.ok((await f.runner.reconcilePiWave(f.planPath,wave.id,f.options.authority,['Success integrated; incomplete partial write inspected and blocker saved'])).reconciliation);
  assert.equal(fs.existsSync(path.join(f.cwd,'output-three.txt')),false);f.passed();
});
test('actual SDK wave read tool enforces durable declared live inputs', async t => {
  const f=await waveFixture(t,context=>context.messages.at(-1).role==='toolResult'?{text:'done'}:{tool:{name:'read',arguments:{path:'secret.txt'}}});
  fs.writeFileSync(path.join(f.cwd,'secret.txt'),'not declared'); f.wave.candidates=f.wave.candidates.slice(0,1);
  const result=await f.runner.runPiWave(f.wave);
  assert.equal(result.outcome.results[0].record.phase,'failed',JSON.stringify(result));
  assert.match(fs.readFileSync(result.outcome.results[0].record.handle.transcript_path,'utf8'),/wave read claims/); f.passed();
});
test('actual SDK wave reserves only once across concurrent controllers', async t => {
  const f=await waveFixture(t,waveAnswer);
  const results=await Promise.allSettled([f.runner.runPiWave(f.wave),f.runner.runPiWave(f.wave)]);
  assert.ok(results.some(r=>r.status==='fulfilled' && r.value.closed));
  assert.equal(f.runner.readDispatchLedger(f.planPath).waves.length,1); assert.equal(f.runner.readDispatchLedger(f.planPath).records.length,2); assert.equal(f.requests.length,4); f.passed();
});
test('actual SDK wave abort joins both providers and retains cancelled results', {timeout:30000}, async t => {
  let count=0, ready; const started=new Promise(resolve=>{ready=resolve;});
  const f=await waveFixture(t,async(context,{signal})=>{ if(++count===2)ready(); await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); return {text:'late after abort'}; });
  const abort=new AbortController(); const running=f.runner.runPiWave({...f.wave,signal:abort.signal}); await started; abort.abort();
  const result=await running;
  assert.equal(result.outcome.results.length,2); assert.equal(result.outcome.quiescence.state,'verified',JSON.stringify(result));
  assert.ok(result.outcome.results.every(r=>r.record?.result.outcome==='cancelled')); assert.equal(f.requests.length,2); f.passed();
});
test('actual SDK unknown wave record prevents new requests and ordinary single dispatch', async t => {
  const f=await waveFixture(t,waveAnswer); const w=await f.runner.runPiWave(f.wave);
  const ledger=f.runner.readDispatchLedger(f.planPath); ledger.records[0].phase='uncertain'; delete ledger.records[0].result;
  fs.writeFileSync(path.join(path.dirname(f.planPath),'.hyperion-dispatch',path.basename(f.planPath),'ledger.json'),JSON.stringify(ledger));
  await assert.rejects(f.runner.reconcilePiWave(f.planPath,w.id,f.options.authority,['cannot invent quiescence']),/Unknown/);
  await assert.rejects(f.runner.runPiWave({...f.wave,waveId:'another',candidates:[f.wave.candidates[2]]}),/reservation failed/);
  const p=(await core.loadPlanSnapshot(f.planPath)).plan;
  core.saveMarkdown(f.planPath,core.checkpoint(p,p.revision,'three','in_progress','single dispatch must remain blocked')[0]);
  await assert.rejects(f.runner.runPiAssignment({...f.options,assignment:f.wave.candidates[2].assignment,attemptId:'single-after-wave'}),/wave holds dispatch/);
  assert.equal(f.requests.length,4); f.passed();
});
for(const fault of ['unselected','prerequisite','scope','owner','review-barrier','handover-barrier']) test(`actual SDK wave rejects ${fault} before any provider call`,async t=>{
  const f=await waveFixture(t,waveAnswer); let p=f.plan;
  if(fault==='unselected')p.execution.selected_step_ids=['two','three'];
  if(fault==='prerequisite')p.steps[0].depends_on=['three'];
  if(fault==='scope')f.wave.candidates[0].assignment.scope_digest='different';
  if(fault==='owner')f.authority.actorId='another';
  if(fault==='review-barrier'){p.steps.unshift({...p.steps[0],id:'baseline',status:'completed'},{...p.steps[0],id:'review',kind:'review',depends_on:['baseline'],checks:['inspect']});p.execution.selected_step_ids.unshift('review');}
  if(fault==='handover-barrier'){p.steps.unshift({id:'transfer',title:'Transfer',kind:'handover',status:'pending'});p.execution.selected_step_ids.unshift('transfer');}
  core.saveMarkdown(f.planPath,p);
  await assert.rejects(f.runner.runPiWave(f.wave)); assert.equal(f.requests.length,0); f.passed();
});
test('actual SDK wave boundary revocation leaves a checkpoint but no launched session',async t=>{
  const f=await waveFixture(t,waveAnswer);
  f.wave.onProgress=m=>{if(m.includes('in_progress saved'))f.authority.currentRunAuthorized=false;};
  const result=await f.runner.runPiWave(f.wave);
  assert.equal(result.closed,true); assert.equal(f.requests.length,0); assert.equal(f.runner.readDispatchLedger(f.planPath).records.length,0);
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.steps[0].status,'in_progress');
  assert.ok(result.outcome.not_started.includes('one')); f.passed();
});
test('actual SDK wave restart-style reservation inspection cannot launch or clear a durable hold',async t=>{
  const f=await waveFixture(t,waveAnswer); await f.runner.runPiWave(f.wave);
  const ledger=f.runner.readDispatchLedger(f.planPath); ledger.records=[]; ledger.waves[0].closed=false; delete ledger.waves[0].outcome;
  fs.writeFileSync(path.join(path.dirname(f.planPath),'.hyperion-dispatch',path.basename(f.planPath),'ledger.json'),JSON.stringify(ledger));
  const old=await f.runner.runPiWave(f.wave); assert.equal(old.closed,false); assert.equal(f.requests.length,4);
  await assert.rejects(f.runner.reconcilePiWave(f.planPath,old.id,f.options.authority,['no writer proof']),/not closed/); f.passed();
});
test('native wave tool dispatches two actual fresh SDK sessions through public registry and emits inline saved-start status',async t=>{
  let f, active=0,peak=0,release,children=0;
  const together=new Promise(resolve=>{release=resolve;});
  f=await waveFixture(t,async context=>{
    if(f.ai.getCurrentTools(context.messages).some(t=>t.name==='hyperion_wave')){
      if(context.messages.at(-1).role==='toolResult')return{text:'Coordinator received wave evidence; completion is separate.'};
      return{tool:{name:'hyperion_wave',arguments:{operation:'run',plan_path:f.planPath,request_id:'wave-run',wave_id:'native-wave',current_request_authorized:true,
        worker_sessions_authorized:!JSON.stringify(context.messages.at(-1)).includes('no worker permission'),
        assignments:f.wave.candidates.slice(0,2).map(c=>({step_id:c.assignment.step_id,owned_paths:c.assignment.owned_paths,read_paths:[],resources:[],independence_evidence:c.independence_evidence}))}}};
    }
    children++; assert.doesNotMatch(JSON.stringify(context.messages),/PRIVATE_PARENT_HISTORY/);
    assert.deepEqual(f.ai.getCurrentTools(context.messages).map(t=>t.name).sort(),['edit','read','write']);
    if(context.messages.at(-1).role!=='toolResult'){active++;peak=Math.max(peak,active);if(active===2)release();await together;active--;}
    return waveAnswer(context);
  });
  const extension=(await import(url('dist/hyperion-plan-pi.js'))).default;
  const settings=f.sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
  const loader=new f.sdk.DefaultResourceLoader({cwd:f.cwd,agentDir:path.join(f.cwd,'parent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[extension]});
  await loader.reload();
  const {session:parent}=await f.sdk.createAgentSession({cwd:f.cwd,agentDir:path.join(f.cwd,'parent'),model:f.options.model,modelRuntime:f.options.modelRuntime,thinkingLevel:'off',tools:['hyperion_wave'],
    sessionManager:f.sdk.SessionManager.inMemory(f.cwd),settingsManager:settings,resourceLoader:loader});
  t.after(()=>parent.dispose());await parent.bindExtensions({mode:'json'});
  await parent.prompt('PRIVATE_PARENT_HISTORY: explicitly authorized offline worker wave for wave-run.');
  const ledger=f.runner.readDispatchLedger(f.planPath);
  assert.equal(peak,2,JSON.stringify(parent.messages));assert.equal(children,4);assert.ok(ledger.records.every(r=>r.phase==='settled'&&r.assignment.owner.native_id===parent.sessionId));
  assert.equal(ledger.waves[0].closed,true);assert.equal(ledger.waves[0].reconciliation,undefined);
  assert.ok(parent.messages.some(m=>m.role==='custom'&&String(m.content).includes('in_progress saved')));
  await parent.prompt('no worker permission: do not launch from stored approval');assert.equal(children,4);
  assert.ok(parent.messages.some(m=>m.role==='toolResult'&&m.isError&&JSON.stringify(m).includes('permission for worker sessions')));f.passed();
});

// Handover investigation only: real public navigation primitives, NOT a
// Hyperion readiness/ownership/continuation protocol or a live-plan transfer.
test('handover capability probe: public command replacement restores a fresh SDK session after readiness-object disposal', {timeout:30000},async t=>{
  let toolContext, commandContext, freshContext, oldPi;
  const f=await fixture(t,context=>{
    const last=context.messages.at(-1);
    if(last.role==='user'&&JSON.stringify(last).includes('PROBE_TOOL_CONTEXT'))return{tool:{name:'probe_context',arguments:{}}};
    return{text:'Offline capability probe only; no implementation or ownership transfer.'};
  });
  const canonicalBefore=canonicalBytes(f), sessionsDir=path.join(f.cwd,'sessions');let runtime;
  const factory=async({cwd,sessionManager,sessionStartEvent})=>{
    const services=await f.sdk.createAgentSessionServices({cwd,agentDir:path.join(f.cwd,'probe-agent'),modelRuntime:f.options.modelRuntime,
      settingsManager:f.sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}}),
      resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{
        pi.registerTool({name:'probe_context',label:'Probe',description:'Observe public context methods',parameters:{type:'object',properties:{}},
          async execute(_id,_params,_signal,_update,ctx){toolContext={newSession:typeof ctx.newSession,switchSession:typeof ctx.switchSession};return{content:[{type:'text',text:'observed'}],details:toolContext};}});
        pi.registerCommand('probe-navigation',{description:'Isolated offline navigation probe',handler:async(file,ctx)=>{
          commandContext=ctx;oldPi=pi;await ctx.waitForIdle();
          await ctx.switchSession(file,{withSession:async next=>{freshContext=next;await next.sendUserMessage('Fresh destination navigation probe. No implementation or transfer authority.');}});
        }});
      }]}});
    return{...await f.sdk.createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model:f.options.model,thinkingLevel:'off',tools:['probe_context']}),services,diagnostics:services.diagnostics};
  };
  runtime=await f.sdk.createAgentSessionRuntime(factory,{cwd:f.cwd,agentDir:path.join(f.cwd,'probe-agent'),sessionManager:f.sdk.SessionManager.create(f.cwd,sessionsDir)});
  t.after(()=>runtime.dispose());
  const bind=async session=>session.bindExtensions({mode:'json',commandContextActions:{waitForIdle:()=>session.waitForIdle(),
    switchSession:(file,options)=>runtime.switchSession(file,options),newSession:options=>runtime.newSession(options),fork:(id,options)=>runtime.fork(id,options),
    navigateTree:async()=>{throw new Error('Not part of probe');},reload:async()=>{throw new Error('Not part of probe');}}});
  runtime.setRebindSession(bind);await bind(runtime.session);
  const source=runtime.session;await source.prompt('PRIVATE_PARENT_HISTORY');await source.prompt('PROBE_TOOL_CONTEXT');
  assert.deepEqual(toolContext,{newSession:'undefined',switchSession:'undefined'});
  const destination=await factory({cwd:f.cwd,sessionManager:f.sdk.SessionManager.create(f.cwd,sessionsDir)});
  await destination.session.prompt('Read-only readiness primitive probe. Report only; no authority to execute.');await destination.session.waitForIdle();
  const destinationId=destination.session.sessionId,destinationFile=destination.session.sessionFile;
  assert.notEqual(destinationId,source.sessionId);assert.ok(fs.existsSync(destinationFile));destination.session.dispose();
  await source.prompt(`/probe-navigation ${destinationFile}`);
  assert.equal(runtime.session.sessionId,destinationId);assert.equal(freshContext.sessionManager.getSessionId(),destinationId);
  assert.equal(typeof commandContext.switchSession,'function');assert.throws(()=>oldPi.getActiveTools(),/stale|disposed|invalid/i);
  assert.doesNotMatch(JSON.stringify(runtime.session.messages),/PRIVATE_PARENT_HISTORY/);
  assert.ok(runtime.session.messages.some(m=>m.role==='user'&&JSON.stringify(m).includes('Fresh destination navigation probe')));
  assert.equal(runtime.session.sessionManager.getHeader().parentSession,undefined);
  assert.deepEqual(canonicalBytes(f),canonicalBefore,'navigation did not fabricate Hyperion ownership transfer');f.passed();
});

for(const nativeFault of ['none','missing-readiness','switch-veto','lost-continuation','source-shutdown','source-switch','scope-pause','unknown-hold'])test(`handover native: shipped workflow ${nativeFault}`,{timeout:30000},async t=>{
 const {execFileSync}=require('node:child_process');let pp,expected,runtime,readinessStarts=0,injected=false,switches=0;const problems=[];
 let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
 const lifecycle=['source-shutdown','source-switch','scope-pause'].includes(nativeFault);
 const f=await fixture(t,async(context,{signal})=>{
  const user=[...context.messages].reverse().find(m=>m.role==='user');const text=typeof user?.content==='string'?user.content:(user?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  const last=context.messages.at(-1);
  if(text.startsWith('READINESS_BINDING')){
   if(last.role==='user')readinessStarts++;
   if(lifecycle){enteredResolve();await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});return{text:'Cancelled readiness.'};}
   if(['missing-readiness','unknown-hold'].includes(nativeFault)&&readinessStarts===1)return{text:'Readiness response lost; no report.'};
   const data=JSON.parse(text.slice(text.indexOf('\n')+1));expected={...Object.fromEntries(['plan_path','cwd','request_id','destination_id','plan_digest','code_digest','brief_digest'].map(k=>[k,data[k]])),ready:true,evidence:['Read native fixture requirements.']};
   if(last.role==='toolResult')return last.toolName==='read'?{tool:{name:'report_handover',arguments:expected}}:{text:'Readiness complete; stopping.'};
   return{tool:{name:'read',arguments:{path:pp}}};
  }
  if(last.role==='toolResult')return{text:'Native fixture work finished.'};
  if(text.includes('HYPERION_CONTINUATION')||text==='CONTINUE_SELECTED_AFTER')return{tool:{name:'native_after',arguments:{}}};
  if(['START_NATIVE_HANDOVER','RESUME_NATIVE_HANDOVER'].includes(text))return{tool:{name:'hyperion_handover',arguments:{operation:text.startsWith('RESUME')?'resume':'run',plan_path:pp,request_id:'native-run',step_id:'gate',current_request_authorized:true,handover_sessions_authorized:true,source_writers_drained:true,source_quiescence_evidence:['Only this idle fixture coordinator and managed readiness session exist.'],files:['code.txt'],summary:'Prior fixture work is complete.',next_action:'Checkpoint and verify after; leave unselected untouched.'}}};
  return{text:'PRIVATE_SOURCE_HISTORY'};
 });
 pp=path.join(f.cwd,'native-plan.md');fs.writeFileSync(path.join(f.cwd,'code.txt'),'native code input');
 execFileSync('git',['init','-q',f.cwd]);execFileSync('git',['-C',f.cwd,'add','code.txt']);execFileSync('git',['-C',f.cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 let p=core.initialize({title:'Native handover',steps:[{id:'pre',title:'Prior',status:'completed'},{id:'gate',title:'Transfer',kind:'handover'},{id:'after',title:'Continue'},{id:'unselected',title:'Untouched'}]});
 p=core.applyRequest(p,{plan_id:p.plan_id,base_revision:p.revision,request_id:'native-run',intent:'implement',operations:[],selected_step_ids:['after']})[0];core.saveMarkdown(pp,p);
 const plugin=(await import(url('dist/hyperion-plan-pi.js'))).default;
 const factory=async({cwd,sessionManager,sessionStartEvent})=>{
  const services=await f.sdk.createAgentSessionServices({cwd,agentDir:path.join(f.cwd,'native-agent'),modelRuntime:f.options.modelRuntime,settingsManager:f.sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}}),
   resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[plugin,pi=>{
    pi.registerTool({name:'native_after',label:'Complete fixture',description:'Checkpoint selected fixture only',parameters:{type:'object',properties:{}},async execute(_id,_p,_s,_u,ctx){
     const actor=ctx.sessionManager.getSessionId();await core.mutatePlan(pp,actor,p=>core.checkpoint(p,p.revision,'after','in_progress','Native destination starts'));
     fs.writeFileSync(path.join(f.cwd,'native-complete.txt'),actor);await core.mutatePlan(pp,actor,p=>core.checkpoint(p,p.revision,'after','completed','Native destination marker verified'));
     return{content:[{type:'text',text:'native complete'}],details:undefined};}});
   }]}});
  return{...await f.sdk.createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model:f.options.model,thinkingLevel:'off',tools:['hyperion_handover','native_after']}),services,diagnostics:services.diagnostics};
 };
 runtime=await f.sdk.createAgentSessionRuntime(factory,{cwd:f.cwd,agentDir:path.join(f.cwd,'native-agent'),sessionManager:f.sdk.SessionManager.create(f.cwd,path.join(f.cwd,'native-sessions'))});t.after(()=>runtime.dispose());
 const bind=async session=>session.bindExtensions({mode:'json',onError:e=>problems.push(e.message??JSON.stringify(e,(_key,value)=>value instanceof Error?{message:value.message}:value)),commandContextActions:{waitForIdle:()=>session.waitForIdle(),switchSession:(file,opts)=>{
  if(!injected&&nativeFault==='switch-veto'){injected=true;return Promise.resolve({cancelled:true});}
  if(!injected&&nativeFault==='lost-continuation'){injected=true;return runtime.switchSession(file,{...opts,withSession:fresh=>opts.withSession({...fresh,sendUserMessage:async()=>{throw Error('Lost continuation delivery fixture');}})});}
  return runtime.switchSession(file,opts).then(value=>{if(!value.cancelled)switches++;return value;});
 },newSession:opts=>runtime.newSession(opts),fork:(id,opts)=>runtime.fork(id,opts),navigateTree:async()=>{throw Error('unused');},reload:async()=>{throw Error('unused');}}});runtime.setRebindSession(bind);await bind(runtime.session);
 const source=runtime.session;await source.prompt('PRIVATE_SOURCE_HISTORY');const launching=source.prompt('START_NATIVE_HANDOVER');
 if(lifecycle){
  await entered;
  if(nativeFault==='source-shutdown')await runtime.dispose();
  else if(nativeFault==='source-switch')await runtime.newSession();
  else await core.mutatePlan(pp,source.sessionId,p=>core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused'));
  await launching;
  const end=Date.now()+5000;let saved;
  while(Date.now()<end){const p=(await core.loadPlanSnapshot(pp)).plan;const file=path.join(f.cwd,'.hyperion-dispatch','native-plan.md','handovers',core.digestText(p.handovers[0].request_id),'runtime.json');if(fs.existsSync(file)){saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.phase==='failed')break;}await new Promise(r=>setTimeout(r,20));}
  const p=(await core.loadPlanSnapshot(pp)).plan;assert.equal(p.execution_owner,source.sessionId);assert.equal(p.steps[1].status,'in_progress');assert.equal(p.steps[2].status,'pending');assert.equal(saved?.phase,'failed');assert.equal(saved.quiescence.state,'verified');
  if(nativeFault==='scope-pause')assert.equal(p.execution.state,'paused');if(nativeFault==='source-switch')assert.notEqual(runtime.session.sessionId,source.sessionId);
  assert.equal(fs.existsSync(path.join(f.cwd,'native-complete.txt')),false);f.passed();return;
 }
 await launching;
 if(nativeFault!=='none'){
  const deadline=Date.now()+8000;while(!problems.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.ok(problems.length,'fault must surface, not silently retry');assert.equal(fs.existsSync(path.join(f.cwd,'native-complete.txt')),false);problems.length=0;
  const before=(await core.loadPlanSnapshot(pp)).plan,destination=before.handovers[0].destination_task_id;
  if(nativeFault==='unknown-hold'){
   const file=path.join(f.cwd,'.hyperion-dispatch','native-plan.md','handovers',core.digestText(before.handovers[0].request_id),'runtime.json');const saved=JSON.parse(fs.readFileSync(file,'utf8'));
   saved.phase='uncertain';saved.quiescence={state:'unknown',reason:'Injected durable uncertainty, not an actually surviving fixture writer'};fs.writeFileSync(file,JSON.stringify(saved));
   await runtime.session.prompt('RESUME_NATIVE_HANDOVER');const end=Date.now()+5000;while(!problems.length&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.match(problems.join('\n'),/unknown writers|Settled same-destination/);assert.equal(readinessStarts,1);assert.equal((await core.loadPlanSnapshot(pp)).plan.execution_owner,source.sessionId);f.passed();return;
  }
  if(nativeFault==='missing-readiness'){
   fs.writeFileSync(path.join(f.cwd,'code.txt'),'explicitly changed code');
   await core.mutatePlan(pp,source.sessionId,p=>{p.title='Explicitly changed fixture context';p.revision++;return[p,true];});
  }else if(nativeFault==='switch-veto')await runtime.session.prompt('/hyperion-handover-open',{expandPromptTemplates:true});
  await runtime.session.prompt('RESUME_NATIVE_HANDOVER');
  if(nativeFault==='lost-continuation'){
   const deadline=Date.now()+5000;while(!switches&&!problems.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(switches);assert.equal(fs.existsSync(path.join(f.cwd,'native-complete.txt')),false,'consumed claim is not automatically replayed');
   // Explicit new user instruction after inspecting the consumed/lost claim.
   await runtime.session.prompt('CONTINUE_SELECTED_AFTER');
  }
  assert.equal((await core.loadPlanSnapshot(pp)).plan.handovers[0].destination_task_id,destination,'recovery must retain the original native identity');
 }
 // The marker is written BEFORE the completion checkpoint. Observe canonical
 // completion and SDK settlement instead of racing the final tool's lock/save.
 const end=Date.now()+10000;
 while(!problems.length&&Date.now()<end){
  const current=(await core.loadPlanSnapshot(pp)).plan;
  if(current.steps[2].status==='completed'&&fs.existsSync(path.join(f.cwd,'native-complete.txt')))break;
  await new Promise(r=>setTimeout(r,20));
 }
 await runtime.session.waitForIdle();
 const latest=(await core.loadPlanSnapshot(pp)).plan;
 fs.writeFileSync(path.join(f.cwd,'native-result.json'),JSON.stringify({problems,source_id:source.sessionId,destination_id:runtime.session.sessionId,plan:latest,messages:runtime.session.messages},null,2));
 assert.deepEqual(problems,[]);assert.equal(latest.steps[2].status,'completed',JSON.stringify(runtime.session.messages).slice(-6000));assert.equal(latest.steps[3].status,'pending');
 assert.notEqual(source.sessionId,runtime.session.sessionId);assert.equal(latest.execution_owner,runtime.session.sessionId);assert.doesNotMatch(JSON.stringify(runtime.session.messages),/PRIVATE_SOURCE_HISTORY/);f.passed();
});

// Actual SDK protocol fixtures; all work stays in this fixture's temporary tree.
// Readiness construction is a test harness, not a production launcher.
async function handoverProtocolFixture(t, fault='none') {
  const navigation=await import(url('dist/pi-handover-navigation.js'));
  let expected, reported, destination, source, runtime, sourcePi, readySettled=false, currentAuthority=true;
  const errors=[],events=[],continuations=[];let cancelSwitch=fault==='switch-cancelled',readinessFailed=false,activeReadinessRunner;
  const f=await fixture(t,(context,{signal})=>{
    const last=context.messages.at(-1), user=[...context.messages].reverse().find(m=>m.role==='user'), text=JSON.stringify(user);
    if(last.role==='toolResult') {
      if(last.toolName==='read')return{tool:{name:'report_handover',arguments:['wrong-readiness','production-wrong'].includes(fault)?{...expected,destination_id:'wrong'}:expected}};
      return{text:'Observed fixture result. No further work.'};
    }
    if(text.includes('SCHEDULE_HANDOVER'))return{tool:{name:'fixture_schedule',arguments:{}}};
    if(text.includes('READINESS_BINDING')){
      const content=typeof user.content==='string'?user.content:user.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      const binding=JSON.parse(content.slice(content.indexOf('\n')+1));
      expected={...Object.fromEntries(['plan_path','cwd','request_id','destination_id','plan_digest','code_digest','brief_digest'].map(k=>[k,binding[k]])),ready:true,evidence:['Read the canonical fixture and compared readiness binding.']};
      if(fault==='production-error')return{error:'Scripted readiness failure'};
      if(fault==='production-missing')return{text:'No readiness report supplied'};
      if(fault==='production-revoked')currentAuthority=false;
      if(['production-timeout','production-stop'].includes(fault)){
        if(fault==='production-stop')setTimeout(()=>void activeReadinessRunner.stop(),5);
        return new Promise(resolve=>{const done=()=>resolve({text:'Stopped without readiness'});if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});});
      }
      return{tool:{name:'read',arguments:{path:fault==='production-readescape'?path.join(f.cwd,'forbidden.txt'):expected.plan_path}}};
    }
    if(text.includes('HYPERION_CONTINUATION')||text.includes('ATTEMPT_SOURCE_WRITE'))return{tool:{name:'fixture_write',arguments:{}}};
    return{text:'Source history only.'};
  });
  const planPath=path.join(f.cwd,'transfer-plan.md'),brief=path.join(f.cwd,'handover.md'),input=path.join(f.cwd,'input.txt'),output=path.join(f.cwd,'continued.txt');
  fs.writeFileSync(brief,'Concise fixture brief; no parent conversation.');fs.writeFileSync(input,'Relevant fixture code v1');
  const sessions=path.join(f.cwd,'handover-sessions');let planId;
  const contextFor=ctx=>({planPath,planId,requestId:'handover',cwd:f.cwd,
    authority:()=>({currentRunAuthorized:currentAuthority,implementationAllowed:true,actorId:ctx.sessionManager.getSessionId(),requestId:'handover-run'}),
    observe:()=>({code_digest:core.digestText(fs.readFileSync(input,'utf8')),
      source_quiescence:source?.isIdle&&(!destination||destination.isIdle)?{state:'verified',evidence:['Observed source and readiness SDK objects idle; no other fixture children.']}:{state:'unknown',reason:'SDK still active'}})});
  const journalFor=ctx=>new navigation.PiHandoverJournal(contextFor(ctx));
  let navigationResult;
  const factory=async({cwd,sessionManager,sessionStartEvent},readiness=false)=>{
    const services=await f.sdk.createAgentSessionServices({cwd,agentDir:path.join(f.cwd,'handover-agent'),modelRuntime:f.options.modelRuntime,
      settingsManager:f.sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}}),
      resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{
        pi.on('session_shutdown',async(_e,ctx)=>{events.push({type:'shutdown',id:ctx.sessionManager.getSessionId()});});
        if(readiness){
          pi.registerTool({name:'read',label:'Read fixture input',description:'Read only captured handover fixture paths',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},
            async execute(_id,p){assert.ok([planPath,brief,input].includes(p.path));return{content:[{type:'text',text:fs.readFileSync(p.path,'utf8')}],details:undefined};}});
          pi.registerTool({name:'report_handover',label:'Readiness',description:'Report readiness only',parameters:{type:'object',properties:Object.fromEntries(['plan_path','cwd','request_id','destination_id','plan_digest','code_digest','brief_digest'].map(k=>[k,{type:'string'}]).concat([['ready',{type:'boolean'}],['evidence',{type:'array',items:{type:'string'}}]]))},
            async execute(_id,p,_signal,_update,ctx){assert.equal(ctx.sessionManager.getSessionId(),expected.destination_id);reported=structuredClone(p);return{content:[{type:'text',text:'Readiness received, not execution authority.'}],details:undefined};}});
        }else{
          navigation.registerPiHandoverOwnerFence(pi);
          pi.registerTool({name:'fixture_schedule',label:'Schedule fixture command',description:'Invoke command after this tool terminates the source turn',parameters:{type:'object',properties:{}},
            async execute(){pi.sendUserMessage('/fixture-handover',{expandPromptTemplates:true,deliverAs:'followUp'});return{content:[{type:'text',text:'Handover command pending source settlement'}],details:undefined,terminate:true};}});
          pi.registerTool({name:'fixture_write',label:'Fixture write',description:'Write the isolated continuation marker',parameters:{type:'object',properties:{}},
            async execute(_id,_p,_s,_u,ctx){const p=(await core.loadPlanSnapshot(planPath)).plan;assert.equal(p.execution_owner,ctx.sessionManager.getSessionId());assert.equal(p.execution.state,'approved');
              const actor=ctx.sessionManager.getSessionId();await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,'after','in_progress','Destination starts selected fixture work'));
              continuations.push(actor);fs.writeFileSync(output,'continued');
              await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,'after','completed','Verified isolated continuation marker'));
              return{content:[{type:'text',text:'Fixture marker written'}],details:undefined};}});
          pi.registerCommand('fixture-handover',{description:'Authorized isolated handover fixture',handler:async(_args,ctx)=>{
            try{pi.appendEntry('hyperion.handover-source',{plan_path:planPath,plan_id:planId});navigationResult=await navigation.navigatePiHandover(ctx,journalFor);}catch(error){errors.push(error.message);}
          }});
          pi.registerCommand('fixture-prepare',{description:'Capture command context without navigation',handler:async(_args,ctx)=>{sourcePi=pi;f.commandContext=ctx;}});
        }
      }]}});
    const result={...await f.sdk.createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model:f.options.model,thinkingLevel:'off',tools:readiness?['read','report_handover']:['fixture_write','fixture_schedule']}),services,diagnostics:services.diagnostics};
    result.session.subscribe(e=>{if(['agent_start','agent_settled'].includes(e.type))events.push({type:e.type,id:result.session.sessionId});if(readiness&&e.type==='agent_settled')readySettled=true;});
    return result;
  };
  runtime=await f.sdk.createAgentSessionRuntime(factory,{cwd:f.cwd,agentDir:path.join(f.cwd,'handover-agent'),sessionManager:f.sdk.SessionManager.create(f.cwd,sessions)});
  t.after(async()=>{destination?.dispose();await runtime.dispose();});
  const bind=async session=>session.bindExtensions({mode:'json',commandContextActions:{waitForIdle:()=>session.waitForIdle(),switchSession:(file,options)=>{
    if(cancelSwitch){cancelSwitch=false;return Promise.resolve({cancelled:true});}
    return runtime.switchSession(file,options);
  },newSession:()=>{throw new Error('No replacement allocation allowed');},fork:()=>{throw new Error('No history fork allowed');},navigateTree:async()=>{throw new Error('Not used');},reload:async()=>{throw new Error('Not used');}}});
  runtime.setRebindSession(bind);await bind(runtime.session);source=runtime.session;
  await source.prompt('PRIVATE_PARENT_HISTORY');await source.prompt('/fixture-prepare');
  let p=core.initialize({title:'Actual SDK handover fixture',steps:[{id:'before',title:'Prior work',status:'completed'},{id:'gate',title:'Handover',kind:'handover'},{id:'after',title:'Continue selected scope'},{id:'unselected',title:'Do not run'}]});
  planId=p.plan_id;p=core.applyRequest(p,{plan_id:planId,base_revision:p.revision,request_id:'handover-run',intent:'implement',operations:[],selected_step_ids:['after']})[0];
  p=core.applyRequest(p,{plan_id:planId,base_revision:p.revision,request_id:'handover',intent:'handover',operations:[],target_step_ids:['gate']})[0];
  p=core.updateHandover(p,p.revision,{request_id:'handover',state:'prepared',brief_path:brief,summary:'Prior fixture work',next_action:'Continue approved fixture only',code_state:'input.txt digest'},source.sessionId)[0];core.saveMarkdown(planPath,p);
  const journal=journalFor(f.commandContext);let identity;
  if(fault.startsWith('production')){
    fs.mkdirSync(path.join(f.cwd,'.pi/extensions'),{recursive:true});fs.writeFileSync(path.join(f.cwd,'.pi/extensions/poison.ts'),'throw new Error("AMBIENT_POISON")');fs.writeFileSync(path.join(f.cwd,'AGENTS.md'),'AMBIENT_SECRET');
    const {PiHandoverReadinessRunner}=await import(url('dist/pi-handover-readiness.js'));
    const readinessRunner=new PiHandoverReadinessRunner();activeReadinessRunner=readinessRunner;
    const config={context:contextFor(f.commandContext),sessionsAuthorized:()=>fault!=='production-denied',modelRuntime:f.options.modelRuntime,model:f.options.model,thinkingLevel:'off',readPaths:[input],timeoutMs:fault==='production-timeout'?60:5000,quiescenceTimeoutMs:1000};
    try{
      const record=await readinessRunner.run(config);identity=record.destination;
      const requests=f.requests.length;assert.deepEqual(await readinessRunner.run(config),record);assert.equal(f.requests.length,requests,'ready retry cannot call the provider again');
    }catch(error){readinessFailed=true;errors.push(error.message);identity=journal.inspect()?.destination;}
    assert.equal((await readinessRunner.stop()).state,'verified');assert.equal((await core.loadPlanSnapshot(planPath)).plan.execution_owner,source.sessionId);
    assert.doesNotMatch(JSON.stringify(f.requests),/AMBIENT_SECRET|AMBIENT_POISON/);
  }else{
  const reservation=await journal.reserve();assert.equal(reservation.created,true);
  const manager=f.sdk.SessionManager.create(f.cwd,sessions);identity={native_id:manager.getSessionId(),transcript_path:manager.getSessionFile()};
  await journal.identify(identity);assert.equal(fs.existsSync(identity.transcript_path),false,'native identity persists before first transcript flush');
  p=(await core.loadPlanSnapshot(planPath)).plan;p=core.updateHandover(p,p.revision,{request_id:'handover',state:'prepared',destination_task_id:identity.native_id},source.sessionId)[0];core.saveMarkdown(planPath,p);
  const r=journal.inspect();manager.appendCustomEntry('hyperion.handover',{plan_path:planPath,plan_id:planId,request_id:r.request_id,source_id:r.source_id,plan_digest:r.plan_digest,code_digest:r.code_digest,brief_digest:r.brief_digest});
  expected={plan_path:planPath,cwd:f.cwd,request_id:r.request_id,destination_id:identity.native_id,plan_digest:r.plan_digest,code_digest:r.code_digest,brief_digest:r.brief_digest,ready:true,evidence:['Read the isolated canonical fixture and compared supplied digests.']};
  destination=(await factory({cwd:f.cwd,sessionManager:manager},true)).session;
  await destination.prompt('READINESS_BINDING\n'+JSON.stringify(expected),{expandPromptTemplates:false});await destination.waitForIdle();
  assert.ok(readySettled&&destination.isIdle);assert.deepEqual(destination.getActiveToolNames().sort(),['read','report_handover']);
  assert.doesNotMatch(JSON.stringify(destination.messages),/PRIVATE_PARENT_HISTORY/);assert.equal(destination.sessionManager.getHeader().parentSession,undefined);
  assert.equal((await core.loadPlanSnapshot(planPath)).plan.execution_owner,source.sessionId,'readiness cannot transfer ownership');
  if(fault==='wrong-readiness'){
    await assert.rejects(journal.ready(reported,{state:'verified',evidence:['Actual SDK agent_settled and waitForIdle']}),/Readiness/);
  }else await journal.ready(reported,{state:'verified',evidence:['Actual read-only SDK agent_settled, waitForIdle and restricted tool list observed']});
  destination.dispose();
  }
  if(fault==='code-drift')fs.writeFileSync(input,'Changed fixture code');
  if(fault==='revoked')currentAuthority=false;
  if(fault==='paused'){
    p=(await core.loadPlanSnapshot(planPath)).plan;core.saveMarkdown(planPath,core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused')[0]);
  }
  if(fault==='queued-command'){
    await source.prompt('SCHEDULE_HANDOVER');
    const until=Date.now()+3000;while(!navigationResult&&!errors.length&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
    assert.ok(navigationResult||errors.length,'queued command did not complete');
  }else if(!readinessFailed)await source.prompt('/fixture-handover');
  const final=(await core.loadPlanSnapshot(planPath)).plan;
  fs.writeFileSync(path.join(f.cwd,'handover-events.json'),JSON.stringify({events,errors,identity,source_id:source.sessionId,result:navigationResult,continuations},null,2));
  return{...f,source,runtime,journal,identity,planPath,final,output,events,errors,continuations,sourcePi,navigationResult,
    passed:()=>{fs.writeFileSync(path.join(f.cwd,'handover-events.json'),JSON.stringify({events,errors,identity,source_id:source.sessionId,result:navigationResult,continuations},null,2));f.passed();}};
}

test('handover protocol: real SDK readiness, transfer, navigation and continuation retain one destination and fence restored source', {timeout:30000},async t=>{
 const f=await handoverProtocolFixture(t);assert.deepEqual(f.errors,[]);assert.equal(f.navigationResult.continuation,'sent');assert.equal(f.runtime.session.sessionId,f.identity.native_id);
 assert.equal(f.final.execution_owner,f.identity.native_id);assert.equal(f.final.steps[1].status,'completed');assert.equal(f.final.steps[3].status,'pending');
 assert.deepEqual(f.continuations,[f.identity.native_id]);assert.equal(fs.readFileSync(f.output,'utf8'),'continued');assert.equal(f.journal.inspect().phase,'claimed');
 assert.ok(f.events.some(e=>e.type==='shutdown'&&e.id===f.source.sessionId));assert.throws(()=>f.sourcePi.getActiveTools(),/stale|disposed|invalid/i);
 assert.doesNotMatch(JSON.stringify(f.runtime.session.messages),/PRIVATE_PARENT_HISTORY/);
 await f.runtime.switchSession(f.source.sessionFile);await f.runtime.session.prompt('ATTEMPT_SOURCE_WRITE');
 assert.deepEqual(f.continuations,[f.identity.native_id],'restored source cannot write');assert.ok(f.runtime.session.messages.some(m=>m.role==='toolResult'&&m.isError&&JSON.stringify(m).includes('does not own')));
 f.passed();
});
for(const fault of ['wrong-readiness','code-drift','revoked','paused'])test(`handover protocol: ${fault} cannot transfer or start destination work`,{timeout:30000},async t=>{
 const f=await handoverProtocolFixture(t,fault);assert.ok(f.errors.length);assert.equal(f.final.execution_owner,f.source.sessionId);assert.equal(f.final.steps[1].status,'in_progress');
 assert.equal(f.runtime.session.sessionId,f.source.sessionId);assert.deepEqual(f.continuations,[]);assert.equal(fs.existsSync(f.output),false);f.passed();
});
test('handover protocol: cancelled navigation retains transferred identity without continuation or duplicate creation',{timeout:30000},async t=>{
 const f=await handoverProtocolFixture(t,'switch-cancelled');assert.match(f.errors[0],/cancelled/);assert.equal(f.final.execution_owner,f.identity.native_id);assert.equal(f.journal.inspect().phase,'transferred');
 assert.equal(f.runtime.session.sessionId,f.source.sessionId);assert.deepEqual(f.continuations,[]);assert.ok(fs.existsSync(f.identity.transcript_path));
 await f.runtime.session.prompt('ATTEMPT_SOURCE_WRITE');assert.deepEqual(f.continuations,[]);
 await f.runtime.session.prompt('/fixture-handover');assert.equal(f.runtime.session.sessionId,f.identity.native_id);assert.deepEqual(f.continuations,[f.identity.native_id]);
 assert.equal(fs.readdirSync(path.dirname(f.identity.transcript_path)).filter(p=>p.endsWith('.jsonl')).length,2,'retry restores, never creates another destination');f.passed();
});
test('handover protocol: public tool-to-command routing waits for source settlement before replacement',{timeout:15000},async t=>{
 const f=await handoverProtocolFixture(t,'queued-command');assert.deepEqual(f.errors,[]);assert.equal(f.navigationResult.continuation,'sent');
 assert.equal(f.runtime.session.sessionId,f.identity.native_id);assert.deepEqual(f.continuations,[f.identity.native_id]);f.passed();
});
for(const fault of ['production-wrong','production-error','production-missing','production-readescape','production-revoked','production-timeout','production-stop','production-denied'])test(`handover protocol: readiness runner ${fault} never transfers ownership`,{timeout:15000},async t=>{
 const f=await handoverProtocolFixture(t,fault);assert.ok(f.errors.length);assert.equal(f.final.execution_owner,f.source.sessionId);assert.deepEqual(f.continuations,[]);assert.equal(fs.existsSync(f.output),false);
 if(fault==='production-denied')assert.equal(f.journal.inspect(),undefined);else assert.equal(f.journal.inspect().phase,'identified');f.passed();
});
test('handover protocol: production read-only SDK readiness runner persists identity, curates context and feeds command navigation',{timeout:15000},async t=>{
 const f=await handoverProtocolFixture(t,'production');assert.deepEqual(f.errors,[]);assert.equal(f.navigationResult.continuation,'sent');
 assert.equal(f.runtime.session.sessionId,f.identity.native_id);assert.deepEqual(f.continuations,[f.identity.native_id]);
 const entries=fs.readFileSync(f.identity.transcript_path,'utf8').trim().split('\n').map(JSON.parse);assert.equal(entries[0].parentSession,undefined);
 assert.ok(entries.some(e=>e.customType==='hyperion-plan.binding'));assert.doesNotMatch(JSON.stringify(entries),/PRIVATE_PARENT_HISTORY|AMBIENT_SECRET/);f.passed();
});

const checkedReview = { acceptance_met: true, integration_checked: true, evidence: ['Fixture coordinator inspected current report, source and settlement'] };
for (const route of ['service', 'CLI']) for (const fault of ['actor', 'missing-actor', 'request', 'unverified', 'failed', 'uncertain', 'not-verified', 'missing-report', 'omitted-suite', 'unavailable-suite', 'failed-suite', 'source', 'scope', 'focus', 'manifest', 'report', 'transcript', 'events', 'test-artifacts', 'newer-attempt', 'task', 'report-path', 'unreconciled-findings']) {
  test(`plan-review completion boundary rejects ${fault} via ${route}`, async t => {
    const runTest = ['unavailable-suite', 'failed-suite', 'test-artifacts'].includes(fault);
    let turn = 0;
    const f = await reviewFixture(t, 'plan-review', context => {
      if (runTest && ++turn === 1) return { tool: { name: 'test_review', arguments: { id: 'check' } } };
      if (context.messages.some(m => m.role === 'toolResult' && m.toolName === 'report_review')) return { text: 'Review delivered; coordinator must reconcile it.' };
      return reportAnswer(context, fault === 'not-verified' ? 'not-verified' : fault === 'unreconciled-findings' ? 'finding' : 'passed');
    });
    if (runTest || fault === 'omitted-suite') {
      f.reviewOptions.requiredTestIds = ['check'];
      f.reviewOptions.reviewTests = { check: { description: 'Synchronous controlled evidence fixture', async run(cwd) {
        fs.writeFileSync(path.join(cwd, 'test.txt'), 'observed');
        return { status: fault === 'unavailable-suite' ? 'not-verified' : fault === 'failed-suite' ? 'finding' : 'passed',
          evidence: 'Observed fixture test result', quiescence: { state: 'verified', evidence: ['Synchronous fixture operations finished; no pending writers'] } };
      } } };
    }
    const r = await f.runner.runPiReview(f.reviewOptions); assert.equal(r.phase, 'settled', JSON.stringify(r));
    const invalidEvidence = ['not-verified', 'omitted-suite', 'unavailable-suite', 'failed-suite', 'unreconciled-findings'].includes(fault);
    if (fault !== 'unverified' && !invalidEvidence) await f.runner.verifyDispatch(f.planPath, r.assignment.assignment_id, f.options.authority, checkedReview);
    const ledgerPath = path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json'), ledger = f.runner.readDispatchLedger(f.planPath), record = ledger.records.at(-1);
    // A stale/forged saved flag cannot replace rechecking real report/test evidence.
    if (invalidEvidence) record.verification = structuredClone(checkedReview);
    if (fault === 'failed') { record.phase = 'failed'; record.result.outcome = 'failed'; }
    if (fault === 'uncertain') { record.phase = 'uncertain'; delete record.result; }
    if (fault === 'missing-report') delete record.review_report;
    if (fault === 'newer-attempt') { const newer = structuredClone(record); newer.assignment.assignment_id += '-new'; newer.attempt_id += '-new'; newer.phase = 'accepted'; delete newer.verification; ledger.records.push(newer); }
    if (invalidEvidence || ['failed', 'uncertain', 'missing-report', 'newer-attempt'].includes(fault)) core.atomicWrite(ledgerPath, ledger);
    let p = (await core.loadPlanSnapshot(f.planPath)).plan, requestId = 'review-run';
    if (fault === 'request') {
      p = core.updatePlanReview(p, p.revision, { request_id: 'review-run', state: 'blocked', note: 'Original report held for reconciliation' })[0];
      requestId = 'later-plan-review';
      p = core.applyRequest(p, { plan_id: p.plan_id, base_revision: p.revision, request_id: requestId, intent: 'review', review_mode: 'independent',
        target_step_ids: ['one'], operations: [] })[0];
    }
    if (fault === 'scope') p.steps[0].done_when = 'New requirement not inspected by this reviewer';
    if (fault === 'focus') p.plan_reviews[0].focus = 'New unreviewed focus';
    if (['request', 'scope', 'focus'].includes(fault)) core.saveMarkdown(f.planPath, p);
    if (fault === 'source') fs.writeFileSync(path.join(f.cwd, 'code.txt'), 'changed after verification');
    if (fault === 'manifest') fs.writeFileSync(path.join(r.review.snapshot.root, 'manifest.json'), '{}');
    if (fault === 'report') { const saved = JSON.parse(fs.readFileSync(r.result_path)); saved.review_report.checks[0].evidence = 'changed'; core.atomicWrite(r.result_path, saved); }
    if (fault === 'transcript') { const entries = fs.readFileSync(r.handle.transcript_path, 'utf8').trim().split('\n').map(JSON.parse); entries[0].id = 'other'; fs.writeFileSync(r.handle.transcript_path, entries.map(JSON.stringify).join('\n')); }
    if (fault === 'events') fs.writeFileSync(r.events_path, '');
    if (fault === 'test-artifacts') { fs.writeFileSync(path.join(r.controlled_tests.check.artifact_root, 'test.txt'), 'changed'); t.after(() => fs.rmSync(r.controlled_tests.check.artifact_root, { recursive: true, force: true })); }
    else if (runTest) t.after(() => fs.rmSync(r.controlled_tests.check.artifact_root, { recursive: true, force: true }));
    const update = { request_id: requestId, state: 'completed', task_id: fault === 'task' ? 'another-reviewer' : r.handle.session.native_id,
      report_path: fault === 'report-path' ? path.join(f.cwd, 'unrelated-report.json') : r.result_path, note: 'Reconciled captured review, not approval of the plan', findings: [] };
    const input = path.join(f.cwd, 'completion-update.json'); fs.writeFileSync(input, JSON.stringify(update));
    const actor = fault === 'actor' ? 'other-coordinator' : fault === 'missing-actor' ? undefined : 'coordinator';
    const before = canonicalBytes(f), ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');
    if (route === 'service') await assert.rejects(core.mutatePlan(f.planPath, actor, plan => core.updatePlanReview(plan, plan.revision, update)),
      /assigning coordinator|identity|request|verification|unresolved|settled|missing|suites|changed|drifted|correlation|findings|evidence/i);
    else {
      const result = completionCLI(f, actor, 'plan-review', ['--base-revision', String(p.revision), '--input', input]);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /assigning coordinator|identity|request|verification|unresolved|settled|missing|suites|changed|drifted|correlation|findings|evidence/i);
    }
    assert.deepEqual(canonicalBytes(f), before); assert.equal(fs.readFileSync(ledgerPath, 'utf8'), ledgerBefore);
    assert.equal(f.requests.length, runTest ? 3 : 2); f.passed();
  });
}
for (const route of ['service', 'CLI']) for (const outcome of ['passed', 'finding']) {
  test(`plan-review completion boundary accepts reconciled ${outcome} evidence via ${route} without approving implementation`, async t => {
    const f = await reviewFixture(t, 'plan-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'Report delivered.' } : reportAnswer(context, outcome));
    const r = await f.runner.runPiReview(f.reviewOptions);
    await f.runner.verifyDispatch(f.planPath, r.assignment.assignment_id, f.options.authority, checkedReview);
    const p = (await core.loadPlanSnapshot(f.planPath)).plan;
    p.execution.state = 'paused'; core.saveMarkdown(f.planPath, p);
    const update = { request_id: 'review-run', state: 'completed', task_id: r.handle.session.native_id, report_path: r.result_path,
      note: 'Report reconciled; completion is not plan approval.', findings: outcome === 'finding'
        ? [{ step_ids: ['one'], text: 'Captured checks identified a supported concern', resolution: 'needs_input', reason: 'The unresolved decision is preserved for the user' }] : [] };
    const input = path.join(f.cwd, 'completion-update.json'); fs.writeFileSync(input, JSON.stringify(update));
    if (route === 'service') await core.mutatePlan(f.planPath, 'coordinator', plan => core.updatePlanReview(plan, plan.revision, update));
    else { const result = completionCLI(f, 'coordinator', 'plan-review', ['--base-revision', String(p.revision), '--input', input]); assert.equal(result.status, 0, result.stdout + result.stderr); }
    const completed = (await core.loadPlanSnapshot(f.planPath)).plan;
    assert.equal(completed.plan_reviews[0].state, 'completed'); assert.deepEqual(completed.plan_reviews[0].findings, update.findings);
    assert.deepEqual(completed.steps, p.steps); assert.deepEqual(completed.execution, p.execution, 'review delivery must not resume or grant implementation');
    assert.equal(f.requests.length, 2); f.passed();
  });
}
for (const route of ['service', 'CLI']) test(`plan-review completion boundary preserves unmanaged external outcomes via ${route}`, async t => {
  const f = await reviewFixture(t, 'plan-review', () => { throw Error('No managed reviewer is authorized'); });
  const update = { request_id: 'review-run', state: 'completed', task_id: 'external-reviewer', report_path: path.join(f.cwd, 'external-report.md'), note: 'External review reconciled', findings: [] };
  const input = path.join(f.cwd, 'completion-update.json'); fs.writeFileSync(input, JSON.stringify(update));
  if (route === 'service') await core.mutatePlan(f.planPath, 'coordinator', p => core.updatePlanReview(p, p.revision, update));
  else { const result = completionCLI(f, 'coordinator', 'plan-review', ['--base-revision', String(f.plan.revision), '--input', input]); assert.equal(result.status, 0, result.stdout + result.stderr); }
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.plan_reviews[0].state, 'completed'); assert.equal(f.requests.length, 0); f.passed();
});
test('plan-review completion boundary rejects combined requirement edit and outcome', async t => {
  const f = await reviewFixture(t, 'plan-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const r = await f.runner.runPiReview(f.reviewOptions); await f.runner.verifyDispatch(f.planPath, r.assignment.assignment_id, f.options.authority, checkedReview);
  const before = canonicalBytes(f);
  await assert.rejects(core.mutatePlan(f.planPath, 'coordinator', p => {
    const next = core.updatePlanReview(p, p.revision, { request_id: 'review-run', state: 'completed', task_id: r.handle.session.native_id, report_path: r.result_path, note: 'Cannot cover new requirements' })[0];
    next.steps[0].done_when = 'New criterion in the completion write'; return [next, true];
  }), /scope changed|requirements changed/);
  assert.deepEqual(canonicalBytes(f), before); f.passed();
});
for (const fault of ['unverified', 'finding', 'not-verified', 'failed', 'request', 'owner', 'scope', 'effort', 'source', 'index', 'mode', 'manifest', 'report', 'transcript', 'events', 'test-artifacts', 'newer-attempt']) {
  test(`review completion boundary rejects ${fault} via service and CLI`, async t => {
    let turn = 0;
    const f = await reviewFixture(t, 'code-review', context => {
      if (fault === 'test-artifacts' && ++turn === 1) return { tool: { name: 'test_review', arguments: { id: 'check' } } };
      if (context.messages.some(m => m.role === 'toolResult' && m.toolName === 'report_review')) return { text: 'done' };
      return reportAnswer(context, ['finding', 'not-verified'].includes(fault) ? fault : 'passed');
    });
    if (fault === 'test-artifacts') f.reviewOptions.reviewTests = { check: { description: 'Bounded fixture', async run(cwd) {
      fs.writeFileSync(path.join(cwd, 'test.txt'), 'observed');
      return { status: 'passed', evidence: 'Synchronous fixture output', quiescence: { state: 'verified', evidence: ['No pending writers'] } };
    } } };
    const r = await f.runner.runPiReview(f.reviewOptions);
    if (!['unverified', 'finding', 'not-verified'].includes(fault)) await f.runner.verifyDispatch(f.planPath, r.assignment.assignment_id, f.options.authority, checkedReview);
    let p = (await core.loadPlanSnapshot(f.planPath)).plan;
    const ledgerPath = path.join(f.runner.dispatchDirectory(f.planPath), 'ledger.json');
    const ledger = f.runner.readDispatchLedger(f.planPath), record = ledger.records.at(-1);
    if (fault === 'failed') { record.phase = 'failed'; record.result.outcome = 'failed'; }
    if (fault === 'newer-attempt') { const newer = structuredClone(record); newer.assignment.assignment_id += '-new'; newer.attempt_id += '-new'; newer.phase = 'accepted'; delete newer.verification; ledger.records.push(newer); }
    if (['failed', 'newer-attempt'].includes(fault)) core.atomicWrite(ledgerPath, ledger);
    if (fault === 'request') p = core.applyRequest(p, { plan_id: p.plan_id, base_revision: p.revision, request_id: 'later-request', intent: 'implement', selected_step_ids: ['review'], operations: [] })[0];
    if (fault === 'scope') p.steps[0].done_when = 'New unreviewed requirement';
    if (fault === 'effort') p.steps.at(-1).reasoning_effort = 'high';
    if (['request', 'scope', 'effort'].includes(fault)) core.saveMarkdown(f.planPath, p);
    if (fault === 'source') fs.writeFileSync(path.join(f.cwd, 'code.txt'), 'drift');
    if (fault === 'index') require('node:child_process').execFileSync('git', ['add', 'code.txt'], { cwd: f.cwd });
    if (fault === 'mode') fs.chmodSync(path.join(f.cwd, 'code.txt'), 0o700);
    if (fault === 'manifest') fs.writeFileSync(path.join(r.review.snapshot.root, 'manifest.json'), '{}');
    if (fault === 'report') { const saved = JSON.parse(fs.readFileSync(r.result_path)); saved.review_report.checks[0].evidence = 'changed'; core.atomicWrite(r.result_path, saved); }
    if (fault === 'transcript') { const entries = fs.readFileSync(r.handle.transcript_path, 'utf8').trim().split('\n').map(JSON.parse); entries[0].id = 'other'; fs.writeFileSync(r.handle.transcript_path, entries.map(JSON.stringify).join('\n')); }
    if (fault === 'events') fs.writeFileSync(r.events_path, '');
    if (fault === 'test-artifacts') fs.writeFileSync(path.join(r.controlled_tests.check.artifact_root, 'test.txt'), 'drift');
    const actor = fault === 'owner' ? 'other-coordinator' : 'coordinator', before = canonicalBytes(f);
    await assert.rejects(core.mutatePlan(f.planPath, actor, plan => core.checkpoint(plan, plan.revision, 'review', 'completed', 'Do not accept this claim')));
    const cli = require('node:child_process').spawnSync(process.execPath, [path.join(root, 'dist/plan.cjs'), 'checkpoint', '--plan', f.planPath, '--task-id', actor,
      '--base-revision', String(p.revision), '--step-id', 'review', '--status', 'completed', '--note', 'Do not accept this claim'], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0, cli.stdout + cli.stderr); assert.deepEqual(canonicalBytes(f), before);
    if (fault === 'unverified') {
      await assert.rejects(core.mutatePlan(f.planPath, actor, plan => core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
        request_id: 'manual-bypass', intent: 'edit', operations: [{ type: 'set_status', step_id: 'review', status: 'completed' }] })), /verification/);
      assert.deepEqual(canonicalBytes(f), before);
    }
    if (fault === 'test-artifacts') fs.rmSync(r.controlled_tests.check.artifact_root, { recursive: true, force: true });
    f.passed();
  });
}
for (const route of ['service', 'CLI']) test(`review completion boundary accepts verified current evidence via ${route}`, async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const r = await f.runner.runPiReview(f.reviewOptions);
  await f.runner.verifyDispatch(f.planPath, r.assignment.assignment_id, f.options.authority, checkedReview);
  if (route === 'service') await core.mutatePlan(f.planPath, 'coordinator', p => core.checkpoint(p, p.revision, 'review', 'completed', 'Verified current evidence'));
  else require('node:child_process').execFileSync(process.execPath, [path.join(root, 'dist/plan.cjs'), 'checkpoint', '--plan', f.planPath, '--task-id', 'coordinator',
    '--base-revision', String(f.plan.revision), '--step-id', 'review', '--status', 'completed', '--note', 'Verified current evidence']);
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.steps.at(-1).status, 'completed'); f.passed();
});
test('review completion boundary rejects combined prerequisite edit and completion', async t => {
  const f = await reviewFixture(t, 'code-review', context => context.messages.at(-1).role === 'toolResult' ? { text: 'done' } : reportAnswer(context));
  const r = await f.runner.runPiReview(f.reviewOptions);
  await f.runner.verifyDispatch(f.planPath, r.assignment.assignment_id, f.options.authority, checkedReview);
  const before = canonicalBytes(f);
  await assert.rejects(core.mutatePlan(f.planPath, 'coordinator', p => {
    const next = core.checkpoint(p, p.revision, 'review', 'completed', 'Old evidence')[0];
    next.steps[0].done_when = 'New criterion in the completion write'; return [next, true];
  }), /requirements changed/);
  assert.deepEqual(canonicalBytes(f), before); f.passed();
});
test('review completion boundary preserves unmanaged review compatibility', async t => {
  const f = await reviewFixture(t, 'code-review', () => { throw Error('No reviewer needed'); });
  await core.mutatePlan(f.planPath, 'coordinator', p => core.checkpoint(p, p.revision, 'review', 'completed', 'External reviewer evidence'));
  assert.equal((await core.loadPlanSnapshot(f.planPath)).plan.steps.at(-1).status, 'completed'); f.passed();
});

// Bundle the actual runner with a test-only delay at the public SDK factory.
// No injection hook, private loader patch or fake AgentSession is shipped.
async function delayedConstruction(f) {
  const key = `hyperion-factory-${f.cwd}`;
  let enter, release, reject;
  const gate = { entered: new Promise(resolve => { enter = resolve; }), wait: new Promise((resolve, fail) => { release = resolve; reject = fail; }), enter,
    disposals: 0, prompts: 0, sessions: [] };
  globalThis[key] = gate;
  const output = path.join(f.cwd, 'delayed-runner.mjs'), sdkURL = url('node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  await require('esbuild').build({ absWorkingDir: root, entryPoints: ['src/pi/runner.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm',
    banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
    plugins: [{ name: 'delayed-sdk-factory', setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'factory', namespace: 'delay' }));
      build.onLoad({ filter: /.*/, namespace: 'delay' }, () => ({ loader: 'js', contents: `
        export * from ${JSON.stringify(sdkURL)};
        import { createAgentSession as actual } from ${JSON.stringify(sdkURL)};
        export async function createAgentSession(options) {
          const gate = globalThis[${JSON.stringify(key)}]; gate.enter(); await gate.wait;
          const result = await actual(options); gate.sessions.push(result.session);
          const dispose = result.session.dispose.bind(result.session), prompt = result.session.prompt.bind(result.session);
          result.session.dispose = () => { gate.disposals++; return dispose(); };
          result.session.prompt = (...args) => { gate.prompts++; return prompt(...args); };
          return result;
        }` }));
      build.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
      build.onResolve({ filter: /^proper-lockfile$/ }, () => ({ path: require.resolve('proper-lockfile'), external: true }));
    } }] });
  const runner = await import(pathToFileURL(output).href);
  return { gate, release, reject, runner, cleanup() { for (const s of gate.sessions) s.dispose(); delete globalThis[key]; } };
}
for (const stop of ['signal', 'deadline', 'shutdown', 'revoked']) for (const late of ['resolve', 'reject']) {
  test(`SDK construction cancellation ${stop} with late ${late} releases lock and retains uncertainty`, { timeout: 10000 }, async t => {
    const f = await fixture(t), delayed = await delayedConstruction(f), abort = new AbortController();
    f.options.signal = abort.signal; f.options.quiescenceTimeoutMs = 40;
    if (stop === 'deadline') f.options.timeoutMs = 60;
    const supervisor = new delayed.runner.PiAssignmentSupervisor();
    const run = supervisor.run(f.options); await delayed.gate.entered;
    if (stop === 'signal') abort.abort();
    if (stop === 'revoked') f.authority.currentRunAuthorized = false;
    const stopped = stop === 'shutdown' ? supervisor.stop('fixture shutdown') : undefined;
    // Bound the regression itself so the old deadlock fails instead of hanging the suite.
    let timer;
    try {
      const r = await Promise.race([run, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('construction did not return within 1000ms')), 1000); })]);
      assert.equal(r.phase, 'uncertain'); assert.equal(r.result, undefined); assert.ok(r.handle.session.native_id);
      assert.equal(fs.existsSync(f.planPath + '.lockdir'), false);
      await core.withLock(f.planPath, () => {});
      if (stopped) assert.equal((await stopped).state, 'unknown');
      assert.equal(f.requests.length, 0); assert.equal(delayed.gate.prompts, 0);
      if (late === 'resolve') delayed.release(); else delayed.reject(Error('late factory rejection'));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(delayed.gate.prompts, 0); assert.equal(f.requests.length, 0);
      if (late === 'resolve') assert.equal(delayed.gate.disposals, 1);
      assert.equal(f.runner.readDispatchLedger(f.planPath).records[0].phase, 'uncertain');
      f.authority.currentRunAuthorized = true;
      await assert.rejects(delayed.runner.runPiAssignment({ ...f.options, signal: undefined, assignment: { ...f.options.assignment, assignment_id: 'other-assignment', evidence_directory: f.runner.assignmentDirectory(f.planPath, 'other-assignment') }, attemptId: 'other-attempt' }), /Duplicate dispatch|active or uncertain/);
      assert.throws(() => supervisor.run(f.options), /unknown|stopped/i);
      f.passed();
    } finally {
      clearTimeout(timer); abort.abort(); delayed.release(); await run; if (stopped) await stopped;
      await new Promise(resolve => setTimeout(resolve, 100)); delayed.cleanup();
    }
  });
}
