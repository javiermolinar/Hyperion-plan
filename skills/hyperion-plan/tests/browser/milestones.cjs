const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const dir=createScratch(), errors=[];
const labels=['Service foundation','Tracepoints','CLI / VS Code','F5'];
const plan={schema_version:1,plan_id:'milestones',revision:1,title:'Debugger implementation',steps:Array.from({length:27},(_,i)=>({
  id:'s'+i,title:'Deliver capability '+(i+1),milestone:labels[Math.floor(i/7)],status:i<7?'completed':'pending',comments:[],
  done_when:'The capability works and its acceptance checks pass.',
  ...(i>8?{depends_on:['s8']}:{}),
}))};
plan.steps[14].blocked_by='Waiting for the adapter contract';
plan.steps[21].review_state='needs_review';
plan.steps[21].review_note='Inspect the changed launch configuration before implementation. '.repeat(15);
function render(name, value){fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));execFileSync(process.execPath,[helper,'render','--plan',path.join(dir,name+'.json'),'--output',path.join(dir,name+'.html')]);}
render('milestones',plan);
render('review',{...plan,steps:[plan.steps[0],{id:'r',title:'Check service foundation',milestone:labels[0],kind:'review',status:'pending',depends_on:['s0'],checks:['Verify the implemented behavior.'],comments:[]}]});
const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try {
  const s=await createView(browser,errors,dir,{file:'milestones.html'});
  assert.equal(await s.ui.locator('.pc-milestone').count(),4);
  assert.deepEqual(await s.ui.locator('.pc-milestone > details').evaluateAll(es=>es.map(e=>e.open)),[false,true,false,false]);
  assert.equal(await s.ui.locator('.pc-row').count(),27);
  assert.equal(await s.ui.locator('.pc-next').count(),0);
  await s.ui.locator('[data-step="s7"] .pc-check input').check();
  await s.ui.locator('[data-step="s8"] .pc-check input').check();
  assert.deepEqual((await s.frame.evaluate(()=>window.__saved)).modelContent.selected_step_ids,['s7','s8']);
  assert.equal(await s.frame.evaluate(()=>window.__calls.length),0,'Selection never submits');
  await s.ui.locator('.pc-milestone > details > summary').nth(1).click();
  await s.ui.locator('.pc-milestone > details > summary').nth(3).click();
  await s.frame.waitForFunction(()=>Object.keys(window.__saved.privateContent.milestones).length>=2);
  const saved=await s.frame.evaluate(()=>window.__saved);
  const restored=await createView(browser,errors,dir,{file:'milestones.html',saved});
  assert.deepEqual(await restored.ui.locator('.pc-milestone > details').evaluateAll(es=>es.map(e=>e.open)),[false,false,false,true]);
  await restored.ui.locator('.pc-milestone > details > summary').nth(1).click();
  await restored.ui.locator('[data-step="s7"] .pc-expand').click();
  assert.equal(await restored.ui.locator('[data-step="s7"] .pc-details').isVisible(),true);
  await restored.ui.locator('.pc-review-plan').click();
  await restored.ui.locator('.pc-refresh-plan').click();
  const call=(await restored.frame.evaluate(()=>window.__calls)).at(-1), request=decode(call);
  assert.equal(request.intent,'review');assert.equal(request.selected_step_ids,undefined);assert.equal(request.target_step_ids.length,20);
  assert.match(call.prompt,/scope, sequencing, dependencies, and acceptance criteria/);
  // New steps and keyboard movement across group boundaries must remain reachable.
  await restored.ui.getByRole('button',{name:'Add step',exact:true}).click();
  await restored.ui.getByRole('textbox',{name:'Step title',exact:true}).fill('Document integration');
  await restored.ui.getByRole('textbox',{name:'Step title',exact:true}).press('Enter');
  assert.equal(await restored.ui.locator('.pc-row').last().isVisible(),true);
  await restored.ui.locator('[data-step="s8"] .pc-drag').press('ArrowUp');
  assert.equal(await restored.ui.locator('[data-step="s8"] .pc-drag').evaluate(e=>e===document.activeElement),true);
  assert.equal(await restored.ui.locator('[data-step="s8"]').isVisible(),true);
  await restored.ui.locator('.pc-milestone > details > summary').filter({hasText:'CLI / VS Code'}).click();
  await restored.ui.locator('[data-step="s14"] .pc-drag').press('ArrowUp');
  assert.equal(await restored.ui.locator('[data-step="s14"] .pc-drag').evaluate(e=>e===document.activeElement),true);
  assert.equal(await restored.ui.locator('[data-step="s14"]').isVisible(),true);
  const r=await createView(browser,errors,dir,{file:'review.html'});
  await r.ui.locator('[data-step="r"] .pc-check input').check();await r.ui.locator('.pc-implement').click();
  const code=decode((await r.frame.evaluate(()=>window.__calls)).at(-1));
  assert.equal(code.intent,'implement');assert.deepEqual(code.selected_step_ids,['r']);
  for(const [width,theme] of [[736,'light'],[320,'light'],[736,'dark'],[320,'dark']]){
    const v=await createView(browser,errors,dir,{file:'milestones.html',width,theme});
    assert.equal(await v.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
    await v.ui.locator('.pc-milestone > details > summary').nth(3).click();
    const row=v.ui.locator('[data-step="s21"]');
    assert.ok((await row.textContent()).length<900,'Detailed evidence stays out of collapsed rows');
    await row.locator('.pc-expand').click();
    assert.ok((await row.locator('.pc-details').textContent()).includes(plan.steps[21].review_note));
    if(process.env.HYPERION_SCREENSHOT_DIR){fs.mkdirSync(process.env.HYPERION_SCREENSHOT_DIR,{recursive:true});await v.ui.locator('section').screenshot({path:path.join(process.env.HYPERION_SCREENSHOT_DIR,`milestones-${width}-${theme}.png`)});}
    await v.page.close();
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: 27-step milestones, explicit step selection, collapsed navigation and restoration, plan/code review isolation, evidence details, responsive layouts.');
} finally {await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
