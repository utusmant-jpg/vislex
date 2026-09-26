// Synthetic-only explicit Verify journey through the packaged Tauri bridge.
(async () => {
  for (let attempt = 0; attempt < 100 && !window.__TAURI_INTERNALS__?.invoke; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!window.__TAURI_INTERNALS__?.invoke) throw new Error('VisLex Tauri bridge did not become ready');
  const invoke = async (action, args = {}) => { try { return await window.__TAURI_INTERNALS__.invoke('command', { action, args }); } catch (error) { throw new Error(`${action}: ${String(error)}`); } };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const fixture = `${root}/artifacts/integrity-256m.bin`;
  const emptyPath = `${root}/artifacts/delete-acceptance-${run}`;
  const empty = await invoke('create_case', { path: emptyPath, name: `Synthetic deletion ${run}` });
  const deletedEmpty = await invoke('delete_case', { case_id: empty.id, session_epoch: empty.session_epoch, path: emptyPath, confirm: empty.name });
  if (!deletedEmpty.deleted) throw new Error('Current-session deletion of the isolated empty case failed');
  const casePath = `${root}/artifacts/integrity-case-${run}`;
  const created = await invoke('create_case', { path: casePath, name: `Synthetic integrity ${run}` });
  if (!Number.isSafeInteger(created.session_epoch)) throw new Error('Created case did not report a session epoch');
  await invoke('close_case');
  const reopened = await invoke('open_case', { path: casePath });
  if (reopened.id !== created.id || reopened.session_epoch <= created.session_epoch) throw new Error('Same-case reopen did not advance the session epoch');
  const reopenedSummary = await invoke('case_summary', { case_id: reopened.id });
  if (reopenedSummary.session_epoch !== reopened.session_epoch) throw new Error('Summary session epoch disagrees with the reopened case');
  if (!Number.isSafeInteger(reopenedSummary.event_seq)) throw new Error('Summary lacks an event sequence');
  const caseEvents = [];
  await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'case-event', target: { kind: 'Any' }, handler: window.__TAURI_INTERNALS__.transformCallback(event => caseEvents.push(event.payload)) });
  let staleSessionDenied = false;
  try { await invoke('save_settings', { case_id: reopened.id, session_epoch: created.session_epoch, settings: reopened.settings }); }
  catch (error) { staleSessionDenied = String(error).includes('Case session changed'); }
  if (!staleSessionDenied) throw new Error('Stale same-case session changed settings after reopen');
  let staleDeleteDenied = false;
  try { await invoke('delete_case', { case_id: reopened.id, session_epoch: created.session_epoch, path: casePath, confirm: reopened.name }); }
  catch (error) { staleDeleteDenied = String(error).includes('Case session changed'); }
  if (!staleDeleteDenied) throw new Error('Stale same-case session deleted the reopened case');
  let wrongDeleteTargetDenied = false;
  try { await invoke('delete_case', { case_id: reopened.id, session_epoch: reopened.session_epoch, path: `${root}/fixtures/generated`, confirm: reopened.name }); }
  catch (error) { wrongDeleteTargetDenied = String(error).includes('Delete target is not the open case'); }
  if (!wrongDeleteTargetDenied) throw new Error('Deletion accepted a different folder');
  const imported = await invoke('import_files', { case_id: created.id, paths: [fixture], production: 'Synthetic integrity' });
  if (imported.items[0]?.status !== 'imported') throw new Error('Synthetic import failed');
  const snapshot = await invoke('snapshot');
  if (!Number.isSafeInteger(snapshot.event_seq) || snapshot.event_seq < reopenedSummary.event_seq) throw new Error('Case event sequence went backwards');
  const source = snapshot.sources[0];
  if (!source || source.size !== 256 * 1024 * 1024) throw new Error('Synthetic source size mismatch');
  const mandatorySessionActions = [
    ['reclaim_staging', {}],
    ['rename', { kind: 'source', id: 'missing', name: 'Old session rename' }],
    ['set_restricted', { source_id: 'missing', restricted: true }],
    ['write_record', { title: 'Old session note', kind: 'note', content: 'No mutation', source_ids: [] }],
    ['review_record', { record_id: 'missing', revision: 1 }],
    ['rollback', { record_id: 'missing', target: 1, base_revision: 1 }],
    ['save_ai_config', { config: {} }],
    ['save_settings', { settings: reopened.settings }],
    ['delete_conversation', { conversation_id: 'missing' }],
    ['review_dossier_claim', { task_id: 'missing', revision: 1, claim_index: 0, decision: 'accepted', note: '' }],
    ['save_ai_settings', { config: {}, settings: reopened.settings }],
    ['set_direct_media_permission', { enabled: true }],
    ['start_task', { prompt: 'Old session should not start a chat' }],
    ['stop_task', { task_id: 'missing' }],
    ['resume_task', { task_id: 'missing' }],
    ['continue_paused_task', { task_id: 'missing' }],
  ];
  const staleSessionActions = [
    ['import_files', { paths: [fixture], production: 'Rejected old session' }],
    ['process_source', { source_id: source.id }],
    ['playback_proxy', { source_id: source.id }],
    ['verify_source', { source_id: source.id }],
    ['backup', { path: `${root}/artifacts/rejected-session-backup-${run}.age`, password: 'synthetic-passphrase-only' }],
    ['export_dossier_bundle', { task_id: 'missing', path: `${root}/artifacts/rejected-session-package-${run}` }],
    ['export_redaction', { artifact_id: 'missing', path: `${root}/artifacts/rejected-session-redaction-${run}.pdf` }],
    ['review_redaction', { artifact_id: 'missing', pages: [1], note: 'Rejected old session' }],
    ['save_speaker_annotations', { source_id: source.id, artifact_id: 'missing', revision: 0, labels: {}, turns: {} }],
    ['hybrid_search', { query: 'synthetic' }],
    ...mandatorySessionActions,
  ];
  for (const [action, args] of staleSessionActions) {
    let rejected = false;
    try { await invoke(action, { case_id: snapshot.id, session_epoch: created.session_epoch, ...args }); }
    catch (error) { rejected = String(error).includes('Case session changed'); }
    if (!rejected) throw new Error(`${action} did not reject an old session before work`);
  }
  for (const [action, args] of mandatorySessionActions) {
    let rejected = false;
    try { await invoke(action, { case_id: snapshot.id, ...args }); }
    catch (error) { rejected = String(error).includes('Missing session_epoch'); }
    if (!rejected) throw new Error(`${action} accepted a missing session epoch`);
  }
  let stalePermissionDenied = false;
  try { await invoke('set_direct_media_permission', { case_id: 'closed-synthetic-case', enabled: true }); } catch { stalePermissionDenied = true; }
  if (!stalePermissionDenied) throw new Error('Stale case permission update was accepted');
  const object = { id: null, base_revision: 0, kind: 'note', title: 'Synthetic fenced finding', content: 'Synthetic record only', source_ids: [source.id], locators: [], dependencies: [], start_seconds: null, end_seconds: null };
  let staleWriteDenied = false;
  try { await invoke('evidence_write', { case_id: 'closed-synthetic-case', object }); } catch { staleWriteDenied = true; }
  if (!staleWriteDenied) throw new Error('Stale case finding update was accepted');
  let staleSessionFindingDenied = false;
  try { await invoke('evidence_write', { case_id: snapshot.id, session_epoch: created.session_epoch, object }); }
  catch (error) { staleSessionFindingDenied = String(error).includes('Case session changed'); }
  if (!staleSessionFindingDenied) throw new Error('An old same-case session wrote a finding');
  const finding = await invoke('evidence_write', { case_id: snapshot.id, session_epoch: reopened.session_epoch, object });
  let staleReviewDenied = false;
  try { await invoke('evidence_review', { case_id: 'closed-synthetic-case', id: finding.id, revision: finding.revision, review: 'accepted' }); } catch { staleReviewDenied = true; }
  if (!staleReviewDenied) throw new Error('Stale case finding review was accepted');
  let staleSessionReviewDenied = false;
  try { await invoke('evidence_review', { case_id: snapshot.id, session_epoch: created.session_epoch, id: finding.id, revision: finding.revision, review: 'accepted' }); }
  catch (error) { staleSessionReviewDenied = String(error).includes('Case session changed'); }
  if (!staleSessionReviewDenied) throw new Error('An old same-case session reviewed a finding');
  await invoke('evidence_review', { case_id: snapshot.id, session_epoch: reopened.session_epoch, id: finding.id, revision: finding.revision, review: 'accepted' });
  const afterFindings = await invoke('case_summary', { case_id: snapshot.id });
  if (afterFindings.event_seq < snapshot.event_seq + 2) throw new Error('Finding write and review did not advance the event sequence');
  const findingEvents = caseEvents.filter(event => event.case_id === snapshot.id && event.session_epoch === reopened.session_epoch);
  if (findingEvents.length < 2 || findingEvents.some((event, index) => index > 0 && event.event_seq <= findingEvents[index - 1].event_seq)) throw new Error('Case event envelopes were missing or out of order');
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
  const staleCaseActions = [
    ['import_files', { paths: [fixture], production: 'Rejected synthetic import' }],
    ['write_record', { title: 'Rejected synthetic note', kind: 'note', content: 'No mutation', source_ids: [] }],
    ['backup', { path: `${root}/artifacts/rejected-backup-${run}.age`, password: 'synthetic-passphrase-only' }],
    ['transcribe_all', {}],
    ['reclaim_staging', {}],
    ['review_record', { record_id: 'missing', revision: 1 }],
    ['rollback', { record_id: 'missing', target: 1, base_revision: 1 }],
    ['process_source', { source_id: source.id }],
    ['probe_pdf', { source_id: source.id }],
    ['transcribe_source', { source_id: source.id }],
    ['scan_sound_events', { source_id: source.id }],
    ['diarize_source', { source_id: source.id }],
    ['step_video_frame', { source_id: source.id, target: 0, direction: 'next' }],
    ['queue_video_discovery', { source_id: source.id, interval: 5 }],
    ['retry_video_discovery', { run_id: 'missing' }],
    ['cancel_video_discovery', { source_id: source.id }],
    ['resume_processing', { job_id: 'missing' }],
    ['cancel_processing', { job_id: 'missing' }],
    ['set_asr_profile', { model: 'tiny' }],
    ['transcribe_full', { source_id: source.id }],
    ['resume_transcription', { job_id: 'missing' }],
    ['cancel_transcription', { source_id: source.id }],
    ['save_speaker_annotations', { source_id: source.id, artifact_id: 'missing', revision: 0, labels: {}, turns: {} }],
    ['save_ai_config', { config: {} }],
    ['save_settings', { settings: snapshot.settings }],
    ['export_redaction', { artifact_id: 'missing', path: `${root}/artifacts/rejected-redaction-${run}.pdf` }],
    ['rename', { kind: 'source', id: source.id, name: 'Rejected rename' }],
    ['set_restricted', { source_id: source.id, restricted: true }],
  ];
  for (const [action, args] of staleCaseActions) {
    let rejected = false;
    try { await invoke(action, { case_id: 'closed-synthetic-case', ...args }); } catch (error) { rejected = String(error).includes('Case changed'); }
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
  await invoke('close_case');
  const other = await invoke('create_case', { path: `${root}/artifacts/event-case-b-${run}`, name: `Synthetic event case B ${run}` });
  const lastEvent = caseEvents.at(-1);
  if (lastEvent?.case_id !== other.id || lastEvent.session_epoch !== other.session_epoch || lastEvent.event_seq <= afterFindings.event_seq) throw new Error('Case switch did not produce a fenced event');
  return { run, source_bytes: source.size, hashed_bytes: source.size, verification_ms: verificationMs, summary_samples: summaries, summaries_completed_during_hash: summaries.filter(s => s.completed_before_verify).length, stale_permission_denied: stalePermissionDenied, stale_finding_write_denied: staleWriteDenied, stale_finding_review_denied: staleReviewDenied, stale_session_finding_write_denied: staleSessionFindingDenied, stale_session_finding_review_denied: staleSessionReviewDenied, stale_workflows_denied: staleWorkflows.length, stale_case_actions_denied: staleCaseActions.length, stale_same_case_session_denied: staleSessionDenied, stale_session_actions_denied: staleSessionActions.length, stale_delete_denied: staleDeleteDenied, wrong_delete_target_denied: wrongDeleteTargetDenied, valid_empty_case_deleted: deletedEmpty.deleted, session_epochs: [created.session_epoch, reopened.session_epoch, other.session_epoch], event_seqs: [reopenedSummary.event_seq, snapshot.event_seq, afterFindings.event_seq, lastEvent.event_seq], received_case_events: findingEvents.length, case_id: snapshot.id };
})().catch(error => ({ native_error: String(error), stack: String(error?.stack ?? '') }))
