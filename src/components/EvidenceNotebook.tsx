import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Clock3, FilePlus2, GitCompareArrows, Info, NotebookPen, Plus, RefreshCw, RotateCcw, Scale, TriangleAlert, X } from 'lucide-react';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import type { Snapshot } from '../types';
import { CitationChip, Skeleton, StatusPill } from '../ui';
import { usePagedSources } from '../usePagedSources';
import SoundDiscovery from './SoundDiscovery';
import ToolPanel from './ToolPanel';

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
/** Snake-case identifiers as sentence-case labels ("issue_matrix" → "Issue matrix"). */
const humanize = (value: string) => { const text = value.replaceAll('_', ' '); return text.charAt(0).toUpperCase() + text.slice(1); };

/** Review state as an icon + label pill; stale always wins because review is
 *  disabled until dependencies are rechecked in a new revision. */
export function reviewPill(object: Pick<EvidenceObject, 'review' | 'stale'>) {
  if (object.stale) return <StatusPill state="stale" label="Recheck dependencies" small />;
  if (object.review === 'accepted') return <StatusPill state="accepted" label="Accepted" small />;
  if (object.review === 'rejected') return <StatusPill state="failed" label="Rejected" small />;
  return <StatusPill state="unreviewed" label="Unreviewed" small />;
}

function structuredContent(object: EvidenceObject) {
  try {
    const value = JSON.parse(object.content) as Record<string, unknown>;
    if (value.schema === 'witness_comparison_v1') {
      return <div className="structured-finding">
        <p className="structured-finding-kind"><span className="badge">{comparisonCategories[String(value.category)] ?? 'Unclassified'}</span></p>
        <dl className="finding-accounts">
          <div><dt>First account</dt><dd>{String(value.first ?? '')}</dd></div>
          <div><dt>Second account</dt><dd>{String(value.second ?? '')}</dd></div>
          <div><dt>Next check</dt><dd>{String(value.next_check ?? '')}</dd></div>
        </dl>
        <p className="finding-limit">Comparison only. The accounts and citations require assessment; this is not a credibility finding.</p>
        <details className="finding-raw"><summary>Raw provenance</summary><pre>{object.content}</pre></details>
      </div>;
    }
    if (typeof value.workflow === 'string' && Array.isArray(value.rows)) {
      return <div className="structured-finding">
        <p className="structured-finding-kind"><strong>{humanize(value.workflow)}</strong> · {String(value.jurisdiction || 'Jurisdiction unspecified')} · {String(value.relevant_date || 'Date unspecified')}</p>
        {value.rows.map((row, i) => <dl key={i} className="finding-accounts">{Object.entries(row as Record<string, unknown>).filter(([key]) => !['citations', 'authority_ids'].includes(key)).map(([key, content]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(content)}</dd></div>)}</dl>)}
        <p className="finding-limit">Authority treatment: {Array.isArray(value.authority_limits) && value.authority_limits.length ? 'Independent checking required' : 'No checked authority recorded'}.</p>
        <details className="finding-raw"><summary>Raw provenance</summary><pre>{object.content}</pre></details>
      </div>;
    }
  } catch { /* Ordinary prose evidence is displayed as prose. */ }
  return <pre className="finding-prose">{object.content}</pre>;
}

