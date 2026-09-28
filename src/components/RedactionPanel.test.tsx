// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  fireEvent.change(screen.getByRole('spinbutton', { name: 'X of rectangle 1 in points' }), { target: { value: '45' } });
  expect(screen.queryByAltText('Redacted page 1')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Export derivative only' })).toBeNull();
  expect(api.mock.calls.filter(([command]) => command === 'export_redaction')).toHaveLength(1);
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

it('asks for explicit confirmation before discarding every marked rectangle', async () => {
  api.mockResolvedValue(undefined);
  render(<RedactionPanel caseId="case-a" sessionEpoch={3} sourceId="source-a" kind="image" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  const clear = screen.getByRole('button', { name: 'Clear all rectangles' });
  fireEvent.click(clear);
  const dialog = screen.getByRole('alertdialog', { name: 'Discard 2 rectangles?' });
  expect(dialog.textContent).toContain('The original source is unchanged.');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep rectangles' }));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(clear);
  expect(screen.getByRole('spinbutton', { name: 'X of rectangle 2 in pixels' })).toBeTruthy();
  fireEvent.click(clear);
  fireEvent.click(screen.getByRole('button', { name: 'Discard rectangles' }));
  expect(screen.queryByRole('spinbutton', { name: 'X of rectangle 1 in pixels' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Build review copy' }).hasAttribute('disabled')).toBe(true);
});

it('confirms before switching drawing mode would discard marked rectangles', async () => {
  api.mockResolvedValue({ published: [{ artifact_id: 'base' }] });
  render(<RedactionPanel caseId="case-a" sessionEpoch={3} sourceId="source-a" kind="image" />);
  fireEvent.click(screen.getByRole('button', { name: 'Draw redactions' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  // The label names the action, so the button carries no aria-pressed state that could contradict it.
  expect(screen.queryByRole('button', { name: 'Draw redactions' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop drawing' }).hasAttribute('aria-pressed')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop drawing' }));
  expect(screen.getByRole('alertdialog', { name: 'Discard 1 rectangle?' }).textContent).toContain('Stopping drawing clears every marked area');
  fireEvent.click(screen.getByRole('button', { name: 'Keep rectangles' }));
  expect(screen.getByRole('button', { name: 'Stop drawing' })).toBeTruthy();
  expect(screen.getByRole('spinbutton', { name: 'X of rectangle 1 in pixels' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stop drawing' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard rectangles' }));
  expect(screen.getByRole('button', { name: 'Draw redactions' })).toBeTruthy();
  expect(screen.queryByRole('spinbutton', { name: 'X of rectangle 1 in pixels' })).toBeNull();
  await waitFor(() => expect(api).toHaveBeenCalledWith('process_source', { case_id: 'case-a', session_epoch: 3, source_id: 'source-a' }));
});

it('shows redaction progress as steps with the current step marked', () => {
  render(<RedactionPanel caseId="case-a" sessionEpoch={3} sourceId="source-a" kind="pdf" />);
  const steps = within(screen.getByRole('list', { name: 'Redaction progress' })).getAllByRole('listitem');
  expect(steps[0].getAttribute('aria-current')).toBe('step');
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  expect(steps[0].textContent).toContain('(done)');
  expect(steps[1].getAttribute('aria-current')).toBe('step');
});

it('marks review and export done only at their real milestones', async () => {
  api.mockImplementation(async (command: string) => command === 'prepare_redaction' ? output : undefined);
  save.mockResolvedValue('C:/synthetic/reviewed.pdf');
  render(<RedactionPanel caseId="case-a" sessionEpoch={3} sourceId="source-a" kind="pdf" />);
  const steps = () => within(screen.getByRole('list', { name: 'Redaction progress' })).getAllByRole('listitem');
  fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Build review copy' }));
  await waitFor(() => expect(screen.getByAltText('Redacted page 1')).toBeTruthy());
  // A built copy is not a reviewed copy: 0 of 1 pages reviewed, so step 2 is current and not done.
  expect(steps()[1].textContent).not.toContain('(done)');
  expect(steps()[1].getAttribute('aria-current')).toBe('step');
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed page 1 for remaining sensitive content' }));
  expect(steps()[1].textContent).not.toContain('(done)');
  fireEvent.click(screen.getByRole('button', { name: 'Accept reviewed derivative' }));
  await waitFor(() => expect(steps()[1].textContent).toContain('(done)'));
  // Accepted but not yet exported: step 3 is current and not done.
  expect(steps()[2].textContent).not.toContain('(done)');
  expect(steps()[2].getAttribute('aria-current')).toBe('step');
  fireEvent.click(screen.getByRole('button', { name: 'Export derivative only' }));
  await waitFor(() => expect(steps()[2].textContent).toContain('(done)'));
  expect(steps().some(item => item.getAttribute('aria-current') === 'step')).toBe(false);
});
