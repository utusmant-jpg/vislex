import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUp, BookOpen, CalendarClock, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleDot,
  CircleStop, CircleX, FilePenLine, FileStack, FileText, Film, Flag, Hourglass, KeyRound, Layers, ListChecks, LoaderCircle,
  Lock, MessageSquareQuote, MonitorSmartphone, Paperclip, Play, Scale, ScanLine, Search, SearchCheck, Settings2, ShieldOff,
  Sparkles, Square, Users, WifiOff, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { ease, springs } from '../lib/motion';
import { turnSignature, useVisLexRuntime } from '../chat/vislex-runtime';
import { listen } from '@tauri-apps/api/event';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, profileKey } from '../aiProfiles';
import type { Action, AIProfile, Snapshot, Selection, Task } from '../types';
import { Markdown } from '../markdown';
import { CopyButton, ModelPicker, StatusPill, Tooltip, formatClock, useNow, type PillState } from '../ui';
import { buildViewerAttachment, getViewerContext, subscribeViewerContext } from '../viewerContext';

// Keep unsaved chat drafts in memory only; never put case content in browser storage.
const chatDrafts = new Map<string, string>();
const modelKey = (caseId: string | undefined, conversationId: string | null) => `vislex-model:${caseId}:${conversationId ?? 'new'}`;
/** The exact pause reason the backend records when the user presses Stop. */
const USER_STOP_REASON = 'Stopped by user';
const STOP_TOOLTIP = 'Stop generating. Tokens already produced may still be billed by the provider.';

type TeamMember = { id: string; role: string; phase: string; provider: string; model: string; status: string; step: number; answer: string; error: string };

/** Tool family, derived only from the recorded tool name. */
function toolFamily(name: string): { Icon: LucideIcon; label: string } {
  if (/finish_task/.test(name)) return { Icon: Flag, label: 'Answer' };
  if (/^read|text|page|transcript/.test(name)) return { Icon: BookOpen, label: 'Reading' };
  if (/search/.test(name)) return { Icon: Search, label: 'Search' };
  if (/video|frame|media|sound|audio|diariz/.test(name)) return { Icon: Film, label: 'Media' };
  if (/record|write|note|draft|work_product/.test(name)) return { Icon: FilePenLine, label: 'Working files' };
  if (/hypothes|clock|fit/.test(name)) return { Icon: Scale, label: 'Analysis' };
  if (/delegate|team|open_source/.test(name)) return { Icon: Layers, label: 'Coordination' };
  if (/scan|ocr|prepare|render/.test(name)) return { Icon: ScanLine, label: 'Processing' };
  return { Icon: Wrench, label: 'Tool' };
}

function friendlyAction(name: string) {
  return name.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
}

function sentenceCase(text: string) {
  return text.replace(/^./, character => character.toUpperCase());
}

function isUserStopped(turn: Task) {
  return turn.status === 'paused' && turn.error === USER_STOP_REASON;
}

function taskState(turn: Task): PillState {
  if (turn.status === 'running') return 'running';
  if (isUserStopped(turn)) return 'stopped';
  if (turn.status === 'paused') return 'paused';
  if (turn.error || turn.status === 'failed') return 'failed';
  if (turn.status === 'complete') return 'complete';
  return 'unreviewed';
}

function taskLabel(turn: Task) {
  if (turn.status === 'running') return 'Working';
  if (isUserStopped(turn)) return 'Stopped by you';
  if (turn.status === 'paused') return 'Paused';
  if (turn.error || turn.status === 'failed') return 'Needs attention';
  if (turn.status === 'complete') return 'Saved response';
  return 'Pending';
}

function validTime(iso: string | undefined) {
  return !!iso && Number.isFinite(Date.parse(iso));
}

function dayKey(iso: string) {
  return validTime(iso) ? new Date(iso).toDateString() : '';
}

function shortTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Status of one recorded action: an icon with an accessible label, never colour alone. */
function ActionStatus({ status, turnRunning }: { status: string; turnRunning: boolean }) {
  const [Icon, label, tone, spinning]: [LucideIcon, string, string, boolean] = status === 'complete'
    ? [CircleCheck, 'Completed', 'success', false]
    : status === 'failed'
      ? [CircleX, 'Failed', 'danger', false]
      : turnRunning
        ? [LoaderCircle, 'In progress', 'accent', true]
        : [CircleDashed, status ? sentenceCase(status.replaceAll('_', ' ')) : 'Status not recorded', 'neutral', false];
  return <span className={`timeline-state tone-${tone}`} role="img" aria-label={label} title={label}>
    <Icon size={14} className={spinning ? 'spin' : undefined} aria-hidden="true" />
  </span>;
}

/** Per-turn activity: every message keeps its receipt ledger, not just the latest. */
function TurnActivity({ turn, onSource }: { turn: Task; onSource: (id: string, locator?: string) => void }) {
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
        .then(value => { if (active) setActions(value); })
        .catch(reason => { if (active) setActions([{ id: 'activity-error', name: 'Activity unavailable', input: '', output: String(reason), status: 'failed', created_at: new Date().toISOString() }]); });
      if (native) api<TeamMember[]>('team_status', { task_id: turn.id })
        .then(value => { if (active) setTeam(value); })
        .catch(reason => { if (active) setTeamError(String(reason)); });
    };
    load();
    const timer = running ? setInterval(load, 2500) : undefined;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [open, turn.id, turn.step, turn.status, running]);
  const failures = actions?.filter(action => action.status === 'failed').length ?? 0;
  const latest = actions?.at(-1)?.name;
  const count = actions?.length ?? 0;
  const summary = running
    ? (latest ? friendlyAction(latest) : 'Considering the evidence…')
    : actions ? `${count} ${count === 1 ? 'action' : 'actions'}${failures ? ` · ${failures} failed` : ''}` : 'Activity';
  const completeMembers = team.filter(member => member.status === 'complete').length;
  return <div className="turn-activity">
    <button
      type="button"
      className={`activity-toggle ${open ? 'open' : ''} ${running ? 'working' : ''} ${failures ? 'has-failures' : ''}`}
      aria-expanded={open}
      aria-controls={open ? bodyId : undefined}
      onClick={() => setOpen(value => !value)}>
      {running ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
      <span className="activity-toggle-label">{summary}</span>
      <ChevronDown size={13} className="activity-toggle-chevron" aria-hidden="true" />
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
      {teamError ? <p className="small danger-text activity-team-error" role="alert">Team status unavailable: {teamError}</p> : null}
      {team.length ? <section className="team-cards" aria-label="Agent team">
        <div className="team-cards-head">
          <Users size={14} aria-hidden="true" />
          <p className="team-disclaimer">Agent team · {completeMembers}/{team.length} assignments complete. Separate working contexts — not independent corroboration or human approval.</p>
        </div>
        <ul className="team-card-list">
          {team.map(member => <li key={member.id}>
            <details className="team-card">
              <summary>
                <span className="team-card-main">
                  <strong className="team-role">{member.role}</strong>
                  <span className="team-model" title={member.model}>{member.model}</span>
                </span>
                <StatusPill state={member.status === 'complete' ? 'complete' : member.status === 'failed' ? 'failed' : 'running'} label={member.status.replaceAll('_', ' ')} small />
                <ChevronRight size={14} className="team-card-chevron" aria-hidden="true" />
              </summary>
              <div className="team-card-body">
                <p className="team-meta">{member.provider.replaceAll('"', '')} · {member.phase.replaceAll('_', ' ')} · step {member.step}</p>
                {member.error ? <p className="small danger-text" role="alert">{member.error}</p> : null}
                {member.answer ? <Markdown text={member.answer} onSource={onSource} /> : <p className="small muted">No completed proposal yet.</p>}
              </div>
            </details>
          </li>)}
        </ul>
      </section> : null}
      <ol className="activity-timeline" aria-label="Recorded actions">
        {(actions ?? []).map(action => {
          const family = toolFamily(action.name);
          return <li className={`timeline-row status-${action.status}`} key={action.id}>
            <details>
              <summary>
                <span className="timeline-icon" title={family.label}><family.Icon size={13} aria-hidden="true" /></span>
                <span className="timeline-name">{friendlyAction(action.name)}</span>
                {validTime(action.created_at) ? <time className="timeline-time" dateTime={action.created_at} title={new Date(action.created_at).toLocaleString()}>{shortTime(action.created_at)}</time> : null}
                <ActionStatus status={action.status} turnRunning={running} />
                <ChevronRight size={13} className="timeline-chevron" aria-hidden="true" />
              </summary>
              <div className="timeline-receipt">
                {action.output ? <pre>{action.output}</pre> : <p className="small muted timeline-empty-output">No output was recorded for this action.</p>}
                <div className="timeline-receipt-meta"><code>Receipt {action.id}</code><div className="spacer" /><CopyButton text={action.output} label="Copy receipt" small /></div>
              </div>
            </details>
          </li>;
        })}
        {!actions ? <li className="timeline-row timeline-placeholder"><span className="timeline-icon"><LoaderCircle size={13} className="spin" aria-hidden="true" /></span><span className="timeline-name">Loading activity…</span></li> : null}
        {actions && !actions.length ? <li className="timeline-row timeline-placeholder"><span className="timeline-icon"><CircleDot size={13} aria-hidden="true" /></span><span className="timeline-name">No recorded actions.</span></li> : null}
      </ol>
      </motion.div> : null}
    </AnimatePresence>
  </div>;
}

