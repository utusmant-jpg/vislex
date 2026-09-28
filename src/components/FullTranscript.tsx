import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Info, LocateFixed, Search } from 'lucide-react';
import SpeakerTurns from './SpeakerTurns';
import { api, native } from '../bridge';
import { transcriptPlaybackLine, type TranscriptTiming } from '../review';
import type { WorkingRecord } from '../types';
import { StatusPill, Tooltip } from '../ui';

type State = { job_id:string;status: string; error: string; progress: { state?: string; track_number?: number; track_count?: number; processed_seconds?: number; estimated_seconds?: number; segments?: number }; result: { saved_files?: string[]; segments?: number; segmented?:boolean; metadata?: TranscriptTiming & { no_audio_tracks?: boolean } }; record: WorkingRecord | null };
type Segment={ordinal:number;track:number;start:number;end:number;text:string;correction?:{id:string;revision:number;text:string;review:'pending'|'accepted'|'rejected'}};
type SegmentPage={segments:Segment[];next_cursor:number|null};
const VISIBLE_SEGMENTS=200;
/** Split a caption prefix like "track 0 · 00:00:01.000 → 00:00:02.000" into its track and time range. */
export function captionParts(prefix:string):{track:string|null;time:string}{const match=/^track (\d+) · (.*)$/.exec(prefix);return match?{track:match[1],time:match[2]}:{track:null,time:prefix};}
function CaptionTime({prefix}:{prefix:string}){const parts=captionParts(prefix);return <span className="caption-time mono">{parts.track!==null?<span className="caption-track" title={`Audio track ${parts.track} — not a speaker identity`}>T{parts.track}</span>:null}<span className="caption-clock">{parts.time}</span></span>;}
/** Wrap case-insensitive occurrences of the search query in <mark> so the match is visible, not only filtered.
 * Lowercasing can change string length (for example "İ" becomes two UTF-16 units), so matches are found in a
 * per-code-point lowercase copy that keeps a map back to original offsets; the <mark> always wraps the original characters. */
export function highlightMatches(text:string,query:string){
  const needle=query.trim().toLowerCase();if(!needle)return text;
  let lower='';const origin:number[]=[];
  for(let index=0;index<text.length;){const char=String.fromCodePoint(text.codePointAt(index)!);const folded=char.toLowerCase();for(let unit=0;unit<folded.length;unit++)origin.push(index);lower+=folded;index+=char.length;}
  origin.push(text.length);
  // The original offset just past the code point that produced lower-case unit `position`.
  const endOf=(position:number)=>{const begin=origin[position];let next=position+1;while(next<origin.length&&origin[next]===begin)next++;return origin[next];};
  const parts:React.ReactNode[]=[];let from=0;let at=lower.indexOf(needle);
  while(at>=0){const begin=origin[at];const finish=endOf(at+needle.length-1);if(begin>=from){if(begin>from)parts.push(text.slice(from,begin));parts.push(<mark key={begin}>{text.slice(begin,finish)}</mark>);from=finish;}at=lower.indexOf(needle,at+needle.length);}
  if(from<text.length)parts.push(text.slice(from));return parts;
}
function clock(seconds:number){const milliseconds=Math.round(Math.max(0,seconds)*1000);return `${String(Math.floor(milliseconds/3600000)).padStart(2,'0')}:${String(Math.floor(milliseconds/60000)%60).padStart(2,'0')}:${String(Math.floor(milliseconds/1000)%60).padStart(2,'0')}.${String(milliseconds%1000).padStart(3,'0')}`;}

// An unsaved correction proposal survives switching or closing the file tab,
// which unmounts the viewer. Memory only, for this app session, like
// working-file drafts; never browser storage. Tied to the transcript run it
// was drafted against.
const correctionDrafts = new Map<string, { run: string | null; ordinal: number; text: string; reason: string }>();
/** Test isolation: drafts are module state. */
export function forgetCorrectionDrafts() { correctionDrafts.clear(); }

type FullTranscriptProps = { open?: boolean; onSeek: (time: number) => void; currentTime: number; sourceId: string; caseId?:string; sessionEpoch?:number; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> };

