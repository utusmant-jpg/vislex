import { expect, test } from '@playwright/test';
import { openHarness } from './harness-support';

// Words the local recogniser scored low are marked for human checking and are
// reachable by keyboard. The mark is a diagnostic, never a percentage.
test('low-confidence transcript words are marked and navigable', async ({ page }) => {
  await openHarness(page);
  const viewer = page.getByRole('main', { name: 'Evidence viewer' });
  await page.keyboard.press('Control+2');
  for (const shown of [100, 150, 200, 250]) {
    await page.getByRole('button', { name: 'Load more sources' }).click();
    await expect(page.getByText(`${shown} shown of 250`)).toBeVisible();
  }
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill('Dispatch call recording 14-31');
  await page.getByRole('list', { name: 'Sources' }).getByRole('listitem').first().click();

  const bar = viewer.getByRole('group', { name: 'Low-confidence words' });
  await expect(bar).toContainText('2 low-confidence words in 2 loaded segments');
  const marks = viewer.locator('.uncertain-word');
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveText('fictional');
  await expect(marks.first()).toHaveAttribute('title', /not accuracy/);
  // No percentage is shown anywhere for the flagged words.
  await expect(bar).not.toContainText('%');

  await bar.getByRole('button', { name: 'Next uncertain' }).click();
  await expect(viewer.locator('[data-ordinal="4"] .caption-row')).toBeFocused();
  await bar.getByRole('button', { name: 'Next uncertain' }).click();
  await expect(viewer.locator('[data-ordinal="7"] .caption-row')).toBeFocused();
  await bar.getByRole('button', { name: 'Next uncertain' }).click();
  await expect(viewer.locator('[data-ordinal="4"] .caption-row')).toBeFocused();

  // Marks can be hidden, and a search takes over highlighting.
  await bar.getByRole('button', { name: 'Hide marks' }).click();
  await expect(marks).toHaveCount(0);
  await bar.getByRole('button', { name: 'Show marks' }).click();
  await expect(marks).toHaveCount(2);
  await viewer.getByRole('textbox', { name: 'Search transcript' }).fill('line 5 of');
  await expect(marks).toHaveCount(0);
  await expect(viewer.locator('mark')).toContainText('line 5 of');
});
