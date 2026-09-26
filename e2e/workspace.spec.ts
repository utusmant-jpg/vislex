import { expect, test } from '@playwright/test';

test('theme, workspace navigation, and case-independent settings', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await expect(page.getByRole('heading', { name: 'Harbor Street · sample case' })).toBeVisible();
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
  await expect(page.locator('.library-row')).toHaveCount(1);
  await page.keyboard.press('Control+3');
  await expect(page.getByRole('heading', { name: 'Findings & clock proposals' })).toBeVisible();
  await page.keyboard.press('Control+4');
  await expect(page.getByRole('heading', { name: 'Investigation workbench' })).toBeVisible();
  await page.keyboard.press('Control+5');
  await expect(page.getByRole('heading', { name: 'Jobs & issues' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workspace-light.png') });
});

test('narrow navigation and command palette remain reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Show navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Show navigation' }).click();
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeVisible();
  await expect(page.getByRole('option', { name: /Open settings/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('workspace-narrow.png') });
});

test('workspace has no page-level horizontal overflow at target desktop sizes', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  for (const [width, height] of [[1000, 680], [1280, 720], [1500, 960], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    for (const shortcut of ['Control+1', 'Control+2', 'Control+3', 'Control+4', 'Control+5']) {
      await page.keyboard.press(shortcut);
      const extent = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      expect(extent.content, `${width}×${height} ${shortcut}: ${JSON.stringify(extent)}`).toBeLessThanOrEqual(extent.viewport);
    }
    await page.locator('.workspace-view').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}x${height}.png`) });
  }
});

test('System appearance follows OS changes and reduced motion disables workspace animation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
  expect(await page.locator('.workspace-view').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});

test('case lifecycle dialogs keep validation and return keyboard focus', async ({ page }) => {
  await page.goto('/');
  const create = page.getByRole('button', { name: /Create a case/ });
  await create.click();
  const createDialog = page.getByRole('dialog', { name: 'Create a local case' });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await createDialog.getByRole('textbox', { name: 'Case name' }).fill('Synthetic matter');
  await expect(createDialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(createDialog).toBeHidden();
  await expect(create).toBeFocused();
  const restore = page.getByRole('button', { name: /Restore a backup/ });
  await restore.click();
  const restoreDialog = page.getByRole('dialog', { name: 'Restore a case' });
  await expect(restoreDialog).toBeVisible();
  await expect(restoreDialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await restoreDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(restoreDialog).toBeHidden();
  await expect(restore).toBeFocused();
});

test('narrow source inspection has an explicit return without losing selection', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.goto('/');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
  await page.locator('.library-row').first().click();
  await expect(page.locator('.main-panel')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeHidden();
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
  await expect(page.locator('.main-panel')).toBeHidden();
  await page.locator('.library-row').first().click();
  await expect(page.locator('.main-panel')).toBeVisible();
});

test('forced-colors mode keeps workspace selection and primary controls visible', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
  const activeRail = page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Evidence' });
  await expect(activeRail).toHaveAttribute('aria-current', 'true');
  expect(await activeRail.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
});

test('review views have keyboard tabs and preserve legal form values', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await page.keyboard.press('Control+4');
  const tabs = page.getByRole('tablist', { name: 'Investigation views' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No question dossiers yet' })).toBeVisible();
  const discrepancy = tabs.getByRole('tab', { name: 'Discrepancies' });
  await expect(discrepancy).toHaveAttribute('aria-selected', 'true');
  await discrepancy.focus();
  await page.keyboard.press('End');
  const legal = tabs.getByRole('tab', { name: 'Legal workflows' });
  await expect(legal).toBeFocused();
  await expect(legal).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Jurisdiction' }).fill('Ontario');
  await legal.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Coverage' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(legal).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Jurisdiction' })).toHaveValue('Ontario');
  await page.setViewportSize({ width: 1000, height: 680 });
  const extent = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(extent.content).toBeLessThanOrEqual(extent.viewport);
});

test('synthetic case refresh stays quiet after its background summary poll', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await page.waitForTimeout(3500);
  await expect(page.getByText('Case refresh failed')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Harbor Street · sample case' })).toBeVisible();
});
