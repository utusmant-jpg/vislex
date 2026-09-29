// R40 native journey: the Browser view driven through the real UI. Clicking the rail's Browser
// button opens the research pane over its slot at the slot's size; leaving the view or opening
// a dialog hides it; the toolbar's Back button navigates the pane. Loopback fixture only, in a
// synthetic case. The research page runs in its own browser process, so it is observed through
// the debug-only research_debug_probe command (the app's in-process bridge, test mode only).
import fs from 'node:fs';

const [port, workspace, fixturePort, screenshotPath] = process.argv.slice(2);
if (!port || !workspace || !fixturePort || !screenshotPath) throw new Error('Arguments: port workspace fixturePort screenshot');
const fixture = `http://127.0.0.1:${fixturePort}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(pick, label) {
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    target = targets.find(pick);
    if (!target) await sleep(200);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`${label} target unavailable`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (!packet.id || !pending.has(packet.id)) return;
    const { resolve, reject } = pending.get(packet.id);
    pending.delete(packet.id);
    packet.error ? reject(new Error(JSON.stringify(packet.error))) : resolve(packet.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(`${label}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  };
  return { call, evaluate, close: () => socket.close() };
}

const isApp = item => item.type === 'page' && item.title === 'VisLex';

async function bridgeReady(app) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await app.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector(".rail-button"))')) return; } catch { /* reloading */ }
    await sleep(100);
  }
  throw new Error('VisLex UI did not become ready');
}

const helpers = `
  const invoke = (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const wait = async (predicate, label, tries = 100) => { for (let i = 0; i < tries; i++) { const found = await predicate(); if (found) return found; await new Promise(r => setTimeout(r, 100)); } throw new Error('UI did not show ' + label); };
  const rail = name => [...document.querySelectorAll('button.rail-button')].find(button => button.getAttribute('aria-label') === name);
`;

const result = { ok: false, steps: {} };
let app;
try {
  app = await connect(isApp, 'App');
  await bridgeReady(app);

  // A synthetic case, online, with the research browser switched on.
  const root = JSON.stringify(workspace.replaceAll('\\', '/'));
  result.steps.case = await app.evaluate(`(async () => { ${helpers}
    const existing = await invoke('snapshot');
    const switching = existing ? { case_id: existing.id, session_epoch: existing.session_epoch } : {};
    const run = Date.now().toString();
    await invoke('create_case', { ...switching, path: ${root} + '/artifacts/research-view-' + run, name: 'Synthetic research view ' + run });
    let snapshot = await invoke('snapshot');
    const ids = { case_id: snapshot.id, session_epoch: snapshot.session_epoch };
    await invoke('save_settings', { ...ids, settings: { ...snapshot.settings, offline: false, allow_text: true, model: 'synthetic' } });
    await invoke('set_research_grant', { ...ids, enabled: true, sso_hosts: [] });
    return snapshot.id;
  })()`);
  await app.call('Page.reload', { ignoreCache: false });
  await sleep(500);
  await bridgeReady(app);

  // The rail's Browser button opens chat beside the research pane.
  const slot = await app.evaluate(`(async () => { ${helpers}
    (await wait(() => rail('Browser'), 'Browser rail button')).click();
    const element = await wait(() => document.querySelector('.research-slot'), 'research slot');
    await wait(async () => { const state = await invoke('research_pane_state'); return state.open && state.host === '127.0.0.1'; }, 'open pane', 150);
    await wait(() => document.querySelector('.research-status-open'), 'connected status');
    await new Promise(r => setTimeout(r, 600));
    const box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height, chat: Boolean(document.querySelector('.research-split .research-split-chat textarea, .research-split .research-split-chat [contenteditable=true]')) };
  })()`);
  result.steps.slot = slot;
  const probe = go => app.evaluate(`window.__TAURI_INTERNALS__.invoke('command', { action: 'research_debug_probe', args: { go: ${JSON.stringify(go ?? null)} } })`);
  const page = () => probe();
  const shown = await page();
  result.steps.shown = shown;
  if (Math.abs(shown.width - slot.width) > 2 || Math.abs(shown.height - slot.height) > 2) throw new Error(`Pane size ${shown.width}x${shown.height} does not match its slot ${slot.width}x${slot.height}`);
  if (shown.visibility !== 'visible') throw new Error('Pane is not visible in the Browser view');
  if (!slot.chat) throw new Error('The chat is not shown beside the browser');

  // Leaving the view hides the pane; coming back shows it again.
  await app.evaluate(`(async () => { ${helpers} rail('Chat').click(); await new Promise(r => setTimeout(r, 600)); })()`);
  result.steps.after_leaving = await page();
  if (result.steps.after_leaving.visibility !== 'hidden') throw new Error('Pane stayed visible after leaving the Browser view');
  await app.evaluate(`(async () => { ${helpers} rail('Browser').click(); await wait(() => document.querySelector('.research-status-open'), 'connected status'); await new Promise(r => setTimeout(r, 600)); })()`);
  result.steps.after_return = await page();
  if (result.steps.after_return.visibility !== 'visible') throw new Error('Pane did not come back with the Browser view');

  // A dialog over the view hides the pane while it is open.
  await app.evaluate(`(async () => { ${helpers}
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true }));
    await wait(() => document.querySelector('dialog[open]'), 'settings dialog');
    await new Promise(r => setTimeout(r, 600));
  })()`);
  result.steps.with_dialog = await page();
  if (result.steps.with_dialog.visibility !== 'hidden') throw new Error('Pane covered an open dialog');
  await app.evaluate(`(async () => { ${helpers}
    document.querySelector('dialog[open]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.querySelector('dialog[open]')?.close();
    await wait(() => !document.querySelector('dialog[open]'), 'dialog closed');
    await new Promise(r => setTimeout(r, 600));
  })()`);
  result.steps.dialog_closed = await page();
  if (result.steps.dialog_closed.visibility !== 'visible') throw new Error('Pane did not return after the dialog closed');

  // The user browses to another page; the toolbar's Back button returns.
  await probe('second');
  for (let attempt = 0; attempt < 50; attempt++) { await sleep(100); try { if ((await page())?.url?.endsWith('/second.html')) break; } catch { /* navigating */ } }
  result.steps.browsed = await page();
  if (!result.steps.browsed?.url?.endsWith('/second.html')) throw new Error('The pane did not reach the second page');
  await app.evaluate(`(async () => { ${helpers} (await wait(() => document.querySelector('button[aria-label="Back"]'), 'Back button')).click(); })()`);
  let back;
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(150);
    try { back = await page(); if (back?.url?.endsWith('/index.html')) break; } catch { /* navigating */ }
  }
  result.steps.after_back = back;
  if (!back?.url.endsWith('/index.html')) throw new Error('Back did not return the pane to the previous page');

  await app.call('Page.enable');
  const screenshot = await app.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  result.ok = true;
} catch (error) {
  result.error = String(error?.message ?? error);
} finally {
  app?.close();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
