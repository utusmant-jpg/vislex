// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import FullTranscript from './FullTranscript';

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
