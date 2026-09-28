import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './harness-support';

// A plain-text original over the 10 MB indexing limit is readable page by page
// straight from the original bytes. It has no extraction revision, so the
// viewer says so and never offers a line citation for a selection.

async function openSource(page: Page, filter: string) {
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill(filter);
  await page.getByRole('list', { name: 'Sources' }).getByRole('listitem').first().click();
}

async function selectLines(page: Page, first: number, last: number) {
  await page.evaluate(([a, b]) => {
    const start = document.querySelector(`.text-line[data-line="${a}"]`)!;
    const end = document.querySelector(`.text-line[data-line="${b}"]`)!;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const box = end.getBoundingClientRect();
    end.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: box.left + 10, clientY: box.top + 5 }));
  }, [first, last]);
}

test('oversized text originals are readable but not citable by line', async ({ page }) => {
  await openHarness(page);
  const viewer = page.getByRole('main', { name: 'Evidence viewer' });
  await page.keyboard.press('Control+2');
  for (const shown of [100, 150, 200, 250]) {
    await page.getByRole('button', { name: 'Load more sources' }).click();
    await expect(page.getByText(`${shown} shown of 250`)).toBeVisible();
  }

  // Control: an indexed statement offers a pinned citation for a selection.
  await openSource(page, 'Witness statement W-01');
  await expect(viewer.getByText(/Extracted text · Revision 2/)).toBeVisible();
  await selectLines(page, 2, 3);
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toContainText('Copy citation (rev 2)');

  await openSource(page, 'Witness statement #14');
  const provenance = viewer.locator('.document-provenance');
  await expect(provenance).toContainText('Original file · Lines 1–94 of 94');
  await expect(provenance).toContainText('not searchable or citable by line');
  await expect(viewer.getByText('Original · not indexed')).toBeVisible();
  await expect(viewer.getByText(/Rev \d+ · current/)).toHaveCount(0);

  await selectLines(page, 2, 3);
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toHaveCount(0);
});
