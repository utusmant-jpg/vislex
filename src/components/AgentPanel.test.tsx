// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentPanel from './AgentPanel';
import type { Snapshot, Task } from '../types';

const api = vi.hoisted(() => vi.fn());
const progress = vi.hoisted(() => ({ listeners: [] as ((event: { payload: { case_id: string; session_epoch?: number; task_id: string; transmission_id: string; delta: { text: string; characters: number } } }) => void)[] }));
vi.mock('../bridge', () => ({ api, native: true, citationParts: () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (_name: string, listener: (typeof progress.listeners)[number]) => { progress.listeners.push(listener); return () => { progress.listeners = progress.listeners.filter(item => item !== listener); }; } }));

function task(id: string, conversation: string): Task {
  return { id, conversation_id: conversation, prompt: 'Existing question', mode: 'investigate', status: 'running', input_tokens: 0, output_tokens: 0, step: 0, answer: '', error: '', generation: 1, created_at: '2026-09-22T00:00:00Z' };
}
function snapshot(tasks: Task[] = [], jobs: Snapshot['jobs'] = []): Snapshot {
  return { id: 'case-1', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks, jobs, settings: { offline: false, allow_text: true, allow_images: false, model: 'synthetic-model' } };
}
function panel(data: Snapshot, conversationId: string | null = null) {
  const onConversation = vi.fn();
  const refresh = vi.fn(async () => undefined);
  const view = render(<AgentPanel snapshot={data} selection={null} conversationId={conversationId} refresh={refresh} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={vi.fn()} onConversation={onConversation} />);
  return { ...view, onConversation, refresh };
}

