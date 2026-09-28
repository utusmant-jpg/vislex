import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { axeViolations, openHarness } from './harness-support';

// axe-core WCAG 2.x A/AA over native-only states that the browser preview
// cannot reach: populated chat, streaming, jobs with progress, the viewer.

// Violations found by this harness in shared app code this surface may not
// edit. Each is reported upstream (see the harness handoff). Anything else
// fails the test; entries are matched by rule id and target selector.
const KNOWN: { id: string; target: RegExp; reason: string }[] = [
  { id: 'aria-required-children', target: /^\.tab-list$/, reason: 'App.tsx open-file tab strip puts close buttons inside role="tablist"' },
  { id: 'scrollable-region-focusable', target: /^\.palette-results$/, reason: 'App.tsx command palette result region scrolls but its options are tabIndex=-1' },
];

async function scan(page: Page, name: string, testInfo: TestInfo) {
  const violations = await axeViolations(page);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const unknown = violations.map(item => ({ ...item, nodes: item.nodes.filter(node => !KNOWN.some(known => known.id === item.id && known.target.test(node.target.join(' ')))) })).filter(item => item.nodes.length);
  for (const item of violations) for (const known of KNOWN) if (known.id === item.id && item.nodes.some(node => known.target.test(node.target.join(' ')))) {
    if (!testInfo.annotations.some(annotation => annotation.description === known.reason)) testInfo.annotations.push({ type: 'known-a11y-issue', description: known.reason });
  }
  expect(unknown, `${name}: ${JSON.stringify(unknown, null, 1)}`).toEqual([]);
}

for (const scheme of ['dark', 'light'] as const) {
  test(`harness workspaces add no WCAG A/AA violations beyond the recorded baseline (${scheme})`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openHarness(page, { colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await expect(page.getByText('Saved response').first()).toBeVisible();
    await scan(page, `chat-${scheme}`, testInfo);

    // Streaming state with the Stop control and live draft.
    await page.evaluate(() => window.__vislexHarness!.setScenario({ autoStream: false }));
    await page.getByRole('textbox', { name: 'Agent task' }).fill('Accessibility streaming check');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    const taskId = await page.evaluate(() => (window.__vislexHarness!.calls('start_task').at(-1) as { result: { task_id: string } }).result.task_id);
    await page.evaluate(id => window.__vislexHarness!.streamTask(id, { chunks: ['Synthetic ', 'live ', 'draft.'], intervalMs: 40, complete: false }), taskId);
    await expect(page.locator('.live-answer')).toContainText('live draft');
    await scan(page, `chat-streaming-${scheme}`, testInfo);
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

    await page.getByRole('button', { name: 'Open cited evidence, rev 1 · 5–5' }).first().click();
    await expect(page.getByRole('main', { name: 'Evidence viewer' }).getByRole('note')).toContainText('Historical extraction revision 1');
    await scan(page, `viewer-historical-${scheme}`, testInfo);

    for (const [shortcut, heading, name] of [
      ['Control+2', 'Evidence library', 'evidence'],
      ['Control+3', 'Findings & clock proposals', 'findings'],
      ['Control+4', 'Investigation workbench', 'investigate'],
      ['Control+5', 'Jobs & issues', 'jobs'],
    ] as const) {
      await page.keyboard.press(shortcut);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      if (name === 'jobs') await expect(page.getByRole('progressbar')).toHaveCount(1);
      await scan(page, `${name}-${scheme}`, testInfo);
    }

    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: /Search case/ }).fill('north');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('group', { name: 'Text & meaning' })).toBeVisible();
    await scan(page, `palette-results-${scheme}`, testInfo);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+,');
    await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible();
    await scan(page, `settings-${scheme}`, testInfo);
  });
}
