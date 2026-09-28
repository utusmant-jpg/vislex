import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, BookOpen, CheckCircle2, ChevronDown, CircleDashed, CircleDot, CircleStop, CloudOff,
  FilePenLine, FileText, Film, Flag, Info, Layers, ListChecks, LoaderCircle, MessageSquareQuote, MessagesSquare, Play,
  RotateCcw, Scale, ScanLine, Search, Settings2, ShieldCheck, ShieldOff, Square, Wrench, X, XCircle,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { springs } from '../lib/motion';
import { useVisLexRuntime } from '../chat/vislex-runtime';
import { composerBlock, costLabel, settingsPath, settledAnnouncement, turnOutcome, usageOf, type SettingsSection } from '../chat/turn-state';
import { listen } from '@tauri-apps/api/event';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, profileKey } from '../aiProfiles';
import type { Action, AIProfile, Settings, Snapshot, Selection, Task } from '../types';
import { Markdown } from '../markdown';
import { CopyButton, ModelPicker, StatusPill, Tooltip, formatClock, useNow } from '../ui';
import { buildViewerAttachment, getViewerContext } from '../viewerContext';

// Keep unsaved chat drafts in memory only; never put case content in browser storage.
const chatDrafts = new Map<string, string>();
const modelKey = (caseId: string | undefined, conversationId: string | null) => `vislex-model:${caseId}:${conversationId ?? 'new'}`;

type TeamMember = { id: string; role: string; phase: string; provider: string; model: string; status: string; step: number; answer: string; error: string };
type SourceOpener = (id: string, locator?: string) => void;

function actionIcon(name: string) {
  if (/finish_task/.test(name)) return <Flag size={14} />;
  if (/^read|text|page|transcript/.test(name)) return <BookOpen size={14} />;
  if (/search/.test(name)) return <Search size={14} />;
  if (/video|frame|media|sound|audio|diariz/.test(name)) return <Film size={14} />;
  if (/record|write|note|draft|work_product/.test(name)) return <FilePenLine size={14} />;
  if (/hypothes|clock|fit/.test(name)) return <Scale size={14} />;
  if (/delegate|team|open_source/.test(name)) return <Layers size={14} />;
  if (/scan|ocr|prepare|render/.test(name)) return <ScanLine size={14} />;
  return <Wrench size={14} />;
}

function friendlyAction(name: string) {
  return name.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
}

/** Status of one recorded action: icon plus a word, never colour alone. */
function ActionState({ status }: { status: string }) {
  if (status === 'complete') return <span className="timeline-state"><CheckCircle2 size={13} aria-hidden="true" />Done</span>;
  if (status === 'failed') return <span className="timeline-state"><XCircle size={13} aria-hidden="true" />Failed</span>;
  if (status === 'running') return <span className="timeline-state"><LoaderCircle size={13} className="spin" aria-hidden="true" />Running</span>;
  return <span className="timeline-state"><CircleDashed size={13} aria-hidden="true" />{status.replaceAll('_', ' ') || 'Recorded'}</span>;
}

