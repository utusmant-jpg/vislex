// The research modes and the window-event contract between the Browser view's research bar
// and the case chat (AgentPanel). The backend keys on the exact prefixes below.
import { useSyncExternalStore } from 'react';

export const QUICK_RESEARCH_PREFIX = 'Quick research:';
export const DEEP_RESEARCH_PREFIX = 'Deep research:';

export const QUICK_RESEARCH_PROMPT = `${QUICK_RESEARCH_PREFIX} find and verify the controlling law on the key issues of the charges in this case, KeyCite every authority relied on, and capture the supporting passages.`;
export const DEEP_RESEARCH_PROMPT = `${DEEP_RESEARCH_PREFIX} exhaustively research every charge, element, defence and procedural issue in this case from every angle, binding authority first then persuasive, favourable and adverse, KeyCite everything, capture every passage relied on, and save a research memo to the case.`;

export function isResearchPrompt(text: string | null | undefined) {
  return !!text && (text.startsWith(QUICK_RESEARCH_PREFIX) || text.startsWith(DEEP_RESEARCH_PREFIX));
}

/**
 * `window` event handled by the open case chat: sends `detail.text` at once through the
 * composer's own send path (same gate, model and route). The chat writes `detail.result`
 * synchronously, so the sender learns whether the message went out or why not.
 */
export const SEND_PROMPT_EVENT = 'vislex:send-prompt';
export type SendPromptResult = { sent: true } | { sent: false; reason: string };
export type SendPromptDetail = { text: string; result?: SendPromptResult };

export function sendPrompt(text: string): SendPromptResult {
  const detail: SendPromptDetail = { text };
  window.dispatchEvent(new CustomEvent<SendPromptDetail>(SEND_PROMPT_EVENT, { detail }));
  return detail.result ?? { sent: false, reason: 'The chat is not open.' };
}

/**
 * What the open case chat reports about itself: whether a response is running in the
 * conversation it shows (and its prompt), or why a new message cannot be sent now.
 */
export type ChatState = { caseId: string; running: boolean; runningPrompt: string | null; blocked: string | null };

let chatState: ChatState | null = null;
const listeners = new Set<() => void>();

export function publishChatState(next: ChatState | null) {
  const current = chatState;
  if (current === next || (current && next && current.caseId === next.caseId && current.running === next.running && current.runningPrompt === next.runningPrompt && current.blocked === next.blocked)) return;
  chatState = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function currentChatState() { return chatState; }

/** The chat's latest state, or null when no chat is mounted (the bar then lets the chat decide). */
export function useChatState() {
  return useSyncExternalStore(subscribe, () => chatState, () => null);
}
