// Synthetic, offline app-wide AI inheritance journey. Invoked through the Tauri bridge.
(async () => {
  const invoke = (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const path = __CASE_PATH__;
  const config = { provider: 'openai', execution: 'auto', review: 'standard', pool: [] };
  const settings = model => ({ offline: true, allow_text: true, allow_images: false, model });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  const initial = await invoke('app_ai_settings');
  assert(!initial.configured, 'The isolated app AI profile was not empty');
  await invoke('save_app_ai_settings', { config, settings: settings('synthetic-app-a') });
  const app = await invoke('app_ai_settings');
  assert(app.configured && app.settings.model === 'synthetic-app-a', 'App settings did not persist');

  await invoke('create_case', { path, name: 'Synthetic app AI inheritance' });
  let current = await invoke('snapshot');
  assert(current.settings.model === 'synthetic-app-a', 'New case did not inherit app AI');
  assert((await invoke('case_ai_scope')).scope === 'app', 'New case did not inherit app scope');

  await invoke('save_app_ai_settings', { config, settings: settings('synthetic-app-b') });
  current = await invoke('snapshot');
  assert(current.settings.model === 'synthetic-app-b', 'Inherited case did not follow updated app AI');

  await invoke('save_ai_settings', { case_id: current.id, session_epoch: current.session_epoch, config, settings: settings('synthetic-case-only') });
  current = await invoke('snapshot');
  assert((await invoke('case_ai_scope')).scope === 'case', 'Case override was not recorded');
  await invoke('save_app_ai_settings', { config, settings: settings('synthetic-app-c') });
  current = await invoke('snapshot');
  assert(current.settings.model === 'synthetic-case-only', 'App settings overwrote the case override');

  await invoke('set_case_ai_scope', { case_id: current.id, session_epoch: current.session_epoch, scope: 'app' });
  current = await invoke('snapshot');
  assert(current.settings.model === 'synthetic-app-c', 'Returning to app settings did not apply the current app AI');
  const caseId = current.id;
  await invoke('close_case', { case_id: caseId, session_epoch: current.session_epoch });
  await invoke('open_case', { path });
  current = await invoke('snapshot');
  assert(current.id === caseId && current.settings.model === 'synthetic-app-c', 'Inheritance did not survive reopen');
  assert((await invoke('case_ai_scope')).scope === 'app', 'App scope did not survive reopen');
  return { case_id: caseId, app_default: 'synthetic-app-c', override_preserved: true, reopened_inheritance: true, provider_calls: 0 };
})()
