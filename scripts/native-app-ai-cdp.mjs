import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [port, casePath] = process.argv.slice(2);
if (!port || !casePath) throw new Error('Usage: native-app-ai-cdp.mjs PORT CASE_PATH');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://tauri.localhost'));
  if (!page) throw new Error('VisLex WebView was not found');
  const expression = readFileSync(new URL('./native-app-ai-acceptance.js', import.meta.url), 'utf8')
    .replace('__CASE_PATH__', JSON.stringify(casePath.replaceAll('\\', '/')));
  const result = await page.evaluate(expression);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await browser.close();
}
