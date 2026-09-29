// Shared helpers for the mocked-IPC harness specs (see e2e/HARNESS.md).
import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);

export type Call = { cmd: string; action: string; args: Record<string, unknown>; at: number; outcome?: string; error?: string; result?: unknown };
export type Fixture = {
  caseA: { id: string; name: string; root: string }; caseB: { id: string; name: string; root: string };
  statement: string; report: string; photo: string; call: string; camera: string; email: string; longName: string; restricted: string; timelineConversation: string;
  jobs: Record<'transcriptRunning' | 'videoIndexRunning' | 'prepareRunning' | 'queued' | 'failed' | 'interrupted', string>;
};

/** Load /harness.html and wait until the real app has rendered the open case. */
export async function openHarness(page: Page, options: { query?: string; colorScheme?: 'dark' | 'light'; waitFor?: 'case' | 'onboarding' } = {}) {
  await page.emulateMedia({ colorScheme: options.colorScheme ?? 'dark', reducedMotion: 'reduce' });
  await page.goto(`/harness.html${options.query ? `?${options.query}` : ''}`);
  await expect(page.locator('html')).toHaveAttribute('data-harness', 'synthetic');
  if ((options.waitFor ?? 'case') === 'case') await expect(page.getByRole('button', { name: /Switch or manage case/ })).toBeVisible();
  return fixture(page);
}

export function fixture(page: Page): Promise<Fixture> {
  return page.evaluate(() => window.__vislexHarness!.fixture as unknown as Fixture);
}

export function calls(page: Page, action?: string): Promise<Call[]> {
  return page.evaluate(name => window.__vislexHarness!.calls(name) as Call[], action);
}

/** The most recent completed call of an action (waits for its response). */
export async function lastCall(page: Page, action: string): Promise<Call> {
  await expect.poll(async () => (await calls(page, action)).filter(call => call.outcome).length, { message: `expected a completed ${action} call` }).toBeGreaterThan(0);
  return (await calls(page, action)).filter(call => call.outcome).at(-1)!;
}

/** Run axe-core (WCAG 2.x A/AA) over the current page state. */
export async function axeViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async () => {
    const axe = (window as typeof window & { axe: { run: (root: Document, options: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[]; failureSummary: string | null }[] }[] }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }));
  });
}

declare global {
  interface Window {
    __vislexHarness?: {
      fixture: unknown;
      calls: (action?: string) => unknown[];
      clearCalls: () => void;
      setScenario: (partial: Record<string, unknown>) => void;
      delay: (action: string, ms: number) => void;
      fail: (action: string, message: string, times?: number) => void;
      clearFailure: (action: string) => void;
      hold: (action: string) => void;
      release: (action: string) => number;
      pending: (action?: string) => number;
      emit: (event: string, payload: unknown) => void;
      emitted: (event?: string) => { event: string; payload: unknown; at: number }[];
      emitCaseEvent: () => void;
      streamTask: (taskId: string, options?: { chunks?: string[]; intervalMs?: number; complete?: boolean }) => void;
      toolCall: (taskId: string, options?: { name?: string; argumentChunks?: string[]; intervalMs?: number }) => void;
      researchStep: (taskId: string, options: { name: string; detail?: string | null; args?: Record<string, unknown>; output?: unknown; recordAfterMs?: number | null; status?: string }) => void;
      completeTask: (taskId: string, answer?: string) => void;
      setJobProgress: (jobId: string, progress: unknown, status?: string) => void;
      setChatPause: (reason: string | null) => void;
      active: () => { id: string; name: string; root: string; session_epoch: number; event_seq: number } | null;
      task: (taskId: string) => { id: string; status: string; error: string; answer: string } | null;
    };
  }
}
