import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import SpeakerTurns from './SpeakerTurns';
import { api, native } from '../bridge';
import { transcriptPlaybackLine, type TranscriptTiming } from '../review';
import type { WorkingRecord } from '../types';
import { StatusPill, Tooltip } from '../ui';

type State = { job_id:string;status: string; error: string; progress: { state?: string; track_number?: number; track_count?: number; processed_seconds?: number; estimated_seconds?: number; segments?: number }; result: { saved_files?: string[]; segments?: number; segmented?:boolean; metadata?: TranscriptTiming & { no_audio_tracks?: boolean } }; record: WorkingRecord | null };
type Segment={ordinal:number;track:number;start:number;end:number;text:string;correction?:{id:string;revision:number;text:string;review:'pending'|'accepted'|'rejected'}};
type SegmentPage={segments:Segment[];next_cursor:number|null};
const VISIBLE_SEGMENTS=200;
function clock(seconds:number){const milliseconds=Math.round(Math.max(0,seconds)*1000);return `${String(Math.floor(milliseconds/3600000)).padStart(2,'0')}:${String(Math.floor(milliseconds/60000)%60).padStart(2,'0')}:${String(Math.floor(milliseconds/1000)%60).padStart(2,'0')}.${String(milliseconds%1000).padStart(3,'0')}`;}

