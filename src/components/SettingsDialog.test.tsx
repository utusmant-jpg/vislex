// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsDialog from './SettingsDialog';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, native: true }));
vi.mock('../ui', async importOriginal => ({ ...(await importOriginal<typeof import('../ui')>()), useTheme: () => ({ theme: 'dark', setTheme: vi.fn(), density: 'comfortable', setDensity: vi.fn() }) }));

const snapshot: Snapshot = {
  id: 'synthetic-case', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, session_epoch: 8,
  sources: [], records: [], tasks: [],
  ai_config: { provider: 'openai', execution: 'single', review: 'challenge', pool: [] },
  settings: { offline: false, allow_text: true, allow_images: true, model: 'saved-model' },
};

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (action: string) => action === 'app_ai_settings' ? { configured: true, config: snapshot.ai_config, settings: snapshot.settings } : action === 'case_ai_scope' ? { scope: 'case' } : action === 'case_ai_access_route' ? { override: 'app', effective: 'api_keys' } : action === 'direct_media_permission' ? { enabled: false } : action === 'provider_key_status' ? { configured: true } : action === 'ai_access_route' ? { route: 'api_keys', account_ready: false, subscription_ready: false, blocker: 'Tool bridge unverified' } : undefined);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
});
afterEach(cleanup);

