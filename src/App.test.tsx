// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { EvidenceLibrary, JobsCenter, RecordDetailPanel } from './App';
import type { Snapshot, RecordSummary, Source, WorkingRecord } from './types';

const api = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock('./bridge', async () => ({ ...await vi.importActual<typeof import('./bridge')>('./bridge'), api, native: false, formatBytes: (value:number) => `${value} bytes` }));
vi.mock('@tauri-apps/plugin-dialog', async () => ({ ...await vi.importActual<typeof import('@tauri-apps/plugin-dialog')>('@tauri-apps/plugin-dialog'), save }));

function snapshot(): Snapshot {
  return {
    id: 'synthetic-case', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [],
    settings: { offline: true, allow_text: false, allow_images: false, model: '' },
    jobs: [
      { id: 'index-run', source_id: 'source', name: 'synthetic.mp4', kind: 'video_ocr_index', status: 'failed', error: 'resource error', created_at: '', superseded: false },
      { id: 'child-job', parent_run_id: 'index-run', source_id: 'source', name: 'synthetic.mp4', kind: 'video_ocr', status: 'failed', error: 'resource error', created_at: '', superseded: false },
    ],
    issues: [{ task_id: 'task', name: 'save_dossier', error: 'invalid check tool', count: 9, latest_receipt: 'latest', created_at: '' }],
  };
}
beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 1440, writable: true, configurable: true }); localStorage.clear(); api.mockReset(); api.mockResolvedValue({ receipts: [{ id: 'latest', created_at: 'now' }], next_offset: null }); save.mockReset(); });
afterEach(cleanup);

it('retries the parent discovery run from both failed job cards', async () => {
  render(<JobsCenter snapshot={snapshot()} run={fn => { void fn(); }} refresh={async () => undefined} />);
  const buttons = screen.getAllByRole('button', { name: 'Retry index from saved progress' });
  fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api).toHaveBeenNthCalledWith(1, 'retry_video_discovery', { run_id: 'index-run' });
  expect(api).toHaveBeenNthCalledWith(2, 'retry_video_discovery', { run_id: 'index-run' });
});

it('groups old AI tool errors and loads their receipts only when expanded', async () => {
  render(<JobsCenter snapshot={snapshot()} run={fn => { void fn(); }} refresh={async () => undefined} />);
  expect(screen.getByText('Previous AI tool errors (1 group)')).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
  const group = screen.getByText('save dossier · 9 previous failures');
  fireEvent.click(group);
  await waitFor(() => expect(api).toHaveBeenCalledWith('issue_history', { receipt_id: 'latest', offset: 0 }));
  expect(await screen.findByText(/Receipt latest/)).toBeTruthy();
});

