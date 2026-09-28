// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InvestigationWorkbench, { investigationPill } from './InvestigationWorkbench';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async () => ({ ...await vi.importActual<typeof import('../bridge')>('../bridge'), api }));
afterEach(() => { cleanup(); api.mockReset(); });

const snapshot: Snapshot = { id: 'synthetic-case', session_epoch: 17, name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [], settings: { offline: true, allow_text: false, allow_images: false, model: '' } };
const claim = (proposition: string) => ({ proposition, assessment: 'supported_within_scope', supporting: [], contrary: [], uncertainty: '', next_check: 'Check it' });

it('starts a legal workflow in the captured case session', async () => {
  api.mockImplementation(async (action: string) => action === 'coverage_map' ? { sources: [], next_offset: null, note: '' } : action === 'investigation_workbench' ? { investigations: [], affected_objects: [], next_offset: null } : action === 'evidence_list' ? { objects: [] } : action === 'start_task' ? { conversation_id: 'workflow-chat' } : null);
  const onConversation = vi.fn();
  render(<InvestigationWorkbench snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} onConversation={onConversation} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Legal workflows' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Jurisdiction' }), { target: { value: 'Ontario' } });
  fireEvent.change(screen.getByLabelText('Legally relevant date'), { target: { value: '2026-09-26' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Questions, documents and drafting instructions' }), { target: { value: 'Prepare a source-linked issue matrix' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }));
  await waitFor(() => expect(api).toHaveBeenCalledWith('start_task', expect.objectContaining({ case_id: 'synthetic-case', session_epoch: 17 })));
  await waitFor(() => expect(onConversation).toHaveBeenCalledWith('workflow-chat'));
});

it('never shows a failed or stopped investigation as running', () => {
  const view = { stale: false, completion_stale: false, dossier: { revision: 1, claims: [] } };
  const label = (status: string, stale = false) => { const { container, unmount } = render(<>{investigationPill({ status, view: { ...view, stale } })}</>); const text = container.textContent; const spinning = !!container.querySelector('.spin'); unmount(); return { text, spinning }; };
  expect(label('failed')).toEqual({ text: 'Failed', spinning: false });
  expect(label('stopped')).toEqual({ text: 'Stopped', spinning: false });
  expect(label('running')).toEqual({ text: 'Running', spinning: true });
  expect(label('complete', true).text).toBe('Evidence changed · recheck required');
});

it('shows loading, then explains the empty replay state and changed assertions', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementation((action: string) => action === 'investigation_workbench' ? new Promise(resolve => { finish = resolve; }) : action === 'evidence_list' ? Promise.resolve({ objects: [] }) : action === 'coverage_map' ? Promise.resolve({ sources: [], next_offset: null, note: '' }) : Promise.resolve(null));
  render(<InvestigationWorkbench snapshot={snapshot} onClose={vi.fn()} onSource={vi.fn()} onConversation={vi.fn()} />);
  expect(screen.getByLabelText('Loading question dossiers')).toBeTruthy();
  finish({ investigations: [{ task_id: 't-1', question: 'Synthetic question?', status: 'complete', view: { stale: false, completion_stale: false, dossier: { revision: 2, claims: [claim('Kept'), claim('Added')] } }, previous: { claims: [claim('Kept'), claim('Dropped')] }, hypotheses: null }], affected_objects: [], next_offset: null });
  expect(await screen.findByRole('heading', { name: 'Synthetic question?' })).toBeTruthy();
  const tabs = screen.getByRole('tablist', { name: 'Investigation views' });
  screen.getByRole('tab', { name: 'Discrepancies' }).focus();
  fireEvent.keyDown(tabs, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'What changed?' }).getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'What changed?' }));
  expect(screen.getByText('New or revised:').parentElement!.textContent).toBe('New or revised: Added');
  expect(screen.getByText('Removed or reformulated:').parentElement!.textContent).toBe('Removed or reformulated: Dropped');
  fireEvent.keyDown(tabs, { key: 'ArrowRight' });
  expect(screen.getByRole('heading', { name: 'No clock proposals yet' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open synchronized replay' })).toBeNull();
});
