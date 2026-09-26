// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import RecordEditor from './RecordEditor';
import type {WorkingRecord} from '../types';

const api=vi.hoisted(()=>vi.fn());
vi.mock('../bridge',()=>({api}));
vi.mock('@tauri-apps/plugin-dialog',()=>({save:vi.fn()}));
vi.mock('../markdown',()=>({Markdown:()=>null}));
afterEach(()=>{cleanup();api.mockReset();});
const record=(content:string,revision=1):WorkingRecord=>({id:'same-record',title:'Working note',kind:'note',content,revision,actor:'user',review:'unreviewed',protected:false,stale:false,updated_at:'2026-09-26',dependencies:[]});
const common={refresh:async()=>undefined,run:(fn:()=>Promise<void>)=>{void fn().catch(()=>{});},onSource:vi.fn()};

it('keeps drafts isolated by case even when record IDs match',()=>{
  const view=render(<RecordEditor caseId="draft-case-a" record={record('Case A saved')} {...common}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Working file content'}),{target:{value:'Case A draft'}});
  view.rerender(<RecordEditor caseId="draft-case-b" record={record('Case B saved')} {...common}/>);
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Case B saved');
  fireEvent.change(screen.getByRole('textbox',{name:'Working file content'}),{target:{value:'Case B draft'}});
  view.rerender(<RecordEditor caseId="draft-case-a" record={record('Case A saved')} {...common}/>);
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Case A draft');
  view.rerender(<RecordEditor caseId="draft-case-b" record={record('Case B saved')} {...common}/>);
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Case B draft');
});

it('follows new server revisions only while clean and preserves a conflicting draft',async()=>{
  const view=render(<RecordEditor caseId="revision-case" record={record('Version one')} {...common}/>);
  view.rerender(<RecordEditor caseId="revision-case" record={record('Version two',2)} {...common}/>);
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Version two'));
  fireEvent.change(screen.getByRole('textbox',{name:'Working file content'}),{target:{value:'Local draft'}});
  view.rerender(<RecordEditor caseId="revision-case" record={record('Version three',3)} {...common}/>);
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Local draft');
  expect(screen.getByText(/newer revision exists/i)).toBeTruthy();
  expect(screen.getByRole('button',{name:'Save revision'}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Load latest revision'}));
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Version three');
});

it('keeps a draft after a failed save and states its session lifetime',async()=>{
  api.mockRejectedValue(new Error('Conflict'));
  render(<RecordEditor caseId="failed-save-case" record={record('Saved')} {...common}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'Working file content'}),{target:{value:'Unsaved after error'}});
  fireEvent.click(screen.getByRole('button',{name:'Save revision'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('write_record',expect.objectContaining({content:'Unsaved after error',base_revision:1})));
  expect((screen.getByRole('textbox',{name:'Working file content'}) as HTMLTextAreaElement).value).toBe('Unsaved after error');
  expect(screen.getByText(/lost if the app closes or crashes/i)).toBeTruthy();
});

it('sends the displayed case ID when reviewing a working file',async()=>{
  api.mockResolvedValue(null);
  render(<RecordEditor caseId="review-case" sessionEpoch={4} record={record('Saved')} {...common}/>);
  fireEvent.click(screen.getByRole('button',{name:'Mark reviewed'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('review_record',expect.objectContaining({case_id:'review-case',session_epoch:4,record_id:'same-record',revision:1})));
});
