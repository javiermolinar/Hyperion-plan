// Session-free component tests. All identities, transcript fragments, readiness
// and settlement observations are explicitly synthetic. Never instantiate Pi.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const core=require('../dist/index.cjs');
const SRC='NOT-A-SESSION-source',DST='NOT-A-SESSION-destination';
async function fixture(t){
 const {PiHandoverJournal}=await import('../dist/pi-handover-journal.js');
 const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hyperion-journal-component-')));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const planPath=path.join(cwd,'plan.md'),brief=path.join(cwd,'brief.md');fs.writeFileSync(brief,'Synthetic brief; no execution authority');
 let p=core.initialize({title:'Synthetic handover metadata fixture',steps:[{id:'pre',title:'Existing work',status:'completed'},{id:'gate',title:'Transfer',kind:'handover'},{id:'next',title:'Remaining work'}]});
 p=core.applyRequest(p,{plan_id:p.plan_id,base_revision:p.revision,request_id:'scope',intent:'implement',operations:[],selected_step_ids:['next'],execution_mode:'sequential'})[0];
 p=core.applyRequest(p,{plan_id:p.plan_id,base_revision:p.revision,request_id:'transfer',intent:'handover',operations:[],target_step_ids:['gate'],handover_reason:'Fixture only'})[0];
 p=core.updateHandover(p,p.revision,{request_id:'transfer',state:'prepared',brief_path:brief,summary:'Synthetic work',next_action:'Observe metadata only',code_state:'Synthetic digest; no SDK'},SRC)[0];core.saveMarkdown(planPath,p);
 const authority={currentRunAuthorized:true,implementationAllowed:true,actorId:SRC,requestId:'scope'};
 const observation={code_digest:core.digestText('fixture-code'),source_quiescence:{state:'verified',evidence:['Synthetic source observation, not runtime proof']}};
 const options={planPath,planId:p.plan_id,requestId:'transfer',cwd,authority:()=>({...authority}),observe:()=>structuredClone(observation)};
 const journal=new PiHandoverJournal(options),file=path.join(cwd,'.hyperion-dispatch','plan.md','handovers',core.digestText('transfer'),'state.json');
 const read=async()=>(await core.loadPlanSnapshot(planPath)).plan;
 const change=async fn=>{const p=await read();core.saveMarkdown(planPath,fn(p));};
 const identity={native_id:DST,transcript_path:path.join(cwd,'synthetic-transcript.jsonl')};
 async function identified(){
  await journal.reserve();await journal.identify(identity);
  await change(p=>core.updateHandover(p,p.revision,{request_id:'transfer',state:'prepared',destination_task_id:DST},SRC)[0]);
  const r=journal.inspect();
  const entries=[{type:'session',id:DST,cwd},{type:'custom',customType:'hyperion.handover',data:{plan_path:r.plan_path,plan_id:r.plan_id,request_id:r.request_id,source_id:r.source_id,plan_digest:r.plan_digest,code_digest:r.code_digest,brief_digest:r.brief_digest}}];
  fs.writeFileSync(identity.transcript_path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  return {plan_path:r.plan_path,cwd:r.cwd,request_id:r.request_id,destination_id:DST,plan_digest:r.plan_digest,code_digest:r.code_digest,brief_digest:r.brief_digest,ready:true,evidence:['Synthetic readiness assertion; not a model result']};
 }
 const settlement={state:'verified',evidence:['Synthetic destination settlement']};
 const ready=async()=>journal.ready(await identified(),settlement);
 return {cwd,planPath,brief,authority,observation,options,journal,file,identity,read,change,identified,ready,settlement,PiHandoverJournal};
}
test('journal bundle has no SDK imports or session construction',()=>{
 const bundle=fs.readFileSync(path.join(__dirname,'../dist/pi-handover-journal.js'),'utf8');
 assert.doesNotMatch(bundle,/@earendil-works|createAgentSession|SessionManager\.create/);
});
test('reservation is durable and exactly one concurrent controller receives created=true',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.planPath,'utf8');
 const results=await Promise.all([f.journal.reserve(),new f.PiHandoverJournal(f.options).reserve()]);
 assert.equal(results.filter(r=>r.created).length,1);assert.deepEqual(results[0].record,results[1].record);
 assert.equal(fs.readFileSync(f.planPath,'utf8'),before);assert.equal(f.journal.inspect().phase,'reserved');
 assert.equal((await new f.PiHandoverJournal(f.options).reserve()).created,false,'restart cannot mint another launch');
});
test('reserved identity is immutable even before Pi would flush its transcript',async t=>{
 const f=await fixture(t);await f.journal.reserve();await f.journal.identify(f.identity);
 assert.equal(fs.existsSync(f.identity.transcript_path),false);
 assert.deepEqual(await f.journal.identify(f.identity),f.journal.inspect());
 await assert.rejects(f.journal.identify({...f.identity,native_id:'NOT-A-SESSION-other'}),/Reuse/);
 await assert.rejects(f.journal.identify({...f.identity,transcript_path:path.join(f.cwd,'other.jsonl')}),/Reuse/);
});
test('identity needs intent; readiness needs both canonical identity and correlated persisted transcript',async t=>{
 const f=await fixture(t);await assert.rejects(f.journal.identify(f.identity),/Reserve/);
 await f.journal.reserve();await f.journal.identify(f.identity);
 await assert.rejects(f.journal.ready({},f.settlement),/canonical prepared/);
});
test('synthetic protocol transfers only after readiness, rejects source writes, and claims continuation once',async t=>{
 const f=await fixture(t);await f.journal.reserve();await assert.rejects(f.journal.transfer(),/Readiness/);
 const ready=await f.ready();assert.equal((await f.read()).steps[1].status,'in_progress');
 await assert.rejects(f.journal.claimContinuation(ready.continuation_id),/Observe canonical/);
 const transferred=await f.journal.transfer(),p=await f.read();
 assert.equal(transferred.phase,'transferred');assert.equal(p.execution_owner,DST);assert.equal(p.steps[1].status,'completed');assert.equal(p.steps[2].status,'pending');
 await assert.rejects(core.mutatePlan(f.planPath,SRC,p=>core.checkpoint(p,p.revision,'next','in_progress','stale source')),/belongs/);
 await assert.rejects(f.journal.claimContinuation(transferred.continuation_id),/destination continuation/);
 f.authority.actorId=DST;await assert.rejects(f.journal.claimContinuation('wrong'),/destination continuation/);
 assert.equal((await f.journal.claimContinuation(transferred.continuation_id)).permit,true);
 assert.equal((await f.journal.claimContinuation(transferred.continuation_id)).permit,false);
 assert.equal((await f.read()).steps[2].status,'pending','a claim itself executes no work');
});
for(const field of ['ready','plan_path','cwd','request_id','destination_id','plan_digest','code_digest','brief_digest','evidence'])test(`reject mismatched readiness ${field}`,async t=>{
 const f=await fixture(t),report=await f.identified();report[field]=field==='ready'?false:field==='evidence'?[]:'wrong';
 await assert.rejects(f.journal.ready(report,f.settlement),/Readiness/);assert.equal(f.journal.inspect().phase,'identified');
});
for(const fault of ['header-id','parent','cwd','tag','tag-path','missing','duplicate-tag'])test(`reject transcript correlation fault ${fault}`,async t=>{
 const f=await fixture(t),report=await f.identified();let entries=fs.readFileSync(f.identity.transcript_path,'utf8').trim().split('\n').map(JSON.parse);
 if(fault==='header-id')entries[0].id='wrong';if(fault==='parent')entries[0].parentSession='/copied-parent.jsonl';if(fault==='cwd')entries[0].cwd='/another';
 if(fault==='tag-path')entries[1].data.plan_path='/wrong-fixture.md';if(fault==='tag')entries[1].data.plan_digest=core.digestText('wrong');if(fault==='duplicate-tag')entries.push(entries[1]);
 fs.writeFileSync(f.identity.transcript_path,entries.map(e=>JSON.stringify(e)).join('\n'));if(fault==='missing')fs.unlinkSync(f.identity.transcript_path);
 await assert.rejects(f.journal.ready(report,f.settlement));assert.equal(f.journal.inspect().phase,'identified');
});
for(const fault of ['authority','mode','actor','request','source-unknown','code','brief','plan','pause','cancel'])test(`transfer rejects ${fault} and never changes owner`,async t=>{
 const f=await fixture(t);await f.ready();
 if(fault==='authority')f.authority.currentRunAuthorized=false;if(fault==='mode')f.authority.implementationAllowed=false;
 if(fault==='actor')f.authority.actorId='NOT-A-SESSION-intruder';if(fault==='request')f.authority.requestId='other';
 if(fault==='source-unknown')f.observation.source_quiescence={state:'unknown',reason:'No observation'};
 if(fault==='code')f.observation.code_digest=core.digestText('changed');if(fault==='brief')fs.writeFileSync(f.brief,'changed');
 if(fault==='plan')await f.change(p=>{p.title='changed';return p;});
 if(fault==='pause')await f.change(p=>core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused')[0]);
 if(fault==='cancel')await f.change(p=>core.updateHandover(p,p.revision,{request_id:'transfer',state:'cancelled',note:'Fixture cancellation'},SRC)[0]);
 const before=fs.readFileSync(f.planPath,'utf8');await assert.rejects(f.journal.transfer());
 assert.equal(fs.readFileSync(f.planPath,'utf8'),before);assert.equal((await f.read()).execution_owner,SRC);assert.equal(f.journal.inspect().phase,'ready');
});
test('unknown destination settlement cannot become ready',async t=>{
 const f=await fixture(t),report=await f.identified();await assert.rejects(f.journal.ready(report,{state:'unknown',reason:'Abort only'}),/settlement/);
});
for(const fault of ['active','unknown','wave'])test(`reservation rejects ${fault} dispatch holds`,async t=>{
 const f=await fixture(t),p=await f.read(),ledger={schema_version:1,plan_path:f.planPath,records:[]};
 if(fault==='wave')ledger.waves=[{id:'wave',plan_id:p.plan_id,request_id:'scope',owner:SRC,closed:true,selection:{selected:[{assignment:{plan_id:p.plan_id,plan_path:f.planPath,approved_request_id:'scope',owner:{native_id:SRC}}}]}}];
 else ledger.records=[{schema_version:1,assignment:{assignment_id:'synthetic',plan_id:p.plan_id,plan_path:f.planPath},attempt_id:'synthetic',phase:fault==='active'?'started':'uncertain',history:[]}];
 const file=path.join(f.cwd,'.hyperion-dispatch','plan.md','ledger.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(ledger));
 await assert.rejects(f.journal.reserve(),/Drain writers/);assert.equal(fs.existsSync(f.file),false);
});
test('lost canonical-transfer acknowledgement recovers without another canonical write or delivery',async t=>{
 const f=await fixture(t);await f.ready();await f.journal.transfer();const before=fs.readFileSync(f.planPath,'utf8');
 const r=f.journal.inspect();r.phase='transfer-intent';fs.writeFileSync(f.file,JSON.stringify(r));
 const restarted=new f.PiHandoverJournal(f.options);assert.equal((await restarted.recoverTransfer()).phase,'transferred');
 assert.equal(fs.readFileSync(f.planPath,'utf8'),before);await assert.rejects(restarted.transfer(),/inspect\/recover/);
});
test('drift between intent and canonical commit leaves ambiguous intent, not a retry permit',async t=>{
 const f=await fixture(t);await f.ready();let observations=0;
 const j=new f.PiHandoverJournal({...f.options,observe:()=>({...structuredClone(f.observation),code_digest:++observations===1?f.observation.code_digest:core.digestText('drift')})});
 await assert.rejects(j.transfer(),/code or brief changed/);assert.equal(j.inspect().phase,'transfer-intent');assert.equal((await f.read()).execution_owner,SRC);
 await assert.rejects(j.transfer(),/inspect\/recover/);await assert.rejects(f.journal.recoverTransfer(),/Canonical transfer/);
});
test('revocation and actor changes during observation reject the final journal write',async t=>{
 for(const field of ['actorId','currentRunAuthorized']){
  const f=await fixture(t),j=new f.PiHandoverJournal({...f.options,observe:()=>{f.authority[field]=field==='actorId'?'NOT-A-SESSION-wrong':false;return structuredClone(f.observation);}});
  await assert.rejects(j.reserve(),/authority|actor changed/);assert.equal(fs.existsSync(f.file),false);
 }
});
test('paused destination cannot claim or auto-resume continuation',async t=>{
 const f=await fixture(t);await f.ready();const r=await f.journal.transfer();f.authority.actorId=DST;
 await f.change(p=>core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused')[0]);
 await assert.rejects(f.journal.claimContinuation(r.continuation_id),/paused/);assert.equal(f.journal.inspect().phase,'transferred');
});
test('permission revoked while waiting for the plan lock prevents intent persistence',async t=>{
 const f=await fixture(t);let release,entered;const enteredPromise=new Promise(r=>{entered=r;});
 const lock=core.withLock(f.planPath,async()=>{entered();await new Promise(r=>{release=r;});});await enteredPromise;
 const pending=f.journal.reserve();f.authority.currentRunAuthorized=false;release();await lock;
 await assert.rejects(pending,/authority/);assert.equal(fs.existsSync(f.file),false);
});
test('changed canonical bytes between intent and commit cannot trigger an implicit refresh',async t=>{
 const f=await fixture(t);await f.ready();const state=core.markdownStatePath(f.planPath),before=fs.readFileSync(state,'utf8');let changed=false;
 const j=new f.PiHandoverJournal({...f.options,authority:()=>{
  if(!changed&&f.journal.inspect()?.phase==='transfer-intent'){changed=true;fs.appendFileSync(f.planPath,'\nExternal fixture edit\n');}
  return {...f.authority};
 }});
 await assert.rejects(j.transfer(),/Canonical plan changed before transfer/);assert.equal(fs.readFileSync(state,'utf8'),before);
 assert.equal(f.journal.inspect().phase,'transfer-intent');
});
test('journal directories cannot redirect durable intent through a symlink',async t=>{
 const f=await fixture(t),elsewhere=path.join(f.cwd,'elsewhere');fs.mkdirSync(elsewhere);
 fs.symlinkSync(elsewhere,path.join(f.cwd,'.hyperion-dispatch'),'dir');
 await assert.rejects(f.journal.reserve(),/aliases/);assert.deepEqual(fs.readdirSync(elsewhere),[]);
});
test('transcript changes after readiness block canonical transfer',async t=>{
 const f=await fixture(t);await f.ready();fs.writeFileSync(f.identity.transcript_path,'{}\n');
 await assert.rejects(f.journal.transfer(),/transcript changed/);assert.equal((await f.read()).execution_owner,SRC);
});
test('additional destination history after readiness cannot silently transfer',async t=>{
 const f=await fixture(t);await f.ready();fs.appendFileSync(f.identity.transcript_path,JSON.stringify({type:'custom',customType:'unexpected-late-entry',data:{}})+'\n');
 await assert.rejects(f.journal.transfer(),/transcript changed/);assert.equal((await f.read()).execution_owner,SRC);
});
test('cancelled execution cannot claim or resume continuation',async t=>{
 const f=await fixture(t);await f.ready();const r=await f.journal.transfer();f.authority.actorId=DST;
 await f.change(p=>core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'cancelled')[0]);
 await assert.rejects(f.journal.claimContinuation(r.continuation_id),/revoked/);assert.equal((await f.read()).execution.state,'cancelled');
});
test('corrupt history fails closed rather than overwriting a reservation',async t=>{
 const f=await fixture(t);await f.journal.reserve();fs.writeFileSync(f.file,'{"schema_version":999}');
 await assert.rejects(f.journal.reserve());assert.equal(fs.readFileSync(f.file,'utf8'),'{"schema_version":999}');
});
for(const priorPhase of ['started','uncertain','failed'])test(`prior handover ${priorPhase} survives reload in global drainage checks`,async t=>{
 const f=await fixture(t);const {record}=await f.journal.reserve();
 const dir=path.join(path.dirname(path.dirname(f.file)),core.digestText('prior'));fs.mkdirSync(dir,{recursive:true});
 const prior={...record,request_id:'prior',phase:'identified',destination:{native_id:'NOT-A-SESSION-prior',transcript_path:path.join(f.cwd,'prior.jsonl')}};
 fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(prior));fs.writeFileSync(path.join(dir,'runtime.json'),JSON.stringify({phase:priorPhase,attempt:1,destination:prior.destination,quiescence:priorPhase==='failed'?f.settlement:{state:'unknown',reason:'Synthetic surviving writer'}}));
 const restored=new f.PiHandoverJournal(f.options);
 if(priorPhase==='failed')assert.equal((await restored.reserve()).created,false);else await assert.rejects(restored.reserve(),/Prior handover writers/);
 assert.equal((await f.read()).execution_owner,SRC);
});
const retryProof=f=>({attempt:1,transcript_digest:core.digestText(fs.readFileSync(f.identity.transcript_path,'utf8')),quiescence:f.settlement});
test('explicit settled re-preparation refreshes plan/code on the same identity and grants one attempt',async t=>{
 const f=await fixture(t);await f.ready();const proof=retryProof(f);
 f.observation.code_digest=core.digestText('changed source');await f.change(p=>{p.title='Changed plan context';p.revision++;return p;});
 const r=await f.journal.reprepare(proof);assert.deepEqual(r.destination,f.identity);assert.equal(r.readiness_attempt,2);assert.equal(r.phase,'identified');assert.equal(r.code_digest,f.observation.code_digest);
 const attempts=await Promise.allSettled([f.journal.claimReadinessRetry(2),f.journal.claimReadinessRetry(2)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
 const bytes=fs.readFileSync(f.planPath,'utf8');await assert.rejects(f.journal.reprepare(proof),/Fresh settled attempt/);assert.equal(fs.readFileSync(f.planPath,'utf8'),bytes);
 const report={plan_path:r.plan_path,cwd:r.cwd,request_id:r.request_id,destination_id:DST,plan_digest:r.plan_digest,code_digest:r.code_digest,brief_digest:r.brief_digest,ready:true,evidence:['Synthetic retry readiness']};
 await assert.rejects(f.journal.ready(report,f.settlement),/context attempt/);
 fs.appendFileSync(f.identity.transcript_path,JSON.stringify({type:'custom',customType:'hyperion.handover-context',data:{...r,readiness_attempt:2}})+'\n');
 await f.journal.ready(report,f.settlement);await f.journal.transfer();assert.equal((await f.read()).execution_owner,DST);
});
for(const fault of ['unknown','transcript','attempt','actor','revoked'])test(`re-preparation rejects ${fault} proof without replacing identity`,async t=>{
 const f=await fixture(t);await f.ready();const proof=retryProof(f),before=fs.readFileSync(f.planPath,'utf8');
 if(fault==='unknown')proof.quiescence={state:'unknown',reason:'No runtime settlement'};if(fault==='transcript')fs.appendFileSync(f.identity.transcript_path,'{}\n');if(fault==='attempt')proof.attempt=2;if(fault==='actor')f.authority.actorId=DST;if(fault==='revoked')f.authority.currentRunAuthorized=false;
 await assert.rejects(f.journal.reprepare(proof));assert.equal(fs.readFileSync(f.planPath,'utf8'),before);assert.deepEqual(f.journal.inspect().destination,f.identity);
});
test('an unclaimed re-preparation can refresh again but stale attempt cannot claim it',async t=>{
 const f=await fixture(t);await f.ready();const proof=retryProof(f);await f.journal.reprepare(proof);
 f.observation.code_digest=core.digestText('changed again');const r=await f.journal.reprepare(proof);assert.equal(r.readiness_attempt,3);
 await assert.rejects(f.journal.claimReadinessRetry(2),/No unclaimed/);await f.journal.claimReadinessRetry(3);
});
test('explicit reconciliation resets only a provably uncommitted stable transfer intent',async t=>{
 const f=await fixture(t);await f.ready();let r=f.journal.inspect();r.phase='transfer-intent';fs.writeFileSync(f.file,JSON.stringify(r));const before=fs.readFileSync(f.planPath,'utf8');
 assert.equal((await f.journal.reconcileUncommittedTransfer()).phase,'ready');assert.equal(fs.readFileSync(f.planPath,'utf8'),before);await f.journal.transfer();
 r=f.journal.inspect();r.phase='transfer-intent';fs.writeFileSync(f.file,JSON.stringify(r));await assert.rejects(f.journal.reconcileUncommittedTransfer(),/source coordinator/);assert.equal((await f.journal.recoverTransfer()).phase,'transferred');
});
test('lost/consumed continuation can navigate after progress and pause but cannot replay work',async t=>{
 const f=await fixture(t);await f.ready();const r=await f.journal.transfer();f.authority.actorId=DST;await f.journal.claimContinuation(r.continuation_id);
 await f.change(p=>core.checkpoint(p,p.revision,'next','in_progress','Synthetic destination progress')[0]);await f.change(p=>core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused')[0]);f.observation.code_digest=core.digestText('later work');f.authority.currentRunAuthorized=false;f.authority.implementationAllowed=false;
 const before=fs.readFileSync(f.planPath,'utf8');assert.deepEqual(await f.journal.navigationTarget(),f.identity);await assert.rejects(f.journal.claimContinuation(r.continuation_id));assert.equal(fs.readFileSync(f.planPath,'utf8'),before);
 f.authority.actorId='NOT-A-SESSION-other';await assert.rejects(f.journal.navigationTarget(),/owner mismatch/);
});
