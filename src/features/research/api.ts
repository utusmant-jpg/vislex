// Typed wrappers over the research browser commands in src-tauri/src/desktop.rs
// (research_pane_command and the research_grant / set_research_grant arms).
import { api } from '../../bridge';
import { caseSessionArgs } from '../../caseSession';

/** src-tauri/src/research/mod.rs `Grant`. */
export type ResearchGrant = {
  enabled: boolean;
  revision: number;
  changed_at: string;
  destination: string;
  sso_hosts: string[];
  caps: Record<string, unknown>;
  routes: string[];
  approval_mode: string;
};

/** research_pane_state: whether the pane exists, its owning case, and the current page's host. */
export type ResearchPaneState = { open: boolean; case_id: string | null; host: string | null; secure: boolean | null };

/** Logical pixels of the main window; CSS pixels of the main webview map 1:1. */
export type PaneRect = { x: number; y: number; width: number; height: number };

/** Fired on window after the grant changes here, so every mounted view reloads it. */
export const RESEARCH_GRANT_CHANGED = 'vislex:research-grant-changed';

export const errorText = (error: unknown) => String(error).replace(/^Error:\s*/, '');

export function researchGrant(caseId: string, sessionEpoch?: number) {
  return api<ResearchGrant | null>('research_grant', caseSessionArgs(caseId, sessionEpoch));
}

/** Omit `ssoHosts` to keep the case's existing sign-in hosts (a toggle-only change). */
export async function setResearchGrant(caseId: string, sessionEpoch: number | undefined, enabled: boolean, ssoHosts?: string[]) {
  const grant = await api<ResearchGrant>('set_research_grant', { ...caseSessionArgs(caseId, sessionEpoch), enabled, ...(ssoHosts ? { sso_hosts: ssoHosts } : {}) });
  window.dispatchEvent(new CustomEvent(RESEARCH_GRANT_CHANGED, { detail: { caseId, grant } }));
  return grant;
}

export function openResearchPane(caseId: string, sessionEpoch: number | undefined, rect: PaneRect) {
  return api<{ open: boolean }>('open_research_pane', { ...caseSessionArgs(caseId, sessionEpoch), rect });
}

export function layoutResearchPane(rect: PaneRect, visible: boolean) {
  return api<null>('research_pane_layout', { rect, visible });
}

/** Toolbar history buttons; the navigation still passes the pane's allowlist. */
export function researchPaneHistory(action: 'back' | 'forward' | 'reload') {
  return api<null>('research_pane_history', { action });
}

/** research_stop: pauses the task holding the research page and stops the page loading. */
export type ResearchStopResult = { stopped: boolean; task_id: string | null };

export function researchStop() {
  return api<ResearchStopResult>('research_stop');
}

export function researchPaneState() {
  return api<ResearchPaneState>('research_pane_state');
}

export function closeResearchPane() {
  return api<null>('close_research_pane');
}

/** Signs out everywhere by deleting the research browser profile; closes the pane first. */
export function clearResearchSession() {
  return api<null>('clear_research_session');
}

export function rectOf(element: Element): PaneRect {
  const box = element.getBoundingClientRect();
  return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
}
