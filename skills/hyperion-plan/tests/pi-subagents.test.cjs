const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { spawnSync } = require('node:child_process');
if (!['--offline-proxy-fixture', '--offline-codemode-fixture'].includes(process.argv[2])) {
let api, compiled, compiledExtension;
before(async () => {
  compiled = path.join(root, `.agent-fixture-${process.pid}.mjs`);
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'pi/fixture.ts')], outfile: compiled,
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
    plugins: [{ name: 'public-ai', setup(build) { build.onResolve({ filter: /(?:pi-ai\/dist\/index.js|dist\/index.cjs)$/ }, args =>
      ({ path: path.resolve(args.resolveDir, args.path), external: true })); } }],
  });
  api = await import(pathToFileURL(compiled));
  // Exercise current executor source without regenerating shipped bundles for this step.
  compiledExtension = path.join(root, `.agent-extension-${process.pid}.mjs`);
  await require("esbuild").build({ entryPoints: [path.join(root, "src/pi/extension.ts")], outfile: compiledExtension,
    bundle: true, format: "esm", platform: "node", packages: "external",
    banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
  });
});
after(() => { for (const file of [compiled, compiledExtension]) if (file) fs.rmSync(file, { force: true }); });
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

test('assignment records effective canonical claims and opaque correlation before the first child request', async t => {
  const f = await fixture(t, () => {
    const intent = f.history[0];
    assert.equal(intent.state, 'launching'); assert.equal(intent.settled, false);
    assert.equal(intent.workspace, f.dir);
    assert.deepEqual(intent.read_paths, [path.join(f.dir, 'input.txt'), path.join(f.dir, 'output.txt')]);
    assert.deepEqual(intent.write_paths, [path.join(f.dir, 'output.txt')]);
    for (const [key, value] of Object.entries(originalCorrelation)) assert.equal(intent[key], value, key);
    // Caller mutations cannot rewrite a reserved assignment's claims/correlation.
    f.options.correlation.request_id = 'mutated'; f.options.writePaths.length = 0;
    return { text: 'Observed scoped assignment.' };
  });
  const originalCorrelation = structuredClone(f.options.correlation);
  fs.writeFileSync(path.join(f.dir, 'input.txt'), 'input');
  f.options.readPaths = [path.join(f.dir, 'input.txt'), path.join(f.dir, 'input.txt'), path.join(f.dir, 'output.txt')];
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'succeeded');
  const claimKeys = ['workspace', 'read_paths', 'write_paths', ...Object.keys(originalCorrelation)];
  const intent = f.history[0];
  for (const record of f.history) for (const key of claimKeys) assert.deepEqual(record[key], intent[key], key);
  const entries = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  const childIntent = entries.find(e => e.type === 'custom' && e.customType === 'hyperion.agent').data;
  assert.deepEqual(childIntent, intent, 'the child stores the same intent, not an executor-free record');
  assert.equal(entries[0].id, intent.native_id); assert.equal(result.native_id, intent.native_id);
  assert.equal(result.transcript_path, intent.transcript_path);
  const inspected = api.inspectAssignment(f.history, result.id);
  inspected.read_paths.length = 0; inspected.write_paths.push('/tampered');
  assert.deepEqual(api.inspectAssignment(f.history, result.id).read_paths, intent.read_paths, 'inspection is an isolated snapshot');
});

for (const state of ['succeeded', 'failed', 'cancelled']) test(`settled legacy ${state} remains inspectable without invented claims or replay`, async t => {
  const f = await fixture(t);
  const legacy = { id: 'legacy', state, native_id: 'native-legacy', transcript_path: '/historical.jsonl', context_digest: 'old', settled: true,
    // Old executor-only correlation lacks coordinator identity and file claims.
    plan_path: path.join(f.dir, 'plan.md'), plan_id: 'old-plan', request_id: 'old-run', step_id: 'old-work', scope_digest: 'b'.repeat(64) };
  f.history.push(structuredClone(legacy));
  assert.deepEqual(api.inspectAssignment(f.history, legacy.id), legacy);
  assert.deepEqual(await f.handler.run({ ...f.options, id: legacy.id }), legacy);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.handler.run(f.options)).state, 'succeeded', 'verified terminal legacy history does not prohibit unrelated new work');
  assert.deepEqual(f.history[0], legacy);
});

for (const fault of ['workspace', 'missing-writes', 'relative-read', 'external-write', 'missing-coordinator', 'missing-request', 'scope', 'write-not-readable']) test(`malformed new ${fault} claims hold inspection and new work`, async t => {
  const f = await fixture(t);
  const record = { ...f.options.correlation, id: 'damaged', state: 'succeeded', native_id: 'native-old', transcript_path: '/old.jsonl', context_digest: 'old', settled: true,
    workspace: f.dir, read_paths: [path.join(f.dir, 'output.txt')], write_paths: [path.join(f.dir, 'output.txt')] };
  if (fault === 'workspace') record.workspace = '.';
  if (fault === 'missing-writes') delete record.write_paths;
  if (fault === 'relative-read') record.read_paths = ['output.txt'];
  if (fault === 'external-write') record.write_paths = ['/outside.txt'];
  if (fault === 'missing-coordinator') delete record.coordinator_id;
  if (fault === 'missing-request') delete record.request_id;
  if (fault === 'scope') record.scope_digest = 'invalid';
  if (fault === 'write-not-readable') record.read_paths = [];
  f.history.push(record);
  assert.throws(() => api.inspectAssignment(f.history, 'damaged'), /Malformed assignment history/);
  await assert.rejects(async () => f.handler.run(f.options), /Malformed assignment history/);
  assert.equal(f.requests.length, 0); assert.deepEqual(f.history, [record]);
});

test('unfinished new claims remain unknown after restoration, not proof of a live handle', async t => {
  const f = await fixture(t);
  const record = { ...f.options.correlation, id: 'unfinished', state: 'running', native_id: 'native-old', transcript_path: '/old.jsonl', context_digest: 'old', settled: false,
    workspace: f.dir, read_paths: [path.join(f.dir, 'output.txt')], write_paths: [path.join(f.dir, 'output.txt')] };
  f.history.push(record);
  assert.equal(api.inspectAssignment(f.history, record.id).state, 'unknown');
  assert.equal((await f.handler.run({ ...f.options, id: record.id })).native_id, record.native_id);
  await assert.rejects(async () => f.handler.run(f.options), /Unsettled prior/);
  assert.equal(f.requests.length, 0); assert.deepEqual(f.history, [record]);
});

test('invalid assignment correlation rejects before reservation or child request', async t => {
  const f = await fixture(t); f.options.correlation.scope_digest = 'invalid';
  await assert.rejects(f.handler.run(f.options), /canonical assignment correlation/);
  assert.equal(f.history.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.options.sessionDir), false);
});

test('failed intent persistence never constructs or prompts a child', async t => {
  const f = await fixture(t);
  f.options.record = () => { throw new Error('Native history save failed'); };
  await assert.rejects(f.handler.run(f.options), /Native history save failed/);
  assert.equal(f.requests.length, 0); assert.equal(f.history.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'output.txt')), false);
  assert.equal(fs.existsSync(path.join(f.options.sessionDir, 'agent')), false, 'SDK construction was not reached');
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), 'Canonical plan must remain unchanged');
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

test('read-only native recovery restores a lost parent report without settling the parent fence', async t => {
  const report = 'Observed native evidence ✓\n' + 'detail\n'.repeat(6000);
  const f = await fixture(t, () => ({ text: report })); f.options.model.maxTokens = 65536;
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  f.history.pop(); // The coordinator lost only its terminal entry.
  const beforeHistory = structuredClone(f.history), beforeFile = fs.readFileSync(result.transcript_path);
  const recovered = api.inspectAssignment(f.history, result.id, f.inspectionScope);
  assert.equal(recovered.source, 'child-session'); assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.settled, true);
  assert.equal(recovered.parent_state, 'running'); assert.equal(recovered.parent_settled, false); assert.equal(recovered.report, report);
  assert.match(recovered.limitation, /Parent lifecycle is unchanged/);
  assert.deepEqual(f.history, beforeHistory); assert.deepEqual(fs.readFileSync(result.transcript_path), beforeFile);
  assert.equal(api.inspectAssignment(f.history, result.id).state, 'unknown', 'legacy/lifecycle inspection still sees the fence');
  assert.throws(() => new api.Subagents().assertHistory(f.history), /unknown writers/);
  const restored = { sessionManager: { getEntries: () => f.history.map(data => ({ type: 'custom', customType: 'hyperion.agent', data })) } };
  assert.throws(() => api.assertAgentIdle(restored), /unknown writers/);
  await assert.rejects(new api.Subagents().run({ ...f.options, id: 'new-work' }), /Unsettled prior/);
  assert.equal(f.requests.length, 1);
  const entries = beforeFile.toString('utf8').trim().split('\n').map(JSON.parse);
  const marker = entries.at(-1);
  assert.equal(marker.customType, api.SETTLEMENT_ENTRY); assert.equal(marker.data.state, 'succeeded');
  assert.equal(marker.data.native_id, result.native_id); assert.equal(marker.data.assignment_id, result.id);
  assert.equal(marker.data.report, undefined); assert.doesNotMatch(JSON.stringify(marker), /Observed native evidence/);
  assert.equal(marker.data.report_entry_id, entries.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).id);
});

