const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const a=require('../dist/index.cjs'),cli=path.resolve(__dirname,'../dist/plan.cjs');
function scratch(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-review-fixes-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function run(...args){return spawnSync(process.execPath,[cli,...args.map(String)],{encoding:'utf8'});}
function ok(...args){const r=run(...args);assert.equal(r.status,0,r.stderr);return r.stdout;}
function fixture(dir,steps){const p=path.join(dir,'plan.md');a.saveMarkdown(p,a.initialize({title:'Review regressions',steps:steps??[
 {id:'work',title:'Work',status:'completed'},
 {id:'review',title:'Review',kind:'review',depends_on:['work'],checks:['Inspect work']}
]}));return p;}
function bytes(p){return [p,a.markdownStatePath(p)].map(f=>fs.readFileSync(f));}
for(const command of ['render','export','review-brief'])for(const target of ['plan.md','plan.state.json'])
 test(`${command} rejects storage aliases to ${target} before refreshing Markdown`,t=>{
  const dir=scratch(t),real=path.join(dir,'real');fs.mkdirSync(real);const p=fixture(real),alias=path.join(dir,'alias');fs.symlinkSync(real,alias,'dir');
  fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('# Review regressions','# Externally changed heading'));
  const before=bytes(p),args=command==='review-brief'?['--step-id','review']:[];
  for(const output of [path.join(alias,target),path.join(real,'direct-alias')]){
   if(output.endsWith('direct-alias'))fs.symlinkSync(path.join(real,target),output);
   const result=run(command,'--plan',p,'--output',output,...args);
   assert.notEqual(result.status,0);assert.match(result.stderr,/Output must not overwrite plan storage/);assert.deepEqual(bytes(p),before);
  }
  ok(command,'--plan',path.join(alias,'plan.md'),'--output',path.join(alias,'new','output.txt'),...args);
  assert.ok(fs.statSync(path.join(real,'new','output.txt')).size>0);
 });
for(const separator of ['\u2028','\u2029'])for(const status of ['pending','in_progress','completed'])
 test(`Unicode separator ${separator.codePointAt(0).toString(16)} preserves ${status} task records`,t=>{
  const dir=scratch(t),title=`First${separator}second`,p=fixture(dir,[{id:'work',title,status,custom_text:`meta${separator}data`}]);
  const original=a.read(p),before=bytes(p);
  assert.equal(original.steps.length,1);assert.equal(original.steps[0].status,status);assert.equal(original.steps[0].title,title);assert.equal(original.steps[0].custom_text,`meta${separator}data`);
  assert.equal(JSON.parse(ok('status','--plan',p)).steps[0].id,'work');assert.deepEqual(bytes(p),before);
  for(const command of ['render','export']){
   const output=path.join(dir,command+'.txt');ok(command,'--plan',p,'--output',output);const rendered=fs.readFileSync(output,'utf8');
   if(command==='render')assert.equal(JSON.parse(rendered.match(/class="pc-data">([\s\S]*?)<\/script>/)[1]).plan.steps[0].title,title);
   else {assert.ok(rendered.includes('First'));assert.ok(rendered.includes('second'));assert.ok(rendered.includes('work'));}
  }
  const input=path.join(dir,'new.json'),fresh=path.join(dir,'fresh.md');fs.writeFileSync(input,JSON.stringify({title:'Fresh',steps:[{id:'work',title,status}]}));
  ok('init','--plan',fresh,'--input',input);assert.equal(JSON.parse(ok('status','--plan',fresh)).steps[0].id,'work');assert.equal(a.read(fresh).steps[0].status,status);
 });
