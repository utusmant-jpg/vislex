// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  await waitFor(() => expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 1, start: 5, count: 10 }));
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
