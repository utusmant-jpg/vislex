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

/** What the composer currently has selected for context attachment (same shape the
 *  backend viewer_context argument expects). */
export type ViewerSelection = { type: 'source' | 'record'; id: string; locator?: string } | null;
export type ViewerAttachment = { type: 'source' | 'record'; id: string; locator: string | null; time_seconds: number | null } | null;

/** Decide the viewer_context payload for the next message.
 *
 * A visible "do not attach this file" choice suppresses the payload entirely — the
 * backend then records no workspace-view reference for that message. The file itself
 * stays available to the agent through the case's authorized investigation scope;
 * only the per-message attachment is suppressed. Page/playback enrichment is only
 * applied when the live view actually belongs to the selected file. */
export function buildViewerAttachment(
  selection: ViewerSelection,
  view: ViewerContextState,
  skip: boolean,
): ViewerAttachment {
  if (!selection || skip) return null;
  const viewed = view && view.sourceId === selection.id ? view : null;
  return {
    type: selection.type,
    id: selection.id,
    locator: selection.locator ?? (viewed?.page
      ? `page:${viewed.page}`
      : selection.type === 'source' && viewed?.lineStart
        ? `L${viewed.lineStart}`
        : null),
    time_seconds: viewed?.timeSeconds ?? null,
  };
}
