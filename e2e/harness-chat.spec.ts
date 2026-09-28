import { expect, test } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

// Drives the real AgentPanel with native === true through the mocked IPC.

test.describe('chat through the mocked IPC harness', () => {
  test('compose, send, stream tokens and stop with the exact case guard', async ({ page }) => {
    const fx = await openHarness(page);
    await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
    await page.getByRole('button', { name: /^New chat/ }).click();
    const composer = page.getByRole('textbox', { name: 'Agent task' });
    await expect(composer).toBeFocused();
    await composer.fill('Harness question about the north entrance');
    await page.getByRole('button', { name: 'Send message' }).click();

    const start = await lastCall(page, 'start_task');
    expect(start.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, prompt: 'Harness question about the north entrance', provider: 'openai', model: 'harness-model-alpha', parent_task_id: null });
    const taskId = (start.result as { task_id: string }).task_id;
    const stop = page.getByRole('button', { name: 'Stop response' });
    await expect(stop).toBeVisible();
    await expect(composer).toHaveValue('');

    await page.evaluate(id => window.__vislexHarness!.streamTask(id, { chunks: ['Synthetic ', 'streamed ', 'tokens ', 'arrive ', 'one ', 'chunk ', 'at ', 'a ', 'time ', 'for ', 'the ', 'harness ', 'and ', 'keep ', 'arriving ', 'until ', 'the ', 'user ', 'presses ', 'stop.'], intervalMs: 150, complete: false }), taskId);
    const live = page.locator('.live-answer');
    await expect(live).toContainText('Synthetic streamed');
    await expect(page.getByText('Live draft — not yet citation-validated')).toBeVisible();
    // Real providers send plain text deltas as { text } only, so no
    // function-call "characters received" row appears while text streams.
    await expect(page.locator('.activity-live')).toHaveCount(0);
    const early = (await live.innerText()).length;
    await expect.poll(async () => (await live.innerText()).length).toBeGreaterThan(early);

    await stop.click();
    const stopCall = await lastCall(page, 'stop_task');
    expect(stopCall.args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, task_id: taskId });
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(live).toHaveCount(0);
    expect(await page.evaluate(id => window.__vislexHarness!.task(id)?.status, taskId)).toBe('paused');
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Harness question about the north entrance' });
    // The backend pauses the task with "Stopped by user"; the chat labels it Stopped.
    await expect(turn.getByText('Stopped', { exact: true })).toBeVisible();
    // A user stop is not reported as a failure state.
    await expect(turn.getByText('Needs attention')).toHaveCount(0);
    // desktop.rs notices the stop by polling every 150 ms while the provider
    // keeps streaming, so deltas for the stopped task can still arrive (the
    // harness sends one by default). Deliver more with the current case and
    // epoch and check the app does not revive the live draft from them.
    await page.evaluate(({ id, caseId }) => {
      const harness = window.__vislexHarness!;
      const sent = harness.emitted('agent-progress').at(-1)!.payload as { transmission_id: string };
      harness.emit('agent-progress', { case_id: caseId, session_epoch: 1, task_id: id, transmission_id: sent.transmission_id, delta: { text: 'LATE-DELTA-AFTER-STOP ' } });
    }, { id: taskId, caseId: fx.caseA.id });
    await page.waitForTimeout(400);
    await expect(live).toHaveCount(0);
    await expect(page.getByText('LATE-DELTA-AFTER-STOP')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  test('a scripted tool call shows the function-call activity with real byte counts', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
    await page.getByRole('button', { name: /^New chat/ }).click();
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Tool activity check');
    await page.getByRole('button', { name: 'Send message' }).click();
    const taskId = ((await lastCall(page, 'start_task')).result as { task_id: string }).task_id;
    // OpenAI Responses shape: { activity: <tool name> } then { characters } per
    // argument chunk ('{"terms":["north' + ' entrance"],' + '"offset":0}' = 39 bytes).
    await page.evaluate(id => window.__vislexHarness!.toolCall(id, { name: 'search_passages', intervalMs: 40 }), taskId);
    // The requested tool is named in plain words (search_passages → searching).
    await expect(page.locator('.activity-live')).toHaveText('Searching the evidence · 39 characters received');
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.locator('.activity-live')).toHaveCount(0);
  });

  test('user stop renders as a neutral stopped state, not an error alert', async ({ page }) => {
    // Formerly a known issue (every task error, including the backend's
    // "Stopped by user" pause reason, rendered as `.notice.error` role="alert").
    // The assistant redesign renders a user stop neutrally, so test.fail is removed.
    await openHarness(page);
    await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
    await page.getByRole('button', { name: /^New chat/ }).click();
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Stop me neutrally');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Stop response' }).click();
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Stop me neutrally' });
    await expect(turn.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(turn.getByText('Stopped by user.')).toBeVisible();
    await expect(turn.getByRole('alert')).toHaveCount(0, { timeout: 2000 });
  });

  test('a streamed follow-up completes into a saved answer with citations', async ({ page }) => {
    const fx = await openHarness(page);
    await expect(page.locator('.chat-heading')).toHaveText('North entrance timeline (SYNTHETIC)');
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Follow up on the bag colour');
    await page.getByRole('textbox', { name: 'Agent task' }).press('Enter');
    const start = await lastCall(page, 'start_task');
    expect(start.args.parent_task_id).toBeTruthy();
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Follow up on the bag colour' });
    await expect(turn.locator('.live-answer')).toContainText('Synthetic streamed answer');
    await expect(turn.getByText('Saved response')).toBeVisible({ timeout: 10_000 });
    await expect(turn.locator('.live-answer')).toHaveCount(0);
    await expect(turn.getByRole('button', { name: 'Open cited evidence, rev 2 · 5–5' })).toBeVisible();
    await expect(turn.locator('.message-meta')).toContainText('tokens');
    expect((await calls(page, 'start_task')).every(call => call.args.case_id === fx.caseA.id && call.args.session_epoch === 1)).toBe(true);
  });

  test('citation chips open the exact cited locator, including historical revisions', async ({ page }) => {
    const fx = await openHarness(page);
    const viewer = page.getByRole('main', { name: 'Evidence viewer' });

    await page.getByRole('button', { name: 'Open cited evidence, rev 1 · 5–5' }).first().click();
    await expect(viewer.locator('.viewer-source-header')).toContainText('Witness statement W-01');
    await expect(viewer.getByRole('note')).toContainText('Historical extraction revision 1');
    await expect(viewer.locator('.document-provenance')).toContainText('Revision 1 · Lines 5–');
    await expect(viewer.locator('.text-line[data-line="5"]')).toContainText('At about 14:30');
    const historical = (await calls(page, 'read_extract_revision')).filter(call => call.args.count === 200).at(-1)!;
    expect(historical.args).toMatchObject({ source_id: fx.statement, revision: 1, start: 5 });
    // The statement is older than the first snapshot page, so the app fetched it by id.
    expect((await lastCall(page, 'source_detail')).args).toEqual({ case_id: fx.caseA.id, source_id: fx.statement });

    await page.getByRole('button', { name: 'Open cited evidence, rev 2 · 5–5' }).first().click();
    await expect(viewer.locator('.text-line[data-line="5"]')).toContainText('approximately 14:32');
    // A pinned R2 locator is read through read_extract_revision (never read_text).
    expect((await calls(page, 'read_extract_revision')).filter(call => call.args.count === 200).at(-1)!.args).toMatchObject({ source_id: fx.statement, revision: 2, start: 5 });

    await page.getByRole('button', { name: 'Open cited evidence, 6-6' }).first().click();
    await expect(viewer.locator('.viewer-source-header')).toContainText('Email from facilities');
    expect((await calls(page, 'read_text')).at(-1)!.args).toMatchObject({ source_id: fx.email, start: 6 });
    await expect(viewer.locator('.text-line[data-line="6"]')).toContainText('two openings');

    await page.getByRole('button', { name: 'Open cited evidence, Image' }).first().click();
    const image = viewer.getByRole('img', { name: /Original evidence: 03 · Scene photograph/ });
    await expect(image).toBeVisible();
    // Original evidence pixels are never recoloured, filtered or blended.
    expect(await image.evaluate(element => { const style = getComputedStyle(element); return [style.filter, style.mixBlendMode, style.opacity]; })).toEqual(['none', 'normal', '1']);

    // History navigation walks back through the exact locators that were opened.
    await page.getByRole('button', { name: 'Previous location' }).click();
    await expect(viewer.locator('.viewer-source-header')).toContainText('Email from facilities');
  });

  test('a citation pinned to the current revision is not labelled as superseded wording', async ({ page }) => {
    // case.rs read_text_revision reports historical only when another revision
    // is active, and the viewer also compares the pinned revision with
    // extract_history's active revision. R2 is the active revision of W-01, so
    // a citation pinned to it is shown as current wording.
    const fx = await openHarness(page);
    const viewer = page.getByRole('main', { name: 'Evidence viewer' });
    await page.getByRole('button', { name: 'Open cited evidence, rev 2 · 5–5' }).first().click();
    await expect(viewer.locator('.text-line[data-line="5"]')).toContainText('approximately 14:32');
    expect((await lastCall(page, 'extract_history')).args).toEqual({ source_id: fx.statement });
    await expect(viewer.getByText('Rev 2 · current')).toBeVisible();
    await expect(viewer.getByText(/Historical extraction revision/)).toHaveCount(0, { timeout: 2000 });
    // A real historical revision keeps its banner verbatim.
    await page.getByRole('button', { name: 'Open cited evidence, rev 1 · 5–5' }).first().click();
    await expect(viewer.getByRole('note')).toContainText('Historical extraction revision 1 — superseded wording preserved; this is not the current active text.');
  });

  test('an unsent draft survives a workspace switch and never reaches browser storage', async ({ page }) => {
    await openHarness(page);
    const composer = page.getByRole('textbox', { name: 'Agent task' });
    const draft = 'Unsent harness draft about the grey van';
    await composer.fill(draft);
    const rail = page.getByRole('navigation', { name: 'Workspaces' });
    await rail.getByRole('button', { name: 'Evidence' }).click();
    await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
    await rail.getByRole('button', { name: 'Chat' }).click();
    await expect(composer).toHaveValue(draft);

    // Drafts are per conversation: another chat starts empty, returning restores it.
    await page.getByRole('button', { name: /^Summarize the dispatch c/ }).click();
    await expect(composer).toHaveValue('');
    await page.getByRole('button', { name: /^North entrance timeline/ }).click();
    await expect(composer).toHaveValue(draft);

    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('grey van');
  });

  test('chat stays blocked while case preparation pauses it', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => window.__vislexHarness!.setChatPause('Preparing case files'));
    await expect(page.getByText('Preparing case files before chat is available.')).toBeVisible({ timeout: 8000 });
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Should not send yet');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await page.evaluate(() => window.__vislexHarness!.setChatPause(null));
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 8000 });
  });
});
