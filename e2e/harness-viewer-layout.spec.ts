import { expect, test, type Page } from '@playwright/test';
import { openHarness } from './harness-support';

// The recording tools dock shares the viewer column with the stage and the
// transport. At short window heights the open dock used to overflow the
// column, and the transcript's scroll-into-view then scrolled the whole app
// shell. 1000x680 is the minimum window size in tauri.conf.json.

async function openVideoWithTranscript(page: Page) {
  await openHarness(page);
  // SYNTHETIC: give the camera recording the dispatch call's transcript.
  await page.evaluate(() => {
    const harness = window.__vislexHarness!;
    const active = [...harness.backend.cases.values()][0];
    active.transcripts[harness.fixture.camera] = { ...active.transcripts[harness.fixture.call] };
  });
  await page.keyboard.press('Control+2');
  for (const shown of [100, 150, 200, 250]) {
    await page.getByRole('button', { name: 'Load more sources' }).click();
    await expect(page.getByText(`${shown} shown of 250`)).toBeVisible();
  }
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill('05 · North entrance camera 04');
  await page.getByRole('list', { name: 'Sources' }).getByRole('listitem').first().click();
  const viewer = page.getByRole('main', { name: 'Evidence viewer' });
  await expect(viewer.locator('.viewer-dock-panel .transcript-segment').first()).toBeAttached();
  return viewer;
}

for (const size of [{ width: 1366, height: 768 }, { width: 1000, height: 680 }]) {
  test(`the transcript dock stays inside the viewer and never scrolls the app at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const viewer = await openVideoWithTranscript(page);
    // Follow playback: bring the first segment under the sticky transcript header.
    await viewer.locator('.viewer-dock-panel .transcript-segment').first().scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const viewer = box('.viewer'), dock = box('.viewer-dock');
      const panel = document.querySelector<HTMLElement>('.viewer-dock-panel')!;
      const rows = [...panel.querySelectorAll('.transcript-segment')] as HTMLElement[];
      panel.scrollTop = rows[0].offsetTop - 52;
      const area = panel.getBoundingClientRect();
      const visibleRows = rows.filter(row => { const b = row.getBoundingClientRect(); return b.top >= area.top && b.bottom <= area.bottom; }).length;
      const shifted = [document.scrollingElement!, ...document.querySelectorAll('body *')]
        .filter(element => element.scrollTop > 0 && !element.closest('.viewer-dock-panel, .source-canvas')).length;
      return { dockBottom: dock.bottom, viewerBottom: viewer.bottom, shifted, visibleRows };
    });
    expect(layout.dockBottom).toBeLessThanOrEqual(layout.viewerBottom + 0.5);
    expect(layout.shifted).toBe(0);
    expect(layout.visibleRows).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('button', { name: /Switch or manage case/ })).toBeInViewport();
  });
}
