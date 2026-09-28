// Live stream state for one running turn, from the backend's agent-progress
// events. High-frequency deltas are coalesced to one update per animation
// frame, and only events for this case session and task are accepted, so a
// late delta from another case or chat can never change this turn.
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { native } from '../bridge';

export type LiveProgress = {
  transmission: string;
  text: string;
  /** Tool name the model most recently requested, as the provider reported it. */
  activity: string;
  characters: number;
};

const EMPTY: LiveProgress = { transmission: '', text: '', activity: '', characters: 0 };

type ProgressEvent = { case_id: string; session_epoch?: number; task_id: string; transmission_id: string; delta: { text?: string; activity?: string; characters?: number } };

export function useLiveProgress(caseId: string | undefined, sessionEpoch: number | undefined, taskId: string, active: boolean): LiveProgress {
  const [live, setLive] = useState<LiveProgress>(EMPTY);
  const liveRef = useRef(live);
  useEffect(() => {
    if (!native || !active || !caseId) return;
    let alive = true;
    let frame = 0;
    let pending: LiveProgress | null = null;
    const cleanup = listen<ProgressEvent>('agent-progress', ({ payload: event }) => {
      if (!alive || event.case_id !== caseId || event.task_id !== taskId || (typeof sessionEpoch === 'number' && event.session_epoch !== sessionEpoch)) return;
      const base = pending ?? liveRef.current;
      const current = base.transmission === event.transmission_id ? base : { ...EMPTY, transmission: event.transmission_id };
      pending = {
        ...current,
        text: current.text + (event.delta.text ?? ''),
        activity: event.delta.activity ?? current.activity,
        characters: current.characters + (event.delta.characters ?? 0),
      };
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) { liveRef.current = pending; setLive(pending); pending = null; }
      });
    });
    return () => { alive = false; if (frame) cancelAnimationFrame(frame); void cleanup.then(unlisten => unlisten()); };
  }, [caseId, sessionEpoch, taskId, active]);
  return live;
}
