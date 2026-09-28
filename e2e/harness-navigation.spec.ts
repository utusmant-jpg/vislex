import { expect, test } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

// Navigation across every workspace of the native code paths, against a
// large synthetic case (250 sources, 60 working files, 70 jobs).

test('every workspace is reachable by keyboard and rail with the synthetic case', async ({ page }) => {
  await openHarness(page);
  const rail = page.getByRole('navigation', { name: 'Workspaces' });
  for (const [shortcut, name, heading] of [
    ['Control+2', 'Evidence', 'Evidence library'],
    ['Control+3', 'Findings', 'Findings & clock proposals'],
    ['Control+4', 'Investigate', 'Investigation workbench'],
    ['Control+5', 'Jobs', 'Jobs & issues'],
    ['Control+1', 'Chat', null],
  ] as const) {
    await page.keyboard.press(shortcut);
    if (heading) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    else await expect(page.getByRole('textbox', { name: 'Agent task' })).toBeVisible();
    await expect(rail.getByRole('button', { name })).toHaveAttribute('aria-current', 'true');
  }
  // Rail buttons are focusable and operable from the keyboard.
  await rail.getByRole('button', { name: 'Jobs' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Jobs & issues' })).toBeVisible();
  // The jobs badge conveys attention with text, not colour alone.
  await expect(page.locator('.matter-status')).toHaveAccessibleName(/Case status: 4 jobs in progress/);
  // The rail button's name carries the count its (aria-hidden) badge shows.
  const badge = await rail.locator('.rail-badge').textContent();
  await expect(rail.locator('.rail-button.attention')).toHaveAccessibleName(new RegExp(`^Jobs, ${badge === '9+' ? '\\d+' : badge} needs? attention$`));
});

test('evidence library pages a large case with the generation and audit guard', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+2');
  await expect(page.getByText('250 original sources · 60 working files')).toBeVisible();
  await expect(page.getByText('50 shown of 250')).toBeVisible();
  await page.getByRole('button', { name: 'Load more sources' }).click();
  await expect(page.getByText('100 shown of 250')).toBeVisible();
  expect((await lastCall(page, 'source_page')).args).toMatchObject({ case_id: fx.caseA.id, generation: 4, audit_seq: 412 });

  // A stale page request (audit sequence moved) is refused and reported, not merged.
  await page.evaluate(() => window.__vislexHarness!.fail('source_page', 'Case changed before source page', 1));
  await page.getByRole('button', { name: 'Load more sources' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load more: Case changed before source page');
  await expect(page.getByText('100 shown of 250')).toBeVisible();

  // Kind chips filter loaded rows; long names stay available via their title.
  await page.getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: 'video' }).click();
  const rows = page.getByRole('list', { name: 'Sources' }).getByRole('listitem');
  expect(await rows.count()).toBeGreaterThan(5);
  for (const text of await rows.locator('.library-sub').allInnerTexts()) expect(text.startsWith('video')).toBe(true);
  await page.getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: 'All kinds' }).click();
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill('unusually long descriptive');
  const longRow = rows.first();
  await expect(longRow).toHaveAttribute('title', /unusually long descriptive file name/);
  const overflow = await longRow.locator('.library-name').evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow, 'very long names are truncated visually, not wrapped over neighbours').toBe(true);
  // Status pills that ellipsize keep their full text in a title, and the row title names the status.
  const status = longRow.locator('.library-cell .pill');
  const statusText = (await status.textContent())!.trim();
  await expect(status).toHaveAttribute('title', statusText);
  await expect(longRow).toHaveAttribute('title', new RegExp(`Status: ${statusText}`));
  // With the viewer open the table narrows: the name column keeps room and headers do not overlap.
  await longRow.click();
  const head = page.locator('.library-head > span');
  const [nameBox, statusBox] = [await head.nth(0).boundingBox(), await head.nth(1).boundingBox()];
  expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(statusBox!.x);
  expect(await longRow.locator('.library-name').evaluate(element => element.clientWidth)).toBeGreaterThan(120);
  await page.keyboard.press('Control+w');

  // Restricting a source sends the exact guard and the pill appears.
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill('');
  const first = rows.first();
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Restrict from AI analysis|Allow AI analysis/ }).click();
  const restrict = await lastCall(page, 'set_restricted');
  expect(restrict.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1 });
});

