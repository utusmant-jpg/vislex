import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AArrowDown, AlertTriangle, Captions, Check, ChevronsLeft, ChevronsRight, FileQuestion, FileText, Film, Fingerprint, History,
  Image as ImageIcon, Info, Link2, Lock, Pause, PanelBottomClose, PanelBottomOpen, Play, RotateCw, ScanSearch, SkipBack,
  SkipForward, SquareDashedMousePointer, StepBack, StepForward, Volume2, VolumeX, ZoomIn, ZoomOut,
} from 'lucide-react';
import { api, evidenceUrl, formatBytes } from '../bridge';
import type { Source, TextPage } from '../types';
import { parsePinnedTextLocator } from '../citationLocator';
import FullTranscript from './FullTranscript';
import RedactionPanel from './RedactionPanel';
import VideoDiscovery from './VideoDiscovery';
import { ViewerTabs, tabPanelProps } from './ViewerTabs';
import { Skeleton, Tooltip } from '../ui';
import { setViewerContext } from '../viewerContext';

export function SourceIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : kind === 'audio' ? Volume2 : FileText;
  return <Icon size={size} aria-hidden="true" />;
}

function formatClockMs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total=Math.round(seconds*1000);
  const h=Math.floor(total/3_600_000);
  const m=Math.floor((total%3_600_000)/60_000);
  const s=Math.floor((total%60_000)/1000);
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}.${String(total%1000).padStart(3, '0')}`;
}

/** Line range a text locator cites, for highlighting. Pinned (R…L…-L…) and legacy (L… / L…-L…) forms only. */
export function citedLineRange(locator: string | undefined | null): { start: number; end: number } | null {
  const match = /^(?:R[1-9]\d*)?L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(locator ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return end >= start ? { start, end } : null;
}

/** Short, readable form of a content hash; the full value stays available in the tooltip and copy action. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

const RESTRICTED_WHY = 'Restricted from AI analysis. Redaction and visual discovery are hidden for this source. Change this in the Evidence library.';

const APPROXIMATE_STEP_SECONDS = 1 / 30;

/** Icon-only copy action with local confirmation; failures route through the caller's run(). */
function CopyAction({ label, value, icon, run }: { label: string; value: () => string; icon: React.ReactNode; run: (fn: () => Promise<void>) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1400); return () => window.clearTimeout(timer); }, [copied]);
  return <Tooltip text={copied ? 'Copied' : label}>
    <button className="icon-button" aria-label={label} onClick={() => run(async () => { await navigator.clipboard.writeText(value()); setCopied(true); })}>
      {copied ? <Check size={16} aria-hidden="true" /> : icon}
    </button>
  </Tooltip>;
}

/** A viewer failure: plain title, the message (long raw detail behind a disclosure), and a recovery action when one exists. */
function ViewerProblem({ title, message, onRetry, retryLabel = 'Try again' }: { title: string; message: string; onRetry?: () => void; retryLabel?: string }) {
  const long = message.length > 180 || message.includes('\n');
  return <div className="viewer-problem notice error" role="alert">
    <AlertTriangle size={16} aria-hidden="true" />
    <div className="viewer-problem-body">
      <strong>{title}</strong>
      {long ? <details><summary>Technical detail</summary><pre>{message}</pre></details> : <p>{message}</p>}
      {onRetry ? <button className="secondary" data-size="sm" onClick={onRetry}>{retryLabel}</button> : null}
    </div>
  </div>;
}

/** Custom forensic transport shared by video and audio. Native controls stay off. */
function MediaControls({ media, element, filmstrip, onSeek, onExactStep, exactBusy }: { media: React.RefObject<HTMLMediaElement | null>; element: HTMLMediaElement | null; filmstrip: { artifact: string; time: number }[] | null; onSeek: (time: number) => void; onExactStep?: (direction:'previous'|'next')=>void; exactBusy?:boolean }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loopA, setLoopA] = useState<number | null>(null);
  const [loopB, setLoopB] = useState<number | null>(null);
  useEffect(() => {
    if (!element) return;
    const onTime = () => {
      if (Number.isFinite(element.currentTime)) setTime(element.currentTime);
      if (loopA !== null && loopB !== null && loopA >= 0 && loopA < loopB && Number.isFinite(loopB) && element.currentTime >= loopB) element.currentTime = loopA;
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => setDuration(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0);
    onTime();onMeta();setPlaying(!element.paused);setRate(element.playbackRate);setMuted(element.muted);
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
  }, [element, loopA, loopB]);
  const toggle = () => { const element = media.current; if (!element) return; if (element.paused) void element.play(); else element.pause(); };
  const skip = (amount: number) => { const element = media.current; if (!element || !Number.isFinite(element.currentTime) || !Number.isFinite(element.duration) || element.duration <= 0) return; onSeek(Math.max(0, Math.min(element.duration, element.currentTime + amount))); };
  const frame = (amount: number) => skip(amount * APPROXIMATE_STEP_SECONDS);
  const applyRate = (next: number) => { setRate(next); if (media.current) media.current.playbackRate = next; };
  const toggleMute = () => { const element = media.current; if (!element) return; element.muted = !element.muted; setMuted(element.muted); };
  const markA = () => { const value=media.current?.currentTime; if (value===undefined || !Number.isFinite(value) || value<0) return;setLoopA(value);if(loopB!==null && value>=loopB)setLoopB(null); };
  const markB = () => { const value=media.current?.currentTime; if (value===undefined || !Number.isFinite(value) || value<0) return;setLoopB(value);if(loopA!==null && value<=loopA)setLoopA(null); };
  return <div className="media-controls" onKeyDown={event => {
    const target=event.target as HTMLElement;
    if (target.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (event.key === ' ' || event.key === 'k') { event.preventDefault(); toggle(); }
    else if (event.key === 'j') skip(-10);
    else if (event.key === 'l') skip(10);
    else if (event.key === 'ArrowLeft') { event.preventDefault(); skip(event.shiftKey ? -1 : -5); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); skip(event.shiftKey ? 1 : 5); }
    else if (event.key === ',') frame(-1);
    else if (event.key === '.') frame(1);
    else if (event.key === '[') markA();
    else if (event.key === ']') markB();
  }} tabIndex={0} role="group" aria-label="Playback controls — space to play, J K L to shuttle, comma and period for approximate time steps">
    <div className="media-progress">
      <span className="media-time mono">{formatClockMs(time)}</span>
      <div className="media-seek">
        <input
          aria-label="Seek position"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(time, duration || 0)}
          onChange={event => onSeek(Number(event.target.value))}
          style={loopA !== null && loopB !== null && loopA < loopB && duration > 0 ? { '--loop-a': `${(loopA / duration) * 100}%`, '--loop-b': `${(loopB / duration) * 100}%` } as React.CSSProperties : undefined}
        />
        {loopA !== null && loopB !== null && loopB > loopA ? <span className="loop-range" style={{ left: `${(loopA / (duration || 1)) * 100}%`, width: `${((loopB - loopA) / (duration || 1)) * 100}%` }} /> : null}
      </div>
      <span className="media-duration mono">{formatClockMs(duration)}</span>
    </div>
    {filmstrip?.length ? <div className="filmstrip" aria-label="Filmstrip of sampled frames">
      {filmstrip.map(frameSample => <Tooltip key={frameSample.artifact} text={`Jump to ${formatClockMs(frameSample.time)}`}>
        <button onClick={() => onSeek(frameSample.time)} aria-label={`Jump to ${formatClockMs(frameSample.time)}`}><img src={evidenceUrl(`artifact/${frameSample.artifact}`)} alt="" loading="lazy" /></button>
      </Tooltip>)}
    </div> : null}
    <div className="media-buttons">
      <div className="media-group">
        <Tooltip text="Back 10 seconds (J)"><button className="icon-button" aria-label="Back 10 seconds" onClick={() => skip(-10)}><ChevronsLeft size={16} /></button></Tooltip>
        <Tooltip text="Back about 33 ms (,)"><button className="icon-button" aria-label="Back about 33 milliseconds" onClick={() => frame(-1)}><SkipBack size={15} /></button></Tooltip>
        <button className="media-play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
        <Tooltip text="Forward about 33 ms (.)"><button className="icon-button" aria-label="Forward about 33 milliseconds" onClick={() => frame(1)}><SkipForward size={15} /></button></Tooltip>
        <Tooltip text="Forward 10 seconds (L)"><button className="icon-button" aria-label="Forward 10 seconds" onClick={() => skip(10)}><ChevronsRight size={16} /></button></Tooltip>
      </div>
      {onExactStep ? <div className="media-group media-exact" role="group" aria-label="Exact decoded frames">
        <span className="media-group-label" aria-hidden="true">Decoded frame</span>
        <Tooltip text="Inspect previous decoded frame"><button className="icon-button" aria-label="Inspect previous decoded frame" disabled={exactBusy} onClick={()=>onExactStep('previous')}><StepBack size={15} /></button></Tooltip>
        <Tooltip text="Inspect next decoded frame"><button className="icon-button" aria-label="Inspect next decoded frame" disabled={exactBusy} onClick={()=>onExactStep('next')}><StepForward size={15} /></button></Tooltip>
      </div> : null}
      <div className="spacer" />
      <div className="media-group">
        <Tooltip text={loopA !== null ? `Loop start ${formatClockMs(loopA)} ([)` : 'Mark loop start ([)'}><button className={`media-loop ${loopA !== null ? 'active' : ''}`} aria-label="Mark loop start" onClick={markA}>A</button></Tooltip>
        <Tooltip text={loopB !== null ? `Loop end ${formatClockMs(loopB)} (])` : 'Mark loop end (])'}><button className={`media-loop ${loopB !== null ? 'active' : ''}`} aria-label="Mark loop end" onClick={markB}>B</button></Tooltip>
        {loopA !== null || loopB !== null ? <>
          <span className="media-loop-range mono">{loopA !== null ? formatClockMs(loopA) : '—'} → {loopB !== null ? formatClockMs(loopB) : '—'}</span>
          <button className="quiet" onClick={() => { setLoopA(null); setLoopB(null); }}>Clear loop</button>
        </> : null}
      </div>
      <div className="media-group">
        <label className="media-rate">Speed
          <select aria-label="Playback speed" value={rate} onChange={event => applyRate(Number(event.target.value))}>
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        <Tooltip text={muted ? 'Unmute' : 'Mute'}><button className="icon-button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button></Tooltip>
      </div>
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
    const prefetch = new IntersectionObserver(entries => {if(entries.some(entry=>entry.isIntersecting))ensure(index);}, { rootMargin: '700px 0px', threshold: 0 });
    const visible = new IntersectionObserver(entries => {if(entries.some(entry=>entry.isIntersecting&&entry.intersectionRatio>=0.4))onVisible(index);}, { rootMargin: '0px', threshold: 0.4 });
    prefetch.observe(node);visible.observe(node);
    return () => {prefetch.disconnect();visible.disconnect();};
  }, [index, ensure, onVisible]);
  // The page label sits in the gap below the paper so it never overlays original page pixels.
  return <div className="pdf-page-frame">
    <div className="pdf-page" ref={node => { ref.current = node; register(index, node); }} data-page={index} style={{ aspectRatio: `${ratio}` }}>
      {artifact ? <img src={evidenceUrl(`artifact/${artifact}`)} alt={`Page ${index}`} loading="lazy" draggable={false} /> : <div className="pdf-page-skeleton" aria-hidden="true"><Skeleton /><Skeleton /><Skeleton /></div>}
    </div>
    <span className="pdf-page-label mono" aria-hidden="true">{index}</span>
  </div>;
}

type SourceView = 'original' | 'redaction';
type ErrorOrigin = 'text' | 'pdf' | 'office' | 'artifact' | 'locator' | 'media' | 'frame' | 'image';
type DockTool = 'transcript' | 'discovery';

export default function EvidenceViewer({ source, locator, run, refresh, onLocatorSelect, onAsk, caseId, sessionEpoch }: { source: Source; locator?: string; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void>; onLocatorSelect: (locator: string) => void; onAsk?: () => void; caseId?:string; sessionEpoch?:number }) {
  const tabPrefix = useId();
  const media = useRef<HTMLMediaElement | null>(null);
  const [mediaElement,setMediaElement]=useState<HTMLMediaElement|null>(null);
  const bindMedia=useCallback((node:HTMLMediaElement|null)=>{media.current=node;setMediaElement(node);},[]);
  const displayedFrameTime=useRef<number|null>(null);
  useEffect(()=>{
    displayedFrameTime.current=null;
    if(!(mediaElement instanceof HTMLVideoElement) || !mediaElement.requestVideoFrameCallback)return;
    let active=true;let callback=0;
    const observe=(_now:number,metadata:VideoFrameCallbackMetadata)=>{if(!active)return;if(Number.isFinite(metadata.mediaTime))displayedFrameTime.current=metadata.mediaTime;callback=mediaElement.requestVideoFrameCallback(observe);};
    callback=mediaElement.requestVideoFrameCallback(observe);
    return()=>{active=false;mediaElement.cancelVideoFrameCallback?.(callback);};
  },[mediaElement]);
  const [currentTime, setCurrentTime] = useState(0);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  useEffect(() => { if (pendingSeek !== null && media.current?.readyState) { media.current.currentTime = pendingSeek; setCurrentTime(pendingSeek); setPendingSeek(null); } }, [pendingSeek]);
  const requestedTime = locator?.startsWith('time:') ? Number(locator.slice(5)) : null;
  const pinnedText = parsePinnedTextLocator(locator);
  const requestedRevision = pinnedText?.revision ?? null;
  const requestedPage = locator?.startsWith('page:') ? Number(locator.slice(5)) : null;
  const cited = citedLineRange(locator);
  const [page, setPage] = useState<TextPage | null>(null);
  const [error, setError] = useState('');
  // Which request produced the current error, so a retry re-issues exactly that request (and only when one exists).
  const [errorOrigin, setErrorOrigin] = useState<ErrorOrigin | null>(null);
  const fail = (origin: ErrorOrigin, reason: unknown) => { setError(String(reason)); setErrorOrigin(origin); };
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
  const [exactFrame,setExactFrame]=useState<{artifact:string;locator:string;time:number;pts:number;timeBase:string}|null>(null);
  const [exactBusy,setExactBusy]=useState(false);
  const exactRequest=useRef(0);
  const filmstripWindow = Number.isFinite(currentTime) && currentTime >= 0 ? Math.floor(currentTime / 120) : 0;
  const [askChip, setAskChip] = useState<{ x: number; y: number; a: number; b: number; revision: number } | null>(null);
  // Retry counters: each one re-issues exactly the request that failed.
  const [textReload, setTextReload] = useState(0);
  const [officeReload, setOfficeReload] = useState(0);
  const [pdfReload, setPdfReload] = useState(0);
  const [artifactReload, setArtifactReload] = useState(0);
  // Viewer sub-views: original vs. redaction for pages/images, and the tool dock under recordings.
  const redactable = ['pdf', 'image'].includes(source.kind) && !source.restricted;
  const isMedia = ['video', 'audio'].includes(source.kind);
  const [view, setView] = useState<SourceView>('original');
  const [dockTool, setDockTool] = useState<DockTool>('transcript');
  const [dockOpen, setDockOpen] = useState(true);
  useEffect(() => { setView('original'); }, [locator]);

  // PDF continuous-scroll state
  const [pdfCount, setPdfCount] = useState<number | null>(null);
  const [pdfPage, setPdfPage] = useState(requestedPage ?? 1);
  const [pdfPageInput, setPdfPageInput] = useState<string | null>(null);
  const ignorePdfBlur = useRef(false);
  const [pdfVisiblePage,setPdfVisiblePage]=useState<number|null>(null);
  const [pdfArtifacts, setPdfArtifacts] = useState<Record<number, string>>({});
  const [pdfRatios, setPdfRatios] = useState<Record<number,number>>({});
  const pdfPending = useRef<Set<number>>(new Set());
  const pdfEpoch=useRef(0);
  const pdfPagesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(()=>{
    const epoch=++pdfEpoch.current;
    pdfPending.current=new Set();setPdfCount(null);setPdfArtifacts({});setPdfRatios({});setPdfPage(1);setPdfVisiblePage(null);
    if(source.kind!=='pdf')return;
    void api<{metadata:{page_count:number;first_page_size_points:[number,number]}}>('probe_pdf',{case_id:caseId,session_epoch:sessionEpoch,source_id:source.id}).then(result=>{
      if(epoch!==pdfEpoch.current)return;
      const count=result.metadata.page_count;
      if(!Number.isSafeInteger(count)||count<1||count>100_000)throw new Error('PDF page count is invalid.');
      setPdfCount(count);
      const [width,height]=result.metadata.first_page_size_points ?? [];
      if(Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0)setPdfRatios({1:width/height});
      if(requestedPage!==null && (!Number.isSafeInteger(requestedPage)||requestedPage<1||requestedPage>count))fail('locator','Requested physical PDF page is outside this document.');
    }).catch(reason=>{if(epoch===pdfEpoch.current)fail('pdf',reason);});
    return()=>{pdfEpoch.current++;};
  },[caseId,sessionEpoch,source.id,source.kind,pdfReload]);
  const ensurePage = useCallback((target: number) => {
    if(pdfCount===null || !Number.isSafeInteger(target)||target<1||target>pdfCount||pdfArtifacts[target]||pdfPending.current.has(target))return;
    const epoch=pdfEpoch.current;const pending=pdfPending.current;pending.add(target);
    void api<{ published: { artifact_id: string; metadata: { page:number;page_count: number; page_size_points?: [number, number] } }[]; limitations: string[] }>('render_page', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id, page: target })
      .then(result => {
        if(epoch!==pdfEpoch.current)return;
        const published=result.published[0];
        if(!published||published.metadata.page!==target||published.metadata.page_count!==pdfCount)throw new Error('PDF page response does not match the requested document geometry.');
        setPdfArtifacts(existing => ({ ...existing, [target]: published.artifact_id }));
        const size=published.metadata.page_size_points;
        if(size&&Number.isFinite(size[0])&&Number.isFinite(size[1])&&size[0]>0&&size[1]>0)setPdfRatios(current=>({...current,[target]:size[0]/size[1]}));
        setLimitations(result.limitations);
      })
      .catch(reason => {if(epoch===pdfEpoch.current)fail('pdf',reason);})
      .finally(() => pending.delete(target));
  }, [caseId,sessionEpoch,source.id,pdfCount,pdfArtifacts]);

  useEffect(() => {
    if(pdfCount===null)return;
    const target=requestedPage??1;
    if(!Number.isSafeInteger(target)||target<1||target>pdfCount)return;
    setPdfPage(target);
    requestAnimationFrame(()=>pdfPagesRef.current.get(target)?.scrollIntoView?.({block:'start'}));
  }, [requestedPage, source.id,pdfCount]);
  useEffect(()=>{
    setPdfArtifacts(current=>Object.fromEntries(Object.entries(current).filter(([page])=>Math.abs(Number(page)-pdfPage)<=20)));
    setPdfRatios(current=>Object.fromEntries(Object.entries(current).filter(([page])=>Number(page)===1||Math.abs(Number(page)-pdfPage)<=20)));
  },[pdfPage]);
  const onPdfVisible=useCallback((page:number)=>{setPdfPage(page);setPdfVisiblePage(page);},[]);

  // Publish what the viewer is looking at for the composer context (no DOM scraping).
  useEffect(() => {
    if (source.kind === 'pdf') setViewerContext(pdfVisiblePage===null?{sourceId:source.id}:{ sourceId: source.id, page: pdfVisiblePage });
    else if (['video', 'audio'].includes(source.kind)) setViewerContext({ sourceId: source.id, timeSeconds: currentTime });
    else if (showText) setViewerContext({ sourceId: source.id, lineStart: start });
    else setViewerContext({ sourceId: source.id });
    return () => { setViewerContext(null); };
  }, [source.id, source.kind, pdfVisiblePage, currentTime, showText, start]);
  useEffect(() => () => setViewerContext(null), [source.id]);

  useEffect(() => {
    if (!needsProxy || source.kind !== 'video') return;
    let active = true; setProcessing(true); setError('');
    api<{ artifact_id: string }>('playback_proxy', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id }).then(result => { if (active) setPlayback(result.artifact_id); }).catch(e => { if (active) fail('media', e); }).finally(() => { if (active) setProcessing(false); });
    return () => { active = false; };
  }, [source.id, needsProxy]);

  useEffect(() => {
    if (!officeDocument || locator) return;
    let active = true;
    setProcessing(true);
    api<{ limitations: string[] }>('process_source', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id }).then(result => { if (active) { setShowText(true); setLimitations(result.limitations); void refresh(); } }).catch(e => { if (active) fail('office', e); }).finally(() => { if (active) setProcessing(false); });
    return () => { active = false; };
  }, [source.id, locator, officeDocument, officeReload]);

  useEffect(() => {
    let active = true; setArtifactText(null); setDerivedMime('');
    if (derived) api<{ mime: string; content: { pages?: { locator: string; text: string }[]; limitations?: string[] } | null }>('artifact_info', { artifact_id: derived }).then(info => {
      if (!active) return; setDerivedMime(info.mime); setError('');
      if (info.mime === 'application/json') {
        const units = info.content?.pages ?? [];
        setArtifactText(units.slice(0, 200).map(unit => `[${unit.locator}]\n${unit.text}`).join('\n\n') + (units.length > 200 ? `\n\nShowing 200 of ${units.length} units. Use the extracted-text viewer for paginated access.` : ''));
        setLimitations(info.content?.limitations ?? []);
      }
    }).catch(e => { if (active) fail('artifact', e); });
    return () => { active = false; };
  }, [derived, artifactReload]);

  useEffect(() => {
    if (locator?.startsWith('L')) { setShowText(true); setDerived(null); setStart(Number(/^L(\d+)/.exec(locator ?? '')?.[1] ?? 1)); }
    else if (parsePinnedTextLocator(locator)) { setShowText(true); setDerived(null); setStart(parsePinnedTextLocator(locator)!.start); }
    else if (locator?.startsWith('artifact:')) { setDerived(locator.slice(9)); setShowText(false); }
    else { setDerived(null); setShowText(source.kind === 'text' || (source.kind === 'other' && source.status.startsWith('text'))); setStart(1); }
  }, [locator, source.id, source.kind, source.status]);

  useEffect(() => { exactRequest.current++;setZoom(1); setRotation(0); setError(''); setExactFrame(null);setExactBusy(false); }, [source.id]);

  useEffect(() => {
    let active = true; setPage(null);
    if (showText) {
      const request = requestedRevision !== null
        ? api<TextPage>('read_extract_revision', { source_id: source.id, revision: requestedRevision, start, count: 200 })
        : api<TextPage>('read_text', { source_id: source.id, start, count: 200 });
      request.then(value => { if (active) { setPage(value); setError(''); } }).catch(e => { if (active) fail('text', e); });
    }
    return () => { active = false; };
  }, [source.id, source.kind, start, showText, source.status, requestedRevision, textReload]);

  useEffect(() => {
    if (requestedTime != null && media.current?.readyState && Number.isFinite(requestedTime)) media.current.currentTime = requestedTime;
  }, [requestedTime]);

  useEffect(() => {
    if (source.kind !== 'video' || source.restricted) return;
    let active = true;
    api<{ samples: { artifact_id: string; metadata: { playback_seconds: number } }[] }>('browse_video_discovery', { source_id: source.id, kind: 'video_overview', start: Math.max(0,filmstripWindow*120-30), end: (filmstripWindow+1)*120+30, offset: 0, query: '' })
      .then(result => { if (active) setFilmstrip(result.samples.slice(0, 22).map(sample => ({ artifact: sample.artifact_id, time: sample.metadata.playback_seconds })).filter(sample => Number.isFinite(sample.time) && sample.time >= 0)); })
      .catch(() => { if(active)setFilmstrip(null); });
    return () => { active = false; };
  }, [source.id, source.restricted, filmstripWindow]);

  const url = evidenceUrl(source.id);
  const playbackUrl = playback ? evidenceUrl(`artifact/${playback}`) : url;
  const onTimeUpdate = (event: React.SyntheticEvent<HTMLMediaElement>) => setCurrentTime(event.currentTarget.currentTime);
  const onLoadedMetadata = () => {
    if (pendingSeek !== null && media.current) { media.current.currentTime = pendingSeek; setPendingSeek(null); }
    else if (requestedTime != null && Number.isFinite(requestedTime) && media.current) media.current.currentTime = requestedTime;
  };
  async function stepExact(direction:'previous'|'next') {
    const target=exactFrame?.time ?? displayedFrameTime.current ?? media.current?.currentTime;
    if (exactBusy || target===undefined || !Number.isFinite(target) || target<0) return;
    const request=++exactRequest.current;
    setExactBusy(true);media.current?.pause();
    try {
      const value=await api<{published:{artifact_id:string;locator:string;metadata:{source_relative_seconds:number;pts:number;time_base:string}}[]}>('step_video_frame',{case_id:caseId,session_epoch:sessionEpoch,source_id:source.id,target,direction});
      if(request!==exactRequest.current)return;
      const item=value.published[0];
      if (!item || !Number.isFinite(item.metadata.source_relative_seconds) || !Number.isFinite(item.metadata.pts)) throw new Error('The decoder did not return a timestamped frame.');
      setExactFrame({artifact:item.artifact_id,locator:item.locator,time:item.metadata.source_relative_seconds,pts:item.metadata.pts,timeBase:item.metadata.time_base});
      if(media.current)media.current.currentTime=item.metadata.source_relative_seconds;
      setCurrentTime(item.metadata.source_relative_seconds);
      setError('');
    } catch(e) {if(request===exactRequest.current)fail('frame',e);}
    finally {if(request===exactRequest.current)setExactBusy(false);}
  }

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

  const pdfWindowStart=pdfCount===null?1:Math.max(1,pdfPage-6);
  const pdfWindowEnd=pdfCount===null?0:Math.min(pdfCount,pdfPage+6);
  const pdfApproxRatio=pdfRatios[pdfPage]??pdfRatios[1]??8.5/11;
  const scrollToPdfPage=(target:number)=>{
    if(pdfCount===null||!Number.isSafeInteger(target)||target<1||target>pdfCount)return;
    setPdfPage(target);
    requestAnimationFrame(()=>pdfPagesRef.current.get(target)?.scrollIntoView?.({behavior:'smooth',block:'start'}));
  };
  const commitPdfPage=()=>{
    if(pdfPageInput!==null && /^\d+$/.test(pdfPageInput.trim()))scrollToPdfPage(Number(pdfPageInput.trim()));
    setPdfPageInput(null);
  };

  const onOriginal = view === 'original';
  // Files without an inline preview explain themselves first; any failure detail follows below.
  const unsupported = !showText && !derived && source.kind === 'other' && !processing;
  const problemTitle = errorOrigin === 'artifact' ? 'This derived view could not open' : showText ? 'Extracted text is not available' : source.kind === 'pdf' ? 'This PDF could not be displayed' : source.kind === 'video' ? 'This recording could not be played' : source.kind === 'audio' ? 'This audio could not be played' : officeDocument ? 'Document text could not be extracted' : 'This preview could not open';
  // Only failures with a matching reload counter offer a retry; the retry re-issues that request alone.
  const retries: Partial<Record<ErrorOrigin, { label: string; run: () => void }>> = {
    text: { label: 'Read text again', run: () => setTextReload(value => value + 1) },
    pdf: { label: 'Reload pages', run: () => setPdfReload(value => value + 1) },
    office: { label: 'Retry extraction', run: () => setOfficeReload(value => value + 1) },
    artifact: { label: 'Reload derived view', run: () => setArtifactReload(value => value + 1) },
  };
  const retryEntry = errorOrigin ? retries[errorOrigin] : undefined;
  const retry = retryEntry ? () => { setError(''); setErrorOrigin(null); retryEntry.run(); } : undefined;
  const retryLabel = retryEntry?.label;
  // The source tab names what the canvas actually shows: extracted text and derivatives are not the original.
  const sourceTabLabel = showText ? 'Extracted text' : derived ? 'Derived view' : source.kind === 'pdf' ? 'Original pages' : 'Original image';
  const sourceViews = redactable ? [
    { id: 'original' as const, label: sourceTabLabel, icon: <SourceIcon kind={source.kind} size={14} /> },
    { id: 'redaction' as const, label: 'Redaction', icon: <SquareDashedMousePointer size={14} aria-hidden="true" /> },
  ] : [];
  const dockTools = isMedia ? [
    { id: 'transcript' as const, label: 'Transcript', icon: <Captions size={14} aria-hidden="true" /> },
    ...(source.kind === 'video' && !source.restricted ? [{ id: 'discovery' as const, label: 'Visual discovery', icon: <ScanSearch size={14} aria-hidden="true" /> }] : []),
  ] : [];
  // The canvas scrolls, so it is focusable for keyboard scrolling; it is the Original tab panel when tabs exist.
  const canvasPanel = redactable ? tabPanelProps(tabPrefix, 'original', onOriginal) : { role: 'region' as const, 'aria-label': 'Source content' };

  return <div className="viewer" data-kind={source.kind}>
    <header className="viewer-source-header">
      <span className="viewer-source-icon"><SourceIcon kind={source.kind} size={17} /></span>
      <div className="viewer-source-identity">
        <strong title={source.name}>{source.name}</strong>
        <div className="viewer-source-meta">
          <span className="viewer-source-facts">{source.kind.toUpperCase()} · {formatBytes(source.size)} · {source.status}</span>
          {source.sha256 ? <Tooltip text={`SHA-256 ${source.sha256}`}><span className="viewer-hash mono" tabIndex={0}><Fingerprint size={12} aria-hidden="true" />{shortHash(source.sha256)}</span></Tooltip> : null}
          {page ? <span className={`viewer-revision ${page.historical ? 'historical' : ''}`}>{page.historical ? <><History size={12} aria-hidden="true" />Pinned rev {page.revision}</> : <>Rev {page.revision} · current</>}</span> : null}
        </div>
      </div>
      <div className="viewer-source-actions">
        {source.restricted ? <Tooltip text={RESTRICTED_WHY}><span className="viewer-restricted" role="status" aria-label="Restricted" tabIndex={0}><Lock size={12} aria-hidden="true" />Restricted</span></Tooltip> : null}
        {source.sha256 ? <CopyAction label="Copy SHA-256 hash" value={() => source.sha256} icon={<Fingerprint size={16} aria-hidden="true" />} run={run} /> : null}
        {page ? <CopyAction label="Copy evidence link" value={() => page.locator} icon={<Link2 size={16} aria-hidden="true" />} run={run} /> : null}
      </div>
    </header>

    {sourceViews.length ? <div className="viewer-tabbar">
      <ViewerTabs tabs={sourceViews} value={view} onChange={setView} label="Source views" prefix={tabPrefix} />
    </div> : null}

    {source.kind === 'image' && onOriginal ? <div className="viewer-toolbar image-controls">
      <Tooltip text="Zoom out"><button className="icon-button" aria-label="Zoom out" onClick={() => setZoom(value => Math.max(0.25, value - 0.25))}><ZoomOut size={16} /></button></Tooltip>
      <span className="viewer-zoom mono" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <Tooltip text="Zoom in"><button className="icon-button" aria-label="Zoom in" onClick={() => setZoom(value => Math.min(6, value + 0.25))}><ZoomIn size={16} /></button></Tooltip>
      <Tooltip text="Fit width"><button className="quiet" onClick={() => setZoom(1)}>Fit</button></Tooltip>
      <span className="toolbar-divider" aria-hidden="true" />
      <Tooltip text="Rotate view"><button className="icon-button" aria-label="Rotate view" onClick={() => setRotation(value => value + 90)}><RotateCw size={16} /></button></Tooltip>
      <span className="viewer-toolbar-note">View only · the original is unchanged</span>
    </div> : null}

    {source.kind === 'pdf' && onOriginal ? <div className="viewer-toolbar pdf-navigation">
      <Tooltip text="Previous physical page"><button className="icon-button" aria-label="Previous page" disabled={pdfCount===null||pdfPage<=1} onClick={() => scrollToPdfPage(pdfPage-1)}><ChevronsLeft size={16} /></button></Tooltip>
      <label className="pdf-page-input">Page
        <input
          type="number" min={1} max={pdfCount ?? undefined} value={pdfPageInput ?? pdfPage} disabled={pdfCount===null}
          aria-label="Current page"
          onChange={event => setPdfPageInput(event.target.value)}
          onBlur={()=>{if(ignorePdfBlur.current){ignorePdfBlur.current=false;return;}commitPdfPage();}}
          onKeyDown={event => {
            if(event.key==='Enter'){event.preventDefault();commitPdfPage();event.currentTarget.blur();}
            if(event.key==='Escape'){event.preventDefault();ignorePdfBlur.current=true;setPdfPageInput(null);event.currentTarget.blur();}
          }} />
      </label>
      <span className="pdf-page-count">{pdfCount ? `of ${pdfCount} physical pages` : 'Checking page count…'}</span>
      <Tooltip text="Next physical page"><button className="icon-button" aria-label="Next page" disabled={pdfCount===null||pdfPage>=pdfCount} onClick={() => scrollToPdfPage(pdfPage+1)}><ChevronsRight size={16} /></button></Tooltip>
      <div className="spacer" />
      <button className="quiet" disabled={pdfCount===null} onClick={() => run(async () => { await navigator.clipboard.writeText(`evidence:${source.id}#page:${pdfPage}`); })}><Link2 size={14} aria-hidden="true" />Copy page navigation link (not a citation)</button>
    </div> : null}

    <div className={`source-canvas ${source.kind}`} tabIndex={0} {...canvasPanel}>
      {processing ? <div className="preview-progress" role="status"><span className="activity-dot" aria-hidden="true" />{needsProxy ? 'Opening video…' : 'Opening source…'}</div> : null}
      {error && !unsupported ? <ViewerProblem title={problemTitle} message={error} onRetry={retry} retryLabel={retryLabel} /> : null}

      {showText && page?.historical ? <div className="viewer-pinned-banner" role="note">
        <History size={16} aria-hidden="true" />
        <div><strong>Pinned revision {page.revision} — not the current text</strong><span>Historical extraction revision {page.revision} — superseded wording preserved; this is not the current active text.</span></div>
      </div> : null}
      {showText && page === null && !error ? <div className="document-page document-page-loading" role="status" aria-label="Loading extracted text">
        <Skeleton className="skeleton-title" />
        {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className={index % 3 === 2 ? 'skeleton-short' : ''} />)}
      </div> : null}
      {showText && page ? <article className="document-page" onMouseUp={onTextSelect}>
        <h2>{source.name.replace(/^\d+ · /, '')}</h2>
        <p className="document-provenance">Extracted text · Revision {page.revision} · Lines {page.start}–{page.end} of {page.total_lines}</p>
        {cited ? <p className="document-cited"><span className="document-cited-mark" aria-hidden="true" />Cited lines L{cited.start}–L{cited.end} are marked</p> : null}
        <div className="doc-rule" />
        {page.text === '' && page.total_lines === 0 ? <p className="document-empty">No text was extracted from this source. This does not establish that the original contains no text.</p> : null}
        <div className="text-lines">
          {page.text.split('\n').map((line, index) => {
            const number = start + index;
            const isCited = !!cited && number >= cited.start && number <= cited.end;
            return <div className={`text-line${isCited ? ' cited' : ''}`} data-line={number} data-cited={isCited || undefined} key={index}><span className="line-number">{number}</span><span>{line || ' '}</span></div>;
          })}
        </div>
      </article> : null}

      {artifactText !== null ? <article className="document-page">
        <h2>{source.name}</h2>
        <p className="document-provenance">Derived text units · not the original file</p>
        <div className="doc-rule" />
        <pre className="artifact-text">{artifactText || 'No text segments were returned. This does not establish absence of speech.'}</pre>
        <button className="secondary" data-size="sm" onClick={() => { setDerived(null); setShowText(false); }}>Back to original</button>
      </article> : null}

      {!showText && ((!derived && source.kind === 'image') || (derived && derivedMime === 'image/jpeg')) ? <div className="image-stage">
        {derived ? <p className="derived-label"><Info size={13} aria-hidden="true" />Derived frame or crop — not the original file</p> : null}
        <img
          className="evidence-image"
          src={derived ? evidenceUrl(`artifact/${derived}`) : url}
          alt={`${derived ? 'Derived frame or crop' : 'Original evidence'}: ${source.name}`}
          style={{ width: zoom === 1 ? '100%' : `${zoom * 100}%`, maxWidth: 'none', transform: rotation ? `rotate(${rotation}deg)` : undefined }}
          onDoubleClick={() => setZoom(value => value === 1 ? 2 : 1)}
          onError={() => {
            if (derived) { fail('image', 'Image preview failed.'); return; }
            setProcessing(true);
            void api<{ published: unknown[] }>('process_source', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id }).then(result => { setDerived((result.published as { artifact_id?: string }[])?.[0]?.artifact_id ?? null); }).catch(e => fail('image', e)).finally(() => setProcessing(false));
          }} />
        {derived && source.kind === 'video' ? <button className="secondary back-source" data-size="sm" onClick={() => setDerived(null)}>Back to recording</button> : null}
      </div> : null}

      {!showText && !derived && source.kind === 'video' ? <video
        ref={bindMedia}
        onTimeUpdate={onTimeUpdate}
        onPlay={()=>{exactRequest.current++;setExactFrame(null);setExactBusy(false);}}
        onLoadedMetadata={onLoadedMetadata}
        key={playbackUrl}
        src={needsProxy && !playback ? undefined : playbackUrl}
        controls={false} playsInline preload="metadata"
        onError={() => { if (!needsProxy) setNeedsProxy(true); else if (playback) fail('media', 'Playback derivative could not be decoded. Original frames remain available.'); }}
      /> : null}

      {!showText && !derived && source.kind === 'audio' ? <div className="audio-stage">
        <span className="audio-stage-icon"><Volume2 size={26} aria-hidden="true" /></span>
        <h2 title={source.name}>{source.name}</h2>
        <p className="small muted">{formatBytes(source.size)} · {source.status}</p>
        <audio ref={bindMedia} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} src={url} controls={false} preload="metadata" onError={() => fail('media', 'This audio format is not supported by the installed viewer.')} />
      </div> : null}

      {!showText && !derived && source.kind === 'other' && !processing ? <div className="empty-state viewer-empty">
        <FileQuestion size={20} aria-hidden="true" />
        <h3>{officeDocument ? 'Document preview could not open' : 'Original file preserved'}</h3>
        <p>{officeDocument ? 'See the error below, then reopen the file to retry extraction.' : 'This file format does not yet have an inline preview.'}</p>
      </div> : null}
      {error && unsupported ? <ViewerProblem title={problemTitle} message={error} onRetry={retry} retryLabel={retryLabel} /> : null}

      {!showText && !derived && source.kind === 'pdf' && pdfCount===null && !error ? <div className="document-page document-page-loading" role="status" aria-label="Checking page count">
        <Skeleton className="skeleton-title" />
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className={index % 3 === 2 ? 'skeleton-short' : ''} />)}
      </div> : null}
      {!showText && !derived && source.kind === 'pdf' && pdfCount!==null ? <div className="pdf-continuous">
        {pdfWindowStart>1?<div className="pdf-page-spacer" style={{width:'min(820px, 100%)',aspectRatio:`${pdfApproxRatio/(pdfWindowStart-1)}`}} aria-hidden="true"/>:null}
        {Array.from({ length: pdfWindowEnd-pdfWindowStart+1 }, (_, index) => pdfWindowStart+index).map(pageNumber => <PdfPageView
          key={pageNumber}
          index={pageNumber}
          ratio={pdfRatios[pageNumber]??pdfApproxRatio}
          artifact={pdfArtifacts[pageNumber] || undefined}
          ensure={ensurePage}
          onVisible={onPdfVisible}
          register={(number, node) => { if (node) pdfPagesRef.current.set(number, node); else pdfPagesRef.current.delete(number); }}
        />)}
        {pdfWindowEnd<pdfCount?<div className="pdf-page-spacer" style={{width:'min(820px, 100%)',aspectRatio:`${pdfApproxRatio/(pdfCount-pdfWindowEnd)}`}} aria-hidden="true"/>:null}
      </div> : null}
    </div>

    {redactable ? <div className="viewer-tool-view" {...tabPanelProps(tabPrefix, 'redaction', view === 'redaction')}>
      <RedactionPanel caseId={caseId} sessionEpoch={sessionEpoch} sourceId={source.id} kind={source.kind} />
    </div> : null}

    {askChip ? <div className="ask-chip" style={{ left: askChip.x, top: askChip.y }} role="toolbar" aria-label="Selection actions">
      <button onClick={() => { onLocatorSelect(`R${askChip.revision}L${askChip.a}-L${askChip.b}`); setAskChip(null); if (onAsk) onAsk(); else window.dispatchEvent(new CustomEvent('vislex:focus-composer')); }}><AArrowDown size={13} />Ask about L{askChip.a}–L{askChip.b}</button>
      <button onClick={() => { void navigator.clipboard.writeText(`evidence:${source.id}#R${askChip.revision}L${askChip.a}-L${askChip.b}`); setAskChip(null); }}>Copy citation (rev {askChip.revision})</button>
    </div> : null}

    {isMedia && !showText && !derived ? <MediaControls media={media} element={mediaElement} filmstrip={source.kind === 'video' ? filmstrip : null} onExactStep={source.kind==='video'?direction=>{void stepExact(direction);}:undefined} exactBusy={exactBusy} onSeek={time => { exactRequest.current++;displayedFrameTime.current=null;setExactBusy(false);setExactFrame(null);if (media.current) { media.current.currentTime = time; setCurrentTime(time); } }} /> : null}
    {source.kind==='video' && exactFrame && !showText && !derived ? <div className="exact-frame-inspection" role="region" aria-label="Exact decoded frame">
      <img src={evidenceUrl(`artifact/${exactFrame.artifact}`)} alt={`Decoded frame at source time ${formatClockMs(exactFrame.time)}`} />
      <div className="exact-frame-facts">
        <p>Decoded source frame at {formatClockMs(exactFrame.time)} · PTS {exactFrame.pts} × {exactFrame.timeBase}. This image is a derivative of one frame.</p>
        <button className="secondary" data-size="sm" onClick={()=>void navigator.clipboard.writeText(exactFrame.locator)}><Link2 size={14} aria-hidden="true" />Copy frame citation</button>
      </div>
    </div> : null}
    {isMedia ? <section className={`viewer-dock ${dockOpen ? 'open' : 'collapsed'}`} aria-label="Recording tools">
      <div className="viewer-dock-bar">
        {dockTools.length > 1
          ? <ViewerTabs tabs={dockTools} value={dockTool} onChange={tool => { setDockTool(tool); setDockOpen(true); }} label="Recording tools" prefix={`${tabPrefix}dock`} />
          : <span className="viewer-dock-title"><Captions size={14} aria-hidden="true" />Transcript</span>}
        <div className="spacer" />
        <Tooltip text={dockOpen ? 'Collapse tools' : 'Expand tools'}><button className="icon-button" aria-expanded={dockOpen} aria-label={dockOpen ? 'Collapse tools' : 'Expand tools'} onClick={() => setDockOpen(value => !value)}>{dockOpen ? <PanelBottomClose size={16} /> : <PanelBottomOpen size={16} />}</button></Tooltip>
      </div>
      <div className="viewer-dock-panel" {...(dockTools.length > 1 ? tabPanelProps(`${tabPrefix}dock`, 'transcript', dockOpen && dockTool === 'transcript') : { hidden: !dockOpen })}>
        <FullTranscript open={dockOpen && dockTool === 'transcript'} caseId={caseId} sessionEpoch={sessionEpoch} currentTime={currentTime} onSeek={time => { if (media.current) { media.current.currentTime = time; setCurrentTime(time); } }} sourceId={source.id} run={run} refresh={refresh} />
      </div>
      {source.kind === 'video' && !source.restricted ? <div className="viewer-dock-panel" {...tabPanelProps(`${tabPrefix}dock`, 'discovery', dockOpen && dockTool === 'discovery')}>
        <VideoDiscovery key={`${sessionEpoch}:${source.id}`} caseId={caseId} sessionEpoch={sessionEpoch} sourceId={source.id} onFrame={id => { setDerived(id); setShowText(false); }} onSeek={time => { setDerived(null); setShowText(false); setPendingSeek(time); }} />
      </div> : null}
    </section> : null}
    {limitations.length ? <details className="processing-limitations disclosure">
      <summary><Info size={13} />About this preview<span className="disclosure-count">{limitations.length}</span></summary>
      {limitations.map(limitation => <p key={limitation}>{limitation}</p>)}
    </details> : null}
    {page ? <div className="locator-bar">
      <code>{page.historical ? `rev ${page.revision} · ` : ''}L{page.start}–L{page.end} / {page.total_lines}</code>
      <div className="spacer" />
      <Tooltip text="Previous 200 lines"><button className="icon-button" aria-label="Previous lines" disabled={start === 1} onClick={() => setStart(value => Math.max(1, value - 200))}><ChevronsLeft size={16} /></button></Tooltip>
      <Tooltip text="Next 200 lines"><button className="icon-button" aria-label="Next lines" disabled={page.end >= page.total_lines} onClick={() => setStart(page.end + 1)}><ChevronsRight size={16} /></button></Tooltip>
    </div> : null}
  </div>;
}
