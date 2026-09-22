// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentPanel from './AgentPanel';
import type { Snapshot, Task } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, native: true, citationParts: () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

function task(id: string, conversation: string): Task {
  return { id, conversation_id: conversation, prompt: 'Existing question', mode: 'investigate', status: 'running', budget: 0, reserved: 0, spent: 0, input_tokens: 0, output_tokens: 0, step: 0, answer: '', error: '', generation: 1, created_at: '2026-09-22T00:00:00Z' };
}
function snapshot(tasks: Task[] = [], jobs: Snapshot['jobs'] = []): Snapshot {
  return { id: 'case-1', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks, jobs, settings: { offline: false, allow_text: true, allow_images: false, model: 'synthetic-model', case_budget: 0, input_per_million: 0, output_per_million: 0 }, budget_committed: 0 };
}
function panel(data: Snapshot, conversationId: string | null = null) {
  const onConversation = vi.fn();
  const refresh = vi.fn(async () => undefined);
  const view = render(<AgentPanel snapshot={data} selection={null} conversationId={conversationId} refresh={refresh} run={fn => { void fn(); }} onSource={vi.fn()} onSettings={vi.fn()} onConversation={onConversation} />);
  return { ...view, onConversation, refresh };
}

describe('chat composer interaction', () => {
  beforeEach(() => { api.mockReset(); api.mockResolvedValue({ task_id: 'new-task', conversation_id: 'new-chat' }); });
  afterEach(cleanup);

  it('sends a new chat while another conversation is running', async () => {
    const { onConversation } = panel(snapshot([task('other-task', 'other-chat')]));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent task' }), { target: { value: 'Check this source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('start_task', expect.objectContaining({ prompt: 'Check this source', parent_task_id: null })));
    expect(onConversation).toHaveBeenCalledWith('new-chat');
    expect(screen.queryByRole('button', { name: 'Stop investigation' })).toBeNull();
  });

  it('stops only the selected conversation and waits for file preparation', async () => {
    const job = { id: 'job-1', source_id: 'source-1', name: 'source.txt', kind: 'auto_prepare', status: 'running', error: '', created_at: '2026-09-22T00:00:00Z', superseded: false };
    const view = panel(snapshot([task('other-task', 'other-chat'), task('current-task', 'current-chat')]), 'current-chat');
    fireEvent.click(screen.getByRole('button', { name: 'Stop investigation' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('stop_task', { task_id: 'current-task' }));
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
    expect(screen.queryByText('AI assessment')).toBeNull();
  });

  it('continues paused work in a new task without resuming the uncertain request', async () => {
    const paused = { ...task('old-task', 'current-chat'), status: 'paused', answer: 'Saved partial finding', error: 'Provider response incomplete' };
    api.mockResolvedValueOnce({ task_id: 'new-task', conversation_id: 'current-chat' });
    const { onConversation, refresh } = panel(snapshot([paused]), 'current-chat');
    fireEvent.click(screen.getByRole('button', { name: 'Continue in new task' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('continue_paused_task', { task_id: 'old-task' }));
    expect(api).not.toHaveBeenCalledWith('resume_task', expect.anything());
    expect(onConversation).toHaveBeenCalledWith('current-chat');
    expect(refresh).toHaveBeenCalled();
  });
});
