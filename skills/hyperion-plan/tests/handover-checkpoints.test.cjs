const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const a=require('../dist/index.cjs');
const base=(done=true)=>a.initialize({title:'Two phases',steps:[
 {id:'10',title:'Complete phase one',status:done?'completed':'pending'},
 {id:'2',title:'Fresh context for phase two',kind:'handover',description:'Carry decisions and verified results into the next phase.'},
 {id:'1',title:'Implement phase two'},
]});
const request=(p,changes={})=>({plan_id:p.plan_id,request_id:'handover',base_revision:p.revision,intent:'handover',operations:[],target_step_ids:['2'],...changes});
const prepare=p=>a.updateHandover(p,p.revision,{request_id:'handover',state:'prepared',brief_path:'/tmp/checkpoint.md',summary:'Phase one validated.',next_action:'Select phase two.',code_state:'Same checkout at abc123; tests passed.'},'source')[0];
test('checkpoint waits for preceding work and prevents crossing the boundary through selection or old approval',()=>{
 const p=base(false);
 assert.throws(()=>a.applyRequest(p,request(p)),/preceding steps/);
 const select=ids=>a.applyRequest(p,request(p,{intent:'implement',target_step_ids:[],selected_step_ids:ids,request_id:'select'}));
 assert.throws(()=>select(['2']),/preceding steps/);
 assert.throws(()=>select(['1']),/preceding steps/);
 assert.deepEqual(select(['10','1'])[0].execution.selected_step_ids,['10','2','1']);
 // IDs intentionally sort differently from plan order.
 assert.equal(a.nextSteps(p).ready_handover_steps.length,0);
 let ready=base();assert.equal(a.nextSteps(ready).ready_handover_steps.length,0);
 [ready]=a.applyRequest(ready,request(ready,{intent:'implement',target_step_ids:[],selected_step_ids:['1']}));
 assert.deepEqual(a.nextSteps(ready).ready_handover_steps.map(s=>s.id),['2']);
 let old=a.initialize({title:'Existing approval',steps:[{id:'first',title:'First'},{id:'last',title:'Last'}]});
 [old]=a.applyRequest(old,{plan_id:old.plan_id,request_id:'approve',base_revision:old.revision,intent:'implement',operations:[],selected_step_ids:['first','last']});
 [old]=a.editStep(old,old.revision,{action:'add',stepId:'boundary',fields:{title:'Handover',kind:'handover'},placement:{after:'first'}});
 assert.deepEqual(a.nextSteps(old).ready_steps.map(s=>s.id),['first']);
 assert.throws(()=>a.checkpoint(old,old.revision,'last','in_progress','Start'),/handover first/);
});
test('only a verified ownership transfer completes the checkpoint, without completing subsequent work',()=>{
 const p=base(),req=request(p);let [next]=a.applyRequest(p,req);
 assert.equal(next.steps[1].status,'in_progress');
 assert.equal(a.applyRequest(next,req)[1],false);
 assert.equal(a.nextSteps(next).ready_handover_steps.length,0);
 assert.throws(()=>a.applyOperations(p,[{type:'set_status',step_id:'2',status:'completed'}]),/ownership transfers/);
 const forged=a.clone(p);forged.steps[1].status='completed';assert.throws(()=>a.validate(forged),/transfer event/);
 assert.throws(()=>a.updateHandover(next,next.revision,{request_id:'handover',state:'transferred',destination_task_id:'dest'},'source'),/Prepare/);
 next=prepare(next);
 [next]=a.updateHandover(next,next.revision,{request_id:'handover',state:'transferred',destination_task_id:'dest'},'source');
 assert.equal(next.execution_owner,'dest');assert.equal(next.steps[1].status,'completed');assert.equal(next.steps[2].status,'pending');assert.equal(next.execution,undefined);
 assert.match(next.steps[1].progress_note,/dest/);assert.equal(a.handoverBlocker(next.steps,next.steps[2]),'');
 assert.equal(a.loads(a.dumps(next),next.plan_id).steps[1].kind,'handover');
 assert.match(a.prNotes(next),/handover · completed/);
 assert.throws(()=>a.applyRequest(next,request(next,{request_id:'again',base_revision:next.revision})),/already started or completed/);
});
test('failure and cancellation retain the checkpoint for retry and never unblock the next phase',()=>{
 let original=base();[original]=a.applyRequest(original,request(original,{request_id:'approve',intent:'implement',target_step_ids:[],selected_step_ids:['1']})); let [p]=a.applyRequest(original,request(original));
 [p]=a.updateHandover(p,p.revision,{request_id:'handover',state:'blocked',note:'Destination unavailable'},'source');
 assert.equal(p.steps[1].status,'in_progress');assert.match(a.handoverBlocker(p.steps,p.steps[2]),/handover first/);
 [p]=a.updateHandover(p,p.revision,{request_id:'handover',state:'cancelled',note:'Retry later'},'source');
 assert.equal(p.steps[1].status,'pending');assert.equal(a.nextSteps(p).ready_handover_steps.length,0);
 assert.ok(!p.execution.selected_step_ids.includes('2'));
 [p]=a.applyRequest(p,request(p,{request_id:'retry'}));assert.equal(p.handovers.length,2);
});
test('moving/removing a pending checkpoint adjusts the phase boundary without granting work',()=>{
 const p=base();
 const [moved]=a.editStep(p,p.revision,{action:'move',stepId:'2',placement:{after:'1'}});
 assert.equal(a.handoverBlocker(moved.steps,moved.steps[1]),'');assert.equal(a.nextSteps(moved).ready_handover_steps.length,0);
 const [removed]=a.editStep(p,p.revision,{action:'remove',stepId:'2'});assert.equal(removed.steps.length,2);assert.equal(removed.execution,undefined);
 assert.throws(()=>a.applyOperations(p,[{type:'add_step',step_id:'r',title:'Bad review',kind:'review',depends_on:['2'],checks:['Review boundary']}]),/implementation steps/);
});
test('CLI persists checkpoint request and completion with actor ownership and exports',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-checkpoint-'));
 try{
  const file=path.join(dir,'plan.md'),input=path.join(dir,'input.json'),cli=path.resolve(__dirname,'../dist/plan.cjs');
  const run=(...args)=>execFileSync(process.execPath,[cli,...args,'--plan',file],{encoding:'utf8',stdio:'pipe'});
  let p=base();a.saveMarkdown(file,p);fs.writeFileSync(input,JSON.stringify(request(p)));
  run('apply','--request',input);p=a.read(file);assert.equal(p.steps[1].status,'in_progress');
  fs.writeFileSync(input,JSON.stringify({request_id:'handover',state:'prepared',brief_path:path.join(dir,'brief.md'),summary:'Phase one done',next_action:'Choose phase two',code_state:'HEAD abc123; checks passed'}));
  run('handover','--base-revision',String(p.revision),'--task-id','source','--input',input);p=a.read(file);
  fs.writeFileSync(input,JSON.stringify({request_id:'handover',state:'transferred',destination_task_id:'dest'}));
  run('handover','--base-revision',String(p.revision),'--task-id','source','--input',input);p=a.read(file);
  assert.equal(p.steps[1].status,'completed');assert.equal(p.execution_owner,'dest');assert.match(fs.readFileSync(path.join(dir,'plan-pr-notes.md'),'utf8'),/Ownership transferred/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('automatic handovers are attached to a batch but suppressed by pause, cancellation, finish and stale reads',()=>{
 let p=base(false);
 [p]=a.applyRequest(p,request(p,{intent:'implement',target_step_ids:[],selected_step_ids:['10']}));
 assert.deepEqual(p.execution.selected_step_ids,['10','2']);
 assert.equal(a.nextSteps(p).ready_handover_steps.length,0);
 [p]=a.checkpoint(p,p.revision,'10','completed','Phase one tests passed.');
 assert.deepEqual(a.nextSteps(p).ready_handover_steps.map(s=>s.id),['2']);
 assert.equal(a.nextSteps(p,true).ready_handover_steps.length,0);
 for(const state of ['paused','cancelled']) {
  const [held]=a.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,state);
  assert.equal(a.nextSteps(held).ready_handover_steps.length,0);
 }
 assert.equal(a.nextSteps(a.setLifecycle(p,p.revision,'finished')[0]).ready_handover_steps.length,0);
 assert.equal(p.steps[2].status,'pending');
 assert.ok(!p.execution.selected_step_ids.includes('1'));
});

test('partial phase runs omit unreachable or blocked trailing checkpoints',()=>{
 const p=a.initialize({title:'Partial phase',steps:[
  {id:'a',title:'A'}, {id:'b',title:'B'}, {id:'h',title:'Handover',kind:'handover'}, {id:'c',title:'C'},
 ]});
 const run=(plan,ids)=>a.applyRequest(plan,{plan_id:plan.plan_id,base_revision:plan.revision,request_id:'partial',intent:'implement',operations:[],selected_step_ids:ids})[0];
 assert.deepEqual(run(p,['b']).execution.selected_step_ids,['b']);
 assert.deepEqual(run(p,['a','b']).execution.selected_step_ids,['a','b','h']);
 assert.throws(()=>run(p,['b','c']),/preceding/);
 for(const fields of [{blocked_by:'Wait'},{review_state:'needs_review',review_note:'Verify boundary'}]) {
  const held=a.clone(p);Object.assign(held.steps[2],fields);
  assert.deepEqual(run(held,['a','b']).execution.selected_step_ids,['a','b']);
 }
});
