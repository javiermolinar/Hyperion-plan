// Component tests only. No createAgentSession, providers, SDK workers or handovers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/index.cjs');
const api = import('../dist/pi-runner.js');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
async function fixture(t, mode = 'auto', steps) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-wave-component-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = { dir, api: await api, events: [], authority: { currentRunAuthorized: true, implementationAllowed: true, actorId: 'component-coordinator', requestId: 'component-run' } };
  f.plan = core.initialize({ title: 'Wave component fixture', steps: steps ?? ['a','b','c'].map(id => ({ id, title: id, status: 'pending', done_when: 'Observed acceptance evidence' })) });
  f.plan = core.applyRequest(f.plan, { plan_id: f.plan.plan_id, base_revision: f.plan.revision, request_id: 'component-run', intent: 'implement', operations: [], selected_step_ids: f.plan.steps.map(s=>s.id), execution_mode: mode })[0];
  f.candidates = f.plan.steps.map(s => ({ assignment: { schema_version: 1, assignment_id: `component-${s.id}`, plan_id: f.plan.plan_id,
    plan_path: path.join(dir, 'plan.md'), approved_request_id: 'component-run', step_id: s.id, scope_digest: core.stepFingerprint(s).scope,
    owner: { host: 'pi', native_id: 'component-coordinator' }, role: 'implementation', cwd: dir, owned_paths: [path.join(dir, `${s.id}.txt`)],
    acceptance: ['Observed acceptance evidence'], evidence_directory: path.join(dir, `evidence-${s.id}`), reasoning_effort: s.reasoning_effort ?? 'inherit' },
    attempt_id: `attempt-${s.id}`, read_paths: [], resources: [], independence_evidence: ['Fixture has disjoint files and no shared resources'] }));
  f.select = (candidates = f.candidates, capacity = 2) => f.api.selectPiWave(f.plan, candidates, f.authority, capacity);
  f.record = (candidate, outcome = 'succeeded') => ({ schema_version: 1, assignment: structuredClone(candidate.assignment), attempt_id: candidate.attempt_id,
    phase: outcome === 'succeeded' ? 'settled' : 'failed', history: [], tools: [], model: { provider: 'none', id: 'component', thinking_level: 'off' },
    resources_digest: 'component', events_path: 'component-only', result_path: 'component-only',
    handle: { assignment_id: candidate.assignment.assignment_id, session: { host: 'pi', native_id: `NOT-A-SESSION-${candidate.assignment.step_id}` }, transcript_path: 'no-transcript' },
    result: { assignment_id: candidate.assignment.assignment_id, session: { host: 'pi', native_id: `NOT-A-SESSION-${candidate.assignment.step_id}` }, outcome,
      changed_paths: [], evidence: ['Synthetic component outcome, not runtime verification'], quiescence: { state: 'verified', evidence: ['Fixture promise resolved; no actual worker exists'] } } });
  f.host = {
    snapshot: async () => ({ plan: structuredClone(f.plan), refresh_required: false }), authority: () => f.authority,
    reserve: async selection => { f.events.push('reserve'); f.reserved = selection; },
    checkpointStart: async candidate => { f.events.push(`checkpoint:${candidate.assignment.step_id}`); f.plan = core.checkpoint(f.plan, f.plan.revision, candidate.assignment.step_id, 'in_progress', 'Component fixture start')[0]; },
    launch: async candidate => { f.events.push(`launch:${candidate.assignment.step_id}`); return f.record(candidate); },
  };
  return f;
}

