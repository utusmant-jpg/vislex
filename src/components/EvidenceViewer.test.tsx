// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EvidenceViewer, { citedLineRange, shortHash } from './EvidenceViewer';
import type { Source, TextPage } from '../types';
import {getViewerContext} from '../viewerContext';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, evidenceUrl: (path: string) => path, formatBytes: (size: number) => `${size} B` }));
vi.mock('../ui', () => ({ Skeleton: () => <span>Loading</span>, Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./FullTranscript', () => ({ default: () => null }));
vi.mock('./RedactionPanel', () => ({ default: () => null }));
vi.mock('./VideoDiscovery', () => ({ default: () => null }));

const source: Source = { id: 'source-one', name: 'Synthetic statement.txt', sha256: 'hash', size: 100, mime: 'text/plain', kind: 'text', status: 'text ready', restricted: false, occurrences: 1, created_at: '2026-09-22T00:00:00Z' };
afterEach(() => { cleanup(); api.mockReset(); vi.unstubAllGlobals(); });

function observePdfPages() {
  const visible:{callback:IntersectionObserverCallback;node:Element;owner:IntersectionObserver}[]=[];
  vi.stubGlobal('IntersectionObserver',class {
    constructor(private callback:IntersectionObserverCallback,private options?:IntersectionObserverInit){}
    observe(node:Element){if(this.options?.rootMargin==='0px')visible.push({callback:this.callback,node,owner:this as unknown as IntersectionObserver});else this.callback([{isIntersecting:true,intersectionRatio:0.1,target:node} as IntersectionObserverEntry],this as unknown as IntersectionObserver);}
    disconnect(){}
  });
  return (page:number)=>{for(const watcher of visible){if(Number((watcher.node as HTMLElement).dataset.page)===page)watcher.callback([{isIntersecting:true,intersectionRatio:0.6,target:watcher.node} as IntersectionObserverEntry],watcher.owner);}};
}

it('opens a pinned citation against its historical revision and marks the wording as superseded', async () => {
  const historical: TextPage = { text: 'Old exact wording', start: 5, end: 5, total_lines: 9, revision: 1, historical: true, locator: 'evidence:source-one#R1L5-L5', truncated_long_lines: false };
  api.mockImplementation(async (action: string) => action === 'read_extract_revision' ? historical : action === 'extract_history' ? { source_id: 'source-one', active_revision: 2, revisions: [] } : { ...historical, text: 'Changed active wording', revision: 2, historical: false });
  render(<EvidenceViewer source={source} locator="R1L5-L5" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 1, start: 5, count: 200 }));
  expect(api).toHaveBeenCalledWith('extract_history', { source_id: 'source-one' });
  expect(await screen.findByText('Old exact wording')).toBeTruthy();
  expect(screen.queryByText('Changed active wording')).toBeNull();
  expect((await screen.findByRole('note')).textContent).toContain('Historical extraction revision 1 — superseded wording preserved; this is not the current active text.');
  expect(screen.getByText('Pinned rev 1')).toBeTruthy();
  expect(screen.getByText('Extracted text · Revision 1 · Lines 5–5 of 9')).toBeTruthy();
  expect(screen.getByText('TEXT · 100 B · text ready')).toBeTruthy();
});

it('does not label a citation pinned to the active revision as superseded', async () => {
  // read_extract_revision reports historical: true for every revision (case.rs).
  const pinned: TextPage = { text: 'Current exact wording', start: 5, end: 5, total_lines: 9, revision: 2, historical: true, locator: 'evidence:source-one#R2L5-L5', truncated_long_lines: false };
  api.mockImplementation(async (action: string) => action === 'read_extract_revision' ? pinned : action === 'extract_history' ? { source_id: 'source-one', active_revision: 2, revisions: [] } : undefined);
  render(<EvidenceViewer source={source} locator="R2L5-L5" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect(await screen.findByText('Current exact wording')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('Rev 2 · current')).toBeTruthy());
  expect(screen.queryByRole('note')).toBeNull();
  expect(screen.queryByText(/superseded wording/)).toBeNull();
  expect(api).not.toHaveBeenCalledWith('read_text', expect.anything());
});

it('keeps the historical label when the active revision cannot be read', async () => {
  const pinned: TextPage = { text: 'Pinned wording', start: 5, end: 5, total_lines: 9, revision: 2, historical: true, locator: 'evidence:source-one#R2L5-L5', truncated_long_lines: false };
  api.mockImplementation(async (action: string) => { if (action === 'extract_history') throw new Error('history unavailable'); return pinned; });
  render(<EvidenceViewer source={source} locator="R2L5-L5" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect((await screen.findByRole('note')).textContent).toContain('Historical extraction revision 2 — superseded wording preserved; this is not the current active text.');
});

it('keeps the restriction visible while reading a source', async () => {
  const restricted={...source,restricted:true};
  api.mockResolvedValue({text:'Allowed excerpt',start:1,end:1,total_lines:1,revision:2,historical:false,locator:'evidence:source-one#R2L1-L1'});
  render(<EvidenceViewer source={restricted} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  expect(screen.getByRole('status',{name:'Restricted'})).toBeTruthy();
  await waitFor(()=>expect(screen.getByText('Allowed excerpt')).toBeTruthy());
});

it('reattaches transport state after original video changes to a proxy and ignores shortcuts in inputs', async () => {
  const videoSource: Source={...source,kind:'video',mime:'video/mp4',name:'Synthetic recording.mp4'};
  api.mockImplementation(async (action:string)=>action==='playback_proxy'?{artifact_id:'proxy-one'}:{samples:[]});
  const view=render(<EvidenceViewer source={videoSource} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  const original=view.container.querySelector('video')!;
  Object.defineProperty(original,'duration',{configurable:true,value:60});
  original.currentTime=5;
  fireEvent.loadedMetadata(original);
  fireEvent.play(original);
  expect(screen.getByRole('button',{name:'Pause'})).toBeTruthy();
  fireEvent.error(original);
  await waitFor(()=>expect(view.container.querySelector('video')?.getAttribute('src')).toBe('artifact/proxy-one'));
  const proxy=view.container.querySelector('video')!;
  expect(proxy).not.toBe(original);
  Object.defineProperty(proxy,'duration',{configurable:true,value:90});
  proxy.currentTime=12;
  fireEvent.loadedMetadata(proxy);
  fireEvent.pause(proxy);
  expect(screen.getByRole('button',{name:'Play'})).toBeTruthy();
  fireEvent.play(original);
  expect(screen.getByRole('button',{name:'Play'})).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox',{name:'Playback speed'}),{target:{value:'1.5'}});
  expect(proxy.playbackRate).toBe(1.5);
  fireEvent.click(screen.getByRole('button',{name:'Mark loop start'}));
  proxy.currentTime=5;
  fireEvent.click(screen.getByRole('button',{name:'Mark loop end'}));
  expect(screen.getByRole('button',{name:'Mark loop start'}).className).not.toContain('active');
  expect(view.container.querySelector('.loop-range')).toBeNull();
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek position'}),{key:'ArrowRight'});
  expect(proxy.currentTime).toBe(5);
});

it('steps through exact VFR timestamps and exposes the artifact citation', async () => {
  const videoSource: Source={...source,kind:'video',mime:'video/mp4',name:'Synthetic VFR.mp4'};
  api.mockImplementation(async (action:string,args:{target?:number;direction?:string})=>{
    if(action==='step_video_frame'){
      const time=args.target===0.6?1.4:2.5;
      return {published:[{artifact_id:`frame-${time}`,locator:`evidence:source-one#artifact:frame-${time}`,metadata:{source_relative_seconds:time,pts:Math.round(time*1000),time_base:'1/1000'}}]};
    }
    return {samples:[]};
  });
  const view=render(<EvidenceViewer caseId="frame-case" sessionEpoch={7} source={videoSource} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  const video=view.container.querySelector('video')!;
  video.currentTime=0.6;
  fireEvent.click(screen.getByRole('button',{name:'Inspect next decoded frame'}));
  await waitFor(()=>expect(screen.getByAltText('Decoded frame at source time 0:01.400')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('step_video_frame',{case_id:'frame-case',session_epoch:7,source_id:'source-one',target:0.6,direction:'next'});
  fireEvent.click(screen.getByRole('button',{name:'Inspect next decoded frame'}));
  await waitFor(()=>expect(screen.getByAltText('Decoded frame at source time 0:02.500')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('step_video_frame',{case_id:'frame-case',session_epoch:7,source_id:'source-one',target:1.4,direction:'next'});
  expect(screen.getByRole('button',{name:'Copy frame citation'})).toBeTruthy();
});

it('probes a one-page PDF before rendering and rejects out-of-range navigation', async () => {
  observePdfPages();
  const pdf:Source={...source,kind:'pdf',mime:'application/pdf',name:'One page.pdf'};
  api.mockImplementation(async (action:string,args:{page?:number})=>action==='probe_pdf'?{metadata:{page_count:1,first_page_size_points:[612,792]}}:action==='render_page'?{published:[{artifact_id:'page-one',metadata:{page:args.page,page_count:1,page_size_points:[612,792]}}],limitations:[]}:{}) ;
  const view=render(<EvidenceViewer caseId="case-one" source={pdf} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText('of 1 physical pages')).toBeTruthy());
  await waitFor(()=>expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(1));
  expect(api).toHaveBeenCalledWith('render_page',{case_id:'case-one',source_id:'source-one',page:1});
  expect(api).not.toHaveBeenCalledWith('render_page',{source_id:'source-one',page:12});
  fireEvent.change(screen.getByRole('spinbutton',{name:'Current page'}),{target:{value:'12'}});
  expect(api).not.toHaveBeenCalledWith('render_page',{source_id:'source-one',page:12});
  expect(screen.getByRole('button',{name:'Next page'}).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button',{name:'Copy page navigation link (not a citation)'})).toBeTruthy();
});

it('uses each rendered PDF page geometry in a mixed orientation document', async () => {
  const showVisible=observePdfPages();
  const pdf:Source={...source,kind:'pdf',mime:'application/pdf',name:'Mixed pages.pdf'};
  api.mockImplementation(async (action:string,args:{page?:number})=>action==='probe_pdf'?{metadata:{page_count:2,first_page_size_points:[612,792]}}:action==='render_page'?{published:[{artifact_id:`page-${args.page}`,metadata:{page:args.page,page_count:2,page_size_points:args.page===1?[612,792]:[792,612]}}],limitations:[]}:{}) ;
  const view=render(<EvidenceViewer source={pdf} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(()=>expect(view.container.querySelector('[data-page="2"]')?.getAttribute('style')).toContain('aspect-ratio: 1.294'));
  expect(getViewerContext()?.page).toBeUndefined();
  showVisible(2);
  await waitFor(()=>expect(getViewerContext()?.page).toBe(2));
});

it('keeps a very large PDF viewer window bounded and jumps to a valid physical page', async () => {
  observePdfPages();
  const pdf:Source={...source,kind:'pdf',mime:'application/pdf',name:'Large.pdf'};
  api.mockImplementation(async (action:string,args:{page?:number})=>action==='probe_pdf'?{metadata:{page_count:10000,first_page_size_points:[612,792]}}:action==='render_page'?{published:[{artifact_id:`page-${args.page}`,metadata:{page:args.page,page_count:10000,page_size_points:[612,792]}}],limitations:[]}:{}) ;
  const view=render(<EvidenceViewer source={pdf} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText('of 10000 physical pages')).toBeTruthy());
  expect(view.container.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(13);
  const pageInput=screen.getByRole('spinbutton',{name:'Current page'});
  fireEvent.change(pageInput,{target:{value:'50'}});
  expect(view.container.querySelector('[data-page="50"]')).toBeNull();
  fireEvent.change(pageInput,{target:{value:'5000'}});
  fireEvent.keyDown(pageInput,{key:'Enter'});
  await waitFor(()=>expect(view.container.querySelector('[data-page="5000"]')).toBeTruthy());
  expect(view.container.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(13);
});

it('reattaches transport state after original video changes to a proxy and ignores shortcuts in inputs', async () => {
  const videoSource: Source={...source,kind:'video',mime:'video/mp4',name:'Synthetic recording.mp4'};
  api.mockImplementation(async (action:string)=>action==='playback_proxy'?{artifact_id:'proxy-one'}:{samples:[]});
  const view=render(<EvidenceViewer source={videoSource} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  const original=view.container.querySelector('video')!;
  Object.defineProperty(original,'duration',{configurable:true,value:60});
  original.currentTime=5;
  fireEvent.loadedMetadata(original);
  fireEvent.play(original);
  expect(screen.getByRole('button',{name:'Pause'})).toBeTruthy();
  fireEvent.error(original);
  await waitFor(()=>expect(view.container.querySelector('video')?.getAttribute('src')).toBe('artifact/proxy-one'));
  const proxy=view.container.querySelector('video')!;
  expect(proxy).not.toBe(original);
  Object.defineProperty(proxy,'duration',{configurable:true,value:90});
  proxy.currentTime=12;
  fireEvent.loadedMetadata(proxy);
  fireEvent.pause(proxy);
  expect(screen.getByRole('button',{name:'Play'})).toBeTruthy();
  fireEvent.play(original);
  expect(screen.getByRole('button',{name:'Play'})).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox',{name:'Playback speed'}),{target:{value:'1.5'}});
  expect(proxy.playbackRate).toBe(1.5);
  fireEvent.click(screen.getByRole('button',{name:'Mark loop start'}));
  proxy.currentTime=5;
  fireEvent.click(screen.getByRole('button',{name:'Mark loop end'}));
  expect(screen.getByRole('button',{name:'Mark loop start'}).className).not.toContain('active');
  expect(view.container.querySelector('.loop-range')).toBeNull();
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek position'}),{key:'ArrowRight'});
  expect(proxy.currentTime).toBe(5);
});

it('steps through exact VFR timestamps and exposes the artifact citation', async () => {
  const videoSource: Source={...source,kind:'video',mime:'video/mp4',name:'Synthetic VFR.mp4'};
  api.mockImplementation(async (action:string,args:{target?:number;direction?:string})=>{
    if(action==='step_video_frame'){
      const time=args.target===0.6?1.4:2.5;
      return {published:[{artifact_id:`frame-${time}`,locator:`evidence:source-one#artifact:frame-${time}`,metadata:{source_relative_seconds:time,pts:Math.round(time*1000),time_base:'1/1000'}}]};
    }
    return {samples:[]};
  });
  const view=render(<EvidenceViewer caseId="frame-case" sessionEpoch={7} source={videoSource} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  const video=view.container.querySelector('video')!;
  video.currentTime=0.6;
  fireEvent.click(screen.getByRole('button',{name:'Inspect next decoded frame'}));
  await waitFor(()=>expect(screen.getByAltText('Decoded frame at source time 0:01.400')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('step_video_frame',{case_id:'frame-case',session_epoch:7,source_id:'source-one',target:0.6,direction:'next'});
  fireEvent.click(screen.getByRole('button',{name:'Inspect next decoded frame'}));
  await waitFor(()=>expect(screen.getByAltText('Decoded frame at source time 0:02.500')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('step_video_frame',{case_id:'frame-case',session_epoch:7,source_id:'source-one',target:1.4,direction:'next'});
  expect(screen.getByRole('button',{name:'Copy frame citation'})).toBeTruthy();
});

it('probes a one-page PDF before rendering and rejects out-of-range navigation', async () => {
  observePdfPages();
  const pdf:Source={...source,kind:'pdf',mime:'application/pdf',name:'One page.pdf'};
  api.mockImplementation(async (action:string,args:{page?:number})=>action==='probe_pdf'?{metadata:{page_count:1,first_page_size_points:[612,792]}}:action==='render_page'?{published:[{artifact_id:'page-one',metadata:{page:args.page,page_count:1,page_size_points:[612,792]}}],limitations:[]}:{}) ;
  const view=render(<EvidenceViewer caseId="case-one" source={pdf} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText('of 1 physical pages')).toBeTruthy());
  await waitFor(()=>expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(1));
  expect(api).toHaveBeenCalledWith('render_page',{case_id:'case-one',source_id:'source-one',page:1});
  expect(api).not.toHaveBeenCalledWith('render_page',{source_id:'source-one',page:12});
  fireEvent.change(screen.getByRole('spinbutton',{name:'Current page'}),{target:{value:'12'}});
  expect(api).not.toHaveBeenCalledWith('render_page',{source_id:'source-one',page:12});
  expect(screen.getByRole('button',{name:'Next page'}).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button',{name:'Copy page navigation link (not a citation)'})).toBeTruthy();
});

it('uses each rendered PDF page geometry in a mixed orientation document', async () => {
  const showVisible=observePdfPages();
  const pdf:Source={...source,kind:'pdf',mime:'application/pdf',name:'Mixed pages.pdf'};
  api.mockImplementation(async (action:string,args:{page?:number})=>action==='probe_pdf'?{metadata:{page_count:2,first_page_size_points:[612,792]}}:action==='render_page'?{published:[{artifact_id:`page-${args.page}`,metadata:{page:args.page,page_count:2,page_size_points:args.page===1?[612,792]:[792,612]}}],limitations:[]}:{}) ;
  const view=render(<EvidenceViewer source={pdf} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(()=>expect(view.container.querySelector('[data-page="2"]')?.getAttribute('style')).toContain('aspect-ratio: 1.294'));
  expect(getViewerContext()?.page).toBeUndefined();
  showVisible(2);
  await waitFor(()=>expect(getViewerContext()?.page).toBe(2));
});

it('keeps a very large PDF viewer window bounded and jumps to a valid physical page', async () => {
  observePdfPages();
  const pdf:Source={...source,kind:'pdf',mime:'application/pdf',name:'Large.pdf'};
  api.mockImplementation(async (action:string,args:{page?:number})=>action==='probe_pdf'?{metadata:{page_count:10000,first_page_size_points:[612,792]}}:action==='render_page'?{published:[{artifact_id:`page-${args.page}`,metadata:{page:args.page,page_count:10000,page_size_points:[612,792]}}],limitations:[]}:{}) ;
  const view=render(<EvidenceViewer source={pdf} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(()=>expect(screen.getByText('of 10000 physical pages')).toBeTruthy());
  expect(view.container.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(13);
  fireEvent.change(screen.getByRole('spinbutton',{name:'Current page'}),{target:{value:'5000'}});
  fireEvent.keyDown(screen.getByRole('spinbutton',{name:'Current page'}),{key:'Enter'});
  await waitFor(()=>expect(view.container.querySelector('[data-page="5000"]')).toBeTruthy());
  expect(view.container.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(13);
});

it('parses cited line ranges and shortens hashes for display only', () => {
  expect(citedLineRange('L9-L11')).toEqual({ start: 9, end: 11 });
  expect(citedLineRange('R2L5-L7')).toEqual({ start: 5, end: 7 });
  expect(citedLineRange('L4')).toEqual({ start: 4, end: 4 });
  expect(citedLineRange('L9-L3')).toBeNull();
  expect(citedLineRange('page:3')).toBeNull();
  expect(citedLineRange(undefined)).toBeNull();
  expect(shortHash('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe('9f86d081…f00a08');
  expect(shortHash('short')).toBe('short');
});

it('marks exactly the cited lines of the extracted text', async () => {
  api.mockResolvedValue({ text: 'two\nthree\nfour', start: 2, end: 4, total_lines: 9, revision: 3, historical: false, locator: 'evidence:source-one#R3L2-L4', truncated_long_lines: false });
  const view = render(<EvidenceViewer source={source} locator="L2-L3" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('three')).toBeTruthy());
  expect(view.container.querySelector('[data-line="2"]')?.getAttribute('data-cited')).toBe('true');
  expect(view.container.querySelector('[data-line="3"]')?.getAttribute('data-cited')).toBe('true');
  expect(view.container.querySelector('[data-line="4"]')?.hasAttribute('data-cited')).toBe(false);
  expect(screen.getByText(/Cited lines L2–L3 are marked/)).toBeTruthy();
  expect(screen.getByText('Rev 3 · current')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy evidence link' })).toBeTruthy();
});

it('offers a retry that re-reads extracted text after a failure', async () => {
  let calls = 0;
  api.mockImplementation(async () => { calls++; if (calls === 1) throw new Error('Extraction is still running'); return { text: 'Recovered wording', start: 1, end: 1, total_lines: 1, revision: 1, historical: false, locator: 'evidence:source-one#R1L1-L1', truncated_long_lines: false }; });
  render(<EvidenceViewer source={source} run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect(await screen.findByText('Extracted text is not available')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Extraction is still running');
  fireEvent.click(screen.getByRole('button', { name: 'Read text again' }));
  await waitFor(() => expect(screen.getByText('Recovered wording')).toBeTruthy());
  expect(api.mock.calls.filter(([action]) => action === 'read_text')).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('switches a PDF between original pages and redaction with keyboard tabs while keeping pages mounted', async () => {
  observePdfPages();
  const pdf: Source = { ...source, kind: 'pdf', mime: 'application/pdf', name: 'Tabs.pdf' };
  api.mockImplementation(async (action: string, args: { page?: number }) => action === 'probe_pdf' ? { metadata: { page_count: 1, first_page_size_points: [612, 792] } } : action === 'render_page' ? { published: [{ artifact_id: 'page-one', metadata: { page: args.page, page_count: 1, page_size_points: [612, 792] } }], limitations: [] } : {});
  const view = render(<EvidenceViewer source={pdf} run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(1));
  const tablist = screen.getByRole('tablist', { name: 'Source views' });
  const original = screen.getByRole('tab', { name: 'Original pages' });
  expect(original.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel', { name: 'Original pages' })).toBeTruthy();
  original.focus();
  fireEvent.keyDown(tablist, { key: 'ArrowRight' });
  const redaction = screen.getByRole('tab', { name: 'Redaction' });
  expect(redaction.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(redaction);
  expect(screen.getByRole('tabpanel', { name: 'Redaction' })).toBeTruthy();
  expect(screen.queryByRole('spinbutton', { name: 'Current page' })).toBeNull();
  expect(view.container.querySelector('.source-canvas')?.hasAttribute('hidden')).toBe(true);
  expect(view.container.querySelectorAll('.pdf-page')).toHaveLength(1);
  fireEvent.keyDown(tablist, { key: 'Home' });
  expect(screen.getByRole('spinbutton', { name: 'Current page' })).toBeTruthy();
});

it('does not offer redaction for a restricted image and explains the restriction', () => {
  const image: Source = { ...source, kind: 'image', mime: 'image/jpeg', name: 'Photo.jpg', restricted: true };
  render(<EvidenceViewer source={image} run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect(screen.queryByRole('tablist', { name: 'Source views' })).toBeNull();
  expect(screen.getByRole('status', { name: 'Restricted' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
});

it('switches recording tools in the dock and collapses it without losing the transport', () => {
  const videoSource: Source = { ...source, kind: 'video', mime: 'video/mp4', name: 'Dock.mp4' };
  api.mockResolvedValue({ samples: [] });
  const view = render(<EvidenceViewer source={videoSource} run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  const tools = screen.getByRole('tablist', { name: 'Recording tools' });
  expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true');
  screen.getByRole('tab', { name: 'Transcript' }).focus();
  fireEvent.keyDown(tools, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Visual discovery' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel', { name: 'Visual discovery' })).toBeTruthy();
  const collapse = screen.getByRole('button', { name: 'Collapse tools' });
  expect(collapse.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(collapse);
  expect(screen.getByRole('button', { name: 'Expand tools' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('tabpanel')).toBeNull();
  expect(view.container.querySelectorAll('.viewer-dock-panel[hidden]')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
  expect(screen.getByRole('tabpanel', { name: 'Transcript' })).toBeTruthy();
});

it('shows only the transcript tool for a restricted recording', () => {
  const videoSource: Source = { ...source, kind: 'video', mime: 'video/mp4', name: 'Restricted.mp4', restricted: true };
  api.mockResolvedValue({ samples: [] });
  render(<EvidenceViewer source={videoSource} run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect(screen.queryByRole('tablist', { name: 'Recording tools' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Visual discovery' })).toBeNull();
  expect(api).not.toHaveBeenCalledWith('browse_video_discovery', expect.anything());
});

it('names the source tab after what the canvas shows, not always the original', async () => {
  observePdfPages();
  const pdf: Source = { ...source, kind: 'pdf', mime: 'application/pdf', name: 'Labels.pdf' };
  api.mockImplementation(async (action: string, args: { page?: number }) => action === 'probe_pdf' ? { metadata: { page_count: 1, first_page_size_points: [612, 792] } }
    : action === 'render_page' ? { published: [{ artifact_id: 'page-one', metadata: { page: args.page, page_count: 1, page_size_points: [612, 792] } }], limitations: [] }
    : action === 'read_text' ? { text: 'Extracted wording', start: 1, end: 1, total_lines: 1, revision: 1, historical: false, locator: 'evidence:source-one#R1L1-L1', truncated_long_lines: false }
    : action === 'artifact_info' ? { mime: 'application/json', content: { pages: [{ locator: 'p1', text: 'Derived unit' }], limitations: [] } }
    : {});
  const props = { source: pdf, run: (fn: () => Promise<void>) => { void fn(); }, refresh: async () => undefined, onLocatorSelect: vi.fn() };
  const view = render(<EvidenceViewer {...props} />);
  expect(screen.getByRole('tab', { name: 'Original pages' })).toBeTruthy();
  view.rerender(<EvidenceViewer {...props} locator="L1" />);
  await waitFor(() => expect(screen.getByText('Extracted wording')).toBeTruthy());
  expect(screen.getByRole('tab', { name: 'Extracted text' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Original pages' })).toBeNull();
  view.rerender(<EvidenceViewer {...props} locator="artifact:derived-one" />);
  await waitFor(() => expect(screen.getByText(/Derived unit/)).toBeTruthy());
  expect(screen.getByRole('tab', { name: 'Derived view' })).toBeTruthy();
});

it('retries a failed derived view by re-reading that artifact rather than reloading pages', async () => {
  observePdfPages();
  const pdf: Source = { ...source, kind: 'pdf', mime: 'application/pdf', name: 'Derived.pdf' };
  let infoCalls = 0;
  api.mockImplementation(async (action: string) => {
    if (action === 'probe_pdf') return { metadata: { page_count: 1, first_page_size_points: [612, 792] } };
    if (action === 'artifact_info') { infoCalls++; if (infoCalls === 1) throw new Error('Artifact store busy'); return { mime: 'application/json', content: { pages: [{ locator: 'p1', text: 'Recovered derived unit' }], limitations: [] } }; }
    return {};
  });
  render(<EvidenceViewer source={pdf} locator="artifact:derived-two" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect(await screen.findByText('This derived view could not open')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Reload pages' })).toBeNull();
  const probes = api.mock.calls.filter(([action]) => action === 'probe_pdf').length;
  fireEvent.click(screen.getByRole('button', { name: 'Reload derived view' }));
  await waitFor(() => expect(screen.getByText(/Recovered derived unit/)).toBeTruthy());
  expect(api.mock.calls.filter(([action]) => action === 'artifact_info')).toHaveLength(2);
  expect(api.mock.calls.filter(([action]) => action === 'probe_pdf')).toHaveLength(probes);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('offers no retry for a requested PDF page that is outside the document', async () => {
  observePdfPages();
  const pdf: Source = { ...source, kind: 'pdf', mime: 'application/pdf', name: 'Range.pdf' };
  api.mockImplementation(async (action: string, args: { page?: number }) => action === 'probe_pdf' ? { metadata: { page_count: 1, first_page_size_points: [612, 792] } } : action === 'render_page' ? { published: [{ artifact_id: 'page-one', metadata: { page: args.page, page_count: 1, page_size_points: [612, 792] } }], limitations: [] } : {});
  render(<EvidenceViewer source={pdf} locator="page:9" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  expect(await screen.findByText('Requested physical PDF page is outside this document.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Reload pages' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});
