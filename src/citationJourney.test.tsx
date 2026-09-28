// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Markdown } from './markdown';
import EvidenceViewer from './components/EvidenceViewer';
import EvidenceNotebook from './components/EvidenceNotebook';
import type { Snapshot, Source, TextPage } from './types';

const api = vi.hoisted(() => vi.fn());
vi.mock('./bridge', async () => ({ ...await vi.importActual<typeof import('./bridge')>('./bridge'), api, native: true, evidenceUrl: (path: string) => path, formatBytes: (size: number) => `${size} B` }));
vi.mock('./components/FullTranscript', () => ({ default: () => null }));
vi.mock('./components/RedactionPanel', () => ({ default: () => null }));
vi.mock('./components/VideoDiscovery', () => ({ default: () => null }));
vi.mock('./components/SoundDiscovery', () => ({ default: () => null }));

const source: Source = { id: 'source-one', name: 'Statement.txt', sha256: 'hash', size: 100, mime: 'text/plain', kind: 'text', status: 'text ready', restricted: false, occurrences: 1, created_at: '2026-09-22T00:00:00Z' };
afterEach(() => { cleanup(); api.mockReset(); });

it('opens a chat citation against the historical wording after active text changes', async () => {
  const page: TextPage = { text: 'Old exact wording', start: 5, end: 5, total_lines: 9, revision: 1, historical: true, locator: 'evidence:source-one#R1L5-L5', truncated_long_lines: false };
  api.mockImplementation(async (action: string) => action === 'read_extract_revision' ? page : { ...page, text: 'Changed active wording', revision: 2, historical: false });
  function Journey() {
    const [locator, setLocator] = useState<string | undefined>();
    return <><Markdown text="See evidence:source-one#R1L5-L5" onSource={(id, value) => { if (id === source.id) setLocator(value); }} />
      {locator ? <EvidenceViewer source={source} locator={locator} run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} /> : null}</>;
  }
  render(<Journey />);
  const chip=screen.getByTitle('evidence:source-one#R1L5-L5');
  fireEvent.mouseEnter(chip);
  await waitFor(() => expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 1, start: 5, count: 1 }));
  fireEvent.click(chip);
  await waitFor(() => expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 1, start: 5, count: 200 }));
  expect(screen.getByText('Old exact wording')).toBeTruthy();
  expect(screen.queryByText('Changed active wording')).toBeNull();
});

it('copies the selected historical line with its revision', async () => {
  const page: TextPage = { text: 'Old exact wording', start: 5, end: 5, total_lines: 9, revision: 1, historical: true, locator: 'evidence:source-one#R1L5-L5', truncated_long_lines: false };
  api.mockResolvedValue(page);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, containsNode: (node: Node) => (node as HTMLElement).dataset?.line === '5' } as Selection);
  render(<EvidenceViewer source={source} locator="R1L5-L5" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  const article = await screen.findByText('Old exact wording');
  fireEvent.mouseUp(article.closest('article')!);
  fireEvent.click(await screen.findByText('Copy citation (rev 1)'));
  expect(writeText).toHaveBeenCalledWith('evidence:source-one#R1L5-L5');
  selection.mockRestore();
});

it('opens a finding citation at its pinned revision', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [{ id: 'finding-one', revision: 1, kind: 'observation', title: 'Old observation', content: 'Old exact wording', source_ids: [source.id], locators: ['evidence:source-one#R1L5-L5'], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null }], next_offset: null } : {});
  const onSource = vi.fn();
  const onClose = vi.fn();
  render(<EvidenceNotebook snapshot={{ id: 'case-one', sources: [source] } as Snapshot} onSource={onSource} onClose={onClose} />);
  fireEvent.click(await screen.findByText('Old observation'));
  fireEvent.click(screen.getByTitle('evidence:source-one#R1L5-L5'));
  expect(onSource).toHaveBeenCalledWith('source-one', 'R1L5-L5');
  expect(onClose).toHaveBeenCalledOnce();
});

