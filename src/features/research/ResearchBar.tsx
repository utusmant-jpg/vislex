import { useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { BookOpenCheck, Layers, SendHorizontal } from 'lucide-react';
import { notify } from '../../ui';
import { DEEP_RESEARCH_PROMPT, QUICK_RESEARCH_PROMPT, isResearchPrompt, sendPrompt, useChatState } from './prompts';

/**
 * The research modes above the browser toolbar: Quick research, Deep research, and a
 * typed instruction, each sent as a message in the case chat beside the browser. Unavailable
 * controls stay focusable (aria-disabled) and name the reason; the chat's own gate still applies.
 */
export default function ResearchBar({ caseId, unavailable }: {
  caseId: string;
  /** Why research cannot start from here (the research browser is off, offline or closed). */
  unavailable: string | null;
}) {
  const chat = useChatState();
  const ours = chat && chat.caseId === caseId ? chat : null;
  const [instruction, setInstruction] = useState('');
  // Instructions sent from this bar, so a running typed instruction also reads as research.
  const sentHere = useRef(new Set<string>());
  const reasonId = useId();
  const researching = !!ours?.running && (isResearchPrompt(ours.runningPrompt) || sentHere.current.has(ours.runningPrompt ?? ''));
  const reason = unavailable
    ?? (ours?.running ? (researching ? null : 'A task is already running in the chat.') : ours?.blocked ?? null);
  const blocked = !!unavailable || !!ours?.running || !!ours?.blocked;

  function send(text: string) {
    if (blocked || !text.trim()) return false;
    const result = sendPrompt(text);
    if (!result.sent) { notify.info('Not sent', result.reason); return false; }
    sentHere.current.add(text);
    return true;
  }
  const press = (text: string) => (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); send(text); };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (send(instruction)) setInstruction('');
  }
  const describedBy = blocked ? reasonId : undefined;
  const sendUnavailable = blocked || !instruction.trim();

  return <div className="research-bar" role="group" aria-label="Research with the AI">
    <button type="button" className="secondary" data-size="sm" aria-disabled={blocked || undefined} aria-describedby={describedBy} onClick={press(QUICK_RESEARCH_PROMPT)}>
      <BookOpenCheck size={14} aria-hidden="true" />Quick research
    </button>
    <button type="button" className="secondary" data-size="sm" aria-disabled={blocked || undefined} aria-describedby={describedBy} onClick={press(DEEP_RESEARCH_PROMPT)}>
      <Layers size={14} aria-hidden="true" />Deep research
    </button>
    <form className="research-instruct" onSubmit={submit}>
      <input type="text" className="research-instruct-input" aria-label="Instruction for the AI" placeholder="Tell the AI what to do on Westlaw…"
        autoComplete="off" enterKeyHint="send" value={instruction} aria-describedby={describedBy}
        onChange={event => setInstruction(event.target.value)} />
      <button type="submit" className="quiet" data-size="sm" aria-label="Send instruction" aria-disabled={sendUnavailable || undefined} aria-describedby={describedBy}>
        <SendHorizontal size={14} aria-hidden="true" />Send
      </button>
    </form>
    <span id={reasonId} className={`research-bar-status ${researching ? 'is-researching' : ''}`} role="status">
      {researching ? <><span className="research-bar-dot" aria-hidden="true" />Researching…</> : reason}
    </span>
  </div>;
}
