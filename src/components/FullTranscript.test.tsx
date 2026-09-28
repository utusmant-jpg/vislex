// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import FullTranscript, {captionParts,highlightMatches} from './FullTranscript';

const api=vi.hoisted(()=>vi.fn());
vi.mock('../bridge',async()=>({...await vi.importActual<typeof import('../bridge')>('../bridge'),api,native:true}));
vi.mock('./SpeakerTurns',()=>({default:()=>null}));
afterEach(()=>{cleanup();api.mockReset();});

it('loads long transcript segments in bounded pages and seeks to a later segment',async()=>{
  api.mockImplementation((action:string,args:Record<string,unknown>)=>{
    if(action==='full_transcription_status')return Promise.resolve({job_id:'run',status:'complete',error:'',progress:{},result:{segmented:true,segments:26,metadata:{container_origin_seconds:0,tracks:[{index:0,origin_seconds:0}]}},record:{content:'Saved transcript summary'}});
    if(action==='transcript_segment_page')return Promise.resolve(args.cursor===null
      ?{segments:[{ordinal:0,track:0,start:1,end:2,text:'Opening words'}],next_cursor:25}
      :{segments:[{ordinal:25,track:0,start:50,end:51,text:'Later words'}],next_cursor:null});
    if(action==='propose_transcript_correction')return Promise.resolve({id:'correction-a',revision:1});
    if(action==='review_transcript_correction')return Promise.resolve({id:'correction-a',review:'accepted'});
    return Promise.resolve(null);
  });
  const onSeek=vi.fn();
  render(<FullTranscript caseId="case-a" sourceId="source-a" run={fn=>{void fn();}} refresh={async()=>undefined} onSeek={onSeek} currentTime={0}/>);
  await waitFor(()=>expect(screen.getByText('Opening words')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('transcript_segment_page',{case_id:'case-a',source_id:'source-a',run_id:'run',cursor:null});
  fireEvent.click(screen.getByRole('button',{name:'Load next 25 segments'}));
  await waitFor(()=>expect(screen.getByText('Later words')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('transcript_segment_page',{case_id:'case-a',source_id:'source-a',run_id:'run',cursor:25});
  fireEvent.click(screen.getByRole('button',{name:/Seek to 50 seconds: Later words/}));
  expect(onSeek).toHaveBeenCalledWith(50);
  fireEvent.click(screen.getAllByRole('button',{name:'Suggest correction'})[1]);
  fireEvent.change(screen.getByRole('textbox',{name:'Correct segment 25'}),{target:{value:'Corrected later words'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Correction reason 25'}),{target:{value:'Checked original audio'}});
  fireEvent.click(screen.getByRole('button',{name:'Save proposal'}));
  await waitFor(()=>expect(screen.getByText(/Correction awaiting human review/)).toBeTruthy());
  expect(api).toHaveBeenCalledWith('propose_transcript_correction',{case_id:'case-a',source_id:'source-a',run_id:'run',ordinal:25,text:'Corrected later words',reason:'Checked original audio'});
  fireEvent.click(screen.getByRole('button',{name:'Accept correction'}));
  await waitFor(()=>expect(screen.getByText(/Accepted human correction/)).toBeTruthy());
});

it('keeps rendered transcript rows bounded after many real-sized cursor pages',async()=>{
  api.mockImplementation((action:string,args:Record<string,unknown>)=>{
    if(action==='full_transcription_status')return Promise.resolve({job_id:'long-run',status:'complete',error:'',progress:{},result:{segmented:true,segments:250,metadata:{container_origin_seconds:0,tracks:[{index:0,origin_seconds:0}]}},record:{content:'Summary'}});
    if(action==='transcript_segment_page'){
      const start=Number(args.cursor??0);
      return Promise.resolve({segments:Array.from({length:25},(_,index)=>({ordinal:start+index,track:0,start:start+index,end:start+index+1,text:`Segment ${start+index}`})),next_cursor:start+25<250?start+25:null});
    }
    return Promise.resolve(null);
  });
  const view=render(<FullTranscript caseId="large-case" sourceId="large-source" run={fn=>{void fn();}} refresh={async()=>undefined} onSeek={vi.fn()} currentTime={0}/>);
  await waitFor(()=>expect(screen.getByText(/25 loaded/)).toBeTruthy());
  for(let page=2;page<=10;page++){
    fireEvent.click(screen.getByRole('button',{name:'Load next 25 segments'}));
    await waitFor(()=>expect(screen.getByText(new RegExp(`${page*25} loaded`))).toBeTruthy());
  }
  expect(view.container.querySelectorAll('.transcript-segment').length).toBeLessThanOrEqual(200);
  expect(screen.getByRole('button',{name:'Show previous 200 loaded segments'})).toBeTruthy();
});

it('keeps legacy long transcript rows bounded while searching the entire saved text',async()=>{
  const content=Array.from({length:10000},(_,index)=>`Line ${index}`).join('\n');
  api.mockImplementation((action:string)=>action==='full_transcription_status'?Promise.resolve({job_id:'legacy-run',status:'complete',error:'',progress:{},result:{segmented:false,metadata:{container_origin_seconds:0,tracks:[]}},record:{content}}):Promise.resolve(null));
  const view=render(<FullTranscript caseId="legacy-case" sourceId="legacy-source" run={fn=>{void fn();}} refresh={async()=>undefined} onSeek={vi.fn()} currentTime={0}/>);
  await waitFor(()=>expect(screen.getByText('Line 199')).toBeTruthy());
  expect(view.container.querySelectorAll('.transcript-plain').length).toBeLessThanOrEqual(200);
  fireEvent.change(screen.getByRole('textbox',{name:'Search transcript'}),{target:{value:'Line 9999'}});
  await waitFor(()=>expect(screen.getByText('Line 9999')).toBeTruthy());
  expect(view.container.querySelectorAll('.transcript-plain')).toHaveLength(1);
});

it('splits caption prefixes into track and time and marks search matches in place',()=>{
  expect(captionParts('track 1 · 00:00:01.000 → 00:00:02.000')).toEqual({track:'1',time:'00:00:01.000 → 00:00:02.000'});
  expect(captionParts('00:01 → 00:02')).toEqual({track:null,time:'00:01 → 00:02'});
  const view=render(<p>{highlightMatches('Blue bag and BLUE car','blue')}</p>);
  expect(Array.from(view.container.querySelectorAll('mark')).map(mark=>mark.textContent)).toEqual(['Blue','BLUE']);
  expect(view.container.textContent).toBe('Blue bag and BLUE car');
  expect(highlightMatches('No query','  ')).toBe('No query');
});

it('shows an empty transcript state with the transcribe action and keeps the honesty line',async()=>{
  api.mockImplementation((action:string)=>Promise.resolve(action==='full_transcription_status'?null:null));
  render(<FullTranscript caseId="empty-case" sessionEpoch={2} sourceId="empty-source" run={fn=>{void fn();}} refresh={async()=>undefined} onSeek={vi.fn()} currentTime={0}/>);
  await waitFor(()=>expect(api).toHaveBeenCalledWith('full_transcription_status',{source_id:'empty-source'}));
  expect(screen.getByText('No full transcript is available. Transcribe this recording using the control above.')).toBeTruthy();
  expect(screen.getByText(/tracks are not speaker identities/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Transcribe recording'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('transcribe_full',{case_id:'empty-case',session_epoch:2,source_id:'empty-source'}));
});

it('announces running transcription with reported units and a neutral cancel',async()=>{
  api.mockImplementation((action:string)=>Promise.resolve(action==='full_transcription_status'?{job_id:'run',status:'running',error:'',progress:{track_number:1,track_count:2,processed_seconds:120.4,estimated_seconds:600,segments:12},result:{},record:null}:null));
  render(<FullTranscript caseId="run-case" sourceId="run-source" run={fn=>{void fn();}} refresh={async()=>undefined} onSeek={vi.fn()} currentTime={0}/>);
  const status=await screen.findByText(/Track 1 of 2 · 120 seconds processed \/ approximately 600 · 12 segments/);
  expect(status.closest('[role="status"]')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Cancel transcription'}).className).toContain('secondary');
});

it('follows playback to a new line without undoing manual paging while the playing line is unchanged',async()=>{
  const time=(seconds:number)=>`00:${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}.000`;
  const content=Array.from({length:1000},(_,index)=>`[track 0 · ${time(index)} → ${time(index+1)}] Spoken line ${index}`).join('\n');
  api.mockImplementation((action:string)=>action==='full_transcription_status'?Promise.resolve({job_id:'follow-run',status:'complete',error:'',progress:{},result:{segmented:false,metadata:{container_origin_seconds:0,tracks:[{index:0,origin_seconds:0}]}},record:{content}}):Promise.resolve(null));
  const props={caseId:'follow-case',sourceId:'follow-source',run:(fn:()=>Promise<void>)=>{void fn();},refresh:async()=>undefined,onSeek:vi.fn()};
  const view=render(<FullTranscript {...props} currentTime={0.5}/>);
  await waitFor(()=>expect(screen.getByText('Showing 1–200 of 1000 transcript lines.')).toBeTruthy());
  expect(screen.getByRole('button',{name:/Seek to 0 seconds: Spoken line 0/}).getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'Show next 200 transcript lines'}));
  expect(screen.getByText('Showing 201–400 of 1000 transcript lines.')).toBeTruthy();
  view.rerender(<FullTranscript {...props} currentTime={0.7}/>);
  expect(screen.getByText('Showing 201–400 of 1000 transcript lines.')).toBeTruthy();
  view.rerender(<FullTranscript {...props} currentTime={700.5}/>);
  await waitFor(()=>expect(screen.getByText('Showing 651–850 of 1000 transcript lines.')).toBeTruthy());
  expect(screen.getByRole('button',{name:/Seek to 700 seconds: Spoken line 700/}).getAttribute('aria-current')).toBe('true');
});
