// Drive the real desktop app over CDP: open a copied case, point analysis at the
// synthetic provider, and record progress until the run settles.
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const [port, casePath, mockPort, outFile, maxMinutes = '240', provider = 'openai'] = process.argv.slice(2);
// zai: text-only GLM-5.3 default with GLM-5.3-Flash approved for images, so
// visual units must route to Flash; a chat turn then checks the text-only path.
const ai = provider === 'zai'
  ? { config: { provider: 'zai', execution: 'auto', review: 'standard', pool: [{ provider: 'zai', model: 'glm-5.3-flash', allow_text: true, allow_images: true }] }, model: 'glm-5.3' }
  : { config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [] }, model: 'gpt-5.4' };
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const log = (...parts) => process.stderr.write(`${new Date().toISOString()} ${parts.join(' ')}\n`);
try {
  const page = browser.contexts().flatMap(c => c.pages())[0];
  if (!page) throw new Error('Native WebView unavailable');
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke));
  const invoke = (action, args = {}) => page.evaluate(([a, b]) => window.__TAURI_INTERNALS__.invoke('command', { action: a, args: b }), [action, args]);
  const mock = async () => (await fetch(`http://127.0.0.1:${mockPort}/state`)).json();
  const opened = await invoke('open_case', { path: casePath });
  const context = { case_id: opened.id, session_epoch: opened.session_epoch };
  // A copied case may carry a per-case ChatGPT-subscription override; this
  // harness measures the API-key route against the loopback synthetic provider.
  await invoke('set_case_ai_access_route', { ...context, route: 'api_keys' });
  // The grants are confirmed for the configured company, as Settings asks a person to.
  await invoke('save_ai_settings', { ...context, config: ai.config, grants_for_provider: ai.config.provider, settings: { ...opened.settings, offline: false, allow_text: true, allow_images: true, model: ai.model } });
  await invoke('control_analysis', { ...context, operation: 'resume' });
  const started = Date.now();
  let status = null, last = '';
  while (Date.now() - started < Number(maxMinutes) * 60000) {
    const snapshot = await invoke('snapshot');
    status = snapshot.analysis_status;
    const state = await mock();
    const line = `${status?.state} ${status?.complete}/${status?.total} blocked=${status?.blocked} gaps=${status?.gaps} findings=${status?.findings} requests=${state.requests.length} errors=${state.errors.length}`;
    if (line !== last) { log(line); last = line; }
    if (state.errors.length) log('mock error:', state.errors.at(-1));
    if (status && ['ready', 'blocked', 'paused', 'cancelled'].includes(status.state) && status.running === 0) break;
    await new Promise(r => setTimeout(r, 10000));
  }
  const state = await mock();
  const byKind = {};
  for (const r of state.requests) {
    const k = byKind[r.kind] ??= { requests: 0, images: 0, estimated_input_tokens: 0, max_request_tokens: 0, models: {} };
    k.requests++; if (r.model) k.models[r.model] = (k.models[r.model] ?? 0) + 1; k.images += r.images; k.estimated_input_tokens += r.estimated_input_tokens; k.max_request_tokens = Math.max(k.max_request_tokens, r.estimated_input_tokens);
  }
  let chat = null;
  if (provider === 'zai') {
    const before = (await mock()).requests.length;
    const started = await invoke('start_task', { ...context, prompt: 'Describe visually what can you see when the officer first approaches the door.' });
    let task = null;
    for (let i = 0; i < 180 && !task; i++) {
      await new Promise(r => setTimeout(r, 1000));
      task = (await invoke('snapshot')).tasks.find(t => t.id === started.task_id && t.status !== 'running') ?? null;
    }
    const turns = (await mock()).requests.slice(before).filter(r => r.kind === 'chat');
    chat = { status: task?.status ?? 'still running', turns: turns.length, models: [...new Set(turns.map(t => t.model))], text_only_notice: turns.some(t => t.text_only_notice), image_tools_offered: Math.max(0, ...turns.map(t => t.image_tools)) };
    log('chat', JSON.stringify(chat));
  }
  const knowledge = await invoke('query_case_knowledge', { ...context, query: '', offset: 0 });
  const result = { minutes: (Date.now() - started) / 60000, status, requests: state.requests.length, estimated_input_tokens: state.requests.reduce((a, r) => a + r.estimated_input_tokens, 0), by_kind: byKind, chat, mock_errors: state.errors.slice(-5), knowledge_items_first_page: knowledge.items?.length };
  writeFileSync(outFile, JSON.stringify({ ...result, request_log: state.requests }, null, 1));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await browser.close(); }
