const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const dir=createScratch();
const planPath=path.join(dir,'plan-selection-preview.json');
const base=JSON.parse(fs.readFileSync(planPath,'utf8'));
execFileSync(process.execPath,[helper,'render','--plan',planPath,'--output',path.join(dir,'host-state.html')]);
const saved={
  modelContent:{kind:'plan-companion',ui_version:3,plan_id:base.plan_id,base_revision:base.revision,operations:[],selected_step_ids:[]},
  privateContent:{expanded:[],settings:[],request_ids:{},note_editors:[]},
};
const errors=[];
(async()=>{
  const browser=await launch();
  try {
    const setup=options=>createView(browser,errors,dir,{file:'host-state.html',...options});
    const update=(frame,state)=>frame.evaluate(widgetState=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState}}})),state);
    // Both initial and late delivery of an unchanged snapshot must keep the
    // user's open menu, focus, and existing rows through viewport updates.
    for (const initial of [null,saved]) {
      const {page,ui,frame}=await setup({saved:initial});
      await ui.locator('[data-step="monorepo"] .pc-more').click();
      const result=await frame.evaluate(async state=>{
        const focused=document.activeElement;
        const rows=[...document.querySelectorAll('.pc-row')];
        const scroll=document.scrollingElement;
        for (const top of [100,240,400,240,100,0]) {
          window.scrollTo(0,top);
          const before=scroll.scrollTop;
          window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{maxHeight:600+top,widgetState:structuredClone(state)}}}));
          await new Promise(requestAnimationFrame);
          if (scroll.scrollTop!==before) throw Error('Host update moved the scroll position');
        }
        return {focusPreserved:document.activeElement===focused,rowsPreserved:rows.every(row=>row.isConnected)};
      },saved);
      assert.equal(result.focusPreserved,true,'Unchanged host state must preserve keyboard focus');
      assert.equal(result.rowsPreserved,true,'Unchanged host state must preserve existing rows');
      assert.equal(await ui.locator('.pc-menu').count(),1,'Unchanged host state must preserve the open menu');
      await page.close();
    }
    const {page,ui,frame}=await setup();
    const draft=structuredClone(saved);
    draft.modelContent.operations=[{type:'add_comment',step_id:'api-client',comment_id:'draft-note',text:'Retain this restored note.'}];
    draft.modelContent.selected_step_ids=['api-client'];
    draft.privateContent.expanded=['api-client','monorepo'];
    draft.privateContent.note_editors=[{step_id:'api-client',id:'draft-note'}];
    await update(frame,draft);
    const note=ui.getByRole('textbox',{name:'Note for: Define the shared API and TypeScript client',exact:true});
    assert.equal(await note.inputValue(),'Retain this restored note.','Changed late drafts still restore');
    assert.equal(await ui.locator('[data-step="api-client"] input[type=checkbox]').isChecked(),true);
    await note.focus();
    await note.evaluate(element=>element.setSelectionRange(7,11));
    const equivalent=structuredClone(draft);
    equivalent.privateContent.expanded.reverse();
    equivalent.privateContent.request_ids={edit:'restored-request'};
    await update(frame,equivalent);
    assert.equal(await note.evaluate(element=>document.activeElement===element),true,'Equivalent state preserves editor focus');
    assert.deepEqual(await note.evaluate(element=>[element.selectionStart,element.selectionEnd]),[7,11],'Equivalent state preserves text selection');
    const stale=structuredClone(draft);stale.modelContent.base_revision++;
    await update(frame,stale);
    const invalid=structuredClone(draft);invalid.modelContent.operations=[{type:'not-an-operation'}];
    await update(frame,invalid);
    assert.equal(await note.inputValue(),'Retain this restored note.');
    await note.fill('Keep my local typing.');
    await update(frame,saved);
    assert.equal(await note.inputValue(),'Keep my local typing.','Later host snapshots cannot overwrite local edits');
    assert.equal(await frame.evaluate(()=>window.__calls.length),0,'Restoration never submits the plan');
    await page.close();
    assert.deepEqual(errors,[]);
    console.log('Host-state browser checks passed: stable rows, scroll, menus, focus, text selection, late restore, and draft protection.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
