import { expect, test } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

// Settings persistence and grants: appearance and model choices never widen
// what evidence a model may receive. Model availability is not authorization.

test('theme and density changes issue no IPC and saving does not broaden grants', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await expect(dialog).toBeVisible();
  await lastCall(page, 'app_ai_settings');
  const sections = dialog.getByRole('navigation', { name: 'Settings sections' });

  // Appearance changes are local presentation only: no IPC at all.
  await page.evaluate(() => window.__vislexHarness!.clearCalls());
  await sections.getByRole('button', { name: 'Appearance' }).click();
  await dialog.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await dialog.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect((await calls(page)).map(call => call.action)).toEqual([]);

  // Loading a catalogue is account metadata only and carries the case guard.
  await sections.getByRole('button', { name: 'Accounts & models' }).click();
  const openai = dialog.locator('fieldset.settings-provider').filter({ hasText: 'OpenAI' });
  await openai.getByRole('button', { name: 'Load models' }).click();
  expect((await lastCall(page, 'provider_models')).args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, provider: 'openai' });

  await dialog.getByRole('button', { name: 'Save app AI settings' }).click();
  await expect(dialog).toBeHidden();
  const saved = await lastCall(page, 'save_app_ai_settings');
  // Exactly the previously granted state: nothing is widened by saving.
  expect(saved.args.settings).toEqual({ offline: false, allow_text: true, allow_images: false, model: 'harness-model-alpha' });
  expect(saved.args.config).toMatchObject({ provider: 'openai', pool: [{ provider: 'anthropic', model: 'harness-model-beta', allow_text: true, allow_images: false }] });
  expect(saved.args).not.toHaveProperty('grants_for_provider');
  for (const action of ['save_ai_settings', 'set_direct_media_permission', 'set_case_ai_scope', 'set_case_ai_access_route']) expect(await calls(page, action)).toEqual([]);

  // Theme persisted locally; the case AI indicator is unchanged.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.status-ai')).toContainText('AI permitted · harness-model-alpha');
});

test('selecting a catalogue model in Settings adds it without evidence grants', async ({ page }) => {
  // The option list renders inside the open modal <dialog> (the rest of the
  // document is inert while it is open), so it can be clicked and dismissed.
  await openHarness(page);
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await lastCall(page, 'app_ai_settings');
  const anthropic = dialog.locator('fieldset.settings-provider').filter({ hasText: 'Claude / Anthropic' });
  await anthropic.getByRole('button', { name: 'Add another model' }).click();
  await anthropic.getByRole('button', { name: 'Load models' }).click();
  await lastCall(page, 'provider_models');
  const trigger = anthropic.getByRole('button', { name: 'Claude / Anthropic model 6' });
  // Escape closes only the list, keeps Settings open and returns focus to the trigger.
  await trigger.click();
  await expect(page.getByRole('option', { name: /Harness anthropic large/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option', { name: /Harness anthropic large/ })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('option', { name: /Harness anthropic large/ }).click({ timeout: 3000 });
  await expect(trigger).toContainText(/harness-model-anthropic-large|Harness anthropic large/);
  await expect(anthropic.getByRole('checkbox', { name: 'May receive case text' }).last()).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save app AI settings' }).click();
  const saved = await lastCall(page, 'save_app_ai_settings');
  expect(saved.args.config).toMatchObject({ pool: [
    { provider: 'anthropic', model: 'harness-model-beta', allow_text: true, allow_images: false },
    { provider: 'anthropic', model: 'harness-model-anthropic-large', allow_text: false, allow_images: false },
  ] });
});

test('model availability is not case authorization in the chat model picker', async ({ page }) => {
  await openHarness(page);
  // A configured model without a text grant (as saved by Settings) must not be offered for chat.
  await page.evaluate(() => {
    const api = window.__vislexHarness! as unknown as { backend: { active: { ai_config: { pool: unknown[] } } }; emitCaseEvent: () => void };
    api.backend.active.ai_config.pool.push({ provider: 'gemini', model: 'harness-model-ungranted', allow_text: false, allow_images: false });
    api.emitCaseEvent();
  });
  await expect.poll(async () => (await calls(page, 'snapshot')).length).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Model for your next message' }).click();
  await expect(page.getByRole('option', { name: /harness-model-alpha/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /harness-model-beta/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /harness-model-ungranted/ })).toHaveCount(0);
  await page.getByRole('option', { name: /harness-model-beta/ }).click();
  await page.getByRole('textbox', { name: 'Agent task' }).fill('Which model runs this?');
  await page.getByRole('button', { name: 'Send message' }).click();
  expect((await lastCall(page, 'start_task')).args).toMatchObject({ provider: 'anthropic', model: 'harness-model-beta' });
});

test('a case override saves exactly the grants shown and carries the case guard', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await dialog.getByRole('button', { name: /^This case/ }).click();
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Case permissions' }).click();
  await expect(dialog.getByRole('checkbox', { name: /Case text may be sent/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Case images may be sent/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save case AI override' }).click();
  await expect(dialog).toBeHidden();
  const saved = await lastCall(page, 'save_ai_settings');
  expect(saved.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, settings: { offline: false, allow_text: true, allow_images: false, model: 'harness-model-alpha' } });
  expect(await calls(page, 'set_direct_media_permission')).toEqual([]);
});

test('a failed save keeps the dialog open with the backend error', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__vislexHarness!.fail('save_app_ai_settings', 'Synthetic failure: settings store is read-only'));
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await lastCall(page, 'app_ai_settings');
  await dialog.getByRole('button', { name: 'Save app AI settings' }).click();
  await expect(dialog.getByRole('alert')).toContainText('settings store is read-only');
  await expect(dialog).toBeVisible();
});