it('records a two-source comparison with exact citations and a next check', async () => {
  const second: Source = { ...source, id: 'source-two', name: 'Interview.txt' };
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [], next_offset: null } : {});
  const onSource = vi.fn();
  render(<EvidenceNotebook snapshot={{ id: 'case-one', session_epoch: 7, sources: [source, second] } as Snapshot} onSource={onSource} onClose={vi.fn()} />);
  fireEvent.click(screen.getByText('Compare two accounts'));
  const groups = [screen.getByRole('group', { name: 'First account' }), screen.getByRole('group', { name: 'Second account' })];
  fireEvent.change(screen.getByLabelText('Comparison title'), { target: { value: 'Sequence of events' } });
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'uncertain_clock' } });
  fireEvent.change(groups[0].querySelector('select')!, { target: { value: source.id } });
  fireEvent.change(groups[0].querySelector('textarea')!, { target: { value: 'The event was at 10:00.' } });
  fireEvent.change(groups[0].querySelector('input')!, { target: { value: 'evidence:source-one#R1L1-L1' } });
  fireEvent.change(groups[1].querySelector('select')!, { target: { value: second.id } });
  fireEvent.change(groups[1].querySelector('textarea')!, { target: { value: 'The event was near 10:30.' } });
  fireEvent.change(groups[1].querySelector('input')!, { target: { value: 'evidence:source-two#R1L2-L2' } });
  fireEvent.change(screen.getByLabelText('Next check'), { target: { value: 'Compare verified clock anchors.' } });
  fireEvent.click(screen.getByText('Open first source'));
  expect(onSource).toHaveBeenCalledWith(source.id, 'R1L1-L1');
  fireEvent.click(screen.getByText('Save unreviewed comparison'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('evidence_write', expect.objectContaining({ case_id: 'case-one', session_epoch: 7, object: expect.objectContaining({ kind: 'issue', source_ids: [source.id, second.id], locators: ['evidence:source-one#R1L1-L1', 'evidence:source-two#R1L2-L2'] }) })));
  const saved = api.mock.calls.find(([name]) => name === 'evidence_write')![1].object;
  expect(JSON.parse(saved.content)).toMatchObject({ category: 'uncertain_clock', next_check: 'Compare verified clock anchors.' });
});

it('builds a draft from an accepted finding with revision and source dependencies', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [{ id: 'accepted-one', revision: 3, kind: 'issue', title: 'Accepted sequence', content: 'Checked account comparison', source_ids: [source.id], locators: ['evidence:source-one#R1L1-L1'], review: 'accepted', stale: false, actor: 'human', start_seconds: null, end_seconds: null }], next_offset: null } : {});
  render(<EvidenceNotebook snapshot={{ id: 'case-one', sources: [source] } as Snapshot} onSource={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText('Accepted sequence');
  fireEvent.click(screen.getByText('Prepare an issue, production gap, exhibit or draft'));
  const form = within(screen.getByText('Prepare an issue, production gap, exhibit or draft').closest('details')!.querySelector('form')!);
  fireEvent.change(screen.getByLabelText('Work product type'), { target: { value: 'draft' } });
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Proposed chronology' } });
  fireEvent.change(screen.getByLabelText('Jurisdiction'), { target: { value: 'Ontario' } });
  fireEvent.change(screen.getByLabelText('Relevant date'), { target: { value: '2026-09-26' } });
  fireEvent.change(screen.getByLabelText('Paragraph'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'The record places the event near 10:00.' } });
  fireEvent.change(form.getByLabelText('Source'), { target: { value: source.id } });
  fireEvent.change(form.getByLabelText('Exact citation'), { target: { value: 'evidence:source-one#R1L1-L1' } });
  fireEvent.change(form.getByLabelText('Accepted finding on this page (optional)'), { target: { value: 'accepted-one:3' } });
  fireEvent.click(screen.getByText('Save unreviewed work product'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('evidence_write', expect.objectContaining({ case_id: 'case-one', object: expect.objectContaining({ kind: 'draft', dependencies: [{ id: 'accepted-one', revision: 3 }], locators: ['evidence:source-one#R1L1-L1'] }) })));
  const saved = api.mock.calls.find(([name]) => name === 'evidence_write')![1].object;
  expect(JSON.parse(saved.content)).toMatchObject({ workflow: 'draft', jurisdiction: 'Ontario', rows: [{ paragraph: '1', text: 'The record places the event near 10:00.', citations: ['evidence:source-one#R1L1-L1'], authority_ids: [] }] });
});

