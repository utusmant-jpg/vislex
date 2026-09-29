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
  await expect(page.getByRole('textbox', { name: 'Address or search' })).toHaveValue('https://next.westlaw.com/');
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

for (const scheme of ['dark', 'light'] as const) {
  test(`the address field opens addresses and web searches by keyboard, and Home returns to Westlaw (${scheme})`, async ({ page }, testInfo) => {
    await openHarness(page, { colorScheme: scheme });
    await page.keyboard.press('Control+6');
    await page.getByRole('button', { name: 'Turn on for this case' }).press('Enter');
    await lastCall(page, 'open_research_pane');
    const address = page.getByRole('textbox', { name: 'Address or search' });
    await expect(address).toHaveValue('https://next.westlaw.com/');
    await expect(address).toHaveAttribute('placeholder', 'Search or enter address');

    // Reached with Tab from the page buttons; focusing selects the whole address.
    await page.getByRole('button', { name: 'Home' }).focus();
    await page.keyboard.press('Tab');
    await expect(address).toBeFocused();
    expect(await address.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.value.length])).toEqual([0, 25, 25]);
    await scan(page, `browser-address-focused-${scheme}`, testInfo);

    // Words search the web.
    await page.keyboard.type('duty of care negligence');
    await page.keyboard.press('Enter');
    expect((await lastCall(page, 'research_pane_navigate')).args).toEqual({ url: 'https://www.google.com/search?q=duty%20of%20care%20negligence' });
    // The address is selected again, so the next typing replaces it.
    await expect.poll(() => address.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart! === input.value.length && input.value.length > 0)).toBe(true);

    // A host name gets https://.
    await page.keyboard.type('example.com');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await calls(page, 'research_pane_navigate')).length).toBe(2);
    expect((await lastCall(page, 'research_pane_navigate')).args).toEqual({ url: 'https://example.com' });

    // Another scheme is refused before anything is sent.
    await page.keyboard.type('javascript:alert(1)');
    await page.keyboard.press('Enter');
    await expect(page.getByText('That address cannot be opened here')).toBeVisible();
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(await calls(page, 'research_pane_navigate')).toHaveLength(2);

    // Escape restores the current address and leaves the field; polling shows the page opened.
    await page.keyboard.press('Escape');
    await expect(address).not.toBeFocused();
    await expect(address).toHaveValue('https://example.com/');
    await expect(address).not.toHaveAttribute('aria-invalid', 'true');

    // Home returns to the Westlaw home page.
    await page.getByRole('button', { name: 'Home' }).press('Enter');
    await expect.poll(async () => (await calls(page, 'research_pane_navigate')).length).toBe(3);
    expect((await lastCall(page, 'research_pane_navigate')).args).toEqual({ url: 'https://1.next.westlaw.com/' });
    await expect(address).toHaveValue('https://1.next.westlaw.com/');
    await scan(page, `browser-address-${scheme}`, testInfo);
    expect(await page.locator('.research-pane').innerText()).not.toMatch(FORBIDDEN);
    expect(await address.getAttribute('placeholder')).not.toMatch(FORBIDDEN);
  });
}

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

