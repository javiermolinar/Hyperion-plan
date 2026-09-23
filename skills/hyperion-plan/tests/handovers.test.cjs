const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const a=require('../dist/index.cjs');
function setup(){
 let p=a.initialize({title:'Migration',steps:[{id:'done',title:'Prepare service',status:'completed'},{id:'active',title:'Migrate writes'},{id:'later',title:'Validate rollback',depends_on:['active']}]});
 [p]=a.applyRequest(p,{plan_id:p.plan_id,request_id:'approve',base_revision:p.revision,intent:'implement',operations:[],selected_step_ids:['active','later']});
 [p]=a.checkpoint(p,p.revision,'active','in_progress','Migration logic started');
 return p;
}
function request(p,changes={}){return {plan_id:p.plan_id,request_id:'handover-one',base_revision:p.revision,intent:'handover',operations:[],target_step_ids:['active'],handover_reason:'Context is getting large',...changes};}
function prepare(p,fields={}){return a.updateHandover(p,p.revision,{request_id:'handover-one',state:'prepared',brief_path:'/tmp/brief.md',summary:'Migration logic written; validation pending',next_action:'Run rollback checks',code_state:'Checkout /tmp/repo at abc123, modified migration.ts; unit tests passed',...fields},'source')[0];}
test('handover records the actual position while preserving progress, scope, and retry receipts',()=>{
 const p=setup(),r=request(p);const [next]=a.applyRequest(p,r);
 assert.deepEqual(next.steps,p.steps);assert.deepEqual(next.execution,p.execution);
 assert.equal(next.handovers[0].position,'during');assert.equal(next.handovers[0].step_id,'active');
 assert.equal(a.applyRequest(next,r)[1],false);
 assert.deepEqual(a.loads(a.dumps(next),next.plan_id).handovers,next.handovers);
 assert.throws(()=>a.applyRequest(next,request(next,{request_id:'second'})),/already active/);
 assert.throws(()=>a.applyRequest(p,request(p,{selected_step_ids:['later']})),/cannot authorize/);
 assert.throws(()=>a.applyRequest(p,request(p,{target_step_ids:['later']})),/active work/);
 assert.equal(a.applyRequest(p,request(p,{target_step_ids:['done']}))[0].handovers[0].position,'after');
 assert.equal(a.applyRequest(p,request(p,{target_step_ids:[]}))[0].handovers[0].position,'between');
 assert.throws(()=>a.applyRequest(p,request(p,{handover_reason:' '})),/reason/);
 assert.equal(a.nextSteps(next).ready_steps.length,0);assert.equal(a.nextSteps(next).in_progress_steps.length,0);
 assert.throws(()=>a.checkpoint(next,next.revision,'active','completed','Tests passed'),/handover/);
 assert.throws(()=>a.applyRequest(next,{plan_id:next.plan_id,base_revision:next.revision,request_id:'work',intent:'implement',operations:[],selected_step_ids:['active']}),/handover/);
});
test('planned boundaries preserve scope and freshness through card and agent edits',()=>{
 const p=setup();const r=a.applyOperations(p,[{type:'set_handover_point',step_id:'active',reason:'Service migration is a coherent batch'}]);
 assert.deepEqual(r.execution,p.execution);assert.equal(r.steps[2].review_state,p.steps[2].review_state);
 assert.deepEqual(a.stepFingerprint(r.steps[1]),a.stepFingerprint(p.steps[1]));
 const [edited]=a.editStep(p,p.revision,{action:'update',stepId:'active',fields:{handover_after:'Good boundary'}});
 assert.deepEqual(edited.execution,p.execution);assert.equal(edited.steps[2].review_state,p.steps[2].review_state);
 assert.equal(a.loads(a.dumps(edited),edited.plan_id).steps[1].handover_after,'Good boundary');
 const cleared=a.applyOperations(edited,[{type:'set_handover_point',step_id:'active',reason:''}]);assert.equal(cleared.steps[1].handover_after,undefined);
});
test('prepare and transfer change owner without altering approvals, paused state or in-progress work',()=>{
 let p=setup();[p]=a.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused');
 [p]=a.applyRequest(p,request(p));const initial=a.clone(p);
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'transferred',destination_task_id:'destination'},'source'),/Prepare/);
 p=prepare(p);assert.equal(p.execution_owner,'source');
 assert.match(a.handoverBrief(p,'handover-one'),/report ready and stop/);
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'transferred',destination_task_id:'source'},'source'),/fresh task/);
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'transferred',destination_task_id:'destination'},'intruder'),/belongs to/);
 [p]=a.updateHandover(p,p.revision,{request_id:'handover-one',state:'transferred',destination_task_id:'destination'},'source');
 assert.equal(p.execution_owner,'destination');assert.deepEqual(p.execution,initial.execution);assert.deepEqual(p.steps,initial.steps);
 assert.equal(p.handovers[0].state,'transferred');assert.ok(p.handovers[0].transferred_at);
 assert.throws(()=>a.assertExecutionOwner(p,'source'),/belongs to/);a.assertExecutionOwner(p,'destination');
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'cancelled',note:'undo'},'destination'),/history/);
 const replacement=a.clone(p);delete replacement.handovers;replacement.execution_owner='source';replacement.steps[2].description='Check rollback';
 const revised=a.revise(p,replacement,p.revision);assert.deepEqual(revised.handovers,p.handovers);assert.equal(revised.execution_owner,'destination');
 assert.match(a.prNotes(revised),/Migration logic written; validation pending/);
});
test('plan drift blocks transfer and recovery reuses the same destination',()=>{
 let p=setup();[p]=a.applyRequest(p,request(p));p=prepare(p,{destination_task_id:'destination'});
 const changed=a.clone(p);changed.steps[1].description='Updated migration requirement';p=a.revise(p,changed,p.revision);
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'transferred'},'source'),/changed since preparation/);
 assert.throws(()=>prepare(p,{destination_task_id:'duplicate'}),/Reuse/);
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'prepared',destination_task_id:'destination'},'source'),/supply refreshed/);
 assert.throws(()=>a.updateHandover(p,p.revision-1,{request_id:'handover-one',state:'blocked',note:'stale'},'source'),/Stale/);
 p=prepare(p);
 [p]=a.updateHandover(p,p.revision,{request_id:'handover-one',state:'blocked',note:'Destination setup unavailable'},'source');
 assert.throws(()=>a.applyRequest(p,request(p,{request_id:'duplicate'})),/already active/);
 p=prepare(p);[p]=a.updateHandover(p,p.revision,{request_id:'handover-one',state:'transferred'},'source');
 assert.equal(p.execution_owner,'destination');
});
test('cancelling a failed handover releases the hold without granting scope',()=>{
 let p=setup();[p]=a.applyRequest(p,request(p));const initial=a.clone(p);
 [p]=a.updateHandover(p,p.revision,{request_id:'handover-one',state:'blocked',note:'No task tools'},'source');
 assert.equal(a.nextSteps(p).in_progress_steps.length,0);
 [p]=a.updateHandover(p,p.revision,{request_id:'handover-one',state:'cancelled',note:'Stay in source'},'source');
 assert.equal(a.nextSteps(p).in_progress_steps.length,1);assert.deepEqual(p.execution,initial.execution);assert.deepEqual(p.steps,initial.steps);
 assert.throws(()=>a.updateHandover(p,p.revision,{request_id:'handover-one',state:'prepared'},'source'),/history/);
});
test('CLI persists handover ownership, protects exports and rejects stale or wrong-owner writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-handover-'));
 try{
  const cli=path.resolve(__dirname,'../dist/plan.cjs'),file=path.join(dir,'plan.md'),input=path.join(dir,'update.json'),brief=path.join(dir,'brief.md');
  const run=(...args)=>execFileSync(process.execPath,[cli,...args,'--plan',file],{encoding:'utf8',stdio:'pipe',env:{...process.env,CODEX_THREAD_ID:''}});
  let p=setup();[p]=a.applyRequest(p,request(p));fs.writeFileSync(file,a.dumps(p));
  fs.writeFileSync(input,JSON.stringify({request_id:'handover-one',state:'prepared',brief_path:brief,summary:'Partial migration',next_action:'Run rollback tests',code_state:'HEAD abc; changed migration.ts'}));
  run('handover','--base-revision',String(p.revision),'--input',input,'--task-id','source');
  const shown=JSON.parse(run('show'));let current=shown.plan??shown;
  assert.equal(current.execution_owner,'source');
  run('handover-brief','--request-id','handover-one','--output',brief);assert.match(fs.readFileSync(brief,'utf8'),/Partial migration/);
  assert.throws(()=>run('handover-brief','--request-id','handover-one','--output',file));
  const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>run('step','update','--step-id','active','--description','wrong task','--base-revision',String(current.revision),'--task-id','other'));
  assert.equal(fs.readFileSync(file,'utf8'),before);
  fs.writeFileSync(input,JSON.stringify({request_id:'handover-one',state:'transferred',destination_task_id:'destination'}));
  run('handover','--base-revision',String(current.revision),'--input',input,'--task-id','source');
  const transferred=JSON.parse(run('show'));current=transferred.plan??transferred;
  assert.equal(current.execution_owner,'destination');
  assert.throws(()=>run('step','update','--step-id','active','--description','old source','--base-revision',String(current.revision),'--task-id','source'));
  fs.writeFileSync(path.join(dir,'marker.json'),JSON.stringify({handover_after:'Boundary'}));
  run('step','update','--step-id','active','--input',path.join(dir,'marker.json'),'--base-revision',String(current.revision),'--task-id','destination');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
