import {useEffect,useState} from 'react';
import {api,evidenceUrl} from '../bridge';
type Sample={artifact_id:string;locator:string;metadata:{source_relative_seconds:number;playback_seconds:number;scene_boundary:boolean;ocr?:{text:string};ocr_error?:string}};
type Job={id:string;kind:string;status:string;error:string;result:{next_start:number;has_gaps?:boolean;interval:number}};
type Index={samples:Sample[];next_offset:number|null;status:{jobs:Job[];note:string}};
export default function VideoDiscovery({sourceId,onFrame,onSeek}:{sourceId:string;onFrame:(id:string)=>void;onSeek:(time:number)=>void}) {
 const [kind,setKind]=useState('video_overview'),[offset,setOffset]=useState(0),[data,setData]=useState<Index|null>(null),[error,setError]=useState('');
 const [query,setQuery]=useState(''),[submitted,setSubmitted]=useState(''),[start,setStart]=useState(0),[end,setEnd]=useState(3600),[interval,setInterval]=useState(5);
 const [refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;setData(null);setError('');
  const load=async()=>{try{const value=await api<Index>('browse_video_discovery',{source_id:sourceId,kind,start,end,offset,query:submitted});if(live){setData(value);setError('');}}catch(e){if(live)setError(String(e));}finally{if(live)timer=setTimeout(()=>void load(),4000);}};
  void load();return()=>{live=false;clearTimeout(timer);};
 },[sourceId,kind,start,end,offset,refresh,submitted]);
 async function action(name:string){setBusy(true);setError('');try{await api(name,{source_id:sourceId,interval});setRefresh(n=>n+1);}catch(e){setError(String(e));}finally{setBusy(false);}}
 const running=data?.status.jobs.some(j=>['queued','running'].includes(j.status));
 return <details className="video-discovery"><summary>Video overview and visible text</summary>
  <p className="small muted">Sampled navigation aids. Actions and text between thumbnails may be missed. Displayed clocks are unverified text.</p>
  <div className="input-row"><button aria-pressed={kind==='video_overview'} onClick={()=>{setKind('video_overview');setOffset(0);setSubmitted('');}}>Overview</button><button aria-pressed={kind==='video_ocr'} onClick={()=>{setKind('video_ocr');setOffset(0);}}>Text in video</button></div>
  <div className="input-row"><label>From (source seconds)<input type="number" min="0" value={start} onChange={e=>{setStart(Number(e.target.value));setOffset(0);}}/></label><label>To<input type="number" min="1" value={end} onChange={e=>{setEnd(Number(e.target.value));setOffset(0);}}/></label></div>
  {kind==='video_ocr'?<form className="input-row" onSubmit={e=>{e.preventDefault();setSubmitted(query);setOffset(0);}}><input aria-label="Search visible text" placeholder="Search visible text in this range" value={query} onChange={e=>setQuery(e.target.value)}/><button>Search</button></form>:null}
  {error?<p role="alert">{error}</p>:null}
  {data?.status.jobs.slice(0,2).map(j=><p className="small muted" key={j.id}>{j.kind==='video_ocr_index'?'Visible text':'Overview'}: {j.status} · chunks through {j.result.next_start?.toFixed(0)??0}s{j.result.has_gaps?' · processing gaps reported':''}{j.error?` · ${j.error}`:''}</p>)}
  <div className="discovery-grid">{data?.samples.map(sample=><div key={sample.artifact_id}>
   <button onClick={()=>onFrame(sample.artifact_id)}><img loading="lazy" src={evidenceUrl(`artifact/${sample.artifact_id}`)} alt={`Sample at ${sample.metadata.source_relative_seconds.toFixed(3)} seconds`}/></button>
   <button disabled={sample.metadata.playback_seconds<0} onClick={()=>onSeek(sample.metadata.playback_seconds)}>{sample.metadata.source_relative_seconds.toFixed(3)}s{sample.metadata.scene_boundary?' · scene boundary':''} · Play</button>
   {kind==='video_ocr'?<p>{sample.metadata.ocr_error??sample.metadata.ocr?.text??'No text detected in this sample'}</p>:null}
  </div>)}</div>
  {data&&!data.samples.length?<p className="small muted">No samples match this range/search yet. Check processing status; this does not establish absence.</p>:null}
  <div className="input-row"><button disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-30))}>Previous</button><button disabled={data?.next_offset==null} onClick={()=>setOffset(data?.next_offset??0)}>Next</button></div>
  <details><summary>Index settings and recovery</summary><div className="input-row"><label>Sample every (seconds)<input type="number" min="1" max="60" value={interval} onChange={e=>setInterval(Number(e.target.value))}/></label><button disabled={busy||running||interval<1||interval>60} onClick={()=>void action('queue_video_discovery')}>Build / resume indexes</button><button disabled={busy||!running} onClick={()=>void action('cancel_video_discovery')}>Cancel indexing</button></div><p className="small muted">Changed sampling settings create a new revision. Published samples are retained on cancellation.</p></details>
 </details>;
}
