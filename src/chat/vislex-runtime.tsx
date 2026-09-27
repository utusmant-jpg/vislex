import { useMemo } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';

import type { Task } from '../types';

/**
 * Bridges the Rust-owned conversation state to assistant-ui.
 *
 * The backend remains the single source of truth: turns arrive from the case
 * snapshot (and conversation_detail paging), streaming text still flows
 * through `agent-progress` events, and the final authoritative answer still
 * lands via the case-event snapshot refresh. This adapter mirrors that state
 * into assistant-ui's ExternalStoreRuntime so the chat surface can adopt its
 * thread/composer/tool components, and routes sends through
 * `runtime.thread.append` — the send button talks to assistant-ui, which
 * calls back into `onNew` below.
 */

export function taskToMessages(turn: Task): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [
    { role: 'user', content: turn.prompt, id: `${turn.id}:user`, createdAt: turn.created_at ? new Date(turn.created_at) : undefined },
  ];
  const answer = turn.answer || (turn.error ? `${turn.error}\n\n(Receipt: ${turn.id})` : '');
  if (answer) {
    messages.push({
      role: 'assistant',
      content: answer,
      id: `${turn.id}:assistant`,
      createdAt: turn.created_at ? new Date(turn.created_at) : undefined,
    });
  }
  return messages;
}

export interface VisLexRuntimeOptions {
  /** Newest-last turn list for the open conversation. */
  turns: Task[];
  /** True while the conversation's task is running. */
  isRunning: boolean;
  /** Called when a message is appended through the assistant-ui runtime. */
  onNew: (text: string) => void;
  /** Called when assistant-ui requests cancellation. */
  onCancel: () => void;
}

export function textOf(message: AppendMessage): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

export function useVisLexRuntime({ turns, isRunning, onNew, onCancel }: VisLexRuntimeOptions): AssistantRuntime {
  const signature = turns.map(turn => `${turn.id}:${turn.status}:${turn.step}:${turn.answer.length}`).join('|');
  const messages = useMemo(() => turns.flatMap(taskToMessages), [signature]);
  return useExternalStoreRuntime({
    isRunning,
    messages,
    convertMessage: message => message,
    onNew: async message => {
      const text = textOf(message);
      if (text) onNew(text);
    },
    onCancel: async () => onCancel(),
  });
}