test('the viewer opens each source kind and degrades honestly without media bytes', async ({ page }) => {
  const fx = await openHarness(page);
  const viewer = page.getByRole('main', { name: 'Evidence viewer' });
  // Fixed fixture sources are the oldest, so load every page of the library first.
  await page.keyboard.press('Control+2');
  for (const shown of [100, 150, 200, 250]) {
    await page.getByRole('button', { name: 'Load more sources' }).click();
    await expect(page.getByText(`${shown} shown of 250`)).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Load more sources' })).toHaveCount(0);
  const filter = page.getByRole('textbox', { name: 'Filter loaded evidence' });
  const openByName = async (name: string) => {
    await filter.fill(name);
    await page.getByRole('list', { name: 'Sources' }).getByRole('listitem').first().click();
  };

  await openByName('Incident report HS-2026-0914');
  await expect(viewer.getByText('of 12 physical pages')).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'Page 1' })).toBeVisible();
  const renders = await calls(page, 'render_page');
  expect(renders.map(call => call.args.page)).toContain(1);
  for (const call of renders) expect(call.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, source_id: fx.report });
  await viewer.getByRole('button', { name: 'Next page' }).click();
  await expect(viewer.getByRole('spinbutton', { name: 'Current page' })).toHaveValue('2');

  await openByName('Dispatch call recording 14-31');
  await expect(viewer.getByText('This audio format is not supported by the installed viewer.')).toBeVisible();
  await expect(viewer.getByText(/Unreviewed machine transcription/)).toBeVisible();
  await expect(viewer.getByText('60 saved segments · 25 loaded.', { exact: false })).toBeVisible();
  expect((await lastCall(page, 'transcript_segment_page')).args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, source_id: fx.call, cursor: null });
  await viewer.getByRole('button', { name: 'Load next 25 segments' }).click();
  await expect(viewer.getByText('60 saved segments · 50 loaded.', { exact: false })).toBeVisible();
  await expect(viewer.getByText('Correction awaiting human review', { exact: false })).toBeVisible();
  await viewer.getByText('Anonymous speaker turns').click();
  await expect(viewer.getByText('24 proposed turns', { exact: false })).toBeVisible();

  await openByName('05 · North entrance camera 04');
  await expect(viewer.getByText(/Playback derivatives are not available in the synthetic harness/)).toBeVisible();
  // The overview moved from a disclosure into the recording tools dock as a tab.
  await viewer.getByRole('tab', { name: 'Visual discovery' }).click();
  await expect(viewer.getByRole('region', { name: 'Video overview and visible text' })).toBeVisible();
  await expect(viewer.getByRole('img', { name: /Sample at 0\.000 seconds/ })).toBeVisible();

  await openByName('06 · Email from facilities');
  await expect(viewer.locator('.text-line[data-line="6"]')).toContainText('two openings');

  await openByName('Medical summary');
  await expect(viewer.getByRole('status', { name: 'Restricted' })).toBeVisible();
  await expect(viewer.getByText('Prepare a reviewed redaction')).toHaveCount(0);

  // Every open source got a tab; tabs are real tabs with accessible names.
  const fileTabs = page.getByRole('tablist', { name: 'Open files' });
  await expect(fileTabs.getByRole('tab')).toHaveCount(5);
  // The tablist owns only tabs; closing stays keyboard reachable.
  await expect(fileTabs.getByRole('button')).toHaveCount(0);
  const selectedTab = fileTabs.getByRole('tab', { selected: true });
  await expect(selectedTab).toHaveAttribute('title', /Medical summary/);
  await selectedTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(fileTabs.getByRole('tab', { selected: true })).toHaveAttribute('title', /Email from facilities/);
  await expect(fileTabs.getByRole('tab', { selected: true })).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(fileTabs.getByRole('tab')).toHaveCount(4);
  await expect(fileTabs.getByRole('tab', { name: /Email from facilities/ })).toHaveCount(0);
  await expect(fileTabs.getByRole('tab', { selected: true })).toBeFocused();
  const current = await fileTabs.getByRole('tab', { selected: true }).getAttribute('title');
  await page.getByRole('main', { name: 'Evidence viewer' }).getByRole('button', { name: `Close ${current}` }).click();
  await expect(fileTabs.getByRole('tab')).toHaveCount(3);
  await page.keyboard.press('Control+w');
  await expect(fileTabs.getByRole('tab')).toHaveCount(2);
});

