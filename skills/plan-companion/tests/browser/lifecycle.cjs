const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs');
const dir=createScratch(),errors=[];
const p=path.join(dir,'plan.md');
const step=(id,extra={})=>({id,title:id,status:'pending',comments:[],...extra});
const base=api.initialize({title:'Finish planning',steps:[step('done',{status:'completed'}),step('pending',{depends_on:['done']}),step('spare')]});
api.saveMarkdown(p,base);
function render(file,preview=false){fs.writeFileSync(path.join(dir,file),api.render(api.read(p),p,preview));}
function decode(call){return JSON.parse(call.prompt.split('Change request JSON:\n')[1]);}
function apply(request){const input=path.join(dir,'request.json');fs.writeFileSync(input,JSON.stringify(request));return JSON.parse(execFileSync(process.execPath,[helper,'apply','--plan',p,'--request',input],{encoding:'utf8'}));}
(async()=>{const browser=await launch();try{
 render('active.html');
 const active=await createView(browser,errors,dir,{file:'active.html',expanded:['pending']});
 assert.equal(await active.ui.locator('.pc-lifecycle').isEnabled(),true);
 await active.ui.locator('[data-step="pending"] input[type=checkbox]').check();
 await active.ui.getByRole('textbox',{name:'Note for: pending'}).fill('Keep my final note.');
 await active.ui.locator('[data-step="pending"] .pc-drag').press('ArrowDown');
 assert.equal(await active.ui.locator('.pc-lifecycle').textContent(),'Save & finish plan');
 await active.frame.evaluate(()=>window.__fail=true);
 await active.ui.locator('.pc-lifecycle').click();
 const firstCall=await active.frame.evaluate(()=>window.__calls.at(-1)),first=decode(firstCall);
 assert.equal(first.intent,'finish');assert.equal(first.selected_step_ids,undefined);
 assert.ok(first.operations.some(op=>op.type==='add_comment'));assert.ok(first.operations.some(op=>op.type==='reorder_steps'));
 assert.match(firstCall.prompt,/do not render another card/);assert.match(await active.ui.locator('.pc-status').textContent(),/not confirmed/);
 const saved=await active.frame.evaluate(()=>window.__savedState);
 const retry=await createView(browser,errors,dir,{file:'active.html',saved});
 assert.equal(await retry.ui.getByRole('textbox',{name:'Note for: pending'}).inputValue(),'Keep my final note.');
 await retry.ui.locator('.pc-lifecycle').click();
 const request=decode(await retry.frame.evaluate(()=>window.__calls.at(-1)));
 assert.deepEqual(request,first);assert.equal(api.read(p).lifecycle,undefined,'Host call alone does not close disk state');
 assert.equal(apply(request).lifecycle,'finished');assert.equal(apply(request).result,'already_applied');
 const closed=api.read(p);assert.equal(closed.execution,undefined);assert.deepEqual(closed.steps.map(s=>[s.id,s.status]),[['done','completed'],['spare','pending'],['pending','pending']]);assert.equal(closed.steps[2].comments[0].text,'Keep my final note.');
 await active.page.close();await retry.page.close();render('finished.html');

 let reopenRequest;
 for(const width of [736,320])for(const theme of ['light','dark']){
  const finished=await createView(browser,errors,dir,{file:'finished.html',width,theme,hasTouch:width===320,expanded:['pending']});
  assert.equal(await finished.ui.locator('.pc-kind').textContent(),'Finished plan');
  assert.equal(await finished.ui.locator('.pc-lifecycle').textContent(),'Reopen plan');
  assert.equal(await finished.ui.locator('.pc-implement').isVisible(),false);assert.equal(await finished.ui.locator('.pc-add-area').isVisible(),false);
  assert.equal(await finished.ui.locator('[data-step="pending"] .pc-more').isDisabled(),true);
  assert.equal(await finished.ui.locator('[data-step="pending"] input[type=checkbox]').isDisabled(),true);
  assert.match(await finished.ui.locator('[data-step="pending"] .pc-details').textContent(),/Keep my final note/);
  assert.equal(await finished.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  assert.ok(await finished.ui.locator('.pc-lifecycle').isEnabled());
  if(width===736 && theme==='light'){
   await finished.frame.evaluate(()=>window.__fail=true);await finished.ui.locator('.pc-lifecycle').click();
   const failedReopen=decode(await finished.frame.evaluate(()=>window.__calls.at(-1)));
   const savedReopen=await finished.frame.evaluate(()=>window.__savedState);
   // A closed card ignores restored edits/selections while retaining the retry ID.
   savedReopen.modelContent.operations=[{type:'set_status',step_id:'pending',status:'completed'}];savedReopen.modelContent.selected_step_ids=['pending'];
   const restored=await createView(browser,errors,dir,{file:'finished.html',saved:savedReopen});
   assert.equal(await restored.ui.locator('input[type=checkbox]:checked').count(),0);
   await restored.ui.locator('.pc-lifecycle').click();reopenRequest=decode(await restored.frame.evaluate(()=>window.__calls.at(-1)));
   assert.deepEqual(reopenRequest,failedReopen);assert.deepEqual(reopenRequest.operations,[]);assert.equal(reopenRequest.intent,'reopen');
   await restored.page.close();
  }
  await finished.page.close();
 }
 assert.equal(apply(reopenRequest).lifecycle,'active');assert.equal(api.read(p).execution,undefined);
 render('reopened.html');
 const reopened=await createView(browser,errors,dir,{file:'reopened.html'});
 assert.equal(await reopened.ui.locator('input[type=checkbox]:checked').count(),0);assert.equal(await reopened.ui.locator('.pc-implement').isDisabled(),true);
 assert.equal(await reopened.ui.locator('[data-step="pending"] input[type=checkbox]').isEnabled(),true);await reopened.page.close();
 render('preview.html',true);const preview=await createView(browser,errors,dir,{file:'preview.html'});
 await preview.ui.locator('.pc-lifecycle').click();assert.equal(await preview.frame.evaluate(()=>window.__calls.length),0);assert.match(await preview.ui.locator('.pc-status').textContent(),/Preview:.*finish/);await preview.page.close();
 assert.deepEqual(errors,[]);console.log('PASS: finish/reopen, preserved notes and order, failure/retry across reload, CLI persistence, finished inspection, draft isolation, fresh selection, preview isolation, and 320/736px light/dark layouts. Host callbacks simulated.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
