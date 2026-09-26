// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EvidenceViewer from './EvidenceViewer';
import type { Source, TextPage } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, evidenceUrl: (path: string) => path, formatBytes: (size: number) => `${size} B` }));
vi.mock('../ui', () => ({ Skeleton: () => <span>Loading</span>, Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./FullTranscript', () => ({ default: () => null }));
vi.mock('./RedactionPanel', () => ({ default: () => null }));
vi.mock('./VideoDiscovery', () => ({ default: () => null }));

const source: Source = { id: 'source-one', name: 'Synthetic statement.txt', sha256: 'hash', size: 100, mime: 'text/plain', kind: 'text', status: 'text ready', restricted: false, occurrences: 1, created_at: '2026-09-22T00:00:00Z' };
afterEach(() => { cleanup(); api.mockReset(); });

it('opens a pinned citation against its historical revision and marks the wording as superseded', async () => {
  const historical: TextPage = { text: 'Old exact wording', start: 5, end: 5, total_lines: 9, revision: 1, historical: true, locator: 'evidence:source-one#R1L5-L5', truncated_long_lines: false };
  api.mockImplementation(async (action: string) => action === 'read_extract_revision' ? historical : { ...historical, text: 'Changed active wording', revision: 2, historical: false });
  render(<EvidenceViewer source={source} locator="R1L5-L5" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 1, start: 5, count: 200 }));
  expect(screen.getByText('Old exact wording')).toBeTruthy();
  expect(screen.queryByText('Changed active wording')).toBeNull();
  expect(screen.getByRole('note').textContent).toContain('superseded wording preserved');
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
  const view=render(<EvidenceViewer source={videoSource} run={fn=>{void fn();}} refresh={async()=>undefined} onLocatorSelect={vi.fn()} />);
  const video=view.container.querySelector('video')!;
  video.currentTime=0.6;
  fireEvent.click(screen.getByRole('button',{name:'Inspect next decoded frame'}));
  await waitFor(()=>expect(screen.getByAltText('Decoded frame at source time 0:01.400')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('step_video_frame',{source_id:'source-one',target:0.6,direction:'next'});
  fireEvent.click(screen.getByRole('button',{name:'Inspect next decoded frame'}));
  await waitFor(()=>expect(screen.getByAltText('Decoded frame at source time 0:02.500')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('step_video_frame',{source_id:'source-one',target:1.4,direction:'next'});
  expect(screen.getByRole('button',{name:'Copy frame citation'})).toBeTruthy();
});
