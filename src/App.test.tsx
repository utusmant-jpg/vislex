// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App, { JobsCenter, RecordDetailPanel } from './App';
import type { Snapshot, RecordSummary, WorkingRecord } from './types';

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
beforeEach(() => { localStorage.clear(); api.mockReset(); api.mockResolvedValue({ receipts: [{ id: 'latest', created_at: 'now' }], next_offset: null }); save.mockReset(); });
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
  await waitFor(()=>expect(api).toHaveBeenCalledWith('continue_paused_task',{task_id:'hidden-review'}));
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
  await waitFor(()=>expect(api).toHaveBeenCalledWith('export_record',{record_id:'record-1',expected_revision:1,path:'C:\\synthetic\\saved.md'}));
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
  const search=screen.getByRole('textbox',{name:/Search case/});
  fireEvent.change(search,{target:{value:'hit'}});
  fireEvent.click(screen.getByRole('button',{name:/Search text & meaning/}));
  fireEvent.click(await screen.findByRole('button',{name:/First hit/}));
  expect(screen.getByRole('tab',{name:'Statement.txt'}).getAttribute('aria-selected')).toBe('true');
  await waitFor(()=>expect(api).toHaveBeenCalledWith('read_extract_revision',{source_id:'source-one',revision:1,start:5,count:200}));
  fireEvent.keyDown(window,{key:'k',ctrlKey:true});
  const reopened=screen.getByRole('textbox',{name:/Search case/});
  fireEvent.keyDown(reopened,{key:'ArrowDown'});
  fireEvent.keyDown(reopened,{key:'Enter'});
  await waitFor(()=>expect(api).toHaveBeenCalledWith('read_extract_revision',{source_id:'source-one',revision:1,start:9,count:200}));
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
  fireEvent.change(screen.getByRole('textbox',{name:/Search case/}),{target:{value:'Statement'}});
  fireEvent.click(await screen.findByRole('button',{name:'Statement.txt'}));
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