test('component selection is bounded to two, ordered, copy-safe and write-free', async t => {
  const f = await fixture(t), before = structuredClone(f.plan);
  const selected = f.select([...f.candidates].reverse());
  assert.equal(selected.mode, 'parallel'); assert.deepEqual(selected.selected.map(c=>c.assignment.step_id), ['a','b']);
  assert.deepEqual(selected.deferred.map(c=>c.step_id), ['c']); assert.deepEqual(f.plan, before);
  selected.selected[0].assignment.owned_paths.push('changed copy'); assert.equal(f.candidates[0].assignment.owned_paths.length, 1);
  assert.throws(()=>f.select(f.candidates,3), /one or two/);
});
for (const mode of ['sequential', undefined]) test(`component honours ${mode ?? 'legacy'} sequential scope and order`, async t => {
  const f = await fixture(t, 'sequential'); if (mode === undefined) delete f.plan.execution.execution_mode;
  assert.equal(f.select().mode, 'sequential'); assert.equal(f.select().selected.length, 1);
  assert.match(f.select().reason, /sequential/); assert.throws(()=>f.select([f.candidates[1]]), /plan order/);
});
for (const conflict of ['write-write','write-read','resource','ancestor','case','symlink']) test(`component defers ${conflict} conflicts`, async t => {
  const f = await fixture(t), [a,b] = f.candidates;
  if (conflict === 'write-write') b.assignment.owned_paths = [...a.assignment.owned_paths];
  if (conflict === 'write-read') b.read_paths = [...a.assignment.owned_paths];
  if (conflict === 'resource') { a.resources = ['generated:api']; b.resources = ['generated:api']; }
  if (conflict === 'ancestor') b.assignment.owned_paths = [path.join(a.assignment.owned_paths[0], 'child')];
  if (conflict === 'case') b.assignment.owned_paths = [a.assignment.owned_paths[0].replace('a.txt', 'A.txt')];
  if (conflict === 'symlink') { fs.writeFileSync(a.assignment.owned_paths[0], 'fixture'); const alias=path.join(f.dir,'alias'); fs.symlinkSync(a.assignment.owned_paths[0],alias); b.read_paths=[alias]; }
  const result = f.select([a,b]); assert.equal(result.mode, 'sequential'); assert.match(result.deferred[0].reason, /Shared/);
});
test('component permits shared read-only inputs but needs an explicit independence assessment', async t => {
  const f = await fixture(t), [a,b] = f.candidates;
  a.read_paths = b.read_paths = [path.join(f.dir, 'shared-input')]; assert.equal(f.select([a,b]).mode, 'parallel');
  b.independence_evidence=[]; assert.equal(f.select([a,b]).mode, 'sequential'); assert.match(f.select([a,b]).reason, /assessment/);
});
for (const fault of ['unselected','paused','owner','request','scope','effort','started','duplicate','no-authority']) test(`component rejects ${fault} candidates`, async t => {
  const f = await fixture(t);
  if (fault === 'unselected') f.plan.execution.selected_step_ids=['a'];
  if (fault === 'paused') f.plan.execution.state='paused';
  if (fault === 'owner') f.authority.actorId='other';
  if (fault === 'request') f.authority.requestId='other';
  if (fault === 'scope') f.candidates[0].assignment.scope_digest='other';
  if (fault === 'effort') f.candidates[0].assignment.reasoning_effort='high';
  if (fault === 'started') f.plan=core.checkpoint(f.plan,f.plan.revision,'a','in_progress','Existing work')[0];
  if (fault === 'duplicate') f.candidates.push(structuredClone(f.candidates[0]));
  if (fault === 'no-authority') f.authority.currentRunAuthorized=false;
  assert.throws(()=>f.select()); assert.deepEqual(f.events,[]);
});
test('component rejects unfinished prerequisites and cannot cross a selected review barrier', async t => {
  const f = await fixture(t, 'auto', [{id:'a',title:'a',status:'pending'}, {id:'b',title:'b',status:'pending',depends_on:['a']}]);
  assert.throws(()=>f.select(), /prerequisite/i);
  const g = await fixture(t, 'auto', [{id:'a',title:'a',status:'pending'}, {id:'review',title:'review',status:'pending',kind:'review',depends_on:['a'],checks:['Inspect a']}, {id:'c',title:'c',status:'pending'}]);
  assert.throws(()=>g.select([g.candidates[2]]), /barrier/i);
  assert.throws(()=>g.select([g.candidates[1]]));
});

