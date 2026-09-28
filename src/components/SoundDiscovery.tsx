import { useState } from 'react';
import { AudioWaveform, TriangleAlert } from 'lucide-react';
import { api, native } from '../bridge';
import type { Snapshot } from '../types';
import ToolPanel from './ToolPanel';
type Candidate = { source_relative_seconds: number; label: string; clipping_fraction: number; onset_resolution_seconds: number; alternatives: string[] };
type Scan = { extraction_locator: string; limitations: string[]; metadata: { requested_interval: number[]; channel: number; track_index: number; decoded_seconds: number; gap_seconds: number; candidates: Candidate[]; waveform: { start_seconds: number; peak: number; fully_decoded: boolean }[] } };

/** Plain-language reason the scan button is unavailable, or null when ready. */
export function scanBlocker(source: string, start: number, end: number): string | null {
  if (!source) return 'Select a recording.';
  if (start < 0) return 'Start must be zero or later.';
  if (end <= start) return 'End must be after start.';
  if (end - start > 60) return 'Scan at most 60 seconds at a time.';
  return null;
}

export default function SoundDiscovery({ snapshot, onSource }: { snapshot: Snapshot; onSource: (id: string) => void }) {
  const [source, setSource] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(30);
  const [track, setTrack] = useState('');
  const [channel, setChannel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scan, setScan] = useState<{ source: string; result: Scan } | null>(null);
  const [shown, setShown] = useState(50);
  const data = scan?.result.metadata;
  async function run() {
    setBusy(true); setError(''); setScan(null); setShown(50);
    try { const result = await api<Scan>('scan_sound_events', { case_id: snapshot.id, session_epoch: snapshot.session_epoch, source_id: source, start, end, track: track === '' ? null : Number(track), channel }); setScan({ source, result }); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const blocker = scanBlocker(source, start, end);
  const path = data?.waveform.map((bin, i, all) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, all.length - 1)) * 800},${90 - Math.min(1, bin.peak) * 80}`).join(' ');
  return <ToolPanel icon={<AudioWaveform size={16} />} title="Sound discovery · selected channel" description="Find transient sound candidates in up to 60 seconds of one channel." className="tool-sound">
    <p className="field-hint">Local transient discovery produces leads for original playback. It does not classify knocks or establish an impact count. Scan up to 60 seconds at a time; other channels and intervals remain unprocessed.</p>
    <label className="field-label">Recording<select value={source} disabled={busy} onChange={e => setSource(e.target.value)}><option value="">Select a recording</option>{snapshot.sources.filter(s => !s.restricted && ['audio', 'video'].includes(s.kind)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <div className="form-grid sound-grid"><label>Start (source seconds)<input type="number" min="0" step="0.01" value={start} disabled={busy} onChange={e => setStart(Number(e.target.value))}/></label><label>End (source seconds)<input type="number" min="0" step="0.01" value={end} disabled={busy} onChange={e => setEnd(Number(e.target.value))}/></label><label>Stream index (blank = first audio)<input type="number" min="0" value={track} disabled={busy} onChange={e => setTrack(e.target.value)}/></label><label>Channel index<input type="number" min="0" step="1" value={channel} disabled={busy} onChange={e => setChannel(Number(e.target.value))}/></label></div>
    <div className="tool-footer">
      <button className="secondary" disabled={busy || !native || blocker !== null} onClick={() => void run()}>{busy ? 'Decoding selected interval…' : 'Discover sound candidates'}</button>
      {busy ? <span className="status-line" role="status"><span className="activity-dot" aria-hidden="true" />Decoding {Math.max(0, end - start).toFixed(2)} s of the selected channel</span> : native && blocker && source ? <span className="field-hint">{blocker}</span> : null}
    </div>
    {error ? <p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    {scan && data ? <div className="sound-result">
      <p className="sound-summary"><strong>{data.candidates.length} unclassified transient candidates</strong> · stream {data.track_index}, channel {data.channel} · {data.decoded_seconds.toFixed(3)} s decoded / {data.gap_seconds.toFixed(3)} s gaps</p>
      <figure className="waveform">
        <svg viewBox="0 0 800 110" role="img" aria-label="Peak amplitude waveform; dashed marks indicate decoder gaps"><line className="waveform-axis" x1="0" y1="90" x2="800" y2="90"/><path className="waveform-path" d={path} fill="none"/>{data.waveform.map((bin, i, all) => !bin.fully_decoded ? <line className="waveform-gap" key={i} x1={i / all.length * 800} x2={i / all.length * 800} y1="10" y2="90"/> : null)}</svg>
        <figcaption className="field-hint">{data.requested_interval.join(' – ')} source-relative seconds. Peak amplitudes are display measurements, not calibrated event probabilities. Dashed marks show decoder gaps.</figcaption>
      </figure>
      {data.candidates.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th className="numeric">Source seconds</th><th>Candidate</th><th>Clipping</th></tr></thead><tbody>{data.candidates.slice(0, shown).map((c, i) => <tr key={i}><td className="numeric">{c.source_relative_seconds.toFixed(3)}</td><td>{c.label}</td><td>{c.clipping_fraction > 0 ? 'Present' : 'Not detected'}</td></tr>)}</tbody></table></div> : null}
      {data.candidates.length ? <p className="field-hint">Showing {Math.min(shown, data.candidates.length)} of {data.candidates.length} candidates.</p> : null}
      {shown < data.candidates.length ? <button className="secondary" data-size="sm" onClick={() => setShown(n => n + 50)}>Show next 50</button> : null}
      {scan.result.limitations.map(l => <p className="field-hint" key={l}>{l}</p>)}
      <p className="field-hint">Immutable receipt: <span className="mono">{scan.result.extraction_locator}</span></p>
      <div className="tool-footer"><button className="secondary evidence-link" onClick={() => onSource(scan.source)}>Open original recording</button></div>
    </div> : null}
  </ToolPanel>;
}
