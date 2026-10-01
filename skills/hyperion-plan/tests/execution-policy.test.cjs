const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../dist/index.cjs');

function approved(steps = [{id:'a',title:'A'}, {id:'b',title:'B',depends_on:['a']}], selected = steps.filter(s=>s.status!=='completed').map(s=>s.id)) {
  const plan = api.initialize({title:'Policy',steps});
  return api.applyRequest(plan,{plan_id:plan.plan_id,base_revision:plan.revision,request_id:'run',intent:'implement',operations:[],selected_step_ids:selected,execution_mode:'auto'})[0];
}
const authority = {currentRunAuthorized:true,implementationAllowed:true,requestId:'run'};

test('policy inspection reuses core readiness without mutation or granting approval', () => {
  const plan = approved();
  const before = api.clone(plan);
  assert.equal(api.assertStepExecutionAllowed(plan,'a',authority).id,'a');
  assert.deepEqual(plan,before);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'b',authority), /Prerequisite is not complete/);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'missing',authority), /outside ready approved scope/);
});

for (const [field,value,pattern] of [
  ['currentRunAuthorized',false,/Saved approval/],
  ['implementationAllowed',false,/Current mode/],
  ['requestId','old-request',/request changed/],
  ['refreshRequired',true,/Refresh external Markdown/],
]) test(`dispatch contract rejects ${field}=${value}`,()=>{
  assert.throws(()=>api.assertStepExecutionAllowed(approved(),'a',{...authority,[field]:value}),pattern);
});

for (const state of ['paused','cancelled']) test(`dispatch contract rejects ${state} scope`,()=>{
  const plan=approved();plan.execution.state=state;
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',authority),new RegExp(state));
});

test('unselected and completed steps, finished plans, blockers and changed active scope cannot dispatch',()=>{
  let plan=approved([{id:'a',title:'A'},{id:'b',title:'B'}],['a']);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'b',authority),/outside ready approved scope/);
  plan.steps[0].status='completed';
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',authority),/outside ready approved scope/);
  plan=approved();plan.lifecycle='finished';
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',authority),/finished/);
  plan=approved();plan.steps[0].blocked_by='Unverified writers';
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',authority),/Unverified writers/);
  plan=approved();plan.steps[0].status='in_progress';plan.steps[0].needs_replanning=true;
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',authority),/Needs replanning/);
});

test('freshness is advisory but actual execution ownership remains enforced',()=>{
  const plan=approved();plan.steps[0].review_state='needs_review';plan.steps[0].review_note='Inspect changed assumptions';plan.execution_owner='native-owner';
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',authority),/belongs to task/);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'a',{...authority,actorId:'other'}),/belongs to task/);
  assert.equal(api.assertStepExecutionAllowed(plan,'a',{...authority,actorId:'native-owner'}).id,'a');
});

test('selected review is a barrier even when later work has no dependency edge',()=>{
  const plan=approved([
    {id:'done',title:'Done',status:'completed'},
    {id:'review',title:'Review',kind:'review',depends_on:['done'],checks:['Check behavior']},
    {id:'later',title:'Later'},
  ]);
  assert.equal(api.assertStepExecutionAllowed(plan,'review',authority).id,'review');
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'later',authority),/Execution barrier first/);
  assert.deepEqual(api.nextSteps(plan).parallel_candidates,[]);
});

test('review waits for earlier selected work even outside its inspection coverage',()=>{
  const plan=approved([
    {id:'early',title:'Earlier work'},
    {id:'done',title:'Already done',status:'completed'},
    {id:'review',title:'Review',depends_on:['done'],kind:'review',checks:['Check done only']},
  ]);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'review',authority),/preceding selected work/);
});

test('handover is transfer-only and prevents later work',()=>{
  const plan=approved([
    {id:'done',title:'Done',status:'completed'},
    {id:'transfer',title:'Transfer',kind:'handover'},
    {id:'later',title:'Later'},
  ],['later']);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'transfer',authority),/outside ready approved scope/);
  assert.throws(()=>api.assertStepExecutionAllowed(plan,'later',authority),/handover/i);
  assert.throws(()=>api.checkpoint(plan,plan.revision,'transfer','completed','A worker said done'),/handover lifecycle/);
});

test('shared core still rejects completion without observed evidence',()=>{
  const plan=approved();
  assert.throws(()=>api.checkpoint(plan,plan.revision,'a','completed',''),/completion evidence/);
});

test('worker success cannot stand in for coordinator verification or writer quiescence',()=>{
  const handle={assignment_id:'job',session:{host:'pi',native_id:'child'},transcript_path:'/evidence/session'};
  const result={assignment_id:'job',session:handle.session,outcome:'succeeded',changed_paths:[],evidence:['report'],effort:{requested:'high',actual:'high'},quiescence:{state:'verified',evidence:['all writers joined']}};
  const verified={acceptance_met:true,integration_checked:true,evidence:['Integrated tests passed']};
  assert.doesNotThrow(()=>api.assertVerifiedWorkerResult(handle,result,verified));
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,result,{...verified,evidence:[]}),/Coordinator acceptance/);
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,result,{...verified,acceptance_met:false}),/Coordinator acceptance/);
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,{...result,assignment_id:'other'},verified),/does not match/);
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,{...result,session:{host:'pi',native_id:'other'}},verified),/does not match/);
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,{...result,outcome:'cancelled'},verified),/did not succeed/);
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,{...result,quiescence:{state:'unknown',reason:'Abort sent only'}},verified),/quiescence/);
  assert.throws(()=>api.assertVerifiedWorkerResult(handle,{...result,quiescence:{state:'verified',evidence:[]}},verified),/quiescence/);
});

test('both hosts consume shared checkpoint/ownership rules with capability-aware Pi waves',()=>{
  const request={plan_id:'p',base_revision:1,request_id:'r',intent:'implement',selected_step_ids:['a'],operations:[]};
  const prompt=api.codexPrompt({plan_path:'/plan.md',skill_path:'/skill.md',request,title:'Run'});
  assert.ok(prompt.includes(api.CHECKPOINT_INSTRUCTIONS));
  assert.ok(prompt.includes(api.OWNERSHIP_INSTRUCTIONS));
  const pi=fs.readFileSync(path.join(__dirname,'../src/pi/extension.ts'),'utf8');
  assert.match(pi,/CHECKPOINT_INSTRUCTIONS,/);
  assert.match(pi,/OWNERSHIP_INSTRUCTIONS,/);
  assert.match(pi,/bounded hyperion_wave assignments only for selected implementation steps/);
  assert.match(pi,/Explicit sequential mode permits at most one assignment/);
  assert.match(pi,/checkpoint each completion or blocker, then reconcile the wave/);
  const shared=api.requestInstructions(request,{freshTask:'fresh session',freshTasks:'fresh sessions'});
  assert.doesNotMatch(shared,/Codex|Pi|spawn_agent|RPC/);
});
