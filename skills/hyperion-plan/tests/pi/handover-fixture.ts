// Offline terminal fixture only. No credentials, network, or live-plan writes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import core from '../../dist/index.cjs';
export default function(pi) {
 const root=process.env.HYPERION_HANDOVER_ROOT,trace=process.env.HYPERION_TEST_TRACE;
 assert.ok(root&&trace);assert.equal(fs.realpathSync(root),fs.realpathSync(process.cwd()));
 assert.equal(fs.readFileSync(path.join(root,'fixture-marker'),'utf8'),'offline-handover-only');
 const planPath=path.join(root,'plan.md');
 const log=value=>fs.appendFileSync(trace,JSON.stringify(value)+'\n');
 pi.on('session_start',async(_event,ctx)=>log({event:'session_start',id:ctx.sessionManager.getSessionId(),file:ctx.sessionManager.getSessionFile()}));
 pi.on('session_shutdown',async(_event,ctx)=>log({event:'session_shutdown',id:ctx.sessionManager.getSessionId()}));
 pi.on('tool_result',async event=>log({event:'tool_result',name:event.toolName,error:event.isError,content:event.content}));
 pi.registerCommand('fixture-source',{description:'Restore isolated source to test its ownership fence',handler:async(_args,ctx)=>{
  const events=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);const source=events.find(e=>e.event==='session_start');
  await ctx.switchSession(source.file,{withSession:async fresh=>{log({event:'source-restored',id:fresh.sessionManager.getSessionId()});}});
 }});
 pi.registerCommand('fixture-pause',{description:'Pause isolated fixture from its actual owner',handler:async(_args,ctx)=>{
  await core.mutatePlan(planPath,ctx.sessionManager.getSessionId(),p=>core.checkpoint(p,p.revision,undefined,undefined,undefined,undefined,'paused'));log({event:'paused',id:ctx.sessionManager.getSessionId()});
 }});
 pi.registerTool({name:'fixture_after',label:'Verify destination',description:'Checkpoint only selected isolated fixture work',parameters:Type.Object({}),async execute(_id,_p,_s,_u,ctx){
  const actor=ctx.sessionManager.getSessionId();await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,'after','in_progress','Destination fixture started'));
  fs.writeFileSync(path.join(root,'continued.txt'),actor);
  await core.mutatePlan(planPath,actor,p=>core.checkpoint(p,p.revision,'after','completed','Verified isolated continuation marker'));
  log({event:'continued',id:actor});return{content:[{type:'text',text:'HANDOVER_DESTINATION_VERIFIED'}],details:undefined};
 }});
 pi.registerProvider('handover-fixture',{baseUrl:'http://invalid.test',apiKey:'offline',api:'openai-completions',models:[{id:'scripted',name:'Offline handover fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],
  streamSimple(model,context){const stream=createAssistantMessageEventStream();queueMicrotask(()=>{
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
   try{
    const last=context.messages.at(-1),user=[...context.messages].reverse().find(m=>m.role==='user');
    const text=typeof user?.content==='string'?user.content:(user?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    let answer='PRIVATE_SOURCE_HISTORY',tool;
    if(text.startsWith('READINESS_BINDING')){
     const d=JSON.parse(text.slice(text.indexOf('\n')+1));
     assert.doesNotMatch(JSON.stringify(context.messages),/PRIVATE_SOURCE_HISTORY/);
     if(last.role==='toolResult'&&last.toolName==='read')tool={name:'report_handover',arguments:{...Object.fromEntries(['plan_path','cwd','request_id','destination_id','plan_digest','code_digest','brief_digest'].map(k=>[k,d[k]])),ready:true,evidence:['Read isolated canonical fixture before transfer.']}};
     else if(last.role==='toolResult')answer='Readiness complete. No execution authority.';
     else tool={name:'read',arguments:{path:d.plan_path}};
    }else if(last.role==='toolResult')answer=last.isError?'SOURCE_WRITE_BLOCKED':'HANDOVER_DESTINATION_VERIFIED';
    else if(text.includes('HYPERION_CONTINUATION')||text==='ATTEMPT_SOURCE_WRITE')tool={name:'fixture_after',arguments:{}};
    else if(text.startsWith('Hyperion Plan request from its native Pi screen.')&&text.includes('The user explicitly authorized Run')){
     const [p]=core.loadMarkdown(planPath);assert.deepEqual(p.execution.selected_step_ids,['gate','after']);
     tool={name:'hyperion_handover',arguments:{operation:'run',plan_path:planPath,request_id:p.execution.request_id,step_id:'gate',current_request_authorized:true,handover_sessions_authorized:true,files:['code.txt'],source_writers_drained:true,source_quiescence_evidence:['Isolated fixture has no external writer processes.'],summary:'Prior fixture work complete. No parent history needed.',next_action:'Verify after through fixture_after; leave unselected untouched.'}};
    }
    log({event:'model',user:text.slice(0,150),tool:tool?.name});stream.push({type:'start',partial:message});
    if(tool){const call={type:'toolCall',id:`fixture-${Date.now()}`, ...tool};message.content=[call];message.stopReason='toolUse';stream.push({type:'toolcall_start',contentIndex:0,partial:message});stream.push({type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(call.arguments),partial:message});stream.push({type:'toolcall_end',contentIndex:0,toolCall:call,partial:message});}
    else{message.content=[{type:'text',text:answer}];stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:answer,partial:message});stream.push({type:'text_end',contentIndex:0,content:answer,partial:message});}
    stream.push({type:'done',reason:message.stopReason,message});
   }catch(error){log({event:'failure',error:String(error)});message.stopReason='error';message.errorMessage=String(error);stream.push({type:'error',reason:'error',error:message});}
   stream.end();
  });return stream;}
 });
}
