import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, BookOpen, ChevronDown, CircleDot, FilePenLine, Film, Flag, Layers, ListChecks,
  LoaderCircle, MessageSquareQuote, Play, Scale, ScanLine, Search, Settings2, Sparkles, Square, Wrench,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, profileKey } from '../aiProfiles';
import type { Action, AIProfile, Snapshot, Selection, Task } from '../types';
import { Markdown } from '../markdown';
import { CopyButton, ModelPicker, StatusPill, Tooltip, formatClock, useNow } from '../ui';
import { buildViewerAttachment, getViewerContext } from '../viewerContext';

// Keep unsaved chat drafts in memory only; never put case content in browser storage.
const chatDrafts = new Map<string, string>();
const modelKey = (caseId: string | undefined, conversationId: string | null) => `vislex-model:${caseId}:${conversationId ?? 'new'}`;

type TeamMember = { id: string; role: string; phase: string; provider: string; model: string; status: string; step: number; answer: string; error: string };

function actionIcon(name: string) {
  if (/finish_task/.test(name)) return <Flag size={13} />;
  if (/^read|text|page|transcript/.test(name)) return <BookOpen size={13} />;
  if (/search/.test(name)) return <Search size={13} />;
  if (/video|frame|media|sound|audio|diariz/.test(name)) return <Film size={13} />;
  if (/record|write|note|draft|work_product/.test(name)) return <FilePenLine size={13} />;
  if (/hypothes|clock|fit/.test(name)) return <Scale size={13} />;
  if (/delegate|team|open_source/.test(name)) return <Layers size={13} />;
  if (/scan|ocr|prepare|render/.test(name)) return <ScanLine size={13} />;
  return <Wrench size={13} />;
}

function friendlyAction(name: string) {
  return name.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
}

function taskState(turn: Task): 'running' | 'paused' | 'complete' | 'failed' | 'unreviewed' {
  if (turn.status === 'running') return 'running';
  if (turn.status === 'paused') return 'paused';
  if (turn.error || turn.status === 'failed') return 'failed';
  if (turn.status === 'complete') return 'complete';
  return 'unreviewed';
}

