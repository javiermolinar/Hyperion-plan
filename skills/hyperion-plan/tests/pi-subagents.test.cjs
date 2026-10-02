const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { spawnSync } = require('node:child_process');
if (process.argv[2] !== '--offline-proxy-fixture') {
let api, compiled;
before(async () => {
  compiled = path.join(root, `.agent-fixture-${process.pid}.mjs`);
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'pi/fixture.ts')], outfile: compiled,
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'public-ai', setup(build) { build.onResolve({ filter: /(?:pi-ai\/dist\/index.js|dist\/index.cjs)$/ }, args =>
      ({ path: path.resolve(args.resolveDir, args.path), external: true })); } }],
  });
  api = await import(pathToFileURL(compiled));
});
after(() => fs.rmSync(compiled, { force: true }));
async function fixture(t, respond = () => ({ text: 'Observed result; acceptance belongs to coordinator.' }), reasoning = false) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-agent-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ...await api.fixture(dir, respond, reasoning) };
}
const written = context => context.messages.at(-1).role === 'toolResult' ? { text: 'Observed output written' }
  : { tool: { name: 'write', arguments: { path: 'output.txt', content: 'approved' } } };

test('actual SDK foreground assignment preserves identity, scope and evidence even when its observer throws', async t => {
  const f = await fixture(t, context => {
    assert.equal(f.history.at(-1).state, 'running'); assert.ok(f.history.at(-1).native_id);
    return written(context);
  });
  const events = [];
  f.options.onEvent = event => { events.push(structuredClone(event)); throw new Error('broken screen'); };
  fs.mkdirSync(path.join(f.dir, '.pi/extensions'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, '.pi/extensions/poison.ts'), 'throw Error("AMBIENT_SECRET")');
  fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), 'AMBIENT_SECRET');
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.equal(result.settled, true);
  assert.ok(events.some(e => e.type === 'tool_execution_start' && e.toolName === 'write'));
  assert.ok(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'write'));
  assert.ok(events.some(e => e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta'));
  assert.ok(events.some(e => e.type === 'agent_settled'));
  assert.ok(result.started_at <= result.updated_at);
  assert.equal(fs.readFileSync(path.join(f.dir, 'output.txt'), 'utf8'), 'approved');
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), 'Canonical plan must remain unchanged');
  assert.deepEqual(f.history.map(r => r.state), ['launching', 'running', 'succeeded']);
  const entries = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].id, result.native_id); assert.equal(entries[0].parentSession, undefined);
  assert.deepEqual(api.getCurrentTools(f.requests[0].messages).map(t => t.name).sort(), ['edit', 'read', 'write']);
  assert.match(api.getCurrentSystemPrompt(f.requests[0].messages), /EXPLICIT_REQUIREMENT/);
  assert.doesNotMatch(JSON.stringify(f.requests), /AMBIENT_SECRET/);
  assert.equal(result.effort.actual, 'off'); assert.match(result.effort.limitation, /unsupported/);
  assert.deepEqual(await new api.Subagents().run(f.options), result, 'restoration inspects, never relaunches');
  assert.equal(f.requests.length, 2);
});

test('assignment returns and restores the entire report beyond the former 30k character cap', async t => {
  const report = '# Evidence\n' + 'Observed Unicode ✓ result\n'.repeat(2200) + '\nREPORT_END';
  const f = await fixture(t, () => ({ text: report }));
  f.options.model.maxTokens = 65536;
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'succeeded'); assert.equal(result.report, report);
  assert.equal(f.history.at(-1).report, report);
  assert.equal(api.inspectAssignment(f.history, f.options.id).report, report);
  assert.equal((await new api.Subagents().run(f.options)).report, report);
  assert.equal(f.requests.length, 1, 'inspection does not relaunch');
  const messages = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.type === 'message' && e.message.role === 'assistant');
  assert.equal(messages.at(-1).message.content.find(c => c.type === 'text').text, report);
});

