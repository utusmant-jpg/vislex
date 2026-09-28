// Synthetic 1 GiB import and same-case reopen race through the packaged bridge.
(async () => {
  const invoke = async (action, args = {}) => {
    try { return await window.__TAURI_INTERNALS__.invoke('command', { action, args }); }
    catch (error) { throw new Error(`${action}: ${String(error)}`); }
  };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const path = `${root}/artifacts/large-tier-${run}`;
  const fixture = `${root}/artifacts/large-1g.bin`;
  const created = await invoke('create_case', { path, name: `Synthetic 1 GiB ${run}` });
  await invoke('save_settings', { case_id: created.id, session_epoch: created.session_epoch, settings: { ...created.settings, offline: true, allow_text: false, allow_images: false } });
  const importStart = performance.now();
  const imported = await invoke('import_files', { case_id: created.id, session_epoch: created.session_epoch, paths: [fixture], production: 'Synthetic large tier' });
  const importMs = performance.now() - importStart;
  if (imported.items[0]?.status !== 'imported') throw new Error('1 GiB synthetic import failed');
  const snapshot = await invoke('snapshot');
  const source = snapshot.sources[0];
  if (!source || source.size !== 1024 * 1024 * 1024) throw new Error('1 GiB source size mismatch');
  const verifyStart = performance.now();
  let finished = false;
  const verification = invoke('verify_source', { case_id: snapshot.id, session_epoch: snapshot.session_epoch, source_id: source.id }).finally(() => { finished = true; });
  const summaries = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now();
    const summary = await invoke('case_summary', { case_id: snapshot.id, session_epoch: snapshot.session_epoch });
    summaries.push({ elapsed_ms: performance.now() - before, before_verify_finished: !finished });
    if (summary.case_id !== snapshot.id || summary.source_count !== 1) throw new Error('Large case summary changed unexpectedly');
  }
  const result = await verification;
  const verifyMs = performance.now() - verifyStart;
  if (!result.verified || summaries.filter(s => s.before_verify_finished).length < 10) throw new Error('Strong Verify did not remain responsive');
  const oldEpoch = snapshot.session_epoch;
  const pending = invoke('verify_source', { case_id: snapshot.id, session_epoch: oldEpoch, source_id: source.id }).then(() => ({ succeeded: true }), error => ({ succeeded: false, error: String(error) }));
  await new Promise(resolve => setTimeout(resolve, 100));
  await invoke('close_case', { case_id: snapshot.id, session_epoch: snapshot.session_epoch });
  const reopened = await invoke('open_case', { path });
  const late = await pending;
  if (late.succeeded || !/Case session changed|Case closed/.test(late.error)) throw new Error(`Old-session Verify was accepted after reopen: ${JSON.stringify(late)}`);
  if (reopened.id !== snapshot.id || reopened.session_epoch <= oldEpoch) throw new Error('Same-case reopen did not advance epoch');
  const fresh = await invoke('case_summary', { case_id: reopened.id, session_epoch: reopened.session_epoch });
  if (fresh.source_count !== 1 || fresh.session_epoch !== reopened.session_epoch) throw new Error('Reopened large case lost its source');
  return { run, case_id: reopened.id, source_bytes: source.size, import_ms: importMs, verify_ms: verifyMs, summary_samples: summaries, summaries_during_verify: summaries.filter(s => s.before_verify_finished).length, session_epochs: [oldEpoch, reopened.session_epoch], late_old_verify_denied: true };
})().catch(error => ({ native_error: String(error), stack: String(error?.stack ?? '') }))
