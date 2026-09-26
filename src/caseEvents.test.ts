import { afterEach, expect, it, vi } from 'vitest';
import { subscribeCaseChanges } from './caseEvents';

afterEach(() => vi.useRealTimers());

function fixture() {
  const callbacks = new Map<string, (event: { payload: unknown }) => void>();
  const listen = async (name: string, callback: (event: { payload: unknown }) => void) => {
    callbacks.set(name, callback);
    return () => { callbacks.delete(name); };
  };
  const emit = (name: string, payload: unknown = null) => callbacks.get(name)?.({ payload });
  return { listen, emit, callbacks };
}

it('refreshes once for the active session, ignores stale envelopes, and discovers a newer case', async () => {
  vi.useFakeTimers();
  const bus = fixture();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const summary = vi.fn().mockResolvedValue(undefined);
  const stop = await subscribeCaseChanges(bus.listen, () => ({ id: 'case-a', session_epoch: 3, event_seq: 5 }), refresh, summary);
  bus.emit('case-event', { case_id: 'case-a', session_epoch: 3, event_seq: 6 });
  bus.emit('case-changed');
  expect(refresh).toHaveBeenCalledTimes(1);
  bus.emit('case-event', { case_id: 'case-a', session_epoch: 3, event_seq: 6 });
  bus.emit('case-changed');
  bus.emit('case-event', { case_id: 'case-a', session_epoch: 1, event_seq: 7 });
  bus.emit('case-changed');
  bus.emit('case-event', { case_id: 'case-b', session_epoch: 3, event_seq: 8 });
  bus.emit('case-changed');
  expect(refresh).toHaveBeenCalledTimes(1);
  bus.emit('case-event', { case_id: 'case-b', session_epoch: 5, event_seq: 9 });
  bus.emit('case-changed');
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(summary).not.toHaveBeenCalled();
  stop();
  expect(bus.callbacks.size).toBe(0);
});

it('discovers a case opened through the native bridge before React has a snapshot', async () => {
  const bus = fixture();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const stop = await subscribeCaseChanges(bus.listen, () => null, refresh, vi.fn());
  bus.emit('case-event', { case_id: 'new-case', session_epoch: 1, event_seq: 1 });
  bus.emit('case-changed');
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});

it('reconciles a sequence gap with a bounded summary before refreshing', async () => {
  const bus = fixture();
  let active = { id: 'case-a', session_epoch: 3, event_seq: 5 };
  let resolveSummary!: () => void;
  const summary = vi.fn(() => new Promise<void>(resolve => { resolveSummary = resolve; }));
  const refresh = vi.fn().mockResolvedValue(undefined);
  const stop = await subscribeCaseChanges(bus.listen, () => active, refresh, summary);
  bus.emit('case-event', { case_id: 'case-a', session_epoch: 3, event_seq: 9 });
  expect(summary).toHaveBeenCalledWith('case-a', 3);
  expect(refresh).not.toHaveBeenCalled();
  resolveSummary();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  bus.emit('case-event', { case_id: 'case-a', session_epoch: 3, event_seq: 11 });
  active = { id: 'case-b', session_epoch: 5, event_seq: 12 };
  resolveSummary();
  await Promise.resolve();
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});

it('keeps a delayed fallback for older case-changed-only builds', async () => {
  vi.useFakeTimers();
  const bus = fixture();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const stop = await subscribeCaseChanges(bus.listen, () => ({ id: 'case-a', session_epoch: 3, event_seq: 5 }), refresh, vi.fn());
  bus.emit('case-changed');
  expect(refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});
