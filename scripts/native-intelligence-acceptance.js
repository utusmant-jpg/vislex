// Real Tauri extraction/dispatch/publication/recovery; synthetic provider only.
(async()=>{
  const root=__WORKSPACE__;
  const invoke=(action,args={})=>window.__TAURI_INTERNALS__.invoke('command',{action,args});
  const wait=async(probe,label)=>{for(let i=0;i<400;i++){const value=await probe();if(value)return value;await new Promise(r=>setTimeout(r,150));}throw new Error(`Timed out: ${label}`);};
  const assert=(value,message)=>{if(!value)throw new Error(message);};
  const opened=await invoke('create_case',{path:`${root}/artifacts/native-intelligence-${Date.now()}`,name:'Synthetic automatic intelligence'});
  const context={case_id:opened.id,session_epoch:opened.session_epoch};
  const config={provider:'openai',execution:'auto',review:'standard',pool:[]};
  await invoke('save_ai_settings',{...context,config,settings:{...opened.settings,offline:false,allow_text:true,allow_images:false,model:'gpt-5.4'}});
  await invoke('import_files',{...context,paths:[`${root}/fixtures/generated/statement.txt`],production:'Synthetic native intelligence'});
  const ready=await wait(async()=>{const s=await invoke('snapshot');return s.analysis_status?.state==='ready'?s:null;},'automatic ready after extraction');
  assert(ready.analysis_status.complete===ready.analysis_status.total,'Not every required unit completed');
  assert(ready.tasks.length===0,'Internal analysis appeared in chat history');
  const knowledge=await invoke('query_case_knowledge',{...context,query:'bag',offset:0});
  assert(knowledge.items.length===3,'Source finding and both synthesis layers were not saved');
  assert(knowledge.items.every(i=>i.human_review==='unreviewed'),'AI review inherited human approval');
  assert(knowledge.items.every(i=>i.evidence[0].proof.text.includes('blue bag')),'Exact immutable source proof was not returned');
  const before=await window.caiMock('state');
  const retrieval=[];
  for(let i=0;i<5;i++){const start=performance.now();await invoke('query_case_knowledge',{...context,query:'bag',offset:0});retrieval.push(performance.now()-start);}
  const after=await window.caiMock('state');assert(before.requests===after.requests,'Warm retrieval triggered another provider request');
  const original=knowledge.items.find(i=>i.kind==='statement');
  const read=await invoke('evidence_read',{id:original.id});
  const object={id:read.id,base_revision:read.revision,kind:read.kind,title:read.title,content:'A human amended this synthetic derived statement.',source_ids:read.source_ids,locators:read.locators,dependencies:[],start_seconds:null,end_seconds:null};
  await invoke('evidence_write',{...context,object});
  const corrected=await wait(async()=>{const state=await window.caiMock('state');const s=await invoke('snapshot');return state.requests>after.requests && s.analysis_status?.state==='ready'?s:null;},'automatic reconciliation after a human edit');
  assert((await invoke('evidence_read',{id:original.id})).content===object.content,'Automatic refresh overwrote the human revision');
  const current=await invoke('query_case_knowledge',{...context,query:'bag',offset:0});
  assert(current.items.length===3 && current.items.every(i=>i.id!==original.id),'Old edited AI finding remained current');
  await window.caiMock('hold');
  const next=current.items.find(i=>i.kind==='statement');const nextRead=await invoke('evidence_read',{id:next.id});
  await invoke('evidence_write',{...context,object:{...object,id:next.id,base_revision:nextRead.revision}});
  await wait(async()=>{const state=await window.caiMock('state');return state.held>0;},'held synthetic analysis delivery');
  await invoke('control_analysis',{...context,operation:'pause'});
  assert((await invoke('analysis_status',context)).state==='paused','Pause did not stop analysis');
  await window.caiMock('release');
  await new Promise(r=>setTimeout(r,500));
  assert((await invoke('analysis_status',context)).state==='paused','A late response resumed paused work');
  await invoke('control_analysis',{...context,operation:'resume'});
  const final=await wait(async()=>{const s=await invoke('snapshot');return s.analysis_status?.state==='ready'?s:null;},'explicit resumed analysis');
  assert(final.tasks.length===0,'Resumed analysis created user chats');
  return {automatic_ready:true,hidden_tasks:true,exact_proof:true,human_revision_preserved:true,human_edit_reconciled:true,pause_and_resume:true,warm_retrieval_ms:retrieval,units:final.analysis_status.total,findings:final.analysis_status.findings};
})().catch(error=>({native_error:String(error),stack:String(error?.stack??'')}))
