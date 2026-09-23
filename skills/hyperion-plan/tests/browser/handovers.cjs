const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs');
const dir=createScratch(),errors=[];
let plan=api.initialize({title:'Migrate service safely',steps:[{id:'done',title:'Prepare service',status:'completed',handover_after:'Service foundation is ready.'},{id:'active',title:'Implement migration'},{id:'later',title:'Verify rollback',depends_on:['active']}]});
[plan]=api.applyRequest(plan,{plan_id:plan.plan_id,request_id:'approve',base_revision:plan.revision,intent:'implement',operations:[],selected_step_ids:['active','later']});
[plan]=api.checkpoint(plan,plan.revision,'active','in_progress','Migration logic is partly written.');
const canonical=path.join(dir,'plan.md');api.saveMarkdown(canonical,plan);
function render(name,p=plan,preview=false){fs.writeFileSync(path.join(dir,name+'.html'),api.render(p,canonical,preview));}
render('active');render('preview',plan,true);
const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try{
 const v=await createView(browser,errors,dir,{file:'active.html'});
 assert.equal(await v.ui.locator('.pc-handover-point').count(),1);
 // A marker is only a draft edit; it does not launch a task or alter selection.
 await v.ui.locator('[data-step="active"] .pc-more').click();await v.ui.locator('[data-step="active"] .pc-add-handover').click();
 assert.equal(await v.ui.locator('.pc-handover-step').count(),1);
 assert.equal(await v.frame.evaluate(()=>window.__calls.length),0);
 await v.ui.locator('[data-step="active"] input[type=checkbox]').check();
 await v.ui.locator('[data-step="active"] .pc-more').click();await v.ui.locator('[data-step="active"] .pc-step-handover').click();assert.match(await v.ui.locator('.pc-handover-dialog').textContent(),/during “Implement migration”/);
 await v.ui.locator('.pc-handover-reason').fill('Context pressure midway through migration');
 await v.frame.evaluate(()=>window.__fail=true);await v.ui.locator('.pc-start-handover').click();
 const firstCall=(await v.frame.evaluate(()=>window.__calls)).at(-1),first=decode(firstCall);
 assert.equal(first.intent,'handover');assert.deepEqual(first.target_step_ids,['active']);assert.equal(first.selected_step_ids,undefined);
 assert.equal(first.operations.find(o=>o.type==='add_step').kind,'handover');assert.match(firstCall.prompt,/same working checkout/);
 const saved=await v.frame.evaluate(()=>window.__saved);
 const retry=await createView(browser,errors,dir,{file:'active.html',saved});
 await retry.ui.locator('[data-step="active"] .pc-more').click();await retry.ui.locator('[data-step="active"] .pc-step-handover').click();assert.equal(await retry.ui.locator('.pc-handover-reason').inputValue(),first.handover_reason);
 await retry.ui.locator('.pc-start-handover').click();assert.equal(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)).request_id,first.request_id);
 // Apply exact submitted request through the real CLI, then render observed state.
 const input=path.join(dir,'request.json');fs.writeFileSync(input,JSON.stringify(first));execFileSync(process.execPath,[helper,'apply','--plan',canonical,'--request',input]);
 let current=api.read(canonical);assert.equal(current.steps[1].status,'in_progress');assert.deepEqual(current.execution,plan.execution);
 render('requested',current);
 const requested=await createView(browser,errors,dir,{file:'requested.html'});assert.equal(await requested.ui.locator('.pc-checkpoint-handover').count(),0);
 await requested.ui.locator('[data-step="active"] input[type=checkbox]').check();assert.equal(await requested.ui.locator('.pc-implement').isDisabled(),true);
 [current]=api.updateHandover(current,current.revision,{request_id:first.request_id,state:'prepared',brief_path:path.join(dir,'brief.md'),summary:'Migration logic written; validation pending.',next_action:'Run rollback tests.',code_state:'Checkout /repo, HEAD abc123; local migration.ts edits; unit tests passed.'},'source');
 [current]=api.updateHandover(current,current.revision,{request_id:first.request_id,state:'transferred',destination_task_id:'destination'},'source');
 render('transferred',current);const [finished]=api.setLifecycle(current,current.revision,'finished');render('finished',finished);
 const f=await createView(browser,errors,dir,{file:'finished.html'});assert.equal(await f.ui.locator('.pc-handover-event').count(),1);assert.equal(await f.ui.locator('.pc-handover').count(),0);
 const preview=await createView(browser,errors,dir,{file:'preview.html'});await preview.ui.locator('[data-step="active"] .pc-more').click();await preview.ui.locator('[data-step="active"] .pc-step-handover').click();await preview.ui.locator('.pc-start-handover').click();assert.equal(await preview.frame.evaluate(()=>window.__calls.length),0);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){
  const result=await createView(browser,errors,dir,{file:'transferred.html',width,theme});
  await result.ui.locator('.pc-handover-event summary').click();
  assert.match(await result.ui.locator('.pc-handover-event').textContent(),/during “Implement migration” · transferred/);
  assert.match(await result.ui.locator('[data-step="active"] .pc-handover-inline').textContent(),/during/);
  assert.equal(await result.ui.getByRole('link',{name:'Continue in task'}).getAttribute('href'),'codex://threads/destination');
  assert.equal(await result.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  await result.page.screenshot({path:`/tmp/hyperion-handover-event-${width}-${theme}.png`});
  await result.ui.locator('[data-step="active"] .pc-more').click();await result.ui.locator('[data-step="active"] .pc-step-handover').click();
  assert.equal(await result.ui.locator('.pc-handover-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);
  await result.page.screenshot({path:`/tmp/hyperion-handover-dialog-${width}-${theme}.png`});
 }
 assert.deepEqual(errors,[]);console.log('PASS: handover markers, mid-step requests, draft/retry restoration, CLI persistence, ownership events, finished/preview isolation and responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
