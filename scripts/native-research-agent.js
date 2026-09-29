// Evaluated in the VisLex main webview by native-cdp-eval.mjs (R44): a real chat task drives
// the research pane through the agent loop, with a scripted synthetic provider.
(async () => {
  const invoke = async (action, args = {}) => {
    try { return await window.__TAURI_INTERNALS__.invoke('command', { action, args }); }
    catch (error) { throw new Error(action + ': ' + String(error)); }
  };
  const wait = async (probe, label, attempts = 600) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for ' + label);
  };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const existing = await invoke('snapshot');
  const switching = existing ? { case_id: existing.id, session_epoch: existing.session_epoch } : {};
  const created = await invoke('create_case', { ...switching, path: root + '/artifacts/research-agent-' + run, name: 'Synthetic research agent ' + run });
  const session = { case_id: created.id, session_epoch: created.session_epoch };
  await invoke('import_files', { ...session, paths: [root + '/fixtures/generated/statement.txt'], production: 'Synthetic research agent' });
  await invoke('save_settings', { ...session, settings: { ...created.settings, offline: false, allow_text: true, model: 'gpt-4.1' } });
  await invoke('set_research_grant', { ...session, enabled: true });
  await invoke('open_research_pane', { ...session, rect: { x: 700, y: 60, width: 700, height: 800 } });
  await wait(async () => (await invoke('research_pane_state')).host, 'research pane load');

  const started = await invoke('start_task', { ...session, prompt: 'Research the duty of care in the research browser.' });
  const task = await wait(async () => {
    const item = (await invoke('snapshot')).tasks.find(entry => entry.id === started.task_id);
    return item && item.status !== 'running' ? item : null;
  }, 'research task completion');
  const actions = await invoke('actions', { case_id: session.case_id, task_id: started.task_id });
  const research = actions.filter(action => action.name.startsWith('research_')).map(action => ({ name: action.name, status: action.status, output: action.output.slice(0, 400) }));
  const failures = research.filter(action => action.status !== 'complete' && action.status !== 'ok');

  // R46: the capture is citable evidence, and no editorial text, script or hidden content from
  // the opinion page reached the model, the extract or the authority.
  const editorial = ['HEADNOTE EDITORIAL', 'SCRIPT MARKER', 'SYNTHETIC-HIDDEN-TOKEN', 'HIDDEN PARAGRAPH MARKER', 'Signed in as'];
  const leaks = (text, label) => editorial.filter(marker => String(text).includes(marker)).map(marker => label + ': ' + marker);
  const outputs = actions.filter(action => action.name.startsWith('research_'));
  const captureAction = outputs.find(action => action.name === 'research_capture' && action.status === 'complete');
  let capture = null;
  // Account chrome may appear in navigation snapshots; editorial, script and hidden content may not.
  const leaked = outputs.flatMap(action => leaks(action.output, action.name).filter(found => !found.endsWith('Signed in as')));
  if (captureAction) {
    capture = JSON.parse(captureAction.output);
    const extract = await invoke('read_text', { ...session, source_id: capture.source_id, start: 1, count: 50 });
    const authority = await invoke('evidence_read', { ...session, id: capture.authority_id });
    const detail = await invoke('source_detail', { ...session, source_id: capture.source_id });
    leaked.push(...leaks(extract.text, 'extract'), ...leaks(authority.content, 'authority'));
    capture = {
      locator: capture.locator,
      citation_mismatch: capture.citation_mismatch,
      extract_has_opinion: String(extract.text).includes('duty of reasonable care'),
      authority_kind: authority.kind,
      authority_review: authority.review,
      authority_locators: authority.locators,
      source_size: detail.size,
    };
  }
  const captured = Boolean(capture && /^evidence:[^#]+#R\d+L\d+-L\d+$/.test(capture.locator) && capture.extract_has_opinion && capture.authority_kind === 'authority' && capture.authority_review === 'unreviewed');
  return {
    ok: task.status === 'complete' && (task.answer ?? '').includes('Synthetic research answer: the page begins') && research.length >= 7 && failures.length === 0 && captured && leaked.length === 0,
    task_status: task.status,
    answer: task.answer,
    research,
    failures,
    capture,
    leaked,
  };
})().catch(error => ({ ok: false, error: String(error.message ?? error) }))
