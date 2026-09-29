// Test harness controls its own loopback fixture outside the app's unchanged CSP.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const [port,workspace,mockPort]=process.argv.slice(2);
if(!/^\d+$/.test(port??'') || !/^\d+$/.test(mockPort??''))throw new Error('Numeric test ports required');
const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page=browser.contexts().flatMap(c=>c.pages())[0];
  if(!page)throw new Error('Native WebView unavailable');
  await page.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__?.invoke));
  await page.exposeFunction('caiMock',async action=>{
    if(!['state','hold','release'].includes(action))throw new Error('Unknown fixture control');
    const response=await fetch(`http://127.0.0.1:${mockPort}/${action}`,{method:action==='state'?'GET':'POST'});
    if(!response.ok)throw new Error('Synthetic fixture control failed');
    return action==='state'?response.json():response.text();
  });
  const expression=readFileSync(new URL('./native-intelligence-acceptance.js',import.meta.url),'utf8').replace('__WORKSPACE__',JSON.stringify(workspace.replaceAll('\\','/')));
  const result=await page.evaluate(expression);
  await page.screenshot({path:`${workspace}/artifacts/native-intelligence-acceptance.png`});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {await browser.close();}
