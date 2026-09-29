// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { notify } from '../../ui';
import BrowserPane from './BrowserPane';
import BrowserView, { BROWSER_WIDTH_KEY } from './BrowserView';
import ResearchSettings from './ResearchSettings';
import ResearchCiteCheck, { CITE_CHECKS, citeCheckNote } from './ResearchCiteCheck';
import SettingsDialog from '../../components/SettingsDialog';
import EvidenceNotebook from '../../components/EvidenceNotebook';
import type { Snapshot } from '../../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../bridge', async () => ({ ...await vi.importActual<typeof import('../../bridge')>('../../bridge'), api, native: true }));
vi.mock('../../ui', async importOriginal => ({ ...(await importOriginal<typeof import('../../ui')>()), useTheme: () => ({ theme: 'dark', setTheme: vi.fn(), density: 'comfortable', setDensity: vi.fn() }) }));

const snapshot: Snapshot = {
  id: 'synthetic-case', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, session_epoch: 4,
  sources: [], records: [], tasks: [],
  ai_config: { provider: 'openai', execution: 'single', review: 'standard', pool: [] },
  settings: { offline: false, allow_text: true, allow_images: false, model: 'synthetic-model' },
};
const grant = (enabled: boolean, sso_hosts: string[] = []) => ({ enabled, revision: 1, changed_at: '2026-09-28T00:00:00Z', destination: 'westlaw', sso_hosts, caps: {}, routes: ['api_keys'], approval_mode: 'autonomous' });

/** A small synthetic research backend: one grant for the case and one pane. */
function backend(initial: ReturnType<typeof grant> | null) {
  const state = { grant: initial, open: false };
  api.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
    switch (action) {
      case 'research_grant': return state.grant;
      case 'set_research_grant': state.grant = grant(Boolean(args.enabled), (args.sso_hosts as string[] | undefined) ?? state.grant?.sso_hosts ?? []); return state.grant;
      case 'open_research_pane': state.open = true; return { open: true };
      case 'research_pane_state': return state.open ? { open: true, case_id: 'synthetic-case', host: 'next.westlaw.com', secure: true } : { open: false, case_id: null, host: null, secure: null };
      case 'close_research_pane': case 'clear_research_session': state.open = false; return null;
      case 'research_pane_layout': case 'research_pane_history': return null;
      case 'app_ai_settings': return { configured: true, config: snapshot.ai_config, settings: snapshot.settings };
      case 'case_ai_scope': return { scope: 'app' };
      case 'provider_key_status': return { configured: true };
      case 'ai_access_route': return { route: 'api_keys', account_ready: false, subscription_ready: false, blocker: 'Synthetic' };
      default: return null;
    }
  });
  return state;
}

let slotRect = { left: 420, top: 64, width: 600, height: 700 };
let observers: (() => void)[] = [];
beforeEach(() => {
  api.mockReset();
  observers = [];
  slotRect = { left: 420, top: 64, width: 600, height: 700 };
  try { localStorage.clear(); } catch { /* not needed */ }
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal('ResizeObserver', class { private callback: () => void; constructor(callback: () => void) { this.callback = callback; } observe() { observers.push(this.callback); } unobserve() {} disconnect() { observers = observers.filter(item => item !== this.callback); } });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const box = this.classList.contains('research-slot') ? slotRect : this.classList.contains('research-split') ? { left: 0, top: 0, width: 1400, height: 800 } : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.querySelectorAll('dialog').forEach(dialog => dialog.remove()); });

const layouts = () => api.mock.calls.filter(([action]) => action === 'research_pane_layout').map(([, args]) => args as { rect: Record<string, number>; visible: boolean });

