import { useState } from 'react';
import { api, native } from '../bridge';
import type { Snapshot } from '../types';
type Candidate = { source_relative_seconds: number; label: string; clipping_fraction: number; onset_resolution_seconds: number; alternatives: string[] };
type Scan = { extraction_locator: string; limitations: string[]; metadata: { requested_interval: number[]; channel: number; track_index: number; decoded_seconds: number; gap_seconds: number; candidates: Candidate[]; waveform: { start_seconds: number; peak: number; fully_decoded: boolean }[] } };

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
    try { const result = await api<Scan>('scan_sound_events', { source_id: source, start, end, track: track === '' ? null : Number(track), channel }); setScan({ source, result }); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const path = data?.waveform.map((bin, i, all) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, all.length - 1)) * 800},${90 - Math.min(1, bin.peak) * 80}`).join(' ');
  return <details className="clock-lab"><summary>Sound discovery · selected channel</summary>
    <p className="small muted">Local transient discovery produces leads for original playback. It does not classify knocks or establish an impact count. Scan up to 60 seconds at a time; other channels and intervals remain unprocessed.</p>
    <label>Recording<select value={source} disabled={busy} onChange={e => setSource(e.target.value)}><option value="">Select a recording</option>{snapshot.sources.filter(s => !s.restricted && ['audio', 'video'].includes(s.kind)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <div className="form-grid"><label>Start (source seconds)<input type="number" min="0" step="0.01" value={start} disabled={busy} onChange={e => setStart(Number(e.target.value))}/></label><label>End (source seconds)<input type="number" min="0" step="0.01" value={end} disabled={busy} onChange={e => setEnd(Number(e.target.value))}/></label><label>Stream index (blank = first audio)<input type="number" min="0" value={track} disabled={busy} onChange={e => setTrack(e.target.value)}/></label><label>Channel index<input type="number" min="0" step="1" value={channel} disabled={busy} onChange={e => setChannel(Number(e.target.value))}/></label></div>
    <button className="secondary" disabled={busy || !source || !native || start < 0 || end <= start || end - start > 60} onClick={() => void run()}>{busy ? 'Decoding selected interval…' : 'Discover sound candidates'}</button>
    {error ? <p role="alert">{error}</p> : null}
    {scan && data ? <div><p><strong>{data.candidates.length} unclassified transient candidates</strong> · stream {data.track_index}, channel {data.channel} · {data.decoded_seconds.toFixed(3)} s decoded / {data.gap_seconds.toFixed(3)} s gaps</p><svg viewBox="0 0 800 110" role="img" aria-label="Peak amplitude waveform; red marks indicate decoder gaps" style={{ width: '100%' }}><line x1="0" y1="90" x2="800" y2="90" stroke="#555"/><path d={path} stroke="#77bea8" fill="none"/>{data.waveform.map((bin, i, all) => !bin.fully_decoded ? <line key={i} x1={i / all.length * 800} x2={i / all.length * 800} y1="10" y2="90" stroke="#c97171"/> : null)}</svg><p className="small muted">{data.requested_interval.join(' – ')} source-relative seconds. Peak amplitudes are display measurements, not calibrated event probabilities.</p><table><thead><tr><th>Source seconds</th><th>Candidate</th><th>Clipping</th></tr></thead><tbody>{data.candidates.slice(0, shown).map((c, i) => <tr key={i}><td>{c.source_relative_seconds.toFixed(3)}</td><td>{c.label}</td><td>{c.clipping_fraction > 0 ? 'Present' : 'Not detected'}</td></tr>)}</tbody></table>{shown < data.candidates.length ? <button className="secondary" onClick={() => setShown(n => n + 50)}>Show next 50</button> : null}{scan.result.limitations.map(l => <p className="small muted" key={l}>{l}</p>)}<p className="small muted">Immutable receipt: {scan.result.extraction_locator}</p><button className="secondary" onClick={() => onSource(scan.source)}>Open original recording</button></div> : null}
  </details>;
}
