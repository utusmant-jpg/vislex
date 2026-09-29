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

/** research_pane_state: whether the pane exists, its owning case, and the current page's address and host. */
export type ResearchPaneState = { open: boolean; case_id: string | null; host: string | null; secure: boolean | null; url?: string | null };

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

/** The research browser's home page (the toolbar Home button). */
export const RESEARCH_HOME_URL = 'https://1.next.westlaw.com/';

/** research_pane_navigate: opens an http(s) address in the pane as the user; the backend refuses other schemes. */
export function researchPaneNavigate(url: string) {
  return api<null>('research_pane_navigate', { url });
}

/**
 * What the address field opens for the text typed into it, as a browser's omnibox does:
 * an address with a scheme is kept only when it is http or https (otherwise null); a
 * bare host name (anything with a dot, or localhost, with an optional port and path)
 * gets https://; anything else becomes a web search.
 */
export function toAddress(text: string): string | null {
  const input = text.trim();
  if (!input) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    // A bare host with a port ("localhost:3000", "example.com:8080") is not a scheme.
    if (!/^(localhost|[^\s/:]+\.[^\s/:]+):\d+(?:[/?#]|$)/i.test(input)) {
      return /^https?:/i.test(input) ? input : null;
    }
  }
  if (!/\s/.test(input) && (/^localhost(?::\d+)?(?:[/?#]|$)/i.test(input) || /^[^/?#]*\.[^/?#]/.test(input))) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** research_stop: pauses the task researching on the pane (holding the page, or between its
 *  steps) and stops the page loading. `stopped` is false when no research task was running. */
export type ResearchStopResult = { stopped: boolean; task_id: string | null };

export function researchStop(caseId: string, sessionEpoch?: number) {
  return api<ResearchStopResult>('research_stop', caseSessionArgs(caseId, sessionEpoch));
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