it('keeps a failed older run in history while its replacement is queued', () => {
  const current=snapshot();
  current.jobs![0].superseded=true;
  current.jobs![1].superseded=true;
  current.jobs![1].status='interrupted';
  current.jobs!.push({id:'replacement',source_id:'source',name:'synthetic.mp4',kind:'video_ocr_index',status:'queued',error:'',created_at:'',superseded:false});
  render(<JobsCenter snapshot={current} run={fn => { void fn(); }} refresh={async () => undefined} />);
  expect(screen.getByText('Earlier failures and interruptions replaced by newer runs (2)')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry index from saved progress' })).toBeNull();
  expect(screen.getAllByText('queued').length).toBeGreaterThan(0);
});

it('loads an older evidence page and opens its source', async () => {
  const current=snapshot();
  current.sources=Array.from({length:50},(_,index):Source=>({id:`source-${index}`,name:`Recent ${index}.txt`,sha256:`sha-${index}`,size:1,mime:'text/plain',kind:'text',status:'imported',restricted:false,occurrences:1,created_at:`2026-09-26T10:${String(59-index).padStart(2,'0')}:00Z`}));
  current.counts={audit_seq:7,source_count:51,source_bytes:51,record_count:0,task_count:0,job_count:0,jobs_queued:0,jobs_running:0,jobs_failed:0,jobs_attention:0,jobs_complete:0};
  const older={...current.sources[0],id:'older-source',name:'Older source.txt',created_at:'2026-09-25T00:00:00Z'};
  api.mockResolvedValue({sources:[older],next_cursor:null});
  const onOpen=vi.fn();const onSourceLoaded=vi.fn();
  render(<EvidenceLibrary snapshot={current} onOpen={onOpen} onOpenRecord={vi.fn()} onRename={vi.fn()} onRestrict={vi.fn()} onSourceLoaded={onSourceLoaded} onRecordLoaded={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load more sources'}));
  await waitFor(()=>expect(screen.getByText('Older source.txt')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('source_page',{case_id:'synthetic-case',generation:1,audit_seq:7,before:{created_at:current.sources[49].created_at,id:'source-49'}});
  fireEvent.click(screen.getByText('Older source.txt').closest('button')!);
  expect(onOpen).toHaveBeenCalledWith('older-source');
  expect(onSourceLoaded).toHaveBeenCalledWith([older]);
});

it('loads older job receipts from a bounded page', async () => {
  const current=snapshot();current.job_next_cursor=10;
  const historical={...current.jobs![0],id:'older-job',name:'older.mp4',status:'failed',superseded:true};
  api.mockResolvedValue({jobs:[historical],next_cursor:null});
  render(<JobsCenter snapshot={current} run={fn=>{void fn();}} refresh={async()=>undefined}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load older jobs'}));
  await waitFor(()=>expect(screen.getByText('Earlier failures and interruptions replaced by newer runs (1)')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('job_page',{case_id:'synthetic-case',before:10});
  expect(screen.queryByRole('button',{name:'Load older jobs'})).toBeNull();
});

it('shows a current older failure immediately beside recent completed jobs', () => {
  const current=snapshot();
  current.jobs=[{...current.jobs![0],id:'recent-success',status:'complete',error:''}];
  current.attention_jobs=[{...current.jobs[0],id:'old-current-failure',name:'Older recording.mp4',status:'failed',error:'Recover from saved index',superseded:false}];
  render(<JobsCenter snapshot={current} run={fn=>{void fn();}} refresh={async()=>undefined}/>);
  expect(screen.getByText('Older recording.mp4')).toBeTruthy();
  expect(screen.getByText('Recover from saved index')).toBeTruthy();
  expect(screen.getByText('Receipt old-current-failure')).toBeTruthy();
});

it('shows live job units from a case-scoped progress read', async () => {
  const current=snapshot();
  current.jobs=[{...current.jobs![0],id:'running-index',status:'running',error:''}];
  api.mockImplementation((action:string)=>action==='job_progress'?Promise.resolve({priority:'background',attempt:2,progress:{unit:'seconds indexed',completed:120}}):Promise.resolve(null));
  render(<JobsCenter snapshot={current} run={fn=>{void fn();}} refresh={async()=>undefined} pollProgress/>);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('120 seconds indexed'));
  expect(screen.getByRole('status').textContent).toContain('background · attempt 2');
  expect(api).toHaveBeenCalledWith('job_progress',{case_id:'synthetic-case',job_id:'running-index'});
});

it('ignores an older source page returned after switching cases', async () => {
  const oldCase=snapshot();
  oldCase.sources=Array.from({length:50},(_,index):Source=>({id:`old-${index}`,name:`Old ${index}.txt`,sha256:`hash-${index}`,size:1,mime:'text/plain',kind:'text',status:'imported',restricted:false,occurrences:1,created_at:`2026-09-26T10:${String(59-index).padStart(2,'0')}:00Z`}));
  oldCase.counts={audit_seq:1,source_count:51,source_bytes:51,record_count:0,task_count:0,job_count:0,jobs_queued:0,jobs_running:0,jobs_failed:0,jobs_attention:0,jobs_complete:0};
  let resolvePage!:(value:{sources:Source[];next_cursor:null})=>void;
  api.mockImplementation((action:string)=>action==='source_page'?new Promise(resolve=>{resolvePage=resolve;}):Promise.resolve(null));
  const loaded=vi.fn();const props={onOpen:vi.fn(),onOpenRecord:vi.fn(),onRename:vi.fn(),onRestrict:vi.fn(),onSourceLoaded:loaded,onRecordLoaded:vi.fn()};
  const view=render(<EvidenceLibrary snapshot={oldCase} {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load more sources'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('source_page',expect.objectContaining({case_id:'synthetic-case'})));
  view.rerender(<EvidenceLibrary snapshot={{...snapshot(),id:'new-case'}} {...props}/>);
  resolvePage({sources:[{...oldCase.sources[0],id:'late-old',name:'Late old source.txt'}],next_cursor:null});
  await Promise.resolve();
  expect(screen.queryByText('Late old source.txt')).toBeNull();
  expect(loaded).not.toHaveBeenCalled();
});

it('shows a failed automatic review even when its original chat is hidden', async () => {
  const current=snapshot();
  current.jobs=[];
  current.automatic_analysis={files:1,prepared:1,pending:0,failed:0,review_task:'hidden-review',review_state:'failed',note:''};
  const onConversation=vi.fn();
  api.mockResolvedValueOnce({task_id:'continued-review',conversation_id:'continued-review'});
  render(<JobsCenter snapshot={current} run={fn => { void fn(); }} refresh={async () => undefined} onConversation={onConversation} />);
  expect(screen.getByText('Automatic case analysis')).toBeTruthy();
  expect(screen.queryByText('No active processing jobs')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Continue saved review'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('continue_paused_task',{case_id:'synthetic-case',task_id:'hidden-review'}));
  expect(onConversation).toHaveBeenCalledWith('continued-review');
});

it('loads record text on selection and ignores a late result from another case', async () => {
  const summary:RecordSummary={id:'same-id',title:'Synthetic note',kind:'note',revision:1,actor:'human',review:'unreviewed',protected:false,stale:false,updated_at:'now',dependencies:[]};
  let resolveOld!:(record:WorkingRecord)=>void;
  const old=new Promise<WorkingRecord>(resolve=>{resolveOld=resolve;});
  api.mockImplementation((action:string,args:{case_id?:string})=>action==='record_detail'?(args.case_id==='old-case'?old:Promise.resolve({...summary,content:'New case text'})):Promise.resolve(null));
  const props={summary,run:(fn:()=>Promise<void>)=>{void fn();},refresh:async()=>undefined,onSource:vi.fn()};
  const view=render(<RecordDetailPanel caseId="old-case" {...props}/>);
  expect(screen.getByText('Loading working file…')).toBeTruthy();
  view.rerender(<RecordDetailPanel caseId="new-case" {...props}/>);
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('New case text'));
  resolveOld({...summary,content:'Old case text'});
  await Promise.resolve();
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('New case text');
  expect(api).toHaveBeenCalledWith('record_detail',{case_id:'new-case',record_id:'same-id',revision:1});
});

it('keeps unsaved editor drafts inside their original case', async () => {
  const summary:RecordSummary={id:'shared-record',title:'Synthetic note',kind:'note',revision:1,actor:'human',review:'unreviewed',protected:false,stale:false,updated_at:'now',dependencies:[]};
  api.mockImplementation(async (action:string,args:{case_id:string})=>action==='record_detail'?{...summary,content:args.case_id==='case-a'?'Case A saved text':'Case B saved text'}:null);
  const props={summary,run:(fn:()=>Promise<void>)=>{void fn();},refresh:async()=>undefined,onSource:vi.fn()};
  const view=render(<RecordDetailPanel caseId="case-a" {...props}/>);
  const editor=await screen.findByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement;
  fireEvent.change(editor,{target:{value:'Case A unsaved draft'}});
  view.rerender(<RecordDetailPanel caseId="case-b" {...props}/>);
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Case B saved text'));
  view.rerender(<RecordDetailPanel caseId="case-a" {...props}/>);
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Case A unsaved draft'));
});

it('keeps an unsaved draft when switching working file tabs without sending it', async () => {
  const first:RecordSummary={id:'tab-one',title:'First note',kind:'note',revision:1,actor:'human',review:'unreviewed',protected:false,stale:false,updated_at:'now',dependencies:[]};
  const second={...first,id:'tab-two',title:'Second note'};
  api.mockImplementation(async (action:string,args:{record_id:string})=>action==='record_detail'?{...(args.record_id==='tab-one'?first:second),content:args.record_id==='tab-one'?'First saved':'Second saved'}:null);
  const props={caseId:'synthetic-case',run:(fn:()=>Promise<void>)=>{void fn();},refresh:async()=>undefined,onSource:vi.fn()};
  const view=render(<RecordDetailPanel summary={first} {...props}/>);
  fireEvent.change(await screen.findByRole('textbox',{name:'Working file content'}),{target:{value:'Private unsaved draft'}});
  view.rerender(<RecordDetailPanel summary={second} {...props}/>);
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Second saved'));
  view.rerender(<RecordDetailPanel summary={first} {...props}/>);
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Private unsaved draft'));
  expect(api).not.toHaveBeenCalledWith('write_record',expect.anything());
});

it('opens a record preview citation and states that export uses saved text', async () => {
  const summary:RecordSummary={id:'record-1',title:'Synthetic note',kind:'note',revision:1,actor:'human',review:'unreviewed',protected:false,stale:false,updated_at:'now',dependencies:['source-one']};
  api.mockImplementation(async (action:string)=>action==='record_detail'?{...summary,content:'See evidence:source-one#R1L5-L5'}:null);
  save.mockResolvedValue('C:\\synthetic\\saved.md');
  const onSource=vi.fn();
  render(<RecordDetailPanel caseId="synthetic-case" summary={summary} run={fn=>{void fn();}} refresh={async()=>undefined} onSource={onSource}/>);
  await screen.findByRole('textbox',{name:'Working file content'});
  fireEvent.click(screen.getByRole('button',{name:'Preview'}));
  fireEvent.click(screen.getByTitle('evidence:source-one#R1L5-L5'));
  expect(onSource).toHaveBeenCalledWith('source-one','R1L5-L5');
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Working file content'}),{target:{value:'Unsaved revision text'}});
  expect(screen.getByText('Export uses the saved revision. Save your changes first to include them.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Export saved revision'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('export_record',{case_id:'synthetic-case',record_id:'record-1',expected_revision:1,path:'C:\\synthetic\\saved.md'}));
});

it('opens the clicked palette search hit at its exact historical locator', async () => {
  const current=snapshot();
  current.sources=[{id:'source-one',name:'Statement.txt',sha256:'hash',size:100,mime:'text/plain',kind:'text',status:'text ready',restricted:false,occurrences:1,created_at:'now'}];
  api.mockImplementation(async (action:string)=>action==='snapshot'?current:action==='hybrid_search'?{results:[
    {source_id:'source-one',name:'First hit',excerpt:'first',locator:'evidence:source-one#R1L5-L5'},
    {source_id:'source-one',name:'Second hit',excerpt:'second',locator:'evidence:source-one#R1L9-L9'},
  ],remaining_passages:0}:action==='storage_usage'?{}:null);
  render(<App/>);
  await screen.findAllByText('Synthetic case');
  fireEvent.keyDown(window,{key:'k',ctrlKey:true});
  const search=screen.getByRole('combobox',{name:/Search case/});
  fireEvent.change(search,{target:{value:'hit'}});
  fireEvent.click(screen.getByRole('button',{name:/Search text & meaning/}));
  fireEvent.click(await screen.findByRole('option',{name:/First hit/}));
  expect(screen.getByRole('tab',{name:'Statement.txt'}).getAttribute('aria-selected')).toBe('true');
  await waitFor(()=>expect(api).toHaveBeenCalledWith('read_extract_revision',{source_id:'source-one',revision:1,start:5,count:200}));
  fireEvent.keyDown(window,{key:'k',ctrlKey:true});
  const reopened=screen.getByRole('combobox',{name:/Search case/});
  fireEvent.keyDown(reopened,{key:'ArrowDown'});
  fireEvent.keyDown(reopened,{key:'Enter'});
  await waitFor(()=>expect(api).toHaveBeenCalledWith('read_extract_revision',{source_id:'source-one',revision:1,start:9,count:200}));
  fireEvent.click(screen.getByRole('button',{name:'Previous location'}));
  await waitFor(()=>expect(api.mock.calls.filter(([action,args])=>action==='read_extract_revision' && args.start===5).length).toBeGreaterThan(1));
  fireEvent.click(screen.getByRole('button',{name:'Next location'}));
  await waitFor(()=>expect(api.mock.calls.filter(([action,args])=>action==='read_extract_revision' && args.start===9).length).toBeGreaterThan(1));
});

it('opens a cited source that is outside the first case page', async () => {
  const current=snapshot();current.sources=[];current.records=[];current.jobs=[];
  const older:Source={id:'older-source',name:'Older statement.txt',sha256:'hash',size:20,mime:'text/plain',kind:'text',status:'text ready',restricted:false,occurrences:1,created_at:'2026-09-01T00:00:00Z'};
  api.mockImplementation(async (action:string)=>action==='snapshot'?current:action==='hybrid_search'?{results:[{source_id:older.id,name:older.name,excerpt:'older evidence',locator:`evidence:${older.id}#R1L2-L2`}],remaining_passages:0}:action==='source_detail'?older:action==='storage_usage'?{}:null);
  render(<App/>);
  await screen.findAllByText('Synthetic case');
  fireEvent.keyDown(window,{key:'k',ctrlKey:true});
  fireEvent.change(screen.getByRole('combobox',{name:/Search case/}),{target:{value:'older evidence'}});
  fireEvent.click(screen.getByRole('button',{name:/Search text & meaning/}));
  fireEvent.click(await screen.findByRole('option',{name:/Older statement/}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('source_detail',{case_id:'synthetic-case',source_id:'older-source'}));
  await waitFor(()=>expect(screen.getByRole('tab',{name:'Older statement.txt'})).toBeTruthy());
});

it('loads older chats by cursor and fetches the full selected answer on demand', async () => {
  const current=snapshot();
  current.jobs=[];
  current.tasks=Array.from({length:50},(_,index)=>({id:`recent-${index}`,conversation_id:`recent-${index}`,prompt:`Recent question ${index}`,mode:'investigate',status:'complete',input_tokens:1,output_tokens:1,step:1,answer:'Short preview',error:'',generation:1,created_at:`2026-09-26T10:${String(59-index).padStart(2,'0')}:00Z`}));
  const old={...current.tasks[0],id:'old-chat',conversation_id:'old-chat',prompt:'Older question',answer:'Long answer preview',answer_truncated:true,created_at:'2026-09-25T00:00:00Z'};
  const full='Exact saved answer '.repeat(100);
  api.mockImplementation(async (action:string,args:{conversation_id?:string})=>action==='snapshot'?current:action==='task_page'?{tasks:[old],next_cursor:null}:action==='conversation_detail'?{tasks:args.conversation_id==='old-chat'?[{...old,answer:full}]:[],has_older:false}:action==='storage_usage'?{}:null);
  render(<App/>);
  await screen.findAllByText('Synthetic case');
  fireEvent.click(screen.getByRole('button',{name:'Show all chats'}));
  fireEvent.click(screen.getByRole('button',{name:'Load older chats'}));
  fireEvent.click(await screen.findByTitle('Older question'));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('conversation_detail',{case_id:'synthetic-case',conversation_id:'old-chat'}));
  await waitFor(()=>expect(document.querySelector('.answer')?.textContent?.length).toBeGreaterThan(1000));
  expect(document.querySelector('.answer')?.textContent).toContain(full.trim());
});

it('takes a selected historical text range to Chat and focuses the composer', async () => {
  const current=snapshot();
  current.sources=[{id:'source-one',name:'Statement.txt',sha256:'hash',size:100,mime:'text/plain',kind:'text',status:'text ready',restricted:false,occurrences:1,created_at:'now'}];
  api.mockImplementation(async (action:string)=>action==='snapshot'?current:action==='read_text'?{text:'selected wording',start:5,end:5,total_lines:10,revision:1,locator:'evidence:source-one#R1L5-L5',truncated_long_lines:false}:action==='storage_usage'?{}:null);
  const selection=vi.spyOn(window,'getSelection').mockReturnValue({isCollapsed:false,containsNode:()=>true} as unknown as globalThis.Selection);
  render(<App/>);
  await screen.findAllByText('Synthetic case');
  fireEvent.click(screen.getByRole('button',{name:'Evidence'}));
  fireEvent.keyDown(window,{key:'k',ctrlKey:true});
  fireEvent.change(screen.getByRole('combobox',{name:/Search case/}),{target:{value:'Statement'}});
  fireEvent.click(await screen.findByRole('option',{name:'Statement.txt'}));
  await screen.findByText('selected wording');
  fireEvent.mouseUp(screen.getByText('selected wording').closest('.document-page')!);
  fireEvent.click(screen.getByRole('button',{name:/Ask about L1/}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Chat'}).getAttribute('aria-current')).toBe('true'));
  expect(screen.getByRole('textbox',{name:'Agent task'})).toBe(document.activeElement);
  selection.mockRestore();
});

it('discards a refresh from the previous case after switching projects', async () => {
  const old=snapshot();
  const next={...snapshot(),id:'new-case',name:'New case',root:'C:\\new-case'};
  localStorage.setItem('vislex-projects',JSON.stringify([{id:next.id,name:next.name,root:next.root}]));
  let resolveOld!:(value:Snapshot)=>void;
  const late=new Promise<Snapshot>(resolve=>{resolveOld=resolve;});
  let reads=0;
  api.mockImplementation(async (action:string)=>action==='snapshot'?(++reads===1?old:late):action==='open_case'?next:action==='storage_usage'?{}:null);
  render(<App/>);
  await screen.findAllByText('Synthetic case');
  fireEvent.click(screen.getByRole('button',{name:'Jobs'}));
  fireEvent.click(screen.getByRole('button',{name:'Queue missing full transcripts'}));
  await waitFor(()=>expect(reads).toBe(2));
  fireEvent.click(screen.getByText('New case',{selector:'summary span'}));
  fireEvent.click(screen.getByRole('button',{name:'Open project'}));
  await screen.findAllByText('New case');
  resolveOld(old);
  await Promise.resolve();
  expect(screen.getByText('New case',{selector:'.title-case'})).toBeTruthy();
});

it('keeps the latest same-case refresh when an earlier request returns last', async () => {
  const initial=snapshot();
  const newest={...snapshot(),name:'Latest saved name'};
  let resolveEarlier!:(value:Snapshot)=>void;
  const earlier=new Promise<Snapshot>(resolve=>{resolveEarlier=resolve;});
  let reads=0;
  api.mockImplementation(async (action:string)=>action==='snapshot'?(++reads===1?initial:reads===2?earlier:newest):action==='storage_usage'?{}:null);
  render(<App/>);
  await screen.findAllByText('Synthetic case');
  fireEvent.click(screen.getByRole('button',{name:'Jobs'}));
  fireEvent.click(screen.getByRole('button',{name:'Queue missing full transcripts'}));
  await waitFor(()=>expect(reads).toBe(2));
  fireEvent.click(screen.getByRole('button',{name:'Queue missing full transcripts'}));
  await screen.findByText('Latest saved name',{selector:'.title-case'});
  resolveEarlier(initial);
  await Promise.resolve();
  expect(screen.getByText('Latest saved name',{selector:'.title-case'})).toBeTruthy();
});

it('collapses navigation at narrow widths and lets the user reopen it', async () => {
  window.innerWidth = 1000;
  api.mockImplementation(async (action:string) => action === 'snapshot' ? null : null);
  render(<App />);
  const toggle = await screen.findByRole('button', { name: 'Show navigation' });
  expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Hide navigation' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
});

it('opens appearance and about settings before a case is selected', async () => {
  api.mockImplementation(async (action:string) => action === 'snapshot' ? null : null);
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('dialog', { name: 'Workspace settings' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
  expect(localStorage.getItem('vislex-density')).toBe('compact');
  fireEvent.click(screen.getByRole('button', { name: 'About' }));
  expect(screen.getByText(/Cases are stored in local/)).toBeTruthy();
});

it('keeps the command palette useful without a case and exposes keyboard selection', async () => {
  api.mockImplementation(async (action:string) => action === 'snapshot' ? null : null);
  render(<App />);
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const search = screen.getByRole('combobox', { name: 'Search commands' });
  expect(search.getAttribute('aria-activedescendant')).toBe('case-command-item-0');
  expect(screen.getByRole('option', { name: /Open settings/ })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /Delete this case/ })).toBeNull();
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(screen.getByRole('dialog', { name: 'Workspace settings' })).toBeTruthy();
});

it('opens workspace settings with the global shortcut before a case exists', async () => {
  api.mockImplementation(async (action:string) => action === 'snapshot' ? null : null);
  render(<App />);
  fireEvent.keyDown(window, { key: ',', ctrlKey: true });
  expect(screen.getByRole('dialog', { name: 'Workspace settings' })).toBeTruthy();
});

it('cancels case creation without calling the backend', async () => {
  api.mockImplementation(async (action:string) => action === 'snapshot' ? null : null);
  render(<App />);
  const trigger = screen.getByRole('button', { name: /Create a case/ });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('heading', { name: 'Create a local case' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('heading', { name: 'Create a local case' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(api).not.toHaveBeenCalledWith('create_case', expect.anything());
});

it('shows an informational findings preview with no empty-page pagination', async () => {
  api.mockImplementation(async (action:string) => action === 'snapshot' ? snapshot() : action === 'storage_usage' ? {} : null);
  render(<App />);
  await screen.findAllByText('Synthetic case');
  fireEvent.click(screen.getByRole('button', { name: 'Findings' }));
  expect(await screen.findByRole('heading', { name: 'No findings on this page' })).toBeTruthy();
  expect(screen.getByText(/This browser shows the layout only/)).toBeTruthy();
  expect(screen.getAllByText(/Structured evidence storage/)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
});