test('recovery requires the unchanged original parent launching reservation', async t => {
  const f = await fixture(t); const terminal = await f.handler.run(f.options);
  const launch = structuredClone(f.history[0]), running = structuredClone(f.history[1]);
  for (const records of [[running], [launch, { ...running, context_digest: 'b'.repeat(64) }], [launch, structuredClone(launch), running]]) {
    const before = structuredClone(records);
    const result = api.inspectAssignment(records, terminal.id, f.inspectionScope);
    assert.equal(result.state, 'unknown'); assert.equal(result.settled, false); assert.equal(result.source, 'unresolved');
    assert.match(result.limitation, /Parent launching reservation/); assert.deepEqual(records, before);
  }
  assert.equal(f.requests.length, 1);
});

test('current request group inspection distinguishes recovered success/failure, parent rejection and unresolved intent', async t => {
  const f = await fixture(t, context => api.getCurrentSystemPrompt(context.messages).includes('FAILURE')
    ? (context.messages.at(-1).role === 'toolResult' ? { text: 'Observed refusal, not success.' }
      : { tool: { name: 'read', arguments: { path: 'not-assigned.txt' } } }) : { text: 'Observed success.' });
  const success = await f.handler.run(f.options);
  const failure = await f.handler.run({ ...f.options, id: 'failure', context: 'FAILURE', correlation: { ...f.options.correlation, step_id: 'other' } });
  assert.equal(failure.state, 'failed');
  f.history.splice(0, f.history.length, ...f.history.filter(r => !r.settled));
  f.history.push({ ...f.options.correlation, id: 'rejection', state: 'rejected', native_id: '', transcript_path: '', context_digest: '', settled: true });
  f.history.push({ ...f.history[0], id: 'pending', native_id: 'missing-native', transcript_path: path.join(f.options.sessionDir, 'missing.jsonl') });
  f.history.push({ ...f.history[0], id: 'foreign-request', request_id: 'other-request' });
  const before = structuredClone(f.history);
  const result = api.inspectAssignments(f.history, f.inspectionScope);
  assert.deepEqual(result.outcomes, { settled: 1, failed: 1, rejected: 1, unresolved: 1 });
  assert.deepEqual(result.assignments.map(r => r.id), [success.id, failure.id, 'rejection', 'pending']);
  assert.deepEqual(result.assignments.map(r => r.source), ['child-session', 'child-session', 'parent', 'unresolved']);
  assert.deepEqual(f.history, before); assert.equal(result.read_only, true); assert.equal(f.requests.length, 3);
});

for (const fault of ['native-id', 'header-id', 'header-workspace', 'header-parent', 'coordinator', 'plan', 'plan-id', 'request',
  'context-digest', 'scope-digest', 'canonical-scope', 'claims', 'intent-claims', 'intent-state', 'intent-native', 'intent-coordinator',
  'intent-plan', 'intent-request', 'intent-context', 'intent-scope', 'marker-native', 'marker-assignment',
  'marker-digest', 'marker-state', 'marker-failed', 'marker-intent', 'marker-report', 'missing-marker', 'duplicate-marker', 'duplicate-intent', 'marker-before-prose',
  'intent-off-branch', 'invalid-parent-order', 'missing', 'corrupt', 'truncated', 'invalid-encoding', 'oversized', 'outside-root',
  'relative-path', 'noncanonical-path', 'symlink', 'hardlink', 'directory', 'aliased-root', 'wrong-root', 'unknown-entry', 'corrupt-message']) {
  test('native recovery keeps ' + fault + ' unknown without rewriting any session', async t => {
    const f = await fixture(t, () => ({ text: 'Final prose alone does not prove settlement.' }));
    const terminal = await f.handler.run(f.options); assert.equal(terminal.state, 'succeeded', JSON.stringify(terminal));
    const record = structuredClone(f.history[0]), scope = { ...f.inspectionScope };
    const file = terminal.transcript_path, original = fs.readFileSync(file);
    let entries = original.toString('utf8').trim().split('\n').map(JSON.parse);
    const header = entries[0], intent = entries.find(e => e.type === 'custom' && e.customType === 'hyperion.agent');
    const marker = entries.at(-1), report = entries.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1);
    if (fault === 'native-id') record.native_id = 'wrong-native';
    if (fault === 'header-id') header.id = 'wrong-native';
    if (fault === 'header-workspace') header.cwd = path.dirname(f.dir);
    if (fault === 'header-parent') header.parentSession = 'another-session.jsonl';
    if (fault === 'coordinator') record.coordinator_id = 'another-coordinator';
    if (fault === 'plan') record.plan_path = path.join(f.dir, 'other-plan.md');
    if (fault === 'plan-id') record.plan_id = 'another-plan';
    if (fault === 'request') record.request_id = 'another-request';
    if (fault === 'context-digest') record.context_digest = 'b'.repeat(64);
    if (fault === 'scope-digest') record.scope_digest = 'b'.repeat(64);
    if (fault === 'canonical-scope') scope.scopeDigest = () => 'b'.repeat(64);
    if (fault === 'claims') record.read_paths.push(path.join(f.dir, 'extra.txt'));
    if (fault === 'intent-claims') intent.data.read_paths.push(path.join(f.dir, 'extra.txt'));
    if (fault === 'intent-state') intent.data.state = 'running';
    if (fault === 'intent-native') intent.data.native_id = 'wrong-native';
    if (fault === 'intent-coordinator') intent.data.coordinator_id = 'wrong-coordinator';
    if (fault === 'intent-plan') intent.data.plan_path = path.join(f.dir, 'other-plan.md');
    if (fault === 'intent-request') intent.data.request_id = 'wrong-request';
    if (fault === 'intent-context') intent.data.context_digest = 'b'.repeat(64);
    if (fault === 'intent-scope') intent.data.scope_digest = 'b'.repeat(64);
    if (fault === 'wrong-root') scope.coordinator_session_dir = f.dir;
    if (fault === 'unknown-entry') report.type = 'not-a-native-entry';
    if (fault === 'corrupt-message') report.message.content = [{ type: 'text', text: 42 }];
    if (fault === 'marker-native') marker.data.native_id = 'wrong-native';
    if (fault === 'marker-assignment') marker.data.assignment_id = 'other';
    if (fault === 'marker-digest') marker.data.intent_digest = 'b'.repeat(64);
    if (fault === 'marker-state') marker.data.state = 'unknown';
    if (fault === 'marker-failed') marker.data.state = 'failed';
    if (fault === 'marker-intent') marker.data.intent_entry_id = report.id;
    if (fault === 'marker-report') marker.data.report_entry_id = intent.id;
    if (fault === 'missing-marker') entries.pop();
    if (fault === 'duplicate-marker') entries.push({ ...structuredClone(marker), id: 'extra-marker', parentId: marker.id });
    if (fault === 'duplicate-intent') entries.push({ ...structuredClone(intent), id: 'extra-intent', parentId: marker.id });
    if (fault === 'marker-before-prose') {
      entries = entries.filter(e => e !== marker); const index = entries.indexOf(report);
      marker.parentId = report.parentId; entries.splice(index, 0, marker); report.parentId = marker.id;
    }
    if (fault === 'intent-off-branch') marker.parentId = null;
    if (fault === 'invalid-parent-order') intent.parentId = marker.id;
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    if (fault === 'missing') fs.rmSync(file);
    if (fault === 'corrupt') fs.appendFileSync(file, '{not-json}\n');
    if (fault === 'truncated') fs.writeFileSync(file, original.subarray(0, original.length - 5));
    if (fault === 'invalid-encoding') fs.appendFileSync(file, Buffer.from([0xff]));
    if (fault === 'oversized') fs.truncateSync(file, 8 * 1024 * 1024 + 1);
    if (fault === 'outside-root') { const outside = path.join(f.dir, 'outside.jsonl'); fs.copyFileSync(file, outside); record.transcript_path = outside; }
    if (fault === 'relative-path') record.transcript_path = path.relative(process.cwd(), file);
    if (fault === 'noncanonical-path') record.transcript_path = path.dirname(file) + '/./' + path.basename(file);
    if (fault === 'symlink' || fault === 'hardlink') {
      const target = path.join(f.dir, 'target.jsonl'); fs.renameSync(file, target);
      if (fault === 'symlink') fs.symlinkSync(target, file); else fs.linkSync(target, file);
    }
    if (fault === 'directory') { fs.rmSync(file); fs.mkdirSync(file); }
    if (fault === 'aliased-root') {
      const root = f.options.sessionDir, target = path.join(f.dir, 'moved-root'); fs.renameSync(root, target); fs.symlinkSync(target, root);
    }
    const history = [record], before = structuredClone(history);
    const bytesBefore = fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : undefined;
    const recovered = api.inspectAssignment(history, record.id, scope);
    assert.equal(recovered.state, 'unknown', JSON.stringify(recovered)); assert.equal(recovered.settled, false);
    assert.equal(recovered.source, 'unresolved'); assert.equal(recovered.parent_state, 'launching'); assert.equal(recovered.parent_settled, false);
    assert.equal(recovered.report, undefined); assert.deepEqual(history, before);
    if (bytesBefore) assert.deepEqual(fs.readFileSync(file), bytesBefore, 'raw inspection never migrates/rewrites');
    assert.equal(f.requests.length, 1);
  });
}

