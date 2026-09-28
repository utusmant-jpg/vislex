// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import RecordEditor,{reviewLabel} from './RecordEditor';
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

it('formats review state without hiding the stored value',()=>{
  expect(reviewLabel({review:'unreviewed',stale:false})).toEqual({tone:'neutral',label:'Unreviewed'});
  expect(reviewLabel({review:'human-reviewed',stale:false})).toEqual({tone:'success',label:'Human reviewed'});
  expect(reviewLabel({review:'human-reviewed',stale:true})).toEqual({tone:'warning',label:'Needs recheck'});
});

it('opens revision history as a panel, marks the current revision and closes it',async()=>{
  api.mockResolvedValue([
    {revision:2,title:'Working note',content:'Second',actor:'human',review:'unreviewed',reason:'Manual editor save',task_id:null,created_at:'2026-09-26T10:00:00Z'},
    {revision:1,title:'Working note',content:'First',actor:'agent',review:'unreviewed',reason:'Created',task_id:null,created_at:'2026-09-25T10:00:00Z'},
  ]);
  render(<RecordEditor caseId="history-case" sessionEpoch={2} record={record('Second',2)} {...common}/>);
  const toggle=screen.getByRole('button',{name:'History'});
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  const panel=await screen.findByRole('complementary',{name:'Revision history'});
  await waitFor(()=>expect(panel.textContent).toContain('Manual editor save'));
  expect(api).toHaveBeenCalledWith('revisions',{record_id:'same-record'});
  const restore=screen.getAllByRole('button',{name:'Restore as new revision'});
  expect(restore[0].hasAttribute('disabled')).toBe(true);
  expect(restore[1].hasAttribute('disabled')).toBe(false);
  expect(panel.textContent).toContain('Current');
  const close=screen.getByRole('button',{name:'Close revision history'});
  close.focus();
  fireEvent.click(close);
  expect(screen.queryByRole('complementary',{name:'Revision history'})).toBeNull();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  // Focus returns to the toggle instead of falling to the document.
  expect(document.activeElement).toBe(toggle);
});

it('closes the history panel when revisions cannot be read, routing the error to the caller',async()=>{
  api.mockRejectedValue(new Error('History unavailable'));
  const errors:unknown[]=[];
  render(<RecordEditor caseId="history-error" record={record('Saved')} refresh={async()=>undefined} onSource={vi.fn()} run={fn=>{void fn().catch(error=>errors.push(error));}}/>);
  fireEvent.click(screen.getByRole('button',{name:'History'}));
  await waitFor(()=>expect(errors).toHaveLength(1));
  expect(screen.queryByRole('complementary',{name:'Revision history'})).toBeNull();
});

it('switches between editing and preview with pressed-state buttons',()=>{
  render(<RecordEditor caseId="mode-case" record={record('Saved')} {...common}/>);
  expect(screen.getByRole('button',{name:'Edit'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'Preview'}));
  expect(screen.getByRole('button',{name:'Preview'}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('textbox',{name:'Working file content'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.getByRole('textbox',{name:'Working file content'})).toBeTruthy();
});
