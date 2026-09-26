// Synthetic-only explicit Verify journey through the packaged Tauri bridge.
(async () => {
  for (let attempt = 0; attempt < 100 && !window.__TAURI_INTERNALS__?.invoke; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!window.__TAURI_INTERNALS__?.invoke) throw new Error('VisLex Tauri bridge did not become ready');
  const invoke = async (action, args = {}) => { try { return await window.__TAURI_INTERNALS__.invoke('command', { action, args }); } catch (error) { throw new Error(`${action}: ${String(error)}`); } };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const fixture = `${root}/artifacts/integrity-256m.bin`;
  const created = await invoke('create_case', { path: `${root}/artifacts/integrity-case-${run}`, name: `Synthetic integrity ${run}` });
  const imported = await invoke('import_files', { case_id: created.id, paths: [fixture], production: 'Synthetic integrity' });
  if (imported.items[0]?.status !== 'imported') throw new Error('Synthetic import failed');
  const snapshot = await invoke('snapshot');
  const source = snapshot.sources[0];
  if (!source || source.size !== 256 * 1024 * 1024) throw new Error('Synthetic source size mismatch');
  let stalePermissionDenied = false;
  try { await invoke('set_direct_media_permission', { case_id: 'closed-synthetic-case', enabled: true }); } catch { stalePermissionDenied = true; }
  if (!stalePermissionDenied) throw new Error('Stale case permission update was accepted');
  const object = { id: null, base_revision: 0, kind: 'note', title: 'Synthetic fenced finding', content: 'Synthetic record only', source_ids: [source.id], locators: [], dependencies: [], start_seconds: null, end_seconds: null };
  let staleWriteDenied = false;
  try { await invoke('evidence_write', { case_id: 'closed-synthetic-case', object }); } catch { staleWriteDenied = true; }
  if (!staleWriteDenied) throw new Error('Stale case finding update was accepted');
  const finding = await invoke('evidence_write', { case_id: snapshot.id, object });
  let staleReviewDenied = false;
  try { await invoke('evidence_review', { case_id: 'closed-synthetic-case', id: finding.id, revision: finding.revision, review: 'accepted' }); } catch { staleReviewDenied = true; }
  if (!staleReviewDenied) throw new Error('Stale case finding review was accepted');
  await invoke('evidence_review', { case_id: snapshot.id, id: finding.id, revision: finding.revision, review: 'accepted' });
  const staleWorkflows = [
    ['review_dossier_claim', { case_id: 'closed-synthetic-case', task_id: 'missing', revision: 1, claim_index: 0, decision: 'accepted', note: '' }],
    ['export_dossier_bundle', { case_id: 'closed-synthetic-case', task_id: 'missing', path: `${root}/artifacts/rejected-package-${run}` }],
    ['fetch_public_authority', { case_id: 'closed-synthetic-case', url: 'https://www.govinfo.gov/content/pkg/test/html/test.htm', title: 'Synthetic authority', jurisdiction: 'test', relevant_date: '2026-09-26' }],
  ];
  for (const [action, args] of staleWorkflows) {
    let rejected = false;
    try { await invoke(action, args); } catch (error) { rejected = String(error).includes('Case changed'); }
    if (!rejected) throw new Error(`${action} did not reject the stale case before work`);
  }
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
  return { run, source_bytes: source.size, hashed_bytes: source.size, verification_ms: verificationMs, summary_samples: summaries, summaries_completed_during_hash: summaries.filter(s => s.completed_before_verify).length, stale_permission_denied: stalePermissionDenied, stale_finding_write_denied: staleWriteDenied, stale_finding_review_denied: staleReviewDenied, stale_workflows_denied: staleWorkflows.length, case_id: snapshot.id };
})().catch(error => ({ native_error: String(error), stack: String(error?.stack ?? '') }))