test('SDK idle and final prose cannot produce a marker when the final authority check fails', async t => {
  let allowed = true;
  const f = await fixture(t, () => ({ text: 'Final prose with revoked authority.' }));
  f.options.onEvent = event => { if (event.type === 'agent_settled') allowed = false; };
  f.options.withPermission = async work => { assert.equal(allowed, true, 'Final authority revoked'); return work(); };
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'unknown'); assert.equal(result.settled, false);
  const entries = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(entries.some(e => e.type === 'message' && e.message.role === 'assistant'));
  assert.equal(entries.some(e => e.customType === api.SETTLEMENT_ENTRY), false);
  assert.equal(api.inspectAssignment(f.history, result.id, f.inspectionScope).state, 'unknown');
});

test('unknown error before verified SDK settlement emits no terminal marker, even after late prose', { timeout: 10000 }, async t => {
  const entered = gate(), late = gate();
  const f = await fixture(t, async () => { entered.open(); await late.promise; return { text: 'Late final prose' }; });
  const running = f.handler.run(f.options); await entered.promise;
  assert.equal(await f.handler.stop(), false); const result = await running;
  assert.equal(result.state, 'unknown'); assert.equal(result.settled, false);
  late.open(); await f.streams[0].result();
  if (fs.existsSync(result.transcript_path)) {
    const entries = fs.readFileSync(result.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.some(e => e.customType === api.SETTLEMENT_ENTRY), false);
  }
  assert.equal(api.inspectAssignment(f.history, result.id, f.inspectionScope).state, 'unknown');
});

function gate() {
  let open; const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}
function child(f, id, reads = [], writes = []) {
  return { ...f.options, id, instructions: `Execute CHILD_${id} only; return observed evidence.`,
    context: `EXPLICIT_REQUIREMENT CHILD_${id}`,
    correlation: { ...f.options.correlation, step_id: id },
    readPaths: reads.map(p => path.join(f.dir, p)), writePaths: writes.map(p => path.join(f.dir, p)) };
}
const childId = context => /CHILD_(\w+)/.exec(api.getCurrentSystemPrompt(context.messages))[1];

test('reservations before native intent reject conflicts, duplicate steps, foreign cohorts and capacity without launching', { timeout: 10000 }, async t => {
  const permission = gate(), entered = { first: gate(), second: gate() }, finish = gate();
  const f = await fixture(t, async context => { entered[childId(context)].open(); await finish.promise; return { text: 'Observed disjoint work.' }; });
  fs.writeFileSync(path.join(f.dir, 'shared.txt'), 'readable');
  fs.writeFileSync(path.join(f.dir, 'first.txt'), 'initial');
  const first = child(f, 'first', ['shared.txt'], ['first.txt']);
  const second = child(f, 'second', ['shared.txt'], ['second.txt']);
  first.withPermission = second.withPermission = async work => { await permission.promise; return work(); };
  const p1 = f.handler.run(first);
  assert.equal(f.handler.run(first), p1, 'a reserved ID awaits the original promise, including before intent exists');
  await assert.rejects(f.handler.run({ ...first, instructions: 'Different work' }), /already reserved/);
  for (const [candidate, reason] of [
    [child(f, 'ww', [], ['first.txt']), /claims conflict/],
    [child(f, 'rw', ['first.txt']), /claims conflict/],
    [child(f, 'wr', [], ['shared.txt']), /claims conflict/],
    [{ ...child(f, 'duplicate', [], ['different.txt']), correlation: { ...first.correlation } }, /Duplicate active step/],
    ...['coordinator_id', 'plan_path', 'plan_id', 'request_id'].map(key => [
      { ...child(f, 'foreign'), correlation: { ...second.correlation, [key]: key === 'plan_path' ? path.join(f.dir, 'other-plan.md') : 'foreign' } }, /Foreign-cohort/]),
    [{ ...child(f, 'missing'), correlation: { ...second.correlation, request_id: undefined } }, /canonical assignment correlation/],
  ]) await assert.rejects(f.handler.run(candidate), reason);
  const p2 = f.handler.run(second);
  await assert.rejects(f.handler.run(child(f, 'third', [], ['third.txt'])), /capacity/);
  assert.equal(f.history.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.options.sessionDir), false, 'reservation needs no native record or session directory');
  // Snapshotting happens at reservation, not when the delayed permission finally runs.
  first.writePaths.length = 0; first.correlation.request_id = 'caller-mutated';
  permission.open(); await Promise.all(Object.values(entered).map(g => g.promise));
  assert.equal(f.requests.length, 2, 'only the two admitted SDK children reached the provider');
  const intent = f.history.find(r => r.id === 'first');
  assert.equal(intent.request_id, 'fixture-run'); assert.deepEqual(intent.write_paths, [path.join(f.dir, 'first.txt')]);
  assert.equal(api.inspectAssignment(f.history, 'first').state, 'unknown', 'inspection deliberately does not pretend to be a live handle');
  finish.open(); const results = await Promise.all([p1, p2]);
  assert.ok(results.every(r => r.state === 'succeeded' && r.settled));
  assert.equal(new Set(results.map(r => r.native_id)).size, 2);
});

test('reentrant shutdown while saving intent sees the reservation and prevents SDK construction', { timeout: 10000 }, async t => {
  const f = await fixture(t); const record = f.options.record; let stopping;
  f.options.record = r => { record(r); if (r.state === 'launching') stopping = f.handler.stop(); };
  const result = await f.handler.run(f.options);
  assert.equal(result.state, 'unknown'); assert.equal(result.settled, false);
  assert.equal(await stopping, false); assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.options.sessionDir, 'agent')), false);
  assert.deepEqual(f.history.map(r => r.state), ['launching', 'unknown']);
  assert.equal((await f.handler.run(f.options)).native_id, result.native_id);
  await assert.rejects(f.handler.run(child(f, 'other')), /stopped or uncertain/);
});

test('shutdown bounds permission-wait reservations with no native record and never launches them late', { timeout: 10000 }, async t => {
  const permission = gate(); const f = await fixture(t);
  const first = child(f, 'first'), second = child(f, 'second');
  first.withPermission = second.withPermission = async work => { await permission.promise; return work(); };
  const p1 = f.handler.run(first), p2 = f.handler.run(second);
  const observed = Promise.allSettled([p1, p2]);
  assert.equal(await f.handler.stop(), false, 'unobserved permission settlement is conservative in-memory uncertainty');
  assert.ok((await observed).every(r => r.status === 'rejected'));
  permission.open(); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(f.history.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.options.sessionDir), false);
  await assert.rejects(f.handler.run(first), /stopped or uncertain/);
});