describe('chat composer interaction', () => {
  beforeEach(() => { api.mockReset(); api.mockResolvedValue({ task_id: 'new-task', conversation_id: 'new-chat' }); progress.listeners = []; });
  afterEach(cleanup);

  it('shows case counts and puts a suggested check in the composer without sending', () => {
    const data = snapshot();
    data.counts = { audit_seq: 1, source_count: 42, source_bytes: 0, record_count: 3, task_count: 0, job_count: 0, jobs_queued: 0, jobs_running: 0, jobs_failed: 0, jobs_attention: 0, jobs_complete: 0 };
    panel(data);
    expect(screen.getByRole('heading', { name: 'Synthetic case' })).toBeTruthy();
    expect(screen.getByLabelText('Case at a glance').textContent).toContain('42Evidence sources');
    fireEvent.click(screen.getByRole('button', { name: /Build a timeline/ }));
    expect((screen.getByRole('textbox', { name: 'Agent task' }) as HTMLTextAreaElement).value).toContain('Build a timeline');
    expect(api).not.toHaveBeenCalledWith('start_task', expect.anything());
  });

  it('does not claim a recording count from a bounded source page', () => {
    const data = snapshot();
    data.sources = [{ id: 'audio-1', name: 'synthetic.wav', sha256: '', size: 1, mime: 'audio/wav', kind: 'audio', status: 'ready', restricted: false, occurrences: 1, created_at: '2026-09-22T00:00:00Z' }];
    data.counts = { audit_seq: 1, source_count: 83, source_bytes: 1, record_count: 0, task_count: 0, job_count: 0, jobs_queued: 0, jobs_running: 0, jobs_failed: 0, jobs_attention: 0, jobs_complete: 0 };
    panel(data);
    expect(screen.getByRole('button', { name: /Build a timeline from the 83 sources/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review the evidence and summarize key moments/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /1 recording/ })).toBeNull();
  });

  it('sends a new chat while another conversation is running', async () => {
    const { onConversation } = panel(snapshot([task('other-task', 'other-chat')]));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Check this source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('start_task', expect.objectContaining({ prompt: 'Check this source', parent_task_id: null })));
    expect(onConversation).toHaveBeenCalledWith('new-chat');
    expect(screen.queryByRole('button', { name: 'Stop response' })).toBeNull();
  });

  it('stops only the selected conversation and waits for file preparation', async () => {
    const job = { id: 'job-1', source_id: 'source-1', name: 'source.txt', kind: 'auto_prepare', status: 'running', error: '', created_at: '2026-09-22T00:00:00Z', superseded: false };
    const view = panel(snapshot([task('other-task', 'other-chat'), task('current-task', 'current-chat')]), 'current-chat');
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('stop_task', { case_id: 'case-1', task_id: 'current-task' }));
    view.rerender(<AgentPanel snapshot={snapshot([], [job])} selection={null} conversationId={null} refresh={view.refresh} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={vi.fn()} onConversation={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Ask after preparation' } });
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true);
    view.rerender(<AgentPanel snapshot={snapshot([], [{ ...job, status: 'failed', error: 'Synthetic error' }])} selection={null} conversationId={null} refresh={view.refresh} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={vi.fn()} onConversation={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows a completed answer without a repeated AI assessment badge', () => {
    const completed = { ...task('answered', 'current-chat'), status: 'complete', answer: 'The report describes three knocks.' };
    panel(snapshot([completed]), 'current-chat');
    expect(screen.getByText('The report describes three knocks.')).toBeTruthy();
    expect(screen.getByText('Saved response')).toBeTruthy();
    expect(screen.queryByText('AI assessment')).toBeNull();
  });

  it('labels pending usage while a subscription turn is running', () => {
    panel(snapshot([task('current-task', 'current-chat')]), 'current-chat');
    expect(screen.getByRole('button', { name: /Considering the evidence/ })).toBeTruthy();
    // The run clock is a role="timer" (not a live status) so it does not
    // announce every second; it is visible without expanding the activity.
    expect(screen.getByRole('timer').textContent).toContain('Token usage pending');
    expect(screen.queryByText(/0 tokens reported/)).toBeNull();
  });

  it('sends a subscription chat without requiring or passing an API provider model', async () => {
    const data=snapshot();
    data.settings.model='';
    api.mockImplementation(async (action: string) => action === 'ai_access_route'
      ? { route: 'chatgpt_subscription', subscription: { model: 'codex-model', effort: 'high' } }
      : action === 'case_ai_access_route' ? { effective: 'chatgpt_subscription', selection: { model: 'codex-model', effort: 'high' } }
      : { task_id: 'new-task', conversation_id: 'new-chat' });
    panel(data);
    expect(await screen.findByRole('button', { name: 'ChatGPT subscription model' })).toHaveProperty('textContent', 'ChatGPT · codex-model');
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Inspect the synthetic source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('start_task', expect.objectContaining({ prompt: 'Inspect the synthetic source' })));
    const args = api.mock.calls.find(([action]) => action === 'start_task')?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('provider');
    expect(args).not.toHaveProperty('model');
  });

  it('sends the captured open-case epoch with a new task', async () => {
    const data = snapshot(); data.session_epoch = 12;
    panel(data);
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Inspect the source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('start_task', expect.objectContaining({ case_id: 'case-1', session_epoch: 12, prompt: 'Inspect the source' })));
  });

  it('keeps every streamed character beyond 64 KiB through batched updates', async () => {
    panel(snapshot([task('long-task', 'long-chat')]), 'long-chat');
    await waitFor(() => expect(progress.listeners.length).toBeGreaterThan(0));
    const stream = progress.listeners.at(-1)!;
    const prefix = `PREFIX_${'evidence '.repeat(9000)}`;
    stream({ payload: { case_id: 'case-1', task_id: 'long-task', transmission_id: 'tx-1', delta: { text: prefix, characters: prefix.length } } });
    stream({ payload: { case_id: 'case-1', task_id: 'long-task', transmission_id: 'tx-1', delta: { text: 'FINAL_SEGMENT', characters: 13 } } });
    await waitFor(() => expect(document.querySelector('.live-answer')?.textContent).toContain('FINAL_SEGMENT'));
    const rendered = document.querySelector('.live-answer')?.textContent ?? '';
    expect(rendered).toContain('PREFIX_');
    expect(rendered).toContain(prefix.slice(-40));
    expect(rendered).toContain('FINAL_SEGMENT');
  });

  it('ignores progress from a prior opening of the same case', async () => {
    const data = snapshot([task('epoch-task', 'epoch-chat')]); data.session_epoch = 14;
    panel(data, 'epoch-chat');
    await waitFor(() => expect(progress.listeners.length).toBeGreaterThan(0));
    const stream = progress.listeners.at(-1)!;
    stream({ payload: { case_id: 'case-1', session_epoch: 13, task_id: 'epoch-task', transmission_id: 'tx-old', delta: { text: 'Old session text', characters: 16 } } });
    stream({ payload: { case_id: 'case-1', session_epoch: 14, task_id: 'epoch-task', transmission_id: 'tx-new', delta: { text: 'Current session text', characters: 20 } } });
    await waitFor(() => expect(document.querySelector('.live-answer')?.textContent).toContain('Current session text'));
    expect(document.querySelector('.live-answer')?.textContent).not.toContain('Old session text');
  });

  it('allows chat after file preparation while automatic review continues', async () => {
    const data = snapshot([task('review-task', 'review-chat')]);
    data.automatic_analysis = { files: 1, prepared: 1, pending: 0, failed: 0, review_task: 'review-task', review_state: 'running', note: '' };
    panel(data);
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Summarize the prepared document' } });
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('start_task', expect.objectContaining({ prompt: 'Summarize the prepared document' })));
  });

  it('continues paused work in a new task without resuming the uncertain request', async () => {
    const paused = { ...task('old-task', 'current-chat'), status: 'paused', answer: 'Saved partial finding', error: 'Provider response incomplete' };
    api.mockImplementation(async (action:string) => action === 'continue_paused_task' ? { task_id: 'new-task', conversation_id: 'current-chat' } : action === 'conversation_detail' ? { tasks: [paused], has_older: false } : null);
    const { onConversation, refresh } = panel(snapshot([paused]), 'current-chat');
    fireEvent.click(screen.getByRole('button', { name: 'Continue in new task' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('continue_paused_task', { case_id: 'case-1', task_id: 'old-task' }));
    expect(api).not.toHaveBeenCalledWith('resume_task', expect.anything());
    expect(onConversation).toHaveBeenCalledWith('current-chat');
    expect(refresh).toHaveBeenCalled();
  });

  it('ignores a late conversation detail from the previous case', async () => {
    const oldTask={...task('shared-task','shared-chat'),status:'complete',answer:'Old case answer'};
    const newTask={...oldTask,answer:'New case answer'};
    let resolveOld!:(value:{tasks:Task[];has_older:boolean})=>void;
    const oldDetail=new Promise<{tasks:Task[];has_older:boolean}>(resolve=>{resolveOld=resolve;});
    api.mockImplementation((action:string,args:{case_id:string})=>action==='conversation_detail'?(args.case_id==='case-1'?oldDetail:Promise.resolve({tasks:[newTask],has_older:false})):Promise.resolve(null));
    const current=snapshot([oldTask]);
    const view=panel(current,'shared-chat');
    const replacement={...snapshot([newTask]),id:'case-2'};
    view.rerender(<AgentPanel snapshot={replacement} selection={null} conversationId="shared-chat" refresh={view.refresh} run={fn=>{void fn();}} onSource={vi.fn()} onSettings={vi.fn()} onConversation={view.onConversation}/>);
    await waitFor(()=>expect(screen.getByText('New case answer')).toBeTruthy());
    resolveOld({tasks:[oldTask],has_older:false});
    await Promise.resolve();
    expect(screen.queryByText('Old case answer')).toBeNull();
  });

  it('opens older saved turns through a bounded detail page', async () => {
    const recent = {...task('recent','shared-chat'),status:'complete',answer:'Recent saved answer',created_at:'2026-09-22T02:00:00Z'};
    const earlier = {...task('earlier','shared-chat'),status:'complete',answer:'Earlier saved answer',created_at:'2026-09-22T01:00:00Z'};
    api.mockImplementation(async (action:string,args:{before?:{id:string}}) => action==='conversation_detail'
      ? args.before ? {tasks:[earlier],next_cursor:null} : {tasks:[recent],next_cursor:{created_at:recent.created_at,id:recent.id}}
      : null);
    panel(snapshot([recent]),'shared-chat');
    await waitFor(()=>expect(screen.getByRole('button',{name:'Load earlier messages'})).toBeTruthy());
    fireEvent.click(screen.getByRole('button',{name:'Load earlier messages'}));
    await waitFor(()=>expect(screen.getByText('Earlier saved answer')).toBeTruthy());
    expect(screen.getByText('Recent saved answer')).toBeTruthy();
    expect(api).toHaveBeenCalledWith('conversation_detail',{case_id:'case-1',conversation_id:'shared-chat',before:{created_at:recent.created_at,id:recent.id}});
    expect(screen.queryByRole('button',{name:'Load earlier messages'})).toBeNull();
  });

  it('renders a user stop as a neutral stopped turn with resume, not an alert', () => {
    const stopped = { ...task('stopped-task', 'current-chat'), status: 'paused', error: 'Stopped by user' };
    panel(snapshot([stopped]), 'current-chat');
    expect(screen.getByText('Stopped', { selector: '.pill' })).toBeTruthy();
    expect(screen.getByText('Stopped by user.')).toBeTruthy();
    expect(screen.queryByText('Needs attention')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume work' })).toBeTruthy();
  });

  it('keeps raw failure detail behind a disclosure and drafts a retry without sending', () => {
    const failed = { ...task('failed-task', 'current-chat'), prompt: 'Which sources mention the van?', status: 'failed', error: 'Provider returned an error: rate limit' };
    panel(snapshot([failed]), 'current-chat');
    expect(screen.getByText('This response did not complete.')).toBeTruthy();
    const detail = screen.getByText('Provider returned an error: rate limit').closest('details')!;
    expect(detail.open).toBe(false);
    expect(detail.textContent).toContain('Receipt: failed-task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit and ask again' }));
    expect((screen.getByRole('textbox', { name: 'Agent task' }) as HTMLTextAreaElement).value).toBe('Which sources mention the van?');
    expect(api).not.toHaveBeenCalledWith('start_task', expect.anything());
  });

  it('states why sending is unavailable and where in settings to change it', () => {
    const data = snapshot(); data.settings.allow_text = false;
    const onSettings = vi.fn();
    render(<AgentPanel snapshot={data} selection={null} conversationId={null} refresh={vi.fn(async () => undefined)} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={onSettings} onConversation={vi.fn()} />);
    expect(screen.getByText('This case does not permit sending case text to AI.')).toBeTruthy();
    // The dialog opens on its default section, so the path is stated as text
    // and the button makes no claim to land on it.
    expect(screen.getByText('Change this in Settings → This case → AI permissions')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Blocked question' } });
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onSettings).toHaveBeenCalledWith('AI permissions');
    // The case grant is shown apart from the model picker.
    expect(screen.getByRole('button', { name: 'Case text not permitted' })).toBeTruthy();
  });

  it('announces once when the running turn settles', async () => {
    const running = task('live-task', 'current-chat');
    const view = panel(snapshot([running]), 'current-chat');
    const region = document.querySelector('[aria-live="polite"]')!;
    expect(region.textContent).toBe('');
    view.rerender(<AgentPanel snapshot={snapshot([{ ...running, status: 'paused', error: 'Stopped by user' }])} selection={null} conversationId="current-chat" refresh={view.refresh} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={vi.fn()} onConversation={view.onConversation} />);
    await waitFor(() => expect(region.textContent).toBe('Response stopped.'));
  });

  it('announces a repeated outcome again when a second turn settles the same way', async () => {
    const first = task('first-task', 'current-chat');
    const view = panel(snapshot([first]), 'current-chat');
    const region = document.querySelector('[aria-live="polite"]')!;
    const rerender = (tasks: ReturnType<typeof task>[]) => view.rerender(<AgentPanel snapshot={snapshot(tasks)} selection={null} conversationId="current-chat" refresh={view.refresh} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={vi.fn()} onConversation={view.onConversation} />);
    const done = { ...first, status: 'complete', answer: 'First answer' };
    rerender([done]);
    await waitFor(() => expect(region.textContent).toBe('Response saved.'));
    const firstNode = region.firstElementChild;
    const second = { ...task('second-task', 'current-chat'), created_at: '2026-09-22T00:01:00Z' };
    rerender([done, second]);
    rerender([done, { ...second, status: 'complete', answer: 'Second answer' }]);
    // Same text, but a new node, so assistive technology hears it again.
    await waitFor(() => expect(region.firstElementChild).not.toBe(firstNode));
    expect(region.textContent).toBe('Response saved.');
    expect(region.querySelectorAll('span')).toHaveLength(1);
  });

  it('keeps an unsent draft per conversation in memory across conversation switches', () => {
    const one = { ...task('one', 'chat-one'), status: 'complete', answer: 'One' };
    const two = { ...task('two', 'chat-two'), status: 'complete', answer: 'Two' };
    const data = snapshot([one, two]);
    const view = panel(data, 'chat-one');
    const composer = () => screen.getByRole('textbox', { name: 'Agent task' }) as HTMLTextAreaElement;
    fireEvent.change(composer(), { target: { value: 'Draft for chat one' } });
    const props = { snapshot: data, selection: null, refresh: view.refresh, run: (fn: () => Promise<void>) => { void fn(); }, onSource: vi.fn(), onSettings: vi.fn(), onConversation: view.onConversation };
    view.rerender(<AgentPanel {...props} conversationId="chat-two" />);
    expect(composer().value).toBe('');
    view.rerender(<AgentPanel {...props} conversationId="chat-one" />);
    expect(composer().value).toBe('Draft for chat one');
    expect(JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage })).not.toContain('Draft for chat one');
  });

  it('does not select a late chat response after the case changes', async () => {
    let resolveStart!:(value:{task_id:string;conversation_id:string})=>void;
    const start=new Promise<{task_id:string;conversation_id:string}>(resolve=>{resolveStart=resolve;});
    api.mockImplementation((action:string)=>action==='start_task'?start:Promise.resolve(null));
    const view=panel(snapshot([]));
    fireEvent.change(screen.getByRole('textbox',{name:'Agent task'}),{target:{value:'Question for case one'}});
    fireEvent.click(screen.getByRole('button',{name:'Send message'}));
    await waitFor(()=>expect(api).toHaveBeenCalledWith('start_task',expect.objectContaining({case_id:'case-1',prompt:'Question for case one'})));
    view.rerender(<AgentPanel snapshot={{...snapshot([]),id:'case-2'}} selection={null} conversationId={null} refresh={view.refresh} run={fn=>{void fn();}} onSource={vi.fn()} onSettings={vi.fn()} onConversation={view.onConversation}/>);
    resolveStart({task_id:'old-task',conversation_id:'old-chat'});
    await Promise.resolve();
    expect(view.onConversation).not.toHaveBeenCalled();
  });
});
