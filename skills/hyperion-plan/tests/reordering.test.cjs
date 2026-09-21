const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync,spawnSync}=require('node:child_process');
const a=require('../dist/index.cjs');
const cli=path.resolve(__dirname,'../dist/plan.cjs');
const step=(id,extra={})=>({id,title:id,status:'pending',comments:[],...extra});
const fixture=()=>a.initialize({title:'Reordering',steps:[
  step('done',{status:'completed'}),step('a'),step('active',{status:'in_progress'}),
  step('b'),step('c',{depends_on:['a']}),
  step('review',{kind:'review',depends_on:['a'],run_after:'b',checks:['Check A.']}),
]});
const op=step_ids=>({type:'reorder_steps',step_ids});
const valid=['done','b','active','a','c','review'];

test('reordering preserves protected history, task contents, review timing and coverage',()=>{
  const plan=fixture(),before=a.clone(plan);
  const result=a.applyOperations(plan,[op(valid)]);
  assert.deepEqual(result.steps.map(s=>s.id),valid);
  for(const s of plan.steps)assert.deepEqual(result.steps.find(x=>x.id===s.id),s);
  assert.deepEqual(plan,before,'Input plan is not mutated');
});
for(const [label,ids] of [
  ['duplicate',['done','a','active','a','c','review']],
  ['missing',['done','a','active','b','c']],
  ['unknown',['done','a','active','b','c','unknown']],
  ['invalid type',null],
  ['protected history reversal',['active','a','done','b','c','review']],
  ['prerequisite inversion',['done','c','active','a','b','review']],
  ['review before covered work',['done','b','active','review','c','a']],
  ['review before timing anchor',['done','a','active','review','c','b']],
])test(`reject ${label} atomically`,()=>{
  const plan=fixture(),before=a.clone(plan);
  assert.throws(()=>a.applyOperations(plan,[op(ids)]));assert.deepEqual(plan,before);
});
for(const id of ['done','active'])test(`status reset cannot make ${id} reorderable in a batch`,()=>{
  const plan=fixture(),ids=plan.steps.map(s=>s.id),index=ids.indexOf(id);
  const other=ids.indexOf(id==='done'?'active':'done');
  [ids[other],ids[index]]=[ids[index],ids[other]];
  assert.throws(()=>a.applyOperations(plan,[{type:'set_status',step_id:id,status:'pending'},op(ids)]),/Only pending/);
});
test('moving then removing a pending task can shift protected positions without reordering history',()=>{
  const plan=fixture();
  const result=a.applyOperations(plan,[{type:'remove_step',step_id:'c'},op(['done','active','b','a','review'])]);
  assert.deepEqual(result.steps.filter(s=>s.status!=='pending').map(s=>s.id),['done','active']);
});
test('new steps, removal, reordering and completion compose without losing IDs or notes',()=>{
  const plan=fixture();
  const result=a.applyOperations(plan,[
    {type:'remove_step',step_id:'c'},
    {type:'add_step',step_id:'new',title:'New'},
    {type:'add_comment',step_id:'a',comment_id:'note',text:'Keep this.'},
    op(['done','new','active','a','b','review']),
    {type:'set_status',step_id:'new',status:'completed'},
  ]);
  assert.equal(result.steps[1].status,'completed');
  assert.equal(result.steps.find(s=>s.id==='a').comments[0].text,'Keep this.');
});
for(const state of ['approved','paused','cancelled'])test(`reorder edit preserves ${state} execution scope and receipts`,()=>{
  let plan=fixture();
  [plan]=a.applyRequest(plan,{plan_id:plan.plan_id,base_revision:1,request_id:'approve',intent:'implement',operations:[],selected_step_ids:['a','b']});
  plan.execution.state=state;
  const request={plan_id:plan.plan_id,base_revision:plan.revision,request_id:'reorder',intent:'edit',operations:[op(valid)]};
  const [result]=a.applyRequest(plan,request);
  assert.deepEqual(result.execution,plan.execution);
  const [retry,changed]=a.applyRequest(result,request);assert.equal(changed,false);assert.deepEqual(retry,result);
  assert.throws(()=>a.applyRequest(result,{...request,request_id:'stale'}),/Stale plan/);
});
test('reordering persists in Markdown and PR notes; stale requests leave files unchanged',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-order-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const planPath=path.join(dir,'plan.md'),requestPath=path.join(dir,'request.json');
  const plan=fixture();a.saveMarkdown(planPath,plan);
  const request={plan_id:plan.plan_id,base_revision:plan.revision,request_id:'reorder',intent:'edit',operations:[op(valid)]};
  fs.writeFileSync(requestPath,JSON.stringify(request));
  execFileSync(process.execPath,[cli,'apply','--plan',planPath,'--request',requestPath]);
  const [result]=a.loadMarkdown(planPath);assert.deepEqual(result.steps.map(s=>s.id),valid);
  const exported=fs.readFileSync(a.notesPath(planPath),'utf8');assert.ok(exported.indexOf('Step `b`')<exported.indexOf('Step `a`'));
  const files=[planPath,a.markdownStatePath(planPath),a.notesPath(planPath)],bytes=files.map(p=>fs.readFileSync(p));
  fs.writeFileSync(requestPath,JSON.stringify({...request,request_id:'stale'}));
  const failure=spawnSync(process.execPath,[cli,'apply','--plan',planPath,'--request',requestPath],{encoding:'utf8'});
  assert.notEqual(failure.status,0);assert.match(failure.stderr,/Stale plan/);assert.deepEqual(files.map(p=>fs.readFileSync(p)),bytes);
});
