// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EvidenceNotebook from './EvidenceNotebook';
import { scanBlocker } from './SoundDiscovery';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async () => ({ ...await vi.importActual<typeof import('../bridge')>('../bridge'), api, native: true }));
beforeAll(() => { Element.prototype.scrollIntoView = () => {}; });
afterEach(() => { cleanup(); api.mockReset(); });

const snapshot: Snapshot = { id: 'synthetic-case', session_epoch: 11, name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [], settings: { offline: true, allow_text: false, allow_images: false, model: '' } };
const finding = (id: string, title: string, review = 'unreviewed', stale = false) => ({ id, revision: 3, kind: 'claim', title, content: 'Synthetic content', source_ids: [], locators: [], review, stale, actor: 'human', start_seconds: null, end_seconds: null });

it('reviews a finding against the captured case session and revision', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [finding('finding-1', 'Synthetic finding')], next_offset: null } : null);
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.click(await screen.findByText('Synthetic finding'));
  fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('evidence_review', { case_id: 'synthetic-case', session_epoch: 11, id: 'finding-1', revision: 3, review: 'accepted' }));
});

it('shows a loading state instead of the empty state until the first page arrives', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation((action: string) => action === 'evidence_list' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null));
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  expect(screen.getByLabelText('Loading findings')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'No findings on this page' })).toBeNull();
  finish({ objects: [], next_offset: null });
  expect(await screen.findByRole('heading', { name: 'No findings on this page' })).toBeTruthy();
  expect(screen.queryByLabelText('Loading findings')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'New object' })[1]);
  expect(screen.getByRole('heading', { name: 'New evidence object' })).toBeTruthy();
});

it('ignores a late page for a previous kind filter', async () => {
  const pending: Record<string, (value: unknown) => void> = {};
  api.mockImplementation((action: string, args: { kind: string | null }) => action === 'evidence_list' ? new Promise(resolve => { pending[args.kind ?? 'all'] = resolve; }) : Promise.resolve(null));
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'hypothesis' } });
  pending.hypothesis({ objects: [finding('h-1', 'Current hypothesis')], next_offset: null });
  expect(await screen.findByText('Current hypothesis')).toBeTruthy();
  pending.all({ objects: [finding('old-1', 'Stale page from all kinds')], next_offset: null });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByText('Stale page from all kinds')).toBeNull();
});

it('blocks review of a stale revision and says why, with an icon and label state', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [finding('stale-1', 'Changed dependency finding', 'accepted', true)], next_offset: null } : null);
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  expect(await screen.findByText('Recheck dependencies')).toBeTruthy();
  expect(screen.getByText(/1 need recheck/)).toBeTruthy();
  for (const name of ['Accept revision', 'Reject revision', 'Clear review']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Review is disabled until a new revision rechecks the latest dependencies/)).toBeTruthy();
});

it('moves focus to the editor when a finding is revised', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [finding('f-1', 'Revisable finding')], next_offset: null } : null);
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByText('Revisable finding');
  fireEvent.click(screen.getByRole('button', { name: 'Revise' }));
  const heading = screen.getByRole('heading', { name: 'Revise object · revision 3' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  fireEvent.click(screen.getByRole('button', { name: 'Close editor without saving' }));
  expect(screen.queryByRole('heading', { name: 'Revise object · revision 3' })).toBeNull();
});

it('keeps the open card mounted during the refetch after a review and returns focus to its review group', async () => {
  let review = 'unreviewed';
  let finishList: ((value: unknown) => void) | null = null;
  api.mockImplementation((action: string) => {
    if (action === 'evidence_review') { review = 'accepted'; return Promise.resolve(null); }
    if (action !== 'evidence_list') return Promise.resolve(null);
    const page = { objects: [finding('f-1', 'Reviewed finding', review)], next_offset: null };
    return review === 'unreviewed' ? Promise.resolve(page) : new Promise(resolve => { finishList = () => resolve(page); });
  });
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.click(await screen.findByText('Reviewed finding'));
  const card = screen.getByText('Reviewed finding').closest('details')!;
  card.open = true;
  const accept = screen.getByRole('button', { name: 'Accept revision' });
  accept.focus();
  fireEvent.click(accept);
  await waitFor(() => expect(finishList).not.toBeNull());
  // Mid-refetch: no skeleton, same card node, still open, list marked busy.
  expect(screen.queryByLabelText('Loading findings')).toBeNull();
  expect(screen.getByText('Reviewed finding').closest('details')).toBe(card);
  expect(card.open).toBe(true);
  expect(card.closest('.object-list')?.getAttribute('aria-busy')).toBe('true');
  // Simulate Chromium dropping focus from the disabled button to <body>.
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  finishList!(null);
  const group = screen.getByRole('group', { name: 'Review revision 3 of Reviewed finding' });
  await waitFor(() => expect(document.activeElement).toBe(group));
  expect(screen.getByText('Reviewed finding').closest('details')).toBe(card);
  expect(card.open).toBe(true);
  expect(card.closest('.object-list')?.hasAttribute('aria-busy')).toBe(false);
  expect((screen.getByRole('button', { name: 'Accept revision' }) as HTMLButtonElement).disabled).toBe(true);
});

it('returns focus to the review group when a review fails, without refetching', async () => {
  let lists = 0;
  api.mockImplementation(async (action: string) => {
    if (action === 'evidence_review') throw new Error('Case session changed');
    if (action === 'evidence_list') { lists += 1; return { objects: [finding('f-2', 'Failing review')], next_offset: null }; }
    return null;
  });
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.click(await screen.findByText('Failing review'));
  // Chromium moves focus to <body> when the focused button is disabled while saving; start from there.
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Case session changed');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Review revision 3 of Failing review' })));
  expect(lists).toBe(1);
});

it('keeps the page list and pager mounted while the next page loads', async () => {
  let finishNext: ((value: unknown) => void) | null = null;
  api.mockImplementation((action: string, args: { offset: number }) => {
    if (action !== 'evidence_list') return Promise.resolve(null);
    if (args.offset === 0) return Promise.resolve({ objects: [finding('p1', 'First page finding')], next_offset: 50 });
    return new Promise(resolve => { finishNext = resolve; });
  });
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  await screen.findByText('First page finding');
  const next = screen.getByRole('button', { name: 'Next' });
  fireEvent.click(next);
  await waitFor(() => expect(finishNext).not.toBeNull());
  expect(screen.queryByLabelText('Loading findings')).toBeNull();
  expect(screen.getByRole('button', { name: 'Next' })).toBe(next);
  expect(screen.getByText('First page finding')).toBeTruthy();
  finishNext!({ objects: [finding('p2', 'Second page finding')], next_offset: null });
  expect(await screen.findByText('Second page finding')).toBeTruthy();
  expect(screen.getByText('Page 2')).toBeTruthy();
});

it('explains why sound discovery cannot start yet', () => {
  expect(scanBlocker('', 0, 30)).toBe('Select a recording.');
  expect(scanBlocker('rec', 10, 10)).toBe('End must be after start.');
  expect(scanBlocker('rec', 0, 61)).toBe('Scan at most 60 seconds at a time.');
  expect(scanBlocker('rec', -1, 5)).toBe('Start must be zero or later.');
  expect(scanBlocker('rec', 0, 60)).toBeNull();
});