/** Keep high-frequency Tauri deltas out of the workspace and preserve the entire draft. */
function LiveResponse({ caseId, sessionEpoch, taskId, onSource, scroll, following }: { caseId: string; sessionEpoch?: number; taskId: string; onSource: (id: string, locator?: string) => void; scroll: { current: HTMLDivElement | null }; following: { current: boolean } }) {
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
    {live.characters ? <div className="activity-live">
      <LoaderCircle size={13} className="spin" aria-hidden="true" />
      <span className="activity-live-name">{sentenceCase(live.activity)}</span>
      <span className="activity-live-units">· {live.characters.toLocaleString()} characters received</span>
    </div> : null}
    {live.text ? <div className="live-answer">
      <p className="live-answer-caption">Live draft — not yet citation-validated</p>
      <Markdown className="answer" text={live.text} onSource={onSource} caret />
    </div> : null}
  </>;
}

/** Elapsed time, step and reported usage for a running turn. The ticking clock is
 *  hidden from assistive technology so the live region is not re-announced every second. */
function RunStatus({ turn }: { turn: Task }) {
  const now = useNow(true);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(turn.created_at)) / 1000));
  const tokens = turn.input_tokens + turn.output_tokens;
  return <div className="run-status" role="status">
    <span className="activity-dot" aria-hidden="true" />
    <span className="run-status-clock" aria-hidden="true">{formatClock(elapsed)} elapsed</span>
    <span> · step {turn.step} · {tokens ? `${tokens.toLocaleString()} tokens reported` : 'Token usage pending'}</span>
    {elapsed > 60 ? <span className="run-status-hint"> · Still working. You can stop this run below.</span> : null}
  </div>;
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

function starterIcon(starter: string): LucideIcon {
  if (/timeline/i.test(starter)) return CalendarClock;
  if (/contradiction/i.test(starter)) return Scale;
  if (/video|recording|moments/i.test(starter)) return Film;
  if (/document|statement/i.test(starter)) return FileText;
  if (/missing|unverified/i.test(starter)) return SearchCheck;
  return Sparkles;
}

type ComposerBlocker = { key: string; Icon: LucideIcon; title: string; detail?: string; action?: string; status?: boolean };

