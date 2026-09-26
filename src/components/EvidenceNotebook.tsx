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
type Comparison = { title: string; category: string; first: string; second: string; firstSource: string; secondSource: string; firstCitation: string; secondCitation: string; nextCheck: string };
const emptyComparison = (): Comparison => ({ title: '', category: 'inconsistency', first: '', second: '', firstSource: '', secondSource: '', firstCitation: '', secondCitation: '', nextCheck: '' });
const comparisonCategories: Record<string, string> = { inconsistency: 'Inconsistency', omission: 'Omission', changed_account: 'Changed account', uncertain_clock: 'Uncertain clock', extraction_error: 'Extraction error' };
const productFields: Record<string, string[]> = { issue_matrix: ['question', 'factual_position', 'missing_evidence'], discovery: ['request', 'production', 'status', 'due_date'], exhibit_list: ['label', 'description'], draft: ['paragraph', 'text'] };
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
type Product = { kind: string; title: string; jurisdiction: string; relevantDate: string; source: string; citation: string; finding: string; fields: Record<string, string> };
const emptyProduct = (): Product => ({ kind: 'issue_matrix', title: '', jurisdiction: '', relevantDate: '', source: '', citation: '', finding: '', fields: {} });
function structuredContent(object: EvidenceObject) {
  try {
    const value = JSON.parse(object.content) as Record<string, unknown>;
    if (value.schema === 'witness_comparison_v1') {
      return <div className="structured-finding"><p><strong>{comparisonCategories[String(value.category)] ?? 'Unclassified'}</strong></p><p><strong>First account:</strong> {String(value.first ?? '')}</p><p><strong>Second account:</strong> {String(value.second ?? '')}</p><p><strong>Next check:</strong> {String(value.next_check ?? '')}</p><p className="small muted">Comparison only. The accounts and citations require assessment; this is not a credibility finding.</p><details><summary>Raw provenance</summary><pre>{object.content}</pre></details></div>;
    }
    if (typeof value.workflow === 'string' && Array.isArray(value.rows)) {
      return <div className="structured-finding"><p><strong>{value.workflow.replaceAll('_', ' ')}</strong> · {String(value.jurisdiction || 'Jurisdiction unspecified')} · {String(value.relevant_date || 'Date unspecified')}</p>{value.rows.map((row, i) => <dl key={i}>{Object.entries(row as Record<string, unknown>).filter(([key]) => !['citations', 'authority_ids'].includes(key)).map(([key, content]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{String(content)}</dd></div>)}</dl>)}<p className="small muted">Authority treatment: {Array.isArray(value.authority_limits) && value.authority_limits.length ? 'Independent checking required' : 'No checked authority recorded'}.</p><details><summary>Raw provenance</summary><pre>{object.content}</pre></details></div>;
    }
  } catch { /* Ordinary prose evidence is displayed as prose. */ }
  return <pre>{object.content}</pre>;
}

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
  const [comparison, setComparison] = useState<Comparison>(emptyComparison);
  const [product, setProduct] = useState<Product>(emptyProduct);
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
  async function saveComparison() {
    const a = comparison.firstCitation.trim(), b = comparison.secondCitation.trim();
    if (!comparison.firstSource || !comparison.secondSource || !a || !b || !comparison.first.trim() || !comparison.second.trim() || !comparison.nextCheck.trim()) throw new Error('Enter both accounts, their sources and exact citations, and a next check.');
    if (comparison.firstSource === comparison.secondSource) throw new Error('Select two distinct source records for the account comparison.');
    await api('evidence_write', { object: { id: null, base_revision: 0, kind: 'issue', title: comparison.title.trim() || 'Account comparison', content: JSON.stringify({ schema: 'witness_comparison_v1', category: comparison.category, first: comparison.first.trim(), second: comparison.second.trim(), next_check: comparison.nextCheck.trim() }), source_ids: [comparison.firstSource, comparison.secondSource], locators: [a, b], dependencies: [], start_seconds: null, end_seconds: null } });
    setComparison(emptyComparison()); setRefresh(v => v + 1);
  }
  async function saveProduct() {
    const linked = page.objects.find(o => `${o.id}:${o.revision}` === product.finding && o.review === 'accepted' && !o.stale);
    if (product.finding && !linked) throw new Error('The selected finding is no longer accepted on this page. Refresh and recheck it.');
    const citation = product.citation.trim();
    if (!product.title.trim() || !product.source || !citation) throw new Error('Enter a title, source and exact citation.');
    if (linked && !linked.source_ids.includes(product.source)) throw new Error('The source must be part of the accepted finding.');
    const fields = productFields[product.kind];
    if (!fields || fields.some(field => !product.fields[field]?.trim())) throw new Error('Complete every work-product field. Use “unknown” where the record does not establish a fact.');
    if (['issue_matrix', 'draft'].includes(product.kind) && (!product.jurisdiction.trim() || !validDate(product.relevantDate))) throw new Error('Enter a jurisdiction and valid relevant date (YYYY-MM-DD).');
    const row = Object.fromEntries(fields.map(field => [field, product.fields[field].trim()]));
    const sources = [...new Set([product.source, ...(linked?.source_ids ?? [])])];
    await api('evidence_write', { object: { id: null, base_revision: 0, kind: product.kind, title: product.title.trim(), content: JSON.stringify({ workflow: product.kind, jurisdiction: product.jurisdiction.trim(), relevant_date: product.relevantDate, rows: [{ ...row, citations: [citation], authority_ids: [] }], authority_limits: [], review: 'Unreviewed working product; authority treatment has not been checked', exposure_sources: sources }), source_ids: sources, locators: [citation], dependencies: linked ? [{ id: linked.id, revision: linked.revision }] : [], start_seconds: null, end_seconds: null } });
    setProduct(emptyProduct()); setRefresh(v => v + 1);
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
    <details className="object-editor"><summary>Compare two accounts</summary><form onSubmit={e => { e.preventDefault(); void action(saveComparison); }}><p className="small muted">Record what differs and what would resolve it. Exact source citations are checked when saved.</p><label>Comparison title<input maxLength={300} value={comparison.title} onChange={e => setComparison(v => ({ ...v, title: e.target.value }))}/></label><label>Type<select value={comparison.category} onChange={e => setComparison(v => ({ ...v, category: e.target.value }))}>{Object.entries(comparisonCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{([1, 2] as const).map(index => { const first = index === 1; const sourceKey = first ? 'firstSource' : 'secondSource'; const textKey = first ? 'first' : 'second'; const citationKey = first ? 'firstCitation' : 'secondCitation'; const selected = comparison[sourceKey]; const locator = comparison[citationKey].trim().startsWith(`evidence:${selected}#`) ? comparison[citationKey].trim().split('#', 2)[1] : undefined; return <fieldset key={index}><legend>{first ? 'First account' : 'Second account'}</legend><label>Source<select value={selected} onChange={e => setComparison(v => ({ ...v, [sourceKey]: e.target.value }))}><option value="">Select source</option>{sourcePages.sources.filter(s => !s.restricted).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>What this account says<textarea value={comparison[textKey]} onChange={e => setComparison(v => ({ ...v, [textKey]: e.target.value }))}/></label><label>Exact citation<input value={comparison[citationKey]} onChange={e => setComparison(v => ({ ...v, [citationKey]: e.target.value }))} placeholder="evidence:SOURCE-ID#R1L1-L3"/></label>{selected ? <button type="button" className="quiet" onClick={() => onSource(selected, locator)}>Open {first ? 'first' : 'second'} source</button> : null}</fieldset>; })}<label>Next check<textarea value={comparison.nextCheck} onChange={e => setComparison(v => ({ ...v, nextCheck: e.target.value }))}/></label><button type="submit" className="primary" disabled={busy || !native}>Save unreviewed comparison</button></form></details>
    <details className="object-editor"><summary>Prepare an issue, production gap, exhibit or draft</summary><form onSubmit={e => { e.preventDefault(); void action(saveProduct); }}><p className="small muted">This creates an unreviewed, versioned work product. The source citation is checked on save; legal authority treatment remains unchecked.</p><label>Work product type<select value={product.kind} onChange={e => setProduct(v => ({ ...v, kind: e.target.value, fields: {} }))}>{Object.keys(productFields).map(name => <option key={name} value={name}>{name.replaceAll('_', ' ')}</option>)}</select></label><label>Title<input value={product.title} maxLength={300} onChange={e => setProduct(v => ({ ...v, title: e.target.value }))}/></label>{['issue_matrix', 'draft'].includes(product.kind) ? <div className="form-grid"><label>Jurisdiction<input value={product.jurisdiction} onChange={e => setProduct(v => ({ ...v, jurisdiction: e.target.value }))}/></label><label>Relevant date<input type="date" value={product.relevantDate} onChange={e => setProduct(v => ({ ...v, relevantDate: e.target.value }))}/></label></div> : null}{productFields[product.kind].map(field => <label key={field}>{field.replaceAll('_', ' ')}<textarea value={product.fields[field] ?? ''} onChange={e => setProduct(v => ({ ...v, fields: { ...v.fields, [field]: e.target.value } }))}/></label>)}<label>Source<select value={product.source} onChange={e => setProduct(v => ({ ...v, source: e.target.value }))}><option value="">Select source</option>{sourcePages.sources.filter(s => !s.restricted).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Exact citation<input value={product.citation} onChange={e => setProduct(v => ({ ...v, citation: e.target.value }))} placeholder="evidence:SOURCE-ID#R1L1-L3"/></label><label>Accepted finding on this page (optional)<select value={product.finding} onChange={e => setProduct(v => ({ ...v, finding: e.target.value }))}><option value="">No linked finding</option>{page.objects.filter(o => o.review === 'accepted' && !o.stale).map(o => <option key={o.id} value={`${o.id}:${o.revision}`}>{o.title} · r{o.revision}</option>)}</select></label><button type="submit" className="primary" disabled={busy || !native}>Save unreviewed work product</button></form></details>
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
    <div className="object-list">{page.objects.map(o => <details key={`${o.id}:${o.revision}`} className="object-card"><summary><strong>{o.title}</strong><span className="badge">{o.kind}</span><span className="mono small muted">r{o.revision}</span>{o.stale ? <StatusPill state="stale" label="Recheck dependencies" small /> : o.review === 'accepted' ? <StatusPill state="accepted" label="Accepted" small /> : o.review === 'rejected' ? <StatusPill state="failed" label="Rejected" small /> : <StatusPill state="unreviewed" label="Unreviewed" small />}</summary><p className="small muted">{o.actor} · {o.id}</p>{structuredContent(o)}{o.locators.length ? <div className="input-row">{o.locators.map((citation, i) => <CitationChip key={i} value={citation} onOpen={(id, locator) => { onSource(id, locator); onClose(); }} />)}</div> : null}<div className="input-row"><button className="secondary" disabled={busy} onClick={() => { setDependencyPreviews([]); setEditing(o); }}>Revise</button>{['accepted', 'rejected', 'unreviewed'].map(review => <button key={review} className="quiet" disabled={busy || o.stale || o.review === review} onClick={() => void action(async () => { await api('evidence_review', { id: o.id, revision: o.revision, review }); setRefresh(v => v + 1); })}>{review === 'accepted' ? 'Accept revision' : review === 'rejected' ? 'Reject revision' : 'Clear review'}</button>)}</div></details>)}</div>
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
