// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { taskToMessages, turnStatus, useVisLexRuntime } from './vislex-runtime';
import type { Task } from '../types';

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'task-1', conversation_id: 'chat-1', prompt: 'Check the statement', mode: 'investigate', status: 'complete', input_tokens: 3, output_tokens: 5, step: 2, answer: 'Two people near the entrance.', error: '', generation: 1, created_at: '2026-09-22T00:00:00Z', ...overrides };
}

describe('taskToMessages', () => {
  it('maps a prompt and answer into a user and an assistant message', () => {
    const messages = taskToMessages(task());
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Check the statement', id: 'task-1:user' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Two people near the entrance.', id: 'task-1:assistant' });
  });

  it('surfaces the error receipt as the assistant message when there is no answer', () => {
    const messages = taskToMessages(task({ status: 'failed', answer: '', error: 'Provider stopped' }));
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(String(messages[1].content)).toContain('Provider stopped');
    expect(String(messages[1].content)).toContain('Receipt: task-1');
  });

  it('omits the assistant message while a turn is still starting', () => {
    expect(taskToMessages(task({ status: 'running', answer: '', error: '' }))).toHaveLength(1);
  });

  it('mirrors a user Stop as cancelled, never as an error', () => {
    const stopped = taskToMessages(task({ status: 'paused', answer: '', error: 'Stopped by user' }));
    expect(stopped[1].status).toEqual({ type: 'incomplete', reason: 'cancelled' });
    expect(turnStatus(task({ status: 'failed', answer: '', error: 'Provider stopped' }))).toEqual({ type: 'incomplete', reason: 'error', error: 'Provider stopped' });
    expect(turnStatus(task())).toEqual({ type: 'complete', reason: 'stop' });
    expect(turnStatus(task({ status: 'running' }))).toEqual({ type: 'running' });
    expect(turnStatus(task({ status: 'paused', error: 'Provider response incomplete' }))).toEqual({ type: 'incomplete', reason: 'other' });
  });
});

function Harness({ turns, onNew, onCancel }: { turns: Task[]; onNew: (text: string) => void; onCancel: () => void }) {
  const runtime = useVisLexRuntime({ turns, isRunning: turns.some(t => t.status === 'running'), onNew, onCancel });
  return <AssistantRuntimeProvider runtime={runtime}>
    <button onClick={() => void runtime.thread.append({ role: 'user', content: [{ type: 'text', text: 'Runtime question' }] })}>append</button>
  </AssistantRuntimeProvider>;
}

describe('useVisLexRuntime', () => {
  it('routes a thread append through onNew with the message text', async () => {
    const onNew = vi.fn();
    render(<Harness turns={[task()]} onNew={onNew} onCancel={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'append' }));
    });
    expect(onNew).toHaveBeenCalledWith('Runtime question');
  });

  it('routes a runtime cancel to onCancel while a turn runs', async () => {
    const onCancel = vi.fn();
    function Cancel() {
      const runtime = useVisLexRuntime({ turns: [task({ status: 'running', answer: '' })], isRunning: true, onNew: vi.fn(), onCancel });
      return <AssistantRuntimeProvider runtime={runtime}><button onClick={() => runtime.thread.cancelRun()}>cancel</button></AssistantRuntimeProvider>;
    }
    render(<Cancel />);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'cancel' }).at(-1)!); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
