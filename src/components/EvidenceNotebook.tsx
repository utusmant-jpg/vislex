import { useEffect, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { api, native } from '../bridge';
import type { Snapshot } from '../types';
import { CitationChip, StatusPill } from '../ui';
import { usePagedSources } from '../usePagedSources';
import SoundDiscovery from './SoundDiscovery';

type EvidenceObject = { id: string; revision: number; kind: string; title: string; content: string; source_ids: string[]; locators: string[]; review: string; stale: boolean; actor: string; start_seconds: number | null; end_seconds: number | null; dependencies?: { id: string; revision: number }[] };
type Page = { objects: EvidenceObject[]; next_offset: number | null };
type Fit = { status: string; scale: number; offset_seconds: number; uncertainty_seconds: number; drift_estimated: boolean; held_out_checks_passed: boolean; valid_source_range: number[]; residuals: { residual_seconds: number; held_out: boolean; within_tolerance: boolean }[]; limitations: string[] };
const kinds = ['track', 'observation', 'statement', 'hypothesis', 'claim', 'event', 'entity', 'clock', 'issue', 'authority', 'note', 'issue_matrix', 'discovery', 'contract_review', 'deposition', 'draft', 'exhibit_list'];

export default function EvidenceNotebook({ snapshot, onClose, onSource }: { snapshot: Snapshot; onClose: () => void; onSource: (id: string, locator?: string) => void }) {
  const sourcePages=usePagedSources(snapshot);
  const [page, setPage] = useState<Page>({ objects: [], next_offset: null });
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<EvidenceObject | null>(null);
  const [dependencyPreviews, setDependencyPreviews] = useState<EvidenceObject[]>([]);
  const [source, setSource] = useState('');
  const [anchorsText, setAnchorsText] = useState('');
  const [fit, setFit] = useState<Fit | null>(null);
  const [fitAnchors, setFitAnchors] = useState<unknown[]>([]);
  useEffect(() => {
    let active = true;
    if (!native) { setError(''); return; }
    setError('');
    api<Page>('evidence_list', { kind: kind || null, offset }).then(v => { if (active) setPage(v); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [snapshot.id, offset, kind, refresh]);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  function create() { setDependencyPreviews([]); setEditing({ id: '', revision: 0, kind: 'observation', title: '', content: '', source_ids: [], locators: [], dependencies: [], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null }); }
  function change(partial: Partial<EvidenceObject>) { setEditing(o => o ? { ...o, ...partial } : o); }
  async function saveObject() {
    if (!editing) return;
    await api('evidence_write', { object: { ...editing, id: editing.id || null, base_revision: editing.revision, dependencies: editing.dependencies ?? [] } });
    setEditing(null); setRefresh(v => v + 1);
  }
  async function calculate() {
    const anchors = anchorsText.trim().split('\n').filter(Boolean).map((line, index) => {
      const values = line.trim().split(/[\s,]+/);
      if (values.length !== 4 || values.some(v => !Number.isFinite(Number(v))) || !['0', '1'].includes(values[3])) throw new Error(`Anchor ${index + 1}: enter source seconds, incident seconds, uncertainty seconds, and 0 (fit) or 1 (held out).`);
      return { source_seconds: Number(values[0]), incident_seconds: Number(values[1]), uncertainty_seconds: Number(values[2]), held_out: values[3] === '1' };
    });
    const result = await api<Fit>('fit_clock', { anchors }); setFit(result); setFitAnchors(anchors);
  }
  return <section className="workspace-view evidence-notebook" aria-label="Findings and clock proposals">
    <div className="workspace-header"><div><div className="eyebrow">FINDINGS</div><h2>Findings &amp; clock proposals</h2></div><div className="spacer"/><button className="secondary" onClick={onClose}>Back to chat</button></div>
    <p className="small muted">Statements, observations and hypotheses remain separate. A valid citation identifies a location; human review and factual support remain separate judgments.</p>
    {sourcePages.hasMore?<button className="quiet" disabled={sourcePages.loading} onClick={()=>void sourcePages.loadMore()}>{sourcePages.loading?'Loading…':'Load more sources'}</button>:null}
    {sourcePages.error?<p role="alert" className="small danger-text">Could not load sources: {sourcePages.error}</p>:null}
    {!native ? <p className="notice notebook-preview-note">Structured evidence storage is available in the Windows desktop app. This browser shows the layout only.</p> : null}
    {error ? <p className="notice error" role="alert">{error}</p> : null}
    <div className="input-row notebook-toolbar"><label>Kind<select value={kind} onChange={e => { setKind(e.target.value); setOffset(0); }}><option value="">All kinds</option>{kinds.map(k => <option key={k}>{k}</option>)}</select></label><div className="spacer"/><button className="secondary" disabled={busy || !native} onClick={create}>New object</button><button className="quiet" disabled={busy || !native} onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    {editing ? <form className="object-editor" onSubmit={e => { e.preventDefault(); void action(saveObject); }}>
      <h3>{editing.id ? `Revise object · revision ${editing.revision}` : 'New evidence object'}</h3>
      <div className="form-grid"><label>Kind<select disabled={!!editing.id} value={editing.kind} onChange={e => change({ kind: e.target.value })}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label><label>Title<input required maxLength={300} value={editing.title} onChange={e => change({ title: e.target.value })}/></label></div>
      <label>Content, uncertainty and competing evidence<textarea required rows={6} value={editing.content} onChange={e => change({ content: e.target.value })}/></label>
      {!editing.id ? <label>Source dependency<select value={editing.source_ids[0] ?? ''} onChange={e => change({ source_ids: e.target.value ? [e.target.value] : [] })}><option value="">No source (working note)</option>{sourcePages.sources.filter(s => !s.restricted).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : <p className="small muted">Existing source and object dependencies are retained. Review starts unreviewed on this new revision.</p>}
      {editing.dependencies?.length ? <div><p className="small muted">Dependencies: {editing.dependencies.map(d => `${d.id} @ r${d.revision}`).join(', ')}</p><button type="button" className="secondary" disabled={busy} onClick={() => void action(async () => {
        const latest = await Promise.all(editing.dependencies!.map(d => api<EvidenceObject>('evidence_read', { id: d.id })));
        setDependencyPreviews(latest);
        setEditing(o => o ? { ...o, dependencies: latest.map(d => ({ id: d.id, revision: d.revision })), source_ids: [...new Set([...o.source_ids, ...latest.flatMap(d => d.source_ids)])] } : o);
      })}>Load latest dependencies for rechecking</button><p className="small muted">Recheck the content below and revise the finding before saving. Updating references does not establish support.</p>{dependencyPreviews.map(d => <details key={d.id}><summary>{d.title} · r{d.revision} · {d.stale ? 'stale' : d.review}</summary><pre>{d.content}</pre></details>)}</div> : null}
      <label>Exact source citations (one per line)<textarea rows={2} value={editing.locators.join('\n')} onChange={e => change({ locators: e.target.value.split('\n').filter(Boolean) })} placeholder="evidence:SOURCE-ID#L1-L3"/></label>
      <div className="input-row"><button type="submit" className="primary" disabled={busy}>Save revision</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Close editor</button></div>
    </form> : null}
    <div className="object-list">{page.objects.map(o => <details key={`${o.id}:${o.revision}`} className="object-card"><summary><strong>{o.title}</strong><span className="badge">{o.kind}</span><span className="mono small muted">r{o.revision}</span>{o.stale ? <StatusPill state="stale" label="Recheck dependencies" small /> : o.review === 'accepted' ? <StatusPill state="accepted" label="Accepted" small /> : o.review === 'rejected' ? <StatusPill state="failed" label="Rejected" small /> : <StatusPill state="unreviewed" label="Unreviewed" small />}</summary><p className="small muted">{o.actor} · {o.id}</p><pre>{o.content}</pre>{o.locators.length ? <div className="input-row">{o.locators.map((citation, i) => <CitationChip key={i} value={citation} onOpen={(id, locator) => { onSource(id, locator); onClose(); }} />)}</div> : null}<div className="input-row"><button className="secondary" disabled={busy} onClick={() => { setDependencyPreviews([]); setEditing(o); }}>Revise</button>{['accepted', 'rejected', 'unreviewed'].map(review => <button key={review} className="quiet" disabled={busy || o.stale || o.review === review} onClick={() => void action(async () => { await api('evidence_review', { id: o.id, revision: o.revision, review }); setRefresh(v => v + 1); })}>{review === 'accepted' ? 'Accept revision' : review === 'rejected' ? 'Reject revision' : 'Clear review'}</button>)}</div></details>)}</div>
    {!page.objects.length ? <div className="empty-state notebook-empty"><NotebookPen size={28}/><h3>No findings on this page</h3><p>Create a structured object or ask VisLex to save an observation. New revisions remain unreviewed until you decide.</p></div> : null}
    {(offset > 0 || page.next_offset !== null || page.objects.length > 0) ? <div className="input-row notebook-pagination"><button className="secondary" disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 50))}>Previous</button><span>Page {Math.floor(offset / 50) + 1}</span><button className="secondary" disabled={page.next_offset === null} onClick={() => setOffset(page.next_offset ?? 0)}>Next</button></div> : null}
    <SoundDiscovery snapshot={{...snapshot,sources:sourcePages.sources}} onSource={id => { onSource(id); onClose(); }}/>
    <details className="clock-lab"><summary>Clock fit lab · manual anchors</summary><p className="small muted">This creates a mapping proposal. Accepted proposals with independent held-out checks can drive incident replay. Supply independently checked anchors. File timestamps are not automatically capture times. No extrapolation; resets require separate fits.</p>
      <label>Recording<select value={source} onChange={e => setSource(e.target.value)}><option value="">Select recording</option>{sourcePages.sources.filter(s => !s.restricted && ['video', 'audio'].includes(s.kind)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>One anchor per line: container-relative playback seconds, incident seconds, uncertainty seconds, held out (0/1)<textarea rows={5} value={anchorsText} onChange={e => { setAnchorsText(e.target.value); setFit(null); }} placeholder={'0, 100, 0.05, 0\n30, 130, 0.05, 0\n60, 160, 0.05, 0\n45, 145, 0.05, 1'}/></label>
      <button className="secondary" disabled={busy || !anchorsText.trim() || !native} onClick={() => void action(calculate)}>Calculate fit</button>
      {fit ? <div><p><strong>{fit.status.replaceAll('_', ' ')}</strong> · {fit.drift_estimated ? 'drift estimated' : 'offset only'}</p><p>Incident seconds = {fit.scale.toPrecision(10)} × source seconds + {fit.offset_seconds.toFixed(6)}. Diagnostic uncertainty: ±{fit.uncertainty_seconds.toFixed(6)} s. Valid source range: {fit.valid_source_range.join(' – ')} s.</p><table><thead><tr><th>Anchor</th><th>Use</th><th>Residual (s)</th><th>Check</th></tr></thead><tbody>{fit.residuals.map((r, i) => <tr key={i}><td>{i + 1}</td><td>{r.held_out ? 'Held out' : 'Fit'}</td><td>{r.residual_seconds.toFixed(6)}</td><td>{r.within_tolerance ? 'Within tolerance' : 'Failed'}</td></tr>)}</tbody></table>{fit.limitations.map(l => <p className="small muted" key={l}>{l}</p>)}<button className="secondary" disabled={busy || !source} onClick={() => void action(async () => { await api('evidence_write', { object: { id: null, base_revision: 0, kind: 'clock', title: `Clock proposal · ${sourcePages.sources.find(s => s.id === source)?.name}`, content: JSON.stringify({ clock_domain: "container_relative", anchors: fitAnchors, fit }, null, 2), source_ids: [source], locators: [], dependencies: [], start_seconds: null, end_seconds: null } }); setRefresh(v => v + 1); })}>Save unreviewed proposal</button></div> : null}
    </details>
  </section>;
}