test('component overlaps only two synthetic promises, never refills, and leaves completion to coordinator', async t => {
  const f=await fixture(t), ready=deferred(), release=deferred(); let active=0, peak=0;
  f.host.launch=async candidate=> { f.events.push(`launch:${candidate.assignment.step_id}`); peak=Math.max(peak,++active); if(active===2) ready.resolve(); await release.promise; active--; return f.record(candidate); };
  const pool=new f.api.PiWaveCoordinator(f.host), running=pool.run(f.candidates); await ready.promise;
  assert.equal(active,2); assert.deepEqual(f.events,['reserve','checkpoint:a','launch:a','checkpoint:b','launch:b']);
  release.resolve(); const result=await running;
  assert.equal(peak,2); assert.equal(result.results.length,2); assert.equal(result.acceptance_verified,false); assert.equal(result.quiescence.state,'verified');
  assert.deepEqual(f.plan.steps.map(s=>s.status),['in_progress','in_progress','pending']);
  await assert.rejects(pool.run(f.candidates), /already used/);
});
test('component joins a slow peer after rejection rather than returning at first failure', async t => {
  const f=await fixture(t), ready=deferred(), rejectFirst=deferred(), releasePeer=deferred(); let count=0, peerAborted=false, returned=false;
  f.host.launch=async(candidate,signal)=> { if(++count===2) ready.resolve(); if(candidate.assignment.step_id==='a') { await rejectFirst.promise; throw Error('fixture rejection'); }
    signal.addEventListener('abort',()=>{peerAborted=true;}); await releasePeer.promise; return f.record(candidate,'cancelled'); };
  const running=new f.api.PiWaveCoordinator(f.host).run(f.candidates).then(r=>{returned=true; return r;});
  await ready.promise; rejectFirst.resolve(); await new Promise(r=>setImmediate(r));
  assert.equal(peerAborted,true); assert.equal(returned,false);
  releasePeer.resolve(); const result=await running; assert.equal(result.results.length,2); assert.equal(result.quiescence.state,'unknown'); assert.match(result.stop_reason,/rejected/);
});
for (const fault of ['scope','owner','sequential','missing-checkpoint']) test(`component rechecks ${fault} between checkpoint and launch`, async t => {
  const f=await fixture(t), checkpoint=f.host.checkpointStart;
  f.host.checkpointStart=async c=> { if(fault!=='missing-checkpoint') await checkpoint(c); if(fault==='scope') f.plan.steps[0].title='Changed';
    if(fault==='owner') f.authority.actorId='other'; if(fault==='sequential') f.plan.execution.execution_mode='sequential'; };
  const result=await new f.api.PiWaveCoordinator(f.host).run(f.candidates);
  assert.equal(result.results.length,0); assert.deepEqual(result.not_started,['a','b']); assert.ok(result.stop_reason); assert.ok(!f.events.some(e=>e.startsWith('launch:')));
});
for (const value of [undefined, 'wrong-identity', 'unknown-writers', 'wrong-outcome']) test(`component treats malformed result ${value} as unknown`, async t => {
  const f=await fixture(t);
  f.host.launch=async c=> { if(value===undefined) return undefined; const r=f.record(c);
    if(value==='wrong-identity') r.handle.session.native_id='mismatch';
    if(value==='unknown-writers') r.result.quiescence={state:'unknown',reason:'fixture'};
    if(value==='wrong-outcome') r.result.outcome='cancelled'; return r; };
  const result=await new f.api.PiWaveCoordinator(f.host).run([f.candidates[0]]);
  assert.equal(result.quiescence.state,'unknown'); assert.ok(result.results[0].error); assert.equal(result.acceptance_verified,false);
});
test('component cancellation joins both synthetic promises and never checkpoints completion', async t => {
  const f=await fixture(t), ready=deferred(), release=deferred(), abort=new AbortController(); let count=0, cancelled=0;
  f.host.launch=async(c,signal)=> { signal.addEventListener('abort',()=>cancelled++); if(++count===2) ready.resolve(); await release.promise; return f.record(c,'cancelled'); };
  const running=new f.api.PiWaveCoordinator(f.host).run(f.candidates,2,abort.signal); await ready.promise; abort.abort();
  assert.equal(cancelled,2); release.resolve(); const result=await running;
  assert.equal(result.quiescence.state,'verified'); assert.match(result.stop_reason,/cancelled/); assert.equal(result.acceptance_verified,false);
  assert.equal(f.plan.steps.filter(s=>s.status==='completed').length,0);
});
test('component pre-abort performs no reservation or checkpoint', async t => {
  const f=await fixture(t), abort=new AbortController(); abort.abort();
  await assert.rejects(new f.api.PiWaveCoordinator(f.host).run(f.candidates,2,abort.signal), /abort/i); assert.deepEqual(f.events,[]);
});