export default function AgentPanel({ snapshot, selection, refresh, run, onSource, onSettings, conversationId, onConversation, focusRequest = 0 }: { snapshot: Snapshot | null; selection: Selection; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; onSource: (id: string, locator?: string) => void; onSettings: () => void; conversationId: string | null; onConversation: (id: string) => void; focusRequest?: number }) {
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
  // A ref as well as state: two Enter presses inside one render must not start two tasks.
  const sendingRef = useRef(false);
  const sessionKey = snapshot ? `${snapshot.id}:${snapshot.session_epoch ?? 'preview'}` : null;
  const currentCaseId = useRef(sessionKey);
  currentCaseId.current = sessionKey;
  const [skipContext, setSkipContext] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const blockerId = useId();
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    input.style.overflowY = input.scrollHeight > 220 ? 'auto' : 'hidden';
  }, [prompt]);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [conversationDetail, setConversationDetail] = useState<{ sessionKey: string; conversationId: string; tasks: Task[]; nextCursor: { created_at: string; id: string } | null } | null>(null);
  const [loadingOlderTurns, setLoadingOlderTurns] = useState(false);
  const summarySignature = (snapshot?.tasks ?? []).filter(turn => (turn.conversation_id ?? turn.id) === conversationId).map(turnSignature).join('|');
  useEffect(() => {
    if (!snapshot || !conversationId) { setConversationDetail(null); return; }
    let active = true;
    api<{ tasks: Task[]; next_cursor: { created_at: string; id: string } | null }>('conversation_detail', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), conversation_id: conversationId })
      .then(detail => { if (active) setConversationDetail(detail && Array.isArray(detail.tasks) ? { sessionKey: sessionKey!, conversationId, tasks: detail.tasks, nextCursor: detail.next_cursor ?? null } : null); })
      .catch(() => { if (active) setConversationDetail(null); });
    return () => { active = false; };
  }, [sessionKey, conversationId, summarySignature]);
  const detailCurrent = !!conversationDetail && conversationDetail.sessionKey === sessionKey && conversationDetail.conversationId === conversationId;
  const turns = (detailCurrent
    ? conversationDetail!.tasks : (snapshot?.tasks ?? []).filter(turn => (turn.conversation_id ?? turn.id) === conversationId)).slice().reverse();
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
  const aiUnavailable = !snapshot || snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady;
  const canSend = !sending && !chatBlocked && native && !aiUnavailable;

  // Only a newly sent or newly arriving turn animates in. History, "Load earlier"
  // pages, conversation switches and remounts render in place.
  const conversationKey = `${sessionKey}:${conversationId ?? 'new'}`;
  const seenTurns = useRef(new Set<string>());
  const settledConversation = useRef<string | null>(null);
  const justSent = useRef<string | null>(null);
  const watchedRunning = useRef(new Set<string>());
  const sameConversation = settledConversation.current === conversationKey;
  const entering = new Set(turns
    .filter(turn => !seenTurns.current.has(turn.id) && (turn.id === justSent.current || (sameConversation && turn.id === task?.id)))
    .map(turn => turn.id));
  useLayoutEffect(() => {
    for (const turn of turns) {
      seenTurns.current.add(turn.id);
      if (turn.status === 'running') watchedRunning.current.add(turn.id);
    }
    if (turns.length) settledConversation.current = conversationKey;
  });

  useEffect(() => { setSelectedModel(sessionStorage.getItem(modelKey(snapshot?.id, conversationId)) ?? ''); }, [snapshot?.id, conversationId]);
  useEffect(() => {
    following.current = true;
    setShowJump(false);
    setSkipContext(false);
    setPrompt(chatDrafts.get(`${snapshot?.id}:${conversationId}`) ?? '');
  }, [snapshot?.id, conversationId]);
  useEffect(() => {
    const focus = () => { composer.current?.focus(); };
    const draftEvent = (event: Event) => { const detail = (event as CustomEvent<{ text?: string }>).detail; if (detail?.text) setPrompt(detail.text); composer.current?.focus(); };
    window.addEventListener('vislex:focus-composer', focus);
    window.addEventListener('vislex:draft-prompt', draftEvent);
    return () => { window.removeEventListener('vislex:focus-composer', focus); window.removeEventListener('vislex:draft-prompt', draftEvent); };
  }, []);
  useEffect(() => { if (focusRequest) composer.current?.focus(); }, [focusRequest]);
  useEffect(() => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [turns.length, task?.answer, task?.status]);
  useEffect(() => { setSkipContext(false); }, [selection?.id, selection?.locator]);

  function draft(value: string) {
    setPrompt(value);
    chatDrafts.set(`${snapshot?.id}:${conversationId}`, value);
  }

  /** The single send path: Enter, the send button and assistant-ui appends all land
   *  here, and any rejection surfaces through run()'s error notification. */
  function submit(text: string = prompt) {
    if (sendingRef.current || !canSend || !text.trim() || !snapshot) return;
    sendingRef.current = true;
    setSending(true);
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
        justSent.current = result.task_id;
        draft('');
        following.current = true;
        onConversation(result.conversation_id ?? result.task_id);
        await refresh();
      } finally { sendingRef.current = false; setSending(false); }
    });
  }

  function stopRunning() {
    if (!snapshot || !running) return;
    run(async () => { await api('stop_task', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), task_id: running.id }); await refresh(); });
  }

  // assistant-ui mirrors the backend conversation only; its appends and cancels
  // route to the same submit/stop paths the composer uses.
  const runtime = useVisLexRuntime({
    turns,
    isRunning: !!running,
    onNew: text => submit(text),
    onCancel: stopRunning,
  });

  const followUps = task?.status === 'complete' && !task.error ? (task.progress?.next_steps ?? []).filter(Boolean).slice(0, 3) : [];
  const starters = starterPrompts(snapshot);
  const reducedMotion = useReducedMotion();
  const viewer = useSyncExternalStore(subscribeViewerContext, getViewerContext, getViewerContext);
  const contextName = selection
    ? selection.type === 'source'
      ? snapshot?.sources.find(source => source.id === selection.id)?.name
      : snapshot?.records.find(record => record.id === selection.id)?.title
    : null;
  const viewed = selection && viewer?.sourceId === selection.id ? viewer : null;
  const contextPage = viewed?.page ?? null;
  const contextTime = typeof viewed?.timeSeconds === 'number' ? viewed.timeSeconds : null;

  const preparing = chatBlocked && !running;
  const blocker: ComposerBlocker | null = !snapshot ? null
    : snapshot.settings.offline ? { key: 'offline', Icon: WifiOff, title: 'This case is offline', detail: 'No new AI requests are sent while the case is offline.', action: 'Open AI settings' }
    : !snapshot.settings.allow_text ? { key: 'text', Icon: ShieldOff, title: 'Case text is not permitted for AI', detail: 'Allow text for this case before VisLex can send it to a model.', action: 'Review permissions' }
    : !native ? { key: 'desktop', Icon: MonitorSmartphone, title: 'Chat runs in the desktop app', detail: 'This browser sample never sends evidence to an AI provider.' }
    : !accessChoice ? { key: 'access', Icon: KeyRound, title: 'AI access could not be checked', detail: 'VisLex could not read which AI access route this case uses.', action: 'Open AI settings' }
    : subscriptionActive && !modelReady ? { key: 'subscription', Icon: KeyRound, title: 'Choose a ChatGPT subscription model', detail: 'The subscription route is on for this case, but no model and effort are chosen.', action: 'Choose model' }
    : !subscriptionActive && !modelReady ? { key: 'model', Icon: Lock, title: 'No permitted model', detail: 'No configured model is permitted to receive case text.', action: 'Manage models' }
    : preparing ? { key: 'preparing', Icon: Hourglass, title: 'Preparing case files before chat is available.', detail: snapshot.counts?.chat_pause ?? undefined, status: true }
    : null;

  function renderTurn(turn: Task, index: number) {
    const previous = turns[index - 1];
    const newDay = !!previous && !!dayKey(turn.created_at) && dayKey(previous.created_at) !== dayKey(turn.created_at);
    const isEntering = entering.has(turn.id);
    const stopped = isUserStopped(turn);
    const paused = turn.status === 'paused';
    const failed = !paused && (!!turn.error || turn.status === 'failed');
    const tokens = turn.input_tokens + turn.output_tokens;
    const showResume = paused && !chatBlocked;
    const showContinue = turn.id === task?.id && paused && !!turn.error && !chatBlocked;
    const showFollowUps = turn.id === task?.id && turn.status === 'complete' && followUps.length > 0;
    return <Fragment key={turn.id}>
      {newDay ? <div className="day-separator" role="separator" aria-label={new Date(turn.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}>
        <span>{new Date(turn.created_at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      </div> : null}
      <motion.article
        className="conversation-turn"
        data-entering={isEntering || undefined}
        initial={isEntering && !reducedMotion ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: ease.out }}
      >
        <div className="user-turn">
          <div className="user-message">{turn.prompt}</div>
        </div>
        <div className={`assistant-turn state-${taskState(turn)}`}>
          <div className="assistant-message-head">
            <span className="assistant-avatar" aria-hidden="true">V</span>
            <strong>VisLex</strong>
            <StatusPill state={taskState(turn)} label={taskLabel(turn)} small />
            {validTime(turn.created_at) ? <time dateTime={turn.created_at} title={new Date(turn.created_at).toLocaleString()}>{shortTime(turn.created_at)}</time> : null}
          </div>
          <div className="assistant-body">
            {turn.status === 'running' ? <RunStatus turn={turn} /> : null}
            <TurnActivity turn={turn} onSource={onSource} />
            {turn.status === 'running' && snapshot ? <LiveResponse caseId={snapshot.id} sessionEpoch={snapshot.session_epoch} taskId={turn.id} onSource={onSource} scroll={scroll} following={following} /> : null}
            {turn.answer ? <>
              <Markdown className="answer" text={turn.answer} onSource={onSource} />
              <div className="message-meta">
                <span className="meta-item" title={tokens ? `${turn.input_tokens.toLocaleString()} input · ${turn.output_tokens.toLocaleString()} output tokens reported` : undefined}>
                  {tokens ? `${tokens.toLocaleString()} tokens reported` : 'Token usage not reported'}
                </span>
                {turn.answer_truncated ? <span className="meta-item">Showing a shortened preview of this answer</span> : null}
                <div className="spacer" />
                {turn.answer_truncated ? null : <CopyButton text={turn.answer} label="Copy answer" small />}
              </div>
            </> : null}
            {stopped ? <div className="turn-outcome">
              <CircleStop size={15} aria-hidden="true" />
              <span>You stopped this response.</span>
              <span className="turn-receipt">Receipt: {turn.id}</span>
            </div> : null}
            {!stopped && (turn.error || failed) ? <div className="notice error turn-error" role="alert">
              <CircleX size={16} aria-hidden="true" />
              <div className="turn-error-body">
                <strong>{paused ? 'Work paused after a problem' : 'This response could not be completed'}</strong>
                <p className="turn-error-message">{turn.error || 'No error detail was recorded.'}</p>
                <small className="turn-receipt">Receipt: {turn.id}</small>
              </div>
            </div> : null}
            {showResume || showContinue ? <div className="turn-actions">
              {showResume ? <button type="button" className="secondary resume-button" data-size="sm" onClick={() => run(async () => { if (!snapshot) return; await api('resume_task', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), task_id: turn.id }); await refresh(); })}><Play size={13} aria-hidden="true" />Resume work</button> : null}
              {showContinue ? <button type="button" className="quiet resume-button" onClick={() => run(async () => {
                const caseId = snapshot?.id;
                if (!caseId) return;
                const result = await api<{task_id:string;conversation_id:string}>('continue_paused_task', { ...caseSessionArgs(caseId, snapshot?.session_epoch), task_id: turn.id });
                if (currentCaseId.current !== sessionKey) return;
                onConversation(result.conversation_id);
                await refresh();
              })}><ArrowRight size={13} aria-hidden="true" />Continue in new task</button> : null}
            </div> : null}
            {showFollowUps ? <motion.div
              className="follow-ups"
              initial={watchedRunning.current.has(turn.id) && !reducedMotion ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: ease.out }}
            >
              <span className="follow-up-label"><MessageSquareQuote size={13} aria-hidden="true" />Suggested next checks</span>
              {followUps.map(step => <button
                type="button"
                key={step}
                className="follow-up"
                onClick={() => { draft(`Perform this next check: ${step}`); composer.current?.focus(); }}
              ><span className="follow-up-text">{step}</span><ArrowUp size={14} aria-hidden="true" /></button>)}
            </motion.div> : null}
          </div>
        </div>
      </motion.article>
    </Fragment>;
  }

  return <AssistantRuntimeProvider runtime={runtime}>
    <section className="agent-panel">
    <div className="panel-heading">
      <span className="chat-heading" title={turns[0]?.title ?? turns[0]?.prompt}>{turns[0]?.title ?? turns[0]?.prompt.slice(0, 65) ?? 'New chat'}</span>
      <div className="spacer" />
      <Tooltip text="Agent &amp; model settings"><button className="icon-button" aria-label="Agent settings" onClick={onSettings}><Settings2 size={16} /></button></Tooltip>
    </div>
    <div className="agent-scroll" ref={scroll} onScroll={() => {
      const element = scroll.current;
      if (!element) return;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      setShowJump(!following.current && turns.length > 0);
    }}>
      <div className="conversation-content">
        {detailCurrent && conversationDetail!.nextCursor ? <div className="load-earlier">
          <button type="button" className="quiet" disabled={loadingOlderTurns} aria-busy={loadingOlderTurns || undefined} onClick={loadOlderTurns}>
            {loadingOlderTurns ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}
            {loadingOlderTurns ? 'Loading…' : 'Load earlier messages'}
          </button>
        </div> : null}
        {turns.length ? turns.map(renderTurn) : <motion.div
          className="agent-welcome"
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: ease.out }}
        >
          <div className="welcome-mark" aria-hidden="true">V</div>
          <div className="eyebrow">Case workspace</div>
          <h1>{snapshot ? snapshot.name : 'Start with a case'}</h1>
          <p className="welcome-lede">{snapshot ? 'Explore the evidence, compare accounts, and keep each conclusion tied to its source.' : 'Open a case to bring your evidence and conversations together.'}</p>
          {snapshot ? <div className="welcome-summary" role="group" aria-label="Case at a glance">
            <div className="welcome-stat"><FileStack size={15} aria-hidden="true" /><strong className={snapshot.counts?.source_count ?? snapshot.sources.length ? undefined : 'stat-zero'}>{snapshot.counts?.source_count ?? snapshot.sources.length}</strong><span>Evidence sources</span></div>
            <div className="welcome-stat"><FilePenLine size={15} aria-hidden="true" /><strong className={snapshot.counts?.record_count ?? snapshot.records.length ? undefined : 'stat-zero'}>{snapshot.counts?.record_count ?? snapshot.records.length}</strong><span>Working files</span></div>
            <div className="welcome-stat"><Lock size={15} aria-hidden="true" /><strong className={snapshot.sources.filter(source => source.restricted).length ? undefined : 'stat-zero'}>{snapshot.sources.filter(source => source.restricted).length}</strong><span>Restricted in this page</span></div>
          </div> : null}
          <h2 className="welcome-prompt-label">Suggested starting points</h2>
          <div className="starter-prompts">{starters.map(starter => {
            const Icon = starterIcon(starter);
            return <button type="button" key={starter} className="starter-row" onClick={() => { draft(starter); composer.current?.focus(); }}>
              <span className="starter-icon" aria-hidden="true"><Icon size={15} /></span>
              <span className="starter-text">{starter}</span>
              <ArrowUp size={14} className="starter-arrow" aria-hidden="true" />
            </button>;
          })}</div>
          <p className="welcome-note">A suggestion fills the composer. Nothing is sent until you press Enter.</p>
        </motion.div>}
      </div>
    </div>
    <div className="composer-area">
      <AnimatePresence>
        {showJump ? <div className="jump-latest-wrap"><motion.button
          type="button"
          className="jump-latest"
          aria-label="Jump to latest message"
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={springs.overlay}
          onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setShowJump(false); }}
        ><ArrowDown size={14} aria-hidden="true" />Latest</motion.button></div> : null}
      </AnimatePresence>
      {blocker ? <div className={`composer-blocker blocker-${blocker.key}`} id={blockerId} role={blocker.status ? 'status' : undefined}>
        <span className="composer-blocker-icon"><blocker.Icon size={15} aria-hidden="true" /></span>
        <div className="composer-blocker-text">
          <strong>{blocker.title}</strong>
          {blocker.detail ? <span>{blocker.detail}</span> : null}
        </div>
        {blocker.action ? <button type="button" className="secondary" data-size="sm" onClick={onSettings}>{blocker.action}</button> : null}
      </div> : null}
      <div className={`composer ${blocker ? 'is-blocked' : ''}`}>
        {contextName ? <div className={`viewer-context ${skipContext ? 'is-skipped' : ''}`} title="The agent receives this open file, its page and playback position">
          <Paperclip size={13} aria-hidden="true" />
          <span className="viewer-context-label">{skipContext ? 'Not attaching' : 'Viewing'}</span>
          <strong>{contextName}</strong>
          {contextPage ? <span className="viewer-context-locator">p.{contextPage}</span> : null}
          {contextTime !== null && !contextPage ? <span className="viewer-context-locator">{formatClock(contextTime)}</span> : null}
          {skipContext
            ? <button type="button" className="viewer-context-undo" onClick={() => setSkipContext(false)} aria-label="Attach this file to the next message">Attach</button>
            : <button type="button" className="icon-button icon-button-sm" aria-label="Do not attach this file to the next message" onClick={() => setSkipContext(true)}><X size={13} aria-hidden="true" /></button>}
        </div> : null}
        {skipContext && contextName ? <p className="small muted context-off">This file will not be attached to your next message.</p> : null}
        <textarea
          ref={composer}
          aria-label="Agent task"
          aria-describedby={blocker ? blockerId : undefined}
          placeholder={task ? 'Follow up, challenge a finding, or ask something else…' : 'Ask VisLex about your case…'}
          value={prompt}
          onChange={event => draft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        <div className="composer-bottom">
          {subscriptionActive ? <button className="chip subscription-chip" type="button" onClick={onSettings} aria-label="ChatGPT subscription model"><span className="provider-dot" data-provider="openai" aria-hidden="true" />ChatGPT · {accessChoice?.model ?? 'Choose model'}</button> : <ModelPicker
            snapshot={snapshot}
            selected={selectedProfile}
            onSelect={profile => { setSelectedModel(profileKey(profile)); sessionStorage.setItem(modelKey(snapshot?.id, conversationId), profileKey(profile)); }}
            onManage={onSettings}
            disabled={chatBlocked || sending || !availableModels.length}
          />}
          <div className="spacer" />
          {running
            ? <Tooltip text={STOP_TOOLTIP}><motion.button
                type="button"
                className="send stop"
                aria-label="Stop response"
                whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                transition={springs.snappy}
                onClick={stopRunning}
              ><Square size={12} fill="currentColor" aria-hidden="true" /></motion.button></Tooltip>
            : <Tooltip text={chatBlocked ? 'Waiting for case preparation' : 'Send message'} shortcut={chatBlocked ? undefined : 'Enter'}><motion.button
                type="button"
                className="send"
                aria-label="Send message"
                disabled={!canSend || !prompt.trim()}
                whileTap={reducedMotion ? undefined : { scale: 0.94 }}
                transition={springs.snappy}
                onClick={() => submit()}
              >{sending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}</motion.button></Tooltip>}
        </div>
      </div>
      <p className="composer-foot">VisLex cites evidence for what it claims · <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line</p>
    </div>
  </section>
  </AssistantRuntimeProvider>;
}
