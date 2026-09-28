// A long synthetic native journey should not inherit the short CLI eval timeout.
import fs from 'node:fs';

const [port, scriptPath, workspace, screenshotPath, mockPort] = process.argv.slice(2);
if (!port || !scriptPath || !workspace || !screenshotPath) throw new Error('Native CDP arguments missing');
// Only the application webview: never fall back to another page, such as the research pane.
// The title appears once the document is parsed, so poll briefly for it.
let target;
for (let attempt = 0; attempt < 50 && !target; attempt++) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  target = targets.find(item => item.type === 'page' && item.title === 'VisLex');
  if (!target) await new Promise(resolve => setTimeout(resolve, 200));
}
if (!target?.webSocketDebuggerUrl) throw new Error('VisLex WebView target unavailable');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const packet = JSON.parse(event.data);
  if (!packet.id || !pending.has(packet.id)) return;
  const { resolve, reject } = pending.get(packet.id);
  pending.delete(packet.id);
  packet.error ? reject(new Error(JSON.stringify(packet.error))) : resolve(packet.result);
});
socket.addEventListener('close', () => {
  for (const { reject } of pending.values()) reject(new Error('Native WebView connection closed'));
  pending.clear();
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const source = fs.readFileSync(scriptPath, 'utf8').replace('__WORKSPACE__', JSON.stringify(workspace.replaceAll('\\', '/'))).replace('__MOCK_PORT__', mockPort ?? '9362');
let bridgeReady = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const probe = await call('Runtime.evaluate', { expression: 'Boolean(window.__TAURI_INTERNALS__?.invoke)', returnByValue: true });
    if (probe.result?.value === true) { bridgeReady = true; break; }
  } catch { /* The WebView can replace its initial navigation context. */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!bridgeReady) throw new Error('VisLex Tauri bridge did not become ready');
const deadline = setTimeout(() => {
  for (const { reject } of pending.values()) reject(new Error('Native journey exceeded 15 minutes'));
  pending.clear();
  socket.close();
}, 15 * 60 * 1000);
try {
  const result = await call('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  const value = result.result?.value;
  if (!value || typeof value !== 'object') throw new Error('Native journey returned no structured result');
  await call('Page.enable');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  process.stdout.write(`${JSON.stringify(value)}\n`);
} finally {
  clearTimeout(deadline);
  socket.close();
}
