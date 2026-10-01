// Deterministic installed-terminal execution fixture, never a user workspace.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {Type} from 'typebox';import {createAssistantMessageEventStream,getCurrentTools} from '@earendil-works/pi-ai';
import core from '../../dist/index.cjs';import {readDispatchLedger,verifyDispatch} from '../../dist/pi-runner.js';
export default function(pi){
 const root=fs.realpathSync(process.env.HYPERION_EXECUTION_ROOT),trace=process.env.HYPERION_TEST_TRACE;assert.equal(root,fs.realpathSync(process.cwd()));assert.equal(fs.readFileSync(path.join(root,'fixture-marker'),'utf8'),'offline-execution-only');
 const planPath=path.join(root,'plan.md'),log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\n'),plan=()=>core.loadMarkdown(planPath)[0];let active=0,peak=0;
 pi.on('session_start',async(_e,ctx)=>log({event:'session_start',id:ctx.sessionManager.getSessionId()}));
 pi.on('agent_settled',async()=>log({event:'settled'}));
 pi.on('tool_result',async e=>log({event:'tool_result',name:e.toolName,error:e.isError,content:e.content}));
 pi.registerTool({name:'fixture_checkpoint',label:'Fixture coordinator checks',description:'Inspect isolated outputs and checkpoint selected work',parameters:Type.Object({phase:Type.String()}),async execute(_id,args,_s,_u,ctx){
  const actor=ctx.sessionManager.getSessionId();assert.deepEqual(plan().execution.selected_step_ids,['a','b','review']);
  if(args.phase==='wave')for(const id of ['a','b']){assert.equal(fs.readFileSync(path.join(root,id+'.txt'),'utf8'),'approved');await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,id,'completed','Coordinator inspected approved fixture bytes'));}
  else if(args.phase==='review-start')await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,'review','in_progress','Fixture independent review starts'));
  else{assert.equal(args.phase,'review-complete');const r=readDispatchLedger(planPath).records.find(r=>r.assignment.role==='review');assert.ok(r.review_report.checks.every(c=>c.status==='passed'));assert.equal(r.effort.actual,'high');
   await verifyDispatch(planPath,r.assignment.assignment_id,()=>({actorId:actor,requestId:plan().execution.request_id,currentRunAuthorized:true,implementationAllowed:true}),{acceptance_met:true,integration_checked:true,evidence:['Fixture coordinator inspected exact captured a/b bytes and report correlation']});
   await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,'review','completed','Inspected read-only fixture report and matching captured bytes'));log({event:'complete',peak});
  }
  return{content:[{type:'text',text:'Fixture checkpoint saved'}],details:undefined};
 }});
 pi.registerProvider('execution-fixture',{baseUrl:'http://invalid.test',apiKey:'offline',api:'openai-completions',models:[{id:'scripted',name:'Offline execution fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],streamSimple(model,context,options){
  const stream=createAssistantMessageEventStream();queueMicrotask(async()=>{
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
   try{
    const names=getCurrentTools(context.messages).map(t=>t.name),last=context.messages.at(-1),first=context.messages.find(m=>m.role==='user'),lastUser=[...context.messages].reverse().find(m=>m.role==='user');
    const text=m=>typeof m?.content==='string'?m.content:(m?.content??[]).map(c=>c.text??'').join('');let tool,answer='PRIVATE_PARENT_HISTORY';
    if(names.includes('hyperion_wave')){
     assert.equal(options?.reasoning??'off','off','child effort must not change coordinator baseline');
     if(text(lastUser).startsWith('Hyperion Plan request from its native Pi screen.')){
      const p=plan(),ledger=readDispatchLedger(planPath),request_id=p.execution.request_id,wave_id='terminal-wave';assert.deepEqual(p.execution.selected_step_ids,['a','b','review']);
      const waveArgs={plan_path:planPath,request_id,wave_id,current_request_authorized:true};
      if(!ledger.waves?.length)tool={name:'hyperion_wave',arguments:{...waveArgs,operation:'run',worker_sessions_authorized:true,assignments:['a','b'].map(id=>({step_id:id,owned_paths:[path.join(root,id+'.txt')],read_paths:[],resources:[],independence_evidence:['Distinct exact output files and no shared inputs']}))}};
      else if(ledger.records.some(r=>r.assignment.role==='implementation'&&!r.verification)){const r=ledger.records.find(r=>r.assignment.role==='implementation'&&!r.verification);assert.equal(fs.readFileSync(r.assignment.owned_paths[0],'utf8'),'approved');tool={name:'hyperion_wave',arguments:{...waveArgs,operation:'verify',assignment_id:r.assignment.assignment_id,evidence:['Inspected exact approved output bytes'],acceptance_met:true,integration_checked:true}};}
      else if(p.steps.slice(0,2).some(s=>s.status!=='completed'))tool={name:'fixture_checkpoint',arguments:{phase:'wave'}};
      else if(!ledger.waves[0].reconciliation)tool={name:'hyperion_wave',arguments:{...waveArgs,operation:'reconcile',evidence:['Both outputs verified, individually checkpointed, and SDK writers settled']}};
      else if(p.steps[2].status==='pending')tool={name:'fixture_checkpoint',arguments:{phase:'review-start'}};
      else if(!ledger.records.some(r=>r.assignment.role==='review'))tool={name:'hyperion_review',arguments:{plan_path:planPath,request_id,intent:'code-review',step_id:'review',files:['code.txt','a.txt','b.txt'],current_request_authorized:true}};
      else if(p.steps[2].status!=='completed')tool={name:'fixture_checkpoint',arguments:{phase:'review-complete'}};
      else answer='EXECUTION_FIXTURE_VERIFIED';
     }
     log({event:'model',role:'coordinator',reasoning:options?.reasoning??'off',tool:tool?.name});
    }else{
     assert.doesNotMatch(JSON.stringify(context.messages),/PRIVATE_PARENT_HISTORY/);const data=JSON.parse(text(first).slice(text(first).indexOf('\n{')+1));
     if(data.assignment.role==='implementation'){
      assert.deepEqual(names.sort(),['edit','read','write']);assert.equal(options?.reasoning??'off',data.assignment.step_id==='a'?'low':'off');
      if(last.role==='toolResult')answer='Worker stopped; coordinator verification required.';
      else{active++;peak=Math.max(peak,active);log({event:'worker-active',active,peak,id:data.assignment.step_id});await new Promise(r=>setTimeout(r,1200));active--;tool={name:'write',arguments:{path:data.assignment.owned_paths[0],content:'approved'}};}
     }else{
      assert.deepEqual(names.sort(),['read','report_review','search_review','test_review']);assert.equal(options?.reasoning,'high');
      const reads=context.messages.filter(m=>m.role==='toolResult'&&m.toolName==='read');for(const r of reads)assert.match(JSON.stringify(r.content),/approved/);
      if(last.role==='toolResult'&&last.toolName==='report_review')answer='Read-only review stopped.';
      else if(reads.length<2)tool={name:'read',arguments:{path:`working/${reads.length?'b':'a'}.txt`}};
      else tool={name:'report_review',arguments:{snapshot_digest:data.review.snapshot.digest,checks:data.review.checks.map((_c,i)=>({id:i+1,status:'passed',evidence:'Read captured working/a.txt and working/b.txt; both contain approved.',blocking:false}))}};
     }
     log({event:'model',role:data.assignment.role,reasoning:options?.reasoning??'off',tool:tool?.name});
    }
    options?.signal?.throwIfAborted();stream.push({type:'start',partial:message});
    if(tool){const call={type:'toolCall',id:`fixture-${Date.now()}-${Math.random()}`,...tool};message.content=[call];message.stopReason='toolUse';stream.push({type:'toolcall_start',contentIndex:0,partial:message});stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(call.arguments),partial:message});stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:message});}
    else{message.content=[{type:'text',text:answer}];stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:answer,partial:message});stream.push({type:'text_end',contentIndex:0,content:answer,partial:message});}
    stream.push({type:'done',reason:message.stopReason,message});
   }catch(error){log({event:'failure',error:String(error)});message.stopReason='error';message.errorMessage=String(error);stream.push({type:'error',reason:'error',error:message});}
   stream.end();
  });return stream;
 }});
}