it('opens the pane over the slot, follows resizes, and hides it on unmount', async () => {
  backend(grant(true));
  const view = render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('open_research_pane', { case_id: 'synthetic-case', session_epoch: 4, rect: { x: 420, y: 64, width: 600, height: 700 } }));
  expect(screen.getByRole('region', { name: 'Research browser' })).toBeTruthy();
  await waitFor(() => expect(layouts()).toContainEqual({ rect: { x: 420, y: 64, width: 600, height: 700 }, visible: true }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe('next.westlaw.com'));
  expect(screen.getByRole('img', { name: 'Secure connection' })).toBeTruthy();
  expect(screen.getByText('Connected')).toBeTruthy();

  // The slot moved and grew: the new logical rect is sent.
  slotRect = { left: 380, top: 64, width: 640, height: 720 };
  act(() => observers.forEach(callback => callback()));
  await waitFor(() => expect(layouts().at(-1)).toEqual({ rect: { x: 380, y: 64, width: 640, height: 720 }, visible: true }));
  // Window resize alone also re-sends the placement.
  slotRect = { left: 380, top: 64, width: 700, height: 720 };
  act(() => { window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(layouts().at(-1)).toEqual({ rect: { x: 380, y: 64, width: 700, height: 720 }, visible: true }));

  view.unmount();
  expect(layouts().at(-1)).toEqual({ rect: { x: 380, y: 64, width: 700, height: 720 }, visible: false });
});

it('shows the pane again when the view returns while the pane is still open', async () => {
  backend(grant(true));
  const first = render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(layouts().at(-1)?.visible).toBe(true));
  first.unmount();
  expect(layouts().at(-1)?.visible).toBe(false);
  const opens = api.mock.calls.filter(([action]) => action === 'open_research_pane').length;
  // As in the app, the grant (a case read) can answer after the pane state (an app-level read).
  const answer = api.getMockImplementation()!;
  api.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
    if (action === 'research_grant') await new Promise(resolve => setTimeout(resolve, 80));
    return answer(action, args);
  });
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(layouts().at(-1)).toEqual({ rect: { x: 420, y: 64, width: 600, height: 700 }, visible: true }));
  // The open pane is placed again, not reopened.
  expect(api.mock.calls.filter(([action]) => action === 'open_research_pane').length).toBe(opens);
});

it('offers back, forward and reload once the pane is open', async () => {
  backend(grant(true));
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  const history = await screen.findByRole('group', { name: 'Page history' });
  for (const [name, action] of [['Back', 'back'], ['Forward', 'forward'], ['Reload', 'reload']] as const) {
    fireEvent.click(within(history).getByRole('button', { name }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('research_pane_history', { action }));
  }
});

it('hides the pane while a modal dialog is open and shows it again afterwards', async () => {
  backend(grant(true));
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(layouts().at(-1)?.visible).toBe(true));
  const dialog = document.createElement('dialog');
  document.body.append(dialog);
  dialog.setAttribute('open', '');
  await waitFor(() => expect(layouts().at(-1)?.visible).toBe(false));
  dialog.remove();
  await waitFor(() => expect(layouts().at(-1)?.visible).toBe(true));
});

it('turns the research browser on from the empty state, then opens it', async () => {
  backend(null);
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on for this case' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('set_research_grant', { case_id: 'synthetic-case', session_epoch: 4, enabled: true }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('open_research_pane', expect.objectContaining({ case_id: 'synthetic-case', session_epoch: 4 })));
});

it('reports a refused switch through the notification helper', async () => {
  backend(null);
  api.mockImplementation(async (action: string) => { if (action === 'set_research_grant') throw 'Turn off offline mode before enabling the research browser'; return action === 'research_pane_state' ? { open: false, case_id: null, host: null, secure: null } : null; });
  const spy = vi.spyOn(notify, 'fromError');
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on for this case' }));
  await waitFor(() => expect(spy).toHaveBeenCalledWith('Could not turn on the research browser', 'Turn off offline mode before enabling the research browser'));
  expect(api).not.toHaveBeenCalledWith('open_research_pane', expect.anything());
});

it('points an offline case to Settings instead of opening the pane', async () => {
  backend(grant(true));
  const onOpenSettings = vi.fn();
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} offline onOpenSettings={onOpenSettings} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Settings' }));
  expect(onOpenSettings).toHaveBeenCalledWith('Privacy & offline');
  expect(screen.getByText('The research browser needs the case online.')).toBeTruthy();
  expect(api).not.toHaveBeenCalledWith('open_research_pane', expect.anything());
});

