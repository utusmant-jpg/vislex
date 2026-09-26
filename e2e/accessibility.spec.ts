import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);

test('dark and light startup, settings, and case navigation have no WCAG A/AA violations', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  async function scan(name: string) {
    const violations = await page.evaluate(async () => {
      const axe = (window as typeof window & { axe: { run: (root: Document, options: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[]; failureSummary: string | null }[] }[] }> } }).axe;
      const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      return result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }));
    });
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    expect(violations, `${name}: ${JSON.stringify(violations)}`).toEqual([]);
  }
  await scan('startup-dark');
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible();
  await scan('appearance-settings-dark');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await scan('appearance-settings-light');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await scan('startup-light');
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await expect(page.getByRole('heading', { name: 'Harbor Street · sample case' })).toBeVisible();
  await scan('sample-case-light');
  await page.keyboard.press('Control+2');
  await expect(page.getByRole('heading', { name: 'Evidence library' })).toBeVisible();
  await scan('evidence-library-light');
  for (const [shortcut, heading, name] of [
    ['Control+3', 'Findings & clock proposals', 'findings-light'],
    ['Control+4', 'Investigation workbench', 'review-light'],
    ['Control+5', 'Jobs & issues', 'jobs-light'],
  ]) {
    await page.keyboard.press(shortcut);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await scan(name);
  }
  await page.keyboard.press('Control+,');
  for (const section of ['Providers & models', 'Case permissions', 'Review & execution', 'Appearance', 'About']) {
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section }).click();
    await scan(`settings-${section.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-light`);
  }
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await scan('appearance-settings-dark-case');
  await page.getByRole('button', { name: 'Close settings' }).click();
  for (const [shortcut, heading, name] of [
    ['Control+1', 'Harbor Street · sample case', 'chat-dark'],
    ['Control+2', 'Evidence library', 'evidence-library-dark'],
    ['Control+3', 'Findings & clock proposals', 'findings-dark'],
    ['Control+4', 'Investigation workbench', 'review-dark'],
    ['Control+5', 'Jobs & issues', 'jobs-dark'],
  ]) {
    await page.keyboard.press(shortcut);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await scan(name);
  }
});
