const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const a = require('../dist/index.cjs');
const base = () => a.initialize({title:'Reasoning preferences', steps:[
  {id:'work', title:'Implement change'},
  {id:'review', title:'Review change', kind:'review', depends_on:['work'], checks:['Check correctness']},
]});
function request(p, effort, intent='edit') {
  return {plan_id:p.plan_id, base_revision:p.revision, request_id:'effort-'+p.revision,
    intent, operations:[{type:'set_reasoning_effort', step_id:'work', reasoning_effort:effort}],
    ...(intent==='implement' ? {selected_step_ids:['work']} : {})};
}
test('effort validates without rewriting legacy plans and round-trips all supported preferences', () => {
  const p = base();
  assert.equal(p.steps[0].reasoning_effort, undefined);
  for (const effort of a.REASONING_EFFORTS) {
    const [changed] = a.applyRequest(p, request(p, effort));
    assert.equal(a.loads(a.dumps(changed),p.plan_id).steps[0].reasoning_effort, effort);
    assert.match(a.prNotes(changed), new RegExp('Requested reasoning effort.*'+effort));
  }
  for (const value of ['automatic', '', null, 3, {}]) {
    assert.throws(() => a.applyRequest(p, request(p,value)), /Invalid reasoning effort/);
    assert.throws(() => a.initialize({title:'Invalid',steps:[{title:'Invalid', reasoning_effort:value}]}), /Invalid reasoning effort/);
  }
  const added = a.applyOperations(p,[{type:'add_step',step_id:'extra',title:'Extra',reasoning_effort:'low'}]);
  assert.equal(added.steps.at(-1).reasoning_effort,'low');
});
test('effort edits preserve approval and freshness across card, agent and Markdown edits', () => {
  let p = base();
  [p] = a.applyRequest(p,request(p,'high','implement'));
  const approved = a.clone(p.execution), fingerprint = a.stepFingerprint(p.steps[0]);
  const req = request(p,'medium');
  [p] = a.applyRequest(p,req);
  assert.equal(a.applyRequest(p,req)[1],false);
  assert.deepEqual(p.execution,approved);
  assert.deepEqual(a.stepFingerprint(p.steps[0]),fingerprint);
  [p] = a.editStep(p,p.revision,{action:'update',stepId:'work',fields:{reasoning_effort:'inherit'}});
  assert.deepEqual(p.execution,approved);
  assert.equal(a.nextSteps(p).ready_steps[0].reasoning_effort,'inherit');
  const changed = a.loads(a.dumps(p),p.plan_id); changed.steps[0].reasoning_effort='xhigh';
  p = a.revise(p,changed,p.revision);
  assert.deepEqual(p.execution,approved);
  assert.notEqual(p.steps[1].review_state,'needs_review');
  const review = a.applyOperations(p,[{type:'set_reasoning_effort',step_id:'review',reasoning_effort:'high'}]);
  assert.match(a.reviewBrief(review,'review'), /Requested reasoning effort.*high/);
  assert.throws(()=>a.applyRequest(p,{...req,request_id:"stale-new"}), /Stale/);
});
test('CLI persists effort in Markdown, status, next, and generated context; invalid edits are atomic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-effort-'));
  try {
    const file=path.join(dir,'plan.md'), input=path.join(dir,'fields.json');
    a.saveMarkdown(file,base());
    const cli=path.resolve(__dirname,'../dist/plan.cjs');
    const run=(...args)=>execFileSync(process.execPath,[cli,...args,'--plan',file],{encoding:'utf8',stdio:'pipe'});
    fs.writeFileSync(input,JSON.stringify({reasoning_effort:'high'}));
    run('step','update','--step-id','work','--base-revision','1','--input',input);
    assert.equal(JSON.parse(run('status')).steps[0].reasoning_effort,'high');
    assert.equal(a.read(file).steps[0].reasoning_effort,'high');
    assert.match(fs.readFileSync(path.join(dir,'plan-pr-notes.md'),'utf8'),/Requested reasoning effort.*high/);
    const before=fs.readFileSync(file,'utf8');
    fs.writeFileSync(input,JSON.stringify({reasoning_effort:'invalid'}));
    assert.throws(()=>run('step','update','--step-id','work','--base-revision','2','--input',input));
    assert.equal(fs.readFileSync(file,'utf8'),before);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
