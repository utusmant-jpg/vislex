// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JobsCenter } from './App';
import type { Snapshot } from './types';

const api = vi.hoisted(() => vi.fn());
vi.mock('./bridge', () => ({ api, native: false, formatBytes: (value:number) => `${value} bytes`, citationParts: () => null }));

function snapshot(): Snapshot {
  return {
    id: 'synthetic-case', name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [], budget_committed: 0,
    settings: { offline: true, allow_text: false, allow_images: false, model: '', case_budget: 0, input_per_million: 0, output_per_million: 0 },
    jobs: [
      { id: 'index-run', source_id: 'source', name: 'synthetic.mp4', kind: 'video_ocr_index', status: 'failed', error: 'resource error', created_at: '', superseded: false },
      { id: 'child-job', parent_run_id: 'index-run', source_id: 'source', name: 'synthetic.mp4', kind: 'video_ocr', status: 'failed', error: 'resource error', created_at: '', superseded: false },
    ],
    issues: [{ task_id: 'task', name: 'save_dossier', error: 'invalid check tool', count: 9, latest_receipt: 'latest', created_at: '' }],
  };
}
beforeEach(() => { api.mockReset(); api.mockResolvedValue({ receipts: [{ id: 'latest', created_at: 'now' }], next_offset: null }); });
afterEach(cleanup);

it('retries the parent discovery run from both failed job cards', async () => {
  render(<JobsCenter snapshot={snapshot()} run={fn => { void fn(); }} refresh={async () => undefined} />);
  const buttons = screen.getAllByRole('button', { name: 'Retry index from saved progress' });
  fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api).toHaveBeenNthCalledWith(1, 'retry_video_discovery', { run_id: 'index-run' });
  expect(api).toHaveBeenNthCalledWith(2, 'retry_video_discovery', { run_id: 'index-run' });
});

it('groups old AI tool errors and loads their receipts only when expanded', async () => {
  render(<JobsCenter snapshot={snapshot()} run={fn => { void fn(); }} refresh={async () => undefined} />);
  expect(screen.getByText('Previous AI tool errors (1 group)')).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
  const group = screen.getByText('save dossier · 9 previous failures');
  fireEvent.click(group);
  await waitFor(() => expect(api).toHaveBeenCalledWith('issue_history', { receipt_id: 'latest', offset: 0 }));
  expect(await screen.findByText(/Receipt latest/)).toBeTruthy();
});
