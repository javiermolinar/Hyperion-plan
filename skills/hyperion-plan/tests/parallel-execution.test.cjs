const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const a=require('../dist/index.cjs');
const base=()=>a.initialize({title:'Parallel work',steps:[
 {id:'a',title:'Change A'}, {id:'b',title:'Change B'},
 {id:'dependent',title:'Uses A',depends_on:['a']},
 {id:'review',title:'Review A and B',kind:'review',depends_on:['a','b'],checks:['Check integration']},
 {id:'later',title:'After review'}, {id:'unselected',title:'Leave for later'}
]});
const req=(p,extra={})=>({plan_id:p.plan_id,base_revision:p.revision,request_id:'run-'+p.revision,intent:'implement',operations:[],selected_step_ids:['a','b','dependent','review','later'],...extra});
const ids=steps=>steps.map(s=>s.id);
test('parallel execution is explicit, scoped, durable and receipt-safe',()=>{
 const p=base(),r=req(p,{execution_mode:'parallel'});
 const [q]=a.applyRequest(p,r);
 assert.equal(q.execution.execution_mode,'parallel');
 assert.deepEqual(a.nextSteps(q).parallel_candidates.map(s=>s.id),['a','b']);
 assert.equal(a.applyRequest(q,r)[1],false);
 assert.throws(()=>a.applyRequest(q,{...r,execution_mode:'sequential'}),/reused/);
 assert.deepEqual(a.nextSteps(q).unselected_step_ids,['unselected']);
 const [fresh]=a.applyRequest(q,req(q,{selected_step_ids:['a']}));
 assert.equal(fresh.execution.execution_mode,undefined);
 assert.equal(a.nextSteps(fresh).execution_mode,'sequential');
 assert.deepEqual(a.nextSteps(fresh).parallel_candidates,[]);
});
test('mode never grants authority through edits, planning, lifecycle, or malformed input',()=>{
 const p=base();
 for(const mode of [null,'unexpected','',3,{},[]]){
  assert.throws(()=>a.applyRequest(p,req(p,{execution_mode:mode})),/Execution mode/);
 }
 for(const intent of ['edit','review','decompose','replan','finish','reopen','handover']){
  assert.throws(()=>a.applyRequest(p,req(p,{intent,execution_mode:'parallel'})),/Execution mode/);
 }
 let [q]=a.applyRequest(p,req(p,{execution_mode:'parallel'}));
 q.execution.execution_mode='automatic'; assert.throws(()=>a.validate(q),/execution mode/);
});
test('parallel candidates obey readiness, active work, review barriers and lifecycle',()=>{
 let p=base(); [p]=a.applyRequest(p,req(p,{execution_mode:'parallel'}));
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['a','b']);
 p.steps[0].status='in_progress';
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['b']);
 assert.deepEqual(ids(a.nextSteps(p).in_progress_steps),['a']);
 p.steps[1].blocked_by='Shared resource';
 assert.deepEqual(a.nextSteps(p).parallel_candidates,[]);
 delete p.steps[1].blocked_by; p.steps[1].review_state='needs_review'; p.steps[1].review_note='Changed prerequisite';
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['b']);
 delete p.steps[1].review_state; delete p.steps[1].review_note;
 p.steps[0].status='completed';p.steps[1].status='completed';
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['dependent']);
 p.steps[2].status='completed';
 assert.deepEqual(a.nextSteps(p).parallel_candidates,[]); // pending review holds later work
 p.steps[3].status='in_progress';
 assert.deepEqual(a.nextSteps(p).parallel_candidates,[]);
 p.steps[3].status='completed';
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['later']);
 assert.deepEqual(a.nextSteps(p,true).parallel_candidates,[]);
 for(const state of ['paused','cancelled']){
  p.execution.state=state;assert.deepEqual(a.nextSteps(p).parallel_candidates,[]);
 }
 p.execution.state='approved';p.lifecycle='finished';assert.deepEqual(a.nextSteps(p).parallel_candidates,[]);
});

test('handover checkpoints prevent delegation to later steps',()=>{
 let p=a.initialize({title:'Boundary',steps:[{id:'a',title:'A'},{id:'h',title:'H',kind:'handover'},{id:'b',title:'B'}]});
 [p]=a.applyRequest(p,req(p,{execution_mode:'parallel',selected_step_ids:['a','b']}));
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['a']);
 p.steps[0].status='completed';
 assert.deepEqual(a.nextSteps(p).parallel_candidates,[]);
 assert.deepEqual(ids(a.nextSteps(p).ready_handover_steps),['h']);
});
test('CLI stores mode in sidecar, preserves it on edits and revokes changed scope',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-parallel-'));
 try {
  const file=path.join(dir,'plan.md'),input=path.join(dir,'request.json');
  const cli=path.resolve(__dirname,'../dist/plan.cjs');
  const run=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,...args,'--plan',file],{encoding:'utf8',stdio:'pipe'}));
  a.saveMarkdown(file,base()); let p=a.read(file);
  fs.writeFileSync(input,JSON.stringify(req(p,{execution_mode:'parallel'})));
  run('apply','--request',input);
  assert.equal(run('status').execution.execution_mode,'parallel');
  assert.equal(run('next').execution_mode,'parallel');
  assert.deepEqual(ids(run('next').parallel_candidates),['a','b']);
  assert.equal(a.read(file).execution.execution_mode,'parallel');
  const before=fs.readFileSync(file,'utf8');
  assert.equal(run('apply','--request',input).result,'already_applied');
  assert.equal(fs.readFileSync(file,'utf8'),before);
  p=a.read(file);
  run('step','update','--step-id','a','--base-revision',String(p.revision),'--description','Changed requirements');
  assert.equal(a.read(file).execution.execution_mode,'parallel');
  assert.ok(!a.read(file).execution.selected_step_ids.includes('a'));
  assert.deepEqual(ids(run('next').parallel_candidates),['b']);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

for (const mode of ['auto', 'parallel']) test(mode + ' exposes only approved ready candidates',()=>{
 let p=base(); [p]=a.applyRequest(p,req(p,{execution_mode:mode}));
 assert.equal(a.nextSteps(p).execution_mode,mode);
 assert.deepEqual(ids(a.nextSteps(p).parallel_candidates),['a','b']);
 p.execution.state='paused';
 assert.deepEqual(a.nextSteps(p).parallel_candidates,[]);
});
