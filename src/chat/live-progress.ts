// Live stream state for one running turn, from the backend's agent-progress
// events. High-frequency deltas are coalesced to one update per animation
// frame, and only events for this case session and task are accepted, so a
// late delta from another case or chat can never change this turn.
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { native } from '../bridge';

/** A research browser step the backend reported while running it (activity plus its detail). */
export type LiveStep = { activity: string; detail: string; at: number };

export type LiveProgress = {
  transmission: string;
  text: string;
  /** Tool name the model most recently requested, as the provider reported it. */
  activity: string;
  /** One-line detail the backend sent with that activity (research tools), or ''. */
  detail: string;
  characters: number;
  /** Research steps reported during this run, oldest first. Kept across transmissions. */
  steps: LiveStep[];
};

export const EMPTY_PROGRESS: LiveProgress = { transmission: '', text: '', activity: '', detail: '', characters: 0, steps: [] };
const MAX_STEPS = 50;

export type ProgressDelta = { text?: string; activity?: string; detail?: string; characters?: number };
export type ProgressEvent = { case_id: string; session_epoch?: number; task_id: string; transmission_id: string; delta: ProgressDelta };

/** Folds one accepted agent-progress delta into the live state. */
export function applyProgress(state: LiveProgress, event: Pick<ProgressEvent, 'transmission_id' | 'delta'>, now = Date.now()): LiveProgress {
  const { delta } = event;
  const current = state.transmission === event.transmission_id ? state : { ...EMPTY_PROGRESS, transmission: event.transmission_id, steps: state.steps };
  const activity = typeof delta.activity === 'string' && delta.activity ? delta.activity : undefined;
  const detail = typeof delta.detail === 'string' ? delta.detail.trim() : undefined;
  // Only a delta that carries a detail is a step the backend is running; the provider's own
  // tool-call deltas name the tool alone, so they never add a step twice.
  const steps = activity && detail !== undefined ? [...current.steps, { activity, detail, at: now }].slice(-MAX_STEPS) : current.steps;
  return {
    ...current,
    text: current.text + (delta.text ?? ''),
    activity: activity ?? current.activity,
    detail: activity ? detail ?? '' : current.detail,
    characters: current.characters + (delta.characters ?? 0),
    steps,
  };
}

export function useLiveProgress(caseId: string | undefined, sessionEpoch: number | undefined, taskId: string, active: boolean): LiveProgress {
  const [live, setLive] = useState<LiveProgress>(EMPTY_PROGRESS);
  const liveRef = useRef(live);
  useEffect(() => {
    if (!native || !active || !caseId) return;
    // Each run starts empty, so a resumed turn never shows the stopped draft as live.
    liveRef.current = EMPTY_PROGRESS;
    setLive(EMPTY_PROGRESS);
    let alive = true;
    let frame = 0;
    let pending: LiveProgress | null = null;
    const cleanup = listen<ProgressEvent>('agent-progress', ({ payload: event }) => {
      if (!alive || event.case_id !== caseId || event.task_id !== taskId || (typeof sessionEpoch === 'number' && event.session_epoch !== sessionEpoch)) return;
      pending = applyProgress(pending ?? liveRef.current, event);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) { liveRef.current = pending; setLive(pending); pending = null; }
      });
    });
    return () => { alive = false; if (frame) cancelAnimationFrame(frame); void cleanup.then(unlisten => unlisten()); };
  }, [caseId, sessionEpoch, taskId, active]);
  return live;
}
