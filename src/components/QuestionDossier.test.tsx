// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuestionDossier from './QuestionDossier';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async () => ({ ...await vi.importActual<typeof import('../bridge')>('../bridge'), api, native: true }));
afterEach(() => { cleanup(); api.mockReset(); });

it('shows the saved block support state separately from human acceptance', async () => {
  api.mockResolvedValue({ dossier: { revision: 1, scope: 'Synthetic account', checks: [], claims: [{ proposition: 'The account reports a call', assessment: 'supported_within_scope', supporting: [], contrary: [], uncertainty: '', next_check: '' }] }, stale: false, completion_stale: false, completion: { outcome: 'declared_checks_complete', gaps: [], created_at: '2026-09-26', structured: true, blocks: [{ id: 'b1', kind: 'attributed_statement', text: 'The account reports a call', claims: ['claim-call'], factual: true, review: 'supported' }] }, human_reviews: [null], coverage_note: 'Declared checks only.' });
  render(<QuestionDossier caseId="case-one" sessionEpoch={9} taskId="task-one" step={1} status="complete" evidenceVersion="one" onSource={vi.fn()} />);
  fireEvent.click(screen.getByText('Question dossier · evidence, checks and gaps'));
  expect(await screen.findByText('Declared checks complete · AI assessment')).toBeTruthy();
  expect(screen.getByText(/support reviewed/)).toBeTruthy();
  fireEvent.click(screen.getByText('The account reports a call', { selector: 'summary .dossier-claim-text' }));
  expect(screen.getByText('No human review recorded.')).toBeTruthy();
  fireEvent.click(screen.getByText('Accept finding'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('review_dossier_claim', { case_id: 'case-one', session_epoch: 9, task_id: 'task-one', revision: 1, claim_index: 0, decision: 'accepted', note: '' }));
});

it('labels human review state per finding and blocks review of a stale dossier', async () => {
  const claim = (proposition: string) => ({ proposition, assessment: 'contested', supporting: [], contrary: [], uncertainty: '', next_check: '' });
  api.mockResolvedValue({ dossier: { revision: 2, scope: 'Synthetic scope', checks: [{ id: 'k', description: 'Inspect frames', state: 'blocked', reason: 'Derivative outdated', receipts: [] }], claims: [claim('First claim'), claim('Second claim'), claim('Third claim')] }, stale: true, completion_stale: false, completion: null, human_reviews: [{ decision: 'accepted', note: '', stale: false }, { decision: 'needs_review', note: '', stale: true }, null], coverage_note: 'Declared checks only.' });
  render(<QuestionDossier caseId="case-one" sessionEpoch={9} taskId="task-one" step={2} status="complete" evidenceVersion="one" onSource={vi.fn()} />);
  fireEvent.click(screen.getByText('Question dossier · evidence, checks and gaps'));
  expect(await screen.findByText('Evidence changed — recheck required')).toBeTruthy();
  expect(screen.getByText('1 of 3 findings have a current human review')).toBeTruthy();
  expect(screen.getByText('Blocked')).toBeTruthy();
  const states = [...document.querySelectorAll('.dossier-claim-state')].map(node => node.textContent);
  expect(states).toEqual(['Accepted', 'Needs review · stale', 'Not reviewed']);
  for (const button of screen.getAllByRole('button', { name: 'Accept finding' })) expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText(/Recheck before recording a review/)).toHaveLength(3);
});
