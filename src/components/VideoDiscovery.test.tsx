// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import VideoDiscovery from './VideoDiscovery';

const api=vi.hoisted(()=>vi.fn());
vi.mock('../bridge',()=>({api,evidenceUrl:(path:string)=>path}));
afterEach(()=>{cleanup();api.mockReset();});

const index=(samples:unknown[])=>({samples,next_offset:null,status:{jobs:[{id:'job',kind:'video_overview_index',status:'running',error:'',result:{next_start:120,interval:5}}],note:''}});

it('switches index mode, opens a sampled frame and seeks from its time',async()=>{
  api.mockResolvedValue(index([{artifact_id:'frame-a',locator:'',metadata:{source_relative_seconds:12.5,playback_seconds:12.5,scene_boundary:true}}]));
  const onFrame=vi.fn(),onSeek=vi.fn();
  render(<VideoDiscovery caseId="case-a" sessionEpoch={4} sourceId="video-a" onFrame={onFrame} onSeek={onSeek}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Sample at 12.500 seconds'}));
  expect(onFrame).toHaveBeenCalledWith('frame-a');
  fireEvent.click(screen.getByRole('button',{name:/12\.500s · Play/}));
  expect(onSeek).toHaveBeenCalledWith(12.5);
  expect(screen.getByText('Scene boundary')).toBeTruthy();
  expect(screen.getByText(/Overview: running · chunks through 120s/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'Overview'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'Text in video'}));
  expect(screen.getByRole('button',{name:'Text in video'}).getAttribute('aria-pressed')).toBe('true');
  await waitFor(()=>expect(api).toHaveBeenCalledWith('browse_video_discovery',expect.objectContaining({kind:'video_ocr',source_id:'video-a'})));
  expect(screen.getByRole('textbox',{name:'Search visible text'})).toBeTruthy();
});

it('states that an empty result does not establish absence',async()=>{
  api.mockResolvedValue(index([]));
  render(<VideoDiscovery sourceId="video-b" onFrame={vi.fn()} onSeek={vi.fn()}/>);
  expect(await screen.findByText('No samples match this range/search yet. Check processing status; this does not establish absence.')).toBeTruthy();
});
