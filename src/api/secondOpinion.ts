// Typed wrappers for the optional second opinion on uncertain audio. The Rust
// backend (src-tauri/src/escalation.rs) owns every rule; these only name the
// actions and their shapes.
import { api } from '../bridge';

export type Vendor = 'openrouter' | 'openai';
export type Reason = { code: string; detail: string; strength: number };
export type Candidate = { track: number; start: number; end: number; ordinals: number[]; risk: number; reasons: Reason[] };
export type Triage = { source_id: string; run_id: string; segments: number; flagged_segments: number; threshold: number; candidates: Candidate[]; note: string };
export type Grant = { vendor: Vendor; model: string; revision: number; granted_at: string };
export type SecondOpinion = {
  id: string; source_id: string; run_id: string; ordinals: number[]; track: number; start: number; end: number;
  vendor: Vendor; model: string; grant_revision: number;
  status: 'clipping' | 'previewed' | 'sending' | 'received' | 'failed' | 'cancelled' | 'uncertain';
  clip_artifact_id: string | null; reasons: Reason[];
  result: { segments: { ordinal: number; text: string }[]; notes: string; raw: string | null; label: string } | null;
  usage: { input_tokens?: number; output_tokens?: number; cost?: number | null; upstream_provider?: string | null } | null;
  error: string; decision: 'accepted_remote' | 'kept_local' | 'edited' | 'unresolved' | null; label: string;
};
export type Preview = { second_opinion: SecondOpinion; recipient: string; sends: string; disclosure: string; estimate: { audio_seconds: number; note: string }; clip_bytes?: number };
type Guard = { case_id: string; session_epoch?: number };

export const secondOpinionGrant = () => api<{ grant: Grant | null; vendors: Vendor[]; note: string }>('second_opinion_grant');
export const setSecondOpinionGrant = (guard: Guard, choice: { vendor: Vendor; model: string } | null) =>
  api<{ grant: Grant | null }>('set_second_opinion_grant', choice ? { ...guard, ...choice } : { ...guard, revoke: true });
export const secondOpinionCandidates = (guard: Guard, source_id: string, run_id: string) =>
  api<Triage>('second_opinion_candidates', { ...guard, source_id, run_id });
export const prepareSecondOpinion = (guard: Guard, source_id: string, run_id: string, clip: Pick<Candidate, 'track' | 'start' | 'end' | 'ordinals'>) =>
  api<Preview>('prepare_second_opinion', { ...guard, source_id, run_id, clip });
export const sendSecondOpinion = (guard: Guard, id: string) => api<SecondOpinion>('send_second_opinion', { ...guard, id });
export const cancelSecondOpinion = (guard: Guard, id: string) => api<{ cancel_requested: boolean }>('cancel_second_opinion', { ...guard, id });
export const decideSecondOpinion = (guard: Guard, id: string, decision: NonNullable<SecondOpinion['decision']>, edits: { ordinal: number; text: string }[] = []) =>
  api<{ second_opinion: SecondOpinion; corrections: { ordinal: number; correction: string }[] }>('decide_second_opinion', { ...guard, id, decision, edits });
export const listSecondOpinions = (source_id: string) => api<SecondOpinion[]>('list_second_opinions', { source_id });

export function formatSpan(start: number, end: number): string {
  const clock = (value: number) => { const s = Math.max(0, value); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
  return `${clock(start)}–${clock(end)}`;
}
