// Captures before/after screenshots of every VisLex UI surface against the
// browser demo shim (never touches real case data). Usage:
//   node scripts/capture-redesign-shots.mjs [outDir] [--base=http://127.0.0.1:1420]
// Reused for the redesign "after" pass: pass a different outDir.
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const base = args.find(a => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:1420';
const outDir = args.find(a => !a.startsWith('--')) ?? 'docs/implementation/screenshots/redesign-before';

const results = [];
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1500, height: 960 }, colorScheme: 'dark' });

async function shot(name) {
  try {
    await page.screenshot({ path: `${outDir}/${name}.png`, animations: 'disabled', caret: 'hide' });
    results.push(`OK   ${name}`);
  } catch (error) { results.push(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}
async function step(name, fn) {
  try { await fn(); results.push(`OK   step:${name}`); }
  catch (error) { results.push(`FAIL step:${name}: ${error.message.split('\n')[0]}`); }
}
const settle = ms => page.waitForTimeout(ms ?? 350);

// At wide widths the "Return to workspace" button is hidden; closing viewer
// tabs via the tab strip is the always-available route back to the library.
async function closeViewerTabs() {
  for (let i = 0; i < 6; i++) {
    const tab = page.locator('.tab-strip button[aria-label^="Close "]');
    if (await tab.count() === 0) break;
    await tab.first().click();
    await settle(250);
  }
}

await mkdir(outDir, { recursive: true });

// --- Onboarding (no case loaded) ---
await page.goto(base, { waitUntil: 'networkidle' });
await settle();
await shot('01-onboarding-dark');

await step('create-dialog', async () => {
  await page.getByRole('button', { name: /Create a case/ }).click();
  await page.getByRole('dialog', { name: 'Create a local case' }).waitFor();
  await shot('02-create-case-dialog');
  await page.keyboard.press('Escape');
});
await step('restore-dialog', async () => {
  await page.getByRole('button', { name: /Restore a backup/ }).click();
  await page.getByRole('dialog', { name: 'Restore a case' }).waitFor();
  await shot('03-restore-dialog');
  await page.getByRole('button', { name: 'Cancel' }).click();
});

// --- Sample case: chat ---
await step('sample', async () => {
  await page.getByRole('button', { name: /Try the sample case/ }).click();
  await page.getByRole('heading', { name: 'Harbor Street · sample case' }).waitFor();
});
await page.keyboard.press('Control+1'); await settle();
await shot('04-chat-welcome-dark');

// --- Evidence library + viewer ---
await page.keyboard.press('Control+2'); await settle();
await shot('05-evidence-library-dark');
await step('viewer', async () => {
  await page.locator('.library-row').first().click();
  await page.locator('.document-page').waitFor();
  await settle();
  await shot('06-evidence-viewer-dark');
});
await step('record-editor', async () => {
  await closeViewerTabs();
  await page.getByRole('button', { name: 'Working files' }).click();
  await page.locator('.library-row').first().click();
  await settle(800);
  await shot('07-record-editor-dark');
  await closeViewerTabs();
});

// --- Findings / workbench / jobs ---
await page.keyboard.press('Control+3'); await settle();
await shot('08-findings-dark');
await page.keyboard.press('Control+4'); await settle();
await shot('09-workbench-dark');
await step('workbench-legal', async () => {
  await page.getByRole('tab', { name: 'Legal workflows' }).click();
  await settle();
  await shot('10-workbench-legal-dark');
});
await page.keyboard.press('Control+5'); await settle();
await shot('11-jobs-dark');

// --- Command palette ---
await step('palette', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: /Search case|Search commands/ }).waitFor();
  await shot('12-palette-dark');
  await page.getByRole('combobox', { name: /Search case|Search commands/ }).fill('witness');
  await settle(600);
  await shot('13-palette-results-dark');
  await page.keyboard.press('Escape');
});

// --- Settings sections ---
await step('settings', async () => {
  await page.keyboard.press('Control+,');
  await page.getByRole('dialog', { name: 'Workspace settings' }).waitFor();
  await shot('14-settings-providers-dark');
  await page.getByRole('button', { name: 'AI permissions', exact: true }).click(); await settle();
  await shot('15-settings-permissions-dark');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click(); await settle();
  await shot('16-settings-appearance-dark');
  await page.getByRole('button', { name: 'About', exact: true }).click(); await settle();
  await shot('17-settings-about-dark');
});

// --- Sidebar collapsed ---
await step('sidebar', async () => {
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Hide navigation' }).click();
  await settle();
  await shot('18-sidebar-collapsed-dark');
  await page.getByRole('button', { name: 'Show navigation' }).click();
});

// --- Light theme sweep ---
await step('light', async () => {
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.locator('html').waitFor({ state: 'visible' });
});
await page.keyboard.press('Control+1'); await settle();
await shot('19-chat-welcome-light');
await page.keyboard.press('Control+2'); await settle();
await shot('20-evidence-library-light');
async function openFirstSource() {
  await page.keyboard.press('Control+2');
  await page.getByRole('heading', { name: 'Evidence library' }).waitFor();
  await page.keyboard.press('Escape');
  await closeViewerTabs();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.locator('.library-row').first().click();
  await page.locator('.document-page').waitFor();
  await settle();
}
await step('viewer-light', async () => {
  await openFirstSource();
  await shot('21-evidence-viewer-light');
  await closeViewerTabs();
});
await page.keyboard.press('Control+4'); await settle();
await shot('22-workbench-light');
await page.keyboard.press('Control+5'); await settle();
await shot('23-jobs-light');

// --- Compact density ---
await step('compact', async () => {
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
});
await page.keyboard.press('Control+2'); await settle();
await shot('24-evidence-compact-light');

// --- Narrow width ---
await step('narrow', async () => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.keyboard.press('Control+2');
  await page.getByRole('heading', { name: 'Evidence library' }).waitFor();
  await settle(600);
  await shot('25-narrow-evidence');
  await closeViewerTabs();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.locator('.library-row').first().click();
  await page.locator('.main-panel').waitFor(); await settle();
  await shot('26-narrow-viewer');
});

console.log(results.join('\n'));
console.log(`\n${results.filter(r => r.startsWith('OK')).length}/${results.length} steps succeeded -> ${outDir}`);
await browser.close();