it('shows saved comparison and work product fields while keeping provenance available', async () => {
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [
    { id: 'issue-one', revision: 1, kind: 'issue', title: 'Account conflict', content: JSON.stringify({ schema: 'witness_comparison_v1', category: 'omission', first: 'Mentions a call', second: 'Does not mention the call', next_check: 'Inspect call records' }), source_ids: [source.id], locators: [], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null },
    { id: 'draft-one', revision: 1, kind: 'draft', title: 'Proposed paragraph', content: JSON.stringify({ workflow: 'draft', jurisdiction: 'Ontario', relevant_date: '2026-09-26', rows: [{ paragraph: '1', text: 'A proposed sentence', citations: [], authority_ids: [] }], authority_limits: [] }), source_ids: [source.id], locators: [], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null }
  ], next_offset: null } : {});
  render(<EvidenceNotebook snapshot={{ id: 'case-one', sources: [source] } as Snapshot} onSource={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByText('Account conflict'));
  expect(screen.getByText('Inspect call records')).toBeTruthy();
  fireEvent.click(screen.getByText('Proposed paragraph'));
  expect(screen.getByText('A proposed sentence')).toBeTruthy();
  expect(screen.getAllByText('Raw provenance')).toHaveLength(2);
});

it('previews only the cited lines and stays open while the pointer crosses to the card', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    api.mockImplementation(async (action: string, args: { start: number; count: number }) => action === 'read_extract_revision'
      ? { text: Array.from({ length: args.count }, (_, index) => `Line ${args.start + index} text`).join('\n'), start: args.start, revision: 2 }
      : undefined);
    const onOpen = vi.fn();
    render(<Markdown text="See evidence:source-one#R2L5-L5" onSource={onOpen} />);
    const chip = screen.getByTitle('evidence:source-one#R2L5-L5');
    fireEvent.mouseEnter(chip);
    await vi.advanceTimersByTimeAsync(400);
    const card = await screen.findByRole('group', { name: 'Cited lines preview' });
    expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 2, start: 5, count: 1 });
    await waitFor(() => expect(within(card).getByText('Line 5 text')).toBeTruthy());
    expect(within(card).queryByText('Line 6 text')).toBeNull();
    expect(within(card).getByText(/^Line 5 · extraction revision 2 · as cited$/)).toBeTruthy();
    fireEvent.mouseLeave(chip);
    fireEvent.mouseEnter(card);
    await vi.advanceTimersByTimeAsync(400);
    expect(screen.getByRole('group', { name: 'Cited lines preview' })).toBe(card);
    fireEvent.click(within(card).getByRole('button', { name: 'Open in viewer' }));
    expect(onOpen).toHaveBeenCalledWith('source-one', 'R2L5-L5');
    expect(screen.queryByRole('group', { name: 'Cited lines preview' })).toBeNull();
    fireEvent.mouseEnter(chip);
    await vi.advanceTimersByTimeAsync(400);
    fireEvent.mouseLeave(chip);
    await vi.advanceTimersByTimeAsync(400);
    expect(screen.queryByRole('group', { name: 'Cited lines preview' })).toBeNull();
  } finally { vi.useRealTimers(); }
});
