// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import QuestionDossier from './QuestionDossier';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async () => ({ ...await vi.importActual<typeof import('../bridge')>('../bridge'), api, native: true }));
afterEach(() => { cleanup(); api.mockReset(); });

it('shows the saved block support state separately from human acceptance', async () => {
  api.mockResolvedValue({ dossier: { revision: 1, scope: 'Synthetic account', checks: [], claims: [{ proposition: 'The account reports a call', assessment: 'supported_within_scope', supporting: [], contrary: [], uncertainty: '', next_check: '' }] }, stale: false, completion_stale: false, completion: { outcome: 'declared_checks_complete', gaps: [], created_at: '2026-09-26', structured: true, blocks: [{ id: 'b1', kind: 'attributed_statement', text: 'The account reports a call', claims: ['claim-call'], factual: true, review: 'supported' }] }, human_reviews: [null], coverage_note: 'Declared checks only.' });
  render(<QuestionDossier taskId="task-one" step={1} status="complete" evidenceVersion="one" onSource={vi.fn()} />);
  fireEvent.click(screen.getByText('Question dossier · evidence, checks and gaps'));
  expect(await screen.findByText('Declared checks complete · AI assessment')).toBeTruthy();
  expect(screen.getByText(/support reviewed/)).toBeTruthy();
  fireEvent.click(screen.getByText('The account reports a call', { selector: 'summary' }));
  expect(screen.getByText('No human review recorded.')).toBeTruthy();
});