async function growingContextFixture(t, onSummary = () => ({ text: 'Goal: inspect assigned files. Preserve explicit scope. Continue reads, then return the report.' }), includeToolError = false) {
  let reads = 0, summaries = 0;
  const paths = Array.from({ length: 6 }, (_, i) => `input-${i}.txt`);
  const f = await fixture(t, (context, signal) => {
    if (!api.getCurrentTools(context.messages).length) { summaries++; return onSummary(context, signal); }
    if (includeToolError) { includeToolError = false; return { tool: { name: 'read', arguments: { path: 'unassigned.txt' } } }; }
    if (reads < paths.length) return { tool: { name: 'read', arguments: { path: paths[reads++] } } };
    return { text: 'Reviewed all assigned files. Report complete.' };
  });
  f.options.model.contextWindow = 60000;
  f.options.writePaths = [];
  f.options.readPaths = paths.map(p => path.join(f.dir, p));
  for (const p of f.options.readPaths) fs.writeFileSync(p, ('observed evidence '.repeat(25) + '\n').repeat(100));
  return { ...f, counts: () => ({ reads, summaries }) };
}

test('actual SDK assignment compacts growing context without another assignment or lost report', { timeout: 10000 }, async t => {
  const f = await growingContextFixture(t);
  const before = fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8');
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.equal(result.settled, true);
  assert.equal(result.report, 'Reviewed all assigned files. Report complete.');
  assert.equal(f.counts().reads, 6); assert.ok(f.counts().summaries > 0, 'native summarization was requested');
  const entries = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(entries.some(e => e.type === 'compaction'), 'native compaction entry is durable');
  assert.equal(entries.filter(e => e.type === 'session').length, 1);
  assert.deepEqual(f.history.map(r => r.state), ['launching', 'running', 'succeeded']);
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), before);
  for (const context of f.requests.filter(c => api.getCurrentTools(c.messages).length)) {
    assert.deepEqual(api.getCurrentTools(context.messages).map(t => t.name), ['read']);
    assert.match(api.getCurrentSystemPrompt(context.messages), /EXPLICIT_REQUIREMENT/);
  }
});

test('native compaction cannot hide an earlier assignment tool error', async t => {
  const f = await growingContextFixture(t, undefined, true);
  const result = await f.handler.run(f.options);
  assert.ok(f.counts().summaries > 0);
  assert.equal(result.state, 'failed', 'summarizing an error does not convert the assignment into success');
  assert.equal(result.settled, true);
  const entries = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(entries.some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.isError));
});

test('caller cancellation during native compaction settles or holds without continuation or relaunch', { timeout: 10000 }, async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const f = await growingContextFixture(t, async (_context, signal) => {
    enter(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  });
  const controller = new AbortController(); f.options.signal = controller.signal;
  const running = f.handler.run(f.options); await entered; controller.abort();
  const result = await running;
  assert.ok(['cancelled', 'unknown'].includes(result.state), JSON.stringify(result));
  const requests = f.requests.length;
  assert.equal((await new api.Subagents().run(f.options)).native_id, result.native_id);
  assert.equal(f.requests.length, requests, 'native recovery may not continue after source cancellation');
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), 'Canonical plan must remain unchanged');
});