export default function FullTranscript({ sourceId, caseId, sessionEpoch, run, refresh, onSeek, currentTime }: { onSeek: (time: number) => void; currentTime: number; sourceId: string; caseId?:string; sessionEpoch?:number; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> }) {
  const [state, setState] = useState<State | null>(null);
  const [version, setVersion] = useState(0);
  const [model, setModel] = useState('tiny');
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [segments,setSegments]=useState<Segment[]>([]);
  const [segmentWindowStart,setSegmentWindowStart]=useState(0);
  const [legacyWindowStart,setLegacyWindowStart]=useState(0);
  const [segmentCursor,setSegmentCursor]=useState<number|null>(null);
  const [segmentError,setSegmentError]=useState('');
  const [loadingSegments,setLoadingSegments]=useState(false);
  const [editingOrdinal,setEditingOrdinal]=useState<number|null>(null);
  const [correctionText,setCorrectionText]=useState('');
  const [correctionReason,setCorrectionReason]=useState('');
  const segmentKey=useRef('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!native) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await api<State | null>('full_transcription_status', { source_id: sourceId }); if (!active) return; setState(next); setError(''); } catch (e) { if (active) setError(String(e)); } finally { if (active) timer = setTimeout(() => { void poll(); }, 2000); } };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [sourceId, version]);
  useEffect(()=>{
    const key=`${caseId}:${sourceId}:${state?.job_id}`;segmentKey.current=key;
    setSegments([]);setSegmentCursor(null);setSegmentError('');setSegmentWindowStart(0);
    if(!native||!caseId||state?.status!=='complete'||!state.result.segmented)return;
    let active=true;
    void api<SegmentPage>('transcript_segment_page',{case_id:caseId,session_epoch:sessionEpoch,source_id:sourceId,run_id:state.job_id,cursor:null})
      .then(page=>{if(active){setSegments(page.segments);setSegmentCursor(page.next_cursor);}})
      .catch(error=>{if(active)setSegmentError(String(error));});
    return()=>{active=false;};
  },[caseId,sourceId,state?.job_id,state?.status,state?.result.segmented]);
  async function loadMoreSegments(){
    if(!caseId||!state?.job_id||segmentCursor===null||loadingSegments)return;
    const key=segmentKey.current;setLoadingSegments(true);setSegmentError('');
    try{const page=await api<SegmentPage>('transcript_segment_page',{case_id:caseId,session_epoch:sessionEpoch,source_id:sourceId,run_id:state.job_id,cursor:segmentCursor});
      if(segmentKey.current===key){setSegments(current=>[...current,...page.segments]);setSegmentWindowStart(filter.trim()?0:Math.max(0,segments.length+page.segments.length-VISIBLE_SEGMENTS));setSegmentCursor(page.next_cursor);}
    }catch(error){if(segmentKey.current===key)setSegmentError(String(error));}
    finally{if(segmentKey.current===key)setLoadingSegments(false);}
  }
  const running = state?.status === 'running' || state?.status === 'queued';
  const progress = state?.progress;
  const matchingSegments=useMemo(()=>segments.filter(segment=>!filter.trim()||segment.text.toLowerCase().includes(filter.trim().toLowerCase())),[segments,filter]);
  const visibleSegments=matchingSegments.slice(segmentWindowStart,segmentWindowStart+VISIBLE_SEGMENTS);
  useEffect(()=>{setSegmentWindowStart(0);},[filter]);
  useEffect(()=>{
    if(!follow||!expanded||filter||!state?.result.segmented)return;
    const index=segments.findIndex(segment=>{
      const interval=transcriptPlaybackLine(`[track ${segment.track} · ${clock(segment.start)} → ${clock(segment.end)}] ${segment.text}`,state.result.metadata);
      return interval&&currentTime>=interval.start&&currentTime<interval.end;
    });
    if(index>=0&&(index<segmentWindowStart||index>=segmentWindowStart+VISIBLE_SEGMENTS))setSegmentWindowStart(Math.max(0,index-50));
  },[currentTime,segments,segmentWindowStart,follow,expanded,filter,state?.result.segmented,state?.result.metadata]);
  const lines=useMemo(()=>state?.record&&!state.result.segmented?state.record.content.split('\n'):[],[state?.record?.content,state?.result.segmented]);
  const legacyRows=useMemo(()=>lines.map((line,index)=>({line,index,hit:!!filter.trim()&&line.toLowerCase().includes(filter.trim().toLowerCase())})).filter(entry=>entry.line.trim()&&(!filter.trim()||entry.hit)),[lines,filter]);
  const visibleLegacyRows=legacyRows.slice(legacyWindowStart,legacyWindowStart+VISIBLE_SEGMENTS);
  useEffect(()=>{setLegacyWindowStart(0);},[filter,state?.job_id]);
  useEffect(()=>{
    if(!follow||!expanded||filter||state?.result.segmented)return;
    const index=legacyRows.findIndex(({line})=>{const interval=transcriptPlaybackLine(line,state?.result.metadata);return interval&&currentTime>=interval.start&&currentTime<interval.end;});
    if(index>=0&&(index<legacyWindowStart||index>=legacyWindowStart+VISIBLE_SEGMENTS))setLegacyWindowStart(Math.max(0,index-50));
  },[currentTime,legacyRows,legacyWindowStart,follow,expanded,filter,state?.result.segmented,state?.result.metadata]);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!follow || !expanded || !state?.record || filter) return;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentTime, follow, expanded, state?.record, filter, segments]);
  return <section className="full-transcript">
    <div className="transcript-heading">
      <button className="quiet" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}{expanded ? 'Hide transcript' : 'Transcript'}</button>
      {running ? <StatusPill state="running" label={state?.status === 'queued' ? 'Queued' : 'Transcribing'} small /> : null}
      <div className="spacer" />
      {state?.record && expanded ? <>
        <Tooltip text={follow ? 'Stop following playback' : 'Follow playback automatically'}><button className={`icon-button ${follow ? 'accent-text' : ''}`} aria-pressed={follow} aria-label={follow ? 'Stop following playback' : 'Follow playback automatically'} onClick={() => setFollow(value => !value)}><ChevronDown size={13} className={follow ? 'follow-icon' : ''} /></button></Tooltip>
        <div className="transcript-search"><Search size={13} /><input aria-label="Search transcript" placeholder={state?.result.segmented?'Search loaded segments…':'Search transcript…'} value={filter} onChange={event => setFilter(event.target.value)} />{filter ? <span className="small muted">{state?.result.segmented?matchingSegments.length:legacyRows.length} {state?.result.segmented?'loaded segments':'lines'}</span> : null}</div>
      </> : null}
    </div>
    {running ? <div className="notice">{state?.status === 'queued' ? 'Queued behind the current recording…' : progress?.state === 'copying' ? 'Preparing a private processing copy…' : `Track ${progress?.track_number ?? 1} of ${progress?.track_count ?? '?'} · ${Math.floor(progress?.processed_seconds ?? 0)} seconds processed${progress?.estimated_seconds ? ` / approximately ${Math.ceil(progress.estimated_seconds)}` : ''} · ${progress?.segments ?? 0} segments`}<span> You can keep reviewing while this runs.</span></div> : null}
    {state?.status === 'failed' || state?.status === 'interrupted' || error ? <div className="notice error">{error || state?.error}</div> : null}
    {expanded ? <div className="run-status">Unreviewed machine transcription · timestamps are audio-track-relative; seek positions account for track offsets · tracks are not speaker identities.{!state?.record || running ? <button className="quiet" onClick={() => run(async () => { await api(running ? 'cancel_transcription' : 'transcribe_full', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId }); setVersion(value => value + 1); await refresh(); })}>{running ? 'Cancel transcription' : 'Transcribe recording'}</button> : null}</div> : null}
    {expanded && !running && state?.record ? <div className="input-row">
      <label className="small">Next transcription model
        <select value={model} onChange={event => setModel(event.target.value)}>
          <option value="tiny">Tiny · faster local processing</option>
          <option value="small">Small · higher-capacity local model</option>
        </select>
      </label>
      <button className="quiet" onClick={() => run(async () => { await api('set_asr_profile', { case_id: caseId, session_epoch: sessionEpoch, model }); await api('transcribe_full', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId }); setVersion(value => value + 1); await refresh(); })}>Transcribe a new version</button>
    </div> : null}
    {state?.record && expanded && state.result.metadata?.container_origin_seconds === undefined ? <p className="small muted">This older transcript has no playback clock mapping. Retranscribe to enable accurate seek links.</p> : null}
    {segmentError ? <p role="alert" className="small danger-text">Could not read transcript segments: {segmentError}</p> : null}
    {state?.record && expanded && state.result.segmented ? <div className="full-transcript-text" ref={transcriptRef}>
      <p className="small muted">{state.result.segments ?? 0} saved segments · {segments.length} loaded. Showing {matchingSegments.length?segmentWindowStart+1:0}–{Math.min(matchingSegments.length,segmentWindowStart+VISIBLE_SEGMENTS)} of {matchingSegments.length} matching loaded segments. Search covers loaded segments.</p>
      {segmentWindowStart>0?<button className="quiet" onClick={()=>setSegmentWindowStart(Math.max(0,segmentWindowStart-VISIBLE_SEGMENTS))}>Show previous 200 loaded segments</button>:null}
      {visibleSegments.map(segment=>{
        const line=`[track ${segment.track} · ${clock(segment.start)} → ${clock(segment.end)}] ${segment.text}`;
        const interval=transcriptPlaybackLine(line,state.result.metadata);
        const active=interval?currentTime>=interval.start&&currentTime<interval.end:false;
        return <div key={segment.ordinal} className="transcript-segment">
          <button className={`transcript-line caption-row ${active?'active':''}`} ref={active?activeRef:undefined} aria-label={`Seek to ${interval?.start ?? segment.start} seconds: ${segment.text}`} onClick={()=>onSeek(interval?.start ?? segment.start)}>
            <span className="caption-time mono">{line.slice(1,line.indexOf(']'))}</span><span className="caption-text">{segment.text}</span>
          </button>
          {segment.correction?<p className="small muted">{segment.correction.review==='accepted'?'Accepted human correction':segment.correction.review==='pending'?'Correction awaiting human review':'Rejected correction'} · version {segment.correction.revision}: {segment.correction.text}</p>:null}
          {segment.correction?.review==='pending'&&caseId?<div className="input-row">
            <button className="quiet" onClick={()=>run(async()=>{await api('review_transcript_correction',{case_id:caseId,session_epoch:sessionEpoch,correction_id:segment.correction!.id,accept:true});setSegments(current=>current.map(item=>item.ordinal===segment.ordinal&&item.correction?{...item,correction:{...item.correction,review:'accepted'}}:item));})}>Accept correction</button>
            <button className="quiet" onClick={()=>run(async()=>{await api('review_transcript_correction',{case_id:caseId,session_epoch:sessionEpoch,correction_id:segment.correction!.id,accept:false});setSegments(current=>current.map(item=>item.ordinal===segment.ordinal&&item.correction?{...item,correction:{...item.correction,review:'rejected'}}:item));})}>Reject correction</button>
          </div>:null}
          {caseId&&editingOrdinal!==segment.ordinal?<button className="quiet" onClick={()=>{setEditingOrdinal(segment.ordinal);setCorrectionText(segment.correction?.text??segment.text);setCorrectionReason('');}}>Suggest correction</button>:null}
          {caseId&&editingOrdinal===segment.ordinal?<div className="input-row">
            <textarea aria-label={`Correct segment ${segment.ordinal}`} value={correctionText} onChange={event=>setCorrectionText(event.target.value)}/>
            <input aria-label={`Correction reason ${segment.ordinal}`} placeholder="Reason checked against recording" value={correctionReason} onChange={event=>setCorrectionReason(event.target.value)}/>
            <button className="quiet" disabled={!correctionText.trim()||!correctionReason.trim()} onClick={()=>run(async()=>{
              const receipt=await api<{id:string;revision:number}>('propose_transcript_correction',{case_id:caseId,session_epoch:sessionEpoch,source_id:sourceId,run_id:state.job_id,ordinal:segment.ordinal,text:correctionText,reason:correctionReason});
              setSegments(current=>current.map(item=>item.ordinal===segment.ordinal?{...item,correction:{id:receipt.id,revision:receipt.revision,text:correctionText,review:'pending'}}:item));setEditingOrdinal(null);
            })}>Save proposal</button>
            <button className="quiet" onClick={()=>setEditingOrdinal(null)}>Cancel</button>
          </div>:null}
        </div>;
      })}
      {segmentWindowStart+VISIBLE_SEGMENTS<matchingSegments.length?<button className="quiet" onClick={()=>setSegmentWindowStart(segmentWindowStart+VISIBLE_SEGMENTS)}>Show next 200 loaded segments</button>:null}
      {segmentCursor!==null?<button className="quiet" disabled={loadingSegments} onClick={()=>void loadMoreSegments()}>{loadingSegments?'Loading…':'Load next 25 segments'}</button>:null}
    </div> : state?.record && expanded ? <div className="full-transcript-text" ref={transcriptRef}>
      <p className="small muted">Showing {legacyRows.length?legacyWindowStart+1:0}–{Math.min(legacyRows.length,legacyWindowStart+VISIBLE_SEGMENTS)} of {legacyRows.length} transcript lines.</p>
      {legacyWindowStart>0?<button className="quiet" onClick={()=>setLegacyWindowStart(Math.max(0,legacyWindowStart-VISIBLE_SEGMENTS))}>Show previous 200 transcript lines</button>:null}
      {visibleLegacyRows.map(({ line, index, hit }) => {
        const interval = transcriptPlaybackLine(line, state.result.metadata);
        const active = interval ? currentTime >= interval.start && currentTime < interval.end : false;
        return interval
          ? <button
              className={`transcript-line caption-row ${active ? 'active' : ''} ${hit ? 'match' : ''}`}
              key={index}
              ref={active ? activeRef : undefined}
              aria-label={`Seek to ${interval.start} seconds: ${interval.text}`}
              onClick={() => onSeek(interval.start)}>
              <span className="caption-time mono">{line.slice(1, line.indexOf(']'))}</span>
              <span className="caption-text">{interval.text}</span>
            </button>
          : line.trim() ? <div className="transcript-plain" key={index}>{line}</div> : null;
      })}
      {legacyWindowStart+VISIBLE_SEGMENTS<legacyRows.length?<button className="quiet" onClick={()=>setLegacyWindowStart(legacyWindowStart+VISIBLE_SEGMENTS)}>Show next 200 transcript lines</button>:null}
    </div> : expanded && !running && !state?.record ? <p className="small muted">No full transcript is available. Transcribe this recording using the control above.</p> : null}
    {expanded ? <SpeakerTurns key={`${sessionEpoch}:${sourceId}`} caseId={caseId} sessionEpoch={sessionEpoch} sourceId={sourceId} onSeek={onSeek} defaultTrack={state?.result.metadata?.tracks?.[0]?.index} /> : null}
  </section>;
}
