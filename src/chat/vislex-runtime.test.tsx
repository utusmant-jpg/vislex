// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AssistantRuntimeProvider, type AssistantRuntime } from '@assistant-ui/react';
import { contentFingerprint, taskToMessages, turnSignature, useVisLexRuntime } from './vislex-runtime';
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
});

describe('turnSignature', () => {
  it('changes when an answer is rewritten to the same length', () => {
    const before = task({ answer: 'Two people near the entrance.' });
    const after = task({ answer: 'Two people near the entrance!' });
    expect(before.answer.length).toBe(after.answer.length);
    expect(turnSignature(before)).not.toBe(turnSignature(after));
  });

  it('changes when only the error changes', () => {
    expect(turnSignature(task({ status: 'paused', error: 'Stopped by user' })))
      .not.toBe(turnSignature(task({ status: 'paused', error: 'Provider response incomplete' })));
  });

  it('is stable for identical content', () => {
    expect(turnSignature(task())).toBe(turnSignature(task()));
    expect(contentFingerprint('')).toBe(contentFingerprint(''));
  });
});

function Harness({ turns, onNew, onCancel, expose }: { turns: Task[]; onNew: (text: string) => void; onCancel: () => void; expose?: (runtime: AssistantRuntime) => void }) {
  const runtime = useVisLexRuntime({ turns, isRunning: turns.some(t => t.status === 'running'), onNew, onCancel });
  expose?.(runtime);
  return <AssistantRuntimeProvider runtime={runtime}>
    <button onClick={() => void runtime.thread.append({ role: 'user', content: [{ type: 'text', text: 'Runtime question' }] })}>append</button>
  </AssistantRuntimeProvider>;
}

function mirroredText(runtime: AssistantRuntime): string[] {
  return runtime.thread.getState().messages.map(message => message.content.map(part => part.type === 'text' ? part.text : '').join(''));
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

  it('re-mirrors a same-length answer rewrite and an error-only change', async () => {
    let runtime: AssistantRuntime | null = null;
    const expose = (value: AssistantRuntime) => { runtime = value; };
    const view = render(<Harness turns={[task({ answer: 'AAAA' })]} onNew={vi.fn()} onCancel={vi.fn()} expose={expose} />);
    await act(async () => {});
    expect(mirroredText(runtime!)).toContain('AAAA');
    view.rerender(<Harness turns={[task({ answer: 'BBBB' })]} onNew={vi.fn()} onCancel={vi.fn()} expose={expose} />);
    await act(async () => {});
    expect(mirroredText(runtime!)).toContain('BBBB');
    expect(mirroredText(runtime!)).not.toContain('AAAA');
    view.rerender(<Harness turns={[task({ status: 'failed', answer: '', error: 'First failure' })]} onNew={vi.fn()} onCancel={vi.fn()} expose={expose} />);
    await act(async () => {});
    view.rerender(<Harness turns={[task({ status: 'failed', answer: '', error: 'Other failure' })]} onNew={vi.fn()} onCancel={vi.fn()} expose={expose} />);
    await act(async () => {});
    expect(mirroredText(runtime!).join('\n')).toContain('Other failure');
  });
});
