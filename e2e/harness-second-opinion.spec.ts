import { expect, test, type Page } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

async function openDispatchCall(page: Page) {
  await page.keyboard.press('Control+2');
  for (const shown of [100, 150, 200, 250]) {
    await page.getByRole('button', { name: 'Load more sources' }).click();
    await expect(page.getByText(`${shown} shown of 250`)).toBeVisible();
  }
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill('Dispatch call recording 14-31');
  await page.getByRole('list', { name: 'Sources' }).getByRole('listitem').first().click();
}

// The optional second opinion: local triage works without any permission;
// sending needs the per-case grant and a confirmed preview; the transcript
// only changes through the reviewer's decision.
test('uncertain spans can be triaged locally and sent only after the grant and a confirmed preview', async ({ page }) => {
  const fx = await openHarness(page);
  const viewer = page.getByRole('main', { name: 'Evidence viewer' });
  await openDispatchCall(page);
  const panel = viewer.getByRole('region', { name: 'Second opinion on uncertain audio' });

  await panel.getByRole('button', { name: 'Find uncertain spans' }).click();
  await expect(panel).toContainText('2 spans from 2 flagged of 60 segments');
  await expect(panel).toContainText('Sending a clip for a second opinion is off for this case');
  await expect(panel.getByRole('button', { name: 'Prepare clip' })).toHaveCount(0);
  expect(await calls(page, 'prepare_second_opinion')).toEqual([]);

  // Allow it for this case in Settings → Privacy & offline.
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Privacy & offline' }).click();
  const card = dialog.getByRole('region', { name: 'Second opinion on uncertain audio' });
  await expect(card).toContainText('Off for this case.');
  await card.getByRole('button', { name: 'Allow for this case' }).click();
  await expect(card).toContainText('Allowed for this case: OpenRouter');
  expect((await lastCall(page, 'set_second_opinion_grant')).args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, vendor: 'openrouter', model: 'google/gemini-2.5-flash' });
  await page.keyboard.press('Escape');

  await panel.getByRole('button', { name: 'Refresh' }).click();
  await panel.getByRole('button', { name: 'Prepare clip' }).first().click();
  const preview = panel.getByRole('group', { name: 'Second opinion preview' });
  await expect(preview).toContainText('What leaves this machine');
  await expect(preview).toContainText('no file name, tags or case text');
  await expect(preview).toContainText('Cancelling may not stop billing');
  expect(await calls(page, 'send_second_opinion')).toEqual([]);

  await preview.getByRole('button', { name: 'Send for second opinion' }).click();
  const result = panel.getByRole('group', { name: 'Second opinion result' });
  await expect(result).toContainText('Received · unreviewed');
  await expect(result).toContainText('Unreviewed remote machine interpretation');
  await expect(result.getByRole('table')).toContainText('SYNTHETIC second opinion for segment 5.');
  await expect(result.getByRole('table')).toContainText('fictional line 5 of the dispatch call.');
  await result.getByRole('button', { name: 'Use second opinion' }).click();
  await expect(result).toContainText('Decision recorded: second opinion used as an accepted correction.');
  expect((await lastCall(page, 'decide_second_opinion')).args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, decision: 'accepted_remote' });
});