test('research steps appear in the chat turn as they run, and the toolbar Stop pauses the task, by keyboard', async ({ page }, testInfo) => {
  await openHarness(page);
  await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
  // Keyboard only: the Browser view, turning the case on, and sending a question.
  await page.keyboard.press('Control+6');
  await page.getByRole('button', { name: 'Turn on for this case' }).press('Enter');
  await lastCall(page, 'open_research_pane');
  await expect(page.getByRole('textbox', { name: 'Address or search' })).toHaveValue('https://next.westlaw.com/');
  await page.getByRole('textbox', { name: 'Agent task' }).focus();
  await page.keyboard.type('Find authority on the duty of care');
  await page.keyboard.press('Enter');
  const taskId = ((await lastCall(page, 'start_task')).result as { task_id: string }).task_id;
  const turn = page.locator('.conversation-turn').filter({ hasText: 'Find authority on the duty of care' });
  const steps = turn.getByRole('list', { name: 'Research steps' });
  // Sending from the Browser view keeps the research browser beside the chat.
  await expect(turn).toBeVisible();
  await expect(page.getByRole('separator', { name: 'Resize research browser' })).toBeVisible();

  // Each step shows within a second of the backend's event, with its query, address, lines or citation.
  const script: { name: string; detail: string; args: Record<string, unknown>; output: unknown; label: string; object: string }[] = [
    { name: 'research_act', detail: 'duty of care /s negligence', args: { action: 'type', ref: 'e3', snapshot_version: 1, text: 'duty of care /s negligence', key: null }, output: { performed: 'type' }, label: 'Searched: duty of care /s negligence', object: 'duty of care /s negligence' },
    { name: 'research_navigate', detail: '1.next.westlaw.com/Document/I0SYNTHETIC', args: { url: 'https://1.next.westlaw.com/Document/I0SYNTHETIC' }, output: { url: 'https://1.next.westlaw.com/Document/I0SYNTHETIC' }, label: 'Opened 1.next.westlaw.com/Document/I0SYNTHETIC', object: '1.next.westlaw.com/Document/I0SYNTHETIC' },
    { name: 'research_read_page', detail: 'lines 0–49', args: { offset: 0, count: 50 }, output: { title: 'Harbor Freight v. Synthetic Depot (SYNTHETIC)', lines: Array.from({ length: 50 }, (_, n) => ({ n, text: 'SYNTHETIC' })), total_lines: 80 }, label: 'Read lines 0–49', object: 'lines 0–49' },
    { name: 'research_capture', detail: '123 F.3d 456', args: { title: 'Harbor Freight v. Synthetic Depot (SYNTHETIC)', jurisdiction: '9th Cir.', relevant_date: null, citation_text: '123 F.3d 456', proposition: 'SYNTHETIC proposition', quote_start_line: 3, quote_end_line: 4 }, output: { locator: 'evidence:synthetic#R1L3-L4' }, label: 'Captured 123 F.3d 456', object: '123 F.3d 456' },
  ];
  for (const step of script) {
    await page.evaluate(([id, item]) => window.__vislexHarness!.researchStep(id, { name: item.name, detail: item.detail, args: item.args, output: item.output, recordAfterMs: 300 }), [taskId, step] as const);
    await expect(steps.getByText(step.label, { exact: true })).toBeVisible({ timeout: 1000 });
  }
  await expect(turn.locator('.trace-label')).toHaveText('Captured 123 F.3d 456…');
  // Once the receipts are polled (every 2.5 s), each step is still listed exactly once.
  await expect.poll(async () => (await calls(page, 'actions')).some(call => call.args.task_id === taskId && Array.isArray(call.result) && call.result.length >= 5), { timeout: 6000 }).toBe(true);
  await expect(steps.getByRole('listitem')).toHaveCount(4);
  await scan(page, 'research-steps', testInfo);
  expect(await steps.innerText()).not.toMatch(FORBIDDEN);

  // The toolbar Stop is reached with Tab from the page history buttons and pressed with Enter.
  await page.getByRole('button', { name: 'Reload' }).focus();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  for (let presses = 0; presses < 6 && !(await stop.evaluate(element => element === document.activeElement)); presses += 1) await page.keyboard.press('Tab');
  await expect(stop).toBeFocused();
  await page.keyboard.press('Enter');
  const stopped = await lastCall(page, 'research_stop');
  expect(stopped.args).toEqual(expect.objectContaining({ case_id: expect.any(String) }));
  expect(stopped.result).toEqual({ stopped: true, task_id: taskId });
  await expect(turn.getByText('Stopped', { exact: true })).toBeVisible();
  expect(await page.evaluate(id => window.__vislexHarness!.task(id)?.status, taskId)).toBe('paused');
  await expect(stop).toBeFocused();
  // The toolbar Stop is its own command; the chat's stop_task was not sent.
  expect((await calls(page, 'stop_task')).filter(call => call.args.task_id === taskId)).toHaveLength(0);

  // After the run, the saved receipts read as the same sentences (Enter opens the activity).
  await expect(steps).toHaveCount(0);
  await turn.getByRole('button', { name: /^Activity:/ }).press('Enter');
  const recorded = turn.getByRole('list', { name: 'Recorded actions' });
  for (const step of script) await expect(recorded.locator('.trace-sentence strong').getByText(step.object, { exact: true })).toBeVisible();
  await expect(recorded).toContainText('Searched: duty of care /s negligence');
  await expect(recorded).toContainText('Captured 123 F.3d 456');
  await scan(page, 'research-steps-recorded', testInfo);

  // A failed research_stop is reported through the notification helper; the pane stays open.
  await page.evaluate(() => window.__vislexHarness!.fail('research_stop', 'The research browser is closed'));
  await stop.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Could not stop the research browser')).toBeVisible();
  await expect(stop).toBeVisible();
});

test('the chat Stop still stops a research turn on its own', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
  await page.keyboard.press('Control+6');
  await page.getByRole('button', { name: 'Turn on for this case' }).press('Enter');
  await lastCall(page, 'open_research_pane');
  await page.getByRole('textbox', { name: 'Agent task' }).fill('Chat stop during research');
  await page.getByRole('textbox', { name: 'Agent task' }).press('Enter');
  const taskId = ((await lastCall(page, 'start_task')).result as { task_id: string }).task_id;
  await page.evaluate(id => window.__vislexHarness!.researchStep(id, { name: 'research_act', detail: 'negligence', args: { action: 'type', text: 'negligence' }, recordAfterMs: null }), taskId);
  await expect(page.getByRole('list', { name: 'Research steps' })).toContainText('Searched: negligence');
  await page.getByRole('button', { name: 'Stop response' }).press('Enter');
  expect((await lastCall(page, 'stop_task')).args).toMatchObject({ task_id: taskId });
  expect(await calls(page, 'research_stop')).toHaveLength(0);
  await expect(page.locator('.conversation-turn').filter({ hasText: 'Chat stop during research' }).getByText('Stopped', { exact: true })).toBeVisible();
});
