import { useEffect, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { MousePointer2, Plus, SquareDashedMousePointer, Trash2 } from 'lucide-react';
import { api, evidenceUrl } from '../bridge';
import { Tooltip } from '../ui';

type Box = { page: number; x: number; y: number; width: number; height: number };
type Derivative = { artifact_id: string; metadata: { mime: string; page?: number; page_count?: number } };

const round1 = (value: number) => Math.round(value * 10) / 10;

export default function RedactionPanel({ caseId, sourceId, kind }: { caseId?: string; sourceId: string; kind: string }) {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [saved, setSaved] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);

  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }

  // Load the page (or corrected image) that boxes are drawn on.
  useEffect(() => {
    if (!drawMode) return;
    let active = true;
    setLoadingBase(true); setError(''); setBaseImage(null); setBaseSize(null);
    const load = kind === 'pdf'
      ? api<{ published: { artifact_id: string; metadata: { page_count?: number; page_size_points?: [number, number] } }[] }>('render_page', { case_id: caseId, source_id: sourceId, page })
        .then(result => {
          if (!active) return;
          const published = result.published[0];
          setBaseImage(published ? evidenceUrl(`artifact/${published.artifact_id}`) : null);
          if (published?.metadata.page_count) setPageCount(published.metadata.page_count);
          setBaseSize(published?.metadata.page_size_points ? { w: published.metadata.page_size_points[0], h: published.metadata.page_size_points[1] } : { w: 612, h: 792 });
        })
      : api<{ published: { artifact_id: string }[] }>('process_source', { case_id: caseId, source_id: sourceId })
        .then(result => {
          if (!active) return;
          setBaseImage(result.published[0] ? evidenceUrl(`artifact/${result.published[0].artifact_id}`) : evidenceUrl(sourceId));
          setBaseSize(null); // image pixels come from the loaded element's natural size
        });
    load.catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoadingBase(false); });
    return () => { active = false; };
  }, [drawMode, sourceId, kind, page]);

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
    setOutputs([]); setReviewed([]); setAccepted(false); setSaved('');
  }

  return <details className="redaction-panel"><summary><SquareDashedMousePointer size={13} />Prepare a reviewed redaction</summary>
    <p className="small muted">Draw rectangles on the page, or enter exact coordinates. {kind === 'pdf' ? 'Coordinates are PDF points from the top-left of the physical page.' : 'Coordinates are orientation-corrected image pixels.'} The derivative contains flattened page images; original text, attachments and source metadata are not copied. Review every page for missed sensitive content before export.</p>

    <div className="input-row redaction-toolbar">
      <button className={drawMode ? 'primary' : 'secondary'} onClick={() => { setDrawMode(value => !value); setBoxes([]); setOutputs([]); }}>
        {drawMode ? 'Stop drawing' : 'Draw redactions'}
      </button>
      {kind === 'pdf' && drawMode ? <label className="small">Page
        <input type="number" min={1} max={pageCount ?? undefined} value={page} onChange={event => setPage(Math.max(1, Number(event.target.value) || 1))} />
      </label> : null}
      {drawMode && pageBoxes.length ? <span className="small muted">{pageBoxes.length} box{pageBoxes.length > 1 ? 'es' : ''} on page {page} · {boxes.length} total</span> : null}
    </div>

    {drawMode ? <div className="redaction-stage-wrap">
      {loadingBase ? <p className="small muted">Rendering page {page}…</p> : null}
      {baseImage ? <div
        className={`redaction-stage ${drag ? 'drawing' : ''}`}
        onPointerDown={event => { if (event.button !== 0) return; const point = pointFromEvent(event); if (point) setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y }); }}
        onPointerMove={event => { if (!drag) return; const point = pointFromEvent(event); if (point) setDrag(current => current ? { ...current, x1: point.x, y1: point.y } : current); }}
        onPointerUp={commitDrag}
        onPointerLeave={() => setDrag(null)}>
        <img ref={imgRef} src={baseImage} alt={`Redaction base ${kind === 'pdf' ? `page ${page}` : 'image'}`} draggable={false} />
        {pageBoxes.map((box, index) => <div
          className="redaction-box-overlay"
          key={index}
          style={(() => { const rect = imgRef.current?.getBoundingClientRect(); const natural = baseSize ?? (imgRef.current ? { w: imgRef.current.naturalWidth } : null); if (!rect || !natural) return undefined; const scale = rect.width / natural.w; return { left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }; })()}>
          <button className="redaction-box-remove" aria-label={`Remove redaction box ${index + 1}`} onClick={() => setBoxes(previous => previous.filter((_, position) => position !== boxes.indexOf(box)))}><Trash2 size={11} /></button>
        </div>)}
        {drag ? <div className="redaction-box-overlay drafting" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} /> : null}
      </div> : !loadingBase ? <p className="small muted">Page preview unavailable. Enter coordinates below.</p> : null}
      <p className="small muted redaction-hint"><MousePointer2 size={12} />Drag on the page to add a rectangle. Click a rectangle to remove it.</p>
    </div> : null}

    <div className="redaction-boxes">
      {boxes.map((box, index) => <div className="redaction-box" key={index}>
        <span className="small muted">p{box.page}</span>
        {(['x', 'y', 'width', 'height'] as const).map(field => <label key={field} aria-label={`${field} of rectangle ${index + 1} in ${kind === 'pdf' ? 'points' : 'pixels'}`}>{field[0].toUpperCase()}
          <input type="number" min={0} step="0.1" value={box[field]} disabled={busy} onChange={event => { const value = Math.max(0, Number(event.target.value) || 0); setBoxes(old => old.map((entry, position) => position === index ? { ...entry, [field]: value } : entry)); setOutputs([]); setAccepted(false); }} />
        </label>)}
        <Tooltip text="Remove rectangle"><button className="icon-button" disabled={busy} aria-label={`Remove rectangle ${index + 1}`} onClick={() => setBoxes(old => old.filter((_, position) => position !== index))}><Trash2 size={13} /></button></Tooltip>
      </div>)}
      <div className="input-row">
        <button className="quiet" disabled={busy || boxes.length >= 1000} onClick={() => { setOutputs([]); setAccepted(false); setBoxes(old => [...old, { page, x: 40, y: 40, width: 200, height: 24 }]); }}><Plus size={13} />Add rectangle</button>
        <button className="primary" disabled={busy || !boxes.length} onClick={() => void action(async () => { setOutputs([]); setReviewed([]); setAccepted(false); setSaved(''); const result = await api<{ published: Derivative[] }>('prepare_redaction', { case_id: caseId, source_id: sourceId, boxes }); setOutputs(result.published); })}>{busy ? 'Processing…' : 'Build review copy'}</button>
      </div>
    </div>

    {error ? <p role="alert" className="danger-text">{error}</p> : null}
    {pages.map(jpeg => <section key={jpeg.artifact_id} className="redaction-review-page">
      <img loading="lazy" src={evidenceUrl(`artifact/${jpeg.artifact_id}`)} alt={`Redacted page ${jpeg.metadata.page}`} style={{ width: '100%' }} />
      <label><input type="checkbox" checked={reviewed.includes(jpeg.metadata.page!)} onChange={event => { setAccepted(false); setReviewed(old => event.target.checked ? [...old, jpeg.metadata.page!] : old.filter(value => value !== jpeg.metadata.page!)); }} />I reviewed page {jpeg.metadata.page} for remaining sensitive content</label>
    </section>)}
    {pdf ? <>
      <label className="field-label">Review note<textarea value={note} maxLength={4000} onChange={event => { setNote(event.target.value); setAccepted(false); }} /></label>
      <div className="input-row">
        <button className="secondary" disabled={busy || !pages.length || reviewed.length !== pages.length} onClick={() => void action(async () => { await api('review_redaction', { case_id: caseId, artifact_id: pdf.artifact_id, pages: reviewed, note }); setAccepted(true); })}>Accept reviewed derivative</button>
        <button className="primary" disabled={busy || !accepted} onClick={() => void action(async () => { const path = await save({ defaultPath: 'Reviewed redaction.pdf', filters: [{ name: 'Flattened redaction', extensions: ['pdf'] }] }); if (path) { await api('export_redaction', { case_id: caseId, artifact_id: pdf.artifact_id, path }); setSaved(path); } })}>Export derivative only</button>
      </div>
    </> : null}
    {saved ? <p role="status" className="small success-text">Saved {saved}</p> : null}
  </details>;
}