it('closes and signs out from the toolbar', async () => {
  const state = backend(grant(true));
  render(<BrowserPane caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('close_research_pane'));
  expect(state.open).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  await waitFor(() => expect(state.open).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('clear_research_session'));
  await screen.findByText('The research browser is closed.');
});

it('splits chat and browser with a keyboard-resizable, remembered divider', async () => {
  backend(grant(true));
  render(<BrowserView chat={<div>Synthetic chat column</div>} caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  expect(screen.getByText('Synthetic chat column')).toBeTruthy();
  const divider = screen.getByRole('separator', { name: 'Resize research browser' });
  expect(divider.getAttribute('aria-valuenow')).toBe('640');
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider.getAttribute('aria-valuenow')).toBe('656');
  fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
  expect(divider.getAttribute('aria-valuenow')).toBe('592');
  fireEvent.keyDown(divider, { key: 'Home' });
  expect(divider.getAttribute('aria-valuenow')).toBe('360');
  expect(localStorage.getItem(BROWSER_WIDTH_KEY)).toBe('360');
  fireEvent.keyDown(divider, { key: 'End' });
  expect(divider.getAttribute('aria-valuenow')).toBe(String(1400 - 340));
});

it('keeps working when browser storage is unavailable', () => {
  backend(grant(false));
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  render(<BrowserView chat={<div>Chat</div>} caseId="synthetic-case" sessionEpoch={4} onOpenSettings={vi.fn()} />);
  const divider = screen.getByRole('separator', { name: 'Resize research browser' });
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider.getAttribute('aria-valuenow')).toBe('656');
});

