// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import EvidenceNotebook from './EvidenceNotebook';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async () => ({ ...await vi.importActual<typeof import('../bridge')>('../bridge'), api, native: true }));
afterEach(() => { cleanup(); api.mockReset(); });

it('reviews a finding against the captured case session and revision', async () => {
  const snapshot: Snapshot = { id: 'synthetic-case', session_epoch: 11, name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [], settings: { offline: true, allow_text: false, allow_images: false, model: '' } };
  api.mockImplementation(async (action: string) => action === 'evidence_list' ? { objects: [{ id: 'finding-1', revision: 3, kind: 'claim', title: 'Synthetic finding', content: 'Unreviewed claim', source_ids: [], locators: [], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null }], next_offset: null } : null);
  render(<EvidenceNotebook snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} />);
  fireEvent.click(await screen.findByText('Synthetic finding'));
  fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('evidence_review', { case_id: 'synthetic-case', session_epoch: 11, id: 'finding-1', revision: 3, review: 'accepted' }));
});
