import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { api, evidenceUrl } from '../bridge';
type Box={page:number;x:number;y:number;width:number;height:number};
type Derivative={artifact_id:string;metadata:{mime:string;page?:number;page_count?:number}};
export default function RedactionPanel({sourceId,kind}:{sourceId:string;kind:string}) {
  const [boxes,setBoxes]=useState<Box[]>([{page:1,x:0,y:0,width:100,height:30}]);const [outputs,setOutputs]=useState<Derivative[]>([]);
  const [reviewed,setReviewed]=useState<number[]>([]);const [note,setNote]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [accepted,setAccepted]=useState(false);const [saved,setSaved]=useState('');
  async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}}
  const pages=outputs.filter(o=>o.metadata.mime==='image/jpeg');const pdf=outputs.find(o=>o.metadata.mime==='application/pdf');
  return <details className="redaction-panel"><summary>Prepare a reviewed redaction</summary><p>Rectangles use {kind==='pdf'?'PDF points':'orientation-corrected image pixels'} measured from the top-left. The derivative contains flattened page images; original text, attachments and source metadata are not copied. Review every page for missed sensitive content.</p>
    {boxes.map((box,index)=><div className="redaction-box" key={index}>{(['page','x','y','width','height'] as const).map(field=><label key={field}>{field}<input type="number" min={field==='page'||field==='width'||field==='height'?1:0} value={box[field]} disabled={busy} onChange={e=>{setAccepted(false);setOutputs([]);setBoxes(old=>old.map((b,i)=>i===index?{...b,[field]:Number(e.target.value)}:b));}}/></label>)}<button disabled={busy||boxes.length===1} onClick={()=>{setOutputs([]);setAccepted(false);setBoxes(old=>old.filter((_,i)=>i!==index));}}>Remove</button></div>)}
    <button disabled={busy||boxes.length>=1000} onClick={()=>{setOutputs([]);setAccepted(false);setBoxes(old=>[...old,{page:1,x:0,y:0,width:100,height:30}]);}}>Add rectangle</button><button className="primary" disabled={busy} onClick={()=>void action(async()=>{setOutputs([]);setReviewed([]);setAccepted(false);setSaved('');const result=await api<{published:Derivative[]}>('prepare_redaction',{source_id:sourceId,boxes});setOutputs(result.published);})}>{busy?'Processing…':'Build review copy'}</button>
    {error?<p role="alert">{error}</p>:null}
    {pages.map(page=><section key={page.artifact_id}><img loading="lazy" src={evidenceUrl(`artifact/${page.artifact_id}`)} alt={`Redacted page ${page.metadata.page}`} style={{width:'100%'}}/><label><input type="checkbox" checked={reviewed.includes(page.metadata.page!)} onChange={e=>{setAccepted(false);setReviewed(old=>e.target.checked?[...old,page.metadata.page!]:old.filter(p=>p!==page.metadata.page));}}/>I reviewed page {page.metadata.page} for remaining sensitive content</label></section>)}
    {pdf?<><label>Review note<textarea value={note} maxLength={4000} onChange={e=>{setNote(e.target.value);setAccepted(false);}}/></label><button disabled={busy||reviewed.length!==pages.length} onClick={()=>void action(async()=>{await api('review_redaction',{artifact_id:pdf.artifact_id,pages:reviewed,note});setAccepted(true);})}>Accept reviewed derivative</button><button disabled={busy||!accepted} onClick={()=>void action(async()=>{const path=await save({defaultPath:'Reviewed redaction.pdf',filters:[{name:'Flattened redaction',extensions:['pdf']}]});if(path){await api('export_redaction',{artifact_id:pdf.artifact_id,path});setSaved(path);}})}>Export derivative only</button></>:null}
    {saved?<p role="status">Saved {saved}</p>:null}
  </details>;
}
