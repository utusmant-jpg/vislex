import { useEffect, useId, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Check, Download, Eraser, MousePointer2, Plus, SquareDashedMousePointer, Trash2 } from 'lucide-react';
import { api, evidenceUrl } from '../bridge';
import { Tooltip } from '../ui';

type Box = { page: number; x: number; y: number; width: number; height: number };
type Derivative = { artifact_id: string; metadata: { mime: string; page?: number; page_count?: number } };

const round1 = (value: number) => Math.round(value * 10) / 10;

export default function RedactionPanel({ caseId, sessionEpoch, sourceId, kind }: { caseId?: string; sessionEpoch?: number; sourceId: string; kind: string }) {
  const [drawMode, setDrawMode] = useState(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null); // PDF points, or image pixels
  const [loadingBase, setLoadingBase] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [outputs, setOutputs] = useState<Derivative[]>([]);
  const [reviewed, setReviewed] = useState<number[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'prepare' | 'review' | 'export' | null>(null);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [saved, setSaved] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  // Destructive changes (discarding every marked rectangle and any review copy) need an explicit confirmation.
  const [confirm, setConfirm] = useState<'toggle' | 'clear' | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  const scopeKey = `${caseId ?? ''}:${sessionEpoch ?? ''}:${sourceId}:${kind}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  function toggleDraw() {
    setDrawMode(value => !value); setBoxes([]); invalidatePrepared();
  }
  function closeConfirm() {
    const trigger = confirm === 'clear' ? clearRef.current : toggleRef.current;
    setConfirm(null);
    trigger?.focus();
  }

  function invalidatePrepared() {
    setOutputs([]); setReviewed([]); setAccepted(false); setSaved('');
  }

  async function action(name: 'prepare' | 'review' | 'export', fn: (isCurrent: () => boolean) => Promise<void>) {
    const current = () => scopeRef.current === scopeKey;
    setBusy(name); setError('');
    try { await fn(current); } catch (e) { if (current()) setError(String(e)); }
    finally { if (current()) setBusy(null); }
  }

  useEffect(() => {
    setDrawMode(false); setBoxes([]); setPage(1); setPageCount(null); setBaseImage(null); setBaseSize(null);
    setDrag(null); setOutputs([]); setReviewed([]); setNote(''); setBusy(null); setError(''); setAccepted(false); setSaved(''); setConfirm(null);
  }, [scopeKey]);

  // Load the page (or corrected image) that boxes are drawn on.
  useEffect(() => {
    if (!drawMode) return;
    let active = true;
    setLoadingBase(true); setError(''); setBaseImage(null); setBaseSize(null);
    const load = kind === 'pdf'
      ? api<{ published: { artifact_id: string; metadata: { page_count?: number; page_size_points?: [number, number] } }[] }>('render_page', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId, page })
        .then(result => {
          if (!active) return;
          const published = result.published[0];
          setBaseImage(published ? evidenceUrl(`artifact/${published.artifact_id}`) : null);
          if (published?.metadata.page_count) setPageCount(published.metadata.page_count);
          setBaseSize(published?.metadata.page_size_points ? { w: published.metadata.page_size_points[0], h: published.metadata.page_size_points[1] } : { w: 612, h: 792 });
        })
      : api<{ published: { artifact_id: string }[] }>('process_source', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId })
        .then(result => {
          if (!active) return;
          setBaseImage(result.published[0] ? evidenceUrl(`artifact/${result.published[0].artifact_id}`) : evidenceUrl(sourceId));
          setBaseSize(null); // image pixels come from the loaded element's natural size
        });
    load.catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoadingBase(false); });
    return () => { active = false; };
  }, [drawMode, caseId, sessionEpoch, sourceId, kind, page]);

  const pages = outputs.filter(output => output.metadata.mime === 'image/jpeg');
  const pdf = outputs.find(output => output.metadata.mime === 'application/pdf');
  const pageBoxes = boxes.filter(box => box.page === page);

  function pointFromEvent(event: React.PointerEvent) {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, rect };
  }
  function commitDrag() {
    if (!drag || !baseImage) { setDrag(null); return; }
    const rect = imgRef.current?.getBoundingClientRect();
    const natural = baseSize ?? (imgRef.current ? { w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight } : null);
    if (!rect || !natural || rect.width === 0) { setDrag(null); return; }
    const x0 = Math.max(0, Math.min(drag.x0, drag.x1));
    const x1 = Math.min(rect.width, Math.max(drag.x0, drag.x1));
    const y0 = Math.max(0, Math.min(drag.y0, drag.y1));
    const y1 = Math.min(rect.height, Math.max(drag.y0, drag.y1));
    setDrag(null);
    if (x1 - x0 < 4 || y1 - y0 < 4) return; // treat as a click, not a box
    const scale = natural.w / rect.width;
    setBoxes(previous => [...previous, { page, x: round1(x0 * scale), y: round1(y0 * scale), width: round1((x1 - x0) * scale), height: round1((y1 - y0) * scale) }]);
    invalidatePrepared();
  }

  const step = !boxes.length ? 1 : !accepted ? 2 : 3;
  const steps = [
    { label: 'Mark areas', done: boxes.length > 0 },
    { label: 'Review every page', done: !!pdf },
    { label: 'Export copy', done: accepted },
  ];
  const confirmTitle = `Discard ${boxes.length} rectangle${boxes.length === 1 ? '' : 's'}?`;
  const confirmBody = confirm === 'toggle'
    ? `${drawMode ? 'Stopping drawing' : 'Starting to draw'} clears every marked area and any review copy built from them. The original source is unchanged.`
    : 'This clears every marked area and any review copy built from them. The original source is unchanged.';

  return <section className="redaction-panel card" aria-labelledby={`${ids}-title`}>
    <header className="redaction-head">
      <span className="icon-tile" aria-hidden="true"><SquareDashedMousePointer size={16} /></span>
      <div className="redaction-head-text">
        <h3 id={`${ids}-title`}>Prepare a reviewed redaction</h3>
        <p>Mark sensitive areas, inspect every page of the flattened copy, then accept it before export. The original source remains unchanged.</p>
      </div>
    </header>
    <ol className="redaction-steps" aria-label="Redaction progress">
      {steps.map((item, index) => <li key={item.label} className={item.done ? 'ready' : ''} aria-current={step === index + 1 ? 'step' : undefined}>
        <span className="redaction-step-index" aria-hidden="true">{item.done ? <Check size={12} /> : index + 1}</span>
        <span>{item.label}</span>{item.done ? <span className="visually-hidden"> (done)</span> : null}
      </li>)}
    </ol>
    <p className="redaction-units">{kind === 'pdf' ? 'Coordinates use PDF points from the physical page’s top-left corner.' : 'Coordinates use orientation-corrected image pixels.'} The copy contains flattened page images; original text, attachments, and source metadata are not copied.</p>

    <div className="redaction-toolbar">
      <button ref={toggleRef} className={drawMode ? 'secondary' : 'primary'} data-size="sm" disabled={!!busy} aria-pressed={drawMode} onClick={() => { if (boxes.length || outputs.length) setConfirm('toggle'); else toggleDraw(); }}>
        <MousePointer2 size={14} aria-hidden="true" />{drawMode ? 'Stop drawing' : 'Draw redactions'}
      </button>
      {kind === 'pdf' && drawMode ? <label className="redaction-page-field">Page {pageCount ? `of ${pageCount}` : ''}
        <input type="number" min={1} max={pageCount ?? undefined} value={page} disabled={!!busy} onChange={event => setPage(Math.min(pageCount ?? Infinity, Math.max(1, Number(event.target.value) || 1)))} />
      </label> : null}
      {drawMode && pageBoxes.length ? <span className="redaction-count">{pageBoxes.length} box{pageBoxes.length > 1 ? 'es' : ''} on page {page} · {boxes.length} total</span> : null}
      <div className="spacer" />
      {boxes.length ? <button ref={clearRef} className="quiet redaction-clear" disabled={!!busy} onClick={() => setConfirm('clear')}><Eraser size={14} aria-hidden="true" />Clear all rectangles</button> : null}
    </div>

    {confirm ? <div className="redaction-confirm" role="alertdialog" aria-modal="false" aria-labelledby={`${ids}-confirm-title`} aria-describedby={`${ids}-confirm-body`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeConfirm(); } }}>
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="redaction-confirm-body">
        <strong id={`${ids}-confirm-title`}>{confirmTitle}</strong>
        <p id={`${ids}-confirm-body`}>{confirmBody}</p>
        <div className="redaction-confirm-actions">
          <button ref={cancelRef} className="secondary" data-size="sm" onClick={closeConfirm}>Keep rectangles</button>
          <button className="danger-button" data-size="sm" onClick={() => { const trigger = confirm; setConfirm(null); if (trigger === 'toggle') toggleDraw(); else { setBoxes([]); invalidatePrepared(); } toggleRef.current?.focus(); }}>Discard rectangles</button>
        </div>
      </div>
    </div> : null}

    {drawMode ? <div className="redaction-stage-wrap">
      {loadingBase ? <p className="redaction-loading status-line" role="status"><span className="activity-dot" aria-hidden="true" />Rendering page {page}…</p> : null}
      {baseImage ? <div
        className={`redaction-stage ${drag ? 'drawing' : ''}`}
        onPointerDown={event => { if (busy || event.button !== 0) return; const point = pointFromEvent(event); if (point) setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y }); }}
        onPointerMove={event => { if (!drag) return; const point = pointFromEvent(event); if (point) setDrag(current => current ? { ...current, x1: point.x, y1: point.y } : current); }}
        onPointerUp={commitDrag}
        onPointerLeave={() => setDrag(null)}>
        <img ref={imgRef} src={baseImage} alt={`Redaction base ${kind === 'pdf' ? `page ${page}` : 'image'}`} draggable={false} />
        {pageBoxes.map((box, index) => <div
          className="redaction-box-overlay"
          key={index}
          style={(() => { const rect = imgRef.current?.getBoundingClientRect(); const natural = baseSize ?? (imgRef.current ? { w: imgRef.current.naturalWidth } : null); if (!rect || !natural) return undefined; const scale = rect.width / natural.w; return { left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }; })()}>
          <button className="redaction-box-remove" disabled={!!busy} aria-label={`Remove redaction box ${index + 1}`} onClick={() => { setBoxes(previous => previous.filter((_, position) => position !== boxes.indexOf(box))); invalidatePrepared(); }}><Trash2 size={12} /></button>
        </div>)}
        {drag ? <div className="redaction-box-overlay drafting" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} /> : null}
      </div> : !loadingBase ? <p className="redaction-hint">Page preview unavailable. Enter coordinates below.</p> : null}
      <p className="redaction-hint"><MousePointer2 size={12} aria-hidden="true" />Drag on the page to add a rectangle. Click a rectangle to remove it.</p>
    </div> : null}

    <div className="redaction-boxes">
      <div className="section-title">Rectangles <span className="count">{boxes.length}</span></div>
      {!boxes.length ? <p className="redaction-hint">No areas marked yet. Draw on the page or add a rectangle by coordinates.</p> : null}
      {boxes.map((box, index) => <div className="redaction-box" key={index}>
        <span className="redaction-box-page mono">p{box.page}</span>
        {(['x', 'y', 'width', 'height'] as const).map(field => <label key={field}>{field[0].toUpperCase()}
          <input aria-label={`${field[0].toUpperCase()} of rectangle ${index + 1} in ${kind === 'pdf' ? 'points' : 'pixels'}`} type="number" min={0} step="0.1" value={box[field]} disabled={!!busy} onChange={event => { const value = Math.max(0, Number(event.target.value) || 0); setBoxes(old => old.map((entry, position) => position === index ? { ...entry, [field]: value } : entry)); invalidatePrepared(); }} />
        </label>)}
        <Tooltip text="Remove rectangle"><button className="icon-button" disabled={!!busy} aria-label={`Remove rectangle ${index + 1}`} onClick={() => { setBoxes(old => old.filter((_, position) => position !== index)); invalidatePrepared(); }}><Trash2 size={14} /></button></Tooltip>
      </div>)}
      <div className="redaction-actions">
        <button className="quiet" disabled={!!busy || boxes.length >= 1000} onClick={() => { invalidatePrepared(); setBoxes(old => [...old, { page, x: 40, y: 40, width: 200, height: 24 }]); }}><Plus size={14} />Add rectangle</button>
        <div className="spacer" />
        <button className={pdf ? 'secondary' : 'primary'} disabled={!!busy || !boxes.length} onClick={() => void action('prepare', async isCurrent => { setOutputs([]); setReviewed([]); setAccepted(false); setSaved(''); const result = await api<{ published: Derivative[] }>('prepare_redaction', { case_id: caseId, session_epoch: sessionEpoch, source_id: sourceId, boxes }); if (isCurrent()) setOutputs(result.published); })}>{busy === 'prepare' ? 'Building review copy…' : 'Build review copy'}</button>
      </div>
    </div>

    {error ? <p role="alert" className="notice error redaction-error"><AlertTriangle size={16} aria-hidden="true" />{error}</p> : null}
    {pdf ? <div className="redaction-review">
      <p className="redaction-review-progress" role="status">{reviewed.length} of {pages.length} pages reviewed. Inspect each page for missed sensitive content before accepting.</p>
      <div className="redaction-review-pages">
        {pages.map(jpeg => <section key={jpeg.artifact_id} className={`redaction-review-page ${reviewed.includes(jpeg.metadata.page!) ? 'reviewed' : ''}`}>
          <p className="redaction-review-caption">Redacted copy · page {jpeg.metadata.page}</p>
          <img loading="lazy" src={evidenceUrl(`artifact/${jpeg.artifact_id}`)} alt={`Redacted page ${jpeg.metadata.page}`} />
          <label><input type="checkbox" checked={reviewed.includes(jpeg.metadata.page!)} onChange={event => { setAccepted(false); setReviewed(old => event.target.checked ? [...old, jpeg.metadata.page!] : old.filter(value => value !== jpeg.metadata.page!)); }} />I reviewed page {jpeg.metadata.page} for remaining sensitive content</label>
        </section>)}
      </div>
      <label className="field-label">Review note<textarea value={note} maxLength={4000} onChange={event => { setNote(event.target.value); setAccepted(false); }} placeholder="Record what you checked and any remaining limitation" /></label>
      <div className="redaction-actions">
        {accepted ? <span className="redaction-accepted"><Check size={14} aria-hidden="true" />Reviewed derivative accepted</span> : null}
        <div className="spacer" />
        <button className={accepted ? 'secondary' : 'primary'} disabled={!!busy || !pages.length || reviewed.length !== pages.length} onClick={() => void action('review', async isCurrent => { await api('review_redaction', { case_id: caseId, session_epoch: sessionEpoch, artifact_id: pdf.artifact_id, pages: reviewed, note }); if (isCurrent()) setAccepted(true); })}>{busy === 'review' ? 'Accepting reviewed copy…' : 'Accept reviewed derivative'}</button>
        <button className={accepted ? 'primary' : 'secondary'} disabled={!!busy || !accepted} onClick={() => void action('export', async isCurrent => { const path = await save({ defaultPath: 'Reviewed redaction.pdf', filters: [{ name: 'Flattened redaction', extensions: ['pdf'] }] }); if (path && isCurrent()) { await api('export_redaction', { case_id: caseId, session_epoch: sessionEpoch, artifact_id: pdf.artifact_id, path }); if (isCurrent()) setSaved(path); } })}><Download size={14} aria-hidden="true" />{busy === 'export' ? 'Exporting reviewed copy…' : 'Export derivative only'}</button>
      </div>
    </div> : null}
    {saved ? <p role="status" className="redaction-saved"><Check size={14} aria-hidden="true" />Saved {saved}</p> : null}
  </section>;
}