test('the command palette results are keyboard reachable on their own', async ({ page }) => {
  await openHarness(page);
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: /Search case/ });
  await input.fill('north');
  await page.keyboard.press('Control+Enter');
  const results = page.getByRole('listbox', { name: 'Search results and commands' });
  await expect(results.getByRole('group', { name: 'Text & meaning' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(results).toBeFocused();
  const first = await results.getAttribute('aria-activedescendant');
  await page.keyboard.press('ArrowDown');
  await expect(results).not.toHaveAttribute('aria-activedescendant', first!);
  await expect(input).toHaveAttribute('aria-activedescendant', (await results.getAttribute('aria-activedescendant'))!);
  await page.keyboard.press('End');
  const last = await results.getAttribute('aria-activedescendant');
  await expect(page.locator(`#${last}`)).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(results).toHaveAttribute('aria-activedescendant', 'case-command-item-0');
});

test('working files, findings and investigation surfaces run their native paths', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+2');
  await page.getByRole('button', { name: 'Working files' }).click();
  await page.getByRole('textbox', { name: 'Filter loaded evidence' }).fill('Locked chronology');
  await page.getByRole('list', { name: 'Working files' }).getByRole('listitem').first().click();
  const viewer = page.getByRole('main', { name: 'Evidence viewer' });
  await expect(viewer.getByRole('textbox', { name: 'Working file title' })).toHaveValue('Locked chronology for counsel review (SYNTHETIC)');
  await expect(viewer.getByRole('button', { name: /Agent edits locked/ })).toBeVisible();
  const content = viewer.getByRole('textbox', { name: 'Working file content' });
  await content.fill(`${await content.inputValue()}\n\nHarness edit.`);
  await viewer.getByRole('button', { name: 'Save revision' }).click();
  const write = await lastCall(page, 'write_record');
  expect(write.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, base_revision: 2, reason: 'Manual editor save' });
  await expect(viewer.getByText('REV 3')).toBeVisible();

  await page.keyboard.press('Control+3');
  await expect(page.getByRole('heading', { name: 'Findings & clock proposals' })).toBeVisible();
  const card = page.locator('details.object-card').filter({ hasText: 'Bag colour differs between extraction revisions' });
  await card.locator('summary').click();
  await card.getByRole('button', { name: 'Accept revision' }).click();
  expect((await lastCall(page, 'evidence_review')).args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, review: 'accepted', revision: 1 });
  const stale = page.locator('details.object-card').filter({ hasText: 'Door alarm openings match the sighting' });
  await stale.locator('summary').click();
  await expect(stale.getByRole('button', { name: 'Accept revision' })).toBeDisabled();

  await page.keyboard.press('Control+4');
  await expect(page.getByRole('heading', { name: 'Investigation workbench' })).toBeVisible();
  await expect(page.getByRole('region', { name: /Assertions for Does W-01 agree/ })).toBeVisible();
  await page.getByText('Question dossier · evidence, checks and gaps').first().click();
  await expect(page.getByText('Inspect camera 04 frames 14:30–14:36', { exact: false })).toBeVisible();
  expect((await lastCall(page, 'read_dossier')).args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1 });
  const tabs = page.getByRole('tablist', { name: 'Investigation views' });
  await tabs.getByRole('tab', { name: 'Discrepancies' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'What changed?' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Legal workflows' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.getByText('Synthetic coverage map. Counts describe fixture data only.')).toBeVisible();
  expect(await calls(page, 'coverage_map')).not.toHaveLength(0);
});
