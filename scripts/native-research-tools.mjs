// Native journey: each research tool run directly on the open pane through the debug-only
// research_debug_probe job runner (test mode). Earlier header follows:
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
    await invoke('create_case', { ...switching, path: ${root} + '/artifacts/research-tools-' + run, name: 'Synthetic research tools ' + run });
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
  const job = (name, args) => app.evaluate(`window.__TAURI_INTERNALS__.invoke('command', { action: 'research_debug_probe', args: { job: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} } })`);
  const failures = [];
  const check = (name, condition, detail) => { result.steps[name] = { passed: Boolean(condition), detail }; if (!condition) failures.push(name); };

  // The fast Westlaw search on the fixture's Westlaw-shaped pages.
  const search = await job('research_westlaw_search', { query: 'adv: theft /s "lawful owner"', jurisdiction: null, content_type: 'cases' });
  const rows = search.ok?.rows ?? [];
  check('westlaw_search_rows', rows.length > 0 && rows[0].url, search.error ?? { total_label: search.ok?.total_label, rows: rows.slice(0, 2), filters: search.ok?.filters });
  if (search.error) result.steps.page_after_search = await job('research_status', {});
  if (rows[0]?.url) {
    const doc = await job('research_westlaw_document', { url: rows[0].url });
    const d = doc.ok ?? {};
    check('westlaw_document', d.title && (d.lines ?? []).length > 0 && (d.all_citations ?? d.citations ?? []).length > 0, doc.error ?? { title: d.title, court: d.court, citations: d.all_citations, keycite: d.keycite, total_lines: d.total_lines });
    check('keycite_read', d.keycite && d.keycite.flag && d.keycite.flag !== 'unknown', d.keycite);
  }

  // Typing replaces what a field held; key combinations work.
  await job('research_navigate', { url: `${fixture}/index.html` });
  const snap = await job('research_snapshot', { scope: 'interactive', find: null, delta: false, max_chars: null });
  const text = snap.ok?.snapshot?.text ?? '';
  const ref = /searchbox "Search" \[ref=(e\d+)\]/.exec(text)?.[1];
  const version = snap.ok?.snapshot?.version;
  const first = await job('research_act', { action: 'type', ref, snapshot_version: version, text: 'first query', key: null });
  const second = await job('research_act', { action: 'type', ref, snapshot_version: version, text: 'second query', key: null });
  const after = second.ok?.snapshot?.text ?? '';
  // The result is a line diff: '+' lines are the field now, '-' lines what it held before.
  const now = after.split('\n').filter(line => !line.startsWith('-')).join('\n');
  check('typing_replaces', !first.error && !second.error && /searchbox "Search"[^\n]*: second query$/m.test(now) && !/first query/.test(now), first.error ?? second.error ?? after.slice(0, 300));
  const combo = await job('research_act', { action: 'press', ref: null, snapshot_version: null, text: null, key: 'Control+A' });
  check('key_combination', !combo.error, combo.error ?? 'pressed');
  const refused = await job('research_act', { action: 'press', ref: null, snapshot_version: null, text: null, key: 'Control+W' });
  check('browser_shortcut_refused', Boolean(refused.error), refused.error ?? 'was pressed');

  await app.call('Page.enable');
  const screenshot = await app.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  result.failures = failures;
  result.ok = failures.length === 0;
} catch (error) {
  result.error = String(error?.message ?? error);
} finally {
  app?.close();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
