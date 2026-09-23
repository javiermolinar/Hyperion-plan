const {fs,path,assert,execFileSync,helper,createScratch,launch,createView}=require('./support.cjs');
const dir=createScratch(),errors=[];
const plan={schema_version:1,plan_id:'review-plan',revision:4,title:'Migration plan',steps:[{id:'done',title:'Existing service',status:'completed'},{id:'next',title:'Migrate writes',status:'pending'}]};
function render(name,p,preview=false){fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(p));execFileSync(process.execPath,[helper,'render','--plan',path.join(dir,name+'.json'),'--output',path.join(dir,name+'.html'),...(preview?['--preview']:[])]);}
render('plan',plan);render('preview',plan,true);
render('result',{...plan,plan_reviews:[{request_id:'r',revision:2,target_step_ids:['next'],focus:'Rollback',state:'completed',task_id:'reviewer',report_path:'/tmp/review.md',findings:[{step_ids:['next'],text:'Rollback missing',resolution:'needs_input',reason:'Choose reversibility'}]}]});
render('running',{...plan,plan_reviews:[{request_id:'r',revision:2,target_step_ids:['next'],focus:'',state:'running',task_id:'reviewer',findings:[]}]});
const decode=c=>JSON.parse(c.prompt.split('Change request JSON:\n')[1]);
(async()=>{const browser=await launch();try{
 const v=await createView(browser,errors,dir,{file:'plan.html'});
 await v.ui.locator('.pc-review-plan').click();assert.equal(await v.frame.evaluate(()=>window.__calls.length),0);
 await v.ui.locator('.pc-independent-review').click();
 assert.equal(await v.ui.locator('.pc-plan-review-scope').inputValue(),'all');
 await v.ui.locator('.pc-plan-review-focus').fill('Challenge rollback');
 await v.frame.evaluate(()=>window.__fail=true);
 await v.ui.locator('.pc-start-plan-review').click();
 const first=decode((await v.frame.evaluate(()=>window.__calls)).at(-1));
 assert.equal(first.review_mode,'independent');assert.equal(first.review_focus,'Challenge rollback');assert.deepEqual(first.target_step_ids,['done','next']);assert.equal(first.selected_step_ids,undefined);
 const saved=await v.frame.evaluate(()=>window.__saved);
 const retry=await createView(browser,errors,dir,{file:'plan.html',saved});
 await retry.ui.locator('.pc-review-plan').click();await retry.ui.locator('.pc-independent-review').click();
 assert.equal(await retry.ui.locator('.pc-plan-review-focus').inputValue(),'Challenge rollback');
 await retry.ui.locator('.pc-start-plan-review').click();assert.equal(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)).request_id,first.request_id);
 await retry.ui.locator('[data-step="next"] .pc-check input').check();await retry.ui.locator('.pc-review-selection').click();await retry.ui.locator('.pc-independent-review').click();
 assert.equal(await retry.ui.locator('.pc-plan-review-scope').inputValue(),'selected');
 await retry.ui.locator('.pc-start-plan-review').click();assert.deepEqual(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)).target_step_ids,['next']);
 const running=await createView(browser,errors,dir,{file:'running.html'});await running.ui.locator('.pc-review-plan').click();assert.equal(await running.ui.locator('.pc-independent-review').isDisabled(),true);
 const preview=await createView(browser,errors,dir,{file:'preview.html'});await preview.ui.locator('.pc-review-plan').click();await preview.ui.locator('.pc-independent-review').click();await preview.ui.locator('.pc-start-plan-review').click();assert.equal(await preview.frame.evaluate(()=>window.__calls.length),0);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){
  const r=await createView(browser,errors,dir,{file:'result.html',width,theme});
  await r.ui.locator('.pc-plan-reviews summary').click();assert.match(await r.ui.locator('.pc-plan-reviews').textContent(),/Needs your input/);
  await r.ui.locator('.pc-review-plan').click();await r.ui.locator('.pc-independent-review').click();
  assert.equal(await r.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  assert.equal(await r.ui.locator('.pc-plan-review-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);
  await r.page.screenshot({path:`/tmp/hyperion-review-${width}-${theme}.png`});
 }
 assert.deepEqual(errors,[]);console.log('PASS: independent review dialog, retry restoration, scope, preview isolation, running and findings, responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
