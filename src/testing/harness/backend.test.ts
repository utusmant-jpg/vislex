import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyntheticBackend } from './backend';
import { buildHarborCase, FIXTURE, SYNTHETIC_BANNER, syntheticId } from './fixtures';
import { placeholderUrl } from './placeholders';

type Snapshot = { id: string; session_epoch: number; event_seq: number; sources: { id: string; created_at: string }[]; source_next_cursor: { created_at: string; id: string } | null; tasks: { answer: string; answer_truncated: boolean }[]; counts: { source_count: number; audit_seq: number } };

function setup(options: ConstructorParameters<typeof SyntheticBackend>[1] = {}) {
  const events: { event: string; payload: unknown }[] = [];
  const backend = new SyntheticBackend((event, payload) => events.push({ event, payload }), { now: Date.parse('2026-09-28T12:00:00Z'), ...options });
  const command = <T,>(action: string, args: Record<string, unknown> = {}) => backend.handle('command', { action, args }) as Promise<T>;
  return { backend, events, command };
}

describe('synthetic fixtures', () => {
  it('builds ~250 labelled synthetic sources across every kind, with restricted and long names', () => {
    const c = buildHarborCase(Date.parse('2026-09-28T12:00:00Z'));
    expect(c.sources).toHaveLength(250);
    expect(new Set(c.sources.map(source => source.kind))).toEqual(new Set(['text', 'pdf', 'image', 'audio', 'video', 'other']));
    expect(c.sources.every(source => /SYNTHETIC/.test(source.name))).toBe(true);
    expect(c.sources.filter(source => source.revisions).every(source => Object.values(source.revisions!).every(lines => lines[0] === SYNTHETIC_BANNER))).toBe(true);
    expect(c.sources.some(source => source.restricted)).toBe(true);
    expect(Math.max(...c.sources.map(source => source.name.length))).toBeGreaterThan(200);
    expect(new Set(c.jobs.map(job => job.status))).toEqual(new Set(['running', 'queued', 'failed', 'interrupted', 'cancelled', 'complete']));
  });

  it('is deterministic', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(JSON.stringify(buildHarborCase(now).sources)).toBe(JSON.stringify(buildHarborCase(now).sources));
    expect(syntheticId('source', 3)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('SyntheticBackend guards and paging', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stamps snapshots with the session and pages sources newest first', async () => {
    const { command } = setup();
    const snapshot = await command<Snapshot>('snapshot');
    expect(snapshot).toMatchObject({ id: FIXTURE.caseA.id, session_epoch: 1, counts: { source_count: 250 } });
    expect(snapshot.sources).toHaveLength(50);
    expect([...snapshot.sources].sort((a, b) => b.created_at.localeCompare(a.created_at))).toEqual(snapshot.sources);
    expect(snapshot.tasks.find(task => task.answer_truncated)?.answer.length).toBe(200);
    const next = await command<{ sources: unknown[] }>('source_page', { case_id: snapshot.id, generation: 4, audit_seq: snapshot.counts.audit_seq, before: snapshot.source_next_cursor });
    expect(next.sources).toHaveLength(50);
    await expect(command('source_page', { case_id: snapshot.id, generation: 4, audit_seq: 1, before: snapshot.source_next_cursor })).rejects.toBe('Case changed before source page');
  });

  it('rejects wrong case ids and stale session epochs like the native dispatcher', async () => {
    const { command } = setup();
    await expect(command('set_restricted', { case_id: 'other', session_epoch: 1, source_id: FIXTURE.statement, restricted: true })).rejects.toBe('Case changed before restriction change');
    await expect(command('set_restricted', { case_id: FIXTURE.caseA.id, session_epoch: 7, source_id: FIXTURE.statement, restricted: true })).rejects.toBe('Case session changed; refresh before continuing');
    await expect(command('set_restricted', { case_id: FIXTURE.caseA.id, source_id: FIXTURE.statement, restricted: true })).rejects.toBe('Missing session_epoch');
    await expect(command('nonexistent_action')).rejects.toBe('Unknown application command');
  });

  it('emits a sequenced case-event after mutations but not after reads', async () => {
    const { command, events } = setup();
    await command('snapshot');
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    await command('set_restricted', { case_id: FIXTURE.caseA.id, session_epoch: 1, source_id: FIXTURE.statement, restricted: true });
    await vi.runAllTimersAsync();
    expect(events.map(item => item.event)).toEqual(['case-event', 'case-changed']);
    expect(events[0].payload).toEqual({ case_id: FIXTURE.caseA.id, session_epoch: 1, event_seq: 1 });
  });

  it('switches cases with a new epoch and refuses while a task runs', async () => {
    const { command, backend } = setup();
    backend.setScenario({ autoStream: false });
    await command('start_task', { case_id: FIXTURE.caseA.id, session_epoch: 1, prompt: 'hold on', provider: 'openai', model: 'harness-model-alpha', parent_task_id: null, viewer_context: null });
    await expect(command('open_case', { case_id: FIXTURE.caseA.id, session_epoch: 1, path: FIXTURE.caseB.root })).rejects.toBe('Stop active tasks and processing jobs before switching cases');
    const running = backend.active!.tasks.find(task => task.status === 'running')!;
    await command('stop_task', { case_id: FIXTURE.caseA.id, session_epoch: 1, task_id: running.id });
    const b = await command<Snapshot>('open_case', { case_id: FIXTURE.caseA.id, session_epoch: 1, path: FIXTURE.caseB.root });
    expect(b).toMatchObject({ id: FIXTURE.caseB.id, session_epoch: 2 });
  });

  it('streams agent-progress deltas, completes, and stops cleanly on stop_task', async () => {
    const { command, backend, events } = setup();
    backend.setScenario({ stream: { chunks: ['a', 'b', 'c'], intervalMs: 10, complete: true } });
    const { task_id } = await command<{ task_id: string }>('start_task', { case_id: FIXTURE.caseA.id, session_epoch: 1, prompt: 'go', parent_task_id: null, viewer_context: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(events.filter(item => item.event === 'agent-progress').map(item => (item.payload as { delta: { text: string } }).delta.text)).toEqual(['a', 'b', 'c']);
    expect(backend.task(task_id)).toMatchObject({ status: 'complete', answer: 'abc' });

    backend.setScenario({ stream: { chunks: ['x', 'y', 'z', 'w'], intervalMs: 10, complete: true } });
    const second = await command<{ task_id: string }>('start_task', { case_id: FIXTURE.caseA.id, session_epoch: 1, prompt: 'stop me', parent_task_id: task_id, viewer_context: null });
    await vi.advanceTimersByTimeAsync(15);
    await command('stop_task', { case_id: FIXTURE.caseA.id, session_epoch: 1, task_id: second.task_id });
    const count = events.filter(item => item.event === 'agent-progress').length;
    await vi.advanceTimersByTimeAsync(100);
    expect(events.filter(item => item.event === 'agent-progress')).toHaveLength(count);
    expect(backend.task(second.task_id)).toMatchObject({ status: 'paused', error: 'Stopped by user', answer: '' });
    expect(backend.task(second.task_id)).toHaveProperty('conversation_id', backend.task(task_id)!.conversation_id);
  });

  it('refuses chat without a text grant and keeps new pool models ungranted on vendor change', async () => {
    const { command, backend } = setup();
    backend.active!.settings.allow_text = false;
    await expect(command('start_task', { case_id: FIXTURE.caseA.id, session_epoch: 1, prompt: 'x', parent_task_id: null })).rejects.toMatch(/may not be sent/);
    await command('save_app_ai_settings', { config: { provider: 'anthropic', execution: 'auto', review: 'standard', pool: [] }, settings: { offline: false, allow_text: true, allow_images: true, model: 'harness-model-beta' } });
    expect(backend.appAi.settings).toMatchObject({ allow_text: false, allow_images: false });
  });

  it('holds a response computed at request time until released, and scripts failures', async () => {
    const { command, backend } = setup();
    backend.hold('case_summary');
    let settled = false;
    const pending = command('case_summary', { case_id: FIXTURE.caseA.id }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    expect(backend.pending('case_summary')).toBe(1);
    expect(backend.release('case_summary')).toBe(1);
    await expect(pending).resolves.toMatchObject({ case_id: FIXTURE.caseA.id });
    backend.fail('case_summary', 'Synthetic failure', 1);
    await expect(command('case_summary', { case_id: FIXTURE.caseA.id })).rejects.toBe('Synthetic failure');
    await expect(command('case_summary', { case_id: FIXTURE.caseA.id })).resolves.toBeTruthy();
    expect(backend.calls('case_summary').map(call => call.outcome)).toEqual(['ok', 'error', 'ok']);
  });

  it('serves pinned historical and current extraction revisions', async () => {
    const { command } = setup();
    const historical = await command<{ text: string; historical?: boolean; locator: string }>('read_extract_revision', { source_id: FIXTURE.statement, revision: 1, start: 5, count: 1 });
    expect(historical).toMatchObject({ historical: true, locator: `evidence:${FIXTURE.statement}#R1L5-L5` });
    expect(historical.text).toContain('about 14:30');
    const current = await command<{ text: string; historical?: boolean }>('read_text', { source_id: FIXTURE.statement, start: 5, count: 1 });
    expect(current.historical).toBeUndefined();
    expect(current.text).toContain('approximately 14:32');
  });
});

describe('placeholders', () => {
  it('labels generated images as synthetic and never fabricates audio or video bytes', () => {
    const image = decodeURIComponent(placeholderUrl('abc', () => 'image'));
    expect(image).toContain('SYNTHETIC PLACEHOLDER');
    expect(placeholderUrl('abc', () => 'video')).toBe('data:,');
    expect(placeholderUrl('abc', () => 'audio')).toBe('data:,');
    expect(decodeURIComponent(placeholderUrl('artifact/page-x-3', () => null))).toContain('page 3');
  });
});
