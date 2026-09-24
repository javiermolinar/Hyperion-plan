const {fs,path,assert,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs'),dir=createScratch(),errors=[];
const base=api.initialize({title:'Plan controls',steps:[{id:'done',title:'Done',status:'completed'},{id:'a',title:'A'},{id:'b',title:'B',depends_on:['a']},{id:'c',title:'C'}]});
const file=path.join(dir,'plan.md');fs.writeFileSync(path.join(dir,'controls.html'),api.render(base,file));
fs.writeFileSync(path.join(dir,'empty.html'),api.render(api.initialize({title:'Empty',steps:[]}),file));
const row=(v,id)=>v.ui.locator(`[data-step="${id}"]`),decode=c=>JSON.parse(c.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try{
 const setup=options=>createView(browser,errors,dir,{file:'controls.html',...options});
 const v=await setup();assert.equal(await v.ui.locator('.pc-implement').isDisabled(),true);assert.equal(await row(v,'done').locator('.pc-check input').count(),0);
 assert.equal(await row(v,'b').locator('.pc-check input').isDisabled(),true);
 await row(v,'a').locator('.pc-check input').check();await row(v,'b').locator('.pc-check input').check();
 await row(v,'a').locator('.pc-check input').uncheck();assert.equal(await row(v,'b').locator('.pc-check input').isChecked(),false);
 await row(v,'c').locator('.pc-check input').check();await v.ui.locator('.pc-implement').click();
 const req=decode((await v.frame.evaluate(()=>window.__calls)).at(-1));assert.deepEqual(req.selected_step_ids,['c']);assert.equal(req.execution_mode,'auto');
 const [result]=api.applyRequest(base,req);assert.equal(result.steps[3].status,'pending');assert.deepEqual(result.execution.selected_step_ids,['c']);
 // Add-step controls still create drafts; asks cannot target an unsaved step.
 await v.ui.getByRole('button',{name:'Add step',exact:true}).click();
 const title=v.ui.locator('.pc-add input');await title.fill('New work');await v.ui.locator('.pc-add-button').click();
 const added=v.ui.locator('.pc-row').last();if(await added.locator('.pc-expand').getAttribute('aria-expanded')==='false') await added.locator('.pc-expand').click();
 await added.locator('textarea').fill('Explain this');assert.equal(await added.locator('.pc-ask-codex').isDisabled(),true);
 await v.ui.locator('.pc-apply').click();const edit=decode((await v.frame.evaluate(()=>window.__calls)).at(-1));assert.equal(edit.intent,'edit');assert.equal(edit.selected_step_ids,undefined);assert.ok(edit.operations.some(o=>o.type==='add_step'));
 const empty=await setup({file:'empty.html'});assert.equal(await empty.ui.locator('.pc-row').count(),0);assert.equal(await empty.ui.locator('.pc-implement').isDisabled(),true);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){const view=await setup({width,theme});assert.equal(await view.frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.ok(await view.ui.locator('.pc-expand-icon svg').count()>0);}
 assert.deepEqual(errors,[]);console.log('PASS: scoped selection, prerequisites, completion isolation, new-step drafts, add controls, empty plans, and layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