function shortTime(iso: string) {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

/** Per-turn activity: every message keeps its receipt ledger, not just the latest. */
function TurnActivity({ turn, onSource }: { turn: Task; onSource: SourceOpener }) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<Action[] | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamError, setTeamError] = useState('');
  const reducedMotion = useReducedMotion();
  const bodyId = useId();
  const running = turn.status === 'running';
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => {
      api<Action[]>('actions', { task_id: turn.id })
        .then(value => { if (active) setActions(Array.isArray(value) ? value : []); })
        .catch(reason => { if (active) setActions([{ id: 'activity-error', name: 'Activity unavailable', input: '', output: String(reason), status: 'failed', created_at: new Date().toISOString() }]); });
      if (native) api<TeamMember[]>('team_status', { task_id: turn.id })
        .then(value => { if (active) setTeam(Array.isArray(value) ? value : []); })
        .catch(reason => { if (active) setTeamError(String(reason)); });
    };
    load();
    const timer = running ? setInterval(load, 2500) : undefined;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [open, turn.id, turn.step, turn.status, running]);
  const failures = actions?.filter(action => action.status === 'failed').length ?? 0;
  const latest = actions?.at(-1)?.name;
  const summary = running
    ? (latest ? friendlyAction(latest) : 'Considering the evidence…')
    : actions ? `${actions.length} ${actions.length === 1 ? 'action' : 'actions'}` : 'Activity';
  return <div className="turn-activity">
    <button className={`activity-toggle ${open ? 'open' : ''} ${running ? 'working' : ''}`} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      {running ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
      <span>{summary}</span>
      {!running && failures ? <span className="activity-failures"><XCircle size={12} aria-hidden="true" />{failures} failed</span> : null}
      <ChevronDown size={13} className="activity-chevron" aria-hidden="true" />
    </button>
    <AnimatePresence initial={false}>
      {open ? <motion.div
        key="activity-body"
        id={bodyId}
        className="activity-body"
        initial={reducedMotion ? false : { height: 0, opacity: 0 }}
        animate={reducedMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
        exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
        transition={springs.gentle}
        style={reducedMotion ? undefined : { overflow: 'hidden' }}
      >
      {teamError ? <p className="small danger-text" role="alert">Team status unavailable: {teamError}</p> : null}
      {team.length ? <div className="team-cards">
        <p className="small muted">Agent team · {team.filter(member => member.status === 'complete').length}/{team.length} assignments complete. Separate working contexts — not independent corroboration or human approval.</p>
        {team.map(member => <details className="team-card" key={member.id}>
          <summary>
            <StatusPill state={member.status === 'complete' ? 'complete' : member.status === 'failed' ? 'failed' : 'running'} label={member.status.replaceAll('_', ' ')} small />
            <strong>{member.role}</strong>
            <span className="team-model">{member.model}</span>
          </summary>
          <p className="small muted">{member.provider.replaceAll('"', '')} · {member.phase.replaceAll('_', ' ')} · step {member.step}</p>
          {member.error ? <p className="small danger-text" role="alert">{member.error}</p> : null}
          {member.answer ? <Markdown text={member.answer} onSource={onSource} /> : <p className="small muted">No completed proposal yet.</p>}
        </details>)}
      </div> : null}
      <ol className="activity-timeline" aria-label="Recorded actions">
        {(actions ?? []).map(action => <li className={`timeline-row status-${action.status}`} key={action.id}>
          <details>
            <summary>
              <span className="timeline-icon" aria-hidden="true">{actionIcon(action.name)}</span>
              <span className="timeline-name">{friendlyAction(action.name)}</span>
              <ActionState status={action.status} />
              {shortTime(action.created_at) ? <time dateTime={action.created_at}>{shortTime(action.created_at)}</time> : null}
              <ChevronDown size={12} className="timeline-chevron" aria-hidden="true" />
            </summary>
            <div className="timeline-receipt">
              <pre>{action.output}</pre>
              <div className="timeline-receipt-meta"><code>Receipt {action.id}</code><CopyButton text={action.output} label="Copy receipt" small /></div>
            </div>
          </details>
        </li>)}
        {!actions ? <li className="timeline-row timeline-placeholder"><span className="timeline-icon"><LoaderCircle size={14} className="spin" aria-hidden="true" /></span><span className="timeline-name">Loading activity…</span></li> : null}
        {actions && !actions.length ? <li className="timeline-row timeline-placeholder"><span className="timeline-icon"><CircleDot size={14} aria-hidden="true" /></span><span className="timeline-name">No recorded actions.</span></li> : null}
      </ol>
      </motion.div> : null}
    </AnimatePresence>
  </div>;
}

/** Keep high-frequency Tauri deltas out of the workspace and preserve the entire draft. */
function LiveResponse({ caseId, sessionEpoch, taskId, onSource, scroll, following }: { caseId: string; sessionEpoch?: number; taskId: string; onSource: SourceOpener; scroll: { current: HTMLDivElement | null }; following: { current: boolean } }) {
  const [live, setLive] = useState({ transmission: '', text: '', activity: 'Receiving response', characters: 0 });
  const liveRef = useRef(live);
  useEffect(() => {
    if (!native) return;
    let active = true;
    let frame = 0;
    let pending: typeof live | null = null;
    const cleanup = listen<{ case_id: string; session_epoch?: number; task_id: string; transmission_id: string; delta: { text?: string; activity?: string; characters?: number } }>('agent-progress', ({ payload: event }) => {
      if (!active || event.case_id !== caseId || event.task_id !== taskId || (typeof sessionEpoch === 'number' && event.session_epoch !== sessionEpoch)) return;
      const base = pending ?? liveRef.current;
      const current = base.transmission === event.transmission_id ? base : { transmission: event.transmission_id, text: '', activity: 'Receiving response', characters: 0 };
      pending = { ...current, text: current.text + (event.delta.text ?? ''), activity: event.delta.activity?.replaceAll('_', ' ') ?? current.activity, characters: current.characters + (event.delta.characters ?? 0) };
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) { liveRef.current = pending; setLive(pending); pending = null; }
      });
    });
    return () => { active = false; if (frame) cancelAnimationFrame(frame); void cleanup.then(unlisten => unlisten()); };
  }, [caseId, sessionEpoch, taskId]);
  useLayoutEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [live.text, following, scroll]);
  return <>
    {live.characters ? <div className="activity-live"><LoaderCircle size={13} className="spin" aria-hidden="true" /><span>{live.activity} · {live.characters.toLocaleString()} characters received</span></div> : null}
    {native && !live.text && !live.characters ? <div className="live-waiting"><LoaderCircle size={13} className="spin" aria-hidden="true" /><span>Waiting for model output</span></div> : null}
    {live.text ? <div className="live-answer">
      <p className="live-answer-caption"><CircleDashed size={12} aria-hidden="true" />Live draft — not yet citation-validated</p>
      <Markdown text={live.text} onSource={onSource} caret />
    </div> : null}
  </>;
}