test('a matching source digest does not excuse missing saved task records',t=>{
 const p=fixture(scratch(t));const text=fs.readFileSync(p,'utf8').replace('- [x] Work','Work');fs.writeFileSync(p,text);
 const state=JSON.parse(fs.readFileSync(a.markdownStatePath(p)));state.source_digest=a.digestText(text);a.atomicWrite(a.markdownStatePath(p),state);
 const before=bytes(p);assert.notEqual(run('status','--plan',p).status,0);assert.deepEqual(bytes(p),before);
});
test('Python numeric metadata retains exact retries, fingerprints and values across refresh and edits',t=>{
 const dir=scratch(t),source=path.join(__dirname,'fixtures/legacy-numeric');
 for(const file of ['plan.md','plan.state.json','request.json'])fs.copyFileSync(path.join(source,file),path.join(dir,file));
 const p=path.join(dir,'plan.md'),expected=a.parseJSON(fs.readFileSync(path.join(source,'expected.json'),'utf8'));
 assert.ok(a.equal(a.read(p),expected));const before=bytes(p);
 assert.equal(JSON.parse(ok('apply','--plan',p,'--request',path.join(dir,'request.json'))).result,'already_applied');assert.deepEqual(bytes(p),before);
 fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('# Numeric legacy compatibility','# Updated heading'));
 const status=JSON.parse(ok('status','--plan',p));assert.deepEqual(status.execution.selected_step_ids,['a','b']);
 assert.ok(a.equal(a.read(p).steps,expected.steps));
 ok('step','update','--plan',p,'--base-revision',status.revision,'--step-id','b','--title','Updated control');
 assert.ok(a.equal(a.read(p).steps[0],expected.steps[0]));
 assert.deepEqual(a.read(p).execution.selected_step_ids,['a']);
 const shown=ok('show','--plan',p);assert.ok(shown.includes('9007199254740993'));assert.ok(shown.includes('1.0'));assert.ok(shown.includes('123456789012345678901234567890'));
});
test('numeric parsing and cloning agree with independently captured Python encodings',()=>{
 const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/legacy-numeric/canonical.json'),'utf8'));
 for(const {source,canonical} of cases){
  const value=a.parseJSON(source);assert.equal(a.canonicalJSON(value),canonical,source);
  assert.equal(a.canonicalJSON(a.clone(value)),canonical,source+' clone');
  assert.equal(a.canonicalJSON(a.parseJSON(JSON.stringify(value))),canonical,source+' round-trip');
 }
 assert.throws(()=>a.parseJSON('1e400'),/Non-finite/);
});
test('unsupported numeric overflow is rejected without rewriting existing source',t=>{
 const dir=scratch(t),p=fixture(dir);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('"id":"work"','"metric":1e400,"id":"work"'));
 const before=bytes(p);assert.match(run('status','--plan',p).stderr,/Non-finite/);assert.deepEqual(bytes(p),before);
});
const work=(id,status='pending',depends_on=[])=>({id,title:id,status,depends_on});
const review=(id,status='pending')=>({...work(id,status,['a']),kind:'review',run_after:'a',checks:['Check a']});
test('reopening cannot change original review scope or move protected history within a batch',t=>{
 const plan=a.initialize({title:'History',steps:[work('a','completed'),review('r','completed'),work('active','in_progress'),work('b'),work('c')]});
 const original=a.clone(plan);
 for(const edit of [{type:'move_review',step_id:'r',after_step_id:'active'},{type:'update_review',step_id:'r',depends_on:['a'],checks:['New scope']}]){
  const operations=[{type:'set_status',step_id:'r',status:'pending'},edit,{type:'reorder_steps',step_ids:['a','active','r','c','b']}];
  assert.throws(()=>a.applyOperations(plan,operations),/Only pending reviews/);assert.deepEqual(plan,original);
 }
 const changed=a.clone(plan.steps);changed.splice(1,1);changed.splice(2,0,{...plan.steps[1],status:'pending'});
 assert.throws(()=>a.reorderPendingSteps(changed,changed.map(s=>s.id),plan.steps),/protected history/);
 const dir=scratch(t),p=fixture(dir,plan.steps),request=path.join(dir,'request.json'),before=bytes(p),saved=a.read(p);
 fs.writeFileSync(request,JSON.stringify({plan_id:saved.plan_id,base_revision:1,request_id:'history',intent:'edit',operations:[{type:'set_status',step_id:'r',status:'pending'},{type:'move_review',step_id:'r',after_step_id:'active'}]}));
 assert.notEqual(run('apply','--plan',p,'--request',request).status,0);assert.deepEqual(bytes(p),before);
});
test('later structural operations cannot invalidate the final prerequisite order',t=>{
 const plan=a.initialize({title:'Order',steps:[work('a'),review('r'),work('d','pending',['r']),work('b'),work('c')]});
 const operations=[{type:'reorder_steps',step_ids:['a','r','d','c','b']},{type:'move_review',step_id:'r',after_step_id:'c'}];
 assert.throws(()=>a.applyOperations(plan,operations),/Keep “d” after “r”/);
 const p=fixture(scratch(t),plan.steps),current=a.read(p),f=path.join(path.dirname(p),'request.json'),before=bytes(p);
 fs.writeFileSync(f,JSON.stringify({plan_id:current.plan_id,base_revision:1,request_id:'order',intent:'edit',operations}));
 assert.notEqual(run('apply','--plan',p,'--request',f).status,0);assert.deepEqual(bytes(p),before);
 const valid=a.applyOperations(plan,[...operations,{type:'reorder_steps',step_ids:['a','c','r','d','b']}]);assert.deepEqual(valid.steps.map(s=>s.id),['a','c','r','d','b']);
});
