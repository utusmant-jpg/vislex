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
 * lands via the case-event snapshot refresh. This adapter only mirrors that
 * state into assistant-ui's ExternalStoreRuntime. It deliberately passes no
 * onEdit / onReload / setMessages handlers, so assistant-ui can never rewrite
 * or regenerate a turn locally; a runtime `append` is routed to `onNew`,
 * which the panel wires to the same single send path the composer uses.
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

/** 32-bit FNV-1a over UTF-16 code units: a cheap content fingerprint so an
 *  answer rewritten to the same length still invalidates memoised state. */
export function contentFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Everything about a turn that changes what is rendered or mirrored. */
export function turnSignature(turn: Task): string {
  return `${turn.id}:${turn.status}:${turn.step}:${turn.answer.length}:${contentFingerprint(turn.answer)}:${contentFingerprint(turn.error ?? '')}`;
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
  const signature = turns.map(turnSignature).join('|');
  // The signature captures every mirrored field of `turns` (status, step, error and answer content).
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
