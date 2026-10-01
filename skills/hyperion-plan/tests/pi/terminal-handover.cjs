// Captured real-terminal handover fixture. Never targets a user plan/session.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const core=require('../../dist/index.cjs'),root=path.resolve(__dirname,'../..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-terminal-handover-')),cwd=path.join(dir,'workspace'),home=path.join(dir,'home'),trace=path.join(dir,'events.jsonl');
console.log(`Handover terminal artifacts: ${dir}`);fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});fs.mkdirSync(home);
fs.writeFileSync(path.join(cwd,'.pi/settings.json'),JSON.stringify({packages:[root]}));
fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({quietStartup:true,theme:'dark',tuiMode:'regular',cacheWarming:'off',enableInstallTelemetry:false,enableAnalytics:false,retry:{enabled:false},compaction:{enabled:false}}));
fs.writeFileSync(path.join(cwd,'fixture-marker'),'offline-handover-only');fs.writeFileSync(path.join(cwd,'code.txt'),'fixture input');
execFileSync('git',['init','-q',cwd]);execFileSync('git',['-C',cwd,'add','code.txt']);execFileSync('git',['-C',cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
const planPath=path.join(cwd,'plan.md');core.saveMarkdown(planPath,core.initialize({title:'Terminal handover fixture',steps:[{id:'pre',title:'Previous work',status:'completed'},{id:'gate',title:'Transfer coordinator',kind:'handover'},{id:'after',title:'Verify destination'},{id:'unselected',title:'Leave untouched'}]}));
fs.writeFileSync(path.join(cwd,'.pi/hyperion-plan.json'),JSON.stringify({default_plan:'plan.md'}));
const events=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const snapshot=()=>core.loadMarkdown(planPath)[0];const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(70);}throw Error(`Timed out: ${label}`);}
(async()=>{
 const log=fs.openSync(path.join(dir,'ttyd.log'),'w');let port,diagnostic='';
 const server=spawn('ttyd',['-i','127.0.0.1','-p','0','-W','-o','-t','fontSize=14','-t','rendererType=dom','-w',cwd,process.execPath,path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
 '--provider','handover-fixture','--model','scripted','--thinking','off','--offline','--approve','--no-builtin-tools','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','-e',path.join(__dirname,'handover-fixture.ts')],
 {detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:home,TMPDIR:os.tmpdir(),TERM:'xterm-256color',COLORTERM:'truecolor',LANG:'en_US.UTF-8',PI_CODING_AGENT_DIR:home,PI_OFFLINE:'1',HYPERION_HANDOVER_ROOT:cwd,HYPERION_TEST_TRACE:trace}});
 const save=b=>{fs.writeSync(log,b);diagnostic+=b;port=/Listening on port: (\d+)/.exec(diagnostic)?.[1];};server.stdout.on('data',save);server.stderr.on('data',save);
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});const page=await browser.newPage({viewport:{width:1400,height:900}});
 const screen=()=>page.evaluate(()=>{const t=window.term,b=t?.buffer.active;return b?Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||''):[];});
 const text=async()=>(await screen()).join('\n');const wait=s=>until(async()=>(await text()).includes(s),s);
 const command=async s=>{await page.evaluate(s=>{window.term.focus();window.term.paste(s);},s);await delay(180);await page.keyboard.press('Enter');};
 const shot=async name=>{await delay(300);await page.screenshot({path:path.join(dir,name+'.png')});fs.writeFileSync(path.join(dir,name+'.txt'),await text());};
 try{
  await until(()=>port,'ttyd');await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>!!window.term);await until(()=>events().some(e=>e.event==='session_start'),'Pi startup');
  await command('Source history');await wait('PRIVATE_SOURCE_HISTORY');
  await command('/hyperion-plan');await wait('CANONICAL PLAN');await shot('before');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Space');await wait('1 selected');await page.keyboard.press('r');
  await until(()=>snapshot().steps[2].status==='completed','native Run through actual terminal handover');await wait('HANDOVER_DESTINATION_VERIFIED');await wait('Resumed session');await shot('destination');
  const p=snapshot(),continued=events().find(e=>e.event==='continued'),source=events().find(e=>e.event==='session_start');
  assert.ok(continued&&continued.id!==source.id);assert.equal(p.execution_owner,continued.id);assert.equal(p.steps[1].status,'completed');assert.equal(p.steps[3].status,'pending');assert.deepEqual(p.execution.selected_step_ids,['gate','after']);
  assert.ok(events().some(e=>e.event==='session_shutdown'&&e.id===source.id));
  await command('/hyperion-plan');await wait('CANONICAL PLAN');await wait('3/4 complete');await shot('destination-plan');await page.keyboard.press('Escape');await until(async()=>!(await text()).includes('CANONICAL PLAN'),'overlay closed');
  await command('/fixture-source');await until(()=>events().some(e=>e.event==='source-restored'),'source restoration');await command('ATTEMPT_SOURCE_WRITE');await wait('SOURCE_WRITE_BLOCKED');await shot('source-blocked');
  assert.equal(events().filter(e=>e.event==='continued').length,1);assert.equal(fs.readFileSync(path.join(cwd,'continued.txt'),'utf8'),continued.id);
  await command('!printf forbidden > forbidden.txt');await delay(700);assert.equal(fs.existsSync(path.join(cwd,'forbidden.txt')),false);await shot('source-bash-blocked');
  await command('/hyperion-handover-open');await wait('HANDOVER_DESTINATION_VERIFIED');await delay(300);
  await command('/fixture-pause');await until(()=>snapshot().execution.state==='paused','destination pause');
  await command('/fixture-source');await until(()=>events().filter(e=>e.event==='source-restored').length===2,'second source restoration');await delay(300);
  await command('/hyperion-handover-open');await wait('HANDOVER_DESTINATION_VERIFIED');await shot('paused-destination');
  assert.equal(snapshot().execution.state,'paused');assert.equal(events().filter(e=>e.event==='continued').length,1,'navigation does not replay a consumed continuation');
  assert.ok(!events().some(e=>e.event==='failure'),JSON.stringify(events()));
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({source,destination:continued,plan:snapshot(),checks:['native Run selection','readiness then transfer','public terminal replacement','same persistent destination','selected-only continuation checkpoints','destination plan binding','source shutdown','restored source model tools blocked','native user-bash blocked','read-only destination navigation while paused; no continuation replay'],limitations:['Offline scripted provider, not live-model routing','No live-plan transfer']},null,2));
  console.log('PASS native terminal handover and source fencing');
 }catch(error){await shot('failure').catch(()=>{});throw error;}
 finally{await page.close();await browser.close();try{process.kill(-server.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}await until(()=>server.exitCode!==null||server.signalCode!==null,'terminal cleanup',5000);fs.closeSync(log);}
})().catch(e=>{console.error(e);process.exitCode=1;});