/** Real units only: elapsed time, the reported step and reported tokens.
 *  role="timer" keeps the per-second clock out of the live announcements. */
function RunStatus({ turn }: { turn: Task }) {
  const now = useNow(true);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(turn.created_at)) / 1000));
  const tokens = turn.input_tokens + turn.output_tokens;
  return <p className="run-status" role="timer" aria-label="Run status">
    {formatClock(elapsed)} elapsed · step {turn.step} · {tokens ? `${tokens.toLocaleString()} tokens reported` : 'Token usage pending'}
    {elapsed > 60 ? ' · Still working. You can stop this run below.' : ''}
  </p>;
}

/** Case grant, shown apart from the model: a listed or selected model does not
 *  make case material sendable. */
function GrantChip({ settings, onOpen }: { settings: Settings; onOpen: () => void }) {
  const state = settings.offline ? 'offline' : settings.allow_text ? 'permitted' : 'blocked';
  const label = state === 'offline' ? 'Offline mode' : state === 'permitted' ? 'Case text permitted' : 'Case text not permitted';
  const detail = state === 'offline'
    ? `Offline mode is on; no AI requests are sent. Change it in ${settingsPath('Privacy & offline')}.`
    : `This case ${state === 'permitted' ? 'permits' : 'does not permit'} sending case text to AI; images ${settings.allow_images ? 'permitted' : 'not permitted'}. Choosing a model does not change this. Change it in ${settingsPath('Case permissions')}.`;
  return <Tooltip text={detail}>
    <button type="button" className="chat-grant" data-state={state} onClick={onOpen}>
      {state === 'offline' ? <CloudOff size={14} aria-hidden="true" /> : state === 'permitted' ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldOff size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  </Tooltip>;
}

function Receipt({ id }: { id: string }) {
  return <span className="turn-receipt"><code>Receipt: {id}</code><CopyButton text={id} label="Copy receipt ID" small /></span>;
}

/** Stopped, paused, interrupted and failed turns each say what happened. A user
 *  Stop is neutral; only a failure uses the danger tone. Raw detail sits behind
 *  a disclosure. */
function TurnNotice({ turn }: { turn: Task }) {
  const outcome = turnOutcome(turn);
  if (outcome.kind === 'stopped') return <p className="turn-note"><CircleStop size={14} aria-hidden="true" /><span>{turn.error}.</span><Receipt id={turn.id} /></p>;
  if (outcome.kind === 'paused' && outcome.pill === 'paused') return <p className="turn-note"><Info size={14} aria-hidden="true" /><span>{turn.error || 'Paused.'}</span></p>;
  if (outcome.kind === 'paused' || outcome.kind === 'interrupted' || outcome.kind === 'failed') {
    const failed = outcome.kind === 'failed';
    const title = failed ? 'This response did not complete.' : outcome.kind === 'interrupted' ? 'Interrupted before this response finished.' : 'Paused before this response finished.';
    return <div className={`notice turn-notice ${failed ? 'error' : 'warning'}`}>
      {failed ? <XCircle size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
      <div className="turn-notice-body">
        <strong>{title}</strong>
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

export default function AgentPanel({ snapshot, selection, refresh, run, onSource, onSettings, conversationId, onConversation, focusRequest = 0 }: { snapshot: Snapshot | null; selection: Selection; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; onSource: SourceOpener; onSettings: (section?: SettingsSection) => void; conversationId: string | null; onConversation: (id: string) => void; focusRequest?: number }) {
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const availableModels = useMemo(() => snapshot ? configuredProfiles(snapshot).filter(profile => profile.allow_text) : [], [snapshot]);
  const selectedProfile: AIProfile | undefined = availableModels.find(profile => profileKey(profile) === selectedModel) ?? availableModels[0];
  const [accessChoice, setAccessChoice] = useState<{ route: 'api_keys' | 'chatgpt_subscription'; model?: string; effort?: string } | null>({route:'api_keys'});
  useEffect(() => {
    if (!native || !snapshot) { setAccessChoice(null); return; }
    let active = true;
    const session = caseSessionArgs(snapshot.id, snapshot.session_epoch);
    const load = () => Promise.all([
      api<{ route: 'api_keys' | 'chatgpt_subscription'; subscription?: { model: string; effort: string } | null }>('ai_access_route'),
      api<{ effective: 'api_keys' | 'chatgpt_subscription'; selection?: { model: string; effort: string } | null }>('case_ai_access_route', session),
    ]).then(([app, currentCase]) => { if (active) setAccessChoice({ route: currentCase.effective ?? app.route, model: currentCase.selection?.model ?? app.subscription?.model, effort: currentCase.selection?.effort ?? app.subscription?.effort }); })
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
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
  }, [prompt]);
  const following = useRef(true);
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
  const block = composerBlock({ native, snapshot, accessKnown: !!accessChoice, subscriptionActive, modelReady, preparing: chatBlocked && !running });

  // Announce once, politely, when a turn that was running settles. Each settle
  // gets a fresh sequence number so the live region's node is replaced even
  // when the text repeats (two completed turns both read "Response saved.").
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  const seenStatuses = useRef(new Map<string, string>());
  const turnSignature = turns.map(turn => `${turn.id}:${turn.status}:${turn.error.length}`).join('|');
  useEffect(() => {
    for (const turn of turns) {
      const message = settledAnnouncement(seenStatuses.current.get(turn.id), turn);
      if (message) setAnnouncement(current => ({ text: message, seq: current.seq + 1 }));
      seenStatuses.current.set(turn.id, turn.status);
    }
  }, [turnSignature]);

  useEffect(() => { setSelectedModel(sessionStorage.getItem(modelKey(snapshot?.id, conversationId)) ?? ''); }, [snapshot?.id, conversationId]);
  useEffect(() => {
    following.current = true;
    setShowJump(false);
    setSkipContext(false);
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
        if (result?.task_id) freshTurns.current.add(result.task_id);
        onConversation(result.conversation_id ?? result.task_id);
        await refresh();
      } finally { setSending(false); }
    });
  }

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
  const sendDisabled = chatBlocked || sending || !prompt.trim() || !snapshot || !native || snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady;

  return <AssistantRuntimeProvider runtime={runtime}>
    <section className="agent-panel" aria-label="Chat">
    <header className="panel-heading chat-bar">
      <div className="chat-bar-title">
        <h2 className="chat-heading" title={turns[0]?.title ?? turns[0]?.prompt}>{title}</h2>
        {turns.length ? <span className="chat-bar-meta" title={usage.total ? `Input ${usage.input.toLocaleString()} · Output ${usage.output.toLocaleString()} tokens, as reported by the provider` : undefined}>
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}{hasOlderTurns ? ' loaded' : ''} · {usage.total ? `${usage.total.toLocaleString()} tokens reported` : 'No token usage reported'}{costLabel(usage.cost, usage.costPartial) ? ` · ${costLabel(usage.cost, usage.costPartial)}` : ''}
        </span> : null}
      </div>
      <div className="spacer" />
      {snapshot && native ? <GrantChip settings={snapshot.settings} onOpen={() => onSettings(snapshot.settings.offline ? 'Privacy & offline' : 'Case permissions')} /> : null}
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
          reducedMotion={!!reducedMotion}
          latest={turn.id === task?.id}
          live={turn.status === 'running' && !!snapshot}
          snapshot={snapshot}
          chatBlocked={chatBlocked}
          followUps={turn.id === task?.id ? followUps : []}
          scroll={scroll}
          following={following}
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
          <span className="welcome-mark" aria-hidden="true"><MessagesSquare size={20} /></span>
          <p className="eyebrow">Case workspace</p>
          <h1>{snapshot ? snapshot.name : 'Start with a case'}</h1>
          <p className="welcome-lede">{snapshot ? 'Explore the evidence, compare accounts, and keep each conclusion tied to its source.' : 'Open a case to bring your evidence and conversations together.'}</p>
          {snapshot ? <div className="welcome-summary" role="group" aria-label="Case at a glance">
            <div><strong className={snapshot.counts?.source_count ?? snapshot.sources.length ? undefined : 'stat-zero'}>{snapshot.counts?.source_count ?? snapshot.sources.length}</strong><span>Evidence sources</span></div>
            <div><strong className={snapshot.counts?.record_count ?? snapshot.records.length ? undefined : 'stat-zero'}>{snapshot.counts?.record_count ?? snapshot.records.length}</strong><span>Working files</span></div>
            <div><strong className={snapshot.sources.filter(source => source.restricted).length ? undefined : 'stat-zero'}>{snapshot.sources.filter(source => source.restricted).length}</strong><span>Restricted in this page</span></div>
          </div> : null}
          <h2 className="welcome-prompt-label">Suggested starting points</h2>
          <div className="starter-prompts">{starters.map(starter => <button key={starter} type="button" onClick={() => { draft(starter); composer.current?.focus(); }}>
            <MessageSquareQuote size={15} aria-hidden="true" className="starter-icon" />
            <span>{starter}</span>
            <ArrowUp size={14} aria-hidden="true" className="starter-arrow" />
          </button>)}</div>
          <p className="welcome-note">Choosing a prompt only fills the message box. Nothing is sent until you press Send.</p>
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
        ><ArrowDown size={14} aria-hidden="true" />Latest</motion.button> : null}
      </AnimatePresence>
      {block ? <div className={`composer-block reason-${block.reason}`} role={block.reason === 'preparing' ? 'status' : undefined}>
        {block.reason === 'preparing' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : block.reason === 'offline' ? <CloudOff size={15} aria-hidden="true" /> : block.reason === 'text-grant' ? <ShieldOff size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
        <span className="composer-block-text">{block.message}</span>
        {block.section ? <>
          <span className="composer-block-where">Change this in {settingsPath(block.section)}</span>
          <button type="button" className="secondary" data-size="sm" onClick={() => onSettings(block.section)}>Open settings</button>
        </> : null}
      </div> : null}
      <div className="composer">
        {contextName ? <div className={`viewer-context ${skipContext ? 'off' : ''}`} title="The agent receives this open file, its page and playback position">
          <FileText size={13} aria-hidden="true" />
          <span>{skipContext ? 'Not attaching' : 'Viewing'}</span><strong>{contextName}</strong>
          {contextPage && !skipContext ? <span>p.{contextPage}</span> : null}
          {skipContext
            ? <button type="button" className="quiet viewer-context-undo" onClick={() => setSkipContext(false)}>Attach</button>
            : <button type="button" className="icon-button icon-button-sm" aria-label="Do not attach this file to the next message" onClick={() => setSkipContext(true)}><X size={13} /></button>}
        </div> : null}
        {skipContext && contextName ? <p className="small muted context-off">This file will not be attached to your next message.</p> : null}
        <textarea ref={composer} aria-label="Agent task" rows={1} placeholder={task ? 'Follow up, challenge a finding, or ask something else…' : 'Ask VisLex about your case…'} value={prompt} onChange={event => draft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        <div className="composer-bottom">
          {subscriptionActive ? <button className="model-picker" type="button" onClick={() => onSettings('Accounts & models')} aria-label="ChatGPT subscription model"><span className="provider-dot" data-provider="openai" aria-hidden="true" />ChatGPT · {accessChoice?.model ?? 'Choose model'}</button> : <ModelPicker
            snapshot={snapshot}
            selected={selectedProfile}
            onSelect={profile => { setSelectedModel(profileKey(profile)); sessionStorage.setItem(modelKey(snapshot?.id, conversationId), profileKey(profile)); }}
            onManage={() => onSettings('Accounts & models')}
            disabled={chatBlocked || sending || !availableModels.length}
          />}
          <div className="spacer" />
          {sending && !running ? <span className="composer-sending" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" />Sending</span> : null}
          {running
            ? <Tooltip text="Stop the current response"><button
                type="button"
                className="secondary stop-button"
                data-size="sm"
                aria-label="Stop response"
                onClick={stop}
              ><Square size={11} fill="currentColor" aria-hidden="true" />Stop</button></Tooltip>
            : <Tooltip text={chatBlocked ? 'Waiting for case preparation' : 'Send message (Enter)'}><button
                type="button"
                className="send"
                aria-label="Send message"
                disabled={sendDisabled}
                onClick={() => void runtime.thread.append({ role: 'user', content: [{ type: 'text', text: prompt }] })}
              ><ArrowUp size={17} aria-hidden="true" /></button></Tooltip>}
        </div>
      </div>
      <p className="composer-foot">VisLex cites evidence for what it claims · Enter to send · Shift+Enter for a new line</p>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement.text ? <span key={announcement.seq} data-seq={announcement.seq}>{announcement.text}</span> : null}</div>
    </div>
  </section>
  </AssistantRuntimeProvider>;
}

function ConversationTurn({ turn, fresh, reducedMotion, latest, live, snapshot, chatBlocked, followUps, scroll, following, onSource, onDraft, onResume, onContinue }: {
  turn: Task; fresh: { current: Set<string> }; reducedMotion: boolean; latest: boolean; live: boolean; snapshot: Snapshot | null; chatBlocked: boolean; followUps: string[];
  scroll: { current: HTMLDivElement | null }; following: { current: boolean }; onSource: SourceOpener; onDraft: (text: string) => void; onResume: () => void; onContinue: () => void;
}) {
  // Decided once at mount: only a turn this panel just sent fades in.
  const [enter] = useState(() => fresh.current.has(turn.id));
  useEffect(() => { fresh.current.delete(turn.id); }, [fresh, turn.id]);
  const outcome = turnOutcome(turn);
  const tokens = turn.input_tokens + turn.output_tokens;
  return <motion.article
    className="conversation-turn"
    data-outcome={outcome.kind}
    initial={enter && !reducedMotion ? { opacity: 0, y: 8 } : false}
    animate={{ opacity: 1, y: 0 }}
    transition={springs.gentle}
  >
    <div className="user-turn"><div className="user-message">{turn.prompt}</div></div>
    <div className="assistant-turn">
      <div className="assistant-message-head">
        <span className="assistant-mark" aria-hidden="true"><span /><span /><span /></span>
        <strong>VisLex</strong>
        <StatusPill state={outcome.pill} label={outcome.label} small />
        {turn.created_at && Number.isFinite(Date.parse(turn.created_at)) ? <time dateTime={turn.created_at} title={new Date(turn.created_at).toLocaleString()}>{shortTime(turn.created_at)}</time> : null}
      </div>
      <TurnActivity turn={turn} onSource={onSource} />
      {live && snapshot ? <LiveResponse caseId={snapshot.id} sessionEpoch={snapshot.session_epoch} taskId={turn.id} onSource={onSource} scroll={scroll} following={following} /> : null}
      {turn.status === 'running' ? <RunStatus turn={turn} /> : null}
      {turn.answer ? <>
        <Markdown className="answer" text={turn.answer} onSource={onSource} />
        <div className="message-meta">
          <CopyButton text={turn.answer} label="Copy answer" small />
          <span className="meta-item" title={tokens ? `Input ${turn.input_tokens.toLocaleString()} · Output ${turn.output_tokens.toLocaleString()} tokens, as reported by the provider` : undefined}>{tokens ? `${tokens.toLocaleString()} tokens` : 'Token usage not reported'}</span>
          {costLabel(turn.cost, turn.cost_partial) ? <span className="meta-item" title="Cost as reported by the provider; VisLex sets no spending limit">{costLabel(turn.cost, turn.cost_partial)}</span> : null}
        </div>
      </> : null}
      <TurnNotice turn={turn} />
      {(turn.status === 'paused' && !chatBlocked) || outcome.kind === 'failed' ? <div className="turn-actions">
        {turn.status === 'paused' && !chatBlocked ? <button type="button" className="secondary resume-button" data-size="sm" onClick={onResume}><Play size={13} aria-hidden="true" />Resume work</button> : null}
        {latest && turn.status === 'paused' && !!turn.error && !chatBlocked ? <button type="button" className="quiet" onClick={onContinue}>Continue in new task</button> : null}
        {outcome.kind === 'failed' ? <button type="button" className="quiet" onClick={() => onDraft(turn.prompt)}><RotateCcw size={13} aria-hidden="true" />Edit and ask again</button> : null}
      </div> : null}
      {latest && turn.status === 'complete' && followUps.length ? <div className="follow-ups">
        <span className="follow-up-label"><MessageSquareQuote size={13} aria-hidden="true" />Suggested next checks</span>
        {followUps.map(step => <button key={step} type="button" className="follow-up" onClick={() => onDraft(`Perform this next check: ${step}`)}><span>{step}</span><ArrowUp size={13} aria-hidden="true" /></button>)}
      </div> : null}
    </div>
  </motion.article>;
}
