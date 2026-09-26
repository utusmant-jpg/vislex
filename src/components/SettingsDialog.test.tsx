// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsDialog from './SettingsDialog';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, native: true }));
vi.mock('../ui', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn(), density: 'comfortable', setDensity: vi.fn() }) }));

const snapshot: Snapshot = {
  id: 'synthetic-case', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1,
  sources: [], records: [], tasks: [],
  ai_config: { provider: 'openai', execution: 'single', review: 'challenge', pool: [] },
  settings: { offline: false, allow_text: true, allow_images: true, model: 'saved-model' },
};

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (action: string) => action === 'direct_media_permission' ? { enabled: false } : action === 'provider_key_status' ? { configured: true } : undefined);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
});
afterEach(cleanup);

it('saves the exact case grants and review mode chosen in the dialog', async () => {
  const refresh = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(<SettingsDialog snapshot={snapshot} refresh={refresh} onClose={onClose} run={fn => { void fn(); }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Case permissions' }));
  await screen.findByText('Permitted — original audio/video may be sent');
  expect(screen.queryByText(/Case budget|tokens|\$\/M/i)).toBeNull();
  fireEvent.click(screen.getByText('Offline — stop new requests'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Case text may be sent to permitted models' }));
  fireEvent.click(screen.getByText('Permitted — original audio/video may be sent'));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings & keys' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith('save_ai_settings', {
    config: { provider: 'openai', execution: 'single', review: 'challenge', pool: [] },
    settings: { offline: true, allow_text: false, allow_images: false, model: 'saved-model' },
  });
  expect(api).toHaveBeenCalledWith('set_direct_media_permission', { enabled: true });
});
