const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs');
const dir=createScratch();
const step=(id,extra={})=>({id,title:id,status:'pending',comments:[],...extra});
const base=api.initialize({title:'Task order',steps:[
  step('done',{status:'completed'}),step('a'),step('active',{status:'in_progress'}),step('b'),
  step('c',{depends_on:['a']}),step('review',{kind:'review',depends_on:['a'],run_after:'b',checks:['Check A.']}),step('tail'),
]});
const planPath=path.join(dir,'order.md');api.saveMarkdown(planPath,base);
execFileSync(process.execPath,[helper,'render','--plan',planPath,'--output',path.join(dir,'order.html')]);
const errors=[];
const ids=ui=>ui.locator('.pc-row').evaluateAll(rows=>rows.map(row=>row.dataset.step));
const handle=(ui,id)=>ui.locator(`[data-step="${id}"] .pc-drag`);
const row=(ui,id)=>ui.locator(`[data-step="${id}"]`);
(async()=>{
  const browser=await launch();
  try {
    const setup=options=>createView(browser,errors,dir,{file:'order.html',...options});
    const s=await setup({expanded:['a']});
    assert.equal(await handle(s.ui,'done').count(),0);assert.equal(await handle(s.ui,'active').count(),0);
    await row(s.ui,'b').getByRole('checkbox').check();
    await row(s.ui,'a').getByRole('textbox').fill('Keep my note through the move.');
    await handle(s.ui,'b').dragTo(row(s.ui,'a'),{targetPosition:{x:100,y:8}});
    const expected=['done','b','a','active','c','review','tail'];
    assert.deepEqual(await ids(s.ui),expected,'Pointer drag inserts a pending task at its new position');
    assert.equal(await row(s.ui,'b').getByRole('checkbox').isChecked(),true);
    assert.equal(await row(s.ui,'a').getByRole('textbox').inputValue(),'Keep my note through the move.');
    assert.equal(await s.frame.evaluate(()=>window.__calls.length),0,'Dragging only creates a draft');
    assert.equal(await handle(s.ui,'b').evaluate(el=>document.activeElement===el),true);
    const saved=await s.frame.evaluate(()=>window.__savedState);
    assert.deepEqual(saved.modelContent.operations.find(op=>op.type==='reorder_steps').step_ids,expected);
    const restored=await setup({saved});
    assert.deepEqual(await ids(restored.ui),expected,'Host draft restoration preserves order');
    assert.equal(await row(restored.ui,'a').getByRole('textbox').inputValue(),'Keep my note through the move.');
    await restored.page.close();
    await row(s.ui,'a').locator('.pc-reasoning-select').selectOption('high');
    await s.ui.locator('.pc-apply').click();
    const request=JSON.parse((await s.frame.evaluate(()=>window.__calls.at(-1))).prompt.split('Change request JSON:\n')[1]);
    assert.equal(request.intent,'edit');assert.equal(request.selected_step_ids,undefined);
    const requestPath=path.join(dir,'request.json');fs.writeFileSync(requestPath,JSON.stringify(request));
    execFileSync(process.execPath,[helper,'apply','--plan',planPath,'--request',requestPath]);
    const [result]=api.loadMarkdown(planPath);assert.deepEqual(result.steps.map(step=>step.id),expected);
    assert.equal(result.steps.find(s=>s.id==='review').run_after,'b');assert.deepEqual(result.steps.find(s=>s.id==='review').depends_on,['a']);
    assert.equal(result.steps.find(s=>s.id==='a').reasoning_effort,'high');
    assert.deepEqual(result.steps.find(s=>s.id==='a').comments,[]);
    await s.page.close();

    const keyboard=await setup();
    await handle(keyboard.ui,'b').press('ArrowUp');await handle(keyboard.ui,'b').press('ArrowUp');assert.deepEqual(await ids(keyboard.ui),expected);
    assert.equal(await keyboard.ui.locator('.pc-apply').isVisible(),false,'Order changes need no Save edits step');
    assert.equal(await keyboard.frame.evaluate(()=>window.__calls.length),0,'Reordering does not prompt or submit');
    assert.match(await keyboard.ui.locator('.pc-interaction-hint').textContent(),/Drag.*grip.*Tick.*checkbox/);
    const remembered=await setup({saved:await keyboard.frame.evaluate(()=>window.__savedState)});
    assert.deepEqual(await ids(remembered.ui),expected);await remembered.page.close();
    await handle(keyboard.ui,'b').press('ArrowDown');await handle(keyboard.ui,'b').press('ArrowDown');assert.deepEqual(await ids(keyboard.ui),base.steps.map(s=>s.id));
    assert.equal(await keyboard.ui.locator('.pc-apply').isVisible(),false,'Returning to the saved order clears the edit');
    await handle(keyboard.ui,'c').dragTo(row(keyboard.ui,'a'),{targetPosition:{x:100,y:8}});
    assert.deepEqual(await ids(keyboard.ui),base.steps.map(s=>s.id),'Prerequisite inversion is rejected');
    assert.match(await keyboard.ui.locator('.pc-status').textContent(),/Keep.*c.*after.*a/);
    await handle(keyboard.ui,'review').press('ArrowUp');
    await handle(keyboard.ui,'review').press('ArrowUp');
    assert.match(await keyboard.ui.locator('.pc-status').textContent(),/Keep.*review.*after.*b/);
    await keyboard.page.close();

    const nextAction=await setup({expanded:['a']});
    await handle(nextAction.ui,'b').press('ArrowUp');await handle(nextAction.ui,'b').press('ArrowUp');
    await row(nextAction.ui,'a').getByRole('textbox').press('Enter');
    assert.equal(await nextAction.frame.evaluate(()=>window.__calls.length),0,'Empty Enter cannot submit ordering alone');
    await row(nextAction.ui,'b').getByRole('checkbox').check();
    await nextAction.ui.locator('.pc-implement').click();
    const implementation=JSON.parse((await nextAction.frame.evaluate(()=>window.__calls.at(-1))).prompt.split('Change request JSON:\n')[1]);
    assert.equal(implementation.intent,'implement');assert.deepEqual(implementation.selected_step_ids,['b']);
    assert.deepEqual(api.applyOperations(base,implementation.operations).steps.map(s=>s.id),expected,'Next implementation action includes the order');
    await nextAction.page.close();

    const cancel=await setup();
    await cancel.frame.evaluate(()=>{
      window.__rowRemovals=0;
      new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)if(removed.classList?.contains('pc-row'))window.__rowRemovals++;}).observe(document.querySelector('.pc-steps'),{childList:true});
    });
    const from=await handle(cancel.ui,'b').boundingBox(),to=await row(cancel.ui,'a').boundingBox();
    await cancel.page.mouse.move(from.x+from.width/2,from.y+from.height/2);await cancel.page.mouse.down();
    await cancel.page.mouse.move(to.x+100,to.y+8,{steps:8});
    assert.equal(await cancel.ui.locator('.pc-drop-before').count(),1);
    assert.equal(await cancel.frame.evaluate(()=>window.__rowRemovals),0,'Dragging does not rebuild rows');
    await cancel.page.keyboard.press('Escape');await cancel.page.mouse.up();
    assert.deepEqual(await ids(cancel.ui),base.steps.map(s=>s.id),'Escape cancels the move');
    assert.equal(await cancel.ui.locator('.pc-dragging,.pc-drop-before,.pc-drop-after').count(),0);
    await handle(cancel.ui,'b').dragTo(cancel.ui.locator('.pc-heading'));
    assert.deepEqual(await ids(cancel.ui),base.steps.map(s=>s.id),'Dropping outside the list cancels the move');
    assert.equal(await cancel.frame.evaluate(()=>window.__calls.length),0);
    await cancel.page.close();

    const touch=await setup({width:320,hasTouch:true});
    const cdp=await touch.page.context().newCDPSession(touch.page);
    const touchFrom=await handle(touch.ui,'b').boundingBox(),touchTo=await row(touch.ui,'a').boundingBox();
    assert.ok(touchFrom.width>=44 && touchFrom.height>=44,'Touch grip has an accessible hit area');
    const start={x:touchFrom.x+touchFrom.width/2,y:touchFrom.y+touchFrom.height/2};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
    for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(touchTo.x+100-start.x)*i/8,y:start.y+(touchTo.y+8-start.y)*i/8}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.deepEqual(await ids(touch.ui),expected,'Touch drag reorders the task');
    assert.equal(await touch.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
    await touch.page.close();

    for(const [width,theme] of [[736,'light'],[320,'light'],[736,'dark'],[320,'dark']]) {
      const view=await setup({width,theme});
      await handle(view.ui,'tail').press('ArrowUp');
      assert.deepEqual(await ids(view.ui),['done','a','active','b','c','tail','review']);
      assert.equal(await view.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
      await view.page.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: pointer drag, cancellation, stable rows during drag, keyboard reordering, visible hints, protected history, dependency rejection, review semantics, notes/selection, immediate host-state persistence without Save, next-action order submission, Markdown persistence, narrow/dark layouts. Mock host only.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
