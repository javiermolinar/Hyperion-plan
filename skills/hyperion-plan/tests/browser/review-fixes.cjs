const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs'),dir=createScratch(),errors=[];
const step=(id,extra={})=>({id,title:id,status:'pending',comments:[],...extra});
const row=(ui,id)=>ui.locator(`[data-step="${id}"]`);
const ids=ui=>ui.locator('.pc-row').evaluateAll(rows=>rows.map(r=>r.dataset.step));
function fixture(name,steps){const p=path.join(dir,name+'.md');api.saveMarkdown(p,api.initialize({title:name,steps}));execFileSync(process.execPath,[helper,'render','--plan',p,'--output',path.join(dir,name+'.html')]);return api.read(p);}
function decode(call){return JSON.parse(call.prompt.split('Change request JSON:\n')[1]);}
(async()=>{
 const browser=await launch();
 try{
  const base=fixture('reopen',[step('a',{status:'completed'}),step('r',{kind:'review',depends_on:['a'],run_after:'a',checks:['Check a'],status:'completed'}),step('b'),step('c')]);
  const view=await createView(browser,errors,dir,{file:'reopen.html',expanded:['r','b'],saved:{modelContent:{kind:'plan-companion',ui_version:3,plan_id:base.plan_id,base_revision:base.revision,operations:[{type:'set_status',step_id:'r',status:'pending'}],selected_step_ids:[]},privateContent:{}}});
  await row(view.ui,'b').getByRole('textbox').fill('Preserve this note.');
  await row(view.ui,'r').locator('.pc-settings > summary').click();
  assert.equal(await row(view.ui,'r').getByRole('combobox',{name:/^Run review after:/}).count(),0);
  assert.match(await row(view.ui,'r').textContent(),/Save the reopened review/);
  await row(view.ui,'c').locator('.pc-drag').press('ArrowUp');
  const saved=await view.frame.evaluate(()=>window.__savedState);
  assert.deepEqual(api.applyOperations(base,saved.modelContent.operations).steps.map(s=>s.id),['a','r','c','b']);
  const restored=await createView(browser,errors,dir,{file:'reopen.html',saved,expanded:['b']});
  assert.deepEqual(await ids(restored.ui),['a','r','c','b']);assert.equal(await row(restored.ui,'b').getByRole('textbox').inputValue(),'Preserve this note.');
  await restored.ui.locator('.pc-apply').click();const req=decode(await restored.frame.evaluate(()=>window.__calls.at(-1)));
  const applied=api.applyRequest(base,req)[0];assert.equal(applied.steps.find(s=>s.id==='r').status,'pending');assert.equal(applied.steps.find(s=>s.id==='r').run_after,'a');
  await view.page.close();await restored.page.close();

  fixture('dependent',[step('a'),step('r',{kind:'review',depends_on:['a'],run_after:'a',checks:['Check a']}),step('d',{depends_on:['r']}),step('c')]);
  const dependent=await createView(browser,errors,dir,{file:'dependent.html',expanded:['r','a']});
  await row(dependent.ui,'a').getByRole('textbox').fill('Keep me');
  await row(dependent.ui,'r').locator('.pc-settings > summary').click();
  await row(dependent.ui,'r').getByRole('combobox',{name:'Run review after: r'}).selectOption('c');
  assert.deepEqual(await ids(dependent.ui),['a','r','d','c']);assert.match(await dependent.ui.locator('.pc-status').textContent(),/Keep.*d.*after.*r/);
  assert.equal(await row(dependent.ui,'a').getByRole('textbox').inputValue(),'Keep me');await dependent.page.close();

  const legacy=path.resolve(__dirname,'../fixtures/legacy-numeric');
  fs.copyFileSync(path.join(legacy,'plan.md'),path.join(dir,'numeric.md'));fs.copyFileSync(path.join(legacy,'plan.state.json'),path.join(dir,'numeric.state.json'));
  const numericBase=api.read(path.join(dir,'numeric.md'));
  execFileSync(process.execPath,[helper,'render','--plan',path.join(dir,'numeric.md'),'--output',path.join(dir,'numeric.html')]);
  const numeric=await createView(browser,errors,dir,{file:'numeric.html',expanded:['b']});
  await row(numeric.ui,'b').getByRole('textbox').fill('Browser numeric round trip');await row(numeric.ui,'b').getByRole('textbox').press('Enter');
  const numericRequest=decode(await numeric.frame.evaluate(()=>window.__calls.at(-1)));
  const numericPlan=api.applyRequest(numericBase,numericRequest)[0];assert.ok(api.equal(numericPlan.steps[0],numericBase.steps[0]));
  await numeric.page.close();

  let notesBase=fixture('note-approval',[step('a'),step('b',{depends_on:['a']}),step('c',{depends_on:['b']}),step('spare')]);
  [notesBase]=api.applyRequest(notesBase,{plan_id:notesBase.plan_id,base_revision:notesBase.revision,request_id:'approve-notes',intent:'implement',operations:[],selected_step_ids:['a','b','c','spare']});
  const notesPath=path.join(dir,'note-approval.md');api.saveMarkdown(notesPath,notesBase);
  execFileSync(process.execPath,[helper,'render','--plan',notesPath,'--output',path.join(dir,'note-approval.html')]);
  const noteView=await createView(browser,errors,dir,{file:'note-approval.html',expanded:['a']});
  await noteView.ui.locator('.pc-select-all').click();
  const noteEditor=row(noteView.ui,'a').getByRole('textbox');
  const editorElement=await noteEditor.elementHandle();
  await noteEditor.fill('New');await noteEditor.press('End');await noteEditor.pressSequentially(' constraint');
  assert.equal(await noteEditor.inputValue(),'New constraint','Updating affected rows preserves typing and focus');
  assert.equal(await editorElement.evaluate(element=>element.isConnected),true,'Availability changes keep the native editor mounted');
  for(const id of ['b','c']){
   assert.equal(await row(noteView.ui,id).getByRole('checkbox').isChecked(),true);
   assert.equal(await row(noteView.ui,id).getByRole('checkbox').isDisabled(),false);
  }
  assert.equal(await row(noteView.ui,'a').getByRole('checkbox').isChecked(),true,'A new explicit selection can include the edited task');
  const noteSaved=await noteView.frame.evaluate(()=>window.__savedState);
  const restoredNotes=await createView(browser,errors,dir,{file:'note-approval.html',saved:noteSaved});
  assert.equal(await row(restoredNotes.ui,'b').getByRole('checkbox').isDisabled(),false);
  await row(restoredNotes.ui,'a').getByRole('textbox').fill('');
  assert.equal(await row(restoredNotes.ui,'b').getByRole('checkbox').isDisabled(),false,'Removing an unsent note clears its draft warning');
  await restoredNotes.page.close();
  await noteEditor.press('Enter');
  const notesRequest=decode(await noteView.frame.evaluate(()=>window.__calls.at(-1)));
  const notesRequestPath=path.join(dir,'notes-request.json');fs.writeFileSync(notesRequestPath,JSON.stringify(notesRequest));
  execFileSync(process.execPath,[helper,'apply','--plan',notesPath,'--request',notesRequestPath]);
  const notesResult=api.read(notesPath);
  assert.deepEqual(notesResult.execution.selected_step_ids,['a','b','c','spare']);
  assert.deepEqual(api.nextSteps(notesResult).ready_steps.map(s=>s.id),['a','spare']);
  for(const id of ['b','c'])assert.equal(notesResult.steps.find(s=>s.id===id).review_state,undefined);
  await noteView.page.close();

  assert.deepEqual(errors,[]);console.log('PASS: protected reopened reviews, valid combined draft replay/submission, rejected dependency inversion without losing notes, question isolation through typing and restore, lossless numeric plan rendering. Simulated host only.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
