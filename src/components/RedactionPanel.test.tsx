// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RedactionPanel from './RedactionPanel';

const api = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, evidenceUrl: (path: string) => path }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save }));
vi.mock('../ui', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => { cleanup(); api.mockReset(); save.mockReset(); });

const output = { published: [
  { artifact_id: 'review-page', metadata: { mime: 'image/jpeg', page: 1 } },
  { artifact_id: 'review-pdf', metadata: { mime: 'application/pdf', page_count: 1 } },
] };

it('requires review of the built derivative before exporting only that artifact', async () => {
  api.mockImplementation(async (command: string) => command === 'prepare_redaction' ? output : undefined);
  save.mockResolvedValue('C:/synthetic/reviewed.pdf');
  render(<RedactionPanel caseId="case-a" sessionEpoch={3} sourceId="source-a" kind="pdf" />);
  fireEvent.click(screen.getByText('Prepare a reviewed redaction'));
  expect(screen.queryByRole('button', { name: 'Export derivative only' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Build review copy' }));
  await waitFor(() => expect(screen.getByAltText('Redacted page 1')).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Export derivative only' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/0 of 1 pages reviewed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed page 1 for remaining sensitive content' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), { target: { value: 'Checked synthetic page.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Accept reviewed derivative' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Export derivative only' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Export derivative only' }));
  await waitFor(() => expect(screen.getByText('Saved C:/synthetic/reviewed.pdf')).toBeTruthy());
  expect(api).toHaveBeenCalledWith('review_redaction', { case_id: 'case-a', session_epoch: 3, artifact_id: 'review-pdf', pages: [1], note: 'Checked synthetic page.' });
  expect(api).toHaveBeenCalledWith('export_redaction', { case_id: 'case-a', session_epoch: 3, artifact_id: 'review-pdf', path: 'C:/synthetic/reviewed.pdf' });
});

it('clears review state on source change and ignores a late preparation result', async () => {
  let resolveOld!: (result: typeof output) => void;
  api.mockImplementation((command: string) => command === 'prepare_redaction'
    ? new Promise<typeof output>(resolve => { resolveOld = resolve; })
    : Promise.resolve(undefined));
  const view = render(<RedactionPanel caseId="case-a" sessionEpoch={3} sourceId="source-a" kind="pdf" />);
  fireEvent.click(screen.getByText('Prepare a reviewed redaction'));
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Build review copy' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('prepare_redaction', expect.objectContaining({ source_id: 'source-a', session_epoch: 3 })));
  view.rerender(<RedactionPanel caseId="case-a" sessionEpoch={5} sourceId="source-b" kind="pdf" />);
  resolveOld(output);
  await waitFor(() => expect(screen.queryByAltText('Redacted page 1')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Export derivative only' })).toBeNull();
  fireEvent.click(screen.getByText('Prepare a reviewed redaction'));
  expect(screen.getByRole('button', { name: 'Build review copy' }).hasAttribute('disabled')).toBe(true);
});