test('actual SDK disjoint children overlap, remain isolated, and completing one does not discard its peer', { timeout: 10000 }, async t => {
  const entered = { first: gate(), second: gate(), third: gate() };
  const finish = { first: gate(), second: gate(), third: gate() };
  const f = await fixture(t, async context => {
    const id = childId(context);
    if (context.messages.at(-1).role !== 'toolResult') return { tool: { name: 'write', arguments: { path: `${id}.txt`, content: `observed-${id}` } } };
    entered[id].open(); await finish[id].promise; return { text: `Observed ${id}.` };
  });
  const first = child(f, 'first', [], ['first.txt']), second = child(f, 'second', [], ['second.txt']);
  let returned = 0;
  const p1 = f.handler.run(first).then(r => { returned++; return r; });
  await entered.first.promise;
  const p2 = f.handler.run(second).then(r => { returned++; return r; });
  await entered.second.promise;
  assert.equal(returned, 0); assert.equal(f.requests.length, 4);
  for (const id of ['first', 'second']) assert.equal(fs.readFileSync(path.join(f.dir, `${id}.txt`), 'utf8'), `observed-${id}`);
  assert.ok(f.history.filter(r => r.state === 'running').length === 2);
  assert.equal(f.handler.run(second), f.handler.run(second), 'live history is not restoration and never creates another child');
  await assert.rejects(new api.Subagents().run(child(f, 'restored')), /Unsettled prior/);
  assert.equal((await new api.Subagents().run(first)).state, 'unknown');
  for (const context of f.requests) {
    const id = childId(context), other = id === 'first' ? 'second' : 'first';
    assert.doesNotMatch(JSON.stringify(context), new RegExp(`CHILD_${other}`));
    assert.deepEqual(api.getCurrentTools(context.messages).map(t => t.name).sort(), ['edit', 'read', 'write']);
  }
  finish.first.open(); assert.equal((await p1).state, 'succeeded');
  assert.equal(f.requests.length, 4, 'completion does not automatically refill');
  await assert.rejects(f.handler.run(child(f, 'conflict', [], ['second.txt'])), /claims conflict/);
  const p3 = f.handler.run(child(f, 'third', [], ['third.txt'])); await entered.third.promise;
  await assert.rejects(f.handler.run(child(f, 'fourth')), /capacity/);
  finish.second.open(); finish.third.open();
  const results = await Promise.all([p2, p3]); assert.ok(results.every(r => r.state === 'succeeded' && r.settled));
  assert.equal(f.requests.length, 6); assert.equal(new Set(f.history.map(r => r.native_id)).size, 3);
  assert.equal(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), 'Canonical plan must remain unchanged');
});

test('actual SDK read/read assignments overlap on the same effective claim with only read tools', { timeout: 10000 }, async t => {
  const entered = { first: gate(), second: gate() }, finish = gate();
  const f = await fixture(t, async context => {
    if (context.messages.at(-1).role !== 'toolResult') return { tool: { name: 'read', arguments: { path: 'shared.txt' } } };
    entered[childId(context)].open(); await finish.promise; return { text: 'Observed shared read.' };
  });
  fs.writeFileSync(path.join(f.dir, 'shared.txt'), 'shared evidence');
  const p1 = f.handler.run(child(f, 'first', ['shared.txt'])), p2 = f.handler.run(child(f, 'second', ['shared.txt']));
  await Promise.all(Object.values(entered).map(g => g.promise));
  assert.equal(f.requests.length, 4);
  for (const context of f.requests) assert.deepEqual(api.getCurrentTools(context.messages).map(t => t.name), ['read']);
  finish.open(); const results = await Promise.all([p1, p2]);
  for (const r of results) {
    assert.equal(r.state, 'succeeded'); assert.equal(r.settled, true);
    assert.deepEqual(r.read_paths, [path.join(f.dir, 'shared.txt')]); assert.deepEqual(r.write_paths, []);
  }
  assert.equal(fs.readFileSync(path.join(f.dir, 'shared.txt'), 'utf8'), 'shared evidence');
});

for (const fault of ['legacy', 'missing-correlation', 'missing-live-metadata', 'unknown', 'foreign-native', 'foreign-correlation'])
  test(`a live SDK handle never exempts historical ${fault} entries`, { timeout: 10000 }, async t => {
    const entered = gate(), finish = gate();
    const f = await fixture(t, async () => { entered.open(); await finish.promise; return { text: 'Observed first.' }; });
    const first = child(f, 'first', [], ['first.txt']); const running = f.handler.run(first); await entered.promise;
    const own = structuredClone(f.history.at(-1));
    let historical = { ...own, id: 'old', state: 'running', settled: false, native_id: 'historical-native' };
    if (fault === 'legacy') historical = { id: 'old', state: 'running', settled: false, native_id: 'old-native', transcript_path: '/old', context_digest: 'old' };
    if (fault === 'missing-correlation') {
      historical = { id: 'old', state: 'running', settled: false, native_id: 'old-native', transcript_path: '/old', context_digest: 'old', request_id: 'fixture-run' };
    }
    if (fault === 'missing-live-metadata') historical = { id: 'first', state: 'running', settled: false,
      native_id: own.native_id, transcript_path: own.transcript_path, context_digest: own.context_digest };
    if (fault === 'unknown') historical.state = 'unknown';
    if (fault === 'foreign-native') historical.id = 'first';
    if (fault === 'foreign-correlation') historical = { ...own, request_id: 'other-cohort' };
    f.history.push(historical);
    assert.equal(api.inspectAssignment(f.history, historical.id).state, 'unknown');
    await assert.rejects(f.handler.run(child(f, 'second', [], ['second.txt'])), /Unsettled prior/);
    assert.equal(f.requests.length, 1); assert.deepEqual(f.history.at(-1), historical);
    finish.open(); assert.equal((await running).state, 'succeeded');
  });

for (const source of ['caller', 'repeated-caller', 'preaborted-caller', 'shutdown']) test(`actual SDK ${source} cancellation aborts both children and joins the peer before returning`, { timeout: 10000 }, async t => {
  const entered = { first: gate(), second: gate() }, aborted = { first: gate(), second: gate() };
  const finish = { first: gate(), second: gate() }, firstTerminal = gate();
  const f = await fixture(t, async (context, signal) => {
    const id = childId(context); entered[id].open();
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted[id].open(); resolve(); }, { once: true }));
    await finish[id].promise; signal.throwIfAborted();
  });
  const record = f.options.record;
  f.options.record = r => { record(r); if (r.id === 'first' && ['cancelled', 'unknown'].includes(r.state)) firstTerminal.open(); };
  f.options.settleTimeoutMs = 2000;
  const controller = new AbortController(), first = child(f, 'first'), second = child(f, 'second');
  if (source === 'caller') first.signal = controller.signal;
  let firstReturned = false;
  const p1 = f.handler.run(first).then(r => { firstReturned = true; return r; }), p2 = f.handler.run(second);
  await Promise.all(Object.values(entered).map(g => g.promise));
  if (source === 'repeated-caller') void f.handler.run({ ...first, signal: controller.signal });
  let stopping, cancelledAdmission;
  if (source === 'preaborted-caller') {
    controller.abort();
    cancelledAdmission = assert.rejects(f.handler.run({ ...child(f, 'cancelled'), signal: controller.signal }), error => error === controller.signal.reason);
  } else if (source !== 'shutdown') controller.abort(); else stopping = f.handler.stop();
  await Promise.all(Object.values(aborted).map(g => g.promise));
  await assert.rejects(f.handler.run(child(f, 'third')), /stopped or uncertain/);
  finish.first.open(); await firstTerminal.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(firstReturned, false, 'the caller-facing first result joins the still-blocked peer');
  finish.second.open(); const results = await Promise.all([p1, p2]);
  assert.ok(results.every(r => ['cancelled', 'unknown'].includes(r.state)));
  if (cancelledAdmission) await cancelledAdmission;
  assert.equal(await (stopping ?? f.handler.stop()), results.every(r => r.settled));
  assert.equal(f.handler.stop(), f.handler.stop(), 'shutdown join is idempotent');
  assert.equal(f.requests.length, 2);
  for (const options of [first, second]) assert.equal((await f.handler.run(options)).native_id, results.find(r => r.id === options.id).native_id);
  assert.equal(f.requests.length, 2, 'no refill, retry or repeated-ID relaunch');
});

