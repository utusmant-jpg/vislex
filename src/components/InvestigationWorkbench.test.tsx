// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InvestigationWorkbench from './InvestigationWorkbench';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async () => ({ ...await vi.importActual<typeof import('../bridge')>('../bridge'), api }));
afterEach(() => { cleanup(); api.mockReset(); });

it('starts a legal workflow in the captured case session', async () => {
  const snapshot: Snapshot = { id: 'synthetic-case', session_epoch: 17, name: 'Synthetic case', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [], settings: { offline: true, allow_text: false, allow_images: false, model: '' } };
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
