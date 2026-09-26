// Synthetic-only native smoke run through the real Tauri bridge, no database edits or provider calls.
(async () => {
  const invoke=async(action,args={})=>{try{return await window.__TAURI_INTERNALS__.invoke('command',{action,args});}catch(e){throw new Error(action+': '+String(e));}};
  const root=__WORKSPACE__;
  const run=Date.now().toString();
  await invoke('create_case',{path:root+'/artifacts/acceptance-'+run,name:'Synthetic native acceptance '+run});
  const initial=await invoke('snapshot');
  const imported=await invoke('import_files',{case_id:initial.id,paths:['statement.pdf','statement.txt','photograph.png','variable-timing.mp4','notes.docx','table.xlsx'].map(n=>root+'/fixtures/generated/'+n),production:'Synthetic acceptance'});
  if(imported.items.some(i=>i.status!=='imported'))throw new Error('Fixture import failed');
  let snapshot=await invoke('snapshot');
  const caseSummary=await invoke('case_summary',{case_id:snapshot.id});
  let firstSources;
  for(let attempt=0;attempt<8;attempt++){
    snapshot=await invoke('snapshot');
    try{firstSources=await invoke('source_page',{case_id:snapshot.id,generation:snapshot.generation,audit_seq:snapshot.counts.audit_seq});break;}
    catch(error){if(!String(error).includes('Case changed before source page')||attempt===7)throw error;}
  }
  if(caseSummary.source_count!==6||firstSources.sources.length!==6||firstSources.next_cursor!==null)throw new Error('Bounded source list did not match imported originals');
  let crossCaseSourceDenied=false;try{await invoke('source_page',{case_id:'another-case',generation:snapshot.generation,audit_seq:snapshot.counts.audit_seq});}catch{crossCaseSourceDenied=true;}
  if(!crossCaseSourceDenied)throw new Error('A stale case was allowed to list sources');
  const pdf=snapshot.sources.find(s=>s.kind==='pdf');const photo=snapshot.sources.find(s=>s.kind==='image');const video=snapshot.sources.find(s=>s.kind==='video');
  const process=invoke('process_source',{case_id:snapshot.id,source_id:pdf.id});const latencies=[];
  for(let i=0;i<5;i++){const t=performance.now();await invoke('snapshot');latencies.push(performance.now()-t);}
  await process;
  const documents=[];
  for(const name of ['notes.docx','table.xlsx']) {
    const source=snapshot.sources.find(s=>s.name===name);
    const first=await invoke('process_source',{case_id:snapshot.id,source_id:source.id});
    const second=await invoke('process_source',{case_id:snapshot.id,source_id:source.id});
    const text=await invoke('read_text',{source_id:source.id,start:1,count:200});
    if(!second.reused || first.extraction_locator!==second.extraction_locator || !text.total_lines)throw new Error('Document extraction/cache failed: '+name);
    documents.push({name,total_lines:text.total_lines,reused:second.reused});
  }
  await invoke('save_settings',{case_id:snapshot.id,session_epoch:snapshot.session_epoch,settings:{...snapshot.settings,offline:false,allow_text:true,model:'synthetic'}});
  let crossCaseChatDenied=false;
  try { await invoke('start_task',{case_id:'another-case',prompt:'how many files we have?'}); } catch { crossCaseChatDenied=true; }
  if(!crossCaseChatDenied)throw new Error('A stale case was allowed to start a chat');
  let inventoryTask;
  for(let attempt=0;attempt<600;attempt++) {
    try { inventoryTask=await invoke('start_task',{case_id:snapshot.id,session_epoch:snapshot.session_epoch,prompt:'how many files we have?'});break; }
    catch(error) {
      if(!String(error).includes('Files are still being prepared'))throw error;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  if(!inventoryTask)throw new Error('Chat preparation gate did not resolve within five minutes');
  const inventorySnapshot=await invoke('snapshot');
  const inventory=inventorySnapshot.tasks.find(t=>t.id===inventoryTask.task_id);
  if(inventory?.status!=='complete' || inventory.answer!=='You have 6 original files in this case.' || inventory.input_tokens || inventory.output_tokens)throw new Error('Inventory did not finish without model calls');
  await invoke('queue_video_discovery',{case_id:snapshot.id,session_epoch:snapshot.session_epoch,source_id:video.id,interval:1});
  const discoveryLatency=[];
  for(let i=0;i<120;i++) {
    const t=performance.now();await invoke('snapshot');discoveryLatency.push(performance.now()-t);
    const status=await invoke('video_discovery_status',{source_id:video.id});
    if(status.jobs.some(j=>j.status==='failed'))throw new Error('Discovery failed: '+JSON.stringify(status));
    if(status.jobs.length>=2&&status.jobs.every(j=>j.status==='complete'))break;
    if(i===119)throw new Error('Discovery did not finish');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const discovery=[];
  for(const kind of ['video_ocr','video_overview']) {
    const result=await invoke('browse_video_discovery',{source_id:video.id,kind,start:0,end:100,offset:0});
    if(!result.samples.length||!Number.isFinite(result.samples[0].metadata.pts))throw new Error('Missing timestamped discovery samples');
    discovery.push({kind,samples:result.samples.length,pts:result.samples[0].metadata.pts});
  }
  const search=await invoke('hybrid_search',{query:'witness'});
  if(!search.results.length && !search.lexical_results?.length)throw new Error('No saved or lexical lead for the exact synthetic fixture term');
  // Automatic local transcription can change the case generation. Wait for it before testing an exact-revision export.
  for(let i=0;i<240;i++){const current=await invoke('snapshot');if(!current.jobs.some(j=>j.kind==='full_audio'&&['running','queued'].includes(j.status)))break;if(i===239)throw new Error('Automatic transcripts did not settle');await new Promise(resolve=>setTimeout(resolve,500));}
  const record=await invoke('write_record',{case_id:initial.id,session_epoch:initial.session_epoch,title:'Synthetic native draft',kind:'report',content:'Synthetic caf\u00e9 draft. Evidence remains unreviewed.',source_ids:[pdf.id]});
  const compact=await invoke('snapshot');
  const firstRecords=await invoke('record_page',{case_id:compact.id,generation:compact.generation,audit_seq:compact.counts.audit_seq});
  if(!firstRecords.records.some(item=>item.id===record.id))throw new Error('Saved working file missing from bounded record list');
  const summary=compact.records.find(item=>item.id===record.id);
  if(!summary||Object.hasOwn(summary,'content'))throw new Error('Working-record body leaked into case summary');
  const detail=await invoke('record_detail',{case_id:compact.id,record_id:record.id,revision:record.revision});
  if(detail.content!==record.content)throw new Error('Working-record detail did not match saved revision');
  let staleDetailDenied=false;try{await invoke('record_detail',{case_id:'other-case',record_id:record.id,revision:record.revision});}catch{staleDetailDenied=true;}
  if(!staleDetailDenied)throw new Error('Cross-case record detail was accepted');
  const exports=[];
  for(const ext of ['docx','pdf'])exports.push(await invoke('export_word',{case_id:snapshot.id,record_id:record.id,path:root+'/artifacts/acceptance-'+run+'.'+ext}));
  let crossCaseExportDenied=false;try{await invoke('export_record',{case_id:'old-case',record_id:record.id,expected_revision:record.revision,path:root+'/artifacts/wrong-case-'+run+'.md'});}catch{crossCaseExportDenied=true;}
  if(!crossCaseExportDenied)throw new Error('Export accepted a stale case identity');
  const redaction=await invoke('prepare_redaction',{case_id:snapshot.id,source_id:photo.id,boxes:[{page:1,x:0,y:0,width:100,height:30}]});
  const derivative=redaction.published.find(p=>p.metadata.mime==='application/pdf');
  let denied=false;try{await invoke('export_redaction',{case_id:snapshot.id,session_epoch:snapshot.session_epoch,artifact_id:derivative.artifact_id,path:root+'/artifacts/unreviewed-'+run+'.pdf'});}catch(error){denied=String(error).includes('Human page review is required');}
  if(!denied)throw new Error('Unreviewed redaction export was allowed');
  const proxy=await invoke('playback_proxy',{source_id:video.id});const info=await invoke('artifact_info',{artifact_id:proxy.artifact_id});
  if(info.metadata.player_origin_seconds!==0)throw new Error('Playback lacks explicit origin');
  const waitFor=async(predicate,label)=>{for(let i=0;i<100;i++){const found=predicate();if(found)return found;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('UI did not show '+label);};
  // Chat rows append a relative-time label inside the button, so match the exact tooltip title instead of concatenated text.
  const chat=await waitFor(()=>[...document.querySelectorAll('button.chat-open')].find(b=>b.title==='how many files we have?'),'inventory conversation');chat.click();
  await waitFor(()=>document.querySelector('.answer')?.textContent.includes('You have 6 original files in this case.'),'direct inventory answer');
  const evidence=await waitFor(()=>[...document.querySelectorAll('button.rail-button')].find(b=>b.getAttribute('aria-label')==='Evidence'),'evidence workspace');evidence.click();
  const doc=await waitFor(()=>[...document.querySelectorAll('button.library-row')].find(b=>b.querySelector('.library-name')?.textContent==='notes.docx'),'DOCX library entry');doc.click();
  await waitFor(()=>document.querySelector('.document-page .text-lines')?.textContent.length>10,'DOCX preview');
  evidence.click();
  const working=await waitFor(()=>[...document.querySelectorAll('.library-controls button')].find(b=>b.textContent==='Working files'),'working-file filter');working.click();
  const draft=await waitFor(()=>[...document.querySelectorAll('button.library-row')].find(b=>b.querySelector('.library-name')?.textContent==='Synthetic native draft'),'working-file entry');draft.click();
  await waitFor(()=>document.querySelector('textarea[aria-label="Working file content"]')?.value===record.content,'lazy working-file detail');
  if(document.querySelector('.saved-progress,.question-dossier,.context-note'))throw new Error('Internal review panels leaked into normal chat');
  const blockingDialog=document.querySelector('dialog[open]');
  if(blockingDialog)throw new Error(`Native journey ended behind an open ${blockingDialog.className} dialog`);
  return {run,discovery,discovery_snapshot_latency_ms:discoveryLatency,chat_answer_rendered:true,docx_preview_rendered:true,unobscured_ui:true,documents,inventory_answer:inventory.answer,case_id:snapshot.id,source_count:snapshot.counts.source_count,snapshot_bytes:JSON.stringify(snapshot).length,summary_bytes:JSON.stringify(caseSummary).length,snapshot_latency_ms:latencies,semantic_results:search.results.length,lexical_results:search.lexical_results?.length??0,remaining_passages:search.remaining_passages,exports,cross_case_chat_denied:crossCaseChatDenied,cross_case_source_denied:crossCaseSourceDenied,cross_case_export_denied:crossCaseExportDenied,unreviewed_redaction_denied:denied,playback_origin:info.metadata,provider_calls:0};
})()
