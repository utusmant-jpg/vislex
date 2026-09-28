// Pure state helpers for the assistant surface. The Rust runtime owns every
// turn; these functions only classify what it reported so the chat can show
// an honest status, a stated reason when sending is unavailable, real usage,
// and a single announcement when a live turn settles.
import type { Snapshot, Task } from '../types';
import type { PillState } from '../ui';
import type { SettingsSection } from '../components/SettingsDialog';

/** Pause reasons written by src-tauri (desktop.rs stop_task, agent::pause,
 *  automatic.rs CHAT_PREEMPTION, case.rs startup recovery). */
export const USER_STOP_REASON = 'Stopped by user';
export const COORDINATOR_STOP_REASON = 'Coordinator stopped';
export const CHAT_PREEMPTION_REASON = 'Paused for your chat; automatic analysis will continue afterwards';
export const APP_STOPPED_REASON = 'Application stopped. Review activity before resuming.';

export type TurnKind = 'running' | 'stopped' | 'paused' | 'interrupted' | 'failed' | 'complete' | 'pending';
export type TurnOutcome = { kind: TurnKind; pill: PillState; label: string };

/** Classify a turn. A user Stop is a neutral "Stopped", never a failure. */
export function turnOutcome(turn: Pick<Task, 'status' | 'error'>): TurnOutcome {
  if (turn.status === 'running') return { kind: 'running', pill: 'running', label: 'Working' };
  if (turn.status === 'paused') {
    if (turn.error === USER_STOP_REASON || turn.error === COORDINATOR_STOP_REASON) return { kind: 'stopped', pill: 'stopped', label: 'Stopped' };
    if (!turn.error || turn.error === CHAT_PREEMPTION_REASON) return { kind: 'paused', pill: 'paused', label: 'Paused' };
    if (turn.error === APP_STOPPED_REASON) return { kind: 'interrupted', pill: 'needs-attention', label: 'Interrupted' };
    return { kind: 'paused', pill: 'needs-attention', label: 'Paused' };
  }
  if (turn.error || turn.status === 'failed') return { kind: 'failed', pill: 'failed', label: 'Needs attention' };
  if (turn.status === 'complete') return { kind: 'complete', pill: 'complete', label: 'Saved response' };
  return { kind: 'pending', pill: 'unreviewed', label: 'Pending' };
}

/** One polite announcement when a turn that was running settles. */
export function settledAnnouncement(previousStatus: string | undefined, turn: Pick<Task, 'status' | 'error'>): string | null {
  if (previousStatus !== 'running' || turn.status === 'running') return null;
  const outcome = turnOutcome(turn);
  const reason = needsAttention(turn) ? failureReason(turn.error) : '';
  const withReason = (text: string) => reason ? `${text}: ${reason}` : `${text}.`;
  switch (outcome.kind) {
    case 'complete': return 'Response saved.';
    case 'stopped': return 'Response stopped.';
    case 'paused': return withReason('Response paused');
    case 'interrupted': return withReason('Response interrupted');
    case 'failed': return withReason('Response did not complete');
    default: return null;
  }
}

/** A turn that ended on a problem the user must act on: a failure, an
 *  interruption, or a pause for a reason other than a stop or chat preemption. */
export function needsAttention(turn: Pick<Task, 'status' | 'error'>): boolean {
  const outcome = turnOutcome(turn);
  return outcome.kind === 'failed' || outcome.kind === 'interrupted' || (outcome.kind === 'paused' && outcome.pill === 'needs-attention');
}

/** The reason as the backend wrote it, reduced to its first line so it can be
 *  shown and announced inline; the full text stays behind a disclosure. */
export function failureReason(error: string): string {
  const line = error.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

export type { SettingsSection };
/** Which settings the AI controls are edited for: app defaults, or this case. */
export type SettingsScope = 'app' | 'case';

/** The clicks that reach a section. "Open settings" lands on exactly this
 *  section and scope, and the text names the same place so it can be found
 *  again without the button. */
export function settingsPath(section: SettingsSection, scope?: SettingsScope): string {
  return `Settings → ${section}${scope === 'case' ? ' → This case' : ''}`;
}
export type ComposerBlock = { reason: 'desktop' | 'offline' | 'text-grant' | 'access-route' | 'subscription-model' | 'no-model' | 'preparing'; message: string; section?: SettingsSection; scope?: SettingsScope };

/** Why the composer cannot send right now, stated plainly and pointing at the
 *  settings section that changes it. Model availability is never treated as
 *  case authorization: the case text grant is checked on its own. */
export function composerBlock({ native, snapshot, accessKnown, subscriptionActive, modelReady, preparing }: {
  native: boolean; snapshot: Pick<Snapshot, 'settings'> | null; accessKnown: boolean; subscriptionActive: boolean; modelReady: boolean; preparing: boolean;
}): ComposerBlock | null {
  if (!snapshot) return null;
  if (!native) return { reason: 'desktop', message: 'AI chat runs in the VisLex desktop app. This preview cannot send messages.' };
  if (snapshot.settings.offline) return { reason: 'offline', message: 'Offline mode is on, so no AI requests are sent for this case.', section: 'Privacy & offline', scope: 'case' };
  if (!snapshot.settings.allow_text) return { reason: 'text-grant', message: 'This case does not permit sending case text to AI.', section: 'Case permissions', scope: 'case' };
  // These are read from the open case, so the link opens the case's own
  // settings: editing app settings would not change a case with an override,
  // and would change every case that inherits them.
  if (!accessKnown) return { reason: 'access-route', message: 'The AI access route for this case could not be read.', section: 'Accounts & models', scope: 'case' };
  if (!modelReady) return subscriptionActive
    ? { reason: 'subscription-model', message: 'Choose a ChatGPT subscription model and effort before sending.', section: 'Accounts & models', scope: 'case' }
    : { reason: 'no-model', message: 'No configured model is permitted to receive case text.', section: 'Accounts & models', scope: 'case' };
  if (preparing) return { reason: 'preparing', message: 'Preparing case files before chat is available.' };
  return null;
}

export type Usage = { input: number; output: number; total: number; reportedTurns: number; cost: number | null; costPartial: boolean };

/** Sum only what providers reported; turns with no reported usage add nothing.
 *  Cost is null when no provider reported one, and marked partial when some
 *  requests reported none, so an unknown cost is never shown as zero. */
export function usageOf(turns: Pick<Task, 'input_tokens' | 'output_tokens' | 'cost' | 'cost_partial'>[]): Usage {
  let input = 0, output = 0, reportedTurns = 0, cost: number | null = null, costPartial = false;
  for (const turn of turns) {
    const turnInput = Number.isFinite(turn.input_tokens) ? turn.input_tokens : 0;
    const turnOutput = Number.isFinite(turn.output_tokens) ? turn.output_tokens : 0;
    if (turnInput + turnOutput > 0) reportedTurns += 1;
    input += turnInput; output += turnOutput;
    const turnCost = typeof turn.cost === 'number' && Number.isFinite(turn.cost) ? turn.cost : null;
    if (turnCost !== null) cost = (cost ?? 0) + turnCost;
    if (turn.cost_partial || (turnCost === null && turnInput + turnOutput > 0)) costPartial = true;
  }
  return { input, output, total: input + output, reportedTurns, cost, costPartial };
}

/** Provider-reported cost as text; null when nothing was reported. */
export function costLabel(cost: number | null | undefined, partial = false): string | null {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  const amount = cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
  return partial ? `${amount}+ reported (some requests reported no cost)` : `${amount} reported`;
}
