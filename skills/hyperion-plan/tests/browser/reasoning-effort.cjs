const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs');
const dir=createScratch(),errors=[];
const plan=api.initialize({title:'Per-step reasoning',steps:[
 {id:'work',title:'Implement storage'},
 {id:'review',title:'Review storage',kind:'review',depends_on:['work'],checks:['Verify persistence'],reasoning_effort:'xhigh'},
 {id:'done',title:'Completed setup',status:'completed',reasoning_effort:'low'},
]});
const canonical=path.join(dir,'plan.md');api.saveMarkdown(canonical,plan);
fs.writeFileSync(path.join(dir,'plan.html'),api.render(plan,canonical));
const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try{
 const v=await createView(browser,errors,dir,{file:'plan.html',expanded:['work','review','done']});
 assert.equal(await v.ui.locator('.pc-next').count(),0);
 assert.equal(await v.frame.evaluate(()=>window.__saved?.modelContent.operations.length ?? 0),0);
 await v.ui.locator('[data-step="work"] .pc-expand').click();
 assert.equal(await v.ui.getByRole('combobox',{name:'Reasoning effort: Implement storage',exact:true}).count(),1);
 assert.equal(await v.ui.getByRole('slider').count(),0);
 await v.ui.locator('[data-step="work"] .pc-expand').click();
 const control=v.ui.getByRole('combobox',{name:'Reasoning effort: Implement storage',exact:true});
 assert.equal(await control.inputValue(),'inherit');
 assert.equal(await v.ui.getByRole('combobox',{name:'Reasoning effort: Completed setup',exact:true}).isDisabled(),true);
 await control.selectOption('high');
 assert.match(await v.ui.locator('[data-step="work"] .pc-reasoning-label').textContent(),/High/);
 assert.equal(await v.frame.evaluate(()=>window.__calls.length),0);
 await v.frame.evaluate(()=>window.__fail=true);
 await v.ui.locator('.pc-apply').click();
 const first=decode((await v.frame.evaluate(()=>window.__calls)).at(-1));
 assert.equal(first.intent,'edit');
 assert.deepEqual(first.operations,[{type:'set_reasoning_effort',step_id:'work',reasoning_effort:'high'}]);
 const saved=await v.frame.evaluate(()=>window.__saved);
 const retry=await createView(browser,errors,dir,{file:'plan.html',saved});
 assert.equal(await retry.ui.getByRole('combobox',{name:'Reasoning effort: Implement storage',exact:true}).inputValue(),'high');
 await retry.ui.locator('.pc-apply').click();
 assert.equal(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)).request_id,first.request_id);
 const input=path.join(dir,'request.json');fs.writeFileSync(input,JSON.stringify(first));
 execFileSync(process.execPath,[helper,'apply','--plan',canonical,'--request',input]);
 const current=api.read(canonical);assert.equal(current.steps[0].reasoning_effort,'high');assert.equal(current.execution,undefined);
 fs.writeFileSync(path.join(dir,'saved.html'),api.render(current,canonical));
 const next=await createView(browser,errors,dir,{file:'saved.html',expanded:['work']});
 const reset=next.ui.getByRole('combobox',{name:'Reasoning effort: Implement storage',exact:true});
 await reset.selectOption('inherit');
 await next.ui.locator('[data-step="work"] input[type=checkbox]').check();
 await next.ui.locator('.pc-implement').click();
 const call=(await next.frame.evaluate(()=>window.__calls)).at(-1), request=decode(call);
 assert.equal(request.operations[0].reasoning_effort,'inherit');assert.deepEqual(request.selected_step_ids,['work']);
 assert.match(call.prompt,/reasoning_effort/);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){
  const view=await createView(browser,errors,dir,{file:'saved.html',width,theme,expanded:['work','review']});
  assert.equal(await view.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  await view.page.screenshot({path:`/tmp/hyperion-reasoning-${width}-${theme}.png`});
 }
 assert.deepEqual(errors,[]);console.log('PASS: reasoning selection, draft/retry restoration, canonical save, reset to inherit, execution request and responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
