// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { usePagedSources } from './usePagedSources';
import type { Snapshot, Source } from './types';

const api=vi.hoisted(()=>vi.fn());
vi.mock('./bridge',()=>({api}));
afterEach(()=>{cleanup();api.mockReset();});

function sample(id:string):Snapshot {
  const source:Source={id:'recent',name:'Recent.txt',sha256:'hash',size:1,mime:'text/plain',kind:'text',status:'imported',restricted:false,occurrences:1,created_at:'2026-09-26T10:00:00Z'};
  return {id,name:'Synthetic',root:'C:\\synthetic',generation:1,sources:[source],records:[],tasks:[],settings:{offline:true,allow_text:false,allow_images:false,model:''},counts:{audit_seq:3,source_count:2,source_bytes:2,record_count:0,task_count:0,job_count:0,jobs_queued:0,jobs_running:0,jobs_failed:0,jobs_attention:0,jobs_complete:0}};
}
function Picker({snapshot}:{snapshot:Snapshot}) {
  const page=usePagedSources(snapshot);
  return <><select aria-label="Sources">{page.sources.map(source=><option key={source.id}>{source.name}</option>)}</select>{page.hasMore?<button onClick={()=>void page.loadMore()}>Load more sources</button>:null}</>;
}

it('loads an older source into a picker without repeating the first page',async()=>{
  api.mockResolvedValue({sources:[{...sample('case-1').sources[0],id:'older',name:'Older.txt',created_at:'2026-09-25T00:00:00Z'}],next_cursor:null});
  render(<Picker snapshot={sample('case-1')}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load more sources'}));
  await waitFor(()=>expect(screen.getByRole('option',{name:'Older.txt'})).toBeTruthy());
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(api).toHaveBeenCalledWith('source_page',{case_id:'case-1',generation:1,audit_seq:3,before:{created_at:'2026-09-26T10:00:00Z',id:'recent'}});
});

it('discards a source page returned after a case switch',async()=>{
  let resolve!:(value:{sources:Source[];next_cursor:null})=>void;
  api.mockImplementation(()=>new Promise(result=>{resolve=result;}));
  const view=render(<Picker snapshot={sample('case-1')}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load more sources'}));
  await waitFor(()=>expect(api).toHaveBeenCalledTimes(1));
  view.rerender(<Picker snapshot={{...sample('case-2'),counts:{...sample('case-2').counts!,source_count:1}}}/>);
  resolve({sources:[{...sample('case-1').sources[0],id:'old-only',name:'Old only.txt'}],next_cursor:null});
  await Promise.resolve();
  expect(screen.queryByRole('option',{name:'Old only.txt'})).toBeNull();
});

it('continues from the first-page cursor when an arbitrary older source is already open',async()=>{
  const current=sample('case-1');
  current.sources.push({...current.sources[0],id:'selected-ancient',name:'Selected ancient.txt',created_at:'2026-09-01T00:00:00Z'});
  current.source_next_cursor={created_at:'2026-09-26T10:00:00Z',id:'recent'};
  current.counts={...current.counts!,source_count:3};
  api.mockResolvedValue({sources:[{...current.sources[0],id:'middle',name:'Middle.txt',created_at:'2026-09-20T00:00:00Z'}],next_cursor:null});
  render(<Picker snapshot={current}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load more sources'}));
  await waitFor(()=>expect(screen.getByRole('option',{name:'Middle.txt'})).toBeTruthy());
  expect(api).toHaveBeenCalledWith('source_page',expect.objectContaining({before:{created_at:'2026-09-26T10:00:00Z',id:'recent'}}));
});