test('shutdown preserves an unresponsive SDK peer as unknown even after late provider settlement', { timeout: 10000 }, async t => {
  const entered = { first: gate(), second: gate() }, aborted = { first: gate(), second: gate() }, late = gate(); const signals = {};
  const f = await fixture(t, async (context, signal) => {
    const id = childId(context); signals[id] = signal;
    signal.addEventListener('abort', () => aborted[id].open(), { once: true }); entered[id].open();
    if (id === 'first') {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
    }
    await late.promise;
    return { tool: { name: 'write', arguments: { path: 'second.txt', content: 'must not write after stop' } } };
  });
  const first = child(f, 'first', [], ['first.txt']), second = child(f, 'second', [], ['second.txt']);
  const p1 = f.handler.run(first), p2 = f.handler.run(second);
  await Promise.all(Object.values(entered).map(g => g.promise));
  const stopped = f.handler.stop();
  await Promise.all(Object.values(aborted).map(g => g.promise));
  assert.ok(signals.first.aborted && signals.second.aborted);
  assert.equal(await stopped, false);
  const results = await Promise.all([p1, p2]);
  const unknown = results.find(r => r.id === 'second'); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.settled, false);
  const before = structuredClone(f.history);
  await assert.rejects(f.handler.run(child(f, 'third')), /stopped or uncertain/);
  assert.equal((await f.handler.run(second)).native_id, unknown.native_id);
  await assert.rejects(new api.Subagents().run(child(f, 'restored')), /Unsettled prior/);
  late.open(); await f.streams.find((_stream, i) => childId(f.requests[i]) === 'second').result();
  assert.deepEqual(f.history, before, 'late stream settlement is not observed native child settlement and cannot clear unknown');
  assert.equal(f.requests.length, 2); assert.equal(fs.existsSync(path.join(f.dir, 'second.txt')), false);
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
async function nativeToolFixture(t, respond = written, steps = [{ id: 'work', title: 'Write output', done_when: 'output.txt contains approved' }, { id: 'other', title: 'Unselected' }], options = {}) {
  const core = require('../dist/index.cjs'), f = await fixture(t, respond);
  const file = path.join(f.dir, 'plan.md');
  let plan = core.initialize({ title: 'Native delegation', steps });
  plan = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'current-run', intent: 'implement', selected_step_ids: options.selected ?? ['work'], ...(options.mode ? { execution_mode: options.mode } : {}), operations: [] })[0];
  core.saveMarkdown(file, plan);
  const tools = new Map(), entries = [], events = new Map();
  const parent = persistedCoordinator(f.dir);
  const pi = { on(name, callback) { const all = events.get(name) ?? []; all.push(callback); events.set(name, all); return () => {}; },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {}, getThinkingLevel: () => 'off',
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); parent.appendCustomEntry(customType, data); } };
  (await import(pathToFileURL(compiledExtension))).default(pi);
  const ctx = { cwd: f.dir, mode: 'json', model: f.options.model, modelRegistry: { streamSimple: (...args) => f.options.modelRuntime.streamSimple(...args) },
    sessionManager: { getSessionId: () => parent.getSessionId(), getSessionDir: () => parent.getSessionDir(),
      getSessionFile: () => parent.getSessionFile(), getEntries: () => entries, getBranch: () => entries } };
  const params = { action: 'run', assignment_id: 'native', plan_path: file, request_id: 'current-run', step_id: 'work', instructions: 'Write output.txt only', write_paths: ['output.txt'] };
  const call = (args = params, signal) => tools.get('hyperion_agent').execute('native-call', args, signal, undefined, ctx);
  return { ...f, core, file, plan, pi, parent, tools, entries, events, ctx, params, call };
}
function persistedCoordinator(cwd) {
  const parent = api.SessionManager.create(cwd, path.join(cwd, 'parent'));
  // A real coordinator executes tools after persisting its assistant tool-call turn.
  parent.appendMessage({ role: 'assistant', content: [], api: 'openai-completions', provider: 'offline-agent', model: 'scripted', timestamp: 1,
    stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return parent;
}

async function cohortFixture(t, respond, options = {}) {
  const steps = options.steps ?? [{ id: 'work', title: 'First' }, { id: 'peer', title: 'Second' }, { id: 'third', title: 'Third' }];
  return nativeToolFixture(t, respond, steps, { selected: steps.map(s => s.id), mode: 'auto', ...options });
}
const cohortArgs = (f, id, step_id = id === 'first' ? 'work' : id === 'second' ? 'peer' : 'third') => ({
  ...f.params, assignment_id: id, step_id, instructions: 'Execute CHILD_' + id, context: 'CHILD_' + id, write_paths: [id + '.txt'],
});

for (const mode of ['auto', 'parallel']) test('native ' + mode + ' current-revision starts overlap two SDK sessions and fence completion/capacity', { timeout: 10000 }, async t => {
  const entered = { first: gate(), second: gate() }, finish = gate(); t.after(finish.open);
  const f = await cohortFixture(t, async context => { entered[childId(context)].open(); await finish.promise; return { text: 'Observed native peer.' }; }, { mode });
  assert.equal(f.tools.get('hyperion_agent').executionMode, 'parallel');
  const running = [f.call(cohortArgs(f, 'first')), f.call(cohortArgs(f, 'second'))];
  await Promise.all(Object.values(entered).map(g => g.promise));
  const plan = (await f.core.loadPlanSnapshot(f.file)).plan;
  assert.equal(plan.revision, f.plan.revision + 2);
  assert.deepEqual(plan.steps.map(s => s.status), ['in_progress', 'in_progress', 'pending']);
  const intents = f.entries.filter(e => e.customType === 'hyperion.agent' && e.data.state === 'launching').map(e => e.data);
  assert.equal(intents.length, 2); assert.notEqual(intents[0].native_id, intents[1].native_id);
  assert.ok(intents.every(r => r.plan_revision >= f.plan.revision + 1 && r.plan_revision <= f.plan.revision + 2), 'native intent carries the current revision observed under its permission lock');
  const third = (await f.call(cohortArgs(f, 'third'))).details;
  assert.equal(third.state, 'rejected'); assert.match(third.limitation, /capacity/); assert.equal(third.checkpointed, false);
  await assert.rejects(f.tools.get('hyperion_plan').execute('early-completion', { action: 'checkpoint', path: f.file, plan_id: plan.plan_id,
    base_revision: plan.revision, update: JSON.stringify({ execution_request_id: 'current-run', step_id: 'work', status: 'completed', note: 'Not safe' }) }, undefined, undefined, f.ctx), /unknown writers/);
  finish.open(); const results = await Promise.allSettled(running);
  assert.ok(results.every(r => r.status === 'fulfilled' && r.value.details.state === 'succeeded'), JSON.stringify(results));
  assert.equal(f.requests.length, 2); assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.revision, plan.revision);
});

test('native start accepts a canonical sibling checkpoint after that sibling has settled', async t => {
  const f = await cohortFixture(t, () => ({ text: 'Observed quick result.' }));
  const results = await Promise.allSettled([f.call(cohortArgs(f, 'first')), f.call(cohortArgs(f, 'second'))]);
  assert.ok(results.every(r => r.status === 'fulfilled' && r.value.details.state === 'succeeded'), JSON.stringify(results));
  assert.equal(f.requests.length, 2); assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.revision, f.plan.revision + 2);
});

for (const fault of ['same-step', 'write-write', 'write-read', 'sequential', 'omitted-mode']) test('native ' + fault + ' rejects before a second checkpoint', { timeout: 10000 }, async t => {
  const entered = gate(), finish = gate(); t.after(finish.open);
  const f = await cohortFixture(t, async context => { if (childId(context) === 'first') { entered.open(); await finish.promise; } return { text: 'Observed first.' }; },
    { mode: fault === 'omitted-mode' ? undefined : fault === 'sequential' ? 'sequential' : 'auto' });
  if (fault === 'omitted-mode') {
    assert.equal(f.plan.execution.execution_mode, undefined);
    assert.equal(f.core.nextSteps(f.plan).execution_mode, 'sequential');
  }
  fs.writeFileSync(path.join(f.dir, 'first.txt'), 'initial');
  const first = f.call(cohortArgs(f, 'first')); await entered.promise;
  const second = cohortArgs(f, 'second');
  if (fault === 'same-step') second.step_id = 'work';
  if (fault === 'write-write') second.write_paths = ['first.txt'];
  if (fault === 'write-read') { second.write_paths = []; second.read_paths = ['first.txt']; }
  try {
    const rejected = (await f.call(second)).details;
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.checkpointed, false);
    assert.match(rejected.limitation, /Duplicate active step|conflict|Sequential/);
    assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.revision, f.plan.revision + 1); assert.equal(f.requests.length, 1);
  } finally { finish.open(); await first; }
  assert.equal((await first).details.state, 'succeeded');
});

for (const repeated of [false, true]) test('native simultaneous ' + (repeated ? 'same-ID joins' : 'same-step reserves once'), { timeout: 10000 }, async t => {
  const entered = gate(), finish = gate(); t.after(finish.open);
  const f = await cohortFixture(t, async () => { entered.open(); await finish.promise; return { text: 'Observed sole owner.' }; });
  const a = f.call(cohortArgs(f, 'first')), b = f.call(cohortArgs(f, repeated ? 'first' : 'second', 'work'));
  await entered.promise;
  if (!repeated) { const losing = (await Promise.race([a, b])).details; assert.equal(losing.state, 'rejected'); assert.equal(losing.checkpointed, false); }
  finish.open(); const results = await Promise.all([a, b]);
  assert.equal(results.filter(r => r.details.state === 'succeeded').length, repeated ? 2 : 1);
  if (repeated) { assert.equal(results[0].details.native_id, results[1].details.native_id); assert.equal(f.entries.filter(e => e.data.state === 'rejected').length, 0); }
  assert.equal(f.requests.length, 1); assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.revision, f.plan.revision + 1);
});

