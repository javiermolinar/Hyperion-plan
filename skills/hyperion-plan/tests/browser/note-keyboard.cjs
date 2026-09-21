const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const dir=createScratch();
execFileSync(process.execPath,[helper,'render','--plan',path.join(dir,'plan-selection-preview.json'),'--output',path.join(dir,'note-keyboard.html')]);
const errors=[];
(async()=>{
  const browser=await launch();
  try {
    const setup=options=>createView(browser,errors,dir,{file:'note-keyboard.html',expanded:['api-client'],...options});
    const editor=ui=>ui.getByRole('textbox',{name:'Note for: Define the shared API and TypeScript client',exact:true});
    const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
    const {page,ui,frame}=await setup();
    const note=editor(ui);
    await ui.locator('[data-step="monorepo"] input[type=checkbox]').check();
    await note.fill('Good');
    await note.press('Meta+Enter');
    await note.pressSequentially('Second line');
    assert.equal(await note.inputValue(),'Good\nSecond line','Command+Enter adds a line');
    assert.equal(await frame.evaluate(()=>window.__calls.length),0,'Adding a line does not send');
    await note.press('Enter');
    let calls=await frame.evaluate(()=>window.__calls);
    assert.equal(calls.length,1,'Enter sends once');
    const request=decode(calls[0]);
    assert.equal(request.intent,'edit','Enter saves edits rather than implementing selected steps');
    assert.equal(request.selected_step_ids,undefined);
    assert.equal(request.operations.length,1);
    assert.equal(request.operations[0].text,'Good\nSecond line');
    assert.equal(await note.inputValue(),'Good\nSecond line','Sending preserves the draft until the agent confirms');
    await frame.evaluate(()=>window.__fail=true);
    await note.press('Enter');
    assert.match(await ui.locator('.pc-status').textContent(),/preserved/);
    await frame.evaluate(()=>window.__fail=false);
    await note.press('Enter');
    calls=await frame.evaluate(()=>window.__calls);
    assert.equal(calls.length,3);
    assert.equal(decode(calls[1]).request_id,request.request_id);
    assert.equal(decode(calls[2]).request_id,request.request_id,'Retry uses the same receipt');
    const saved=await frame.evaluate(()=>window.__savedState);
    const restored=await setup({saved});
    assert.equal(await editor(restored.ui).inputValue(),'Good\nSecond line');
    await restored.page.close();
    await page.close();

    const clean=await setup();
    const input=editor(clean.ui);
    await input.press('Enter');
    assert.equal(await clean.frame.evaluate(()=>window.__calls.length),0,'Empty notes do not submit');
    await input.fill('Unsent');
    for(const options of [{isComposing:true},{keyCode:229},{repeat:true}]) {
      await input.evaluate((element,options)=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options})),options);
      assert.equal(await clean.frame.evaluate(()=>window.__calls.length),0,'Composition and held Enter do not submit');
    }
    await input.fill('x'.repeat(1000));
    await input.press('End');
    await input.press('Meta+Enter');
    assert.equal((await input.inputValue()).length,1000,'Command+Enter respects the note length limit');
    await input.evaluate(element=>element.setSelectionRange(499,500));
    await input.press('Meta+Enter');
    assert.equal(await input.inputValue(),'x'.repeat(499)+'\n'+'x'.repeat(500),'Command+Enter replaces the selected text');
    assert.deepEqual(await input.evaluate(element=>[element.selectionStart,element.selectionEnd]),[500,500]);
    assert.equal(await clean.frame.evaluate(()=>window.__calls.length),0);
    await clean.page.close();
    assert.deepEqual(errors,[]);
    console.log('PASS: Enter saves edits, Command+Enter adds lines, selection and length limits, composition/repeat guards, preserved drafts, and idempotent retry. Simulated host only.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
