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
  const total=Math.round(seconds*1000);
  const h=Math.floor(total/3_600_000);
  const m=Math.floor((total%3_600_000)/60_000);
  const s=Math.floor((total%60_000)/1000);
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}.${String(total%1000).padStart(3, '0')}`;
}

const APPROXIMATE_STEP_SECONDS = 1 / 30;

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
    {filmstrip?.length ? <div className="filmstrip" aria-label="Filmstrip of sampled frames">
      {filmstrip.map(frameSample => <Tooltip key={frameSample.artifact} text={`Jump to ${formatClockMs(frameSample.time)}`}>
        <button onClick={() => onSeek(frameSample.time)}><img src={evidenceUrl(`artifact/${frameSample.artifact}`)} alt="" loading="lazy" /></button>
      </Tooltip>)}
    </div> : null}
    <div className="media-buttons">
      <Tooltip text="Back 10 seconds (J)"><button className="icon-button" aria-label="Back 10 seconds" onClick={() => skip(-10)}><ChevronsLeft size={16} /></button></Tooltip>
      <Tooltip text="Back about 33 ms (,)"><button className="icon-button" aria-label="Back about 33 milliseconds" onClick={() => frame(-1)}><SkipBack size={14} /></button></Tooltip>
      <button className="media-play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <Tooltip text="Forward about 33 ms (.)"><button className="icon-button" aria-label="Forward about 33 milliseconds" onClick={() => frame(1)}><SkipForward size={14} /></button></Tooltip>
      <Tooltip text="Forward 10 seconds (L)"><button className="icon-button" aria-label="Forward 10 seconds" onClick={() => skip(10)}><ChevronsRight size={16} /></button></Tooltip>
      {onExactStep ? <><button className="quiet" disabled={exactBusy} onClick={()=>onExactStep('previous')}>Inspect previous decoded frame</button><button className="quiet" disabled={exactBusy} onClick={()=>onExactStep('next')}>Inspect next decoded frame</button></> : null}
      <span className="media-time mono">{formatClockMs(time)} <span className="media-duration">/ {formatClockMs(duration)}</span></span>
      <div className="spacer" />
      <Tooltip text="Mark loop start ([)"><button className={`media-loop ${loopA !== null ? 'active' : ''}`} aria-label="Mark loop start" onClick={markA}>A</button></Tooltip>
      <Tooltip text="Mark loop end (])"><button className={`media-loop ${loopB !== null ? 'active' : ''}`} aria-label="Mark loop end" onClick={markB}>B</button></Tooltip>
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
    const prefetch = new IntersectionObserver(entries => {if(entries.some(entry=>entry.isIntersecting))ensure(index);}, { rootMargin: '700px 0px', threshold: 0 });
    const visible = new IntersectionObserver(entries => {if(entries.some(entry=>entry.isIntersecting&&entry.intersectionRatio>=0.4))onVisible(index);}, { rootMargin: '0px', threshold: 0.4 });
    prefetch.observe(node);visible.observe(node);
    return () => {prefetch.disconnect();visible.disconnect();};
  }, [index, ensure, onVisible]);
  return <div className="pdf-page" ref={node => { ref.current = node; register(index, node); }} data-page={index} style={{ aspectRatio: `${ratio}` }}>
    {artifact ? <img src={evidenceUrl(`artifact/${artifact}`)} alt={`Page ${index}`} loading="lazy" draggable={false} /> : <div className="pdf-page-skeleton"><Skeleton /></div>}
    <span className="pdf-page-label">{index}</span>
  </div>;
}

export default function EvidenceViewer({ source, locator, run, refresh, onLocatorSelect, onAsk, caseId, sessionEpoch }: { source: Source; locator?: string; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void>; onLocatorSelect: (locator: string) => void; onAsk?: () => void; caseId?:string; sessionEpoch?:number }) {
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
  const [exactFrame,setExactFrame]=useState<{artifact:string;locator:string;time:number;pts:number;timeBase:string}|null>(null);
  const [exactBusy,setExactBusy]=useState(false);
  const exactRequest=useRef(0);
  const filmstripWindow = Number.isFinite(currentTime) && currentTime >= 0 ? Math.floor(currentTime / 120) : 0;
  const [askChip, setAskChip] = useState<{ x: number; y: number; a: number; b: number; revision: number } | null>(null);

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
      if(requestedPage!==null && (!Number.isSafeInteger(requestedPage)||requestedPage<1||requestedPage>count))setError('Requested physical PDF page is outside this document.');
    }).catch(reason=>{if(epoch===pdfEpoch.current)setError(String(reason));});
    return()=>{pdfEpoch.current++;};
  },[caseId,sessionEpoch,source.id,source.kind]);
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
      .catch(reason => {if(epoch===pdfEpoch.current)setError(String(reason));})
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
    api<{ artifact_id: string }>('playback_proxy', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id }).then(result => { if (active) setPlayback(result.artifact_id); }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setProcessing(false); });
    return () => { active = false; };
  }, [source.id, needsProxy]);

  useEffect(() => {
    if (!officeDocument || locator) return;
    let active = true;
    setProcessing(true);
    api<{ limitations: string[] }>('process_source', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id }).then(result => { if (active) { setShowText(true); setLimitations(result.limitations); void refresh(); } }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setProcessing(false); });
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

  useEffect(() => { exactRequest.current++;setZoom(1); setRotation(0); setError(''); setExactFrame(null);setExactBusy(false); }, [source.id]);

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
    } catch(e) {if(request===exactRequest.current)setError(String(e));}
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

  return <div className="viewer">
    <header className="viewer-source-header">
      <div className="viewer-source-icon"><SourceIcon kind={source.kind} size={17} /></div>
      <div className="viewer-source-identity">
        <strong title={source.name}>{source.name}</strong>
        <span>{source.kind.toUpperCase()} · {formatBytes(source.size)} · {source.status}</span>
      </div>
      {source.restricted ? <span className="viewer-restricted" role="status" aria-label="Restricted">Restricted</span> : null}
    </header>
    {source.kind === 'image' ? <div className="image-controls">
      <Tooltip text="Zoom out"><button className="icon-button" aria-label="Zoom out" onClick={() => setZoom(value => Math.max(0.25, value - 0.25))}><ZoomOut size={15} /></button></Tooltip>
      <span className="mono">{Math.round(zoom * 100)}%</span>
      <Tooltip text="Zoom in"><button className="icon-button" aria-label="Zoom in" onClick={() => setZoom(value => Math.min(6, value + 0.25))}><ZoomIn size={15} /></button></Tooltip>
      <Tooltip text="Fit width"><button className="quiet" onClick={() => setZoom(1)}>Fit</button></Tooltip>
      <Tooltip text="Rotate view"><button className="icon-button" aria-label="Rotate view" onClick={() => setRotation(value => value + 90)}><RotateCw size={15} /></button></Tooltip>
    </div> : null}

    {source.kind === 'pdf' ? <div className="pdf-navigation">
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
      <span className="muted small">{pdfCount ? `of ${pdfCount} physical pages` : 'Checking page count…'}</span>
      <Tooltip text="Next physical page"><button className="icon-button" aria-label="Next page" disabled={pdfCount===null||pdfPage>=pdfCount} onClick={() => scrollToPdfPage(pdfPage+1)}><ChevronsRight size={16} /></button></Tooltip>
      <div className="spacer" />
      <button className="quiet" disabled={pdfCount===null} onClick={() => run(async () => { await navigator.clipboard.writeText(`evidence:${source.id}#page:${pdfPage}`); })}>Copy page navigation link (not a citation)</button>
    </div> : null}

    <div className={`source-canvas ${source.kind}`}>
      {processing ? <div className="preview-progress" role="status"><ScanLine size={17} className="pulse" />{needsProxy ? 'Opening video…' : 'Opening source…'}</div> : null}
      {error ? <div className="notice error"><Info size={18} />{error}</div> : null}

      {showText && page === null && !error ? <div className="document-page"><Skeleton /></div> : null}
      {showText && page ? <article className="document-page" onMouseUp={onTextSelect}>
        {page.historical ? <p className="small muted historical-notice" role="note">Historical extraction revision {page.revision} — superseded wording preserved; this is not the current active text.</p> : null}
        <h2>{source.name.replace(/^\d+ · /, '')}</h2>
        <p className="document-provenance">Extracted text · Revision {page.revision} · Lines {page.start}–{page.end} of {page.total_lines}</p>
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
            void api<{ published: unknown[] }>('process_source', { case_id: caseId, session_epoch: sessionEpoch, source_id: source.id }).then(result => { setDerived((result.published as { artifact_id?: string }[])?.[0]?.artifact_id ?? null); }).catch(e => setError(String(e))).finally(() => setProcessing(false));
          }} />
        {derived && source.kind === 'video' ? <button className="quiet back-source" onClick={() => setDerived(null)}>Back to recording</button> : null}
      </div> : null}

      {!showText && !derived && source.kind === 'video' ? <video
        ref={bindMedia}
        onTimeUpdate={onTimeUpdate}
        onPlay={()=>{exactRequest.current++;setExactFrame(null);setExactBusy(false);}}
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
        <audio ref={bindMedia} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} src={url} controls={false} preload="metadata" onError={() => setError('This audio format is not supported by the installed viewer.')} />
      </div> : null}

      {!showText && !derived && source.kind === 'other' && !processing ? <div className="empty-content">
        <FileText size={38} />
        <h2>{officeDocument ? 'Document preview could not open' : 'Original file preserved'}</h2>
        <p>{officeDocument ? 'See the error below, then reopen the file to retry extraction.' : 'This file format does not yet have an inline preview.'}</p>
      </div> : null}

      {!showText && !derived && source.kind === 'pdf' && pdfCount===null && !error ? <div className="document-page"><Skeleton /></div> : null}
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

    {askChip ? <div className="ask-chip" style={{ left: askChip.x, top: askChip.y }} role="toolbar" aria-label="Selection actions">
      <button onClick={() => { onLocatorSelect(`R${askChip.revision}L${askChip.a}-L${askChip.b}`); setAskChip(null); if (onAsk) onAsk(); else window.dispatchEvent(new CustomEvent('vislex:focus-composer')); }}><AArrowDown size={13} />Ask about L{askChip.a}–L{askChip.b}</button>
      <button onClick={() => { void navigator.clipboard.writeText(`evidence:${source.id}#R${askChip.revision}L${askChip.a}-L${askChip.b}`); setAskChip(null); }}>Copy citation (rev {askChip.revision})</button>
    </div> : null}

    {['video', 'audio'].includes(source.kind) && !showText && !derived ? <MediaControls media={media} element={mediaElement} filmstrip={source.kind === 'video' ? filmstrip : null} onExactStep={source.kind==='video'?direction=>{void stepExact(direction);}:undefined} exactBusy={exactBusy} onSeek={time => { exactRequest.current++;displayedFrameTime.current=null;setExactBusy(false);setExactFrame(null);if (media.current) { media.current.currentTime = time; setCurrentTime(time); } }} /> : null}
    {source.kind==='video' && exactFrame && !showText && !derived ? <div className="exact-frame-inspection" role="region" aria-label="Exact decoded frame"><img src={evidenceUrl(`artifact/${exactFrame.artifact}`)} alt={`Decoded frame at source time ${formatClockMs(exactFrame.time)}`} style={{maxWidth:'100%',maxHeight:'40vh',objectFit:'contain'}} /><p>Decoded source frame at {formatClockMs(exactFrame.time)} · PTS {exactFrame.pts} × {exactFrame.timeBase}. This image is a derivative of one frame.</p><button className="quiet" onClick={()=>void navigator.clipboard.writeText(exactFrame.locator)}>Copy frame citation</button></div> : null}
    {['video', 'audio'].includes(source.kind) ? <FullTranscript caseId={caseId} sessionEpoch={sessionEpoch} currentTime={currentTime} onSeek={time => { if (media.current) { media.current.currentTime = time; setCurrentTime(time); } }} sourceId={source.id} run={run} refresh={refresh} /> : null}
    {source.kind === 'video' && !source.restricted ? <VideoDiscovery key={`${sessionEpoch}:${source.id}`} caseId={caseId} sessionEpoch={sessionEpoch} sourceId={source.id} onFrame={id => { setDerived(id); setShowText(false); }} onSeek={time => { setDerived(null); setShowText(false); setPendingSeek(time); }} /> : null}
    {['pdf', 'image'].includes(source.kind) && !source.restricted ? <RedactionPanel caseId={caseId} sessionEpoch={sessionEpoch} sourceId={source.id} kind={source.kind} /> : null}
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
