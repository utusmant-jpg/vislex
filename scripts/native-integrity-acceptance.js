// Synthetic-only explicit Verify journey through the packaged Tauri bridge.
(async () => {
  const invoke = async (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const fixture = `${root}/artifacts/integrity-256m.bin`;
  await invoke('create_case', { path: `${root}/artifacts/integrity-case-${run}`, name: `Synthetic integrity ${run}` });
  const imported = await invoke('import_files', { paths: [fixture], production: 'Synthetic integrity' });
  if (imported.items[0]?.status !== 'imported') throw new Error('Synthetic import failed');
  const snapshot = await invoke('snapshot');
  const source = snapshot.sources[0];
  if (!source || source.size !== 256 * 1024 * 1024) throw new Error('Synthetic source size mismatch');
  const started = performance.now();
  let finished = false;
  const verification = invoke('verify_source', { source_id: source.id }).finally(() => { finished = true; });
  const summaries = [];
  for (let i = 0; i < 12; i++) {
    const before = performance.now();
    const summary = await invoke('case_summary', { case_id: snapshot.id });
    summaries.push({ elapsed_ms: performance.now() - before, completed_before_verify: !finished });
    if (summary.case_id !== snapshot.id) throw new Error('Case changed during verification');
    if (finished && i >= 2) break;
  }
  const result = await verification;
  const verificationMs = performance.now() - started;
  if (!result.verified || result.method !== 'full-sha256-reread') throw new Error('Explicit Verify did not return a strong check');
  return { run, source_bytes: source.size, hashed_bytes: source.size, verification_ms: verificationMs, summary_samples: summaries, summaries_completed_during_hash: summaries.filter(s => s.completed_before_verify).length, case_id: snapshot.id };
})()
