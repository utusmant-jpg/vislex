// Second phase of native-research-pane.ps1: sign out of the research browser, which closes
// the pane and deletes its profile. The launcher then checks the profile folder is gone.
(async () => {
  const invoke = (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  await invoke('clear_research_session');
  const state = await invoke('research_pane_state');
  return { ok: !state.open, state };
})().catch(error => ({ ok: false, error: String(error) }))
