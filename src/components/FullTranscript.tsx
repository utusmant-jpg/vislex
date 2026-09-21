import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import SpeakerTurns from './SpeakerTurns';
import { api, native } from '../bridge';
import { transcriptPlaybackLine, type TranscriptTiming } from '../review';
import type { WorkingRecord } from '../types';
import { StatusPill, Tooltip } from '../ui';

type State = { status: string; error: string; progress: { state?: string; track_number?: number; track_count?: number; processed_seconds?: number; estimated_seconds?: number; segments?: number }; result: { saved_files?: string[]; segments?: number; metadata?: TranscriptTiming & { no_audio_tracks?: boolean } }; record: WorkingRecord | null };

export default function FullTranscript({ sourceId, run, refresh, onSeek, currentTime }: { onSeek: (time: number) => void; currentTime: number; sourceId: string; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> }) {
  const [state, setState] = useState<State | null>(null);
  const [version, setVersion] = useState(0);
  const [model, setModel] = useState('tiny');
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!native) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await api<State | null>('full_transcription_status', { source_id: sourceId }); if (!active) return; setState(next); setError(''); } catch (e) { if (active) setError(String(e)); } finally { if (active) timer = setTimeout(() => { void poll(); }, 2000); } };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [sourceId, version]);
  const running = state?.status === 'running' || state?.status === 'queued';
  const progress = state?.progress;
  const lines = state?.record ? state.record.content.split('\n') : [];
  const matches = filter.trim() ? lines.map((line, index) => ({ line, index, hit: line.toLowerCase().includes(filter.trim().toLowerCase()) })) : null;
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!follow || !expanded || !state?.record || filter) return;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentTime, follow, expanded, state?.record, filter]);
  return <section className="full-transcript">
    <div className="transcript-heading">
      <button className="quiet" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}{expanded ? 'Hide transcript' : 'Transcript'}</button>
      {running ? <StatusPill state="running" label={state?.status === 'queued' ? 'Queued' : 'Transcribing'} small /> : null}
      <div className="spacer" />
      {state?.record && expanded ? <>
        <Tooltip text={follow ? 'Stop following playback' : 'Follow playback automatically'}><button className={`icon-button ${follow ? 'accent-text' : ''}`} aria-pressed={follow} aria-label={follow ? 'Stop following playback' : 'Follow playback automatically'} onClick={() => setFollow(value => !value)}><ChevronDown size={13} className={follow ? 'follow-icon' : ''} /></button></Tooltip>
        <div className="transcript-search"><Search size={13} /><input aria-label="Search transcript" placeholder="Search transcript…" value={filter} onChange={event => setFilter(event.target.value)} />{filter ? <span className="small muted">{matches?.filter(entry => entry.hit).length ?? 0} lines</span> : null}</div>
      </> : null}
    </div>
    {running ? <div className="notice">{state?.status === 'queued' ? 'Queued behind the current recording…' : progress?.state === 'copying' ? 'Preparing a private processing copy…' : `Track ${progress?.track_number ?? 1} of ${progress?.track_count ?? '?'} · ${Math.floor(progress?.processed_seconds ?? 0)} seconds processed${progress?.estimated_seconds ? ` / approximately ${Math.ceil(progress.estimated_seconds)}` : ''} · ${progress?.segments ?? 0} segments`}<span> You can keep reviewing while this runs.</span></div> : null}
    {state?.status === 'failed' || state?.status === 'interrupted' || error ? <div className="notice error">{error || state?.error}</div> : null}
    {expanded ? <div className="run-status">Unreviewed machine transcription · timestamps are audio-track-relative; seek positions account for track offsets · tracks are not speaker identities.{!state?.record || running ? <button className="quiet" onClick={() => run(async () => { await api(running ? 'cancel_transcription' : 'transcribe_full', { source_id: sourceId }); setVersion(value => value + 1); await refresh(); })}>{running ? 'Cancel transcription' : 'Transcribe recording'}</button> : null}</div> : null}
    {expanded && !running && state?.record ? <div className="input-row">
      <label className="small">Next transcription model
        <select value={model} onChange={event => setModel(event.target.value)}>
          <option value="tiny">Tiny · faster local processing</option>
          <option value="small">Small · higher-capacity local model</option>
        </select>
      </label>
      <button className="quiet" onClick={() => run(async () => { await api('set_asr_profile', { model }); await api('transcribe_full', { source_id: sourceId }); setVersion(value => value + 1); await refresh(); })}>Transcribe a new version</button>
    </div> : null}
    {state?.record && expanded && state.result.metadata?.container_origin_seconds === undefined ? <p className="small muted">This older transcript has no playback clock mapping. Retranscribe to enable accurate seek links.</p> : null}
    {state?.record && expanded ? <div className="full-transcript-text" ref={transcriptRef}>
      {(matches ?? lines.map((line, index) => ({ line, index, hit: false }))).map(({ line, index, hit }) => {
        const interval = transcriptPlaybackLine(line, state.result.metadata);
        const active = interval ? currentTime >= interval.start && currentTime < interval.end : false;
        if (filter && !hit && interval) return null;
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
    </div> : expanded && !running && !state?.record ? <p className="small muted">No full transcript is available. Transcribe this recording using the control above.</p> : null}
    {expanded ? <SpeakerTurns key={sourceId} sourceId={sourceId} onSeek={onSeek} defaultTrack={state?.result.metadata?.tracks?.[0]?.index} /> : null}
  </section>;
}
