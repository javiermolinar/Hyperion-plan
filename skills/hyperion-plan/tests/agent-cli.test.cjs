const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const api=require('../dist/index.cjs'),cli=path.resolve(__dirname,'../dist/plan.cjs');
const step=(id,extra={})=>({id,title:id,status:'pending',comments:[],...extra});
function setup(t,{markdown=true,approve=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-agent-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let plan=api.initialize({title:'Agent commands',steps:[step('done',{status:'completed'}),
  step('a',{description:'Full description.',done_when:'Observable result.',depends_on:['done']}),
  step('b',{depends_on:['a'],comments:[{id:'constraint',text:'Keep Unicode café 🐛 and `literal` text.',state:'pending'}]}),
  step('c'),step('active',{status:'in_progress'}),
  step('review',{kind:'review',depends_on:['a'],run_after:'b',checks:['Inspect A.']}),step('spare')]});
 if(approve)[plan]=api.applyRequest(plan,{plan_id:plan.plan_id,base_revision:plan.revision,request_id:'approve',intent:'implement',operations:[],selected_step_ids:['c','a','b','active','review']});
 const p=path.join(dir,markdown?'plan.md':'plan.json');
 if(markdown)api.saveMarkdown(p,plan);else api.atomicWrite(p,plan);
 return {dir,p,read:()=>api.read(p),json:(name,value)=>{const f=path.join(dir,name);fs.writeFileSync(f,JSON.stringify(value));return f;}};
}
function exec(args){return spawnSync(process.execPath,[cli,...args.map(String)],{encoding:'utf8'});}
function run(...args){const r=exec(args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function fail(...args){const r=exec(args);assert.notEqual(r.status,0,r.stdout);return r.stderr;}
function snapshot(dir){const result={};for(const name of fs.readdirSync(dir,{recursive:true}).sort()){const p=path.join(dir,name),s=fs.statSync(p);result[name]=s.isDirectory()?'directory':{bytes:fs.readFileSync(p).toString('base64'),mtime:s.mtimeMs};}return result;}
function edit(f,group,action,id,...args){return run(group,action,'--plan',f.p,'--base-revision',f.read().revision,'--step-id',id,...args);}

test('show exposes full step context without touching storage; rejects unstable/unknown IDs',t=>{
 const f=setup(t),before=snapshot(f.dir);
 const full=run('show','--plan',f.p),one=run('show','--plan',f.p,'--step-id','a');
 assert.equal(full.plan.steps[1].description,'Full description.');assert.equal(one.step.done_when,'Observable result.');
 assert.equal(full.plan.steps[2].comments[0].id,'constraint');assert.equal(full.plan.applied_requests,undefined);
 assert.equal(one.refresh_required,false);assert.match(fail('show','--plan',f.p,'--step-id','15'),/Unknown step/);
 assert.deepEqual(snapshot(f.dir),before);
});
test('next lists only approved immediately ready work in plan order, separating active work and blockers',t=>{
 const f=setup(t),before=snapshot(f.dir),next=run('next','--plan',f.p);
 assert.deepEqual(next.ready_steps.map(s=>s.id),['a','c']);assert.deepEqual(next.in_progress_steps.map(s=>s.id),['active']);
 assert.deepEqual(next.blocked_steps.map(s=>s.step.id),['b','review']);assert.deepEqual(next.blocked_steps[1].prerequisite_ids,['a','b']);
 assert.deepEqual(next.unselected_step_ids,['spare']);assert.deepEqual(snapshot(f.dir),before);
});
for(const state of ['paused','cancelled'])test(`next cannot resume ${state} execution`,t=>{
 const f=setup(t),p=f.read();p.execution.state=state;api.saveMarkdown(f.p,p);
 const before=snapshot(f.dir),n=run('next','--plan',f.p);
 assert.deepEqual(n.ready_steps,[]);assert.deepEqual(n.in_progress_steps,[]);assert.ok(n.blocked_steps.every(s=>s.reasons.includes('Execution is '+state)));
 assert.deepEqual(snapshot(f.dir),before);
});
test('next requires prior approval and reports stale scopes and explicit blockers',t=>{
 const f=setup(t,{approve:false});assert.deepEqual(run('next','--plan',f.p).ready_steps,[]);
 let p=f.read();[p]=api.applyRequest(p,{plan_id:p.plan_id,base_revision:p.revision,request_id:'go',intent:'implement',operations:[],selected_step_ids:['a','c']});
 p.steps.find(s=>s.id==='a').blocked_by='Awaiting input';Object.assign(p.steps.find(s=>s.id==='c'),{review_state:'needs_review',review_note:'Changed interface'});api.saveMarkdown(f.p,p);
 const n=run('next','--plan',f.p);assert.deepEqual(n.ready_steps.map(s=>s.id),["c"]);assert.match(JSON.stringify(n.blocked_steps),/Awaiting input/);assert.equal(n.ready_steps[0].review_note,"Changed interface");
});
test('step update previews and applies the same scope invalidation without altering unrelated steps',t=>{
 const f=setup(t),old=f.read(),before=snapshot(f.dir);
 const preview=edit(f,'step','update','a','--description','New interface.','--dry-run');
 assert.equal(preview.result,'preview');assert.equal(preview.proposed_revision,old.revision+1);assert.deepEqual(snapshot(f.dir),before);
 assert.ok(!preview.changes.execution.after.selected_step_ids.includes('a'));
 assert.ok(preview.changes.updated_steps.some(s=>s.step_id==='b' && s.fields.review_state.after==='needs_review'));
 const result=edit(f,'step','update','a','--description','New interface.');assert.deepEqual(result.changes,preview.changes);
 const saved=f.read();assert.equal(saved.steps[1].description,'New interface.');assert.deepEqual(saved.steps.find(s=>s.id==='c'),old.steps.find(s=>s.id==='c'));
 assert.deepEqual(saved.applied_requests,old.applied_requests);assert.equal(saved.execution.state,'approved');
 assert.match(fs.readFileSync(api.notesPath(f.p),'utf8'),/New interface/);
 const after=snapshot(f.dir);assert.match(fail('step','update','--plan',f.p,'--base-revision',old.revision,'--step-id','a','--title','Stale'),/Stale plan/);
 assert.deepEqual(snapshot(f.dir),after);
 run('review','--plan',f.p,'--base-revision',saved.revision,'--step-id','a','--state','current','--note','Scope checked.');
 assert.match(fail('checkpoint','--plan',f.p,'--base-revision',f.read().revision,'--step-id','a','--status','in_progress'),/outside the recorded/);
});
test('no-op step updates preserve revision and execution approval',t=>{
 const f=setup(t),before=f.read();const result=edit(f,'step','update','a','--title','a');
 assert.equal(result.result,'unchanged');assert.deepEqual(f.read(),before);
});
test('step edits reject state/identity injection and invalid dependency graphs',t=>{
 const f=setup(t);
 for(const patch of [{status:'completed'},{id:'changed'},{comments:[]},{execution:{}},{depends_on:['missing']},{depends_on:['b']}]){
  const input=f.json('patch.json',patch),before=f.read();
  assert.match(fail('step','update','--plan',f.p,'--base-revision',before.revision,'--step-id','a','--input',input),/Unsupported step field|Unknown prerequisite|cycle/);
  assert.deepEqual(f.read(),before);
 }
});
test('add accepts structured review fields and placement without granting execution authority',t=>{
 const f=setup(t);const input=f.json('fields.json',{kind:'review',title:'Review C',depends_on:['c'],run_after:'c',checks:['Inspect C'],complexity:'low',complexity_reason:'Narrow check.'});
 const before=f.read().execution;edit(f,'step','add','review-c','--input',input,'--after','c');
 const p=f.read(),index=p.steps.findIndex(s=>s.id==='c');assert.equal(p.steps[index+1].id,'review-c');assert.equal(p.steps[index+1].status,'pending');assert.deepEqual(p.execution,before);
 assert.match(fail('step','add','--plan',f.p,'--base-revision',p.revision,'--step-id','review-c','--title','Duplicate'),/already exists/);
});
test('move preserves review scope/timing and approval; invalid movement and protected rows are rejected',t=>{
 const f=setup(t),before=f.read();edit(f,'step','move','spare','--before','review');
 assert.deepEqual(f.read().steps.find(s=>s.id==='review'),before.steps.find(s=>s.id==='review'));assert.deepEqual(f.read().execution,before.execution);
 edit(f,'step','move','review','--after','spare');
 for(const [id,target] of [['b','a'],['review','b'],['done','a'],['active','a']]){
  const p=f.read();assert.match(fail('step','move','--plan',f.p,'--base-revision',p.revision,'--step-id',id,'--before',target),/Keep|Only pending/);assert.deepEqual(f.read(),p);
 }
 assert.match(fail('step','move','--plan',f.p,'--base-revision',f.read().revision,'--step-id','spare'),/needs --before or --after/);
});
test('remove protects active/completed history and referenced pending steps',t=>{
 const f=setup(t);
 for(const id of ['done','active','a']){const before=f.read();assert.match(fail('step','remove','--plan',f.p,'--base-revision',before.revision,'--step-id',id),/history|prerequisite/);assert.deepEqual(f.read(),before);}
 edit(f,'step','remove','spare');assert.ok(!f.read().steps.some(s=>s.id==='spare'));
});
test('note add/reply preserves literal text, acknowledges only the addressed note, and previews scope effects',t=>{
 const f=setup(t),text='Two lines\nwith `backticks`, $(literal), café 🐛.';const file=path.join(f.dir,'note.txt');fs.writeFileSync(file,text);
 edit(f,'note','add','c','--note-id','new-note','--text-file',file);
 assert.equal(f.read().steps.find(s=>s.id==='c').comments[0].text,text);
 const before=snapshot(f.dir);const preview=edit(f,'note','reply','b','--note-id','constraint','--text','Addressed.','--dry-run');
 assert.deepEqual(snapshot(f.dir),before);assert.ok(!preview.changes.execution.after.selected_step_ids.includes('b'));
 const result=edit(f,'note','reply','b','--note-id','constraint','--text','Addressed.');assert.deepEqual(result.changes,preview.changes);
 const n=f.read().steps.find(s=>s.id==='b').comments[0];assert.equal(n.text,'Keep Unicode café 🐛 and `literal` text.');assert.equal(n.state,'acknowledged');assert.equal(n.response,'Addressed.');
 assert.match(fs.readFileSync(api.notesPath(f.p),'utf8'),/Addressed\./);
 assert.match(fail('note','reply','--plan',f.p,'--base-revision',f.read().revision,'--step-id','b','--note-id','missing','--text','Oops'),/Unknown note/);
});
test('dry-run apply does not consume receipts or authorize work; retry after actual apply stays idempotent',t=>{
 const f=setup(t,{approve:false}),p=f.read();
 const request=f.json('request.json',{plan_id:p.plan_id,base_revision:p.revision,request_id:'explicit-approval',intent:'implement',operations:[],selected_step_ids:['a']});
 const before=snapshot(f.dir);const preview=run('apply','--plan',f.p,'--request',request,'--dry-run');assert.equal(preview.changes.execution.after.state,'approved');assert.deepEqual(snapshot(f.dir),before);
 run('apply','--plan',f.p,'--request',request);assert.equal(run('apply','--plan',f.p,'--request',request).result,'already_applied');
});
test('dry-run revise, checkpoint, freshness review and init do not write any files',t=>{
 const f=setup(t),p=f.read(),draft=api.clone(p);draft.steps[1].title='Proposed title';draft.title='Proposed plan title';
 const replacement=f.json('replacement.json',draft),initial=f.json('initial.json',{title:'New',steps:[step('new')]});
 const before=snapshot(f.dir);
 const revised=run('revise','--plan',f.p,'--base-revision',p.revision,'--input',replacement,'--dry-run');
 assert.deepEqual(revised.changes.plan_fields.title,{before:p.title,after:'Proposed plan title'});
 run('checkpoint','--plan',f.p,'--base-revision',p.revision,'--step-id','a','--status','completed','--note','Verified.','--dry-run');
 run('review','--plan',f.p,'--base-revision',p.revision,'--step-id','a','--state','needs_review','--note','Changed API.','--dry-run');
 run('init','--plan',path.join(f.dir,'absent','new.md'),'--input',initial,'--dry-run');
 assert.deepEqual(snapshot(f.dir),before);
});
test('show/next/dry-run do not normalize plain Markdown or refresh externally edited storage',t=>{
 const f=setup(t);fs.appendFileSync(f.p,'\n');const before=snapshot(f.dir);
 const shown=run('show','--plan',f.p);assert.equal(shown.refresh_required,true);
 const next=run('next','--plan',f.p);assert.deepEqual(next.ready_steps,[]);assert.ok(next.blocked_steps.every(s=>s.reasons.some(r=>r.includes('Refresh external'))));
 run('step','update','--plan',f.p,'--base-revision',shown.revision,'--step-id','a','--title','Preview','--dry-run');
 assert.deepEqual(snapshot(f.dir),before);
 const plain=path.join(f.dir,'plain.md');fs.writeFileSync(plain,'# Plain\n\n- [ ] Simple\n');const plainBefore=snapshot(f.dir);
 assert.equal(run('show','--plan',plain).refresh_required,true);run('next','--plan',plain);assert.deepEqual(snapshot(f.dir),plainBefore);
});
test('legacy JSON and redirects support the same targeted commands',t=>{
 const f=setup(t,{markdown:false});edit(f,'step','update','a','--done-when','JSON works');
 const md=path.join(f.dir,'migrated.md');run('migrate','--plan',f.p,'--output',md);
 const rev=run('show','--plan',f.p).revision;run('note','reply','--plan',f.p,'--base-revision',rev,'--step-id','b','--note-id','constraint','--text','Redirect works');
 assert.equal(api.read(md).steps.find(s=>s.id==='b').comments[0].response,'Redirect works');
});
test('active/completed reviews retain their inspection scope under targeted edits',t=>{
 const f=setup(t),p=f.read();p.steps.find(s=>s.id==='review').status='in_progress';api.saveMarkdown(f.p,p);
 const input=f.json('review-patch.json',{depends_on:['c']});assert.match(fail('step','update','--plan',f.p,'--base-revision',p.revision,'--step-id','review','--input',input),/Preserve the scope/);
});
test('command help is specific and invalid subcommands/options fail without plan writes',t=>{
 const f=setup(t),before=snapshot(f.dir);const help=exec(['step','move','--help']);assert.equal(help.status,0);assert.match(help.stdout,/--before/);assert.match(help.stdout,/--base-revision/);assert.doesNotMatch(help.stdout,/--text-file/);
 assert.match(exec(['note','reply','--help']).stdout,/--note-id/);assert.match(exec(['apply','--help']).stdout,/--dry-run/);
 assert.match(fail('step','unknown','--help'),/Unknown command/);assert.match(fail('show','--plan',f.p,'--made-up'),/Unknown option/);assert.deepEqual(snapshot(f.dir),before);
});
test('untyped library callers cannot turn an unknown action into a removal or reply',t=>{
 const f=setup(t),p=f.read(),before=api.clone(p);
 assert.throws(()=>api.editStep(p,p.revision,{action:'typo',stepId:'spare'}),/Unknown step action/);
 assert.throws(()=>api.editNote(p,p.revision,{action:'typo',stepId:'b',noteId:'constraint',text:'Incorrect reply'}),/Unknown note action/);
 assert.deepEqual(p,before);
});