for (const fault of ['read-escape', 'write-escape', 'protected', 'hardlink', 'symlink']) test(`actual SDK rejects ${fault} without outside writes`, async t => {
  let f;
  f = await fixture(t, context => context.messages.at(-1).role === 'toolResult' ? { text: 'Tool refused; cannot claim success' }
    : { tool: { name: fault === 'read-escape' ? 'read' : 'write', arguments: { path: fault === 'protected' ? 'plan.md' : fault === 'hardlink' || fault === 'symlink' ? 'output.txt' : 'outside.txt', content: 'bad' } } });
  fs.writeFileSync(path.join(f.dir, 'outside.txt'), 'unchanged');
  if (fault === 'hardlink') fs.linkSync(path.join(f.dir, 'outside.txt'), path.join(f.dir, 'output.txt'));
  if (fault === 'symlink') fs.symlinkSync(path.join(f.dir, 'outside.txt'), path.join(f.dir, 'output.txt'));
  if (fault === 'hardlink' || fault === 'symlink') await assert.rejects(f.handler.run(f.options), /scope|unaliased/);
  else assert.equal((await f.handler.run(f.options)).state, 'failed');
  assert.equal(fs.readFileSync(path.join(f.dir, 'outside.txt'), 'utf8'), 'unchanged');
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), 'Canonical plan must remain unchanged');
});
test('actual SDK refuses shell, plan mutations, nested agents and test execution', async t => {
  const forbidden = ['bash', 'hyperion_plan', 'hyperion_agent', 'test_review'];
  let attempted = 0;
  const f = await fixture(t, () => attempted < forbidden.length
    ? { tool: { name: forbidden[attempted++], arguments: {} } } : { text: 'Refused all unavailable tools' });
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'failed'); assert.equal(result.settled, true);
  const messages = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => e.message);
  assert.deepEqual(messages.map(m => m.toolName), forbidden);
  assert.ok(messages.every(m => m.isError));
});
for (const requested of ['none', 'low', 'high', 'inherit', 'ultra']) test(`effort ${requested} uses real SDK control or reports a limitation`, async t => {
  const f = await fixture(t, undefined, true); f.options.effort = requested;
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.effort.actual, ['none', 'inherit', 'ultra'].includes(requested) ? 'off' : requested);
  assert.equal(Boolean(result.effort.limitation), requested === 'ultra');
});
for (const source of ['shutdown', 'revoked']) test(`actual SDK ${source} joins writers or preserves unknown without relaunch`, { timeout: 10000 }, async t => {
  let enter; const entered = new Promise(r => enter = r); let allowed = true;
  const f = await fixture(t, async (_context, signal) => {
    enter(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  });
  f.options.withPermission = async work => { assert.ok(allowed, 'Authority revoked'); return work(); };
  const running = f.handler.run(f.options); await entered;
  if (source === 'shutdown') void f.handler.stop(); else allowed = false;
  const result = await running;
  assert.ok(['cancelled', 'unknown'].includes(result.state), JSON.stringify(result));
  assert.equal(f.requests.length, 1);
  assert.equal((await new api.Subagents().run(f.options)).native_id, result.native_id);
  assert.equal(f.requests.length, 1);
});
async function nativeToolFixture(t, respond = written, steps = [{ id: 'work', title: 'Write output', done_when: 'output.txt contains approved' }, { id: 'other', title: 'Unselected' }]) {
  const core = require('../dist/index.cjs'), f = await fixture(t, respond);
  const file = path.join(f.dir, 'plan.md');
  let plan = core.initialize({ title: 'Native delegation', steps });
  plan = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'current-run', intent: 'implement', selected_step_ids: ['work'], operations: [] })[0];
  core.saveMarkdown(file, plan);
  const tools = new Map(), entries = [], events = new Map();
  const pi = { on(name, callback) { const all = events.get(name) ?? []; all.push(callback); events.set(name, all); return () => {}; },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {}, getThinkingLevel: () => 'off',
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); } };
  (await import('../dist/hyperion-plan-pi.js')).default(pi);
  const ctx = { cwd: f.dir, mode: 'json', model: f.options.model, modelRegistry: { streamSimple: (...args) => f.options.modelRuntime.streamSimple(...args) },
    sessionManager: { getSessionId: () => 'coordinator', getSessionDir: () => path.join(f.dir, 'parent'), getEntries: () => entries, getBranch: () => entries } };
  const params = { action: 'run', assignment_id: 'native', plan_path: file, request_id: 'current-run', step_id: 'work', instructions: 'Write output.txt only', write_paths: ['output.txt'] };
  const call = (args = params, signal) => tools.get('hyperion_agent').execute('native-call', args, signal, undefined, ctx);
  return { ...f, core, file, plan, tools, entries, events, ctx, params, call };
}

