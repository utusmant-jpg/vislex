// Small pub/sub for "what is the viewer looking at" so the composer can attach precise
// page/playback context without scraping the DOM. EvidenceViewer publishes; AgentPanel reads.
export type ViewerContextState = { sourceId: string; page?: number; timeSeconds?: number | null; lineStart?: number } | null;

let state: ViewerContextState = null;
const listeners = new Set<() => void>();

export function setViewerContext(next: ViewerContextState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getViewerContext() { return state; }

export function subscribeViewerContext(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
