import { expect, test, type Page } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

// Assistant surface interaction checks through the mocked IPC harness: the
// composer, honest streaming and stop states, receipts, disabled reasons,
// citation keyboard access and history motion.

async function startNewChat(page: Page, prompt: string) {
  await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
  await page.getByRole('button', { name: /^New chat/ }).click();
  const composer = page.getByRole('textbox', { name: 'Agent task' });
  await composer.fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  const start = await lastCall(page, 'start_task');
  return (start.result as { task_id: string }).task_id;
}

test.describe('assistant surface', () => {
  test('Shift+Enter adds a line, the composer grows, and Enter sends the whole message', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
    await page.getByRole('button', { name: /^New chat/ }).click();
    const composer = page.getByRole('textbox', { name: 'Agent task' });
    await expect(composer).toBeFocused();
    const before = await composer.evaluate(element => element.getBoundingClientRect().height);
    await composer.pressSequentially('First line of the question');
    for (let line = 2; line <= 4; line++) {
      await composer.press('Shift+Enter');
      await composer.pressSequentially(`Line ${line}`);
    }
    expect(await calls(page, 'start_task')).toHaveLength(0);
    await expect(composer).toHaveValue('First line of the question\nLine 2\nLine 3\nLine 4');
    expect(await composer.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(before);

    await composer.press('Enter');
    const start = await lastCall(page, 'start_task');
    expect(start.args.prompt).toBe('First line of the question\nLine 2\nLine 3\nLine 4');
    await expect(composer).toHaveValue('');
    const turn = page.locator('.conversation-turn').filter({ hasText: 'First line of the question' });
    await expect(turn.locator('.user-message')).toHaveText('First line of the question\nLine 2\nLine 3\nLine 4');
    // The composer shrinks back once the draft is sent.
    await expect.poll(() => composer.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(before + 1);
  });

  test('streaming names the work with real units, and Stop settles to a neutral announced state', async ({ page }) => {
    await openHarness(page);
    const taskId = await startNewChat(page, 'Streaming state check');
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Streaming state check' });
    await expect(turn.getByText('Working', { exact: true })).toBeVisible();
    // Before any delta: a plain waiting line and the run clock, no invented progress.
    await expect(turn.locator('.live-waiting')).toHaveText('Waiting for model output');
    await expect(turn.getByRole('timer')).toContainText('Token usage pending');
    await expect(turn.getByRole('progressbar')).toHaveCount(0);

    await page.evaluate(id => window.__vislexHarness!.streamTask(id, { chunks: ['Streamed ', 'draft ', 'text'], intervalMs: 30, complete: false }), taskId);
    await expect(turn.locator('.live-answer')).toContainText('Streamed draft text');
    await expect(turn.locator('.live-waiting')).toHaveCount(0);
    await expect(turn.getByText('Live draft — not yet citation-validated')).toBeVisible();

    const stop = page.getByRole('button', { name: 'Stop response' });
    await expect(stop).toHaveText('Stop');
    await stop.click();
    expect((await lastCall(page, 'stop_task')).args).toMatchObject({ task_id: taskId, session_epoch: 1 });
    await expect(turn.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(turn.locator('.pill.tone-danger')).toHaveCount(0);
    await expect(turn.locator('.notice.error')).toHaveCount(0);
    await expect(turn.getByRole('button', { name: 'Resume work' })).toBeVisible();
    await expect(page.locator('.agent-panel [aria-live="polite"]')).toHaveText('Response stopped.');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  test('a completed stream is announced once and keeps its reported usage visible', async ({ page }) => {
    await openHarness(page);
    const taskId = await startNewChat(page, 'Completion announcement check');
    await page.evaluate(id => window.__vislexHarness!.completeTask(id, 'Saved synthetic answer.'), taskId);
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Completion announcement check' });
    await expect(turn.getByText('Saved response')).toBeVisible();
    await expect(page.locator('.agent-panel [aria-live="polite"]')).toHaveText('Response saved.');
    await expect(turn.getByRole('timer')).toHaveCount(0);
    await expect(turn.locator('.message-meta')).toContainText(/tokens|Token usage not reported/);
    await expect(page.locator('.chat-bar-meta')).toContainText(/turn/);
  });

  test('activity receipts expand with labelled statuses and exact receipt text', async ({ page }) => {
    await openHarness(page);
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Does the blue bag appear in more than one source?' });
    const toggle = turn.getByRole('button', { name: /^Activity/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(turn.getByRole('button', { name: /3 actions/ })).toHaveAttribute('aria-expanded', 'true');
    const receipts = turn.getByRole('list', { name: 'Recorded actions' });
    await expect(receipts.getByRole('listitem')).toHaveCount(3);
    // Status is an icon plus a word, never colour alone.
    await expect(receipts.getByRole('listitem').filter({ hasText: 'Render page' })).toContainText('Failed');
    await expect(receipts.getByRole('listitem').filter({ hasText: 'Search' })).toContainText('Done');
    await expect(turn.getByRole('button', { name: /1 failed/ })).toBeVisible();
    await receipts.getByText('Render page').click();
    await expect(receipts.getByText('Synthetic failure: page renderer timed out.')).toBeVisible();
    expect((await lastCall(page, 'actions')).args).toMatchObject({ task_id: expect.any(String) });
  });

  test('a failed turn hides raw detail behind a disclosure and retries only through the composer', async ({ page }) => {
    await openHarness(page);
    await page.getByRole('button', { name: /^Which sources mention the grey van/ }).click();
    const turn = page.locator('.conversation-turn').filter({ hasText: 'Which sources mention the grey van?' });
    await expect(turn.getByText('This response did not complete.')).toBeVisible();
    const raw = turn.getByText('Provider returned an error: synthetic rate limit reached. No answer was saved.');
    await expect(raw).toBeHidden();
    await turn.getByText('Show details').click();
    await expect(raw).toBeVisible();
    await expect(turn.locator('.turn-detail')).toContainText('Receipt:');
    await turn.getByRole('button', { name: 'Edit and ask again' }).click();
    await expect(page.getByRole('textbox', { name: 'Agent task' })).toHaveValue('Which sources mention the grey van?');
    await expect(page.getByRole('textbox', { name: 'Agent task' })).toBeFocused();
    expect(await calls(page, 'start_task')).toHaveLength(0);
  });

  test('disabled sending states the reason and the settings section, separately from model availability', async ({ page }) => {
    await openHarness(page);
    await expect(page.getByRole('button', { name: 'Case text permitted' })).toBeVisible();
    await page.evaluate(() => {
      const harness = window.__vislexHarness! as unknown as { backend: { active: { settings: { allow_text: boolean } } }; emitCaseEvent: () => void };
      harness.backend.active.settings.allow_text = false;
      harness.emitCaseEvent();
    });
    const block = page.locator('.composer-block');
    await expect(block).toContainText('This case does not permit sending case text to AI.');
    await expect(block).toContainText('Change this in Settings → Case permissions');
    await expect(page.getByRole('button', { name: 'Case text not permitted' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Should not send');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Agent task' }).press('Enter');
    expect(await calls(page, 'start_task')).toHaveLength(0);
    await block.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
    await expect(dialog).toBeVisible();
    // The stated path is real: This case → Case permissions shows the case text grant.
    await dialog.getByRole('group', { name: 'AI settings scope' }).getByRole('button', { name: /^This case/ }).click();
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Case permissions' }).click();
    await expect(dialog.getByRole('region', { name: 'Case AI permissions' })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /Case text may be sent to permitted models/ })).not.toBeChecked();
    await page.keyboard.press('Escape');

    await page.evaluate(() => {
      const harness = window.__vislexHarness! as unknown as { backend: { active: { settings: { offline: boolean; allow_text: boolean } } }; emitCaseEvent: () => void };
      harness.backend.active.settings.allow_text = true;
      harness.backend.active.settings.offline = true;
      harness.emitCaseEvent();
    });
    await expect(block).toContainText('Offline mode is on, so no AI requests are sent for this case.');
    await expect(page.getByRole('button', { name: 'Offline mode' })).toBeVisible();
  });

  test('citation chips in a saved answer are keyboard reachable and open the exact locator', async ({ page }) => {
    const fx = await openHarness(page);
    const chip = page.getByRole('button', { name: 'Open cited evidence, 6-6' }).first();
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press('Enter');
    const viewer = page.getByRole('main', { name: 'Evidence viewer' });
    await expect(viewer.locator('.viewer-source-header')).toContainText('Email from facilities');
    expect((await calls(page, 'read_text')).at(-1)!.args).toMatchObject({ source_id: fx.email, start: 6 });
  });

  test('only the newly sent turn animates in; history and switches render in place', async ({ page }) => {
    await openHarness(page);
    // openHarness emulates reduced motion; load again with motion allowed.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await expect(page.getByRole('button', { name: /Switch or manage case/ })).toBeVisible();
    await page.evaluate(() => {
      const record = (window as typeof window & { __turnOpacity?: { text: string; opacity: string }[] }).__turnOpacity = [] as { text: string; opacity: string }[];
      new MutationObserver(mutations => {
        for (const mutation of mutations) for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const turns = node.matches('.conversation-turn') ? [node] : [...node.querySelectorAll<HTMLElement>('.conversation-turn')];
          for (const turn of turns) record.push({ text: turn.querySelector('.user-message')?.textContent ?? '', opacity: turn.style.opacity || '1' });
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const inserted = () => page.evaluate(() => (window as typeof window & { __turnOpacity?: { text: string; opacity: string }[] }).__turnOpacity ?? []);

    // Switching conversations mounts history without an entrance animation.
    await page.getByRole('button', { name: /^Summarize the dispatch c/ }).click();
    await page.getByRole('button', { name: /^North entrance timeline/ }).click();
    await expect(page.locator('.conversation-turn')).toHaveCount(2);
    const history = await inserted();
    expect(history.length).toBeGreaterThan(0);
    expect(history.every(entry => entry.opacity === '1')).toBe(true);

    await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Freshly sent turn');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.conversation-turn').filter({ hasText: 'Freshly sent turn' })).toBeVisible();
    const fresh = (await inserted()).filter(entry => entry.text === 'Freshly sent turn');
    expect(fresh.length).toBeGreaterThan(0);
    expect(Number(fresh[0].opacity)).toBeLessThan(1);
    await page.getByRole('button', { name: 'Stop response' }).click();
  });

  test('with reduced motion even the newly sent turn renders without an entrance', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => {
      const record = (window as typeof window & { __turnOpacity?: string[] }).__turnOpacity = [] as string[];
      new MutationObserver(mutations => {
        for (const mutation of mutations) for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.conversation-turn')) record.push(node.style.opacity || '1');
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await startNewChat(page, 'Reduced motion turn');
    await expect(page.locator('.conversation-turn').filter({ hasText: 'Reduced motion turn' })).toBeVisible();
    const opacities = await page.evaluate(() => (window as typeof window & { __turnOpacity?: string[] }).__turnOpacity ?? []);
    expect(opacities.length).toBeGreaterThan(0);
    expect(opacities.every(value => value === '1')).toBe(true);
    await page.getByRole('button', { name: 'Stop response' }).click();
  });
});