test('native dispatch -> validated start -> SDK report -> inspection -> coordinator-verified completion', async t => {
  const f = await nativeToolFixture(t, context => {
    const plan = f.core.loadMarkdown(f.file)[0];
    assert.equal(plan.steps[0].status, 'in_progress', 'start must be saved before the first model request');
    return written(context);
  });
  const result = (await f.call()).details;
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.plan_id, f.plan.plan_id); assert.equal(result.request_id, 'current-run'); assert.equal(result.step_id, 'work');
  assert.equal(result.checkpointed, true);
  assert.match(result.scope_digest, /^[a-f0-9]{64}$/);
  const after = (await f.core.loadPlanSnapshot(f.file)).plan;
  assert.equal(after.revision, f.plan.revision + 1); assert.equal(result.plan_revision, after.revision);
  assert.equal(after.steps[0].status, 'in_progress'); assert.equal(after.steps[1].status, 'pending');
  assert.match(after.steps[0].progress_note, /preflight passed/);
  assert.equal(f.entries.filter(e => e.customType === 'hyperion.agent').length, 3);
  const artifacts = () => [f.file, f.core.markdownStatePath(f.file), f.core.notesPath(f.file)].map(p => fs.readFileSync(p, 'utf8'));
  const before = artifacts();
  const repeated = (await f.call()).details;
  const inspected = (await f.call({ action: 'inspect', assignment_id: 'native' })).details;
  assert.deepEqual(repeated, inspected, 'repeated IDs return inspection evidence');
  for (const key of ['state', 'settled', 'native_id', 'transcript_path', 'report', 'plan_revision', 'scope_digest'])
    assert.equal(inspected[key], result[key], key);
  assert.equal(f.requests.length, 2, 'inspection never relaunches');
  assert.deepEqual(artifacts(), before);
  const checkpoint = (revision, note) => f.tools.get('hyperion_plan').execute('complete', {
    action: 'checkpoint', path: f.file, plan_id: after.plan_id, base_revision: revision,
    update: JSON.stringify({ execution_request_id: 'current-run', step_id: 'work', status: 'completed', note }),
  }, undefined, undefined, f.ctx);
  await assert.rejects(checkpoint(f.plan.revision, 'Stale coordinator evidence'), /Stale plan/);
  await assert.rejects(checkpoint(inspected.plan_revision, ''), /evidence/);
  assert.deepEqual(artifacts(), before);

  // The coordinator checks observed evidence and acceptance before a separate write.
  assert.equal(inspected.settled, true); assert.equal(inspected.report, 'Observed output written');
  assert.equal(fs.readFileSync(path.join(f.dir, 'output.txt'), 'utf8'), 'approved');
  const transcript = fs.readFileSync(inspected.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(transcript[0].id, inspected.native_id);
  assert.ok(transcript.some(e => e.type === 'message' && e.message.role === 'toolResult' && !e.message.isError));
  const done = (await checkpoint(inspected.plan_revision, 'Coordinator inspected native report and verified output.txt contains approved')).details.plan;
  assert.equal(done.revision, inspected.plan_revision + 1);
  assert.equal(done.steps[0].status, 'completed'); assert.equal(done.steps[1].status, 'pending');
  assert.deepEqual(done.execution, after.execution); assert.equal(f.requests.length, 2);

  f.entries.push({ type: 'custom', customType: 'hyperion.agent', data: { ...result, id: 'unjoined', state: 'running', settled: false } });
  const completed = artifacts();
  await assert.rejects(checkpoint(done.revision, 'Cannot accept evidence with an unjoined assignment'), /unknown writers/);
  assert.deepEqual(artifacts(), completed);
});

test('native dispatch cancellation preserves the validated start and repeated IDs never resume work', { timeout: 10000 }, async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const f = await nativeToolFixture(t, async (_context, signal) => {
    enter(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  });
  const controller = new AbortController();
  const running = f.call(f.params, controller.signal);
  await entered; controller.abort();
  const result = (await running).details;
  assert.ok(['cancelled', 'unknown'].includes(result.state), JSON.stringify(result));
  assert.ok(result.native_id); assert.equal(result.checkpointed, true);
  const after = (await f.core.loadPlanSnapshot(f.file)).plan;
  assert.equal(after.revision, f.plan.revision + 1); assert.equal(after.steps[0].status, 'in_progress');
  assert.equal(after.steps[1].status, 'pending');
  const files = [f.file, f.core.markdownStatePath(f.file)], before = files.map(p => fs.readFileSync(p));
  assert.equal((await f.call()).details.native_id, result.native_id);
  assert.equal((await f.call({ action: 'inspect', assignment_id: 'native' })).details.state, result.state);
  assert.equal(f.requests.length, 1); assert.deepEqual(files.map(p => fs.readFileSync(p)), before);
  assert.equal(fs.existsSync(path.join(f.dir, 'output.txt')), false);
});

