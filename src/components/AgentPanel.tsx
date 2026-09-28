import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, CircleDashed, CircleStop, CloudOff, CornerDownRight, FileText, Info, ListPlus, LoaderCircle,
  MessageSquareQuote, PencilLine, Play, Quote, RotateCcw, Settings2, ShieldCheck, ShieldOff, Square, X, XCircle,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { springs } from '../lib/motion';
import { useVisLexRuntime } from '../chat/vislex-runtime';
import { composerBlock, costLabel, failureReason, needsAttention, settingsPath, settledAnnouncement, turnOutcome, usageOf, type SettingsScope, type SettingsSection } from '../chat/turn-state';
import { api, citationParts, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, profileKey } from '../aiProfiles';
import type { AIProfile, Settings, Snapshot, Selection, Task } from '../types';
import { Markdown } from '../markdown';
import { CopyButton, ModelPicker, StatusPill, Tooltip, formatClock, useNow } from '../ui';
import { buildViewerAttachment, getViewerContext } from '../viewerContext';
import ActivityTrace from '../chat/ActivityTrace';
import SourcesList from '../chat/SourcesList';
import { CitationContext, citationOrder, locatorWords, numbering, type CitationScope, type SourceInfo } from '../chat/citation-context';
import { useSourceDirectory } from '../chat/source-directory';
import { useLiveProgress, type LiveProgress } from '../chat/live-progress';
import { liveLabel } from '../chat/activity-summary';

// Keep unsaved chat drafts in memory only; never put case content in browser storage.
const chatDrafts = new Map<string, string>();
const modelKey = (caseId: string | undefined, conversationId: string | null) => `vislex-model:${caseId}:${conversationId ?? 'new'}`;

type SourceOpener = (id: string, locator?: string) => void;
type SourceLookup = (sourceId: string) => SourceInfo | undefined;

function shortTime(iso: string) {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

function compactTokens(total: number) {
  return total >= 10_000 ? `${(total / 1000).toFixed(total >= 100_000 ? 0 : 1)}k` : total.toLocaleString();
}

/** The answer with each citation replaced by its number, followed by the numbered sources. */
export function answerWithSources(answer: string, citations: string[], lookup: SourceLookup): string {
  const numberOf = numbering(citations);
  const body = answer.replace(/evidence:[a-zA-Z0-9-]+#(?:R[1-9]\d*L[1-9]\d*-L[1-9]\d*|L\d+-L\d+|image|media|artifact:[a-zA-Z0-9-]+)/g, value => `[${numberOf(value) ?? '?'}]`);
  if (!citations.length) return body;
  const sources = citations.map((value, index) => {
    const parts = citationParts(value);
    const name = parts ? lookup(parts.sourceId)?.name ?? parts.sourceId : value;
    return `[${index + 1}] ${name}${parts ? `, ${locatorWords(parts.locator)}` : ''} (${value})`;
  });
  return `${body}\n\nSources\n${sources.join('\n')}`;
}

/** The live stream for a running turn: what the provider is doing and the
 *  draft text so far, clearly marked as not yet citation-validated. */
function LiveResponse({ live, onSource, scroll, following }: { live: LiveProgress; onSource: SourceOpener; scroll: { current: HTMLDivElement | null }; following: { current: boolean } }) {
  useLayoutEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [live.text, following, scroll]);
  return <>
    {live.characters ? <div className="activity-live"><span>{liveLabel(live.activity)} · {live.characters.toLocaleString()} characters received</span></div> : null}
    {/* States only what was received: the backend may be running a tool, not
        waiting on the model, and a remount starts with nothing received. */}
    {native && !live.text && !live.characters ? <div className="live-waiting"><span className="trace-live-dot" aria-hidden="true" /><span>{live.transmission && live.activity ? `${liveLabel(live.activity)} · no response text yet` : 'No response output received yet'}</span></div> : null}
    {live.text ? <div className="live-answer">
      <p className="live-answer-caption"><CircleDashed size={14} aria-hidden="true" />Live draft — not yet citation-validated</p>
      <Markdown text={live.text} onSource={onSource} caret streaming />
    </div> : null}
  </>;
}

/** Real units only: elapsed time, the reported step and reported tokens.
 *  role="timer" keeps the per-second clock out of the live announcements. */
function RunStatus({ turn }: { turn: Task }) {
  const now = useNow(true);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(turn.created_at)) / 1000));
  const tokens = turn.input_tokens + turn.output_tokens;
  return <p className="turn-clock" role="timer" aria-label="Run status">
    <span>{formatClock(elapsed)} elapsed</span><span>step {turn.step}</span><span>{tokens ? `${tokens.toLocaleString()} tokens reported` : 'Token usage pending'}</span>
    {elapsed > 60 ? <span className="turn-clock-hint">Still working. Press Esc or Stop to end this run.</span> : null}
  </p>;
}

/** Case grant, shown apart from the model: a listed or selected model does not
 *  make case material sendable. */
