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

it('explains why sound discovery cannot start yet', () => {
  expect(scanBlocker('', 0, 30)).toBe('Select a recording.');
  expect(scanBlocker('rec', 10, 10)).toBe('End must be after start.');
  expect(scanBlocker('rec', 0, 61)).toBe('Scan at most 60 seconds at a time.');
  expect(scanBlocker('rec', -1, 5)).toBe('Start must be zero or later.');
  expect(scanBlocker('rec', 0, 60)).toBeNull();
});
