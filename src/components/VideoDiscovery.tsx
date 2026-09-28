import {useEffect,useState} from 'react';
import {Info,Play,Search,Settings2} from 'lucide-react';
import {api,evidenceUrl} from '../bridge';
import {Skeleton} from '../ui';
type Sample={artifact_id:string;locator:string;metadata:{source_relative_seconds:number;playback_seconds:number;scene_boundary:boolean;ocr?:{text:string};ocr_error?:string}};
type Job={id:string;kind:string;status:string;error:string;result:{next_start:number;has_gaps?:boolean;interval:number}};
type Index={samples:Sample[];next_offset:number|null;status:{jobs:Job[];note:string}};
export default function VideoDiscovery({caseId,sessionEpoch,sourceId,onFrame,onSeek}:{caseId?:string;sessionEpoch?:number;sourceId:string;onFrame:(id:string)=>void;onSeek:(time:number)=>void}) {
 const [kind,setKind]=useState('video_overview'),[offset,setOffset]=useState(0),[data,setData]=useState<Index|null>(null),[error,setError]=useState('');
 const [query,setQuery]=useState(''),[submitted,setSubmitted]=useState(''),[start,setStart]=useState(0),[end,setEnd]=useState(3600),[interval,setInterval]=useState(5);
 const [refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;let timer:ReturnType<typeof setTimeout>;setData(null);setError('');
  const load=async()=>{try{const value=await api<Index>('browse_video_discovery',{source_id:sourceId,kind,start,end,offset,query:submitted});if(live){setData(value);setError('');}}catch(e){if(live)setError(String(e));}finally{if(live)timer=setTimeout(()=>void load(),4000);}};
  void load();return()=>{live=false;clearTimeout(timer);};
 },[sourceId,kind,start,end,offset,refresh,submitted]);
 async function action(name:string){setBusy(true);setError('');try{await api(name,{case_id:caseId,session_epoch:sessionEpoch,source_id:sourceId,interval});setRefresh(n=>n+1);}catch(e){setError(String(e));}finally{setBusy(false);}}
 const running=data?.status.jobs.some(j=>['queued','running'].includes(j.status));
 return <section className="video-discovery" aria-label="Video overview and visible text">
  <p className="discovery-note"><Info size={14} aria-hidden="true"/><span>Sampled navigation aids. Actions and text between thumbnails may be missed. Displayed clocks are unverified text.</span></p>
  <div className="discovery-controls">
   <div className="segmented discovery-mode" role="group" aria-label="Discovery index"><button aria-pressed={kind==='video_overview'} onClick={()=>{setKind('video_overview');setOffset(0);setSubmitted('');}}>Overview</button><button aria-pressed={kind==='video_ocr'} onClick={()=>{setKind('video_ocr');setOffset(0);}}>Text in video</button></div>
   <label className="discovery-field">From (source seconds)<input type="number" min="0" value={start} onChange={e=>{setStart(Number(e.target.value));setOffset(0);}}/></label>
   <label className="discovery-field">To<input type="number" min="1" value={end} onChange={e=>{setEnd(Number(e.target.value));setOffset(0);}}/></label>
  </div>
  {kind==='video_ocr'?<form className="discovery-search" onSubmit={e=>{e.preventDefault();setSubmitted(query);setOffset(0);}}><div className="search-box"><Search size={14} aria-hidden="true"/><input aria-label="Search visible text" placeholder="Search visible text in this range" value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="secondary" data-size="sm">Search</button></form>:null}
  {error?<p role="alert" className="notice error">{error}</p>:null}
  {data?.status.jobs.length?<ul className="discovery-jobs" aria-label="Index status">{data.status.jobs.slice(0,2).map(j=><li className="status-line" key={j.id}>{['queued','running'].includes(j.status)?<span className="activity-dot" aria-hidden="true"/>:null}<span>{j.kind==='video_ocr_index'?'Visible text':'Overview'}: {j.status} · chunks through {j.result.next_start?.toFixed(0)??0}s{j.result.has_gaps?' · processing gaps reported':''}{j.error?` · ${j.error}`:''}</span></li>)}</ul>:null}
  {data===null&&!error?<div className="discovery-grid" aria-hidden="true">{Array.from({length:6},(_,index)=><div className="discovery-card discovery-card-loading" key={index}><Skeleton height={84}/><Skeleton height={12}/></div>)}</div>:null}
  {data?.samples.length?<div className="discovery-grid">{data.samples.map(sample=><div className="discovery-card" key={sample.artifact_id}>
   <button className="discovery-thumb" onClick={()=>onFrame(sample.artifact_id)}><img loading="lazy" src={evidenceUrl(`artifact/${sample.artifact_id}`)} alt={`Sample at ${sample.metadata.source_relative_seconds.toFixed(3)} seconds`}/></button>
   <button className="discovery-seek" disabled={sample.metadata.playback_seconds<0} onClick={()=>onSeek(sample.metadata.playback_seconds)}><Play size={12} aria-hidden="true"/><span className="mono">{sample.metadata.source_relative_seconds.toFixed(3)}s</span><span> · Play</span>{sample.metadata.scene_boundary?<span className="discovery-scene">Scene boundary</span>:null}</button>
   {kind==='video_ocr'?<p className={sample.metadata.ocr_error?'discovery-ocr error':'discovery-ocr'}>{sample.metadata.ocr_error??sample.metadata.ocr?.text??'No text detected in this sample'}</p>:null}
  </div>)}</div>:null}
  {data&&!data.samples.length?<p className="discovery-empty">No samples match this range/search yet. Check processing status; this does not establish absence.</p>:null}
  {data&&(offset>0||data.next_offset!=null)?<div className="discovery-pager"><button className="quiet" disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-30))}>Previous</button><button className="quiet" disabled={data?.next_offset==null} onClick={()=>setOffset(data?.next_offset??0)}>Next</button></div>:null}
  <details className="discovery-settings disclosure"><summary><Settings2 size={13} aria-hidden="true"/>Index settings and recovery</summary><div className="discovery-controls"><label className="discovery-field">Sample every (seconds)<input type="number" min="1" max="60" value={interval} onChange={e=>setInterval(Number(e.target.value))}/></label><button className="secondary" data-size="sm" disabled={busy||running||interval<1||interval>60} onClick={()=>void action('queue_video_discovery')}>Build / resume indexes</button><button className="quiet" disabled={busy||!running} onClick={()=>void action('cancel_video_discovery')}>Cancel indexing</button></div><p className="discovery-hint">Changed sampling settings create a new revision. Published samples are retained on cancellation.</p></details>
 </section>;
}
