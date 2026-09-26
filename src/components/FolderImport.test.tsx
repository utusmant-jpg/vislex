// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FolderImport from './FolderImport';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, native: true }));
afterEach(() => { cleanup(); api.mockReset(); });
const common = { run: (fn: () => Promise<void>) => { void fn(); }, refresh: async () => undefined };

it('imports into the case shown when the folder dialog opened', async () => {
  api.mockResolvedValue({ items: [] });
  render(<FolderImport caseId="visible-case" sessionEpoch={5} hasCase {...common} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Evidence folder path' }), { target: { value: 'C:\\Evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import folder files' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('import_folder', expect.objectContaining({ case_id: 'visible-case', session_epoch: 5, path: 'C:\\Evidence' })));
});

it('uses the newly created case ID for a first folder import', async () => {
  api.mockImplementation(async (action: string) => action === 'create_case' ? { id: 'new-case', session_epoch: 6 } : { items: [] });
  render(<FolderImport hasCase={false} {...common} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Evidence folder path' }), { target: { value: 'C:\\Evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import folder files' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('import_folder', expect.objectContaining({ case_id: 'new-case', session_epoch: 6, path: 'C:\\Evidence' })));
});
