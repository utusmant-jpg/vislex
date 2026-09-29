// "What it did": the per-turn record of recorded agent actions, shown as plain
// sentences. Collapsed, it is one quiet line (a live label while working, a
// recap once done); expanded, a slim list with grouped runs and per-step
// detail. Raw receipts stay one click deeper, never removed.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AudioLines, BookOpen, Check, ChevronRight, CircleDot, FileSearch, FilePenLine, Film, Flag, FolderOpen, Search, ShieldCheck, Users, X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, native } from '../bridge';
import type { Action, Task } from '../types';
import { CopyButton, StatusPill, useNow } from '../ui';
import { Markdown } from '../markdown';
import { CitationChip } from '../ui';
import { springs } from '../lib/motion';
import {
  groupLabel, groupSteps, isGroup, liveLabel, progressLabel, researchLines, summarizeAction, traceRecap, workedFor,
  type NameLookup, type StepGroup, type StepKind, type StepSummary,
} from './activity-summary';
import type { LiveStep } from './live-progress';

type TeamMember = { id: string; role: string; phase: string; provider: string; model: string; status: string; step: number; answer: string; error: string };
type SourceOpener = (id: string, locator?: string) => void;

const kindIcon: Record<StepKind, typeof Search> = {
  search: Search, read: BookOpen, look: FileSearch, watch: Film, listen: AudioLines, save: FilePenLine,
  check: ShieldCheck, team: Users, finish: Flag, browse: FolderOpen, other: CircleDot,
};

function StepIcon({ kind }: { kind: StepKind }) {
  const Icon = kindIcon[kind];
  return <span className="trace-icon" aria-hidden="true"><Icon size={14} /></span>;
}

function shortTime(iso: string) {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
}

function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function Sentence({ step }: { step: StepSummary }) {
  return <span className="trace-sentence">
    {step.verb}{step.object ? <> <strong>{step.object}</strong></> : null}
    {step.detail ? <span className="trace-detail"> · {step.detail}</span> : null}
    {step.result ? <span className="trace-result"> · {step.result}</span> : null}
    {step.repeat ? <span className="trace-tag">already retrieved</span> : null}
  </span>;
}

