import { expect, test, type Page } from '@playwright/test';
import { calls, lastCall, openHarness, type Fixture } from './harness-support';

// Case switching with responses that arrive after the switch. The harness
// computes each response when the request is made (as the native dispatcher
// does) and holds its delivery until released.

async function switchToRiverside(page: Page, fx: Fixture) {
  await page.getByRole('button', { name: /Switch or manage case/ }).click();
  await page.getByRole('menuitem', { name: 'Open a case folder…' }).click();
  await expect(page.getByRole('button', { name: `Switch or manage case (current: ${fx.caseB.name})` })).toBeVisible();
  await expect(page.getByRole('heading', { name: fx.caseB.name })).toBeVisible();
}

test('late responses from the previous case are discarded after a switch', async ({ page }) => {
  const fx = await openHarness(page);

  // 1. A text search is in flight when the user switches case.
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: /Search case/ });
  await search.fill('north entrance');
  await page.evaluate(() => window.__vislexHarness!.hold('hybrid_search'));
  await search.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.__vislexHarness!.pending('hybrid_search'))).toBe(1);
  expect((await calls(page, 'hybrid_search'))[0].args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, query: 'north entrance' });
  await page.keyboard.press('Escape');

  // 2. A conversation detail for case A is also still in flight.
  await page.evaluate(() => window.__vislexHarness!.hold('conversation_detail'));
  await page.getByRole('button', { name: /^Summarize the dispatch c/ }).click();
  await expect.poll(() => page.evaluate(() => window.__vislexHarness!.pending('conversation_detail'))).toBeGreaterThan(0);

  await switchToRiverside(page, fx);
  const open = await lastCall(page, 'open_case');
  expect(open.args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, path: fx.caseB.root });
  expect(await page.evaluate(() => window.__vislexHarness!.active()?.session_epoch)).toBe(2);

  // Deliver the stale responses now.
  expect(await page.evaluate(() => window.__vislexHarness!.release('hybrid_search'))).toBe(1);
  expect(await page.evaluate(() => window.__vislexHarness!.release('conversation_detail'))).toBeGreaterThan(0);
  await page.waitForTimeout(300);

  // Case B shows none of case A's conversation or search results.
  await expect(page.getByText('Summarize the dispatch call recording')).toHaveCount(0);
  await expect(page.getByText('No conversations yet. Ask your first question.')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('group', { name: 'Text & meaning' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /Witness statement W-01/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A late response never re-points case B at case A's conversation.
  expect(await page.evaluate(id => localStorage.getItem(`vislex-conversation:${id}`), fx.caseB.id)).toBeNull();
});

test('stale case events and agent deltas from the previous session are ignored', async ({ page }) => {
  const fx = await openHarness(page);
  await switchToRiverside(page, fx);
  await page.waitForTimeout(300);
  const snapshots = async () => (await calls(page, 'snapshot')).length;

  // A case-event stamped with case A's epoch must not refresh case B.
  const before = await snapshots();
  await page.evaluate(caseA => window.__vislexHarness!.emit('case-event', { case_id: caseA, session_epoch: 1, event_seq: 10_000 }), fx.caseA.id);
  await page.waitForTimeout(400);
  expect(await snapshots()).toBe(before);

  // The current session's next event does refresh.
  await page.evaluate(() => window.__vislexHarness!.emitCaseEvent());
  await expect.poll(snapshots).toBeGreaterThan(before);

  // Start a chat in case B, then deliver agent deltas addressed to case A's session.
  await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
  await page.getByRole('textbox', { name: 'Agent task' }).fill('Riverside question');
  await page.getByRole('button', { name: 'Send message' }).click();
  const start = await lastCall(page, 'start_task');
  expect(start.args).toMatchObject({ case_id: fx.caseB.id, session_epoch: 2 });
  const taskId = (start.result as { task_id: string }).task_id;
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.evaluate(([task, caseA]) => {
    window.__vislexHarness!.emit('agent-progress', { case_id: caseA, session_epoch: 1, task_id: task, transmission_id: 'stale', delta: { text: 'LEAKED FROM CASE A', characters: 18 } });
  }, [taskId, fx.caseA.id] as const);
  await page.evaluate(([task, caseB]) => {
    window.__vislexHarness!.emit('agent-progress', { case_id: caseB, session_epoch: 1, task_id: task, transmission_id: 'stale-epoch', delta: { text: 'LEAKED FROM OLD EPOCH', characters: 21 } });
  }, [taskId, fx.caseB.id] as const);
  await page.evaluate(task => window.__vislexHarness!.streamTask(task, { chunks: ['Riverside ', 'delta ', 'arrives.'], intervalMs: 60, complete: false }), taskId);
  await expect(page.locator('.live-answer')).toContainText('Riverside delta arrives.');
  await expect(page.getByText(/LEAKED FROM/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});

test('switching is refused while a task runs, and the error is surfaced', async ({ page }) => {
  const fx = await openHarness(page);
  await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
  await page.getByRole('textbox', { name: 'Agent task' }).fill('Long running question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.getByRole('button', { name: /Switch or manage case/ }).click();
  await page.getByRole('menuitem', { name: 'Open a case folder…' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toBeVisible();
  expect((await lastCall(page, 'open_case')).error).toContain('Stop active tasks');
  await expect(page.getByRole('button', { name: `Switch or manage case (current: ${fx.caseA.name})` })).toBeVisible();
});