it('Settings → Research browser switches the case, edits sign-in hosts and signs out', async () => {
  backend(grant(false));
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Research browser' }));
  expect(screen.getByRole('heading', { level: 2, name: 'Research browser' })).toBeTruthy();
  const toggle = await screen.findByRole('switch', { name: 'Research browser for this case' });
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  await waitFor(() => expect(api).toHaveBeenCalledWith('set_research_grant', { case_id: 'synthetic-case', session_epoch: 4, enabled: true }));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));

  fireEvent.change(screen.getByRole('textbox', { name: 'Sign-in host' }), { target: { value: 'login.firm.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('set_research_grant', { case_id: 'synthetic-case', session_epoch: 4, enabled: true, sso_hosts: ['login.firm.example'] }));
  expect(await screen.findByText('login.firm.example')).toBeTruthy();

  // The backend's validation message is shown next to the field.
  const prior = api.getMockImplementation()!;
  api.mockImplementation(async (action: string, args?: Record<string, unknown>) => { if (action === 'set_research_grant') throw 'Invalid sign-in host "bad host"; enter a host name such as login.firm.example'; return prior(action, args); });
  fireEvent.change(screen.getByRole('textbox', { name: 'Sign-in host' }), { target: { value: 'bad host' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Invalid sign-in host "bad host"');
  expect(screen.getByRole('textbox', { name: 'Sign-in host' }).getAttribute('aria-invalid')).toBe('true');
  api.mockImplementation(prior);

  fireEvent.click(screen.getByRole('button', { name: 'Remove login.firm.example' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('set_research_grant', { case_id: 'synthetic-case', session_epoch: 4, enabled: true, sso_hosts: [] }));

  fireEvent.click(screen.getByRole('button', { name: 'Sign out and clear research session' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('clear_research_session'));
  expect(await screen.findByText(/Signed out\./)).toBeTruthy();
});

it('disables the case switch with a reason when no case is open or the case is offline', async () => {
  backend(grant(false));
  const { unmount } = render(<ResearchSettings snapshot={null} />);
  expect((screen.getByRole('switch', { name: 'Research browser for this case' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Open a case to change this setting.')).toBeTruthy();
  unmount();
  render(<ResearchSettings snapshot={{ ...snapshot, settings: { ...snapshot.settings, offline: true } }} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('research_grant', { case_id: 'synthetic-case', session_epoch: 4 }));
  expect((screen.getByRole('switch', { name: 'Research browser for this case' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/This case is offline/)).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Sign-in host' }) as HTMLInputElement).disabled).toBe(true);
});

const authority = (extra: Record<string, unknown> = {}) => ({
  id: 'authority-1', revision: 2, kind: 'authority', title: 'Synthetic v. Example (SYNTHETIC)', source_ids: [], locators: [], review: 'unreviewed', stale: false,
  actor: 'research_browser_adapter', start_seconds: null, end_seconds: null,
  content: JSON.stringify({ url: 'https://next.westlaw.com/Document/SYNTHETIC', title: 'Synthetic v. Example', citation: { raw: '1 F.4th 2', claimed: '1 F.4th 3', mismatch: true }, quote: { exact: 'Synthetic quoted words.', locator: 'line 4' }, proposition: 'A synthetic proposition.', treatment_status: 'not_checked', proposition_support: 'unassessed' }),
  ...extra,
});

it('cite-check keeps Accept disabled until all four checks are ticked, then records them', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [authority()], next_offset: null } : null);
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.click(await screen.findByText('Synthetic v. Example (SYNTHETIC)'));
  expect(screen.getByText('Citation mismatch.')).toBeTruthy();
  expect(screen.getByText(/Cited as “1 F\.4th 3”; the page shows “1 F\.4th 2”/)).toBeTruthy();
  const accept = screen.getByRole('button', { name: 'Accept revision' }) as HTMLButtonElement;
  expect(accept.disabled).toBe(true);
  for (const [index, check] of CITE_CHECKS.entries()) {
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: check.label }));
    expect(accept.disabled).toBe(index < CITE_CHECKS.length - 1);
  }
  // Unticking one disables it again.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Citator status checked' }));
  expect(accept.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Citator status checked' }));
  fireEvent.click(accept);
  await waitFor(() => expect(api).toHaveBeenCalledWith('evidence_review', {
    case_id: 'synthetic-case', session_epoch: 4, id: 'authority-1', revision: 2, review: 'accepted',
    note: citeCheckNote(), checks: ['exists', 'quote', 'citator', 'support'],
  }));
  expect(citeCheckNote()).toBe('Cite-check completed: exists at the cited page; quote matches the opinion text; citator status checked; supports the proposition.');
  // Reject and clear stay available; there is exactly one Accept control for this authority.
  expect(screen.getAllByRole('button', { name: 'Accept revision' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Reject revision' })).toBeTruthy();
});

it('leaves other authorities with the ordinary review controls', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [authority({ id: 'public-1', actor: 'human', title: 'Public authority' })], next_offset: null } : null);
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.click(await screen.findByText('Public authority'));
  expect(screen.queryByRole('checkbox', { name: 'Exists at the cited page' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('evidence_review', { case_id: 'synthetic-case', session_epoch: 4, id: 'public-1', revision: 2, review: 'accepted' }));
});

const FORBIDDEN = /warning|consent|acknowledg|terms|risk/i;
function visibleText(root: HTMLElement) {
  const attributes = [...root.querySelectorAll('*')].flatMap(element => ['aria-label', 'title', 'placeholder', 'alt'].map(name => element.getAttribute(name) ?? ''));
  return `${root.textContent ?? ''} ${attributes.join(' ')}`;
}

it('shows no warning, consent or acknowledgement language in any research state', async () => {
  const texts: string[] = [];
  for (const [initial, offline] of [[null, false], [grant(true), false], [grant(true), true]] as const) {
    backend(initial);
    const view = render(<BrowserView chat={<div />} caseId="synthetic-case" sessionEpoch={4} offline={offline} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('research_pane_state'));
    if (initial?.enabled && !offline) await screen.findByText('Connected');
    texts.push(visibleText(view.container));
    view.unmount();
  }
  backend(grant(true, ['login.firm.example']));
  const settings = render(<ResearchSettings snapshot={snapshot} />);
  await screen.findByText('login.firm.example');
  texts.push(visibleText(settings.container));
  settings.unmount();
  const offlineSettings = render(<ResearchSettings snapshot={{ ...snapshot, settings: { ...snapshot.settings, offline: true } }} />);
  texts.push(visibleText(offlineSettings.container));
  offlineSettings.unmount();
  const check = render(<ResearchCiteCheck object={authority()} onAccept={vi.fn()} />);
  texts.push(visibleText(check.container));
  for (const text of texts) expect(text).not.toMatch(FORBIDDEN);
});
