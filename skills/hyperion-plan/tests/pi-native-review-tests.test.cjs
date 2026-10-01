const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const load=()=>import(pathToFileURL(path.resolve(__dirname,'../dist/pi-runner.js')).href);
async function fixture(t,body="const {test}=require('node:test');test('captured',()=>{});"){
 const api=await load(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-native-test-'))),source=path.join(root,'source');
 fs.mkdirSync(path.join(source,'tests'),{recursive:true});fs.mkdirSync(path.join(source,'node_modules'),{recursive:true});
 fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'fixture',scripts:{test:'DO NOT EXECUTE PACKAGE SCRIPTS'}}));
 fs.writeFileSync(path.join(source,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
 fs.writeFileSync(path.join(source,'node_modules/.package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
 fs.writeFileSync(path.join(source,'node_modules/sentinel'),'dependency original');
 fs.writeFileSync(path.join(source,'tests/example.test.cjs'),body);
 execFileSync('git',['init','-q',source]);execFileSync('git',['-C',source,'add','package.json']);execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=f@invalid.test','commit','-qm','fixture']);
 const files=['package.json','package-lock.json','tests/example.test.cjs'];
 const snapshot=api.captureReviewSnapshot(source,path.join(root,'snapshot'),files);
 const suites=api.nativeReviewTests(source,files);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return{api,root,source,files,snapshot,suites};
}
test('native registry exposes fixed IDs, no scripts; captured execution isolates dependencies/home and retains correlated output',async t=>{
 const f=await fixture(t,`const {test}=require('node:test'),fs=require('fs'),path=require('path'),assert=require('assert/strict');test('isolation',()=>{assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.FAKE_REVIEW_SECRET,undefined);assert.ok(process.env.HOME.includes('.hyperion-test-runtime'));fs.writeFileSync('node_modules/sentinel','changed copy');console.log('FRESH_CAPTURE_TEST');});`);
 assert.deepEqual(f.suites.required,['.:node']);assert.deepEqual(Object.keys(f.suites.tests),['.:node']);
 const old=process.env.FAKE_REVIEW_SECRET;process.env.FAKE_REVIEW_SECRET='not forwarded';
 let result;try{result=await f.api.runCapturedReviewTest(f.snapshot,f.suites.tests['.:node'],new AbortController().signal);}finally{if(old===undefined)delete process.env.FAKE_REVIEW_SECRET;else process.env.FAKE_REVIEW_SECRET=old;}
 t.after(()=>fs.rmSync(result.artifact_root,{recursive:true,force:true}));
 assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(fs.readFileSync(path.join(f.source,'node_modules/sentinel'),'utf8'),'dependency original');
 assert.ok(Object.keys(result.files).every(p=>p.startsWith('.hyperion-test-results/')));assert.ok(!Object.keys(result.files).some(p=>p.includes('node_modules')));
 assert.match(fs.readFileSync(path.join(result.artifact_root,'.hyperion-test-results/suite.log'),'utf8'),/FRESH_CAPTURE_TEST/);
 f.api.assertReviewSnapshotCurrent(f.snapshot);f.api.assertControlledTestArtifacts(result);
 fs.appendFileSync(path.join(result.artifact_root,'.hyperion-test-results/suite.log'),'tamper');assert.throws(()=>f.api.assertControlledTestArtifacts(result),/drifted/);
});
for(const kind of ['failure','missing-dependencies','dependency-mismatch','external-symlink','missing-test','cancelled'])test('native suite preserves '+kind+' as non-pass',async t=>{
 const f=await fixture(t,kind==='failure'?"require('node:test').test('bad',()=>{throw Error('expected failure')});":undefined);
 if(kind==='missing-dependencies')fs.rmSync(path.join(f.source,'node_modules'),{recursive:true});
 if(kind==='dependency-mismatch')fs.writeFileSync(path.join(f.source,'node_modules/.package-lock.json'),'{"packages":{}}');
 if(kind==='external-symlink')fs.symlinkSync(os.tmpdir(),path.join(f.source,'node_modules/external'));
 if(kind==='missing-test')fs.writeFileSync(path.join(f.source,'tests/omitted.test.cjs'),'throw Error("omitted")');
 if(kind==='dependency-mismatch'){
  fs.writeFileSync(path.join(f.source,'package-lock.json'),'{"packages":{"node_modules/missing":{"version":"1"}}}');
  f.snapshot=f.api.captureReviewSnapshot(f.source,path.join(f.root,'snapshot2'),f.files);
 }
 const abort=new AbortController();if(kind==='cancelled')abort.abort();
 if(kind==='cancelled'){await assert.rejects(f.api.runCapturedReviewTest(f.snapshot,f.suites.tests['.:node'],abort.signal),/abort/i);return;}
 const result=await f.api.runCapturedReviewTest(f.snapshot,f.suites.tests['.:node'],abort.signal);t.after(()=>fs.rmSync(result.artifact_root,{recursive:true,force:true}));
 assert.equal(result.status,kind==='failure'?'finding':'not-verified',JSON.stringify(result));f.api.assertReviewSnapshotCurrent(f.snapshot);
});
test('native test cancellation joins a surviving detached child and retains logs',async t=>{
 const f=await fixture(t,`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);`);
 const abort=new AbortController();let workspace;
 const wrapped={description:'cancel fixed fixture',async run(cwd,signal){workspace=cwd;const promise=f.suites.tests['.:node'].run(cwd,signal);const until=Date.now()+10000;while(!fs.existsSync(path.join(cwd,'child.pid'))&&Date.now()<until)await new Promise(r=>setTimeout(r,20));assert.ok(fs.existsSync(path.join(cwd,'child.pid')));abort.abort();return promise;}};
 const result=await f.api.runCapturedReviewTest(f.snapshot,wrapped,abort.signal);t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 assert.equal(result.status,'not-verified',JSON.stringify(result));const pid=Number(fs.readFileSync(path.join(workspace,'child.pid'),'utf8'));
 const ps=execFileSync('/bin/ps',['-axo','pid=,stat='],{encoding:'utf8'}).split('\n').find(l=>Number(l.trim().split(/\s+/)[0])===pid);assert.ok(!ps||/Z/.test(ps),`Child still live: ${ps}`);
});
test('successful exit with a surviving detached child is a finding, not a pass',async t=>{
 const f=await fixture(t,`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();`);
 const result=await f.api.runCapturedReviewTest(f.snapshot,f.suites.tests['.:node'],new AbortController().signal);t.after(()=>fs.rmSync(result.artifact_root,{recursive:true,force:true}));
 assert.equal(result.status,'finding');assert.match(result.evidence,/surviving subprocesses/);
});
test('resource-only native configuration is captured; unrelated repository commands are never loaded',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.source,'.pi'));fs.writeFileSync(path.join(f.source,'.pi/hyperion-review.json'),JSON.stringify({command:'touch forbidden'}));
 assert.deepEqual(f.api.nativeReviewFiles(f.source,f.files),[...f.files,'.pi/hyperion-review.json']);
 assert.deepEqual(Object.keys(f.api.nativeReviewTests(f.source,f.files).tests),['.:node']);assert.ok(!fs.existsSync(path.join(f.source,'forbidden')));
});
test('machine-local resource config overrides legacy paths, environment wins, and suites freeze selected inputs', async t => {
 const f=await fixture(t);
 const keys=['PI_CODING_AGENT_DIR','PLAYWRIGHT_MODULE','CHROMIUM_EXECUTABLE','VISUALIZE_ASSETS'];
 const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}});
 for(const k of keys)delete process.env[k];
 process.env.PI_CODING_AGENT_DIR=path.join(f.root,'agent');
 const playwright=path.join(f.root,'playwright'),assets=path.join(f.root,'assets');
 fs.mkdirSync(playwright);fs.writeFileSync(path.join(playwright,'package.json'),'{}');
 fs.mkdirSync(assets);for(const file of ['visualize.html','visualize.css'])fs.writeFileSync(path.join(assets,file),'fixture');
 const config={PLAYWRIGHT_MODULE:playwright,CHROMIUM_EXECUTABLE:process.execPath,VISUALIZE_ASSETS:assets};
 fs.mkdirSync(path.join(f.source,'.pi'));fs.writeFileSync(path.join(f.source,'.pi/hyperion-review.json'),JSON.stringify({CHROMIUM_EXECUTABLE:'/missing-legacy'}));
 const local=path.join(process.env.PI_CODING_AGENT_DIR,'hyperion/review',require('node:crypto').createHash('sha256').update(fs.realpathSync(f.source)).digest('hex')+'.json');
 fs.mkdirSync(path.dirname(local),{recursive:true});fs.writeFileSync(local,JSON.stringify(config));
 fs.writeFileSync(path.join(f.source,'package.json'),'{"name":"hyperion-plan"}');
 fs.mkdirSync(path.join(f.source,'tests/browser'));fs.writeFileSync(path.join(f.source,'tests/browser/run.cjs'),"console.log('FROZEN_RESOURCES_EXECUTED')");
 const files=f.api.nativeReviewFiles(f.source,[...f.files,'tests/browser/run.cjs']);
 const suites=f.api.nativeReviewTests(f.source,files);assert.deepEqual(suites.setupProblems,[]);
 assert.deepEqual(suites.resources,['PLAYWRIGHT_MODULE','CHROMIUM_EXECUTABLE','VISUALIZE_ASSETS']);
 process.env.CHROMIUM_EXECUTABLE='/missing-environment';assert.ok(f.api.nativeReviewTests(f.source,files).setupProblems.some(p=>p.includes('CHROMIUM_EXECUTABLE')));
 delete process.env.CHROMIUM_EXECUTABLE;
 fs.writeFileSync(local,JSON.stringify({CHROMIUM_EXECUTABLE:'/changed-after-registry'}));
 const snapshot=f.api.captureReviewSnapshot(f.source,path.join(f.root,'browser-snapshot'),files);
 const result=await f.api.runCapturedReviewTest(snapshot,suites.tests['.:browser'],new AbortController().signal);
 t.after(()=>fs.rmSync(result.artifact_root,{recursive:true,force:true}));assert.equal(result.status,'passed',JSON.stringify(result));
 assert.match(fs.readFileSync(path.join(result.artifact_root,'.hyperion-test-results/suite.log'),'utf8'),/FROZEN_RESOURCES_EXECUTED/);
 assert.ok(!files.includes(path.relative(f.source,local)));
});
test('native browser suite repairs a stale asset path in memory and executes the original captured suite', async t => {
 const f=await fixture(t);
 const keys=['PI_CODING_AGENT_DIR','PLAYWRIGHT_MODULE','CHROMIUM_EXECUTABLE','VISUALIZE_ASSETS'];
 const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}});
 for(const k of keys)delete process.env[k];
 process.env.PI_CODING_AGENT_DIR=path.join(f.root,'agent');
 const playwright=path.join(f.root,'playwright'),assets=path.join(f.root,'visualize/1.0.45/skills/visualize/assets');
 fs.mkdirSync(playwright);fs.writeFileSync(path.join(playwright,'package.json'),'{"name":"playwright-core"}');
 fs.mkdirSync(assets,{recursive:true});for(const file of ['visualize.html','visualize.css'])fs.writeFileSync(path.join(assets,file),'fixture');
 fs.mkdirSync(path.join(f.source,'.pi'));
 const configPath=path.join(f.source,'.pi/hyperion-review.json');
 fs.writeFileSync(configPath,JSON.stringify({PLAYWRIGHT_MODULE:playwright,CHROMIUM_EXECUTABLE:process.execPath,VISUALIZE_ASSETS:assets.replace('1.0.45','1.0.39')}));
 const original=fs.readFileSync(configPath);
 fs.writeFileSync(path.join(f.source,'package.json'),'{"name":"hyperion-plan"}');
 fs.mkdirSync(path.join(f.source,'tests/browser'));
 fs.writeFileSync(path.join(f.source,'tests/browser/run.cjs'),"require('node:assert/strict').ok(require('node:fs').existsSync(require('node:path').join(process.env.VISUALIZE_ASSETS,'visualize.html')));console.log('AUTO_RESOLVED_ASSETS_USED');");
 const files=f.api.nativeReviewFiles(f.source,[...f.files,'tests/browser/run.cjs']);
 const suites=f.api.nativeReviewTests(f.source,files);
 assert.deepEqual(suites.setupProblems,[]);assert.equal(suites.resolvedResources.VISUALIZE_ASSETS,assets);
 const snapshot=f.api.captureReviewSnapshot(f.source,path.join(f.root,'auto-snapshot'),files);
 const result=await f.api.runCapturedReviewTest(snapshot,suites.tests['.:browser'],new AbortController().signal);
 t.after(()=>fs.rmSync(result.artifact_root,{recursive:true,force:true}));
 assert.equal(result.status,'passed',JSON.stringify(result));
 const artifacts=path.join(result.artifact_root,'.hyperion-test-results');
 assert.match(fs.readFileSync(path.join(artifacts,'suite.log'),'utf8'),/AUTO_RESOLVED_ASSETS_USED/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts,'provenance.json'))).source_resources.VISUALIZE_ASSETS,assets);
 assert.deepEqual(fs.readFileSync(configPath),original);assert.equal(fs.existsSync(process.env.PI_CODING_AGENT_DIR),false);
 f.api.assertReviewSnapshotCurrent(snapshot);
});
for(const fault of ['deadline','missing-executable','output-limit','log-write'])test('fixed process executor handles '+fault,async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-process-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const output=path.join(dir,'executor.mjs');await require('esbuild').build({entryPoints:[path.resolve(__dirname,'../src/pi/review-process.ts')],outfile:output,bundle:true,platform:'node',format:'esm'});
 const {runReviewCommand}=await import(pathToFileURL(output));
 const args=fault==='output-limit'?['-e',"process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)"]:fault==='log-write'?['-e',"console.log('LOG_FAULT_MARKER');setInterval(()=>{},1000)"]:['-e','setInterval(()=>{},1000)'];
 const original=fs.writeSync;
 if(fault==='log-write'){fs.writeSync=function(fd,data,...rest){if(Buffer.isBuffer(data)&&data.includes('LOG_FAULT_MARKER'))throw Error('injected disk failure');return original.call(this,fd,data,...rest);};require('node:module').syncBuiltinESMExports();}
 let result;try{result=await runReviewCommand({executable:fault==='missing-executable'?path.join(dir,'absent'):process.execPath,args,cwd:dir,env:{PATH:process.env.PATH,HOME:dir},timeoutMs:fault==='deadline'?100:3000,log:path.join(dir,'suite.log')},new AbortController().signal);}finally{fs.writeSync=original;require('node:module').syncBuiltinESMExports();}
 if(fault==='log-write')assert.match(result.evidence,/injected disk failure/);
 assert.equal(result.status,'not-verified');assert.equal(result.quiescence.state,'verified',JSON.stringify(result));assert.ok(fs.statSync(path.join(dir,'suite.log')).size<=4*1024*1024);
});

test('controlled artifact-directory escape is rejected',async t=>{
 const f=await fixture(t);await assert.rejects(f.api.runCapturedReviewTest(f.snapshot,{description:'bad host callback',async run(){return{status:'passed',evidence:'not acceptable',quiescence:{state:'verified',evidence:['No processes']},artifact_directory:'../'};}},new AbortController().signal),/inside its disposable/);
});
