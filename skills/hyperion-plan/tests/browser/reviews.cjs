const {fs,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const dir=createScratch();
for(const [name,preview] of [['review-ux-test.html',false],['review-ux-demo-test.html',true]]){execFileSync(process.execPath,[helper,'render','--plan',dir+'/review-ux-test.json','--output',dir+'/'+name,...(preview?['--preview']:[])]);}
const historyBase=JSON.parse(fs.readFileSync(dir+'/review-ux-test.json','utf8'));
historyBase.steps=[{id:'completed-history',title:'Completed history',status:'completed',comments:[]},{id:'active-history',title:'Active history',status:'in_progress',comments:[]}];
fs.writeFileSync(dir+'/history-test.json',JSON.stringify(historyBase));
execFileSync(process.execPath,[helper,'render','--plan',dir+'/history-test.json','--output',dir+'/history-test.html']);
const errors=[];
const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
function apply(request){
  const planPath=dir+'/review-ux-roundtrip.json',requestPath=dir+'/review-ux-request.json';
  fs.copyFileSync(dir+'/review-ux-test.json',planPath);fs.writeFileSync(requestPath,JSON.stringify(request));
  execFileSync(process.execPath,[helper,'apply','--plan',planPath,'--request',requestPath]);
  return JSON.parse(fs.readFileSync(planPath,'utf8'));
}
(async()=>{
const browser=await launch();
try{
  const setup=({preview=false,...options}={})=>createView(browser,errors,dir,{file:preview?'review-ux-demo-test.html':'review-ux-test.html',expanded:['review-selection'],...options});
  const history=await setup({file:'history-test.html',expanded:[]});
  for(const id of ['completed-history','active-history']){
    const row=history.ui.locator(`[data-step="${id}"]`);await row.locator('.pc-more').click();
    if(id==='active-history'){await row.getByRole('button',{name:'Mark as done',exact:true}).click();await row.locator('.pc-more').click();}
    await row.getByRole('button',{name:'Mark as pending',exact:true}).click();await row.locator('.pc-more').click();
    assert.equal(await row.getByRole('button',{name:'Remove planned step',exact:true}).isDisabled(),true,'Draft status changes must not unlock protected history');
    assert.match(await row.locator('.pc-menu').textContent(),/kept in/);
  }
  const invalidSaved=await history.frame.evaluate(()=>window.__saved);
  invalidSaved.modelContent.operations=[{type:'set_status',step_id:'completed-history',status:'pending'},{type:'remove_step',step_id:'completed-history'}];
  const rejectedDraft=await setup({file:'history-test.html',expanded:[],saved:invalidSaved});
  assert.equal(await rejectedDraft.ui.locator('.pc-row').count(),2);
  assert.equal(await rejectedDraft.ui.locator('.pc-apply').isVisible(),false,'Invalid history-removal drafts are not restored');
  const s=await setup(),review=s.ui.locator('[data-step="review-selection"]');
  assert.equal(await review.locator('.pc-checks li').count(),4);
  assert.equal(await review.locator('.pc-settings').evaluate(e=>e.open),false);
  assert.equal(await s.ui.locator('.pc-apply').isVisible(),false,'Inherited context is not fabricated draft notes');
  const completed=s.ui.locator('[data-step="progress"]');await completed.locator('.pc-more').click();
  assert.match(await completed.locator('.pc-menu-heading').textContent(),/#2 Preserve progress between turns/);
  assert.equal(await completed.getByRole('button',{name:'Remove planned step',exact:true}).isDisabled(),true);
  assert.match(await completed.locator('.pc-menu').textContent(),/#3 Review selection and progress/);
  const bounds=await s.frame.evaluate(()=>{const menu=document.querySelector('.pc-menu').getBoundingClientRect(),review=document.querySelector('[data-step="review-selection"]').getBoundingClientRect();return {bottom:menu.bottom,nextTop:review.top};});assert.ok(bounds.bottom<=bounds.nextTop,'Menu stays in its own row');
  await completed.getByRole('button',{name:'Replan dependencies',exact:true}).click();
  let request=decode(await s.frame.evaluate(()=>window.__calls.at(-1))),result=apply(request);
  assert.equal(request.intent,'replan');assert.equal(result.steps[1].status,'completed');assert.equal(result.steps[2].review_state,'needs_review');assert.equal(result.execution,undefined);
  await review.locator('.pc-check input').check();assert.equal(await s.ui.locator('.pc-implement').textContent(),'Review implemented code');await s.ui.locator('.pc-implement').click();
  const call=await s.frame.evaluate(()=>window.__calls.at(-1));assert.match(call.prompt,/covered step descriptions/);assert.match(call.prompt,/run_after as timing/);assert.deepEqual(decode(call).selected_step_ids,['review-selection']);
  await review.locator('.pc-check input').uncheck();await review.locator('.pc-settings > summary').click();
  assert.match(await review.locator('.pc-inherited').textContent(),/Only|Run only/);assert.match(await review.locator('.pc-inherited').textContent(),/Keyboard users/);
  const position=review.getByRole('combobox');assert.equal(await position.locator('option[value="selection"]').evaluate(e=>e.disabled),true);
  await position.selectOption('polish');
  assert.equal(await review.locator('.pc-settings').evaluate(e=>e.open),true);
  assert.equal(await review.locator('.pc-check input').isDisabled(),true,'Unselected scheduling prerequisite blocks execution');
  await s.ui.locator('.pc-apply').click();request=decode(await s.frame.evaluate(()=>window.__calls.at(-1)));result=apply(request);
  assert.deepEqual(result.steps.at(-1).depends_on,['selection','progress'],'Moving later must not add inspected work');assert.equal(result.steps.at(-1).run_after,'polish');assert.equal(result.execution,undefined);
  assert.equal(request.operations.some(op=>op.type==='update_review'),false);
  await review.locator('.pc-review-controls summary').click();await review.getByRole('checkbox',{name:'Include in review: Polish mobile interactions',exact:true}).check();
  await review.getByRole('textbox',{name:'Note for: Review selection and progress',exact:true}).fill('Preserve the reviewer context in the PR description.');
  await s.ui.locator('.pc-apply').click();result=apply(decode(await s.frame.evaluate(()=>window.__calls.at(-1))));
  assert.deepEqual(result.steps.at(-1).depends_on,['selection','progress','polish']);assert.equal(result.steps.at(-1).run_after,'polish');
  assert.match(fs.readFileSync(dir+'/review-ux-roundtrip-pr-notes.md','utf8'),/Preserve the reviewer context in the PR description/);
  assert.match(fs.readFileSync(dir+'/review-ux-roundtrip-pr-notes.md','utf8'),/Keyboard users/);
  const saved=await s.frame.evaluate(()=>window.__saved),restored=await setup({saved});
  assert.equal(await restored.ui.locator('.pc-row').last().getAttribute('data-step'),'review-selection');assert.equal(await restored.ui.locator('.pc-settings').evaluate(e=>e.open),true);
  assert.equal(await restored.ui.getByRole('textbox',{name:'Note for: Review selection and progress',exact:true}).inputValue(),'Preserve the reviewer context in the PR description.');
  await s.ui.getByRole('button',{name:'Add step',exact:true}).click();await s.ui.getByRole('combobox',{name:'Step type',exact:true}).selectOption('review');
  await s.ui.getByRole('combobox',{name:'Place new review after',exact:true}).selectOption('selection');await s.ui.getByRole('button',{name:'Add code review',exact:true}).click();
  const added=s.ui.locator('.pc-row').nth(1),id=await added.getAttribute('data-step');assert.notEqual(id,'review-selection');assert.equal(await added.locator('.pc-check input').isChecked(),false);
  await s.ui.locator('.pc-apply').click();result=apply(decode(await s.frame.evaluate(()=>window.__calls.at(-1))));assert.equal(result.steps[1].kind,'review');assert.equal(result.steps[1].run_after,'selection');assert.deepEqual(result.steps[1].depends_on,['selection']);
  await added.locator('.pc-more').click();assert.match(await added.locator('.pc-menu').textContent(),/does not revert code/);await added.getByRole('button',{name:'Remove planned step',exact:true}).click();await s.ui.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await s.ui.locator('.pc-row').nth(1).getAttribute('data-step'),id);
  const p=await setup({preview:true});await p.ui.locator('[data-step="review-selection"] .pc-check input').check();await p.ui.locator('.pc-implement').click();assert.equal(await p.frame.evaluate(()=>window.__calls.length),0);
  for(const [width,theme] of [[736,'light'],[320,'dark']]){
    const v=await setup({preview:true,width,theme}),row=v.ui.locator('[data-step="review-selection"]');
    const expandedHeight=await row.evaluate(e=>e.getBoundingClientRect().height);assert.ok(expandedHeight<(width===736?350:600),`Review too tall: ${expandedHeight}`);
    const geometry=await v.frame.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert.ok(geometry.scroll<=geometry.width);
    const region=v.ui.getByRole('region',{name:'Interactive task plan'}),height=await region.evaluate(el=>Math.ceil(el.getBoundingClientRect().height)+20);
    await v.page.locator('iframe').evaluate((el,h)=>el.style.height=h+'px',height);await v.page.setViewportSize({width,height:height+10});await region.screenshot({path:dir+`/review-ux-${width}-${theme}.png`});
    console.log(JSON.stringify({width,expandedReviewHeight:expandedHeight}));
  }
  assert.deepEqual(errors,[]);console.log('PASS: named in-flow action panels; history/removal guards; actionable replan; independent timing/scope; inherited context; compact settings; one add control; persisted notes/exports; restored drafts; preview isolation. Mock host only.');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