test('already-started native dispatch preserves the canonical plan', async t => {
  const f = await nativeToolFixture(t);
  const started = f.core.checkpoint(f.plan, f.plan.revision, 'work', 'in_progress', 'Coordinator start')[0];
  f.core.saveMarkdown(f.file, started);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = (await f.call()).details;
  assert.equal(result.state, 'succeeded'); assert.equal(result.checkpointed, true);
  assert.equal(result.plan_revision, started.revision);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

for (const fault of ['external', 'missing', 'protected', 'wrong-request', 'unselected', 'owner', 'model', 'paused', 'aborted']) test(`dispatch ${fault} rejection precedes model setup and start checkpoint`, async t => {
  const f = await nativeToolFixture(t);
  let args = { ...f.params, write_paths: [] }, signal;
  let code = 'dispatch_rejected';
  if (fault === 'external') { args.read_paths = [path.join(path.dirname(f.dir), 'outside-assignment.txt')]; code = 'outside_workspace'; }
  if (fault === 'missing') { args.read_paths = ['missing.txt']; code = 'missing_read_path'; }
  if (fault === 'protected') { args.read_paths = ['plan.md']; code = 'protected_path'; }
  if (fault === 'wrong-request') args.request_id = 'not-current';
  if (fault === 'unselected') args.step_id = 'other';
  if (fault === 'owner') f.core.saveMarkdown(f.file, { ...f.plan, execution_owner: 'another-task' });
  if (fault === 'model') f.ctx.model = undefined;
  if (fault === 'paused') f.core.saveMarkdown(f.file, f.core.checkpoint(f.plan, f.plan.revision, undefined, undefined, undefined, undefined, 'paused')[0]);
  if (fault === 'aborted') { const controller = new AbortController(); controller.abort(); signal = controller.signal; }
  const before = fs.readFileSync(f.file, 'utf8');
  const result = await f.call(args, signal), rejected = result.details;
  assert.equal(result.isError, true); assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.rejection.code, code); assert.equal(rejected.rejection.workspace, f.dir);
  assert.equal(rejected.native_id, ''); assert.equal(rejected.transcript_path, '');
  assert.equal(rejected.settled, true); assert.equal(rejected.checkpointed, false);
  assert.equal(f.requests.length, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.dir, 'parent', 'hyperion-agents')), false);
  assert.equal(f.entries.filter(e => e.customType === 'hyperion.agent').length, 1);
  if (fault === 'external') {
    assert.equal(rejected.rejection.path, args.read_paths[0]);
    assert.match(rejected.limitation, /inside the coordinator workspace.*even when explicitly listed/);
    assert.match(rejected.limitation, /Workspace:/);
  }
});

for (const target of ['markdown', 'sidecar']) test(`concurrent ${target} change rejects dispatch without refreshing or starting work`, async t => {
  const f = await nativeToolFixture(t);
  const file = target === 'markdown' ? f.file : f.core.markdownStatePath(f.file);
  let calls = 0, changed;
  f.ctx.sessionManager.getSessionId = () => {
    if (++calls === 3) {
      changed = fs.readFileSync(file, 'utf8') + '\n';
      fs.writeFileSync(file, changed);
    }
    return 'coordinator';
  };
  const result = await f.call();
  assert.equal(result.isError, true); assert.equal(result.details.state, 'rejected');
  assert.equal(result.details.checkpointed, false); assert.match(result.details.limitation, /Plan changed during dispatch preflight/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), changed, 'dispatch must not refresh or overwrite the concurrent change');
});

test('native review rejects writes before launch, then runs a read-only actual SDK review', async t => {
  const f = await nativeToolFixture(t, context => context.messages.at(-1).role === 'toolResult'
    ? { text: 'Observed review input; findings do not authorize fixes.' }
    : { tool: { name: 'read', arguments: { path: 'input.txt' } } }, [
    { id: 'pre', title: 'Implemented work', status: 'completed' },
    { id: 'work', title: 'Review', kind: 'review', depends_on: ['pre'], checks: ['Inspect behavior'] },
  ]);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = await f.call();
  assert.equal(result.isError, true); assert.equal(result.details.state, 'rejected');
  assert.match(result.details.limitation, /Reviews have no write permissions/);
  assert.equal(result.details.checkpointed, false); assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.writeFileSync(path.join(f.dir, 'input.txt'), 'review input');
  const reviewed = (await f.call({ ...f.params, assignment_id: 'read-only-review', write_paths: [], read_paths: ['input.txt'] })).details;
  assert.equal(reviewed.state, 'succeeded'); assert.equal(reviewed.settled, true);
  assert.equal(reviewed.report, 'Observed review input; findings do not authorize fixes.');
  assert.deepEqual(api.getCurrentTools(f.requests[0].messages).map(t => t.name), ['read']);
  const after = (await f.core.loadPlanSnapshot(f.file)).plan;
  assert.equal(after.steps[1].status, 'in_progress', 'review report is not canonical completion');
  assert.equal(fs.readFileSync(path.join(f.dir, 'input.txt'), 'utf8'), 'review input');
  assert.equal(fs.existsSync(path.join(f.dir, 'output.txt')), false);
});

