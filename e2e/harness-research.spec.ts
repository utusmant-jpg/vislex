import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { axeViolations, calls, lastCall, openHarness } from './harness-support';

// Research browser UI against the synthetic backend: the Settings section, the
// Browser split view (the native webview itself is not part of the harness; the
// pane's placement calls are asserted instead) and the cite-check for captured
// authorities. No warnings or consent text appear anywhere in these surfaces.

const FORBIDDEN = /warning|consent|acknowledg|terms|risk/i;

async function scan(page: Page, name: string, testInfo: TestInfo) {
  const violations = await axeViolations(page);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  expect(violations, `${name}: ${JSON.stringify(violations, null, 1)}`).toEqual([]);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`Settings → Research browser toggles the case and edits sign-in hosts (${scheme})`, async ({ page }, testInfo) => {
    const fx = await openHarness(page, { colorScheme: scheme });
    await page.keyboard.press('Control+,');
    const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Research browser' }).click();
    await expect(dialog.getByRole('heading', { level: 2, name: 'Research browser' })).toBeVisible();
    await lastCall(page, 'research_grant');

    const toggle = dialog.getByRole('switch', { name: 'Research browser for this case' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await scan(page, `settings-research-off-${scheme}`, testInfo);
    // Keyboard operable: Space on the focused switch turns it on.
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect((await lastCall(page, 'set_research_grant')).args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, enabled: true });

    const host = dialog.getByRole('textbox', { name: 'Sign-in host' });
    await host.fill('not a host');
    await host.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('Invalid sign-in host');
    await host.fill('login.firm.example');
    await dialog.getByRole('button', { name: 'Add host' }).click();
    await expect(dialog.getByRole('list', { name: 'Sign-in hosts' })).toContainText('login.firm.example');
    expect((await lastCall(page, 'set_research_grant')).args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, enabled: true, sso_hosts: ['login.firm.example'] });
    await scan(page, `settings-research-on-${scheme}`, testInfo);
    expect(await dialog.locator('.research-settings').innerText()).not.toMatch(FORBIDDEN);

    await dialog.getByRole('button', { name: 'Sign out and clear research session' }).click();
    await expect(dialog.getByText(/Signed out\./)).toBeVisible();
    expect(await calls(page, 'clear_research_session')).toHaveLength(1);
  });
}

test('the Browser rail entry splits chat and browser and places the pane over its slot', async ({ page }, testInfo) => {
  const fx = await openHarness(page);
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Browser' }).click();
  await expect(page.getByRole('separator', { name: 'Resize research browser' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Agent task' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on for this case' }).click();
  const opened = await lastCall(page, 'open_research_pane');
  expect(opened.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1 });

  const slot = page.getByRole('region', { name: 'Research browser' });
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('next.westlaw.com');
  const box = (await slot.boundingBox())!;
  await expect.poll(async () => (await calls(page, 'research_pane_layout')).at(-1)?.args).toEqual({
    rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, visible: true,
  });
  await scan(page, 'browser-view', testInfo);
  expect(await page.locator('.research-pane').innerText()).not.toMatch(FORBIDDEN);

  // The divider is keyboard operable and the pane follows it.
  const divider = page.getByRole('separator', { name: 'Resize research browser' });
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', String(before + 16));
  await expect.poll(async () => (await calls(page, 'research_pane_layout')).at(-1)?.args.rect).toMatchObject({ width: Math.round(box.width) + 16 });

  // Settings (a modal dialog) hides the native pane; closing it shows it again.
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible();
  await expect.poll(async () => (await calls(page, 'research_pane_layout')).at(-1)?.args.visible).toBe(false);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(async () => (await calls(page, 'research_pane_layout')).at(-1)?.args.visible).toBe(true);

  // Leaving the view hides the pane.
  await page.keyboard.press('Control+1');
  await expect.poll(async () => (await calls(page, 'research_pane_layout')).at(-1)?.args.visible).toBe(false);
});

test('a captured authority is accepted only after the four-item cite-check', async ({ page }, testInfo) => {
  const fx = await openHarness(page);
  const id = await page.evaluate(() => (window.__vislexHarness as unknown as { backend: { seedResearchAuthority: (options: { mismatch: boolean }) => string } }).backend.seedResearchAuthority({ mismatch: true }));
  await page.keyboard.press('Control+3');
  await expect(page.getByRole('heading', { name: 'Findings & clock proposals' })).toBeVisible();
  await page.locator('.object-card-title', { hasText: 'Harbor Freight v. Synthetic Depot (SYNTHETIC)' }).click();
  const card = page.locator('details.object-card[open]');
  await expect(card.getByText('Citation mismatch.')).toBeVisible();
  const accept = card.getByRole('button', { name: 'Accept revision' });
  await expect(accept).toBeDisabled();
  for (const label of ['Exists at the cited page', 'Quote matches the opinion text', 'Citator status checked']) await card.getByRole('checkbox', { name: label }).check();
  await expect(accept).toBeDisabled();
  await card.getByRole('checkbox', { name: 'Supports the proposition' }).check();
  await expect(accept).toBeEnabled();
  await scan(page, 'cite-check', testInfo);
  expect(await card.innerText()).not.toMatch(FORBIDDEN);
  await accept.click();
  const review = await lastCall(page, 'evidence_review');
  expect(review.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1, id, revision: 1, review: 'accepted', checks: ['exists', 'quote', 'citator', 'support'] });
  expect(String(review.args.note)).toContain('supports the proposition');
});
