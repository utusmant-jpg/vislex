import { useEffect, useMemo, useState } from 'react';
import { UserRound } from 'lucide-react';
import { api } from '../bridge';
import { Tooltip } from '../ui';

type Turn = { start: number; end: number; speaker: string };
type Annotations = { revision: number; labels: Record<string, string>; turns: Record<string, string[]> };
type Result = { metadata: { turns: Turn[]; track_index: number; origin_seconds: number; container_origin_seconds: number; gap_seconds: number }; extraction_locator: string; limitations: string[] };

export default function SpeakerTurns({ caseId, sessionEpoch, sourceId, onSeek, defaultTrack }: { caseId?: string; sessionEpoch?: number; sourceId: string; defaultTrack?: number; onSeek: (seconds: number) => void }) {
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(60);
  const [track, setTrack] = useState(0);
  const [offset, setOffset] = useState(0);
  useEffect(() => { if (defaultTrack !== undefined) setTrack(defaultTrack); }, [defaultTrack]);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [annotations, setAnnotations] = useState<Annotations>({ revision: 0, labels: {}, turns: {} });
  const [filter, setFilter] = useState('');
  const [saved, setSaved] = useState('');
  const [annotationsReady, setAnnotationsReady] = useState(false);
  const artifact = result?.extraction_locator.split('#artifact:')[1];
  useEffect(() => {
    let live = true;
    setAnnotationsReady(false); setAnnotations({ revision: 0, labels: {}, turns: {} }); setSaved('');
    if (artifact) void api<Annotations>('speaker_annotations', { source_id: sourceId, artifact_id: artifact }).then(value => { if (live) { setAnnotations(value); setAnnotationsReady(true); } }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [sourceId, artifact]);
  const speakers = useMemo(() => Array.from(new Set(result?.metadata.turns.map(turn => turn.speaker) ?? [])), [result]);
  const label = (speaker: string) => annotations.labels[speaker] ?? speaker;
  const assignments = (turn: Turn, index: number) => annotations.turns[String(index)] ?? [turn.speaker];
  const visible = result?.metadata.turns.map((turn, index) => ({ turn, index })).filter(({ turn, index }) => !filter || assignments(turn, index).includes(filter)) ?? [];
  async function save() {
    if (!artifact) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const next = await api<Annotations>('save_speaker_annotations', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId, artifact_id: artifact, ...annotations });
      setAnnotations(next);
      setSaved('Corrections saved. Identity remains unverified.');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true; setResult(null); setOffset(0); setFilter('');
    void api<{ kind: string; status: string; result: string }[]>('processing_status', { source_id: sourceId }).then(jobs => {
      const last = jobs.find(job => job.kind === 'diarization' && job.status === 'complete');
      if (active && last) setResult(JSON.parse(last.result));
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [sourceId]);
  async function analyze() {
    setBusy(true); setError('');
    try { setResult(await api<Result>('diarize_source', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId, start, end, track })); setOffset(0); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const laneRange = result ? (() => {
    const turns = result.metadata.turns;
    const from = turns.length ? turns[0].start : 0;
    const to = turns.length ? turns[turns.length - 1].end : 1;
    return { from, to: to > from ? to : from + 1 };
  })() : null;
  return <details className="speaker-turns"><summary><UserRound size={14} aria-hidden="true" />Anonymous speaker turns<span className="speaker-turns-hint">Navigation proposals · not identities</span></summary>
    <p className="small muted">Local speaker clusters are navigation proposals. Labels may split or merge voices and never establish a person's identity. Each run has its own labels.</p>
    <div className="input-row speaker-controls"><label>Audio track<input type="number" min={0} value={track} onChange={event => setTrack(Number(event.target.value))} /></label><label>Start (s)<input type="number" min={0} value={start} onChange={event => setStart(Number(event.target.value))} /></label><label>End (s)<input type="number" min={1} value={end} onChange={event => setEnd(Number(event.target.value))} /></label><button className="secondary" disabled={busy || end <= start || end - start > 600} onClick={() => void analyze()}>{busy ? 'Analyzing voices…' : 'Propose speaker turns'}</button></div>
    {error ? <p role="alert" className="danger-text">{error}</p> : null}
    {result && laneRange ? <>
      <p className="speaker-stats">{result.metadata.turns.length} proposed turns · {result.metadata.gap_seconds.toFixed(2)} seconds undecoded within requested interval</p>
      <div className="speaker-lanes" role="group" aria-label={`Speaker lanes from ${laneRange.from.toFixed(1)} to ${laneRange.to.toFixed(1)} seconds`}>
        {speakers.map((speaker, laneIndex) => <div className="speaker-lane" key={speaker}>
          <span className="speaker-lane-label" title={label(speaker)}>{label(speaker)}</span>
          <div className="speaker-lane-track" data-lane={laneIndex % 6}>
            {result.metadata.turns.map((turn, index) => (assignments(turn, index).includes(speaker)
              ? <Tooltip key={index} text={`${label(speaker)} · ${turn.start.toFixed(2)}–${turn.end.toFixed(2)} s`}>
                  <button
                    className="speaker-segment"
                    style={{ left: `${((turn.start - laneRange.from) / (laneRange.to - laneRange.from)) * 100}%`, width: `${Math.max(0.5, ((turn.end - turn.start) / (laneRange.to - laneRange.from)) * 100)}%` }}
                    aria-label={`${label(speaker)} from ${turn.start.toFixed(2)} to ${turn.end.toFixed(2)} seconds`}
                    onClick={() => { const position = turn.start + result.metadata.origin_seconds - result.metadata.container_origin_seconds; if (position >= 0) onSeek(position); }} />
                </Tooltip>
              : null))}
          </div>
        </div>)}
      </div>
      <div className="input-row"><label>Filter speaker<select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}><option value="">All turns</option>{speakers.map(speaker => <option key={speaker} value={speaker}>{label(speaker)}</option>)}</select></label></div>
      {visible.slice(offset, offset + 100).map(({ turn, index }) => {
        const position = turn.start + result.metadata.origin_seconds - result.metadata.container_origin_seconds;
        const assigned = assignments(turn, index);
        return <div className="turn-row" key={index}>
          <button className="transcript-line caption-row" disabled={position < 0} onClick={() => onSeek(position)}>
            <span className="caption-time mono">{turn.start.toFixed(2)}–{turn.end.toFixed(2)}</span>
            <span className="caption-text">{assigned.length ? assigned.map(speaker => label(speaker)).join(' + ') : 'Unknown speaker'} · track {result.metadata.track_index} · unreviewed</span>
          </button>
          <details className="turn-assign"><summary>Correct</summary>
            <p className="small muted">Select multiple voices for overlap, or clear all for unknown. Original machine turn and transcript stay unchanged.</p>
            {speakers.map(speaker => <label key={speaker}><input type="checkbox" disabled={!annotationsReady} checked={assigned.includes(speaker)} onChange={event => { const next = event.target.checked ? [...assigned, speaker] : assigned.filter(value => value !== speaker); setAnnotations(current => ({ ...current, turns: { ...current.turns, [String(index)]: next } })); setSaved(''); }} />{label(speaker)}</label>)}
          </details>
        </div>;
      })}
      <details className="turn-labels"><summary>Edit display labels</summary>{speakers.map(speaker => <label key={speaker}>{speaker}<input disabled={!annotationsReady} maxLength={120} value={annotations.labels[speaker] ?? speaker} onChange={event => { const text = event.target.value; setAnnotations(current => ({ ...current, labels: { ...current.labels, [speaker]: text } })); setSaved(''); }} /></label>)}<p className="small muted">A display label does not authenticate a person's identity and does not carry to another run.</p></details>
      <div className="input-row"><button className="secondary" disabled={busy || !annotationsReady} onClick={() => void save()}>Save corrections</button>{saved ? <p role="status" className="small success-text">{saved}</p> : null}</div>
      <div className="input-row"><button className="quiet" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous turns</button><button className="quiet" disabled={offset + 100 >= visible.length} onClick={() => setOffset(value => value + 100)}>Next turns</button></div>
      <code className="small muted">{result.extraction_locator}</code>
      {result.limitations.map(limitation => <p className="small muted" key={limitation}>{limitation}</p>)}
    </> : null}
  </details>;
}
