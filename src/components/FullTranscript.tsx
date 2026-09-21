import { useEffect, useState } from 'react';
import SpeakerTurns from './SpeakerTurns';
import { api, native } from '../bridge';
import { transcriptPlaybackLine, type TranscriptTiming } from '../review';
import type { WorkingRecord } from '../types';
type State = { status: string; error: string; progress: { state?: string; track_number?: number; track_count?: number; processed_seconds?: number; estimated_seconds?: number; segments?: number }; result: { saved_files?: string[]; segments?: number; metadata?: TranscriptTiming & { no_audio_tracks?: boolean } }; record: WorkingRecord | null };
export default function FullTranscript({ sourceId, run, refresh, onSeek, currentTime }: { onSeek:(time:number)=>void; currentTime:number; sourceId: string; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> }) {
  const [state, setState] = useState<State | null>(null); const [version, setVersion] = useState(0);
  const [model,setModel]=useState('tiny');
  const [expanded, setExpanded] = useState(true); const [error, setError] = useState('');
  useEffect(() => {
    if (!native) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await api<State | null>('full_transcription_status', { source_id: sourceId }); if (!active) return; setState(next); setError(''); } catch (e) { if (active) setError(String(e)); } finally { if (active) timer = setTimeout(() => { void poll(); }, 2000); } };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [sourceId, version]);
  const running = state?.status === 'running' || state?.status === 'queued'; const progress = state?.progress;
  return <section className="full-transcript">
    <div className="transcript-heading"><button className="quiet" onClick={()=>setExpanded(v=>!v)}>{expanded?'Hide transcript':'Transcript'}</button><div className="spacer"/>{running?<span className="muted">Transcribing…</span>:null}</div>
    {running ? <div className="notice">{state?.status === 'queued' ? 'Queued behind the current recording…' : progress?.state === 'copying' ? 'Preparing a private processing copy…' : `Track ${progress?.track_number ?? 1} of ${progress?.track_count ?? '?'} · ${Math.floor(progress?.processed_seconds ?? 0)} seconds processed${progress?.estimated_seconds ? ` / approximately ${Math.ceil(progress.estimated_seconds)}` : ''} · ${progress?.segments ?? 0} segments`}<span> You can keep reviewing while this runs.</span></div> : null}
    {state?.status === 'failed' || state?.status === 'interrupted' || error ? <div className="notice error">{error || state?.error}</div> : null}
    {expanded?<div className="run-status">Unreviewed machine transcription · timestamps are audio-track-relative; seek positions account for track offsets · tracks are not speaker identities.{!state?.record||running?<button className="quiet" onClick={()=>run(async()=>{await api(running?'cancel_transcription':'transcribe_full',{source_id:sourceId});setVersion(v=>v+1);await refresh();})}>{running?'Cancel transcription':'Transcribe recording'}</button>:null}</div>:null}
    {expanded&&!running?<div className="input-row"><label>Next transcription model<select value={model} onChange={e=>setModel(e.target.value)}><option value="tiny">Tiny · faster local processing</option><option value="small">Small · higher-capacity local model</option></select></label><button className="quiet" onClick={()=>run(async()=>{await api('set_asr_profile',{model});await api('transcribe_full',{source_id:sourceId});setVersion(v=>v+1);await refresh();})}>Transcribe a new version</button></div>:null}
    {state?.record && expanded && state.result.metadata?.container_origin_seconds === undefined ? <p className="small muted">This older transcript has no playback clock mapping. Retranscribe to enable accurate seek links.</p> : null}
    {state?.record && expanded ? <><pre className="full-transcript-text">{state.record.content.split('\n').map((line,i)=>{const interval=transcriptPlaybackLine(line,state.result.metadata);return interval?<button className={`transcript-line ${currentTime>=interval.start&&currentTime<interval.end?'active':''}`} key={i} aria-label={`Seek to ${interval.start} seconds: ${interval.text}`} onClick={()=>onSeek(interval.start)}>{line}</button>:<span key={i}>{line}{'\n'}</span>;})}</pre></> : expanded && !running && !state?.record ? <p className="small muted">No full transcript is available. Transcribe this recording using the control above.</p> : null}
    {expanded?<SpeakerTurns key={sourceId} sourceId={sourceId} onSeek={onSeek} defaultTrack={state?.result.metadata?.tracks?.[0]?.index}/>:null}
  </section>;
}
