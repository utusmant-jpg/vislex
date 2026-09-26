// Synthetic-only packaged coordinator race through the real Tauri bridge.
(async () => {
  for (let i = 0; i < 100 && !window.__TAURI_INTERNALS__?.invoke; i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!window.__TAURI_INTERNALS__?.invoke) throw new Error('Tauri bridge did not become ready');
  const invoke = async (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const wait = async (probe, label) => {
    for (let i = 0; i < 150; i++) {
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const opened = await invoke('create_case', { path: `${root}/artifacts/provider-race-${run}`, name: `Synthetic provider race ${run}` });
  const imported = await invoke('import_files', { case_id: opened.id, session_epoch: opened.session_epoch, paths: [`${root}/fixtures/generated/statement.txt`], production: 'Synthetic provider race' });
  if (imported.items[0]?.status !== 'imported') throw new Error('Synthetic provider race source import failed');
  await invoke('save_settings', { case_id: opened.id, session_epoch: opened.session_epoch, settings: { ...opened.settings, offline: false, allow_text: true, model: 'gpt-4.1' } });
  const first = await invoke('start_task', { case_id: opened.id, session_epoch: opened.session_epoch, prompt: 'Give a short synthetic answer.' });
  await wait(async () => { const current = await invoke('snapshot'); return current.tasks.find(t => t.id === first.task_id)?.step >= 1; }, 'first provider request');
  await new Promise(resolve => setTimeout(resolve, 250));
  await invoke('stop_task', { case_id: opened.id, session_epoch: opened.session_epoch, task_id: first.task_id });
  await wait(async () => { const current = await invoke('snapshot'); return current.tasks.find(t => t.id === first.task_id)?.status === 'paused'; }, 'paused original task');
  const second = await invoke('continue_paused_task', { case_id: opened.id, session_epoch: opened.session_epoch, task_id: first.task_id });
  if (second.task_id === first.task_id) throw new Error('Continuation reused the paused task');
  const completed = await wait(async () => { const current = await invoke('snapshot'); const task = current.tasks.find(t => t.id === second.task_id); return task?.status !== 'running' ? task : null; }, 'continuation result');
  if (completed.status !== 'complete' || !completed.answer?.includes('Synthetic provider answer 2')) throw new Error(`Continuation did not complete with the second provider response: ${completed.status} ${completed.error ?? ''}`);
  // Let the original HTTP response arrive after the continuation has finished.
  await new Promise(resolve => setTimeout(resolve, 4500));
  const final = await invoke('snapshot');
  const old = final.tasks.find(t => t.id === first.task_id);
  if (old?.status !== 'paused' || old.answer?.includes('Synthetic provider answer 1')) throw new Error('Late response published into the paused task');
  if (completed.answer?.includes('Synthetic provider answer 1')) throw new Error('Late response published into the continuation');
  return { run, case_id: opened.id, first_task: first.task_id, continuation: second.task_id, old_status: old.status, continuation_status: completed.status, continuation_answer: completed.answer };
})().catch(error => ({ native_error: String(error), stack: String(error?.stack ?? '') }))
