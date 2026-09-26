// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './markdown';
import EvidenceViewer from './components/EvidenceViewer';
import type { Source, TextPage } from './types';

const api = vi.hoisted(() => vi.fn());
vi.mock('./bridge', async () => ({ ...await vi.importActual<typeof import('./bridge')>('./bridge'), api, evidenceUrl: (path: string) => path, formatBytes: (size: number) => `${size} B` }));
vi.mock('./components/FullTranscript', () => ({ default: () => null }));
vi.mock('./components/RedactionPanel', () => ({ default: () => null }));
vi.mock('./components/VideoDiscovery', () => ({ default: () => null }));

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