it('shows the isolated subscription route as unavailable until case execution is verified', async () => {
  api.mockImplementation(async (action: string) => action === 'ai_access_route'
    ? { route: 'api_keys', subscription: null, account_ready: false, subscription_ready: false, blocker: 'Tool bridge unverified' }
    : action === 'codex_account_status' ? { connected: false }
    : action === 'app_ai_settings' ? { configured: true, config: snapshot.ai_config, settings: snapshot.settings }
    : action === 'case_ai_scope' ? { scope: 'case' }
    : action === 'provider_key_status' ? { configured: true }
    : undefined);
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  const button = await screen.findByRole('button', { name: 'ChatGPT subscription' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
  expect(screen.getByText(/Tool bridge unverified/)).toBeTruthy();
  fireEvent.click(button);
  expect(api).not.toHaveBeenCalledWith('set_ai_access_route', { route: 'chatgpt_subscription' });
});

it('shows a device code and allows cancellation without changing API keys', async () => {
  const prior = api.getMockImplementation()!;
  api.mockImplementation(async (action: string, args?: unknown) => {
    if (action === 'ai_access_route') return { route: 'api_keys', account_ready: true, subscription_ready: false, blocker: 'Tool bridge unverified' };
    if (action === 'codex_account_status') return { connected: false };
    if (action === 'codex_account_login') return { login_id: 'synthetic-login', auth_url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH' };
    return prior(action, args);
  });
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
  expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('codex_account_cancel_login', { login_id: 'synthetic-login' }));
  expect(api).not.toHaveBeenCalledWith('save_provider_key', expect.anything());
});

it('applies a case subscription override without changing the app route', async () => {
  const prior = api.getMockImplementation()!;
  api.mockImplementation(async (action: string, args?: unknown) => {
    if (action === 'ai_access_route') return { route: 'api_keys', account_ready: true, subscription_ready: true, blocker: '' };
    if (action === 'codex_account_status') return { connected: true, email: 'synthetic@example.test' };
    if (action === 'set_case_ai_access_route') return { override: 'chatgpt_subscription', effective: 'chatgpt_subscription' };
    return prior(action, args);
  });
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'This case · customized' }));
  fireEvent.click(await screen.findByRole('button', { name: 'ChatGPT subscription' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('set_case_ai_access_route', { case_id: 'synthetic-case', session_epoch: 8, route: 'chatgpt_subscription' }));
  expect(api).not.toHaveBeenCalledWith('set_ai_access_route', expect.anything());
  expect(await screen.findByText('Effective route for this case: ChatGPT subscription.')).toBeTruthy();
});

it('saves a case model without replacing the app subscription model', async () => {
  const prior = api.getMockImplementation()!;
  api.mockImplementation(async (action: string, args?: unknown) => {
    if (action === 'ai_access_route') return { route: 'chatgpt_subscription', subscription: { model: 'app-model', effort: 'high' }, account_ready: true, subscription_ready: true, blocker: '' };
    if (action === 'case_ai_access_route') return { override: 'app', effective: 'chatgpt_subscription', selection_override: false, selection: { model: 'app-model', effort: 'high' } };
    if (action === 'codex_account_status') return { connected: true };
    if (action === 'codex_account_models') return [{ id: 'app-model', name: 'App model', efforts: ['high'], default_effort: 'high' }, { id: 'case-model', name: 'Case model', efforts: ['medium'], default_effort: 'medium' }];
    if (action === 'save_case_codex_selection') return { selection_override: true, selection: { model: 'case-model', effort: 'medium' } };
    return prior(action, args);
  });
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'This case · customized' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Load subscription models' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'ChatGPT subscription model' }), { target: { value: 'case-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save case model' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('save_case_codex_selection', { case_id: 'synthetic-case', session_epoch: 8, model: 'case-model', effort: 'medium' }));
  expect(api).not.toHaveBeenCalledWith('save_codex_selection', expect.anything());
});

it('shows a completed device-code failure instead of polling silently forever', async () => {
  const prior = api.getMockImplementation()!;
  api.mockImplementation(async (action: string, args?: unknown) => {
    if (action === 'ai_access_route') return { route: 'api_keys', account_ready: true, subscription_ready: true, blocker: '' };
    if (action === 'codex_account_status') return { connected: false, login: { state: 'failed', error: 'Authorization was denied', expires_in_seconds: 0 } };
    if (action === 'codex_account_login') return { login_id: 'synthetic-login', auth_url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH' };
    return prior(action, args);
  });
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Authorization was denied');
});

it('saves app AI permissions independently of a case', async () => {
  const refresh = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(<SettingsDialog snapshot={null} refresh={refresh} onClose={onClose} run={fn => { void fn(); }} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI permissions' }));
  await screen.findByRole('checkbox', { name: 'Inherited case text may be sent to permitted models' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Inherited case images may be sent to permitted models' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save app AI settings' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith('save_app_ai_settings', {
    config: { provider: 'openai', execution: 'single', review: 'challenge', pool: [] },
    settings: { offline: false, allow_text: true, allow_images: false, model: 'saved-model' },
  });
});

it('saves case-specific permissions without changing app settings', async () => {
  const refresh = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(<SettingsDialog snapshot={snapshot} refresh={refresh} onClose={onClose} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'This case · customized' }));
  fireEvent.click(screen.getByRole('button', { name: 'AI permissions' }));
  await screen.findByText('Permitted — original audio/video may be sent');
  expect(screen.queryByText(/Case budget|tokens|\$\/M/i)).toBeNull();
  fireEvent.click(screen.getByText('Offline — stop new requests'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Case text may be sent to permitted models' }));
  fireEvent.click(screen.getByText('Permitted — original audio/video may be sent'));
  fireEvent.click(screen.getByRole('button', { name: 'Save case AI override' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith('save_ai_settings', {
    case_id: 'synthetic-case',
    session_epoch: 8,
    config: { provider: 'openai', execution: 'single', review: 'challenge', pool: [] },
    settings: { offline: true, allow_text: false, allow_images: false, model: 'saved-model' },
  });
  expect(api).toHaveBeenCalledWith('set_direct_media_permission', { case_id: 'synthetic-case', session_epoch: 8, enabled: true });
});

it('keeps case settings visible when app defaults finish loading after scope selection', async () => {
  let finishAppLoad!: (value: unknown) => void;
  const appLoad = new Promise(resolve => { finishAppLoad = resolve; });
  api.mockImplementation(async (action: string) => action === 'app_ai_settings' ? appLoad : action === 'case_ai_scope' ? { scope: 'case' } : action === 'direct_media_permission' ? { enabled: false } : action === 'provider_key_status' ? { configured: true } : undefined);
  render(<SettingsDialog snapshot={snapshot} refresh={async () => undefined} onClose={vi.fn()} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'This case · customized' }));
  fireEvent.click(screen.getByRole('button', { name: 'AI permissions' }));
  finishAppLoad({ configured: true, config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [] }, settings: { offline: true, allow_text: false, allow_images: false, model: '' } });
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Case text may be sent to permitted models' }) as HTMLInputElement).checked).toBe(true));
  expect((screen.getByRole('checkbox', { name: 'Case images may be sent to permitted models' }) as HTMLInputElement).checked).toBe(true);
});

it('returns an existing case override to app settings with the current session', async () => {
  const refresh = vi.fn(async () => undefined);
  render(<SettingsDialog snapshot={snapshot} refresh={refresh} onClose={vi.fn()} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'This case · customized' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return this case to app settings' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('set_case_ai_scope', { case_id: 'synthetic-case', session_epoch: 8, scope: 'app' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it('can save offline app defaults before connecting a provider', async () => {
  api.mockImplementation(async (action: string) => action === 'app_ai_settings' ? { configured: false, config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [] }, settings: { offline: true, allow_text: false, allow_images: false, model: '' } } : action === 'provider_key_status' ? { configured: false } : undefined);
  const onClose = vi.fn();
  render(<SettingsDialog snapshot={null} refresh={async () => undefined} onClose={onClose} run={fn => { void fn(); }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save app AI settings' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith('save_app_ai_settings', { config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [] }, settings: { offline: true, allow_text: false, allow_images: false, model: '' } });
});