/** Per-turn activity: every message keeps its receipt ledger, not just the latest. */
function TurnActivity({ turn, onSource }: { turn: Task; onSource: (id: string, locator?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<Action[] | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamError, setTeamError] = useState('');
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
  return <div className="turn-activity">
    <button className={`activity-toggle ${open ? 'open' : ''} ${running ? 'working' : ''}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {running ? <LoaderCircle size={13} className="spin" /> : <ListChecks size={13} />}
      <span>{running ? (latest ? friendlyAction(latest) : 'Considering the evidence…') : `${actions?.length ?? '—'} actions${failures ? ` · ${failures} failed` : ''}`}</span>
      <ChevronDown size={12} />
    </button>
    {open ? <>
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
      <ol className="activity-timeline">
        {(actions ?? []).map(action => <li className={`timeline-row status-${action.status}`} key={action.id}>
          <details>
            <summary>
              <span className="timeline-icon">{actionIcon(action.name)}</span>
              <span className="timeline-name">{friendlyAction(action.name)}</span>
              <span className="timeline-state">{action.status === 'complete' ? '✓' : action.status === 'failed' ? '✕' : '…'}</span>
            </summary>
            <div className="timeline-receipt">
              <pre>{action.output}</pre>
              <div className="timeline-receipt-meta"><code>Receipt {action.id}</code><CopyButton text={action.output} label="Copy receipt" small /></div>
            </div>
          </details>
        </li>)}
        {!actions ? <li className="timeline-row"><span className="timeline-icon"><LoaderCircle size={13} className="spin" /></span><span className="timeline-name">Loading activity…</span></li> : null}
        {actions && !actions.length ? <li className="timeline-row"><span className="timeline-icon"><CircleDot size={13} /></span><span className="timeline-name">No recorded actions.</span></li> : null}
      </ol>
      {running ? <RunStatus turn={turn} /> : null}
    </> : null}
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
    {live.characters ? <div className="activity-live"><LoaderCircle size={12} className="spin" /><span>{live.activity} · {live.characters.toLocaleString()} characters received</span></div> : null}
    {live.text ? <div className="live-answer">
      <p className="live-answer-caption">Live draft — not yet citation-validated</p>
      <Markdown text={live.text} onSource={onSource} caret />
    </div> : null}
  </>;
}

function RunStatus({ turn }: { turn: Task }) {
  const now = useNow(true);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(turn.created_at)) / 1000));
  const tokens = turn.input_tokens + turn.output_tokens;
  return <div className="run-status" role="status">
    {formatClock(elapsed)} elapsed · step {turn.step} · {tokens ? `${tokens.toLocaleString()} tokens reported` : 'Token usage pending'}
    {elapsed > 60 ? ' · Still working. You can stop this run below.' : ''}
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
  const sessionKey = snapshot ? `${snapshot.id}:${snapshot.session_epoch ?? 'preview'}` : null;
  const currentCaseId = useRef(sessionKey);
  currentCaseId.current = sessionKey;
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
  const turns = (conversationDetail && conversationDetail.sessionKey === sessionKey && conversationDetail.conversationId === conversationId
    ? conversationDetail.tasks : (snapshot?.tasks ?? []).filter(turn => (turn.conversation_id ?? turn.id) === conversationId)).slice().reverse();
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

  function submit() {
    if (sending || chatBlocked || !prompt.trim() || !native || !snapshot || snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady) return;
    setSending(true);
    run(async () => {
      try {
        const viewerContext = buildViewerAttachment(selection, getViewerContext(), skipContext);
        const result = await api<{ task_id: string; conversation_id: string }>('start_task', {
          ...caseSessionArgs(snapshot.id, snapshot.session_epoch),
          prompt,
          ...(subscriptionActive ? {} : { provider: selectedProfile!.provider, model: selectedProfile!.model }),
          parent_task_id: task?.id ?? null,
          viewer_context: viewerContext,
        });
        if (currentCaseId.current !== sessionKey) return;
        draft('');
        following.current = true;
        onConversation(result.conversation_id ?? result.task_id);
        await refresh();
      } finally { setSending(false); }
    });
  }

  const followUps = task?.status === 'complete' && !task.error ? (task.progress?.next_steps ?? []).filter(Boolean).slice(0, 3) : [];
  const starters = starterPrompts(snapshot);
  const contextName = selection
    ? selection.type === 'source'
      ? snapshot?.sources.find(source => source.id === selection.id)?.name
      : snapshot?.records.find(record => record.id === selection.id)?.title
    : null;
  const contextPage = selection && getViewerContext()?.sourceId === selection.id ? getViewerContext()?.page : null;

  return <section className="agent-panel">
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
        {conversationDetail && conversationDetail.sessionKey === sessionKey && conversationDetail.conversationId === conversationId && conversationDetail.nextCursor ? <button className="quiet" disabled={loadingOlderTurns} onClick={loadOlderTurns}>{loadingOlderTurns ? 'Loading…' : 'Load earlier messages'}</button> : null}
        {turns.length ? turns.map(turn => <article className="conversation-turn" key={turn.id}>
          <div className="user-message">
            {turn.prompt}
            {turn.status === 'running' && turn.id === running?.id ? <LoaderCircle size={12} className="spin user-message-running" /> : null}
          </div>
          <div className="assistant-message-head">
            <span className="assistant-avatar" aria-hidden="true">V</span>
            <strong>VisLex</strong>
            <StatusPill state={taskState(turn)} label={turn.status === 'running' ? 'Working' : turn.status === 'paused' ? 'Paused' : turn.error || turn.status === 'failed' ? 'Needs attention' : turn.status === 'complete' ? 'Saved response' : 'Pending'} small />
            {turn.created_at && Number.isFinite(Date.parse(turn.created_at)) ? <time dateTime={turn.created_at} title={new Date(turn.created_at).toLocaleString()}>{new Date(turn.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}
          </div>
          <TurnActivity turn={turn} onSource={onSource} />
          {turn.status === 'running' && snapshot ? <LiveResponse caseId={snapshot.id} sessionEpoch={snapshot.session_epoch} taskId={turn.id} onSource={onSource} scroll={scroll} following={following} /> : null}
          {turn.answer ? <>
            <Markdown className="answer" text={turn.answer} onSource={onSource} />
            <div className="message-meta">
              <span className="meta-item">{(turn.input_tokens + turn.output_tokens).toLocaleString()} tokens</span>
              <div className="spacer" />
              <CopyButton text={turn.answer} label="Copy answer" small />
            </div>
          </> : null}
          {turn.error ? <div className="notice error" role="alert">{turn.error}<br /><small>Receipt: {turn.id}</small></div> : null}
          {turn.status === 'paused' && !chatBlocked ? <button className="quiet resume-button" onClick={() => run(async () => { if (!snapshot) return; await api('resume_task', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), task_id: turn.id }); await refresh(); })}><Play size={12} />Resume work</button> : null}
          {turn.id === task?.id && turn.status === 'paused' && !!turn.error && !chatBlocked ? <button className="quiet resume-button" onClick={() => run(async () => {
            const caseId = snapshot?.id;
            if (!caseId) return;
            const result = await api<{task_id:string;conversation_id:string}>('continue_paused_task', { ...caseSessionArgs(caseId, snapshot?.session_epoch), task_id: turn.id });
            if (currentCaseId.current !== sessionKey) return;
            onConversation(result.conversation_id);
            await refresh();
          })}>Continue in new task</button> : null}
          {turn.id === task?.id && turn.status === 'complete' && followUps.length ? <div className="follow-ups">
            <span className="follow-up-label"><MessageSquareQuote size={13} />Suggested next checks</span>
            {followUps.map(step => <button key={step} className="follow-up" onClick={() => { draft(`Perform this next check: ${step}`); composer.current?.focus(); }}>{step}</button>)}
          </div> : null}
        </article>) : <div className="agent-welcome">
          <div className="vislex-glyph"><Sparkles size={22} /></div>
          <div className="eyebrow">CASE WORKSPACE</div>
          <h1>{snapshot ? snapshot.name : 'Start with a case'}</h1>
          <p>{snapshot ? 'Explore the evidence, compare accounts, and keep each conclusion tied to its source.' : 'Open a case to bring your evidence and conversations together.'}</p>
          {snapshot ? <div className="welcome-summary" aria-label="Case at a glance">
            <div><strong>{snapshot.counts?.source_count ?? snapshot.sources.length}</strong><span>Evidence sources</span></div>
            <div><strong>{snapshot.counts?.record_count ?? snapshot.records.length}</strong><span>Working files</span></div>
            <div><strong>{snapshot.sources.filter(source => source.restricted).length}</strong><span>Restricted in this page</span></div>
          </div> : null}
          <h2 className="welcome-prompt-label">Suggested starting points</h2>
          <div className="starter-prompts">{starters.map(starter => <button key={starter} onClick={() => { draft(starter); composer.current?.focus(); }}>{starter}<ArrowUp size={14} /></button>)}</div>
        </div>}
      </div>
    </div>
    {showJump ? <button className="jump-latest" aria-label="Jump to latest message" onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setShowJump(false); }}>Latest ↓</button> : null}
    <div className="composer-area">
      {snapshot && (snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady) ? <button className="offline-notice" onClick={onSettings}>Set up or enable AI in settings</button> : null}
      {chatBlocked && !running ? <p role="status" className="small muted">Preparing case files before chat is available.</p> : null}
      <div className="composer">
        {contextName ? <div className="viewer-context" title="The agent receives this open file, its page and playback position">
          <span>Viewing</span><strong>{contextName}</strong>
          {contextPage ? <span>p.{contextPage}</span> : null}
          <button className="icon-button icon-button-sm" aria-label="Do not attach this file to the next message" onClick={() => setSkipContext(true)} disabled={skipContext}>✕</button>
        </div> : null}
        {skipContext && contextName ? <p className="small muted context-off">This file will not be attached to your next message.</p> : null}
        <textarea ref={composer} aria-label="Agent task" placeholder={task ? 'Follow up, challenge a finding, or ask something else…' : 'Ask VisLex about your case…'} value={prompt} onChange={event => draft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        <div className="composer-bottom">
          {subscriptionActive ? <button className="chip" type="button" onClick={onSettings} aria-label="ChatGPT subscription model">ChatGPT · {accessChoice?.model ?? 'Choose model'}</button> : <ModelPicker
            snapshot={snapshot}
            selected={selectedProfile}
            onSelect={profile => { setSelectedModel(profileKey(profile)); sessionStorage.setItem(modelKey(snapshot?.id, conversationId), profileKey(profile)); }}
            onManage={onSettings}
            disabled={chatBlocked || sending || !availableModels.length}
          />}
          <div className="spacer" />
          {running
            ? <Tooltip text="Stop the current response"><button className="send stop" aria-label="Stop response" onClick={() => run(async () => { if (!snapshot) return; await api('stop_task', { ...caseSessionArgs(snapshot.id, snapshot.session_epoch), task_id: running.id }); await refresh(); })}><Square size={14} /></button></Tooltip>
            : <Tooltip text={chatBlocked ? 'Waiting for case preparation' : 'Send message (Enter)'}><button className="send" aria-label="Send message" disabled={chatBlocked || sending || !prompt.trim() || !snapshot || !native || snapshot.settings.offline || !snapshot.settings.allow_text || !modelReady} onClick={submit}><ArrowUp size={18} /></button></Tooltip>}
        </div>
      </div>
      <p className="composer-foot">VisLex cites evidence for what it claims · Enter to send · Shift+Enter for a new line</p>
    </div>
  </section>;
}