test('a rejected ID stays rejected; a fresh authorized Run can dispatch without erasing its history', async t => {
  const f = await nativeToolFixture(t);
  const rejected = await f.call({ ...f.params, read_paths: ['missing.txt'] });
  const repeated = await f.call();
  assert.equal(repeated.isError, true); assert.deepEqual(repeated.details, rejected.details);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.call({ action: 'inspect', assignment_id: f.params.assignment_id })).details.state, 'rejected');
  const next = f.core.applyRequest(f.plan, { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'fresh-run', intent: 'implement', selected_step_ids: ['work'], operations: [] })[0];
  f.core.saveMarkdown(f.file, next);
  const result = (await f.call({ ...f.params, request_id: 'fresh-run', assignment_id: 'fresh-run-work' })).details;
  assert.equal(result.state, 'succeeded');
  assert.equal(f.entries.filter(e => e.customType === 'hyperion.agent' && e.data.state === 'rejected').length, 1);
  assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.steps[0].status, 'in_progress');
});

test('restored unfinished intent holds new work; rejection and inspection never clear unknown writers', async t => {
  const f = await fixture(t); const event = { id: 'old', state: 'launching', native_id: 'native-old', transcript_path: '/missing', context_digest: 'old', settled: false };
  f.history.push(event);
  assert.equal(api.inspectAssignment(f.history, 'old').state, 'unknown');
  await assert.rejects(async () => f.handler.run(f.options), /Unsettled prior/);
  assert.deepEqual(f.history, [event]); assert.equal(f.requests.length, 0);

  const native = await nativeToolFixture(t);
  native.entries.push({ type: 'custom', customType: 'hyperion.agent', data: event });
  const before = [native.file, native.core.markdownStatePath(native.file)].map(p => fs.readFileSync(p, 'utf8'));
  for (const assignment_id of ['rejected-run', 'another-run']) {
    const rejected = await native.call({ ...native.params, assignment_id });
    assert.equal(rejected.details.state, 'rejected'); assert.equal(rejected.details.checkpointed, false);
    assert.match(rejected.details.limitation, /unknown writers/);
  }
  const inspected = (await native.call({ action: 'inspect', assignment_id: 'old' })).details;
  assert.equal(inspected.state, 'unknown'); assert.equal(inspected.settled, false);
  assert.deepEqual(native.entries[0].data, event);
  assert.deepEqual([native.file, native.core.markdownStatePath(native.file)].map(p => fs.readFileSync(p, 'utf8')), before);
  assert.equal(native.requests.length, 0);
});

}
const cases = ['codex-token', 'rotating-source-key', 'missing-source-auth'];

// A separate, credential-free process keeps SDK environment discovery and network
// guards out of the other tests. No agent session or model request is launched.
if (process.argv[2] === '--offline-proxy-fixture') {
  runFixture(process.argv[3], process.argv[4]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { test } = require('node:test');
  for (const name of cases) test(`model proxy resolves source authentication: ${name}`, { timeout: 30000 }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-proxy-auth-'));
    fs.mkdirSync(path.join(dir, 'home'));
    const result = spawnSync(process.execPath, [__filename, '--offline-proxy-fixture', name, dir], {
      env: { HOME: path.join(dir, 'home'), PATH: process.env.PATH },
      encoding: 'utf8', timeout: 25000,
    });
    if (result.status === 0) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    else t.diagnostic(`Proxy regression artifacts: ${dir}`);
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { case: name, networkAttempts: 0 });
  });
}