export default function EvidenceNotebook({ snapshot, onClose, onSource }: { snapshot: Snapshot; onClose: () => void; onSource: (id: string, locator?: string) => void }) {
  const sourcePages=usePagedSources(snapshot);
  const [page, setPage] = useState<Page>({ objects: [], next_offset: null });
  // `loaded` becomes true after the first response and stays true: refetches after a review,
  // save, Refresh or page turn keep the current list (and any open card or focused button)
  // mounted and mark it busy instead of swapping it for skeletons. The component is keyed by
  // case and session epoch, so a case switch remounts it and never shows another case's rows.
  const [loaded, setLoaded] = useState(!native);
  const [refreshing, setRefreshing] = useState(false);
  const [showRefreshing, setShowRefreshing] = useState(false);
  const [pageVersion, setPageVersion] = useState(0);
  const [restoreFocus, setRestoreFocus] = useState<{ key: string; version: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const editingKey = editing ? `${editing.id}:${editing.revision}` : null;
  useEffect(() => {
    let active = true;
    if (!native) { setError(''); return; }
    setError(''); setRefreshing(true);
    api<Page>('evidence_list', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), kind: kind || null, offset }).then(v => { if (active) { setPage(v); setPageVersion(n => n + 1); setLoaded(true); setRefreshing(false); } }).catch(e => { if (active) { setError(String(e)); setLoaded(true); setRefreshing(false); } });
    return () => { active = false; };
  }, [snapshot.id, snapshot.session_epoch, offset, kind, refresh]);
  // Review buttons are disabled while a decision is saved, which drops keyboard focus to the
  // document. Once the refreshed page lands (or the save fails), return focus to that card's
  // review group: a neutral target, so a repeated Enter cannot record a different decision.
  useEffect(() => {
    if (!restoreFocus || busy || pageVersion < restoreFocus.version) return;
    setRestoreFocus(null);
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    const card = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-object-key]') ?? [])].find(el => el.dataset.objectKey === restoreFocus.key);
    card?.querySelector<HTMLElement>('.object-card-review')?.focus();
  }, [restoreFocus, busy, pageVersion]);
  // A quiet status line appears only if a refetch takes longer than 150 ms, so fast refreshes never flash.
  useEffect(() => {
    if (!refreshing || !loaded) { setShowRefreshing(false); return; }
    const timer = window.setTimeout(() => setShowRefreshing(true), 150);
    return () => window.clearTimeout(timer);
  }, [refreshing, loaded]);
  // Opening the editor from a card far down the list brings it into view.
  useEffect(() => { if (editingKey !== null) { editorHeading.current?.focus(); editorHeading.current?.scrollIntoView?.({ block: 'nearest' }); } }, [editingKey]);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  function create() { setDependencyPreviews([]); setEditing({ id: '', revision: 0, kind: 'observation', title: '', content: '', source_ids: [], locators: [], dependencies: [], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null }); }
  function change(partial: Partial<EvidenceObject>) { setEditing(o => o ? { ...o, ...partial } : o); }
  async function saveObject() {
    if (!editing) return;
    await api('evidence_write', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), object: { ...editing, id: editing.id || null, base_revision: editing.revision, dependencies: editing.dependencies ?? [] } });
    setEditing(null); setRefresh(v => v + 1);
  }
  async function saveComparison() {
    const a = comparison.firstCitation.trim(), b = comparison.secondCitation.trim();
    if (!comparison.firstSource || !comparison.secondSource || !a || !b || !comparison.first.trim() || !comparison.second.trim() || !comparison.nextCheck.trim()) throw new Error('Enter both accounts, their sources and exact citations, and a next check.');
    if (comparison.firstSource === comparison.secondSource) throw new Error('Select two distinct source records for the account comparison.');
    await api('evidence_write', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), object: { id: null, base_revision: 0, kind: 'issue', title: comparison.title.trim() || 'Account comparison', content: JSON.stringify({ schema: 'witness_comparison_v1', category: comparison.category, first: comparison.first.trim(), second: comparison.second.trim(), next_check: comparison.nextCheck.trim() }), source_ids: [comparison.firstSource, comparison.secondSource], locators: [a, b], dependencies: [], start_seconds: null, end_seconds: null } });
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
    await api('evidence_write', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), object: { id: null, base_revision: 0, kind: product.kind, title: product.title.trim(), content: JSON.stringify({ workflow: product.kind, jurisdiction: product.jurisdiction.trim(), relevant_date: product.relevantDate, rows: [{ ...row, citations: [citation], authority_ids: [] }], authority_limits: [], review: 'Unreviewed working product; authority treatment has not been checked', exposure_sources: sources }), source_ids: sources, locators: [citation], dependencies: linked ? [{ id: linked.id, revision: linked.revision }] : [], start_seconds: null, end_seconds: null } });
    setProduct(emptyProduct()); setRefresh(v => v + 1);
  }
  async function calculate() {
    const anchors = anchorsText.trim().split('\n').filter(Boolean).map((line, index) => {
      const values = line.trim().split(/[\s,]+/);
      if (values.length !== 4 || values.some(v => !Number.isFinite(Number(v))) || !['0', '1'].includes(values[3])) throw new Error(`Anchor ${index + 1}: enter source seconds, incident seconds, uncertainty seconds, and 0 (fit) or 1 (held out).`);
      return { source_seconds: Number(values[0]), incident_seconds: Number(values[1]), uncertainty_seconds: Number(values[2]), held_out: values[3] === '1' };
    });
    const result = await api<Fit>('fit_clock', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), anchors }); setFit(result); setFitAnchors(anchors);
  }
  const permittedSources = sourcePages.sources.filter(s => !s.restricted);
  const counts = { accepted: page.objects.filter(o => !o.stale && o.review === 'accepted').length, stale: page.objects.filter(o => o.stale).length, unreviewed: page.objects.filter(o => !o.stale && !['accepted', 'rejected'].includes(o.review)).length };
  const showPagination = offset > 0 || page.next_offset !== null || page.objects.length > 0;
  return <section className="workspace-view evidence-notebook" aria-label="Findings and clock proposals">
    <header className="surface-header">
      <div className="surface-header-text">
        <div className="eyebrow">Findings</div>
        <h2>Findings &amp; clock proposals</h2>
        <p>Statements, observations and hypotheses remain separate. A valid citation identifies a location; human review and factual support remain separate judgments.</p>
      </div>
      <div className="surface-actions">
        <button className="quiet" onClick={onClose}><ArrowLeft size={15} />Back to chat</button>
        <button className="primary" disabled={busy || !native} onClick={create}><Plus size={15} />New object</button>
      </div>
    </header>
    {!native ? <p className="notice info notebook-preview-note"><Info size={16} aria-hidden="true" /><span>Structured evidence storage is available in the Windows desktop app. This browser shows the layout only.</span></p> : null}
    {error ? <p className="notice error" role="alert"><TriangleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    {sourcePages.error?<p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" /><span>Could not load sources: {sourcePages.error}</span></p>:null}

    {editing ? <form className="card object-editor" aria-labelledby="object-editor-title" onSubmit={e => { e.preventDefault(); void action(saveObject); }}>
      <div className="card-header"><h3 className="card-title" id="object-editor-title" ref={editorHeading} tabIndex={-1}>{editing.id ? `Revise object · revision ${editing.revision}` : 'New evidence object'}</h3><div className="card-actions"><button type="button" className="icon-button" aria-label="Close editor without saving" disabled={busy} onClick={() => setEditing(null)}><X size={16} /></button></div></div>
      <div className="form-grid"><label>Kind<select disabled={!!editing.id} value={editing.kind} onChange={e => change({ kind: e.target.value })}>{kinds.map(k => <option key={k} value={k}>{humanize(k)}</option>)}</select></label><label>Title<input required maxLength={300} value={editing.title} onChange={e => change({ title: e.target.value })}/></label></div>
      <label className="field-label">Content, uncertainty and competing evidence<textarea required rows={6} value={editing.content} onChange={e => change({ content: e.target.value })}/></label>
      {!editing.id ? <label className="field-label">Source dependency<select value={editing.source_ids[0] ?? ''} onChange={e => change({ source_ids: e.target.value ? [e.target.value] : [] })}><option value="">No source (working note)</option>{permittedSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label> : <p className="field-hint editor-note">Existing source and object dependencies are retained. Review starts unreviewed on this new revision.</p>}
      {editing.dependencies?.length ? <div className="editor-dependencies"><p className="field-hint">Dependencies: {editing.dependencies.map(d => `${d.id} @ r${d.revision}`).join(', ')}</p><button type="button" className="secondary" data-size="sm" disabled={busy} onClick={() => void action(async () => {
        const latest = await Promise.all(editing.dependencies!.map(d => api<EvidenceObject>('evidence_read', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), id: d.id })));
        setDependencyPreviews(latest);
        setEditing(o => o ? { ...o, dependencies: latest.map(d => ({ id: d.id, revision: d.revision })), source_ids: [...new Set([...o.source_ids, ...latest.flatMap(d => d.source_ids)])] } : o);
      })}><RefreshCw size={14} />Load latest dependencies for rechecking</button><p className="field-hint">Recheck the content below and revise the finding before saving. Updating references does not establish support.</p>{dependencyPreviews.map(d => <details key={d.id} className="finding-raw"><summary>{d.title} · r{d.revision} · {d.stale ? 'stale' : d.review}</summary><pre>{d.content}</pre></details>)}</div> : null}
      <label className="field-label">Exact source citations (one per line)<textarea rows={2} value={editing.locators.join('\n')} onChange={e => change({ locators: e.target.value.split('\n').filter(Boolean) })} placeholder="evidence:SOURCE-ID#L1-L3"/></label>
      <div className="editor-footer"><span className="field-hint">New revisions start unreviewed.</span><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Close editor</button><button type="submit" className="primary" disabled={busy}>Save revision</button></div>
    </form> : null}

    <div className="findings-toolbar">
      <label className="findings-kind">Kind<select value={kind} onChange={e => { setKind(e.target.value); setOffset(0); }}><option value="">All kinds</option>{kinds.map(k => <option key={k} value={k}>{humanize(k)}</option>)}</select></label>
      {native && loaded && page.objects.length ? <span className="findings-summary" aria-live="polite">{page.objects.length} on this page · {counts.unreviewed} unreviewed · {counts.accepted} accepted{counts.stale ? ` · ${counts.stale} need recheck` : ''}</span> : <span className="findings-summary" />}
      <span className="findings-refreshing" role="status">{showRefreshing ? 'Updating findings…' : ''}</span>
      <button className="quiet" disabled={busy || !native} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={14} />Refresh</button>
    </div>

    {native && !loaded ? <div className="object-list" aria-busy="true" aria-label="Loading findings">{[0, 1, 2].map(i => <div className="object-card skeleton-card" key={i}><Skeleton height={14} className="skeleton-title" /><Skeleton height={10} className="skeleton-short" /></div>)}</div> : null}
    {loaded && page.objects.length ? <div className="object-list" ref={listRef} aria-busy={refreshing || undefined}>{page.objects.map(o => <details key={`${o.id}:${o.revision}`} data-object-key={`${o.id}:${o.revision}`} className={`object-card ${o.stale ? 'is-stale' : ''}`}>
      <summary>
        <ChevronRight size={15} className="object-card-chevron" aria-hidden="true" />
        <span className="object-card-title" title={o.title}>{o.title}</span>
        <span className="object-card-meta"><span className="badge">{humanize(o.kind)}</span><span className="object-card-rev">r{o.revision}</span>{reviewPill(o)}</span>
      </summary>
      <div className="object-card-body">
        <p className="object-card-provenance">{o.actor} · <span className="mono">{o.id}</span></p>
        {structuredContent(o)}
        {o.locators.length ? <div className="object-card-citations"><span className="object-card-label">Citations</span>{o.locators.map((citation, i) => <CitationChip key={i} value={citation} onOpen={(id, locator) => { onSource(id, locator); onClose(); }} />)}</div> : null}
        {o.stale ? <p className="notice warning"><TriangleAlert size={16} aria-hidden="true" /><span>A dependency changed. Review is disabled until a new revision rechecks the latest dependencies.</span></p> : null}
        <div className="object-card-actions">
          <button className="secondary" data-size="sm" disabled={busy} onClick={() => { setDependencyPreviews([]); setEditing(o); }}>Revise</button>
          <span className="object-card-review" role="group" tabIndex={-1} aria-label={`Review revision ${o.revision} of ${o.title}`}>
            {['accepted', 'rejected', 'unreviewed'].map(review => <button key={review} className={`quiet review-${review}`} disabled={busy || o.stale || o.review === review} onClick={() => void action(async () => { const key = `${o.id}:${o.revision}`; setRestoreFocus({ key, version: pageVersion }); await api('evidence_review', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), id: o.id, revision: o.revision, review }); setRestoreFocus({ key, version: pageVersion + 1 }); setRefresh(v => v + 1); })}>{review === 'accepted' ? <Check size={14} /> : review === 'rejected' ? <X size={14} /> : <RotateCcw size={14} />}{review === 'accepted' ? 'Accept revision' : review === 'rejected' ? 'Reject revision' : 'Clear review'}</button>)}
          </span>
        </div>
      </div>
    </details>)}</div> : null}
    {loaded && !page.objects.length ? <div className="empty-state notebook-empty"><NotebookPen size={20}/><h3>No findings on this page</h3><p>Create a structured object or ask VisLex to save an observation. New revisions remain unreviewed until you decide.</p>{native && !kind && offset === 0 ? <button className="primary" disabled={busy} onClick={create}><Plus size={15} />New object</button> : null}</div> : null}
    {showPagination && loaded ? <nav className="notebook-pagination" aria-label="Findings pages"><button className="secondary" data-size="sm" disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 50))}>Previous</button><span>Page {Math.floor(offset / 50) + 1}</span><button className="secondary" data-size="sm" disabled={page.next_offset === null} onClick={() => setOffset(page.next_offset ?? 0)}>Next</button></nav> : null}

    <h3 className="section-title notebook-tools-title">Structured tools</h3>
    {sourcePages.hasMore?<p className="notebook-sources-more"><span className="field-hint">Source pickers list {sourcePages.sources.length} loaded sources.</span><button className="quiet" disabled={sourcePages.loading} onClick={()=>void sourcePages.loadMore()}>{sourcePages.loading?'Loading…':'Load more sources'}</button></p>:null}
    <div className="notebook-tools">
      <ToolPanel icon={<GitCompareArrows size={16} />} title="Compare two accounts" description="Record what differs between two sources and what would resolve it." className="tool-compare">
        <form onSubmit={e => { e.preventDefault(); void action(saveComparison); }}>
          <p className="field-hint">Record what differs and what would resolve it. Exact source citations are checked when saved.</p>
          <div className="form-grid"><label>Comparison title<input maxLength={300} value={comparison.title} onChange={e => setComparison(v => ({ ...v, title: e.target.value }))}/></label><label>Type<select value={comparison.category} onChange={e => setComparison(v => ({ ...v, category: e.target.value }))}>{Object.entries(comparisonCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
          <div className="account-grid">{([1, 2] as const).map(index => { const first = index === 1; const sourceKey = first ? 'firstSource' : 'secondSource'; const textKey = first ? 'first' : 'second'; const citationKey = first ? 'firstCitation' : 'secondCitation'; const selected = comparison[sourceKey]; const locator = comparison[citationKey].trim().startsWith(`evidence:${selected}#`) ? comparison[citationKey].trim().split('#', 2)[1] : undefined; return <fieldset key={index} className="account-card"><legend>{first ? 'First account' : 'Second account'}</legend><label className="field-label">Source<select value={selected} onChange={e => setComparison(v => ({ ...v, [sourceKey]: e.target.value }))}><option value="">Select source</option>{permittedSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field-label">What this account says<textarea value={comparison[textKey]} onChange={e => setComparison(v => ({ ...v, [textKey]: e.target.value }))}/></label><label className="field-label">Exact citation<input value={comparison[citationKey]} onChange={e => setComparison(v => ({ ...v, [citationKey]: e.target.value }))} placeholder="evidence:SOURCE-ID#R1L1-L3"/></label>{selected ? <button type="button" className="quiet evidence-link" onClick={() => onSource(selected, locator)}>Open {first ? 'first' : 'second'} source</button> : null}</fieldset>; })}</div>
          <label className="field-label">Next check<textarea value={comparison.nextCheck} onChange={e => setComparison(v => ({ ...v, nextCheck: e.target.value }))}/></label>
          <div className="tool-footer"><button type="submit" className="primary" disabled={busy || !native}>Save unreviewed comparison</button></div>
        </form>
      </ToolPanel>
      <ToolPanel icon={<Scale size={16} />} title="Prepare an issue, production gap, exhibit or draft" description="Create a versioned work product linked to an exact source citation." className="tool-product">
        <form onSubmit={e => { e.preventDefault(); void action(saveProduct); }}>
          <p className="field-hint">This creates an unreviewed, versioned work product. The source citation is checked on save; legal authority treatment remains unchecked.</p>
          <div className="form-grid"><label>Work product type<select value={product.kind} onChange={e => setProduct(v => ({ ...v, kind: e.target.value, fields: {} }))}>{Object.keys(productFields).map(name => <option key={name} value={name}>{humanize(name)}</option>)}</select></label><label>Title<input value={product.title} maxLength={300} onChange={e => setProduct(v => ({ ...v, title: e.target.value }))}/></label>
            {['issue_matrix', 'draft'].includes(product.kind) ? <><label>Jurisdiction<input value={product.jurisdiction} onChange={e => setProduct(v => ({ ...v, jurisdiction: e.target.value }))}/></label><label>Relevant date<input type="date" value={product.relevantDate} onChange={e => setProduct(v => ({ ...v, relevantDate: e.target.value }))}/></label></> : null}
          </div>
          {productFields[product.kind].map(field => <label key={field} className="field-label product-field">{humanize(field)}<textarea value={product.fields[field] ?? ''} onChange={e => setProduct(v => ({ ...v, fields: { ...v.fields, [field]: e.target.value } }))}/></label>)}
          <div className="form-grid"><label>Source<select value={product.source} onChange={e => setProduct(v => ({ ...v, source: e.target.value }))}><option value="">Select source</option>{permittedSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Exact citation<input value={product.citation} onChange={e => setProduct(v => ({ ...v, citation: e.target.value }))} placeholder="evidence:SOURCE-ID#R1L1-L3"/></label>
            <label className="wide">Accepted finding on this page (optional)<select value={product.finding} onChange={e => setProduct(v => ({ ...v, finding: e.target.value }))}><option value="">No linked finding</option>{page.objects.filter(o => o.review === 'accepted' && !o.stale).map(o => <option key={o.id} value={`${o.id}:${o.revision}`}>{o.title} · r{o.revision}</option>)}</select></label></div>
          <div className="tool-footer"><button type="submit" className="primary" disabled={busy || !native}>Save unreviewed work product</button></div>
        </form>
      </ToolPanel>
      <SoundDiscovery snapshot={{...snapshot,sources:sourcePages.sources}} onSource={id => { onSource(id); onClose(); }}/>
      <ToolPanel icon={<Clock3 size={16} />} title="Clock fit lab · manual anchors" description="Fit a mapping from recording playback time to incident time." className="tool-clock">
        <p className="field-hint">This creates a mapping proposal. Accepted proposals with independent held-out checks can drive incident replay. Supply independently checked anchors. File timestamps are not automatically capture times. No extrapolation; resets require separate fits.</p>
        <label className="field-label">Recording<select value={source} onChange={e => setSource(e.target.value)}><option value="">Select recording</option>{permittedSources.filter(s => ['video', 'audio'].includes(s.kind)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field-label">One anchor per line: container-relative playback seconds, incident seconds, uncertainty seconds, held out (0/1)<textarea className="mono" rows={5} value={anchorsText} onChange={e => { setAnchorsText(e.target.value); setFit(null); }} placeholder={'0, 100, 0.05, 0\n30, 130, 0.05, 0\n60, 160, 0.05, 0\n45, 145, 0.05, 1'}/></label>
        <div className="tool-footer"><button className="secondary" disabled={busy || !anchorsText.trim() || !native} onClick={() => void action(calculate)}>Calculate fit</button></div>
        {fit ? <div className="fit-result" role="status">
          <div className="fit-result-head"><span className="badge">{humanize(fit.status)}</span><span className="field-hint">{fit.drift_estimated ? 'drift estimated' : 'offset only'}</span></div>
          <p className="fit-equation">Incident seconds = {fit.scale.toPrecision(10)} × source seconds + {fit.offset_seconds.toFixed(6)}. Diagnostic uncertainty: ±{fit.uncertainty_seconds.toFixed(6)} s. Valid source range: {fit.valid_source_range.join(' – ')} s.</p>
          <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Anchor</th><th>Use</th><th className="numeric">Residual (s)</th><th>Check</th></tr></thead><tbody>{fit.residuals.map((r, i) => <tr key={i}><td className="numeric">{i + 1}</td><td>{r.held_out ? 'Held out' : 'Fit'}</td><td className="numeric">{r.residual_seconds.toFixed(6)}</td><td>{r.within_tolerance ? <StatusPill state="complete" label="Within tolerance" small /> : <StatusPill state="failed" label="Failed" small />}</td></tr>)}</tbody></table></div>
          {fit.limitations.map(l => <p className="field-hint" key={l}>{l}</p>)}
          <div className="tool-footer"><button className="primary" disabled={busy || !source} onClick={() => void action(async () => { await api('evidence_write', { ...caseSessionArgs(snapshot.id,snapshot.session_epoch), object: { id: null, base_revision: 0, kind: 'clock', title: `Clock proposal · ${sourcePages.sources.find(s => s.id === source)?.name}`, content: JSON.stringify({ clock_domain: "container_relative", anchors: fitAnchors, fit }, null, 2), source_ids: [source], locators: [], dependencies: [], start_seconds: null, end_seconds: null } }); setRefresh(v => v + 1); })}><FilePlus2 size={15} />Save unreviewed proposal</button>{!source ? <span className="field-hint">Select the recording before saving.</span> : null}</div>
        </div> : null}
      </ToolPanel>
    </div>
  </section>;
}
