import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AArrowDown, ChevronsLeft, ChevronsRight, FileText, Film, Image as ImageIcon, Info, Pause, Play,
  RotateCw, ScanLine, SkipBack, SkipForward, Volume2, VolumeX, ZoomIn, ZoomOut,
} from 'lucide-react';
import { api, evidenceUrl, formatBytes } from '../bridge';
import type { Source, TextPage } from '../types';
import { parsePinnedTextLocator } from '../citationLocator';
import FullTranscript from './FullTranscript';
import RedactionPanel from './RedactionPanel';
import VideoDiscovery from './VideoDiscovery';
import { Skeleton, Tooltip } from '../ui';
import { setViewerContext } from '../viewerContext';

export function SourceIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : kind === 'audio' ? Volume2 : FileText;
  return <Icon size={size} aria-hidden="true" />;
}

function formatClockMs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(Math.floor(s)).padStart(2, '0')}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`;
}

const FRAME_STEP = 1 / 30;

/** Custom forensic transport shared by video and audio. Native controls stay off. */
function MediaControls({ media, filmstrip, onSeek }: { media: React.RefObject<HTMLMediaElement | null>; filmstrip: { artifact: string; time: number }[] | null; onSeek: (time: number) => void }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  useEffect(() => {
    const element = media.current;
    if (!element) return;
    const onTime = () => {
      setTime(element.currentTime);
      if (loopA !== null && loopB !== null && element.currentTime >= loopB) element.currentTime = loopA;
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => setDuration(element.duration || 0);
    element.addEventListener('timeupdate', onTime);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    element.addEventListener('loadedmetadata', onMeta);
    element.addEventListener('durationchange', onMeta);
    return () => {
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('loadedmetadata', onMeta);
      element.removeEventListener('durationchange', onMeta);
    };
  }, [media, loopA, loopB]);
  const toggle = () => { const element = media.current; if (!element) return; if (element.paused) void element.play(); else element.pause(); };
  const skip = (amount: number) => { const element = media.current; if (!element) return; onSeek(Math.max(0, Math.min((element.duration || 0) - 0.01, element.currentTime + amount))); };
  const frame = (amount: number) => skip(amount * FRAME_STEP);
  const applyRate = (next: number) => { setRate(next); if (media.current) media.current.playbackRate = next; };
  const toggleMute = () => { const element = media.current; if (!element) return; element.muted = !element.muted; setMuted(element.muted); };
  return <div className="media-controls" onKeyDown={event => {
    if (event.key === ' ' || event.key === 'k') { event.preventDefault(); toggle(); }
    else if (event.key === 'j') skip(-10);
    else if (event.key === 'l') skip(10);
    else if (event.key === 'ArrowLeft') { event.preventDefault(); skip(event.shiftKey ? -1 : -5); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); skip(event.shiftKey ? 1 : 5); }
    else if (event.key === ',') frame(-1);
    else if (event.key === '.') frame(1);
    else if (event.key === '[') setLoopA(media.current?.currentTime ?? null);
    else if (event.key === ']') setLoopB(media.current?.currentTime ?? null);
  }} tabIndex={0} role="group" aria-label="Playback controls — space to play, J K L to shuttle, comma and period to step frames">
    <div className="media-progress">
      <input
        aria-label="Seek position"
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(time, duration || 0)}
        onChange={event => onSeek(Number(event.target.value))}
        style={loopA !== null && loopB !== null ? { '--loop-a': `${(loopA / (duration || 1)) * 100}%`, '--loop-b': `${(loopB / (duration || 1)) * 100}%` } as React.CSSProperties : undefined}
      />
      {loopA !== null && loopB !== null && loopB > loopA ? <span className="loop-range" style={{ left: `${(loopA / (duration || 1)) * 100}%`, width: `${((loopB - loopA) / (duration || 1)) * 100}%` }} /> : null}
    </div>
    {filmstrip?.length ? <div className="filmstrip" aria-label="Filmstrip of sampled frames">
      {filmstrip.map(frameSample => <Tooltip key={frameSample.artifact} text={`Jump to ${formatClockMs(frameSample.time)}`}>
        <button onClick={() => onSeek(frameSample.time)}><img src={evidenceUrl(`artifact/${frameSample.artifact}`)} alt="" loading="lazy" /></button>
      </Tooltip>)}
    </div> : null}
    <div className="media-buttons">
      <Tooltip text="Back 10 seconds (J)"><button className="icon-button" aria-label="Back 10 seconds" onClick={() => skip(-10)}><ChevronsLeft size={16} /></button></Tooltip>
      <Tooltip text="Back 1 frame (,)"><button className="icon-button" aria-label="Back one frame" onClick={() => frame(-1)}><SkipBack size={14} /></button></Tooltip>
      <button className="media-play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <Tooltip text="Forward 1 frame (.)"><button className="icon-button" aria-label="Forward one frame" onClick={() => frame(1)}><SkipForward size={14} /></button></Tooltip>
      <Tooltip text="Forward 10 seconds (L)"><button className="icon-button" aria-label="Forward 10 seconds" onClick={() => skip(10)}><ChevronsRight size={16} /></button></Tooltip>
      <span className="media-time mono">{formatClockMs(time)} <span className="media-duration">/ {formatClockMs(duration)}</span></span>
      <div className="spacer" />
      <Tooltip text="Mark loop start ([)"><button className={`media-loop ${loopA !== null ? 'active' : ''}`} aria-label="Mark loop start" onClick={() => setLoopA(media.current?.currentTime ?? null)}>A</button></Tooltip>
      <Tooltip text="Mark loop end (])"><button className={`media-loop ${loopB !== null ? 'active' : ''}`} aria-label="Mark loop end" onClick={() => setLoopB(media.current?.currentTime ?? null)}>B</button></Tooltip>
      {loopA !== null || loopB !== null ? <button className="quiet" onClick={() => { setLoopA(null); setLoopB(null); }}>Clear loop</button> : null}
      <label className="media-rate">Speed
        <select aria-label="Playback speed" value={rate} onChange={event => applyRate(Number(event.target.value))}>
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
      <Tooltip text={muted ? 'Unmute' : 'Mute'}><button className="icon-button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button></Tooltip>
    </div>
  </div>;
}

function PdfPageView({ index, ratio, artifact, ensure, onVisible, register }: {
  index: number; ratio: number; artifact?: string;
  ensure: (page: number) => void; onVisible: (page: number) => void; register: (page: number, node: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) ensure(index);
        if (entry.intersectionRatio >= 0.4) onVisible(index);
      }
    }, { rootMargin: '700px 0px', threshold: [0, 0.4] });
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, ensure, onVisible]);
  return <div className="pdf-page" ref={node => { ref.current = node; register(index, node); }} data-page={index} style={{ aspectRatio: `${ratio}` }}>
    {artifact ? <img src={evidenceUrl(`artifact/${artifact}`)} alt={`Page ${index}`} loading="lazy" draggable={false} /> : <div className="pdf-page-skeleton"><Skeleton /></div>}
    <span className="pdf-page-label">{index}</span>
  </div>;
}

export default function EvidenceViewer({ source, locator, run, refresh, onLocatorSelect }: { source: Source; locator?: string; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void>; onLocatorSelect: (locator: string) => void }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  useEffect(() => { if (pendingSeek !== null && media.current?.readyState) { media.current.currentTime = pendingSeek; setCurrentTime(pendingSeek); setPendingSeek(null); } }, [pendingSeek]);
  const requestedTime = locator?.startsWith('time:') ? Number(locator.slice(5)) : null;
  const pinnedText = parsePinnedTextLocator(locator);
  const requestedRevision = pinnedText?.revision ?? null;
  const requestedPage = locator?.startsWith('page:') ? Number(locator.slice(5)) : null;
  const [page, setPage] = useState<TextPage | null>(null);
  const [error, setError] = useState('');
  const [start, setStart] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const officeDocument = /\.(docx|xlsx|pptx|odt)$/i.test(source.name);
  const [showText, setShowText] = useState(source.kind === 'text' || (source.kind === 'other' && source.status.startsWith('text')));
  const [limitations, setLimitations] = useState<string[]>([]);
  const [derived, setDerived] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [artifactText, setArtifactText] = useState<string | null>(null);
  const [derivedMime, setDerivedMime] = useState('');
  const [playback, setPlayback] = useState<string | null>(null);
  const [needsProxy, setNeedsProxy] = useState(/\.avi$/i.test(source.name));
  const [filmstrip, setFilmstrip] = useState<{ artifact: string; time: number }[] | null>(null);
  const [askChip, setAskChip] = useState<{ x: number; y: number; a: number; b: number; revision: number } | null>(null);

  // PDF continuous-scroll state
  const [pdfCount, setPdfCount] = useState<number | null>(null);
  const [pdfPage, setPdfPage] = useState(requestedPage ?? 1);
  const [pdfArtifacts, setPdfArtifacts] = useState<Record<number, string>>({});
  const [pdfRatio, setPdfRatio] = useState(8.5 / 11);
  const pdfPending = useRef<Set<number>>(new Set());
  const pdfPagesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const ensurePage = useCallback((target: number) => {
    setPdfArtifacts(current => {
      if (current[target] || pdfPending.current.has(target)) return current;
      pdfPending.current.add(target);
      void api<{ published: { artifact_id: string; metadata: { page_count: number; page_size_points?: [number, number] } }[]; limitations: string[] }>('render_page', { source_id: source.id, page: target })
        .then(result => {
          const published = result.published[0];
          setPdfArtifacts(existing => ({ ...existing, [target]: published?.artifact_id ?? '' }));
          if (published?.metadata.page_count) setPdfCount(published.metadata.page_count);
          if (published?.metadata.page_size_points) setPdfRatio(published.metadata.page_size_points[0] / published.metadata.page_size_points[1]);
          setLimitations(result.limitations);
        })
        .catch(reason => setError(String(reason)))
        .finally(() => pdfPending.current.delete(target));
      return current;
    });
  }, [source.id]);

  useEffect(() => { pdfPagesRef.current.get(requestedPage ?? 1)?.scrollIntoView({ block: 'start' }); setPdfPage(requestedPage ?? 1); }, [requestedPage, source.id]);

  // Publish what the viewer is looking at for the composer context (no DOM scraping).
  useEffect(() => {
    if (source.kind === 'pdf') setViewerContext({ sourceId: source.id, page: pdfPage });
    else if (['video', 'audio'].includes(source.kind)) setViewerContext({ sourceId: source.id, timeSeconds: currentTime });
    else if (showText) setViewerContext({ sourceId: source.id, lineStart: start });
    else setViewerContext({ sourceId: source.id });
    return () => { setViewerContext(null); };
  }, [source.id, source.kind, pdfPage, currentTime, showText, start]);
  useEffect(() => () => setViewerContext(null), [source.id]);

  useEffect(() => {
    if (!needsProxy || source.kind !== 'video') return;
    let active = true; setProcessing(true); setError('');
    api<{ artifact_id: string }>('playback_proxy', { source_id: source.id }).then(result => { if (active) setPlayback(result.artifact_id); }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setProcessing(false); });
    return () => { active = false; };
  }, [source.id, needsProxy]);

  useEffect(() => {
    if (!officeDocument || locator) return;
    let active = true;
    setProcessing(true);
    api<{ limitations: string[] }>('process_source', { source_id: source.id }).then(result => { if (active) { setShowText(true); setLimitations(result.limitations); void refresh(); } }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setProcessing(false); });
    return () => { active = false; };
  }, [source.id, locator, officeDocument]);

  useEffect(() => {
    let active = true; setArtifactText(null); setDerivedMime('');
    if (derived) api<{ mime: string; content: { pages?: { locator: string; text: string }[]; limitations?: string[] } | null }>('artifact_info', { artifact_id: derived }).then(info => {
      if (!active) return; setDerivedMime(info.mime); setError('');
      if (info.mime === 'application/json') {
        const units = info.content?.pages ?? [];
        setArtifactText(units.slice(0, 200).map(unit => `[${unit.locator}]\n${unit.text}`).join('\n\n') + (units.length > 200 ? `\n\nShowing 200 of ${units.length} units. Use the extracted-text viewer for paginated access.` : ''));
        setLimitations(info.content?.limitations ?? []);
      }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [derived]);

  useEffect(() => {
    if (locator?.startsWith('L')) { setShowText(true); setDerived(null); setStart(Number(/^L(\d+)/.exec(locator ?? '')?.[1] ?? 1)); }
    else if (parsePinnedTextLocator(locator)) { setShowText(true); setDerived(null); setStart(parsePinnedTextLocator(locator)!.start); }
    else if (locator?.startsWith('artifact:')) { setDerived(locator.slice(9)); setShowText(false); }
    else { setDerived(null); setShowText(source.kind === 'text' || (source.kind === 'other' && source.status.startsWith('text'))); setStart(1); }
  }, [locator, source.id, source.kind, source.status]);

  useEffect(() => { setZoom(1); setRotation(0); setError(''); }, [source.id]);

  useEffect(() => {
    let active = true; setPage(null);
    if (showText) {
      const request = requestedRevision !== null
        ? api<TextPage>('read_extract_revision', { source_id: source.id, revision: requestedRevision, start, count: 200 })
        : api<TextPage>('read_text', { source_id: source.id, start, count: 200 });
      request.then(value => { if (active) { setPage(value); setError(''); } }).catch(e => { if (active) setError(String(e)); });
    }
    return () => { active = false; };
  }, [source.id, source.kind, start, showText, source.status, requestedRevision]);

  useEffect(() => {
    if (requestedTime != null && media.current?.readyState && Number.isFinite(requestedTime)) media.current.currentTime = requestedTime;
  }, [requestedTime]);

  useEffect(() => {
    if (source.kind !== 'video' || source.restricted) return;
    let active = true;
    api<{ samples: { artifact_id: string; metadata: { playback_seconds: number } }[] }>('browse_video_discovery', { source_id: source.id, kind: 'video_overview', start: 0, end: 86_400, offset: 0, query: '' })
      .then(result => { if (active) setFilmstrip(result.samples.slice(0, 22).map(sample => ({ artifact: sample.artifact_id, time: sample.metadata.playback_seconds })).filter(sample => sample.time >= 0)); })
      .catch(() => setFilmstrip(null));
    return () => { active = false; };
  }, [source.id, source.restricted]);

  const url = evidenceUrl(source.id);
  const playbackUrl = playback ? evidenceUrl(`artifact/${playback}`) : url;
  const onTimeUpdate = (event: React.SyntheticEvent<HTMLMediaElement>) => setCurrentTime(event.currentTarget.currentTime);
  const onLoadedMetadata = () => {
    if (pendingSeek !== null && media.current) { media.current.currentTime = pendingSeek; setPendingSeek(null); }
    else if (requestedTime != null && Number.isFinite(requestedTime) && media.current) media.current.currentTime = requestedTime;
  };

  function onTextSelect(event: React.MouseEvent) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) { setAskChip(null); return; }
    const numbers: number[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('.text-line[data-line]'))) {
      if (selection.containsNode(element, true) && element.textContent) numbers.push(Number(element.dataset.line));
    }
    if (!numbers.length) { setAskChip(null); return; }
    setAskChip({ x: event.clientX, y: event.clientY, a: Math.min(...numbers), b: Math.max(...numbers), revision: page?.revision ?? 1 });
  }

  const totalPdfPages = pdfCount ?? Math.max((requestedPage ?? 1) + 4, 12);

  return <div className="viewer">
    {source.kind === 'image' ? <div className="image-controls">
      <Tooltip text="Zoom out"><button className="icon-button" aria-label="Zoom out" onClick={() => setZoom(value => Math.max(0.25, value - 0.25))}><ZoomOut size={15} /></button></Tooltip>
      <span className="mono">{Math.round(zoom * 100)}%</span>
      <Tooltip text="Zoom in"><button className="icon-button" aria-label="Zoom in" onClick={() => setZoom(value => Math.min(6, value + 0.25))}><ZoomIn size={15} /></button></Tooltip>
      <Tooltip text="Fit width"><button className="quiet" onClick={() => setZoom(1)}>Fit</button></Tooltip>
      <Tooltip text="Rotate view"><button className="icon-button" aria-label="Rotate view" onClick={() => setRotation(value => value + 90)}><RotateCw size={15} /></button></Tooltip>
    </div> : null}

    {source.kind === 'pdf' ? <div className="pdf-navigation">
      <Tooltip text="Previous page"><button className="icon-button" aria-label="Previous page" onClick={() => pdfPagesRef.current.get(Math.max(1, pdfPage - 1))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ChevronsLeft size={16} /></button></Tooltip>
      <label className="pdf-page-input">Page
        <input
          type="number" min={1} max={pdfCount ?? undefined} value={pdfPage}
          aria-label="Current page"
          onChange={event => {
            const target = Number(event.target.value);
            if (!Number.isFinite(target)) return;
            setPdfPage(target); ensurePage(target); pdfPagesRef.current.get(target)?.scrollIntoView({ block: 'start' });
          }} />
      </label>
      <span className="muted small">{pdfCount ? `of ${pdfCount}` : ''}</span>
      <Tooltip text="Next page"><button className="icon-button" aria-label="Next page" disabled={!!pdfCount && pdfPage >= pdfCount} onClick={() => pdfPagesRef.current.get(pdfPage + 1)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ChevronsRight size={16} /></button></Tooltip>
      <div className="spacer" />
      <button className="quiet" onClick={() => run(async () => { await navigator.clipboard.writeText(`evidence:${source.id}#page:${pdfPage}`); })}>Copy page link</button>
    </div> : null}

    <div className={`source-canvas ${source.kind}`}>
      {processing ? <div className="preview-progress" role="status"><ScanLine size={17} className="pulse" />{needsProxy ? 'Opening video…' : 'Opening source…'}</div> : null}
      {error ? <div className="notice error"><Info size={18} />{error}</div> : null}

      {showText && page === null && !error ? <div className="document-page"><Skeleton /></div> : null}
      {showText && page ? <article className="document-page" onMouseUp={onTextSelect}>
        {page.historical ? <p className="small muted historical-notice" role="note">Historical extraction revision {page.revision} — superseded wording preserved; this is not the current active text.</p> : null}
        <h2>{source.name.replace(/^\d+ · /, '')}</h2>
        <div className="doc-rule" />
        <div className="text-lines">
          {page.text.split('\n').map((line, index) => <div className="text-line" data-line={start + index} key={index}><span className="line-number">{start + index}</span><span>{line || '\u00a0'}</span></div>)}
        </div>
      </article> : null}

      {artifactText !== null ? <article className="document-page">
        <h2>{source.name}</h2>
        <pre className="artifact-text">{artifactText || 'No text segments were returned. This does not establish absence of speech.'}</pre>
        <button className="quiet" onClick={() => { setDerived(null); setShowText(false); }}>Back to original</button>
      </article> : null}

      {!showText && ((!derived && source.kind === 'image') || (derived && derivedMime === 'image/jpeg')) ? <div className="image-stage">
        <img
          className="evidence-image"
          src={derived ? evidenceUrl(`artifact/${derived}`) : url}
          alt={`${derived ? 'Derived frame or crop' : 'Original evidence'}: ${source.name}`}
          style={{ width: zoom === 1 ? '100%' : `${zoom * 100}%`, maxWidth: 'none', transform: rotation ? `rotate(${rotation}deg)` : undefined }}
          onDoubleClick={() => setZoom(value => value === 1 ? 2 : 1)}
          onError={() => {
            if (derived) { setError('Image preview failed.'); return; }
            setProcessing(true);
            void api<{ published: unknown[] }>('process_source', { source_id: source.id }).then(result => { setDerived((result.published as { artifact_id?: string }[])?.[0]?.artifact_id ?? null); }).catch(e => setError(String(e))).finally(() => setProcessing(false));
          }} />
        {derived && source.kind === 'video' ? <button className="quiet back-source" onClick={() => setDerived(null)}>Back to recording</button> : null}
      </div> : null}

      {!showText && !derived && source.kind === 'video' ? <video
        ref={node => { media.current = node; }}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        key={playbackUrl}
        src={needsProxy && !playback ? undefined : playbackUrl}
        controls={false} playsInline preload="metadata"
        onError={() => { if (!needsProxy) setNeedsProxy(true); else if (playback) setError('Playback derivative could not be decoded. Original frames remain available.'); }}
      /> : null}

      {!showText && !derived && source.kind === 'audio' ? <div className="audio-stage">
        <Volume2 size={52} />
        <h2>{source.name}</h2>
        <p className="small muted">{formatBytes(source.size)} · {source.status}</p>
        <audio ref={node => { media.current = node; }} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} src={url} controls={false} preload="metadata" onError={() => setError('This audio format is not supported by the installed viewer.')} />
      </div> : null}

      {!showText && !derived && source.kind === 'other' && !processing ? <div className="empty-content">
        <FileText size={38} />
        <h2>{officeDocument ? 'Document preview could not open' : 'Original file preserved'}</h2>
        <p>{officeDocument ? 'See the error below, then reopen the file to retry extraction.' : 'This file format does not yet have an inline preview.'}</p>
      </div> : null}

      {!showText && !derived && source.kind === 'pdf' ? <div className="pdf-continuous">
        {Array.from({ length: totalPdfPages }, (_, index) => index + 1).map(pageNumber => <PdfPageView
          key={pageNumber}
          index={pageNumber}
          ratio={pdfRatio}
          artifact={pdfArtifacts[pageNumber] || undefined}
          ensure={ensurePage}
          onVisible={setPdfPage}
          register={(number, node) => { if (node) pdfPagesRef.current.set(number, node); else pdfPagesRef.current.delete(number); }}
        />)}
      </div> : null}
    </div>

    {askChip ? <div className="ask-chip" style={{ left: askChip.x, top: askChip.y }} role="toolbar" aria-label="Selection actions">
      <button onClick={() => { onLocatorSelect(`L${askChip.a}-L${askChip.b}`); setAskChip(null); window.dispatchEvent(new CustomEvent('vislex:focus-composer')); }}><AArrowDown size={13} />Ask about L{askChip.a}–L{askChip.b}</button>
      <button onClick={() => { void navigator.clipboard.writeText(`evidence:${source.id}#R${askChip.revision}L${askChip.a}-L${askChip.b}`); setAskChip(null); }}>Copy citation (rev {askChip.revision})</button>
    </div> : null}

    {['video', 'audio'].includes(source.kind) && !showText && !derived ? <MediaControls media={media} filmstrip={source.kind === 'video' ? filmstrip : null} onSeek={time => { if (media.current) { media.current.currentTime = time; setCurrentTime(time); } }} /> : null}
    {['video', 'audio'].includes(source.kind) ? <FullTranscript currentTime={currentTime} onSeek={time => { if (media.current) { media.current.currentTime = time; setCurrentTime(time); } }} sourceId={source.id} run={run} refresh={refresh} /> : null}
    {source.kind === 'video' && !source.restricted ? <VideoDiscovery key={source.id} sourceId={source.id} onFrame={id => { setDerived(id); setShowText(false); }} onSeek={time => { setDerived(null); setShowText(false); setPendingSeek(time); }} /> : null}
    {['pdf', 'image'].includes(source.kind) && !source.restricted ? <RedactionPanel sourceId={source.id} kind={source.kind} /> : null}
    {limitations.length ? <details className="processing-limitations disclosure">
      <summary><Info size={13} />About this preview<span className="disclosure-count">{limitations.length}</span></summary>
      {limitations.map(limitation => <p key={limitation}>{limitation}</p>)}
    </details> : null}
    {page ? <div className="locator-bar">
      <button className="quiet" onClick={() => run(async () => { await navigator.clipboard.writeText(page.locator); })}>Copy evidence link</button>
      <code>{page.historical ? `rev ${page.revision} · ` : ''}L{page.start}–L{page.end} / {page.total_lines}</code>
      <div className="spacer" />
      <Tooltip text="Previous 200 lines"><button className="icon-button" aria-label="Previous lines" disabled={start === 1} onClick={() => setStart(value => Math.max(1, value - 200))}><ChevronsLeft size={16} /></button></Tooltip>
      <Tooltip text="Next 200 lines"><button className="icon-button" aria-label="Next lines" disabled={page.end >= page.total_lines} onClick={() => setStart(page.end + 1)}><ChevronsRight size={16} /></button></Tooltip>
    </div> : null}
  </div>;
}