async function runFixture(name, dir) {
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden'); };
  require('node:net').Socket.prototype.connect = function () { networkAttempts++; throw new Error('Network forbidden'); };
  const sdkPath = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const aiRoot = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
  // Test the actual source helper, not a reimplementation or an extra shipped API.
  const modulePath = path.join(dir, 'model-proxy.mjs');
  await require('esbuild').build({
    entryPoints: [path.join(root, 'src/pi/subagents.ts')], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: 'const __dirname = new URL(".", import.meta.url).pathname;' },
    plugins: [{ name: 'installed-public-dependencies', setup(build) {
      build.onResolve({ filter: /^(@earendil-works\/pi-coding-agent|proper-lockfile)$/ }, args =>
        ({ path: args.path === '@earendil-works/pi-coding-agent' ? sdkPath : require.resolve(args.path), external: true }));
    } }],
  });
  const { ModelRuntime } = await import(pathToFileURL(sdkPath));
  const ai = await import(pathToFileURL(path.join(aiRoot, 'index.js')));
  const codex = await import(pathToFileURL(path.join(aiRoot, 'api/openai-codex-responses.js')));
  const { childModelProxy } = await import(pathToFileURL(modulePath));
  const isCodex = name === 'codex-token';
  const model = { provider: isCodex ? 'openai-codex' : 'offline-proxy-test',
    id: 'offline', name: 'Offline proxy regression', api: isCodex ? 'openai-codex-responses' : 'openai-completions',
    baseUrl: 'https://invalid.test', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Synthetic, unsigned and never transmitted; this is token parsing, not a login.
  const token = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })}.fake`;
  let expectedKey = isCodex ? token : 'offline-source-key-one';
  const source = await ModelRuntime.create({ authPath: path.join(dir, 'source-auth.json'), modelsPath: null,
    modelsStorePath: path.join(dir, 'source-models.json'), refreshOnCreate: false, allowModelNetwork: false });
  let sourceCalls = 0, forwardedCalls = 0, payloadCalls = 0;
  const controller = new AbortController();
  const options = { signal: controller.signal, reasoning: 'high', maxTokens: 123, sessionId: 'offline-session',
    transport: 'sse', headers: { 'x-offline-test': 'preserved' }, env: { OFFLINE_TEST_ENV: 'preserved' },
    onPayload() { payloadCalls++; throw new Error('Offline token extraction passed'); },
    onResponse() {}, onProviderStreamEvent() {},
  };
  source.registerProvider(model.provider, {
    api: model.api, models: [model], ...(name === 'missing-source-auth' ? {} : { apiKey: expectedKey }),
    streamSimple(selected, context, opts) {
      sourceCalls++;
      assert.equal(opts.apiKey, expectedKey, 'source credentials must win over child placeholder');
      if (isCodex) return codex.streamSimple(selected, context, opts);
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
        timestamp: Date.now(), content: [], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const context = { messages: [{ role: 'user', content: 'Offline proxy regression', timestamp: 1 }] };
  if (isCodex) {
    // Prove the real Codex parser rejects the old placeholder before any request,
    // while the source fixture token reaches the pre-network payload hook.
    const rejected = await codex.streamSimple(model, context, { ...options, apiKey: 'in-process-registry-proxy' }).result();
    assert.equal(rejected.errorMessage, 'Failed to extract accountId from token');
    const direct = await source.streamSimple(model, context, options).result();
    assert.equal(direct.errorMessage, 'Offline token extraction passed');
  }
  const originalModel = structuredClone(model);
  const proxy = await childModelProxy({ model, modelRegistry: {
    streamSimple(selected, ctx, opts) {
      forwardedCalls++;
      assert.equal(Object.hasOwn(opts, 'apiKey'), false, 'do not forward any child API key override');
      assert.deepEqual(selected, originalModel);
      for (const key of ['signal', 'onPayload', 'onResponse', 'onProviderStreamEvent']) assert.equal(opts[key], options[key], key);
      for (const key of ['reasoning', 'maxTokens', 'sessionId', 'transport', 'headers', 'env']) assert.deepEqual(opts[key], options[key], key);
      return source.streamSimple(selected, ctx, opts);
    },
  } }, path.join(dir, 'children'));
  assert.deepEqual(model, originalModel, 'source model metadata is unchanged');
  const result = await proxy.runtime.streamSimple(proxy.model, context, options).result();
  if (isCodex) {
    assert.equal(result.errorMessage, 'Offline token extraction passed');
    assert.equal(payloadCalls, 2);
    assert.equal(sourceCalls, 2);
  } else if (name === 'missing-source-auth') {
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Provider is not configured/);
    assert.equal(sourceCalls, 0, 'placeholder cannot mask absent source credentials');
  } else {
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    expectedKey = 'offline-source-key-two';
    await source.setRuntimeApiKey(model.provider, expectedKey);
    const again = await proxy.runtime.streamSimple(proxy.model, context, options).result();
    assert.equal(again.stopReason, 'stop', again.errorMessage);
    assert.equal(sourceCalls, 2, 'source credentials are resolved afresh for each call');
  }
  assert.equal(forwardedCalls, name === 'rotating-source-key' ? 2 : 1);
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({ case: name, networkAttempts }));
}
