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
