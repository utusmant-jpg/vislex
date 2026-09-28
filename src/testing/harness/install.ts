// Installs the synthetic backend behind @tauri-apps/api's IPC so the real app
// code paths that require `native === true` can run in a plain browser.
//
// Must run BEFORE src/bridge.ts is evaluated: bridge computes `native` once at
// module load from isTauri(), which reads globalThis.isTauri.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { SyntheticBackend, type Scenario, type StreamOptions } from './backend';
import { FIXTURE } from './fixtures';
import { placeholderUrl } from './placeholders';

type Internals = { invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>; convertFileSrc?: (path: string, protocol?: string) => string };

export type HarnessApi = {
  fixture: typeof FIXTURE;
  backend: SyntheticBackend;
  setScenario: (partial: Partial<Scenario>) => void;
  delay: (action: string, ms: number) => void;
  fail: (action: string, message: string, times?: number) => void;
  clearFailure: (action: string) => void;
  hold: (action: string) => void;
  release: (action: string) => number;
  pending: (action?: string) => number;
  calls: (action?: string) => { cmd: string; action: string; args: Record<string, unknown>; at: number; outcome?: string; error?: string; result?: unknown }[];
  clearCalls: () => void;
  emit: (event: string, payload: unknown) => void;
  emitted: (event?: string) => { event: string; payload: unknown; at: number }[];
  emitCaseEvent: () => void;
  streamTask: (taskId: string, options?: StreamOptions) => void;
  toolCall: SyntheticBackend['toolCall'];
  completeTask: (taskId: string, answer?: string) => void;
  setJobProgress: SyntheticBackend['setJobProgress'];
  setChatPause: (reason: string | null) => void;
  active: () => ReturnType<SyntheticBackend['activeSummary']>;
  task: (taskId: string) => ReturnType<SyntheticBackend['task']>;
};

declare global { interface Window { __vislexHarness?: HarnessApi } }

export function installHarness(options: { startWith?: 'A' | 'none'; sourceCount?: number } = {}): HarnessApi {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  mockWindows('main');
  const internals = () => (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  // Events go through the mocked event plugin so listen()/unlisten() behave as in Tauri.
  const emit = (event: string, payload: unknown) => { void internals().invoke('plugin:event|emit', { event, payload }); };
  const backend = new SyntheticBackend(emit, options);
  mockIPC((cmd, payload) => backend.handle(cmd, payload as Record<string, unknown> | undefined), { shouldMockEvents: true });
  internals().convertFileSrc = (path: string) => placeholderUrl(path, id => [...backend.cases.values()].flatMap(item => item.sources).find(source => source.id === id)?.kind ?? null);

  const api: HarnessApi = {
    fixture: FIXTURE,
    backend,
    setScenario: partial => backend.setScenario(partial),
    delay: (action, ms) => backend.delay(action, ms),
    fail: (action, message, times) => backend.fail(action, message, times),
    clearFailure: action => backend.clearFailure(action),
    hold: action => backend.hold(action),
    release: action => backend.release(action),
    pending: action => backend.pending(action),
    calls: action => backend.calls(action),
    clearCalls: () => backend.clearCalls(),
    emit,
    emitted: event => backend.emitted.filter(item => !event || item.event === event),
    emitCaseEvent: () => backend.caseChanged(),
    streamTask: (taskId, streamOptions) => backend.streamTask(taskId, streamOptions),
    toolCall: (taskId, toolOptions) => backend.toolCall(taskId, toolOptions),
    completeTask: (taskId, answer) => backend.completeTask(taskId, answer),
    setJobProgress: (jobId, progress, status) => backend.setJobProgress(jobId, progress, status),
    setChatPause: reason => backend.setChatPause(reason),
    active: () => backend.activeSummary(),
    task: taskId => backend.task(taskId),
  };
  window.__vislexHarness = api;
  return api;
}
