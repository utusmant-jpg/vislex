// Evaluated in the VisLex main webview by native-cdp-eval.mjs: runs the debug-only R34 spike
// against the loopback fixture and returns its measurements.
(async () => {
  const origin = `http://127.0.0.1:${__MOCK_PORT__}`;
  const profile = __WORKSPACE__ + '/artifacts/research-spike-profile-' + Date.now();
  const invoke = window.__TAURI_INTERNALS__.invoke;
  try {
    const report = await invoke('command', { action: 'research_spike', args: { url: `${origin}/index.html`, profile } });
    return { ok: true, report };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
})()