for (const fault of ['legacy', 'orphan-step', 'dependency', 'review-barrier', 'sequential-order', 'omitted-mode-order', 'request', 'paused', 'cancelled']) test('native ' + fault + ' rejects unknown or unauthorized work', async t => {
  const steps = fault === 'review-barrier' ? [{ id: 'work', title: 'First' }, { id: 'peer', title: 'Review', kind: 'review', depends_on: ['work'], checks: ['Inspect snapshot'] }, { id: 'third', title: 'Beyond' }]
    : [{ id: 'work', title: 'First' }, { id: 'peer', title: 'Second', ...(fault === 'dependency' ? { depends_on: ['work'] } : {}) }, { id: 'third', title: 'Third' }];
  const f = await cohortFixture(t, () => ({ text: 'Should not launch.' }), { steps,
    mode: fault === 'omitted-mode-order' ? undefined : fault === 'sequential-order' ? 'sequential' : 'auto' });
  let plan = f.plan, args = cohortArgs(f, 'second');
  if (fault === 'legacy') f.entries.push({ type: 'custom', customType: 'hyperion.agent', data: { id: 'old', state: 'running', settled: false, native_id: 'old', transcript_path: '/missing', context_digest: 'old' } });
  if (fault === 'orphan-step') plan = f.core.checkpoint(plan, plan.revision, 'work', 'in_progress', 'No live handle')[0];
  if (fault === 'review-barrier') args = cohortArgs(f, 'third');
  if (fault === 'request') args.request_id = 'stale-run';
  if (fault === 'paused' || fault === 'cancelled') plan = f.core.checkpoint(plan, plan.revision, undefined, undefined, undefined, undefined, fault)[0];
  if (plan !== f.plan) f.core.saveMarkdown(f.file, plan);
  const before = [f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8'));
  const result = (await f.call(args)).details;
  assert.equal(result.state, 'rejected', JSON.stringify(result)); assert.equal(result.checkpointed, false); assert.equal(f.requests.length, 0);
  assert.deepEqual([f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8')), before);
});

for (const mode of [undefined, 'sequential']) test('native ' + (mode ?? 'omitted-mode') + ' exclusive reservation independently prevents SDK overlap', { timeout: 10000 }, async t => {
  const entered = gate(), finish = gate(); t.after(finish.open);
  const f = await cohortFixture(t, async context => {
    if (childId(context) === 'first') { entered.open(); await finish.promise; }
    return { text: 'Observed sequential child.' };
  }, { mode });
  assert.equal(f.plan.execution.execution_mode, mode);
  assert.equal(f.core.nextSteps(f.plan).execution_mode, 'sequential');
  const first = f.call(cohortArgs(f, 'first')); await entered.promise;
  const started = (await f.core.loadPlanSnapshot(f.file)).plan;
  // Deliberately bypass native completion fencing in this disposable fixture so
  // plan order passes. The independent reservation gate must still reject peers.
  const injected = f.core.checkpoint(started, started.revision, 'work', 'completed', 'Test-only order-gate bypass')[0];
  f.core.saveMarkdown(f.file, injected);
  const before = [f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8'));
  try {
    const rejected = (await f.call(cohortArgs(f, 'second'))).details;
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.checkpointed, false);
    assert.match(rejected.limitation, /exclusive admission/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual([f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8')), before);
  } finally {
    // Restore the active checkpoint and drain the real child even on failure.
    f.core.saveMarkdown(f.file, started); finish.open(); await first;
  }
  assert.equal((await first).details.state, 'succeeded');
  await f.tools.get('hyperion_plan').execute('sequential-completion', { action: 'checkpoint', path: f.file, plan_id: started.plan_id,
    base_revision: started.revision, update: JSON.stringify({ execution_request_id: 'current-run', step_id: 'work', status: 'completed', note: 'Observed settled first child' }) }, undefined, undefined, f.ctx);
  const second = (await f.call({ ...cohortArgs(f, 'second'), assignment_id: 'after-first' })).details;
  assert.equal(second.state, 'succeeded'); assert.equal(f.requests.length, 2);
  assert.deepEqual((await f.core.loadPlanSnapshot(f.file)).plan.steps.map(s => s.status), ['completed', 'in_progress', 'pending']);
});

test('native caller cancellation joins both admitted SDK peers', { timeout: 10000 }, async t => {
  const entered = { first: gate(), second: gate() }, aborted = { first: gate(), second: gate() }, finish = gate(); t.after(finish.open);
  const f = await cohortFixture(t, async (context, signal) => {
    const id = childId(context); entered[id].open(); signal.addEventListener('abort', () => aborted[id].open(), { once: true });
    await aborted[id].promise; await finish.promise; signal.throwIfAborted();
  });
  const controller = new AbortController(); const running = [f.call(cohortArgs(f, 'first'), controller.signal), f.call(cohortArgs(f, 'second'))];
  await Promise.all(Object.values(entered).map(g => g.promise)); controller.abort(); await Promise.all(Object.values(aborted).map(g => g.promise));
  let returned = false; void running[0].then(() => { returned = true; }); await Promise.resolve(); assert.equal(returned, false);
  finish.open(); const results = await Promise.all(running);
  assert.ok(results.every(r => r.details.settled && r.details.state === 'cancelled'), JSON.stringify(results));
  assert.deepEqual((await f.core.loadPlanSnapshot(f.file)).plan.steps.map(s => s.status), ['in_progress', 'in_progress', 'pending']);
});

test('native completion is fenced during the pre-record reservation gap', { timeout: 10000 }, async t => {
  const entered = gate(), finish = gate(); t.after(finish.open);
  const f = await nativeToolFixture(t, async () => { entered.open(); await finish.promise; return { text: 'Observed bounded result.' }; });
  let attempted, beforeIntent;
  f.pi.getThinkingLevel = () => {
    beforeIntent = f.entries.filter(e => e.customType === 'hyperion.agent').length;
    const plan = f.core.loadMarkdown(f.file)[0];
    attempted = f.tools.get('hyperion_plan').execute('gap-completion', { action: 'checkpoint', path: f.file, plan_id: plan.plan_id,
      base_revision: plan.revision, update: JSON.stringify({ execution_request_id: 'current-run', step_id: 'work', status: 'completed', note: 'Cannot integrate yet' }) }, undefined, undefined, f.ctx);
    void attempted.catch(() => {}); return 'off';
  };
  const running = f.call(); await entered.promise;
  assert.equal(beforeIntent, 0); await assert.rejects(attempted, /live or unknown writers/);
  finish.open(); const result = (await running).details;
  assert.equal(result.state, 'succeeded'); assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.steps[0].status, 'in_progress');
});

for (const fault of ['scope', 'request', 'owner', 'paused', 'cancelled']) test('native prelaunch ' + fault + ' change is not overwritten or launched', async t => {
  const f = await nativeToolFixture(t, () => ({ text: 'Should not launch.' }));
  let calls = 0, changed;
  const actor = f.ctx.sessionManager.getSessionId();
  f.ctx.sessionManager.getSessionId = () => {
    if (++calls === 3) {
      let plan = f.core.loadMarkdown(f.file)[0];
      if (fault === 'scope') { const replacement = f.core.clone(plan); replacement.steps[0].description = 'Changed scope'; plan = f.core.revise(plan, replacement, plan.revision); }
      if (fault === 'request') plan = f.core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: 'new-run', intent: 'implement', selected_step_ids: ['work'], operations: [] })[0];
      if (fault === 'owner') plan = { ...plan, execution_owner: 'other-owner' };
      if (fault === 'paused' || fault === 'cancelled') plan = f.core.checkpoint(plan, plan.revision, undefined, undefined, undefined, undefined, fault)[0];
      f.core.saveMarkdown(f.file, plan);
      changed = [f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8'));
    }
    return actor;
  };
  const result = (await f.call()).details;
  assert.equal(result.state, 'rejected'); assert.equal(result.checkpointed, false); assert.equal(f.requests.length, 0);
  assert.deepEqual([f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p, 'utf8')), changed);
});

test('native parent terminal-save failure leaves recoverable child evidence and a restored unresolved fence', async t => {
  const f = await nativeToolFixture(t, () => ({ text: 'Observed result survived parent save failure.' }));
  const append = f.pi.appendEntry; let failedSave = false, nativeId, nativePath;
  f.pi.appendEntry = (type, data) => {
    if (type === 'hyperion.agent' && data.state === 'succeeded') {
      const entries = fs.readFileSync(data.transcript_path, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(entries.at(-1).customType, api.SETTLEMENT_ENTRY, 'child persistence precedes parent terminal save');
      assert.equal(entries.at(-1).data.state, 'succeeded');
      assert.equal(entries.at(-1).data.native_id, data.native_id);
      nativeId = data.native_id; nativePath = data.transcript_path; failedSave = true;
      throw Error('Simulated parent terminal save failure');
    }
    append(type, data);
  };
  const returned = (await f.call()).details;
  assert.equal(failedSave, true); assert.equal(returned.state, 'unknown'); assert.equal(returned.settled, false);
  assert.equal(f.entries.at(-1).data.state, 'unknown');
  const beforeParent = fs.readFileSync(f.parent.getSessionFile()), beforeChild = fs.readFileSync(nativePath);
  const beforeEntries = structuredClone(f.entries), beforePlan = [f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p));
  // Same original coordinator, but no restored live handle. Inspection must not adopt/reconstruct one.
  f.ctx.sessionManager = { ...f.ctx.sessionManager };
  const recovered = (await f.call({ action: 'inspect', assignment_id: 'native', plan_path: f.file, request_id: 'current-run' })).details;
  assert.equal(recovered.state, 'succeeded'); assert.equal(recovered.settled, true); assert.equal(recovered.source, 'child-session');
  assert.equal(recovered.parent_state, 'unknown'); assert.equal(recovered.parent_settled, false);
  assert.equal(recovered.report, 'Observed result survived parent save failure.');
  assert.equal(recovered.native_id, nativeId); assert.equal(recovered.transcript_path, nativePath);
  assert.throws(() => api.assertAgentIdle(f.ctx), /unknown writers/);
  const plan = (await f.core.loadPlanSnapshot(f.file)).plan;
  await assert.rejects(f.tools.get('hyperion_plan').execute('not-reconciled', { action: 'checkpoint', path: f.file, plan_id: plan.plan_id,
    base_revision: plan.revision, update: JSON.stringify({ execution_request_id: 'current-run', step_id: 'work', status: 'completed', note: 'Recovered report is not reconciliation' }) },
    undefined, undefined, f.ctx), /live or unknown writers|unknown writers/);
  assert.deepEqual(f.entries, beforeEntries); assert.deepEqual(fs.readFileSync(f.parent.getSessionFile()), beforeParent);
  assert.deepEqual(fs.readFileSync(nativePath), beforeChild);
  assert.deepEqual([f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p)), beforePlan); assert.equal(f.requests.length, 1);
  assert.equal((await f.call()).details.source, 'child-session', 'repeated run only inspects; it never reconciles/relaunches');
  assert.equal(f.requests.length, 1);
});

test('native optional group inspect reads the current canonical cohort, with no launch or lifecycle writes', async t => {
  const f = await cohortFixture(t, context => childId(context) === 'second'
    ? (context.messages.at(-1).role === 'toolResult' ? { text: 'Observed failed tool.' }
      : { tool: { name: 'read', arguments: { path: 'unassigned.txt' } } }) : { text: 'Observed success.' });
  assert.equal((await f.call(cohortArgs(f, 'first'))).details.state, 'succeeded');
  assert.equal((await f.call(cohortArgs(f, 'second'))).details.state, 'failed');
  const rejected = await f.call({ ...cohortArgs(f, 'third'), write_paths: [path.join(path.dirname(f.dir), 'external.txt')] });
  assert.equal(rejected.details.state, 'rejected');
  // Model a lost parent terminal record on both children, without touching their native files.
  const lost = f.entries.filter(e => e.customType === 'hyperion.agent' && ['succeeded', 'failed'].includes(e.data.state));
  for (const entry of lost) f.entries.splice(f.entries.indexOf(entry), 1);
  const intent = f.entries.find(e => e.customType === 'hyperion.agent' && e.data.state === 'launching').data;
  f.pi.appendEntry('hyperion.agent', { ...intent, id: 'pending', state: 'unknown', settled: false, native_id: 'missing-native',
    transcript_path: path.join(path.dirname(intent.transcript_path), 'missing.jsonl') });
  const before = structuredClone(f.entries), parentBefore = fs.readFileSync(f.parent.getSessionFile());
  const planBefore = [f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p));
  const inspected = (await f.call({ action: 'inspect', plan_path: f.file, request_id: 'current-run' })).details;
  assert.deepEqual(inspected.outcomes, { settled: 1, failed: 1, rejected: 1, unresolved: 1 });
  assert.equal(inspected.read_only, true); assert.equal(inspected.coordinator_id, f.parent.getSessionId());
  for (const r of inspected.assignments.filter(r => r.source === 'child-session')) assert.equal(r.parent_settled, false);
  assert.throws(() => api.assertAgentIdle(f.ctx), /unknown writers/);
  assert.deepEqual(f.entries, before); assert.deepEqual(fs.readFileSync(f.parent.getSessionFile()), parentBefore);
  assert.deepEqual([f.file, f.core.markdownStatePath(f.file)].map(p => fs.readFileSync(p)), planBefore); assert.equal(f.requests.length, 3);
  await assert.rejects(f.call({ action: 'inspect', plan_path: f.file, request_id: 'wrong-request' }), /current canonical request/);
  await assert.rejects(f.call({ action: 'inspect' }), /Group inspection needs/);
  await assert.rejects(f.call({ action: 'run', plan_path: f.file, request_id: 'current-run' }), /assignment_id/);
  const other = f.ctx.sessionManager.getSessionId; f.ctx.sessionManager.getSessionId = () => 'other-coordinator';
  const foreign = (await f.call({ action: 'inspect', assignment_id: 'first', plan_path: f.file, request_id: 'current-run' })).details;
  assert.equal(foreign.state, 'unknown'); assert.equal(foreign.source, 'unresolved'); assert.equal(foreign.parent_settled, false);
  f.ctx.sessionManager.getSessionId = other;
  assert.deepEqual(f.entries, before); assert.equal(f.requests.length, 3);
});

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

test('native intent and canonical claims are durable in the coordinator session before child prompting', async t => {
  const f = await nativeToolFixture(t, () => {
    const persisted = fs.readFileSync(parent.getSessionFile(), 'utf8').trim().split('\n').map(JSON.parse);
    const intent = persisted.find(e => e.type === 'custom' && e.customType === 'hyperion.agent').data;
    assert.equal(intent.state, 'launching'); assert.equal(intent.settled, false);
    assert.equal(intent.coordinator_id, parent.getSessionId()); assert.equal(intent.workspace, f.dir);
    assert.equal(intent.plan_id, f.plan.plan_id); assert.equal(intent.plan_path, f.file);
    assert.equal(intent.request_id, 'current-run'); assert.equal(intent.step_id, 'work');
    assert.deepEqual(intent.read_paths, [path.join(f.dir, 'input.txt'), path.join(f.dir, 'output.txt')]);
    assert.deepEqual(intent.write_paths, [path.join(f.dir, 'output.txt')]);
    assert.equal(intent.checkpointed, true); assert.equal(intent.plan_revision, f.plan.revision + 1);
    // SDK defers the child's file until an assistant entry; parent intent must already be on disk.
    assert.equal(fs.existsSync(intent.transcript_path), false);
    return { text: 'Inspected exact dispatch metadata.' };
  });
  const parent = f.parent;
  f.ctx.sessionManager = parent;
  f.pi.appendEntry = (customType, data) => { f.entries.push({ type: 'custom', customType, data }); parent.appendCustomEntry(customType, data); };
  fs.writeFileSync(path.join(f.dir, 'input.txt'), 'input');
  fs.symlinkSync(path.join(f.dir, 'input.txt'), path.join(f.dir, 'input-alias.txt'));
  const result = (await f.call({ ...f.params, read_paths: ['input-alias.txt', './input.txt', 'output.txt'], write_paths: ['./output.txt', 'output.txt'] })).details;
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  const child = api.SessionManager.open(result.transcript_path);
  assert.equal(child.getSessionId(), result.native_id);
  const childIntent = child.getEntries().find(e => e.type === 'custom' && e.customType === 'hyperion.agent').data;
  for (const key of ['coordinator_id', 'plan_path', 'plan_id', 'request_id', 'step_id', 'scope_digest', 'workspace', 'read_paths', 'write_paths', 'native_id', 'transcript_path'])
    assert.deepEqual(childIntent[key], result[key], key);
  const restoredParent = api.SessionManager.open(parent.getSessionFile());
  f.ctx.sessionManager = restoredParent;
  const inspected = (await f.call({ action: 'inspect', assignment_id: 'native' })).details;
  assert.equal(inspected.native_id, result.native_id); assert.deepEqual(inspected.read_paths, result.read_paths);
  const before = fs.readFileSync(parent.getSessionFile(), 'utf8');
  assert.deepEqual((await f.call()).details, inspected, 'restored native history never prompts again');
  assert.equal(f.requests.length, 1); assert.equal(fs.readFileSync(parent.getSessionFile(), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.dir, 'output.txt')), false);
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

test('agent ownership is scoped to its actual coordinator/request, not legacy plan ownership', async t => {
  const f = await nativeToolFixture(t, () => ({ text: 'Scoped result.' }));
  f.core.saveMarkdown(f.file, { ...f.plan, execution_owner: 'old-session' });
  const result = (await f.call()).details;
  assert.equal(result.state, 'succeeded');
  assert.equal(result.coordinator_id, f.ctx.sessionManager.getSessionId());
  assert.equal(result.request_id, 'current-run');
  assert.equal((await f.core.loadPlanSnapshot(f.file)).plan.execution_owner, undefined);
  assert.equal(f.requests.length, 1);
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

for (const fault of ['external', 'missing', 'protected', 'wrong-request', 'unselected', 'model', 'paused', 'aborted', 'ephemeral', 'unpersisted']) test(`dispatch ${fault} rejection precedes model setup and start checkpoint`, async t => {
  const f = await nativeToolFixture(t);
  let args = { ...f.params, write_paths: [] }, signal;
  let code = 'dispatch_rejected';
  if (fault === 'external') { args.read_paths = [path.join(path.dirname(f.dir), 'outside-assignment.txt')]; code = 'outside_workspace'; }
  if (fault === 'missing') { args.read_paths = ['missing.txt']; code = 'missing_read_path'; }
  if (fault === 'protected') { args.read_paths = ['plan.md']; code = 'protected_path'; }
  if (fault === 'wrong-request') args.request_id = 'not-current';
  if (fault === 'unselected') args.step_id = 'other';
  if (fault === 'model') f.ctx.model = undefined;
  if (fault === 'ephemeral') f.ctx.sessionManager.getSessionFile = () => undefined;
  if (fault === 'unpersisted') f.ctx.sessionManager.getSessionFile = () => path.join(f.dir, 'not-yet-persisted.jsonl');
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
  const actor = f.ctx.sessionManager.getSessionId();
  f.ctx.sessionManager.getSessionId = () => {
    if (++calls === 3) {
      changed = fs.readFileSync(file, 'utf8') + '\n';
      fs.writeFileSync(file, changed);
    }
    return actor;
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

test('independent plan review uses the read-only SDK fallback and coordinator records the returned identity', async t => {
  const entered = gate(), finish = gate(); t.after(finish.open);
  const f = await nativeToolFixture(t, async context => {
    if (context.messages.at(-1).role !== 'toolResult') return { tool: { name: 'read', arguments: { path: 'input.txt' } } };
    entered.open(); await finish.promise;
    return { text: 'Reviewed the captured plan and input; runtime checks unavailable.' };
  });
  const independent = f.core.applyRequest(f.plan, { plan_id: f.plan.plan_id, base_revision: f.plan.revision,
    request_id: 'independent-review', intent: 'review', review_mode: 'independent', target_step_ids: ['work'], operations: [] })[0];
  f.core.saveMarkdown(f.file, independent);
  fs.writeFileSync(path.join(f.dir, 'input.txt'), 'captured review input');
  const args = { ...f.params, request_id: 'independent-review', assignment_id: 'independent-review-plan',
    instructions: 'Review the captured plan; return findings only.', context: 'Original requirement: bounded execution.',
    read_paths: ['input.txt'], write_paths: [] };
  delete args.step_id;
  const rejected = (await f.call({ ...args, assignment_id: 'independent-review-writes', write_paths: ['output.txt'] })).details;
  assert.equal(rejected.state, 'rejected'); assert.match(rejected.limitation, /Reviews have no write permissions/);
  assert.equal(f.requests.length, 0);
  const running = f.call(args);
  await entered.promise;
  const during = (await f.core.loadPlanSnapshot(f.file)).plan;
  assert.equal(during.revision, independent.revision);
  assert.equal(during.plan_reviews[0].state, 'requested');
  assert.equal(during.plan_reviews[0].task_id, undefined, 'foreground gate requires an unassigned canonical request');
  assert.deepEqual(during.steps.map(s => s.status), ['pending', 'pending']);
  finish.open(); const reviewed = (await running).details;
  assert.equal(reviewed.state, 'succeeded'); assert.equal(reviewed.settled, true);
  assert.equal(reviewed.checkpointed, false);
  assert.deepEqual(api.getCurrentTools(f.requests[0].messages).map(t => t.name), ['read']);
  assert.equal((await f.call(args)).details.native_id, reviewed.native_id, 'retry inspects the original reviewer');
  assert.equal(f.requests.length, 2, 'one reviewer made two provider turns; retry did not launch another');
  const reportPath = path.join(f.dir, 'plan-review-report.md');
  fs.writeFileSync(reportPath, reviewed.report); // The coordinator, not the read-only child, preserves the report.
  const result = await f.tools.get('hyperion_plan').execute('record-review', { action: 'plan-review', path: f.file,
    plan_id: independent.plan_id, base_revision: reviewed.plan_revision,
    update: JSON.stringify({ request_id: 'independent-review', state: 'completed', task_id: reviewed.native_id,
      report_path: reportPath, findings: [], note: 'Coordinator inspected captured-plan report; runtime checks unavailable.' })
  }, undefined, undefined, f.ctx);
  const after = result.details.plan;
  assert.equal(after.plan_reviews[0].state, 'completed');
  assert.equal(after.plan_reviews[0].task_id, reviewed.native_id);
  assert.equal(after.plan_reviews[0].revision, independent.revision);
  assert.equal(after.plan_reviews[0].report_path, reportPath);
  assert.deepEqual(after.steps.map(s => s.status), ['pending', 'pending'], 'review grants no implementation progress');
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

for (const state of ['launching', 'running', 'unknown']) test(`restored unfinished legacy ${state} holds new work; rejection and inspection never clear unknown writers`, async t => {
  const f = await fixture(t); const event = { id: 'old', state, native_id: 'native-old', transcript_path: '/missing', context_digest: 'old', settled: false };
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
} else if (process.argv[2] !== '--offline-codemode-fixture') {
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

const pi103Directory = process.env.HYPERION_PI_103_DIR ?? path.join(os.homedir(), '.pi/agent/install/releases/1.0.3/node_modules/@earendil-works/pi-coding-agent');
if (process.argv[2] === '--offline-codemode-fixture') {
  runCodemodeFixture(process.argv[3], process.argv[4], process.argv[5]).catch(error => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] !== '--offline-proxy-fixture') {
  for (const scenario of ['overlap', 'partial-rejection', 'cancel', 'restore']) test('isolated Pi 1.0.3 actual Codemode nested fork/join: ' + scenario,
    { timeout: 45000, skip: !fs.existsSync(path.join(pi103Directory, 'dist/index.js')) && 'Pi 1.0.3 not installed; set HYPERION_PI_103_DIR' }, t => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-codemode-')));
      fs.mkdirSync(path.join(dir, 'home'));
      const result = spawnSync(process.execPath, [__filename, '--offline-codemode-fixture', scenario, dir, pi103Directory], {
        env: { HOME: path.join(dir, 'home'), PATH: process.env.PATH, PI_CODING_AGENT_DIR: path.join(dir, 'agent') },
        encoding: 'utf8', timeout: 40000,
      });
      if (result.status === 0) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      else t.diagnostic('Codemode regression artifacts: ' + dir);
      assert.equal(result.status, 0, String(result.error ?? '') + '\n' + result.stdout + '\n' + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.sdk_version, '1.0.3'); assert.equal(report.networkAttempts, 0);
      assert.equal(report.nested_calls, 2); assert.equal(report.restored, scenario === 'restore');
      if (scenario !== 'partial-rejection') assert.equal(report.max_active, 2);
    });
}

async function runCodemodeFixture(scenario, dir, sdkDirectory) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(sdkDirectory, 'package.json'))).version, '1.0.3');
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden'); };
  require('node:net').Socket.prototype.connect = function () { networkAttempts++; throw new Error('Network forbidden'); };
  const sdkPath = path.join(sdkDirectory, 'dist/index.js'), aiPath = path.resolve(sdkDirectory, '../pi-ai/dist/index.js');
  const modulePath = path.join(dir, 'codemode-fixture.mjs');
  await require('esbuild').build({ entryPoints: [path.join(root, 'tests/pi/fixture.ts')], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
    plugins: [{ name: 'isolated-public-sdk-103', setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: sdkPath, external: true }));
      build.onResolve({ filter: /pi-ai\/dist\/index.js$/ }, () => ({ path: aiPath, external: true }));
      build.onResolve({ filter: /dist\/index.cjs$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), external: true }));
      build.onResolve({ filter: /^(proper-lockfile|typebox|entities)$/ }, args => ({ path: require.resolve(args.path, { paths: [root] }), external: true }));
    } }],
  });
  const sdk = await import(pathToFileURL(sdkPath)), fixture = await import(pathToFileURL(modulePath));
  const report = await fixture.codemodeFixture(sdk, dir, scenario);
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({ ...report, networkAttempts }));
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
