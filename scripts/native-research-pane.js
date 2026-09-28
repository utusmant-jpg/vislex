// Evaluated in the VisLex main webview by native-cdp-eval.mjs (R39): research pane commands,
// the per-case toggle and the automatic close triggers, against the loopback fixture only.
(async () => {
  const invoke = async (action, args = {}) => {
    try { return await window.__TAURI_INTERNALS__.invoke('command', { action, args }); }
    catch (error) { throw new Error(action + ': ' + String(error)); }
  };
  const refused = async (action, args) => { try { await invoke(action, args); return null; } catch (error) { return String(error.message); } };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const rect = { x: 700, y: 60, width: 700, height: 800 };
  const result = {};

  const existing = await invoke('snapshot');
  const switching = existing ? { case_id: existing.id, session_epoch: existing.session_epoch } : {};
  await invoke('create_case', { ...switching, path: root + '/artifacts/research-pane-' + run, name: 'Synthetic research pane ' + run });
  let snapshot = await invoke('snapshot');
  const ids = () => ({ case_id: snapshot.id, session_epoch: snapshot.session_epoch });

  result.open_while_offline = await refused('open_research_pane', { ...ids(), rect });
  expect(result.open_while_offline?.includes('Offline mode'), 'Pane opened for an offline case: ' + result.open_while_offline);
  result.enable_while_offline = await refused('set_research_grant', { ...ids(), enabled: true });
  expect(result.enable_while_offline?.includes('offline'), 'Research browser enabled while offline');

  await invoke('save_settings', { ...ids(), settings: { ...snapshot.settings, offline: false, allow_text: true, model: 'synthetic' } });
  snapshot = await invoke('snapshot');
  result.open_while_off = await refused('open_research_pane', { ...ids(), rect });
  expect(result.open_while_off?.includes('Turn on the research browser'), 'Pane opened without the case toggle: ' + result.open_while_off);
  const grant = await invoke('set_research_grant', { ...ids(), enabled: true, sso_hosts: [] });
  expect(grant.enabled && grant.revision === 1, 'Toggle did not enable');
  expect((await invoke('research_grant', { case_id: snapshot.id })).enabled, 'Toggle not persisted');

  await invoke('open_research_pane', { ...ids(), rect });
  let state = await invoke('research_pane_state');
  for (let attempt = 0; attempt < 50 && !state.host; attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); state = await invoke('research_pane_state'); }
  expect(state.open && state.case_id === snapshot.id && state.host === '127.0.0.1', 'Pane state wrong after open: ' + JSON.stringify(state));
  await invoke('open_research_pane', { ...ids(), rect });
  result.reopen_is_idempotent = true;
  await invoke('research_pane_layout', { rect: { x: 720, y: 80, width: 600, height: 500 }, visible: true });
  await invoke('research_pane_layout', { rect, visible: false });
  await invoke('research_pane_layout', { rect, visible: true });
  result.layout_ok = true;

  // Turning the toggle off closes the pane.
  await invoke('set_research_grant', { ...ids(), enabled: false });
  state = await invoke('research_pane_state');
  expect(!state.open, 'Pane stayed open after the toggle was switched off');
  result.closed_on_toggle_off = true;

  // Going offline closes the pane.
  await invoke('set_research_grant', { ...ids(), enabled: true });
  await invoke('open_research_pane', { ...ids(), rect });
  snapshot = await invoke('snapshot');
  await invoke('save_settings', { ...ids(), settings: { ...snapshot.settings, offline: true } });
  expect(!(await invoke('research_pane_state')).open, 'Pane stayed open after going offline');
  result.closed_on_offline = true;

  // Switching to another case closes the pane.
  snapshot = await invoke('snapshot');
  await invoke('save_settings', { ...ids(), settings: { ...snapshot.settings, offline: false } });
  await invoke('open_research_pane', { ...ids(), rect });
  await invoke('create_case', { ...ids(), path: root + '/artifacts/research-pane-other-' + run, name: 'Synthetic other case ' + run });
  expect(!(await invoke('research_pane_state')).open, 'Pane stayed open after switching case');
  result.closed_on_case_switch = true;

  // Sign-out runs as a second phase (native-research-signout.js) after the launcher checks the profile.
  return { ok: true, result };
})().catch(error => ({ ok: false, error: String(error.message ?? error) }))
