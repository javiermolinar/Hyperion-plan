const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const api=require('../dist/index.cjs'),cli=path.resolve(__dirname,'../dist/plan.cjs');
const step=(id,extra={})=>({id,title:id,status:'pending',comments:[],...extra});
function request(plan,intent,extra={}){return {plan_id:plan.plan_id,base_revision:plan.revision,request_id:intent+'-'+plan.revision,intent,operations:[],...extra};}
function plan(){
 let p=api.initialize({title:'Lifecycle',steps:[step('done',{status:'completed',progress_note:'Verified result.'}),step('active',{status:'in_progress'}),step('pending',{depends_on:['done'],comments:[{id:'note',text:'Retain this constraint',state:'pending'}]})]});
 [p]=api.applyRequest(p,request(p,'implement',{selected_step_ids:['active','pending']}));
 p.steps[1].blocked_by='Needs input';return p;
}
function setup(t,json=false){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const p=path.join(dir,json?'plan.json':'plan.md'),base=plan();if(json)api.atomicWrite(p,base);else api.saveMarkdown(p,base);return {dir,p,base};}
function run(...args){const r=spawnSync(process.execPath,[cli,...args.map(String)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function snapshot(dir){return Object.fromEntries(fs.readdirSync(dir,{recursive:true}).sort().map(name=>{const p=path.join(dir,name),s=fs.statSync(p);return [name,s.isDirectory()?'directory':{bytes:fs.readFileSync(p).toString('base64'),mtime:s.mtimeMs}];}));}

test('finishing preserves actual task history and clears implementation approval',()=>{
 const before=plan(),[closed,changed]=api.setLifecycle(before,before.revision,'finished');
 assert.equal(changed,true);assert.equal(closed.lifecycle,'finished');assert.equal(closed.execution,undefined);
 assert.deepEqual(closed.steps,before.steps);assert.deepEqual(closed.applied_requests,before.applied_requests);
 assert.equal(api.summary(closed).render_policy,'on_request');assert.deepEqual(api.nextSteps(closed).ready_steps,[]);
 assert.equal(before.lifecycle,undefined);assert.equal(api.summary(before).lifecycle,'active');
});
test('empty and fully complete plans can finish without inventing tasks or results',()=>{
 for(const steps of [[],[step('done',{status:'completed'})]]){
  const p=api.initialize({title:'Done',steps}),[closed]=api.setLifecycle(p,p.revision,'finished');
  assert.deepEqual(closed.steps,p.steps);assert.equal(api.summary(closed).render_policy,'on_request');
 }
});
test('lifecycle writes reject stale revisions and invalid states; repeats are unchanged',()=>{
 const p=plan();assert.throws(()=>api.setLifecycle(p,p.revision-1,'finished'),/Stale/);
 assert.throws(()=>api.setLifecycle(p,p.revision,'complete'),/Invalid plan lifecycle/);
 assert.throws(()=>api.validate({...p,lifecycle:null}),/Invalid plan lifecycle/);
 const [closed]=api.setLifecycle(p,p.revision,'finished');assert.deepEqual(api.setLifecycle(closed,closed.revision,'finished'),[closed,false]);
 assert.deepEqual(api.setLifecycle(p,p.revision,'active'),[p,false]);
});
test('finish atomically carries notes and ordering without treating checked work as authorization',()=>{
 const p=plan(),ops=[{type:'reorder_steps',step_ids:['done','pending','active']},{type:'add_comment',step_id:'pending',comment_id:'last-note',text:'Keep the final draft.'}];
 const r=request(p,'finish',{operations:ops}),[closed]=api.applyRequest(p,r);
 assert.deepEqual(closed.steps.map(s=>s.id),['done','pending','active']);assert.equal(closed.steps[1].comments.at(-1).text,'Keep the final draft.');
 assert.equal(closed.steps[1].status,'pending');assert.equal(closed.execution,undefined);
 assert.throws(()=>api.applyRequest(p,{...r,selected_step_ids:['pending']}),/cannot select/);
 assert.throws(()=>api.applyRequest(p,{...r,target_step_ids:['pending']}),/cannot select/);
 assert.throws(()=>api.applyRequest(p,request(p,'finish',{operations:[{type:'remove_step',step_id:'active'}]})),/history/);
 assert.equal(p.steps[2].comments.length,1);
});
test('reopening retains history and requires a fresh implementation selection',()=>{
 const p=plan(),[closed]=api.applyRequest(p,request(p,'finish'));
 const [open]=api.applyRequest(closed,request(closed,'reopen'));
 assert.equal(open.lifecycle,'active');assert.equal(open.execution,undefined);assert.deepEqual(open.steps,p.steps);
 assert.deepEqual(api.nextSteps(open).ready_steps,[]);
 assert.throws(()=>api.checkpoint(open,open.revision,'pending','in_progress'),/No recorded/);
 const [approved]=api.applyRequest(open,request(open,'implement',{selected_step_ids:['pending']}));
 assert.deepEqual(api.nextSteps(approved).ready_steps.map(s=>s.id),['pending']);
 assert.throws(()=>api.applyRequest(closed,request(closed,'reopen',{operations:[{type:'set_status',step_id:'pending',status:'completed'}]})),/before submitting edits/);
});
test('late identical request retries never close, reopen, or reapprove the current plan again',()=>{
 const p=plan(),finish=request(p,'finish'),[closed]=api.applyRequest(p,finish),reopen=request(closed,'reopen'),[open]=api.applyRequest(closed,reopen);
 assert.deepEqual(api.applyRequest(open,finish),[open,false]);
 const [closedAgain]=api.applyRequest(open,request(open,'finish'));
 assert.deepEqual(api.applyRequest(closedAgain,reopen),[closedAgain,false]);
 assert.throws(()=>api.applyRequest(closedAgain,{...finish,request_id:'new-stale-id'}),/Stale/);
 assert.throws(()=>api.applyRequest(closedAgain,{...finish,operations:[{type:'set_status',step_id:'pending',status:'completed'}]}),/reused/);
});
test('finished plans reject other mutations including scope reapproval and metadata replacement',()=>{
 const p=plan(),[closed]=api.setLifecycle(p,p.revision,'finished');
 for(const intent of ['edit','implement','review','decompose','replan'])
  assert.throws(()=>api.applyRequest(closed,request(closed,intent,{operations:[{type:'add_comment',step_id:'pending',comment_id:'x',text:'x'}],...(intent==='implement'?{selected_step_ids:['pending']}:{})})),/Reopen/);
 assert.throws(()=>api.editStep(closed,closed.revision,{action:'update',stepId:'pending',fields:{title:'Changed'}}),/Reopen/);
 assert.throws(()=>api.editNote(closed,closed.revision,{action:'add',stepId:'pending',noteId:'x',text:'x'}),/Reopen/);
 assert.throws(()=>api.checkpoint(closed,closed.revision,null,null,null,null,'approved'),/Reopen/);
 assert.throws(()=>api.reviewStep(closed,closed.revision,'pending','current','Checked'),/Reopen/);
 assert.throws(()=>api.revise(closed,{...closed,lifecycle:'active'},closed.revision),/Reopen/);
 assert.throws(()=>api.revise(p,{...p,lifecycle:'finished'},p.revision),/Use finish or reopen/);
});
for(const json of [false,true])test(`CLI finish/reopen persists and dry runs write nothing (${json?'JSON':'Markdown'})`,t=>{
 const f=setup(t,json),before=snapshot(f.dir);
 const preview=run('finish','--plan',f.p,'--base-revision',f.base.revision,'--dry-run');
 assert.equal(preview.changes.plan_fields.lifecycle.after,'finished');assert.equal(preview.changes.execution.after,null);assert.deepEqual(snapshot(f.dir),before);
 const result=run('finish','--plan',f.p,'--base-revision',f.base.revision);assert.equal(result.lifecycle,'finished');assert.equal(result.render_policy,'on_request');
 const closed=api.read(f.p);assert.deepEqual(closed.steps,f.base.steps);assert.equal(closed.execution,undefined);
 assert.equal(run('status','--plan',f.p).lifecycle,'finished');assert.equal(run('next','--plan',f.p).ready_steps.length,0);
 assert.match(fs.readFileSync(api.notesPath(f.p),'utf8'),/Plan finished/);
 const after=snapshot(f.dir);run('reopen','--plan',f.p,'--base-revision',closed.revision,'--dry-run');assert.deepEqual(snapshot(f.dir),after);
 const reopened=run('reopen','--plan',f.p,'--base-revision',closed.revision);assert.equal(reopened.lifecycle,'active');assert.equal(api.read(f.p).execution,undefined);
 assert.deepEqual(api.read(f.p).steps,f.base.steps);
});
test('external edits to finished Markdown retain closure and do not revive approval',t=>{
 const f=setup(t),[closed]=api.setLifecycle(f.base,f.base.revision,'finished');api.saveMarkdown(f.p,closed);
 fs.writeFileSync(f.p,fs.readFileSync(f.p,'utf8').replace('# Lifecycle','# Finished history'));
 const status=run('status','--plan',f.p);assert.equal(status.lifecycle,'finished');assert.equal(status.render_policy,'on_request');assert.equal(status.execution,null);
 assert.equal(api.read(f.p).title,'Finished history');
});
test('interrupted finish cannot recover old approval from its previous sidecar',t=>{
 const f=setup(t),[closed]=api.setLifecycle(f.base,f.base.revision,'finished');
 assert.throws(()=>api.saveMarkdown(f.p,closed,undefined,()=>{throw Error('simulated interruption');}),/interruption/);
 const [loaded,dirty]=api.loadMarkdown(f.p);assert.equal(dirty,true);assert.equal(loaded.lifecycle,'finished');assert.equal(loaded.execution,undefined);
 const status=run('status','--plan',f.p);assert.equal(status.execution,null);assert.deepEqual(status.steps.map(s=>s.status),f.base.steps.map(s=>s.status));
});
test('direct Markdown closure withholds work and finished JSON cannot report ready work',t=>{
 const f=setup(t),direct={...f.base,lifecycle:'finished'};fs.writeFileSync(f.p,api.dumps(direct));
 assert.equal(run('status','--plan',f.p).execution,null);
 const n=api.nextSteps(direct);assert.deepEqual(n.ready_steps,[]);assert.deepEqual(n.in_progress_steps,[]);assert.ok(n.blocked_steps.every(s=>s.reasons.some(r=>r.includes('finished'))));
});
