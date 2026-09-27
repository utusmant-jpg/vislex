import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [port, casePath, phase] = process.argv.slice(2);
if (!port || !casePath || !phase) throw new Error('Usage: native-consent-cdp.mjs PORT CASE_PATH PHASE');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://tauri.localhost'));
  if (!page) throw new Error('VisLex WebView was not found');
  const expression = readFileSync(new URL('./native-consent-acceptance.js', import.meta.url), 'utf8')
    .replace('__CASE_PATH__', JSON.stringify(casePath.replaceAll('\\', '/')))
    .replaceAll('__PHASE__', phase);
  const result = await page.evaluate(expression);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
}