/** The transcript stays mounted while the dock is collapsed or shows another
 *  tool (so searches and drafts survive), but a hidden transcript skips the
 *  per-tick re-render of up to 200 rows and the speaker turns: playback time
 *  and fresh callback identities are ignored until it is shown again. */
function hiddenPropsEqual(previous: FullTranscriptProps, next: FullTranscriptProps) {
  if (previous.open !== false || next.open !== false) return false;
  return previous.sourceId === next.sourceId && previous.caseId === next.caseId && previous.sessionEpoch === next.sessionEpoch;
}

export default memo(FullTranscript, hiddenPropsEqual);

function FullTranscript({ sourceId, caseId, sessionEpoch, run, refresh, onSeek, currentTime, open = true }: FullTranscriptProps) {
  const [state, setState] = useState<State | null>(null);
  const [version, setVersion] = useState(0);
  const [model, setModel] = useState('tiny');
  // Visibility is owned by the viewer's tool dock; follow-scrolling pauses while hidden.
  const expanded = open;
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [segments,setSegments]=useState<Segment[]>([]);
  const [segmentWindowStart,setSegmentWindowStart]=useState(0);
  const [legacyWindowStart,setLegacyWindowStart]=useState(0);
  const [segmentCursor,setSegmentCursor]=useState<number|null>(null);
  const [segmentError,setSegmentError]=useState('');
  const [loadingSegments,setLoadingSegments]=useState(false);
  const draftKey=`${caseId}:${sessionEpoch}:${sourceId}`;
  const [editingOrdinal,setEditingOrdinal]=useState<number|null>(()=>correctionDrafts.get(draftKey)?.ordinal??null);
  const [correctionText,setCorrectionText]=useState(()=>correctionDrafts.get(draftKey)?.text??'');
  const [correctionReason,setCorrectionReason]=useState(()=>correctionDrafts.get(draftKey)?.reason??'');
  const segmentKey=useRef('');
  const runId=state?.job_id??null;
  useEffect(()=>{
    const kept=correctionDrafts.get(draftKey);
    // A draft made against another transcript run does not carry over to this one.
    if(runId&&kept?.run&&kept.run!==runId){correctionDrafts.delete(draftKey);setEditingOrdinal(null);return;}
    if(editingOrdinal===null)correctionDrafts.delete(draftKey);
    else correctionDrafts.set(draftKey,{run:runId??kept?.run??null,ordinal:editingOrdinal,text:correctionText,reason:correctionReason});
  },[draftKey,runId,editingOrdinal,correctionText,correctionReason]);
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
  // Follow re-windows only when playback reaches a different segment, so paging
  // or loading more segments is not undone while the playing segment is unchanged.
  const followedSegment=useRef<number|null>(null);
  const followedLine=useRef<number|null>(null);
  useEffect(()=>{
    if(!follow||!expanded||filter||!state?.result.segmented){followedSegment.current=null;return;}
    const index=segments.findIndex(segment=>{
      const interval=transcriptPlaybackLine(`[track ${segment.track} · ${clock(segment.start)} → ${clock(segment.end)}] ${segment.text}`,state.result.metadata);
      return interval&&currentTime>=interval.start&&currentTime<interval.end;
    });
    if(index<0||followedSegment.current===index)return;
    followedSegment.current=index;
    if(index<segmentWindowStart||index>=segmentWindowStart+VISIBLE_SEGMENTS)setSegmentWindowStart(Math.max(0,index-50));
  },[currentTime,segments,segmentWindowStart,follow,expanded,filter,state?.result.segmented,state?.result.metadata]);
  const lines=useMemo(()=>state?.record&&!state.result.segmented?state.record.content.split('\n'):[],[state?.record?.content,state?.result.segmented]);
  const legacyRows=useMemo(()=>lines.map((line,index)=>({line,index,hit:!!filter.trim()&&line.toLowerCase().includes(filter.trim().toLowerCase())})).filter(entry=>entry.line.trim()&&(!filter.trim()||entry.hit)),[lines,filter]);
  const visibleLegacyRows=legacyRows.slice(legacyWindowStart,legacyWindowStart+VISIBLE_SEGMENTS);
  useEffect(()=>{setLegacyWindowStart(0);},[filter,state?.job_id]);
  useEffect(()=>{
    if(!follow||!expanded||filter||state?.result.segmented){followedLine.current=null;return;}
    const index=legacyRows.findIndex(({line})=>{const interval=transcriptPlaybackLine(line,state?.result.metadata);return interval&&currentTime>=interval.start&&currentTime<interval.end;});
    if(index<0||followedLine.current===index)return;
    followedLine.current=index;
    if((index<legacyWindowStart||index>=legacyWindowStart+VISIBLE_SEGMENTS))setLegacyWindowStart(Math.max(0,index-50));
  },[currentTime,legacyRows,legacyWindowStart,follow,expanded,filter,state?.result.segmented,state?.result.metadata]);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!follow || !expanded || !state?.record || filter) return;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentTime, follow, expanded, state?.record, filter, segments]);
  const hasRecord = !!state?.record;
  const segmented = !!state?.result.segmented;
  const correctionLabel = (review: 'pending'|'accepted'|'rejected') => review==='accepted'?'Accepted human correction':review==='pending'?'Correction awaiting human review':'Rejected correction';
  // Content stays mounted while the dock shows another tool so searches, drafts and speaker corrections survive tab switches.
  return <section className="full-transcript" aria-label="Full transcript">
    <div className="transcript-heading">
      {running ? <StatusPill state="running" label={state?.status === 'queued' ? 'Queued' : 'Transcribing'} small /> : <span className="transcript-kind"><AudioLines size={14} aria-hidden="true" />{hasRecord ? 'Machine transcript' : 'No transcript yet'}</span>}
      <div className="spacer" />
      {hasRecord ? <>
        <div className="search-box transcript-search"><Search size={14} aria-hidden="true" /><input aria-label="Search transcript" placeholder={segmented?'Search loaded segments…':'Search transcript…'} value={filter} onChange={event => setFilter(event.target.value)} />{filter ? <span className="transcript-search-count">{segmented?matchingSegments.length:legacyRows.length} {segmented?'loaded segments':'lines'}</span> : null}</div>
        <Tooltip text={follow ? 'Stop following playback' : 'Follow playback automatically'}><button className="icon-button" aria-pressed={follow} aria-label={follow ? 'Stop following playback' : 'Follow playback automatically'} onClick={() => setFollow(value => !value)}><LocateFixed size={16} /></button></Tooltip>
      </> : null}
    </div>
    {running ? <div className="transcript-progress status-line" role="status"><span className="activity-dot" aria-hidden="true" /><span>{state?.status === 'queued' ? 'Queued behind the current recording…' : progress?.state === 'copying' ? 'Preparing a private processing copy…' : `Track ${progress?.track_number ?? 1} of ${progress?.track_count ?? '?'} · ${Math.floor(progress?.processed_seconds ?? 0)} seconds processed${progress?.estimated_seconds ? ` / approximately ${Math.ceil(progress.estimated_seconds)}` : ''} · ${progress?.segments ?? 0} segments`}<span className="units"> You can keep reviewing while this runs.</span></span></div> : null}
    {state?.status === 'failed' || state?.status === 'interrupted' || error ? <div className="notice error" role="alert"><Info size={16} aria-hidden="true" /><span>{error || state?.error}</span></div> : null}
    <div className="run-status"><Info size={14} aria-hidden="true" /><span>Unreviewed machine transcription · timestamps are audio-track-relative; seek positions account for track offsets · tracks are not speaker identities.</span>{!state?.record || running ? <button className={running ? 'secondary' : 'primary'} data-size="sm" onClick={() => run(async () => { await api(running ? 'cancel_transcription' : 'transcribe_full', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId }); setVersion(value => value + 1); await refresh(); })}>{running ? 'Cancel transcription' : 'Transcribe recording'}</button> : null}</div>
    {!running && state?.record ? <details className="transcript-version disclosure"><summary>New transcription version</summary><div className="input-row transcript-model">
      <label>Next transcription model
        <select value={model} onChange={event => setModel(event.target.value)}>
          <option value="tiny">Tiny · faster local processing</option>
          <option value="small">Small · higher-capacity local model</option>
        </select>
      </label>
      <button className="secondary" data-size="sm" onClick={() => run(async () => { await api('set_asr_profile', { case_id: caseId, session_epoch: sessionEpoch, model }); await api('transcribe_full', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId }); setVersion(value => value + 1); await refresh(); })}>Transcribe a new version</button>
    </div></details> : null}
    {state?.record && state.result.metadata?.container_origin_seconds === undefined ? <p className="transcript-note">This older transcript has no playback clock mapping. Retranscribe to enable accurate seek links.</p> : null}
    {segmentError ? <p role="alert" className="small danger-text">Could not read transcript segments: {segmentError}</p> : null}
    {state?.record && state.result.segmented ? <div className="full-transcript-text" ref={transcriptRef}>
      <p className="transcript-window">{state.result.segments ?? 0} saved segments · {segments.length} loaded. Showing {matchingSegments.length?segmentWindowStart+1:0}–{Math.min(matchingSegments.length,segmentWindowStart+VISIBLE_SEGMENTS)} of {matchingSegments.length} matching loaded segments. Search covers loaded segments.</p>
      {segmentWindowStart>0?<button className="quiet transcript-page" onClick={()=>setSegmentWindowStart(Math.max(0,segmentWindowStart-VISIBLE_SEGMENTS))}>Show previous 200 loaded segments</button>:null}
      {visibleSegments.map(segment=>{
        const line=`[track ${segment.track} · ${clock(segment.start)} → ${clock(segment.end)}] ${segment.text}`;
        const interval=transcriptPlaybackLine(line,state.result.metadata);
        const active=interval?currentTime>=interval.start&&currentTime<interval.end:false;
        return <div key={segment.ordinal} className={`transcript-segment ${active?'active':''}`}>
          <div className="transcript-segment-row">
            <button className={`transcript-line caption-row ${active?'active':''}`} ref={active?activeRef:undefined} aria-current={active?'true':undefined} aria-label={`Seek to ${interval?.start ?? segment.start} seconds: ${segment.text}`} onClick={()=>onSeek(interval?.start ?? segment.start)}>
              <CaptionTime prefix={line.slice(1,line.indexOf(']'))} /><span className="caption-text">{highlightMatches(segment.text,filter)}</span>
            </button>
            {caseId&&editingOrdinal!==segment.ordinal?<button className="quiet transcript-suggest" aria-label="Suggest correction" onClick={()=>{setEditingOrdinal(segment.ordinal);setCorrectionText(segment.correction?.text??segment.text);setCorrectionReason('');}}><span>Suggest</span></button>:null}
          </div>
          {segment.correction?<p className={`transcript-correction review-${segment.correction.review}`}><span className="transcript-correction-state">{correctionLabel(segment.correction.review)} · version {segment.correction.revision}:</span> {segment.correction.text}</p>:null}
          {segment.correction?.review==='pending'&&caseId?<div className="input-row transcript-correction-actions">
            <button className="secondary" data-size="sm" onClick={()=>run(async()=>{await api('review_transcript_correction',{case_id:caseId,session_epoch:sessionEpoch,correction_id:segment.correction!.id,accept:true});setSegments(current=>current.map(item=>item.ordinal===segment.ordinal&&item.correction?{...item,correction:{...item.correction,review:'accepted'}}:item));})}>Accept correction</button>
            <button className="quiet" onClick={()=>run(async()=>{await api('review_transcript_correction',{case_id:caseId,session_epoch:sessionEpoch,correction_id:segment.correction!.id,accept:false});setSegments(current=>current.map(item=>item.ordinal===segment.ordinal&&item.correction?{...item,correction:{...item.correction,review:'rejected'}}:item));})}>Reject correction</button>
          </div>:null}
          {caseId&&editingOrdinal===segment.ordinal?<div className="transcript-correction-editor">
            <label className="field-label">Corrected wording<textarea aria-label={`Correct segment ${segment.ordinal}`} value={correctionText} onChange={event=>setCorrectionText(event.target.value)}/></label>
            <label className="field-label">Reason<input aria-label={`Correction reason ${segment.ordinal}`} placeholder="Reason checked against recording" value={correctionReason} onChange={event=>setCorrectionReason(event.target.value)}/></label>
            <p className="field-hint">A proposal is saved for human review. The machine transcript is not changed.</p>
            <div className="transcript-correction-actions">
              <button className="quiet" onClick={()=>setEditingOrdinal(null)}>Cancel</button>
              <button className="primary" data-size="sm" disabled={!correctionText.trim()||!correctionReason.trim()} onClick={()=>run(async()=>{
                const receipt=await api<{id:string;revision:number}>('propose_transcript_correction',{case_id:caseId,session_epoch:sessionEpoch,source_id:sourceId,run_id:state.job_id,ordinal:segment.ordinal,text:correctionText,reason:correctionReason});
                setSegments(current=>current.map(item=>item.ordinal===segment.ordinal?{...item,correction:{id:receipt.id,revision:receipt.revision,text:correctionText,review:'pending'}}:item));setEditingOrdinal(null);
              })}>Save proposal</button>
            </div>
          </div>:null}
        </div>;
      })}
      {segmentWindowStart+VISIBLE_SEGMENTS<matchingSegments.length?<button className="quiet transcript-page" onClick={()=>setSegmentWindowStart(segmentWindowStart+VISIBLE_SEGMENTS)}>Show next 200 loaded segments</button>:null}
      {segmentCursor!==null?<button className="secondary transcript-page" data-size="sm" disabled={loadingSegments} onClick={()=>void loadMoreSegments()}>{loadingSegments?'Loading…':'Load next 25 segments'}</button>:null}
    </div> : state?.record ? <div className="full-transcript-text" ref={transcriptRef}>
      <p className="transcript-window">Showing {legacyRows.length?legacyWindowStart+1:0}–{Math.min(legacyRows.length,legacyWindowStart+VISIBLE_SEGMENTS)} of {legacyRows.length} transcript lines.</p>
      {legacyWindowStart>0?<button className="quiet transcript-page" onClick={()=>setLegacyWindowStart(Math.max(0,legacyWindowStart-VISIBLE_SEGMENTS))}>Show previous 200 transcript lines</button>:null}
      {visibleLegacyRows.map(({ line, index, hit }) => {
        const interval = transcriptPlaybackLine(line, state.result.metadata);
        const active = interval ? currentTime >= interval.start && currentTime < interval.end : false;
        return interval
          ? <button
              className={`transcript-line caption-row ${active ? 'active' : ''} ${hit ? 'match' : ''}`}
              key={index}
              ref={active ? activeRef : undefined}
              aria-current={active ? 'true' : undefined}
              aria-label={`Seek to ${interval.start} seconds: ${interval.text}`}
              onClick={() => onSeek(interval.start)}>
              <CaptionTime prefix={line.slice(1, line.indexOf(']'))} />
              <span className="caption-text">{highlightMatches(interval.text,filter)}</span>
            </button>
          : line.trim() ? <div className={`transcript-plain ${hit ? 'match' : ''}`} key={index}>{highlightMatches(line,filter)}</div> : null;
      })}
      {legacyWindowStart+VISIBLE_SEGMENTS<legacyRows.length?<button className="quiet transcript-page" onClick={()=>setLegacyWindowStart(legacyWindowStart+VISIBLE_SEGMENTS)}>Show next 200 transcript lines</button>:null}
    </div> : !running && !state?.record ? <div className="transcript-empty">
      <AudioLines size={20} aria-hidden="true" />
      <p>No full transcript is available. Transcribe this recording using the control above.</p>
    </div> : null}
    <SpeakerTurns key={`${sessionEpoch}:${sourceId}`} caseId={caseId} sessionEpoch={sessionEpoch} sourceId={sourceId} onSeek={onSeek} defaultTrack={state?.result.metadata?.tracks?.[0]?.index} />
  </section>;
}