function GrantChip({ settings, onOpen }: { settings: Settings; onOpen: () => void }) {
  const state = settings.offline ? 'offline' : settings.allow_text ? 'permitted' : 'blocked';
  const label = state === 'offline' ? 'Offline mode' : state === 'permitted' ? 'Case text permitted' : 'Case text not permitted';
  const detail = state === 'offline'
    ? `Offline mode is on; no AI requests are sent. Change it in ${settingsPath('Privacy & offline', 'case')}.`
    : `This case ${state === 'permitted' ? 'permits' : 'does not permit'} sending case text to AI; images ${settings.allow_images ? 'permitted' : 'not permitted'}. Choosing a model does not change this. Change it in ${settingsPath('Case permissions', 'case')}.`;
  return <Tooltip text={detail}>
    <button type="button" className="chat-grant" data-state={state} onClick={onOpen}>
      {state === 'offline' ? <CloudOff size={14} aria-hidden="true" /> : state === 'permitted' ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldOff size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  </Tooltip>;
}

/** The turn's receipt ID. Compact form keeps the full ID in its tooltip and copy button. */
function Receipt({ id, compact }: { id: string; compact?: boolean }) {
  return <span className="turn-receipt">{compact ? <span title={`Receipt: ${id}`}>Receipt …{id.slice(-6)}</span> : <code>Receipt: {id}</code>}<CopyButton text={id} label="Copy receipt ID" small /></span>;
}

/** Stopped, paused, interrupted and failed turns each say what happened. A user
 *  Stop is neutral; only a failure uses the danger tone. The backend's reason
 *  (its first line) is always visible; the full text and receipt sit behind a
 *  disclosure. */
function TurnNotice({ turn }: { turn: Task }) {
  const outcome = turnOutcome(turn);
  if (outcome.kind === 'stopped') return <p className="turn-note"><CircleStop size={14} aria-hidden="true" /><span>{turn.error}.</span><Receipt id={turn.id} compact /></p>;
  if (outcome.kind === 'paused' && outcome.pill === 'paused') return <p className="turn-note"><Info size={14} aria-hidden="true" /><span>{turn.error || 'Paused.'}</span></p>;
  if (outcome.kind === 'paused' || outcome.kind === 'interrupted' || outcome.kind === 'failed') {
    const failed = outcome.kind === 'failed';
    const title = failed ? 'This response did not complete.' : outcome.kind === 'interrupted' ? 'Interrupted before this response finished.' : 'Paused before this response finished.';
    return <div className={`notice turn-notice ${failed ? 'error' : 'warning'}`}>
      {failed ? <XCircle size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
      <div className="turn-notice-body">
        <strong>{title}</strong>
        {failureReason(turn.error) ? <p className="turn-notice-reason">{failureReason(turn.error)}</p> : null}
        <details className="turn-detail">
          <summary>Show details</summary>
          <pre>{turn.error || turn.status}</pre>
          <Receipt id={turn.id} />
        </details>
      </div>
    </div>;
  }
  return null;
}

/** Selecting text in an answer offers to quote it in the reply. */
function QuoteButton({ container, onQuote }: { container: { current: HTMLElement | null }; onQuote: (text: string) => void }) {
  const [anchor, setAnchor] = useState<{ text: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      const root = container.current;
      if (!selection || !text || !root || selection.rangeCount === 0) { setAnchor(null); return; }
      const range = selection.getRangeAt(0);
      const answer = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.assistant-turn .markdown-body');
      if (!answer || !root.contains(answer)) { setAnchor(null); return; }
      const rect = range.getBoundingClientRect();
      setAnchor({ text, top: Math.max(8, rect.top - 40), left: Math.min(window.innerWidth - 150, Math.max(8, rect.left + rect.width / 2 - 66)) });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [container]);
  if (!anchor) return null;
  return <button type="button" className="quote-selection" style={{ top: anchor.top, left: anchor.left }}
    onMouseDown={event => event.preventDefault()}
    onClick={() => { onQuote(anchor.text); window.getSelection()?.removeAllRanges(); setAnchor(null); }}>
    <Quote size={14} aria-hidden="true" />Quote in reply
  </button>;
}

function starterPrompts(snapshot: Snapshot | null): string[] {
  const count = snapshot?.counts?.source_count ?? snapshot?.sources.length ?? 0;
  if (!snapshot || !count) {
    return ['Build a timeline from the evidence', 'Find contradictions across sources', 'Review the videos and summarize key moments'];
  }
  const sourceWord = count === 1 ? 'source' : 'sources';
  if (count > snapshot.sources.length) {
    return [`Build a timeline from the ${count} ${sourceWord}`, 'Review the evidence and summarize key moments', 'Find contradictions across the sources'];
  }
  const recordings = snapshot.sources.filter(source => ['video', 'audio'].includes(source.kind)).length;
  const documents = snapshot.sources.filter(source => ['pdf', 'text', 'other'].includes(source.kind)).length;
  const starters = [`Build a timeline from the ${count} ${sourceWord}`];
  starters.push(recordings > 0 ? `Review the ${recordingText(recordings)} and summarize the key moments` : 'Find contradictions across the sources');
  starters.push(documents > 0 ? 'Summarize the documents and list the disputed statements' : 'What evidence is missing or unverified in this case?');
  return starters;
}

function recordingText(count: number) { return `${count} recording${count > 1 ? 's' : ''}`; }

export default function AgentPanel({ snapshot, selection, refresh, run, onSource, onSettings, conversationId, onConversation, onRename, focusRequest = 0 }: { snapshot: Snapshot | null; selection: Selection; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; onSource: SourceOpener; onSettings: (section?: SettingsSection, scope?: SettingsScope) => void; conversationId: string | null; onConversation: (id: string) => void; onRename?: () => void; focusRequest?: number }) {
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const availableModels = useMemo(() => snapshot ? configuredProfiles(snapshot).filter(profile => profile.allow_text) : [], [snapshot]);
  const selectedProfile: AIProfile | undefined = availableModels.find(profile => profileKey(profile) === selectedModel) ?? availableModels[0];
  const [accessChoice, setAccessChoice] = useState<{ route: 'api_keys' | 'chatgpt_subscription'; model?: string; effort?: string; routeBlocker?: string } | null>({route:'api_keys'});
  useEffect(() => {
    if (!native || !snapshot) { setAccessChoice(null); return; }
    let active = true;
    const session = caseSessionArgs(snapshot.id, snapshot.session_epoch);
    const load = () => Promise.all([
      api<{ route: 'api_keys' | 'chatgpt_subscription'; subscription?: { model: string; effort: string } | null; subscription_ready?: boolean; blocker?: string }>('ai_access_route'),
      api<{ effective: 'api_keys' | 'chatgpt_subscription'; selection?: { model: string; effort: string } | null }>('case_ai_access_route', session),
    ]).then(([app, currentCase]) => { if (active) setAccessChoice({ route: currentCase.effective ?? app.route, model: currentCase.selection?.model ?? app.subscription?.model, effort: currentCase.selection?.effort ?? app.subscription?.effort, routeBlocker: app.subscription_ready === false ? (app.blocker || 'The subscription route is not ready') : undefined }); })
      .catch(() => { if (active) setAccessChoice(null); });
    void load();
    window.addEventListener('vislex:ai-access-changed', load);
    return () => { active = false; window.removeEventListener('vislex:ai-access-changed', load); };
  }, [snapshot?.id, snapshot?.session_epoch]);
  const subscriptionActive = accessChoice?.route === 'chatgpt_subscription';
  const modelReady = !!accessChoice && (subscriptionActive ? !!accessChoice.model && !!accessChoice.effort : !!selectedProfile);
  const [sending, setSending] = useState(false);
  const sessionKey = snapshot ? `${snapshot.id}:${snapshot.session_epoch ?? 'preview'}` : null;
  const currentCaseId = useRef(sessionKey);
  currentCaseId.current = sessionKey;
  const draftKey = `${snapshot?.id}:${conversationId}`;
  const currentDraftKey = useRef(draftKey);
  currentDraftKey.current = draftKey;
  const [skipContext, setSkipContext] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    const limit = Math.max(160, Math.round(window.innerHeight * 0.4));
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
    input.style.overflowY = input.scrollHeight > limit ? 'auto' : 'hidden';
  }, [prompt]);
  const following = useRef(true);
  const lookup = useSourceDirectory(snapshot);
  // The turn sent from this panel keeps its question near the top while the
  // answer grows beneath it; its minimum height is the visible scroll area.
  const [anchoredTurn, setAnchoredTurn] = useState<string | null>(null);
  const [anchorHeight, setAnchorHeight] = useState(0);
  useEffect(() => {
    const element = scroll.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setAnchorHeight(Math.max(0, element.clientHeight - 48)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [showJump, setShowJump] = useState(false);
  // Turns this panel just sent; each animates in once, history never does.
  const freshTurns = useRef(new Set<string>());
  const [conversationDetail, setConversationDetail] = useState<{ sessionKey: string; conversationId: string; tasks: Task[]; nextCursor: { created_at: string; id: string } | null } | null>(null);
  const [loadingOlderTurns, setLoadingOlderTurns] = useState(false);
  const summarySignature = (snapshot?.tasks ?? []).filter(turn => (turn.conversation_id ?? turn.id) === conversationId).map(turn => `${turn.id}:${turn.status}:${turn.step}:${turn.answer.length}`).join('|');
  useEffect(() => {
    if (!snapshot || !conversationId) { setConversationDetail(null); return; }
    let active = true;
    api<{ tasks: Task[]; next_cursor: { created_at: string; id: string } | null }>('conversation_detail', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), conversation_id: conversationId })
      .then(detail => { if (active) setConversationDetail(detail && Array.isArray(detail.tasks) ? { sessionKey: sessionKey!, conversationId, tasks: detail.tasks, nextCursor: detail.next_cursor ?? null } : null); })
      .catch(() => { if (active) setConversationDetail(null); });
    return () => { active = false; };
  }, [sessionKey, conversationId, summarySignature]);
  const detailCurrent = !!conversationDetail && conversationDetail.sessionKey === sessionKey && conversationDetail.conversationId === conversationId;
  const turns = (detailCurrent ? conversationDetail!.tasks : (snapshot?.tasks ?? []).filter(turn => (turn.conversation_id ?? turn.id) === conversationId)).slice().reverse();
  const hasOlderTurns = detailCurrent && !!conversationDetail!.nextCursor;
  function loadOlderTurns() {
    if (!snapshot || !conversationId || !conversationDetail?.nextCursor || loadingOlderTurns) return;
    const caseId = snapshot.id;
    const caseSession = sessionKey;
    const conversation = conversationId;
    const cursor = conversationDetail.nextCursor;
    setLoadingOlderTurns(true);
    run(async () => {
      try {
        const page = await api<{ tasks: Task[]; next_cursor: { created_at: string; id: string } | null }>('conversation_detail', { ...caseSessionArgs(caseId, snapshot.session_epoch), conversation_id: conversation, before: cursor });
        setConversationDetail(current => current?.sessionKey === caseSession && current.conversationId === conversation && current.nextCursor?.id === cursor.id
          ? { ...current, tasks: [...current.tasks, ...page.tasks.filter(task => !current.tasks.some(existing => existing.id === task.id))], nextCursor: page.next_cursor ?? null } : current);
      } finally { setLoadingOlderTurns(false); }
    });
  }
  const task = turns.at(-1);
  const running = turns.find(candidate => candidate.status === 'running');
  const fileJobs = snapshot?.jobs?.filter(job => !job.superseded && ['auto_prepare', 'full_audio', 'video_ocr_index', 'video_overview_index'].includes(job.kind)) ?? [];
  const processingFailed = fileJobs.some(job => ['failed', 'interrupted'].includes(job.status));
  const processingPending = fileJobs.some(job => ['queued', 'running'].includes(job.status));
  const chatBlocked = !!running || (snapshot?.counts ? !!snapshot.counts.chat_pause : !processingFailed && processingPending);
  const block = composerBlock({ native, snapshot, accessKnown: !!accessChoice, subscriptionActive, routeBlocker: accessChoice?.routeBlocker, modelReady, preparing: chatBlocked && !running });

  // Announce once, politely, when a turn that was running settles. Each settle
  // gets a fresh sequence number so the live region's node is replaced even
  // when the text repeats (two completed turns both read "Response saved.").
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number; urgent: boolean }>({ text: '', seq: 0, urgent: false });
  const seenStatuses = useRef(new Map<string, string>());
  const turnSignature = turns.map(turn => `${turn.id}:${turn.status}:${turn.error.length}`).join('|');
  useEffect(() => {
    for (const turn of turns) {
      const message = settledAnnouncement(seenStatuses.current.get(turn.id), turn);
      // A turn that ends on a problem is announced assertively with its reason.
      if (message) setAnnouncement(current => ({ text: message, seq: current.seq + 1, urgent: needsAttention(turn) }));
      seenStatuses.current.set(turn.id, turn.status);
    }
  }, [turnSignature]);

  useEffect(() => { setSelectedModel(sessionStorage.getItem(modelKey(snapshot?.id, conversationId)) ?? ''); }, [snapshot?.id, conversationId]);
  useEffect(() => {
    following.current = true;
    setShowJump(false);
    setSkipContext(false);
    setAnchoredTurn(null);
    setPrompt(chatDrafts.get(`${snapshot?.id}:${conversationId}`) ?? '');
  }, [snapshot?.id, conversationId]);
  useEffect(() => {
    const focus = () => { composer.current?.focus(); };
    const draftEvent = (event: Event) => { const detail = (event as CustomEvent<{ text?: string }>).detail; if (detail?.text) draft(detail.text); composer.current?.focus(); };
    window.addEventListener('vislex:focus-composer', focus);
    window.addEventListener('vislex:draft-prompt', draftEvent);
    return () => { window.removeEventListener('vislex:focus-composer', focus); window.removeEventListener('vislex:draft-prompt', draftEvent); };
  }, []);
  useEffect(() => { if (focusRequest) composer.current?.focus(); }, [focusRequest]);
  // Ctrl+Shift+; focuses the composer; Ctrl+Shift+C copies the latest answer
  // (only when no text is selected, so ordinary copy keeps working).
  const latestAnswer = useRef('');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.code === 'Semicolon') { event.preventDefault(); composer.current?.focus(); }
      if (event.code === 'KeyC' && !window.getSelection()?.toString() && latestAnswer.current) {
        event.preventDefault();
        void navigator.clipboard?.writeText(latestAnswer.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (!turns.length) { element.scrollTop = 0; return; }
    if (following.current) element.scrollTop = element.scrollHeight;
  }, [turns.length, task?.answer, task?.status]);
  // Content that grows after render (a detail page, follow-ups, an opened
  // receipt) keeps the view pinned to the latest turn while following.
  const content = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  useEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const viewport = scroll.current;
      if (viewport && following.current && viewport.querySelector('.conversation-turn')) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setSkipContext(false); }, [selection?.id, selection?.locator]);

  /** Drafts are kept per conversation, in memory only. A draft written for a
   *  conversation the user has since left is stored without touching the
   *  composer they are now looking at. */
  function draft(value: string, key: string = currentDraftKey.current) {
    if (value) chatDrafts.set(key, value); else chatDrafts.delete(key);
    if (key === currentDraftKey.current) setPrompt(value);
  }

  function submit(text: string = prompt) {
    // The same gate as the Send button: any stated composer block stops a send.
    if (block) return;
    if (sending || chatBlocked || !text.trim() || !native || !snapshot || snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady) return;
    setSending(true);
    const sentFrom = currentDraftKey.current;
    run(async () => {
      try {
        const viewerContext = buildViewerAttachment(selection, getViewerContext(), skipContext);
        const result = await api<{ task_id: string; conversation_id: string }>('start_task', {
          ...caseSessionArgs(snapshot.id, snapshot.session_epoch),
          prompt: text,
          ...(subscriptionActive ? {} : { provider: selectedProfile!.provider, model: selectedProfile!.model }),
          parent_task_id: task?.id ?? null,
          viewer_context: viewerContext,
        });
        if (currentCaseId.current !== sessionKey) return;
        draft('', sentFrom);
        following.current = true;
        if (result?.task_id) { freshTurns.current.add(result.task_id); setAnchoredTurn(result.task_id); }
        onConversation(result.conversation_id ?? result.task_id);
        await refresh();
      } finally { setSending(false); }
    });
  }

  // Send is disabled while sending and then replaced by Stop, and Stop is
  // replaced by a (disabled, empty-draft) Send, so the pressed control leaves
  // the page. When it held focus, focus returns to the composer instead of
  // falling to the document.
  const actionHadFocus = useRef(false);
  const noteActionFocus = (event: React.MouseEvent<HTMLButtonElement>) => { actionHadFocus.current = document.activeElement === event.currentTarget; };
  useEffect(() => {
    if (!actionHadFocus.current) return;
    actionHadFocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !active.matches(':disabled')) return;
    composer.current?.focus();
  }, [running?.id, sending]);

  function stop() {
    if (!snapshot || !running) return;
    const target = running.id;
    run(async () => { await api('stop_task', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), task_id: target }); await refresh(); });
  }

  // assistant-ui runtime: sends flow through runtime.thread.append → onNew →
  // submit, so the composer and any future assistant-ui elements share one path.
  const runtime = useVisLexRuntime({
    turns,
    isRunning: !!running,
    onNew: text => submit(text),
    onCancel: stop,
  });

  const followUps = task?.status === 'complete' && !task.error ? (task.progress?.next_steps ?? []).filter(Boolean).slice(0, 3) : [];
  const starters = starterPrompts(snapshot);
  const reducedMotion = useReducedMotion();
  const contextName = selection
    ? selection.type === 'source'
      ? snapshot?.sources.find(source => source.id === selection.id)?.name
      : snapshot?.records.find(record => record.id === selection.id)?.title
    : null;
  const contextPage = selection && getViewerContext()?.sourceId === selection.id ? getViewerContext()?.page : null;
  const title = turns[0]?.title ?? turns[0]?.prompt.slice(0, 65) ?? 'New chat';
  const usage = usageOf(turns);
  latestAnswer.current = [...turns].reverse().find(turn => turn.answer)?.answer ?? '';
  const sendDisabled = !!block && block.reason !== 'preparing' || chatBlocked || sending || !prompt.trim() || !snapshot || !native || snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady;

  const sourceCount = snapshot?.counts?.source_count ?? snapshot?.sources.length ?? 0;
  const recordCount = snapshot?.counts?.record_count ?? snapshot?.records.length ?? 0;
  const restrictedCount = snapshot?.sources.filter(source => source.restricted).length ?? 0;
  const empty = !turns.length;

  return <AssistantRuntimeProvider runtime={runtime}>
    <section className={`agent-panel ${empty ? 'is-empty' : ''}`} aria-label="Chat" style={{ ['--anchor-h' as string]: `${anchorHeight}px` }}>
    <header className="panel-heading chat-bar">
      <div className="chat-bar-title">
        {turns.length && onRename
          ? <Tooltip text="Rename chat (F2)"><button type="button" className="chat-heading chat-heading-button" title={turns[0]?.title ?? turns[0]?.prompt} onClick={onRename}>{title}</button></Tooltip>
          : <h2 className="chat-heading" title={turns[0]?.title ?? turns[0]?.prompt}>{title}</h2>}
        {turns.length ? <Tooltip text={usage.total ? `Input ${usage.input.toLocaleString()} · Output ${usage.output.toLocaleString()} tokens, as reported by the provider. No spending limit is set.` : 'No token usage reported yet.'}>
          <span className="chat-bar-meta" tabIndex={0}>
            {turns.length} {turns.length === 1 ? 'turn' : 'turns'}{hasOlderTurns ? ' loaded' : ''} · {usage.total ? `${compactTokens(usage.total)} tokens reported` : 'No token usage reported'}{costLabel(usage.cost, usage.costPartial) ? ` · ${costLabel(usage.cost, usage.costPartial)}` : ''}
          </span>
        </Tooltip> : null}
      </div>
      <div className="spacer" />
      {snapshot && native ? <GrantChip settings={snapshot.settings} onOpen={() => onSettings(snapshot.settings.offline ? 'Privacy & offline' : 'Case permissions', 'case')} /> : null}
      <Tooltip text="Agent &amp; model settings"><button className="icon-button" aria-label="Agent settings" onClick={() => onSettings()}><Settings2 size={16} /></button></Tooltip>
    </header>
    <div className="agent-scroll" ref={scroll} onScroll={() => {
      const element = scroll.current;
      if (!element) return;
      // Stop following only when the reader moves up; content growing below
      // the view does not count as leaving the latest turn.
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 100) following.current = true;
      else if (element.scrollTop < lastScrollTop.current - 1) following.current = false;
      lastScrollTop.current = element.scrollTop;
      setShowJump(!following.current && turns.length > 0);
    }}>
      <div className="conversation-content" ref={content}>
        {hasOlderTurns ? <div className="older-turns"><button className="quiet" disabled={loadingOlderTurns} onClick={loadOlderTurns}>{loadingOlderTurns ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}{loadingOlderTurns ? 'Loading…' : 'Load earlier messages'}</button></div> : null}
        {turns.length ? turns.map(turn => <ConversationTurn
          key={turn.id}
          turn={turn}
          fresh={freshTurns}
          anchored={turn.id === anchoredTurn && turn.id === task?.id}
          reducedMotion={!!reducedMotion}
          latest={turn.id === task?.id}
          live={turn.status === 'running' && !!snapshot}
          snapshot={snapshot}
          chatBlocked={chatBlocked}
          followUps={turn.id === task?.id ? followUps : []}
          scroll={scroll}
          following={following}
          lookup={lookup}
          onSource={onSource}
          onDraft={text => { draft(text); composer.current?.focus(); }}
          onResume={() => run(async () => { if (!snapshot) return; await api('resume_task', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), task_id: turn.id }); await refresh(); })}
          onContinue={() => run(async () => {
            const caseId = snapshot?.id;
            if (!caseId) return;
            const result = await api<{task_id:string;conversation_id:string}>('continue_paused_task', { ...caseSessionArgs(caseId, snapshot?.session_epoch), task_id: turn.id });
            if (currentCaseId.current !== sessionKey) return;
            onConversation(result.conversation_id);
            await refresh();
          })}
        />) : <div className="agent-welcome">
          <h1>{snapshot ? <>What would you like to know about <span className="welcome-case">{snapshot.name}</span>?</> : 'Open a case to start'}</h1>
          {snapshot ? <p className="welcome-summary" role="group" aria-label="Case at a glance">
            <span><strong>{sourceCount.toLocaleString()}</strong> evidence {sourceCount === 1 ? 'source' : 'sources'}</span>
            <span aria-hidden="true">·</span>
            <span><strong>{recordCount.toLocaleString()}</strong> working {recordCount === 1 ? 'file' : 'files'}</span>
            {restrictedCount ? <><span aria-hidden="true">·</span><span><strong>{restrictedCount}</strong> restricted in this page</span></> : null}
          </p> : <p className="welcome-lede">Bring your evidence and conversations together. Every answer stays tied to its source.</p>}
        </div>}
      </div>
    </div>
    <div className="composer-area">
      <AnimatePresence>
        {showJump ? <motion.button
          className="jump-latest"
          aria-label="Jump to latest message"
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={springs.overlay}
          onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setShowJump(false); }}
        ><ArrowDown size={16} aria-hidden="true" /></motion.button> : null}
      </AnimatePresence>
      <div className={`composer ${block ? 'has-block' : ''}`}>
        {block ? <div className={`composer-block reason-${block.reason}`} role={block.reason === 'preparing' ? 'status' : undefined}>
          {block.reason === 'preparing' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : block.reason === 'offline' ? <CloudOff size={14} aria-hidden="true" /> : block.reason === 'text-grant' ? <ShieldOff size={14} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
          <span className="composer-block-text">{block.message}</span>
          {block.section ? <>
            <span className="composer-block-where">Change this in {settingsPath(block.section, block.scope)}</span>
            <button type="button" className="quiet composer-block-action" onClick={() => onSettings(block.section, block.scope)}>Open settings</button>
          </> : null}
        </div> : null}
        {contextName ? <div className={`viewer-context ${skipContext ? 'off' : ''}`} title="The agent receives this open file, its page and playback position">
          <FileText size={14} aria-hidden="true" />
          <span>{skipContext ? 'Not attaching' : 'Viewing'}</span><strong>{contextName}</strong>
          {contextPage && !skipContext ? <span>p.{contextPage}</span> : null}
          {skipContext
            ? <button type="button" className="quiet viewer-context-undo" onClick={() => setSkipContext(false)}>Attach</button>
            : <button type="button" className="icon-button icon-button-sm" aria-label="Do not attach this file to the next message" onClick={() => setSkipContext(true)}><X size={14} /></button>}
        </div> : null}
        {skipContext && contextName ? <p className="small muted context-off">This file will not be attached to your next message.</p> : null}
        <textarea ref={composer} aria-label="Agent task" rows={1} placeholder={task ? 'Ask a follow-up, or challenge a finding…' : 'Ask about this case…'} value={prompt}
          onChange={event => draft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); return; }
            // Esc stops a running response from the composer.
            if (event.key === 'Escape' && running) { event.preventDefault(); stop(); return; }
            // Up in an empty composer recalls the last message sent in this chat.
            if (event.key === 'ArrowUp' && !prompt && task?.prompt) { event.preventDefault(); draft(task.prompt); }
          }} />
        <div className="composer-bottom">
          {subscriptionActive ? <button className="model-picker" type="button" onClick={() => onSettings('Accounts & models')} aria-label="ChatGPT subscription model"><span className="provider-dot" data-provider="openai" aria-hidden="true" />ChatGPT · {accessChoice?.model ?? 'Choose model'}</button> : <ModelPicker
            snapshot={snapshot}
            selected={selectedProfile}
            onSelect={profile => { setSelectedModel(profileKey(profile)); sessionStorage.setItem(modelKey(snapshot?.id, conversationId), profileKey(profile)); }}
            onManage={() => onSettings('Accounts & models')}
            disabled={chatBlocked || sending || !availableModels.length}
          />}
          <div className="spacer" />
          {sending && !running ? <span className="composer-sending" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Sending</span> : null}
          {running
            ? <Tooltip text="Stop the current response" shortcut="Esc"><button
                type="button"
                className="send stop-button"
                aria-label="Stop response"
                onClick={event => { noteActionFocus(event); stop(); }}
              ><Square size={12} fill="currentColor" aria-hidden="true" /><span className="visually-hidden">Stop</span></button></Tooltip>
            : <Tooltip text={chatBlocked ? 'Waiting for case preparation' : 'Send message'} shortcut={chatBlocked ? undefined : 'Enter'}><button
                type="button"
                className={`send ${prompt.trim() ? 'ready' : ''}`}
                aria-label="Send message"
                disabled={sendDisabled}
                onClick={event => { noteActionFocus(event); void runtime.thread.append({ role: 'user', content: [{ type: 'text', text: prompt }] }); }}
              ><ArrowUp size={16} aria-hidden="true" /></button></Tooltip>}
        </div>
      </div>
      {empty && snapshot ? <div className="starter-prompts" role="group" aria-label="Suggested starting points">
        {starters.map(starter => <button key={starter} type="button" onClick={() => { draft(starter); composer.current?.focus(); }}>
          <MessageSquareQuote size={14} aria-hidden="true" className="starter-icon" />
          <span>{starter}</span>
        </button>)}
      </div> : null}
      <p className="composer-foot">{empty && snapshot ? 'Choosing a suggestion only fills the message box. Nothing is sent until you press Send.' : 'Answers cite the evidence they rely on · Enter to send · Shift+Enter for a new line'}</p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement.text && !announcement.urgent ? <span key={announcement.seq} data-seq={announcement.seq}>{announcement.text}</span> : null}</div>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">{announcement.text && announcement.urgent ? <span key={announcement.seq} data-seq={announcement.seq}>{announcement.text}</span> : null}</div>
    </div>
    <QuoteButton container={scroll} onQuote={text => { const quote = text.split('\n').map(line => `> ${line}`).join('\n'); draft(`${quote}\n\n${prompt}`); composer.current?.focus(); }} />
  </section>
  </AssistantRuntimeProvider>;
}

