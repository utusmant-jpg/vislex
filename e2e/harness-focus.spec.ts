// Keyboard focus and forced-colours behaviour through the mocked-IPC harness.
// Each test pins a reviewed defect where focus fell to <body>, a control had no
// visible focus, or one key press did two things. Everything here is synthetic.
import { expect, test, type Page } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

const activeTag = (page: Page) => page.evaluate(() => {
  const active = document.activeElement;
  return active ? `${active.tagName}${active.getAttribute('role') ? `[role=${active.getAttribute('role')}]` : ''}` : 'NONE';
});

async function openThreeFiles(page: Page) {
  await page.keyboard.press('Control+2');
  const rows = page.getByRole('list', { name: 'Sources' }).getByRole('listitem');
  for (const index of [0, 1, 2]) await rows.nth(index).click();
  const fileTabs = page.getByRole('tablist', { name: 'Open files' });
  await expect(fileTabs.getByRole('tab')).toHaveCount(3);
  return fileTabs;
}

test('every way of closing a file tab keeps keyboard focus on a tab or the workspace', async ({ page }) => {
  await openHarness(page);
  const fileTabs = await openThreeFiles(page);
  // Ctrl+W on the focused (selected) tab.
  await fileTabs.getByRole('tab', { selected: true }).focus();
  await page.keyboard.press('Control+w');
  await expect(fileTabs.getByRole('tab')).toHaveCount(2);
  await expect(fileTabs.getByRole('tab', { selected: true })).toBeFocused();
  // The tab context menu's Close.
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Actions' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: /^Close/ }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fileTabs.getByRole('tab')).toHaveCount(1);
  await expect(fileTabs.getByRole('tab', { selected: true })).toBeFocused();
  // Delete on the last tab hides the viewer: focus goes to the current workspace's rail button.
  await page.keyboard.press('Delete');
  await expect(page.getByRole('main', { name: 'Evidence viewer', includeHidden: true })).toBeHidden();
  await expect(page.locator('.rail .rail-button.active')).toBeFocused();
  expect(await activeTag(page)).not.toBe('BODY');
});

test('Alt+Arrow on a focused tab moves the tab only, not the location history as well', async ({ page }) => {
  await openHarness(page);
  const fileTabs = await openThreeFiles(page);
  const tabs = fileTabs.getByRole('tab');
  const titles = await Promise.all([0, 1, 2].map(index => tabs.nth(index).getAttribute('title')));
  // Make the history order differ from the tab order: ..., first, third.
  await tabs.nth(0).click();
  await tabs.nth(2).click();
  await tabs.nth(2).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  // The tablist handled the key: the previous tab is selected and focused
  // (history alone would have gone back to the first file).
  await expect(fileTabs.getByRole('tab', { selected: true })).toHaveAttribute('title', titles[1]!);
  await expect(fileTabs.getByRole('tab', { selected: true })).toBeFocused();
  // Away from a widget that uses arrows, Alt+ArrowLeft still walks the history.
  await page.getByRole('button', { name: 'Previous location' }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(fileTabs.getByRole('tab', { selected: true })).toHaveAttribute('title', titles[2]!);
});

test('an error raised while a modal dialog is open appears inside it and can be dismissed', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__vislexHarness!.fail('rename', 'Synthetic rename failure', 1));
  await page.locator('.matter-identity').click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('textbox').fill('Renamed synthetic case');
  await dialog.getByRole('button', { name: 'Save name' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Synthetic rename failure');
  await alert.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test('sending and stopping from the keyboard leave focus in the composer', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
  await page.getByRole('button', { name: /^New chat/ }).click();
  await page.getByRole('textbox', { name: 'Agent task' }).fill('Focus after send check');
  await page.getByRole('button', { name: 'Send message' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Agent task' })).toBeFocused();
  await page.getByRole('button', { name: 'Stop response' }).focus();
  await page.keyboard.press('Enter');
  expect((await lastCall(page, 'stop_task')).outcome).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Agent task' })).toBeFocused();
  expect(await calls(page, 'start_task')).toHaveLength(1);
});

test('checkboxes and radios show a solid focus ring, including under forced colours', async ({ page }) => {
  await openHarness(page);
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Case permissions' }).click();
  const checkbox = dialog.getByRole('checkbox').first();
  await checkbox.focus();
  // Keyboard modality: move away and back with Tab so :focus-visible applies.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(checkbox).toBeFocused();
  const ring = () => checkbox.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: style.outlineWidth }; });
  expect(await ring()).toEqual({ style: 'solid', width: '2px' });
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await ring()).toEqual({ style: 'solid', width: '2px' });
});

test('under forced colours the highlighted menu item has its own outline', async ({ page }) => {
  await openHarness(page);
  await page.emulateMedia({ forcedColors: 'active' });
  await openThreeFiles(page);
  await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { selected: true }).focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  const items = page.getByRole('menu', { name: 'Actions' }).getByRole('menuitem');
  const outline = (index: number) => items.nth(index).evaluate(element => getComputedStyle(element).outlineStyle);
  expect(await outline(0)).toBe('solid');
  expect(await outline(1)).toBe('none');
});

test('a cancelled job states its reason neutrally, not as an error alert', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+5');
  const card = page.locator('.job-card').filter({ hasText: fx.jobs.prepareRunning });
  await card.getByRole('button', { name: 'Cancel' }).click();
  expect((await lastCall(page, 'cancel_processing')).args).toMatchObject({ job_id: fx.jobs.prepareRunning });
  await expect(card.getByText('Processing cancelled before publication')).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.locator('.job-error')).toHaveCount(0);
});
