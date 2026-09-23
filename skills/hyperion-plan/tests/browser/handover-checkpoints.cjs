const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const a=require('../../dist/index.cjs');
const dir=createScratch(),errors=[];
const make=done=>a.initialize({title:'Delivery phases',steps:[
 {id:'phase-one',title:'Implement and verify storage',status:done?'completed':'pending',reasoning_effort:'high'},
 {id:'boundary',kind:'handover',title:'Fresh context for the API phase',description:'Carry the verified storage contract and decisions into the next phase.'},
 {id:'phase-two',title:'Build the API',reasoning_effort:'medium'},
]});
const p=make(true),canonical=path.join(dir,'plan.md');a.saveMarkdown(canonical,p);
const render=(file,plan,preview=false)=>fs.writeFileSync(path.join(dir,file),a.render(plan,canonical,preview));
render('ready.html',p);render('blocked.html',make(false));render('preview.html',p,true);
const decode=c=>JSON.parse(c.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try{
 const v=await createView(browser,errors,dir,{file:'ready.html',expanded:['boundary']});
 assert.equal(await v.ui.locator('.pc-plan-actions .pc-handover').count(),0);
 assert.equal(await v.ui.locator('[data-step="boundary"] input[type=checkbox]').count(),0);
 assert.equal(await v.ui.locator('[data-step="boundary"] input[type=range]').count(),0);
 assert.equal(await v.ui.locator('.pc-checkpoint-handover').count(),0);
 assert.match(await v.ui.locator('[data-step="boundary"] .pc-automatic-handover').textContent(),/Automatic/);
 assert.equal(await v.ui.locator('[data-step="phase-two"] input[type=checkbox]').isEnabled(),true);
 await v.ui.locator('[data-step="phase-two"] input[type=checkbox]').check();
 await v.frame.evaluate(()=>window.__fail=true);await v.ui.locator('.pc-implement').click();
 const call=(await v.frame.evaluate(()=>window.__calls)).at(-1),first=decode(call);
 assert.deepEqual(first.selected_step_ids,['phase-two']);assert.equal(first.intent,'implement');
 assert.match(call.prompt,/explicitly requests fresh Codex tasks at the automatic handover checkpoints/);
 const saved=await v.frame.evaluate(()=>window.__saved);
 const retry=await createView(browser,errors,dir,{file:'ready.html',saved});
 await retry.ui.locator('.pc-implement').click();
 assert.equal(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)).request_id,first.request_id);
 const input=path.join(dir,'request.json');fs.writeFileSync(input,JSON.stringify(first));execFileSync(process.execPath,[helper,'apply','--plan',canonical,'--request',input]);
 let current=a.read(canonical);
 assert.deepEqual(current.execution.selected_step_ids,['boundary','phase-two']);
 assert.deepEqual(a.nextSteps(current).ready_handover_steps.map(s=>s.id),['boundary']);
 assert.equal(a.nextSteps(current).ready_steps.length,0);
 // Simulate the executor reaching the boundary under the existing run authorization.
 const handover={plan_id:current.plan_id,request_id:'automatic-boundary',base_revision:current.revision,intent:'handover',operations:[],target_step_ids:['boundary']};
 [current]=a.applyRequest(current,handover);assert.equal(current.steps[1].status,'in_progress');
 [current]=a.updateHandover(current,current.revision,{request_id:handover.request_id,state:'prepared',brief_path:'/tmp/brief.md',summary:'Storage validated.',next_action:'Select API work.',code_state:'Same checkout; tests passed.'},'source');
 [current]=a.updateHandover(current,current.revision,{request_id:handover.request_id,state:'transferred',destination_task_id:'destination'},'source');
 render('transferred.html',current);
 const transferred=await createView(browser,errors,dir,{file:'transferred.html'});
 assert.equal(await transferred.ui.locator('[data-step="boundary"] .pc-completed-icon').count(),1);
 assert.equal(await transferred.ui.locator('[data-step="phase-two"] input[type=checkbox]').isEnabled(),true);
 await transferred.ui.locator('.pc-handover-event summary').click();
 assert.equal(await transferred.ui.getByRole('link',{name:'Continue in task'}).getAttribute('href'),'codex://threads/destination');
 const blocked=await createView(browser,errors,dir,{file:'blocked.html'});
 assert.equal(await blocked.ui.locator('.pc-checkpoint-handover').count(),0);
 await blocked.ui.locator('.pc-select-all').click();
 assert.deepEqual((await blocked.frame.evaluate(()=>window.__saved)).modelContent.selected_step_ids,['phase-one','phase-two']);
 // Moving a pending boundary relocates it; removing it is an edit, never execution.
 await blocked.ui.locator('[data-step="boundary"] .pc-drag').press('ArrowDown');
 assert.deepEqual(await blocked.ui.locator('.pc-row').evaluateAll(es=>es.map(e=>e.dataset.step)),['phase-one','phase-two','boundary']);
 await blocked.ui.locator('[data-step="boundary"] .pc-more').click();await blocked.ui.locator('[data-step="boundary"] .pc-remove').click();
 assert.equal(await blocked.ui.locator('.pc-handover-step').count(),0);
 await blocked.ui.locator('.pc-undo').click();assert.equal(await blocked.ui.locator('.pc-handover-step').count(),1);
 await blocked.ui.locator('[data-step="phase-two"] .pc-more').click();await blocked.ui.locator('[data-step="phase-two"] .pc-add-handover').click();
 assert.equal(await blocked.ui.locator('.pc-handover-step').count(),2);
 await blocked.ui.locator('.pc-apply').click();const edits=decode((await blocked.frame.evaluate(()=>window.__calls)).at(-1));
 assert.equal(edits.intent,'edit');assert.ok(edits.operations.some(o=>o.type==='add_step'&&o.kind==='handover'));
 // A cancelled terminal checkpoint can be reauthorized through the existing run button.
 let terminal=a.initialize({title:'Final handover',steps:[
  {id:'done',title:'Finished work',status:'completed'},
  {id:'end',title:'Final handover',kind:'handover'},
 ]});
 [terminal]=a.applyRequest(terminal,{plan_id:terminal.plan_id,base_revision:terminal.revision,request_id:'terminal-handover',intent:'handover',operations:[],target_step_ids:['end']});
 render('terminal-active.html',terminal);
 const active=await createView(browser,errors,dir,{file:'terminal-active.html'});
 assert.equal(await active.ui.locator('.pc-implement').isDisabled(),true);
 [terminal]=a.updateHandover(terminal,terminal.revision,{request_id:'terminal-handover',state:'cancelled',note:'Retry later'},'source');
 render('terminal-retry.html',terminal);
 const terminalView=await createView(browser,errors,dir,{file:'terminal-retry.html'});
 assert.equal(await terminalView.ui.locator('input[type=checkbox]').count(),0);
 assert.equal(await terminalView.ui.locator('.pc-implement').textContent(),'Continue plan');
 await terminalView.frame.evaluate(()=>window.__fail=true);
 await terminalView.ui.locator('.pc-implement').click();
 const terminalRequest=decode((await terminalView.frame.evaluate(()=>window.__calls)).at(-1));
 assert.deepEqual(terminalRequest.selected_step_ids,['end']);
 const terminalSaved=await terminalView.frame.evaluate(()=>window.__saved);
 const terminalReload=await createView(browser,errors,dir,{file:'terminal-retry.html',saved:terminalSaved});
 await terminalReload.ui.locator('.pc-implement').click();
 assert.equal(decode((await terminalReload.frame.evaluate(()=>window.__calls)).at(-1)).request_id,terminalRequest.request_id);
 const [reauthorized]=a.applyRequest(terminal,terminalRequest);
 assert.deepEqual(a.nextSteps(reauthorized).ready_handover_steps.map(s=>s.id),['end']);
 const held=a.clone(terminal);held.steps[1].blocked_by='Wait for destination';render('terminal-held.html',held);
 const heldView=await createView(browser,errors,dir,{file:'terminal-held.html'});
 assert.equal(await heldView.ui.locator('.pc-implement').isDisabled(),true);
 const partial=a.initialize({title:'Partial work',steps:[{id:'a',title:'A'},{id:'b',title:'B'},{id:'h',title:'Handover',kind:'handover'}]});
 render('partial.html',partial);
 const partialView=await createView(browser,errors,dir,{file:'partial.html'});
 await partialView.ui.locator('[data-step="b"] input[type=checkbox]').check();
 await partialView.ui.locator('.pc-implement').click();
 const partialRequest=decode((await partialView.frame.evaluate(()=>window.__calls)).at(-1));
 assert.deepEqual(a.applyRequest(partial,partialRequest)[0].execution.selected_step_ids,['b']);
 const preview=await createView(browser,errors,dir,{file:'preview.html'});
 await preview.ui.locator('[data-step="phase-two"] input[type=checkbox]').check();await preview.ui.locator('.pc-implement').click();assert.equal(await preview.frame.evaluate(()=>window.__calls.length),0);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){
  const view=await createView(browser,errors,dir,{file:'ready.html',width,theme,expanded:['boundary']});
  assert.equal(await view.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  await view.ui.locator('section').screenshot({path:`/tmp/hyperion-checkpoint-${width}.png`});
 }
 assert.deepEqual(errors,[]);console.log('PASS: automatic in-sequence handover authorization, execution barrier, retry, transfer, add/move/remove/undo, and responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
