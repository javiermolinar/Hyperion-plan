const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {execFileSync}=require('node:child_process');
const a=require('../dist/index.cjs');
function setup(){
 let p=a.initialize({title:'Plan',steps:[{id:'done',title:'Existing behavior',status:'completed'},{id:'next',title:'Migration'}]});
 [p]=a.applyRequest(p,{plan_id:p.plan_id,request_id:'approve',base_revision:p.revision,intent:'implement',operations:[],selected_step_ids:['next']});
 const request={plan_id:p.plan_id,request_id:'review-one',base_revision:p.revision,intent:'review',review_mode:'independent',review_focus:'Challenge migration order',operations:[],target_step_ids:['done','next']};
 return {p,request};
}
test('independent review persists, is idempotent, includes completed context and never grants authority',()=>{
 const {p,request}=setup();const [r]=a.applyRequest(p,request);
 assert.deepEqual(r.execution,p.execution);assert.deepEqual(r.steps,p.steps);
 assert.equal(r.plan_reviews[0].revision,r.revision);
 assert.deepEqual(a.loads(a.dumps(r),r.plan_id).plan_reviews,r.plan_reviews);
 assert.equal(a.applyRequest(r,request)[1],false);
 assert.throws(()=>a.applyRequest(r,{...request,request_id:'second',base_revision:r.revision}),/already active/);
 assert.throws(()=>a.applyRequest(p,{...request,selected_step_ids:['next']}),/cannot authorize/);
 assert.throws(()=>a.applyRequest(p,{...request,review_mode:'wrong'}),/Invalid review mode/);
 assert.throws(()=>a.applyRequest(p,{...request,review_focus:'x'.repeat(2001)}),/focus/);
 assert.throws(()=>a.applyRequest(p,{...request,base_revision:1}),/Stale/);
});
test('review results require evidence, preserve task identity and survive reconciliation',()=>{
 const {p,request}=setup();let [r]=a.applyRequest(p,request);
 assert.throws(()=>a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'completed'}),/task ID/);
 [r]=a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'running',task_id:'reviewer',report_path:'/tmp/report.md'});
 assert.throws(()=>a.updatePlanReview(r,r.revision,{request_id:'review-one',task_id:'replacement'}),/original reviewer/);
 const findings=[{step_ids:['next'],text:'Missing rollback',resolution:'needs_input',reason:'Choose reversibility requirement'}];
 [r]=a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'completed',findings,note:'Reviewed architecture'});
 assert.deepEqual(r.execution,p.execution);
 const replacement=a.clone(r);delete replacement.plan_reviews;replacement.steps[1].description='Require rollback';
 const revised=a.revise(r,replacement,r.revision);
 assert.deepEqual(revised.plan_reviews,r.plan_reviews);
 assert.deepEqual(revised.execution.selected_step_ids,[]);
 assert.throws(()=>a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'running'}),/restart/);
 assert.throws(()=>a.updatePlanReview(r,r.revision,{request_id:'review-one',revision:99}),/Unexpected/);
 assert.throws(()=>a.updatePlanReview(r,r.revision,{request_id:'review-one',findings:[{...findings[0],step_ids:['unknown']}]}),/outside/);
 assert.equal(a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'completed'})[1],false);
});
test('CLI saves review updates to canonical Markdown and rejects stale writes without changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-plan-review-'));
 try{
  const cli=path.resolve(__dirname,'../dist/plan.cjs'), file=path.join(dir,'plan.md'), input=path.join(dir,'update.json');
  const {p,request}=setup();const [r]=a.applyRequest(p,request);fs.writeFileSync(file,a.dumps(r));
  fs.writeFileSync(input,JSON.stringify({request_id:'review-one',state:'running',task_id:'reviewer'}));
  execFileSync(process.execPath,[cli,'plan-review','--plan',file,'--base-revision',String(r.revision),'--input',input]);
  const saved=fs.readFileSync(file,'utf8');assert.equal(a.loads(saved,r.plan_id).plan_reviews[0].state,'running');
  assert.throws(()=>execFileSync(process.execPath,[cli,'plan-review','--plan',file,'--base-revision',String(r.revision),'--input',input],{stdio:'pipe'}));
  assert.equal(fs.readFileSync(file,'utf8'),saved);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a blocked review cannot resume alongside another active reviewer',()=>{
 const {p,request}=setup();let [r]=a.applyRequest(p,request);
 [r]=a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'blocked',note:'Reviewer unavailable'});
 [r]=a.applyRequest(r,{...request,base_revision:r.revision,request_id:'review-two'});
 assert.throws(()=>a.updatePlanReview(r,r.revision,{request_id:'review-one',state:'running',task_id:'reviewer'}),/already active/);
 assert.equal(a.summary(r).plan_reviews.length,2);
});
