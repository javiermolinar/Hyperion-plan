const {fs,path,assert,createScratch,launch,createView}=require('./support.cjs');
const api=require('../../dist/index.cjs');
const dir=createScratch(),errors=[];
const p=api.initialize({title:'Ask Codex workflow',steps:[
 {id:'a',title:'Parser',reasoning_effort:'high',parallel_group:1,description:'Preserve exact line boundaries.'},
 {id:'b',title:'Layout',reasoning_effort:'medium',parallel_group:1},
 {id:'c',title:'Integrate parser',depends_on:['a']},
 {id:'r',title:'Review changes',kind:'review',depends_on:['a','b','c'],checks:['Check invariants']},
 {id:'h',title:'Next phase',kind:'handover'},
 {id:'d',title:'Documentation',reasoning_effort:'low',parallel_group:2},
 {id:'e',title:'Examples',reasoning_effort:'low',parallel_group:2},
]});
const file=path.join(dir,'plan.md');api.saveMarkdown(file,p);
for(const [name,plan,preview] of [['plan',p,false],['demo',p,true],['finished',{...p,lifecycle:'finished'},false],['empty',api.initialize({title:'Empty',steps:[]}),false]]) fs.writeFileSync(path.join(dir,name+'.html'),api.render(plan,file,preview));
const decode=call=>JSON.parse(call.prompt.split('Change request JSON:\n')[1]);
const input=v=>v.ui.getByRole('textbox',{name:'Ask Codex about: Parser',exact:true});
(async()=>{const browser=await launch();try{
 const setup=opts=>createView(browser,errors,dir,{file:'plan.html',expanded:['a'],...opts});
 const v=await setup();
 assert.equal(await v.ui.locator('.pc-more,.pc-menu,.pc-use-subagents').count(),0);
 assert.equal(await v.ui.locator('.pc-reasoning-label svg').count(),6); // brain only
 assert.equal(await v.ui.locator('.pc-expand-icon').count(),7);
 assert.equal(await v.ui.locator('.pc-parallel-group').count(),4);
 await v.ui.locator('[data-step="d"] .pc-parallel-group').click();
 assert.deepEqual(await v.ui.locator('.pc-group-highlight').evaluateAll(rows=>rows.map(r=>r.dataset.step)),['d','e']);
 await v.ui.locator('[data-step="a"] .pc-parallel-group').click();
 assert.deepEqual(await v.ui.locator('.pc-group-highlight').evaluateAll(rows=>rows.map(r=>r.dataset.step)),['a','b']);
 await v.ui.locator('.pc-select-all').click();
 await v.ui.locator('[data-step="b"] .pc-reasoning-select').selectOption('high');
 await input(v).fill('Why is this needed?');
 const savedBefore=await v.frame.evaluate(()=>window.__saved);
 assert.equal(savedBefore.modelContent.operations.length,1); // effort draft, not question
 assert.equal(savedBefore.modelContent.operations[0].type,'set_reasoning_effort');
 await v.frame.evaluate(()=>window.__fail=true);
 await input(v).press('Enter');
 let calls=await v.frame.evaluate(()=>window.__calls),req=decode(calls.at(-1));
 assert.equal(req.intent,'ask');assert.equal(req.question,'Why is this needed?');
 assert.deepEqual(req.target_step_ids,['a']);assert.deepEqual(req.operations,[]);
 assert.equal(req.selected_step_ids,undefined);assert.equal(req.execution_mode,undefined);
 assert.match(calls.at(-1).prompt,/does not authorize implementation/);
 assert.match(await v.ui.locator('.pc-status').textContent(),/preserved/);
 let [applied]=api.applyRequest(p,req);assert.deepEqual(applied.steps,p.steps);
 assert.equal(api.applyRequest(applied,req)[1],false);
 const saved=await v.frame.evaluate(()=>window.__saved);
 const retry=await setup({saved});assert.equal(await input(retry).inputValue(),req.question);
 assert.equal(await retry.ui.locator('.pc-group-highlight').count(),2);
 await input(retry).press('Enter');
 assert.deepEqual(decode((await retry.frame.evaluate(()=>window.__calls)).at(-1)),req);
 await input(retry).fill('Split this step');await input(retry).press('Enter');
 const changed=decode((await retry.frame.evaluate(()=>window.__calls)).at(-1));assert.notEqual(changed.request_id,req.request_id);
 // Host refreshes must preserve focus, element identity, selection and late drafts.
 const late=await setup({expanded:[]});await late.frame.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),saved);
 assert.equal(await input(late).inputValue(),'Why is this needed?');
 const identity=await input(late).elementHandle();await input(late).focus();
 await input(late).evaluate(el=>el.setSelectionRange(2,7));
 for(let i=0;i<3;i++) await late.frame.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),saved);
 assert.equal(await input(late).evaluate((el,old)=>el===old,identity),true);
 assert.deepEqual(await input(late).evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,7]);
 await input(late).fill('New typing');
 await late.frame.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),saved);
 assert.equal(await input(late).inputValue(),'New typing');
 // Question text never creates Save edits or dependent freshness changes.
 const clean=await setup();await input(clean).fill('Move this later');
 assert.equal(await clean.ui.locator('.pc-apply').isVisible(),false);
 assert.equal(await clean.ui.locator('.pc-review-label').count(),0);
 assert.deepEqual((await clean.frame.evaluate(()=>window.__saved)).modelContent.operations,[]);
 for(const options of [{isComposing:true},{keyCode:229},{repeat:true}]) await input(clean).evaluate((el,options)=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options})),options);
 assert.equal(await clean.frame.evaluate(()=>window.__calls.length),0);
 await input(clean).fill('Line one');await input(clean).press('Meta+Enter');await input(clean).pressSequentially('Line two');
 assert.equal(await input(clean).inputValue(),'Line one\nLine two');
 await input(clean).fill('x'.repeat(1000));await input(clean).press('End');await input(clean).press('Meta+Enter');assert.equal((await input(clean).inputValue()).length,1000);
 await input(clean).evaluate(el=>el.setSelectionRange(499,500));await input(clean).press('Meta+Enter');assert.equal((await input(clean).inputValue())[499],'\n');
 await input(clean).fill('');await input(clean).press('Enter');assert.equal(await clean.frame.evaluate(()=>window.__calls.length),0);
 await clean.ui.locator('.pc-ask-codex').first().isDisabled().then(x=>assert.equal(x,true));
 // Offline/preview/finished boundaries and legacy note draft migration.
 const offline=await setup();await offline.frame.evaluate(()=>delete window.openai.sendFollowUpMessage);await input(offline).fill('Explain this');await input(offline).press('Enter');assert.match(await offline.ui.locator('.pc-status').textContent(),/inside Codex/);assert.equal(await input(offline).inputValue(),'Explain this');
 const demo=await setup({file:'demo.html'});await input(demo).fill('Remove this');await input(demo).press('Enter');assert.equal(await demo.frame.evaluate(()=>window.__calls.length),0);assert.match(await demo.ui.locator('.pc-status').textContent(),/No request was sent/);
 const done=await setup({file:'finished.html',saved});assert.equal(await input(done).isDisabled(),true);await done.ui.locator('.pc-lifecycle').click();const reopen=decode((await done.frame.evaluate(()=>window.__calls)).at(-1));assert.equal(reopen.intent,'reopen');assert.deepEqual(reopen.operations,[]);
 const legacy={modelContent:{kind:'plan-companion',ui_version:3,plan_id:p.plan_id,base_revision:p.revision,operations:[{type:'add_comment',step_id:'a',comment_id:'legacy',text:'Keep this old note'}],selected_step_ids:[]},privateContent:{expanded:['a'],note_editors:[{step_id:'a',id:'legacy'}]}};
 const migrated=await setup({saved:legacy});assert.match(await migrated.ui.locator('[data-step="a"]').textContent(),/Keep this old note/);assert.equal(await input(migrated).inputValue(),'');await migrated.ui.locator('.pc-apply').click();const edit=decode((await migrated.frame.evaluate(()=>window.__calls)).at(-1));assert.equal(edit.operations[0].text,'Keep this old note');
 for(const [width,theme] of [[736,'light'],[736,'dark'],[320,'light'],[320,'dark']]){
 const narrow=await setup({width,theme});await input(narrow).fill('Add an independent review after this step.');assert.equal(await narrow.frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await narrow.ui.locator('.pc-ask-codex').first().isVisible(),true);
 }
 assert.deepEqual(errors,[]);console.log('PASS: Ask Codex isolation, exact retries, revisions, drafts, host refresh, keyboard, groups, lifecycle, legacy notes, and responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
