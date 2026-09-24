const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const api=require('../dist/index.cjs');
const make=()=>api.initialize({title:'Plan',steps:[{id:'a',title:'A',parallel_group:1},{id:'b',title:'B',parallel_group:1},{id:'c',title:'C',depends_on:['a']}]});
const ask=p=>({plan_id:p.plan_id,base_revision:p.revision,request_id:'question',intent:'ask',operations:[],target_step_ids:['a'],question:'Why is this needed?'});
test('asking records a receipt without changing steps, approval or freshness',()=>{
 let p=make();[p]=api.applyRequest(p,{plan_id:p.plan_id,base_revision:p.revision,request_id:'run',intent:'implement',operations:[],selected_step_ids:['a','b'],execution_mode:'auto'});
 const req=ask(p),[q]=api.applyRequest(p,req);
 assert.deepEqual(q.steps,p.steps);assert.deepEqual(q.execution,p.execution);
 assert.equal(q.revision,p.revision);assert.equal(api.applyRequest(q,req)[1],false);
 assert.throws(()=>api.applyRequest(q,{...req,question:'Remove it'}),/reused/);
 assert.equal(api.applyRequest(q,{...req,request_id:'second-question',question:'What can run alongside this?'})[1],true);
 assert.throws(()=>api.applyRequest(q,{...req,request_id:'new',base_revision:q.revision-1}),/Stale/);
});
test('ask rejects mixed mutations, missing questions, bad targets and execution modes',()=>{
 const p=make();
 for(const patch of [{question:undefined},{question:''},{question:' '.repeat(3)},{question:'x'.repeat(1001)},{question:3},{target_step_ids:[]},{target_step_ids:['a','b']},{target_step_ids:['absent']},{selected_step_ids:['a']},{operations:[{type:'set_status',step_id:'a',status:'completed'}]},{execution_mode:'auto'}]) assert.throws(()=>api.applyRequest(p,{...ask(p),...patch}));
 assert.throws(()=>api.applyRequest(p,{...ask(p),intent:'edit'}),/question/);
 assert.throws(()=>api.applyRequest({...p,lifecycle:'finished'},ask(p)),/finished/);
});
test('parallel groups reject dependency chains, invalid values and review/handover crossings',()=>{
 const p=make();
 for(const value of [null,0,-1,1.5,31,'1']) assert.throws(()=>api.validate({...p,steps:p.steps.map(s=>s.id==='a'?{...s,parallel_group:value}:s)}),/parallel group/i);
 assert.throws(()=>api.validate({...p,steps:p.steps.map(s=>s.id==='c'?{...s,parallel_group:1}:s)}),/dependent/);
 for(const barrier of [{id:'h',title:'H',kind:'handover'},{id:'r',title:'R',kind:'review',depends_on:['a'],checks:['Check A']}])
  assert.throws(()=>api.initialize({title:'Plan',steps:[{id:'a',title:'A',parallel_group:1},barrier,{id:'b',title:'B',parallel_group:1}]}),/crosses/);
});
test('CLI persists groups, supports targeted assignment, and stores idempotent ask receipts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hp-ask-'));try{
 const plan=path.join(dir,'plan.md'),request=path.join(dir,'request.json'),fields=path.join(dir,'fields.json');
 api.saveMarkdown(plan,make());let p=api.read(plan);
 const run=(...args)=>JSON.parse(execFileSync(process.execPath,[path.resolve(__dirname,'../dist/plan.cjs'),...args,'--plan',plan],{encoding:'utf8'}));
 fs.writeFileSync(request,JSON.stringify(ask(p)));run('apply','--request',request);
 assert.equal(api.read(plan).steps[0].parallel_group,1);
 assert.equal(run('apply','--request',request).result,'already_applied');
 assert.deepEqual(api.read(plan).steps,p.steps);
 fs.writeFileSync(fields,JSON.stringify({parallel_group:2}));p=api.read(plan);
 run('step','update','--step-id','b','--base-revision',String(p.revision),'--input',fields);
 assert.equal(api.read(plan).steps[1].parallel_group,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