function StepRow({ step, action, onSource }: { step: StepSummary; action: Action; onSource: SourceOpener }) {
  return <details className="trace-step-details">
    <summary>
      <StepIcon kind={step.kind} />
      <Sentence step={step} />
      {step.failed
        ? <span className="trace-state is-failed"><X size={14} aria-hidden="true" />Failed</span>
        : <span className="trace-state is-done"><Check size={14} aria-hidden="true" /><span className="visually-hidden">Done</span></span>}
      <ChevronRight size={14} className="trace-chevron" aria-hidden="true" />
    </summary>
    <div className="trace-step-body">
      {step.facts.length ? <dl className="trace-facts">{step.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl> : null}
      {step.excerpts.length ? <ul className="trace-excerpts">{step.excerpts.map((excerpt, index) => <li key={index}>
        {excerpt.title ? <span className="trace-excerpt-title">{excerpt.title}</span> : null}
        <span className="trace-excerpt-text">{excerpt.text}</span>
        {excerpt.locator ? <CitationChip value={excerpt.locator} previewable={false} onOpen={(id, locator) => onSource(id, locator)} /> : null}
      </li>)}</ul> : null}
      <details className="trace-receipt">
        <summary>Technical receipt</summary>
        {action.input ? <><p className="trace-receipt-label">Request</p><pre>{pretty(action.input)}</pre></> : null}
        <p className="trace-receipt-label">Result</p>
        <pre>{pretty(action.output)}</pre>
        <div className="trace-receipt-meta"><time dateTime={action.created_at}>{shortTime(action.created_at)}</time><code>Receipt {action.id}</code><CopyButton text={action.output} label="Copy receipt" small /></div>
      </details>
    </div>
  </details>;
}

function GroupRow({ group, actions, onSource }: { group: StepGroup; actions: Map<string, Action>; onSource: SourceOpener }) {
  return <details className="trace-group">
    <summary>
      <StepIcon kind={group.kind} />
      <span className="trace-sentence">{groupLabel(group)}</span>
      <span className="trace-state is-done"><Check size={14} aria-hidden="true" /><span className="visually-hidden">Done</span></span>
      <ChevronRight size={14} className="trace-chevron" aria-hidden="true" />
    </summary>
    <ol className="trace-steps nested">
      {group.steps.map(step => <li key={step.id} className="trace-step" data-kind={step.kind}><StepRow step={step} action={actions.get(step.id)!} onSource={onSource} /></li>)}
    </ol>
  </details>;
}

export default function ActivityTrace({ turn, liveActivity, liveDetail, liveAction, liveSteps, nameOf, onSource, eager }: {
  turn: Task & { updated_at?: string }; liveActivity?: string; liveDetail?: string; liveAction?: string; liveSteps?: LiveStep[]; nameOf: NameLookup; onSource: SourceOpener; eager: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<Action[] | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamError, setTeamError] = useState('');
  const [visible, setVisible] = useState(eager);
  const reducedMotion = useReducedMotion();
  const bodyId = useId();
  const host = useRef<HTMLDivElement>(null);
  const running = turn.status === 'running';
  const now = useNow(running);

  // Load when opened, while running, for the latest turn, or once this turn scrolls into view.
  useEffect(() => {
    if (visible || eager) return;
    const element = host.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '240px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, eager]);
  const wanted = open || running || eager || visible;
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    const load = () => {
      api<Action[]>('actions', { task_id: turn.id })
        .then(value => { if (active) setActions(Array.isArray(value) ? value : []); })
        .catch(reason => { if (active) setActions([{ id: 'activity-error', name: 'Activity unavailable', input: '', output: String(reason), status: 'failed', created_at: new Date().toISOString() }]); });
      if (native && open) api<TeamMember[]>('team_status', { task_id: turn.id })
        .then(value => { if (active) setTeam(Array.isArray(value) ? value : []); })
        .catch(reason => { if (active) setTeamError(String(reason)); });
    };
    load();
    const timer = running ? setInterval(load, 2500) : undefined;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [wanted, open, turn.id, turn.step, turn.status, running]);

  const steps = useMemo(() => (actions ?? []).map(action => summarizeAction(action, nameOf)), [actions, nameOf]);
  const byId = useMemo(() => new Map((actions ?? []).map(action => [action.id, action])), [actions]);
  const items = useMemo(() => groupSteps(steps, running), [steps, running]);
  const failures = steps.filter(step => step.failed).length;

  // Research browser steps, inline while the turn runs: receipts plus steps reported live.
  const research = useMemo(() => running ? researchLines(steps, liveSteps ?? []) : [], [running, steps, liveSteps]);

  // Only real signals: the tool the provider just reported, else the newest recorded step.
  const label = running
    ? (liveActivity ? liveLabel(liveActivity, liveDetail, liveAction) : progressLabel(steps.at(-1)))
    : actions
      ? traceRecap(steps)
      : turn.step ? `${turn.step} ${turn.step === 1 ? 'step' : 'steps'}` : 'Show activity';
  const started = Date.parse(turn.created_at);
  const ended = turn.updated_at ? Date.parse(turn.updated_at) : NaN;
  const duration = running
    ? (Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : NaN)
    : (Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, (ended - started) / 1000) : NaN);
  // Wall-clock time from the question to the saved answer, only for completed turns.
  const prefix = turn.status === 'complete' && Number.isFinite(duration) && actions ? `Took ${workedFor(duration)} · ` : '';
  const text = `${prefix}${running ? `${label}…` : label}`;
  const shown = text.charAt(0).toUpperCase() + text.slice(1);

  return <div className="trace" ref={host} data-running={running || undefined}>
    <button type="button" className={`trace-toggle ${open ? 'open' : ''}`} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <span className="visually-hidden">Activity: </span>
      {running ? <span className="trace-live-dot" aria-hidden="true" /> : null}
      <span className={`trace-label ${running && !reducedMotion ? 'shimmer' : ''}`}>{shown}</span>
      {!running && failures && !label.includes('failed') ? <span className="trace-failures">{failures} failed</span> : null}
      <ChevronRight size={14} className="trace-chevron" aria-hidden="true" />
    </button>
    {research.length && !open ? <ol className="trace-research" aria-label="Research steps" aria-live="polite" aria-relevant="additions">
      {research.map(line => <li key={line.key} className="trace-research-step" data-pending={line.pending || undefined} data-failed={line.failed || undefined}>
        <StepIcon kind={line.kind} />
        <span className="trace-sentence">{line.label}{line.failed ? <span className="trace-result"> · failed</span> : null}</span>
      </li>)}
    </ol> : null}
    <AnimatePresence initial={false}>
      {open ? <motion.div
        key="trace-body"
        id={bodyId}
        className="trace-body"
        initial={reducedMotion ? false : { height: 0, opacity: 0 }}
        animate={reducedMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
        exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
        transition={springs.gentle}
        style={reducedMotion ? undefined : { overflow: 'hidden' }}
      >
        {teamError ? <p className="small danger-text" role="alert">Team status unavailable: {teamError}</p> : null}
        {team.length ? <div className="team-cards">
          <p className="team-note">Agent team · {team.filter(member => member.status === 'complete').length}/{team.length} assignments complete. Separate working contexts — not independent corroboration or human approval.</p>
          {team.map(member => <details className="team-card" key={member.id}>
            <summary>
              <Users size={14} aria-hidden="true" className="team-icon" />
              <strong>{member.role}</strong>
              <span className="team-model">{member.model}</span>
              <StatusPill state={member.status === 'complete' ? 'complete' : member.status === 'failed' ? 'failed' : 'running'} label={member.status.replaceAll('_', ' ')} small />
            </summary>
            <p className="small muted">{member.provider.replaceAll('"', '')} · {member.phase.replaceAll('_', ' ')} · step {member.step}</p>
            {member.error ? <p className="small danger-text" role="alert">{member.error}</p> : null}
            {member.answer ? <Markdown text={member.answer} onSource={onSource} /> : <p className="small muted">No completed proposal yet.</p>}
          </details>)}
        </div> : null}
        <ol className="trace-steps" aria-label="Recorded actions">
          {items.map(item => isGroup(item)
            ? <li key={`group-${item.steps[0].id}`} className="trace-step" data-kind={item.kind}><GroupRow group={item} actions={byId} onSource={onSource} /></li>
            : <li key={item.id} className={`trace-step ${item.failed ? 'is-failed' : ''}`} data-kind={item.kind}>
                <StepRow step={item} action={byId.get(item.id)!} onSource={onSource} />
                {item.failed && item.error ? <p className="trace-error">{item.error}</p> : null}
              </li>)}
          {!actions ? <li className="trace-step trace-placeholder"><span className="trace-icon"><span className="trace-live-dot" aria-hidden="true" /></span>Loading activity…</li> : null}
          {actions && !actions.length ? <li className="trace-step trace-placeholder"><span className="trace-icon"><CircleDot size={14} aria-hidden="true" /></span>{running ? 'No recorded actions yet.' : 'No recorded actions.'}</li> : null}
        </ol>
      </motion.div> : null}
    </AnimatePresence>
  </div>;
}
