const {fs,path,assert,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs'),dir=createScratch(),errors=[];
const base=api.initialize({title:'Debugger architecture update',steps:[
 {id:'transport',title:'Update the debugger transport',description:'Use the revised connection contract.',review_state:'needs_review',review_note:'Transport scope updated after architecture review.',complexity:'moderate',complexity_reason:'Coordinates the transport and session interfaces'},
 {id:'adapter',title:'Adapt the existing debugger session',status:'in_progress',description:'Resume the adapter against the updated transport contract.',progress_note:'Session discovery and breakpoint mapping are implemented.',needs_replanning:true,review_state:'needs_review',review_note:'The session contract changed while this step was in progress.',complexity:'moderate',complexity_reason:'Coordinates the transport and session interfaces'},
 {id:'integration',title:'Verify debugger integration',depends_on:['transport'],description:'Run the debugger flow against the updated transport.',complexity:'low',complexity_reason:'Exercises the established integration checks'},
 {id:'decision',title:'Configure remote authentication',blocked_by:'Authentication method is undecided',complexity:'moderate',complexity_reason:'Coordinates the transport and session interfaces'}
]});
fs.writeFileSync(path.join(dir,'freshness.html'),api.render(base,path.join(dir,'plan.md')));
const row=(v,id)=>v.ui.locator(`[data-step="${id}"]`);
(async()=>{const browser=await launch();try{
 const v=await createView(browser,errors,dir,{file:'freshness.html',expanded:['adapter']});
 assert.equal(await row(v,'transport').locator('.pc-check input').isDisabled(),false);
 assert.match(await row(v,'transport').textContent(),/Changed since last review/);
 assert.match(await row(v,'adapter').textContent(),/Needs replanning/);
 assert.equal(await row(v,'integration').locator('.pc-check input').isDisabled(),true);
 assert.match(await row(v,'integration').locator('.pc-condition').textContent(),/Select first: Update/);
 assert.match(await row(v,'decision').locator('.pc-condition').textContent(),/Ask Codex to resolve/);
 if(process.env.SCREENSHOT_PATH) await v.ui.locator('section[aria-label="Interactive task plan"]').screenshot({path:process.env.SCREENSHOT_PATH});
 await row(v,'adapter').getByRole('button',{name:'Resume with updated scope',exact:true}).click();
 const req=JSON.parse((await v.frame.evaluate(()=>window.__calls.at(-1))).prompt.split('Change request JSON:\n')[1]);
 assert.deepEqual(req.selected_step_ids,['adapter']);
 const [result]=api.applyRequest(base,req);
 assert.equal(result.steps[1].needs_replanning,undefined);
 assert.equal(result.steps[1].progress_note,base.steps[1].progress_note);
 for(const [width,theme] of [[736,'light'],[320,'dark']]){
  const view=await createView(browser,errors,dir,{file:'freshness.html',width,theme});
  assert.equal(await view.frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 assert.deepEqual(errors,[]);console.log('PASS: advisory freshness, scoped resume, visible blockers, progress preservation and responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