function ConversationTurn({ turn, fresh, anchored, reducedMotion, latest, live, snapshot, chatBlocked, followUps, scroll, following, lookup, onSource, onDraft, onResume, onContinue }: {
  turn: Task; fresh: { current: Set<string> }; anchored: boolean; reducedMotion: boolean; latest: boolean; live: boolean; snapshot: Snapshot | null; chatBlocked: boolean; followUps: string[];
  scroll: { current: HTMLDivElement | null }; following: { current: boolean }; lookup: SourceLookup; onSource: SourceOpener; onDraft: (text: string) => void; onResume: () => void; onContinue: () => void;
}) {
  // Decided once at mount: only a turn this panel just sent fades in.
  const [enter] = useState(() => fresh.current.has(turn.id));
  useEffect(() => { fresh.current.delete(turn.id); }, [fresh, turn.id]);
  const outcome = turnOutcome(turn);
  const tokens = turn.input_tokens + turn.output_tokens;
  const liveState = useLiveProgress(snapshot?.id, snapshot?.session_epoch, turn.id, live);
  const nameOf = useCallback((id: string) => lookup(id)?.name, [lookup]);
  const citations = useMemo(() => citationOrder(turn.answer), [turn.answer]);
  const answerScope = useMemo<CitationScope>(() => ({ numberOf: numbering(citations), source: lookup }), [citations, lookup]);
  const liveCitations = useMemo(() => citationOrder(liveState.text), [liveState.text]);
  const liveScope = useMemo<CitationScope>(() => ({ numberOf: numbering(liveCitations), source: lookup }), [liveCitations, lookup]);
  const time = turn.created_at && Number.isFinite(Date.parse(turn.created_at)) ? <time dateTime={turn.created_at} title={new Date(turn.created_at).toLocaleString()}>{shortTime(turn.created_at)}</time> : null;
  return <motion.article
    className={`conversation-turn ${anchored ? 'is-anchored' : ''} ${latest ? 'is-latest' : ''}`}
    data-outcome={outcome.kind}
    initial={enter && !reducedMotion ? { opacity: 0, y: 8 } : false}
    animate={{ opacity: 1, y: 0 }}
    transition={springs.gentle}
  >
    <div className="user-turn">
      <div className="user-message">{turn.prompt}</div>
      <div className="user-actions">
        <CopyButton text={turn.prompt} label="Copy message" small />
        <Tooltip text="Edit message"><button type="button" className="icon-button icon-button-sm" aria-label="Edit message" onClick={() => onDraft(turn.prompt)}><PencilLine size={14} aria-hidden="true" /></button></Tooltip>
      </div>
    </div>
    <div className="assistant-turn">
      {outcome.kind !== 'complete' ? <div className="assistant-status"><StatusPill state={outcome.pill} label={outcome.label} small />{time}</div> : null}
      <ActivityTrace turn={turn} liveActivity={live ? liveState.activity : undefined} nameOf={nameOf} onSource={onSource} eager={latest} />
      {live && snapshot ? <CitationContext.Provider value={liveScope}><LiveResponse live={liveState} onSource={onSource} scroll={scroll} following={following} /></CitationContext.Provider> : null}
      {turn.status === 'running' ? <RunStatus turn={turn} /> : null}
      {turn.answer ? <CitationContext.Provider value={answerScope}>
        <Markdown className="answer" text={turn.answer} onSource={onSource} />
        <SourcesList citations={citations} scope={answerScope} onSource={onSource} />
        <div className="message-meta">
          <CopyButton text={turn.answer} label="Copy answer" small />
          {citations.length ? <CopyButton text={answerWithSources(turn.answer, citations, lookup)} label="Copy with sources" small /> : null}
          {turn.status === 'complete' ? <Tooltip text="Ask this again"><button type="button" className="icon-button icon-button-sm" aria-label="Ask this again" onClick={() => onDraft(turn.prompt)}><RotateCcw size={14} aria-hidden="true" /></button></Tooltip> : null}
          <span className="meta-divider" aria-hidden="true" />
          {outcome.kind === 'complete' ? <span className="meta-item meta-status" title="Saved to this case with its validated citations">{outcome.label}</span> : null}
          {outcome.kind === 'complete' ? time : null}
          <span className="meta-item" title={tokens ? `Input ${turn.input_tokens.toLocaleString()} · Output ${turn.output_tokens.toLocaleString()} tokens, as reported by the provider` : undefined}>{tokens ? `${tokens.toLocaleString()} tokens` : 'Token usage not reported'}</span>
          {costLabel(turn.cost, turn.cost_partial) ? <span className="meta-item" title="Cost as reported by the provider; no spending limit is set">{costLabel(turn.cost, turn.cost_partial)}</span> : null}
        </div>
      </CitationContext.Provider> : null}
      <TurnNotice turn={turn} />
      {(turn.status === 'paused' && !chatBlocked) || outcome.kind === 'failed' ? <div className="turn-actions">
        {turn.status === 'paused' && !chatBlocked ? <button type="button" className="secondary resume-button" data-size="sm" onClick={onResume}><Play size={14} aria-hidden="true" />Resume work</button> : null}
        {latest && turn.status === 'paused' && !!turn.error && !chatBlocked ? <button type="button" className="quiet" onClick={onContinue}><CornerDownRight size={14} aria-hidden="true" />Continue in new task</button> : null}
        {outcome.kind === 'failed' ? <button type="button" className="quiet" onClick={() => onDraft(turn.prompt)}><RotateCcw size={14} aria-hidden="true" />Edit and ask again</button> : null}
      </div> : null}
      {latest && turn.status === 'complete' && followUps.length ? <div className="follow-ups">
        <span className="follow-up-label">Suggested next checks</span>
        {followUps.map(step => <button key={step} type="button" className="follow-up" onClick={() => onDraft(`Perform this next check: ${step}`)}><ListPlus size={14} aria-hidden="true" /><span>{step}</span></button>)}
      </div> : null}
    </div>
  </motion.article>;
}
