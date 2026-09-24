const {fs,path,assert,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs');
const dir=createScratch(),errors=[];
const plan=api.initialize({title:'Model-managed execution',steps:[
 {id:'one',title:'Implement parser',reasoning_effort:'high',parallel_group:1}, {id:'two',title:'Implement layout',reasoning_effort:'medium',parallel_group:1},
]});
const canonical=path.join(dir,'plan.md');
fs.writeFileSync(path.join(dir,'plan.html'),api.render(plan,canonical));
fs.writeFileSync(path.join(dir,'preview.html'),api.render(plan,canonical,true));
fs.writeFileSync(path.join(dir,'finished.html'),api.render({...plan,lifecycle:'finished'},canonical));
const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try{
 const v=await createView(browser,errors,dir,{file:'plan.html'});
 assert.equal(await v.ui.locator('.pc-use-subagents').count(),0);
 assert.equal(await v.ui.locator('.pc-parallel-group').count(),2);
 assert.match(await v.ui.locator('.pc-parallel-summary').textContent(),/Can run in parallel: #1, #2/);
 await v.ui.locator('.pc-select-all').click();
 await v.frame.evaluate(()=>window.__fail=true);
 await v.ui.locator('.pc-implement').click();
 const first=(await v.frame.evaluate(()=>window.__calls)).at(-1), parallel=decode(first);
 assert.equal(parallel.execution_mode,'auto');
 assert.deepEqual(parallel.selected_step_ids,['one','two']);
 assert.match(first.prompt,/model-managed execution/);
 assert.match(first.prompt,/coordinator owns canonical-plan checkpoints, integration, conflict resolution, and validation/);
 const saved=await v.frame.evaluate(()=>window.__saved);
 const retry=await createView(browser,errors,dir,{file:'plan.html',saved});
 await retry.ui.locator('.pc-implement').click();
 assert.deepEqual(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)),parallel);
 const late=await createView(browser,errors,dir,{file:'plan.html'});
 await late.frame.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),{
  modelContent:{kind:'plan-companion',ui_version:3,plan_id:plan.plan_id,base_revision:plan.revision,operations:[],selected_step_ids:[]},
  privateContent:{execution_mode:'parallel'},
 });
 assert.equal(await late.ui.locator('.pc-use-subagents').count(),0);
 // Editing is still only editing, even with the draft execution option enabled.
 await late.ui.locator('[data-step="one"] .pc-expand').click();
 await late.ui.getByRole('combobox',{name:'Reasoning effort: Implement parser',exact:true}).selectOption('low');
 await late.ui.locator('.pc-apply').click();
 const edit=decode((await late.frame.evaluate(()=>window.__calls)).at(-1));
 assert.equal(edit.intent,'edit');assert.equal(edit.execution_mode,undefined);
 const preview=await createView(browser,errors,dir,{file:'preview.html',saved});
 await preview.ui.locator('.pc-implement').click();
 assert.equal(await preview.frame.evaluate(()=>window.__calls.length),0);
 assert.match(await preview.ui.locator('.pc-status').textContent(),/would choose/);
 const finished=await createView(browser,errors,dir,{file:'finished.html',saved});
 assert.equal(await finished.ui.locator('.pc-execution-option').isVisible(),false);
 await finished.ui.locator('.pc-lifecycle').click();
 const reopen=decode((await finished.frame.evaluate(()=>window.__calls)).at(-1));
 assert.equal(reopen.intent,'reopen');assert.equal(reopen.execution_mode,undefined);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){
  const view=await createView(browser,errors,dir,{file:'plan.html',width,theme,saved});
  assert.equal(await view.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  await view.page.screenshot({path:`/tmp/hyperion-parallel-${width}-${theme}.png`});
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: model-managed execution, visible parallel candidates, failed-send retry, late host restoration, edit/preview/finished boundaries, responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
