// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EvidenceViewer from './EvidenceViewer';
import type { Source, TextPage } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, evidenceUrl: (path: string) => path, formatBytes: (size: number) => `${size} B` }));
vi.mock('../ui', () => ({ Skeleton: () => <span>Loading</span>, Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./FullTranscript', () => ({ default: () => null }));
vi.mock('./RedactionPanel', () => ({ default: () => null }));
vi.mock('./VideoDiscovery', () => ({ default: () => null }));

const source: Source = { id: 'source-one', name: 'Synthetic statement.txt', sha256: 'hash', size: 100, mime: 'text/plain', kind: 'text', status: 'text ready', restricted: false, occurrences: 1, created_at: '2026-09-22T00:00:00Z' };
afterEach(() => { cleanup(); api.mockReset(); });

it('opens a pinned citation against its historical revision and marks the wording as superseded', async () => {
  const historical: TextPage = { text: 'Old exact wording', start: 5, end: 5, total_lines: 9, revision: 1, historical: true, locator: 'evidence:source-one#R1L5-L5', truncated_long_lines: false };
  api.mockImplementation(async (action: string) => action === 'read_extract_revision' ? historical : { ...historical, text: 'Changed active wording', revision: 2, historical: false });
  render(<EvidenceViewer source={source} locator="R1L5-L5" run={fn => { void fn(); }} refresh={async () => undefined} onLocatorSelect={vi.fn()} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith('read_extract_revision', { source_id: 'source-one', revision: 1, start: 5, count: 200 }));
  expect(screen.getByText('Old exact wording')).toBeTruthy();
  expect(screen.queryByText('Changed active wording')).toBeNull();
  expect(screen.getByRole('note').textContent).toContain('superseded wording preserved');
});
