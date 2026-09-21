import { useEffect, useRef, useState } from 'react';
import { FileText, Image, Film, Volume2, ZoomIn, ZoomOut, RotateCw, ShieldCheck, Lock, Unlock, Copy, ChevronLeft, ChevronRight, Info, ScanLine } from 'lucide-react';
import { api, evidenceUrl, formatBytes } from '../bridge';
import type { Source, TextPage } from '../types';
import FullTranscript from './FullTranscript';
import RedactionPanel from './RedactionPanel';
import VideoDiscovery from './VideoDiscovery';

export function SourceIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = kind === 'image' ? Image : kind === 'video' ? Film : kind === 'audio' ? Volume2 : FileText;
  return <Icon size={size} aria-hidden="true" />;
}
export default function EvidenceViewer({ source, locator, run, refresh }: { source: Source; locator?: string; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [currentTime,setCurrentTime]=useState(0);
  const [pendingSeek,setPendingSeek]=useState<number|null>(null);
  useEffect(()=>{if(pendingSeek!==null&&media.current?.readyState){media.current.currentTime=pendingSeek;setCurrentTime(pendingSeek);setPendingSeek(null);}},[pendingSeek]);
  const requestedTime=locator?.startsWith('time:') ? Number(locator.slice(5)) : null;
  const [page, setPage] = useState<TextPage | null>(null);
  const [error, setError] = useState(''); const [start, setStart] = useState(1);
  const [zoom, setZoom] = useState(1); const [rotation, setRotation] = useState(0);
  const [verified, setVerified] = useState(false);
  const officeDocument = /\.(docx|xlsx|pptx|odt)$/i.test(source.name);
  const [showText, setShowText] = useState((source.kind === 'text' || source.kind === 'other' && source.status.startsWith('text')));
  const [limitations, setLimitations] = useState<string[]>([]);
  const [derived, setDerived] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [artifactText, setArtifactText] = useState<string | null>(null);
  const [derivedMime, setDerivedMime] = useState('');
  const [intervalStart, setIntervalStart] = useState(0); const [intervalEnd, setIntervalEnd] = useState(30);
  const [pdfPage, setPdfPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [playback, setPlayback] = useState<string | null>(null);
  const [needsProxy, setNeedsProxy] = useState(/\.avi$/i.test(source.name));
  useEffect(() => {
    if (!needsProxy || source.kind !== 'video') return;
    let active=true;setProcessing(true);setError('');
    api<{artifact_id:string}>('playback_proxy',{source_id:source.id}).then(result=>{if(active)setPlayback(result.artifact_id);}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setProcessing(false);});
    return ()=>{active=false;};
  },[source.id,needsProxy]);
  useEffect(() => {
    if(source.kind!=='pdf' || locator && !locator.startsWith('page:')) return;
    let active=true;setProcessing(true);setError('');
    api<{published:{artifact_id:string;metadata:{page_count:number}}[];limitations:string[]}>('render_page',{source_id:source.id,page:pdfPage}).then(result=>{if(active){setDerived(result.published[0]?.artifact_id ?? null);setPageCount(result.published[0]?.metadata.page_count ?? null);setLimitations(result.limitations);}}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setProcessing(false);});
    return ()=>{active=false;};
  },[source.id,pdfPage,locator]);
  useEffect(() => {
    if(!officeDocument || locator) return;
    let active=true;
    setProcessing(true);
    api<{limitations:string[]}>('process_source',{source_id:source.id}).then(result=>{if(active){setShowText(true);setLimitations(result.limitations);void refresh();}}).catch(e=>{if(active)setError(String(e));}).finally(()=>{if(active)setProcessing(false);});
    return ()=>{active=false;};
  },[source.id, locator]);
  useEffect(() => {
    let active = true; setArtifactText(null); setDerivedMime('');
    if (derived) api<{ mime: string; content: { pages?: { locator: string; text: string }[]; limitations?: string[] } | null }>('artifact_info', { artifact_id: derived }).then(info => {
      if (!active) return; setDerivedMime(info.mime); setError('');
      if (info.mime === 'application/json') { const units = info.content?.pages ?? []; setArtifactText(units.slice(0, 200).map(p => `[${p.locator}]\n${p.text}`).join('\n\n') + (units.length > 200 ? `\n\nShowing 200 of ${units.length} units. Use the extracted-text viewer for paginated access.` : '')); setLimitations(info.content?.limitations ?? []); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [derived]);
  useEffect(() => {
    if (locator?.startsWith('L')) { setShowText(true); setDerived(null); setStart(Number(/^L(\d+)/.exec(locator)?.[1] ?? 1)); }
    else if (locator?.startsWith('artifact:')) { setDerived(locator.slice(9)); setShowText(false); }
    else { if(locator?.startsWith('page:'))setPdfPage(Number(locator.slice(5))); setDerived(null); setShowText((source.kind === 'text' || source.kind === 'other' && source.status.startsWith('text'))); setStart(1); }
  }, [locator, source.id, source.kind]);
  useEffect(() => { setZoom(1); setRotation(0); setVerified(false); setError(''); }, [source.id]);
  useEffect(() => {
    let active = true; setPage(null);
    if (showText) api<TextPage>('read_text', { source_id: source.id, start, count: 200 }).then(v => { if (active) { setPage(v); setError(''); } }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [source.id, source.kind, start, showText, source.status]);
  useEffect(()=>{if(requestedTime!=null && media.current?.readyState && Number.isFinite(requestedTime))media.current.currentTime=requestedTime;},[requestedTime]);
  const url = evidenceUrl(source.id);
  const playbackUrl=playback ? evidenceUrl(`artifact/${playback}`) : url;
  return <div className="viewer">
    {source.kind==='image'?<div className="image-controls"><button className="icon-button" aria-label="Zoom out" onClick={()=>setZoom(z=>Math.max(.25,z-.25))}><ZoomOut size={15}/></button><span>{Math.round(zoom*100)}%</span><button className="icon-button" aria-label="Zoom in" onClick={()=>setZoom(z=>Math.min(4,z+.25))}><ZoomIn size={15}/></button><button className="icon-button" aria-label="Rotate view" onClick={()=>setRotation(r=>r+90)}><RotateCw size={15}/></button></div>:null}
    {source.kind==='pdf' ? <div className="pdf-navigation"><button className="icon-button" aria-label="Previous PDF page" disabled={processing||pdfPage<=1} onClick={()=>setPdfPage(p=>p-1)}><ChevronLeft size={16}/></button><span>Page {pdfPage}{pageCount ? ` of ${pageCount}` : ''}</span><button className="icon-button" aria-label="Next PDF page" disabled={processing||!!pageCount&&pdfPage>=pageCount} onClick={()=>setPdfPage(p=>p+1)}><ChevronRight size={16}/></button></div> : null}
    <div className={`source-canvas ${source.kind}`}>
      {processing ? <div className="preview-progress" role="status"><ScanLine size={17} className="pulse"/>{needsProxy ? 'Opening video…' : 'Opening source…'}</div> : null}
      {error ? <div className="notice error"><Info size={18}/>{error}</div> : null}
      {showText && page ? <article className="document-page"><h2>{source.name.replace(/^\d+ · /, '')}</h2><div className="doc-rule"/><div className="text-lines">{page.text.split('\n').map((line, i) => <div className="text-line" key={i}><span className="line-number">{start + i}</span><span>{line || '\u00a0'}</span></div>)}</div></article> : null}
      {artifactText !== null ? <article className="document-page"><h2>{source.name}</h2><pre className="artifact-text">{artifactText || 'No text segments were returned. This does not establish absence of speech.'}</pre><button onClick={() => { setDerived(null); setShowText(false); }}>Back to original</button></article> : null}
      {!showText && ((!derived && source.kind === 'image') || (derived && derivedMime === 'image/jpeg')) ? <div><img className="evidence-image" src={derived ? evidenceUrl(`artifact/${derived}`) : url} alt={`${derived ? 'Derived frame or crop' : 'Original evidence'}: ${source.name}`} style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} onError={() => {if(derived){setError('Image preview failed.');return;}setProcessing(true);void api<{published:{artifact_id:string}[]}>('process_source',{source_id:source.id}).then(r=>{setDerived(r.published[0]?.artifact_id??null);}).catch(e=>setError(String(e))).finally(()=>setProcessing(false));}} />{derived && source.kind==='video' ? <button className="back-source quiet" onClick={() => setDerived(null)}>Back to recording</button> : null}</div> : null}
      {!showText && !derived && source.kind === 'video' ? <video ref={node=>{media.current=node;}} onTimeUpdate={e=>setCurrentTime(e.currentTarget.currentTime)} onLoadedMetadata={()=>{if(pendingSeek!==null&&media.current){media.current.currentTime=pendingSeek;setPendingSeek(null);}else if(requestedTime!=null&&Number.isFinite(requestedTime)&&media.current)media.current.currentTime=requestedTime;}} key={playbackUrl} src={needsProxy&&!playback ? undefined : playbackUrl} controls preload="metadata" onError={() => {if(!needsProxy)setNeedsProxy(true);else if(playback)setError('Playback derivative could not be decoded. Original frames remain available.');}} /> : null}
      {!showText && !derived && source.kind === 'audio' ? <div className="audio-stage"><Volume2 size={56}/><h2>{source.name}</h2><audio ref={node=>{media.current=node;}} onTimeUpdate={e=>setCurrentTime(e.currentTarget.currentTime)} onLoadedMetadata={()=>{if(pendingSeek!==null&&media.current){media.current.currentTime=pendingSeek;setPendingSeek(null);}else if(requestedTime!=null&&Number.isFinite(requestedTime)&&media.current)media.current.currentTime=requestedTime;}} src={url} controls preload="metadata" onError={() => setError('This audio format is not supported by the installed viewer.')} /></div> : null}
      {!showText && !derived && source.kind === 'other' && !processing ? <div className="empty-content"><FileText size={40}/><h2>{officeDocument ? "Document preview could not open" : "Original file preserved"}</h2><p>{officeDocument ? "See the error below, then reopen the file to retry extraction." : "This file format does not yet have an inline preview."}</p></div> : null}
    </div>
    {['video', 'audio'].includes(source.kind) ? <FullTranscript currentTime={currentTime} onSeek={time=>{if(media.current){media.current.currentTime=time;setCurrentTime(time);}}} sourceId={source.id} run={run} refresh={refresh}/> : null}
    {source.kind==='video'&&!source.restricted?<VideoDiscovery key={source.id} sourceId={source.id} onFrame={id=>{setDerived(id);setShowText(false);}} onSeek={time=>{setDerived(null);setShowText(false);setPendingSeek(time);}}/>:null}
    {['pdf','image'].includes(source.kind)&&!source.restricted?<RedactionPanel sourceId={source.id} kind={source.kind}/>:null}
    {limitations.length ? <details className="processing-limitations"><summary>About this preview</summary>{limitations.map(l => <p key={l}>{l}</p>)}</details> : null}
    {page ? <div className="locator-bar"><button className="quiet" onClick={() => run(async () => { await navigator.clipboard.writeText(page.locator); })}><Copy size={13}/>Copy evidence link</button><code>L{page.start}–L{page.end} / {page.total_lines}</code><div className="spacer"/><button className="icon-button" aria-label="Previous lines" disabled={start === 1} onClick={() => setStart(s => Math.max(1, s - 200))}><ChevronLeft size={16}/></button><button className="icon-button" aria-label="Next lines" disabled={page.end >= page.total_lines} onClick={() => setStart(page.end + 1)}><ChevronRight size={16}/></button></div> : null}
  </div>;
}
