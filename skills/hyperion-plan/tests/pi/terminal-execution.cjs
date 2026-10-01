// Real CLI/terminal, isolated offline wave + review + effort acceptance fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const core=require('../../dist/index.cjs'),root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-terminal-execution-'));
const cwd=path.join(dir,'workspace'),home=path.join(dir,'home'),trace=path.join(dir,'events.jsonl'),planPath=path.join(cwd,'plan.md');
console.log(`Execution terminal artifacts: ${dir}`);fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});fs.mkdirSync(home);
fs.writeFileSync(path.join(cwd,'.pi/settings.json'),JSON.stringify({packages:[root]}));fs.writeFileSync(path.join(cwd,'.pi/hyperion-plan.json'),JSON.stringify({default_plan:'plan.md'}));
fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({quietStartup:true,theme:'dark',tuiMode:'regular',cacheWarming:'off',enableAnalytics:false,enableInstallTelemetry:false,retry:{enabled:false},compaction:{enabled:false}}));
fs.writeFileSync(path.join(cwd,'fixture-marker'),'offline-execution-only');fs.writeFileSync(path.join(cwd,'code.txt'),'fixture code');
execFileSync('git',['init','-q',cwd]);execFileSync('git',['-C',cwd,'add','code.txt']);execFileSync('git',['-C',cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
core.saveMarkdown(planPath,core.initialize({title:'Terminal execution fixture',steps:[{id:'a',title:'Independent output A',reasoning_effort:'low',parallel_group:1},{id:'b',title:'Independent output B',reasoning_effort:'none',parallel_group:1},{id:'review',title:'Inspect captured outputs',kind:'review',depends_on:['a','b'],reasoning_effort:'high',checks:['Inspect captured a.txt and b.txt; both must contain approved.']},{id:'unselected',title:'Leave untouched'}]}));
const events=()=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(50);}throw Error('Timed out: '+label);}
(async()=>{
 let port,diagnostic='';const log=fs.openSync(path.join(dir,'ttyd.log'),'w');
 const server=spawn('ttyd',['-i','127.0.0.1','-p','0','-W','-o','-t','fontSize=14','-t','rendererType=dom','-w',cwd,process.execPath,path.join(root,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--provider','execution-fixture','--model','scripted','--thinking','off','--offline','--approve','--no-builtin-tools','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','-e',path.join(__dirname,'execution-fixture.ts')],{detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:home,TMPDIR:os.tmpdir(),TERM:'xterm-256color',COLORTERM:'truecolor',LANG:'en_US.UTF-8',PI_CODING_AGENT_DIR:home,PI_OFFLINE:'1',HYPERION_EXECUTION_ROOT:cwd,HYPERION_TEST_TRACE:trace}});
 const save=b=>{fs.writeSync(log,b);diagnostic+=b;port=/Listening on port: (\d+)/.exec(diagnostic)?.[1];};server.stdout.on('data',save);server.stderr.on('data',save);
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}),page=await browser.newPage({viewport:{width:1400,height:900}});
 const text=()=>page.evaluate(()=>{const t=window.term,b=t?.buffer.active;return b?Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||'').join('\n'):'';});
 const wait=s=>until(async()=>(await text()).includes(s),s),command=async s=>{await page.evaluate(s=>{window.term.focus();window.term.paste(s);},s);await delay(150);await page.keyboard.press('Enter');};
 const shot=async name=>{await page.screenshot({path:path.join(dir,name+'.png')});fs.writeFileSync(path.join(dir,name+'.txt'),await text());};
 try{
  await until(()=>port,'ttyd');await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>!!window.term);await until(()=>events().some(e=>e.event==='session_start'),'Pi startup');
  await command('Source history');await wait('PRIVATE_PARENT_HISTORY');await command('/hyperion-plan');await wait('CANONICAL PLAN');
  for(let i=0;i<3;i++){await page.keyboard.press('Space');if(i<2)await page.keyboard.press('ArrowDown');}await wait('3 selected');await page.keyboard.press('r');
  await until(()=>events().some(e=>e.event==='worker-active'&&e.peak===2),'actual two-worker overlap');
  await page.evaluate(()=>window.term.paste('fixture-draft'));await wait('fixture-draft');assert.doesNotMatch(await text(),/CANONICAL PLAN/);await shot('active-inline');
  await until(()=>events().some(e=>e.event==='complete'),'verified wave then fresh review',60000);await wait('EXECUTION_FIXTURE_VERIFIED');await wait('fixture-draft');await shot('complete-inline');
  assert.ok(!events().some(e=>e.event==='failure'),JSON.stringify(events()));assert.ok(!events().some(e=>e.event==='tool_result'&&e.error),JSON.stringify(events()));
  const p=core.loadMarkdown(planPath)[0],ledger=JSON.parse(fs.readFileSync(path.join(cwd,'.hyperion-dispatch','plan.md','ledger.json'),'utf8'));
  assert.deepEqual(p.execution.selected_step_ids,['a','b','review']);assert.ok(p.steps.slice(0,3).every(s=>s.status==='completed'));assert.equal(p.steps[3].status,'pending');assert.ok(ledger.waves[0].reconciliation);
  assert.equal(ledger.records.length,3);assert.equal(new Set(ledger.records.map(r=>r.handle.session.native_id)).size,3);assert.ok(ledger.records.every(r=>r.phase==='settled'&&r.result.quiescence.state==='verified'&&r.verification));
  for(const r of ledger.records){const wanted=r.assignment.step_id==='a'?'low':r.assignment.step_id==='b'?'off':'high';assert.equal(r.effort.actual,wanted);const entries=fs.readFileSync(r.handle.transcript_path,'utf8').trim().split('\n').map(JSON.parse);assert.equal(entries[0].parentSession,undefined);assert.doesNotMatch(JSON.stringify(entries),/PRIVATE_PARENT_HISTORY/);}
  await page.keyboard.press('Control+u');await command('/hyperion-plan');await wait('CANONICAL PLAN');await wait('3/4 complete');await shot('completed-plan');
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({plan:p,children:ledger.records.map(r=>({step:r.assignment.step_id,id:r.handle.session.native_id,phase:r.phase,effort:r.effort})),peak:2,checks:['native selected Run','two actual concurrent SDK workers','per-step low/off/high and parent off','fresh read-only snapshot reviewer','coordinator verification and per-step checkpoints','reconciled wave before review','unselected untouched','inline progress preserves editor draft and does not open an overlay'],limitation:'Offline scripted fixture, not independent review or live-model routing'},null,2));
  console.log('PASS installed terminal wave/review/effort and no-focus progress');
 }catch(error){await shot('failure').catch(()=>{});throw error;}
 finally{await page.close();await browser.close();try{process.kill(-server.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}await until(()=>server.exitCode!==null||server.signalCode!==null,'terminal cleanup',5000);fs.closeSync(log);}
})().catch(error=>{console.error(error);process.exitCode=1;});
