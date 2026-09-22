const {test}=require('node:test');
const assert=require('node:assert/strict');
const a=require('../dist/index.cjs');
test('milestones round-trip through Markdown without changing step scope or order',()=>{
  const plan=a.initialize({title:'Milestones',steps:[{id:'a',title:'Service',milestone:'Foundation',status:'completed'}, {id:'b',title:'CLI',milestone:'CLI / VS Code',depends_on:['a']}]});
  assert.deepEqual(a.loads(a.dumps(plan),plan.plan_id),plan);
  const grouped=a.clone(plan);grouped.steps[0].milestone='Service foundation';
  assert.deepEqual(a.stepFingerprint(grouped.steps[0]),a.stepFingerprint(plan.steps[0]));
  assert.deepEqual(grouped.steps.map(s=>s.id),plan.steps.map(s=>s.id));
});
test('adding a code review retains its milestone through operation replay',()=>{
  const plan=a.initialize({title:'Milestones',steps:[{id:'a',title:'Service',milestone:'Foundation'}]});
  const result=a.applyOperations(plan,[{type:'add_step',step_id:'r',title:'Review service',kind:'review',milestone:'Foundation',depends_on:['a'],checks:['Check service behavior'],after_step_id:'a'}]);
  assert.equal(result.steps[1].milestone,'Foundation');
  assert.equal(a.loads(a.dumps(result),result.plan_id).steps[1].milestone,'Foundation');
  for(const milestone of [null,{},'x'.repeat(101)])assert.throws(()=>a.validate({...result,steps:[{...result.steps[0],milestone}]}));
});
test('regrouping approved work preserves execution scope and dependent freshness',()=>{
  let plan=a.initialize({title:'Approved work',steps:[{id:'a',title:'Service'},{id:'b',title:'CLI',depends_on:['a']}]});
  [plan]=a.applyRequest(plan,{plan_id:plan.plan_id,base_revision:plan.revision,request_id:'approve',intent:'implement',operations:[],selected_step_ids:['a','b']});
  const [updated]=a.editStep(plan,plan.revision,{action:'update',stepId:'a',fields:{milestone:'Service foundation'}});
  assert.deepEqual(updated.execution,plan.execution);
  assert.equal(updated.steps[1].review_state,plan.steps[1].review_state);
  assert.equal(updated.steps[0].milestone,'Service foundation');
  assert.equal(a.loads(a.dumps(updated),updated.plan_id).steps[0].milestone,'Service foundation');
});
