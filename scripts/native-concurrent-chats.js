// Synthetic provider transport verifies separate chats can overlap and finish independently.
(async () => {
  const invoke = async (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const wait = async (probe, label) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const root = __WORKSPACE__;
  const run = Date.now().toString();
  const created = await invoke('create_case', { path: `${root}/artifacts/concurrent-chats-${run}`, name: `Synthetic concurrent chats ${run}` });
  const session = { case_id: created.id, session_epoch: created.session_epoch };
  const imported = await invoke('import_files', { ...session, paths: [`${root}/fixtures/generated/statement.txt`], production: 'Synthetic concurrent chats' });
  if (imported.items[0]?.status !== 'imported') throw new Error('Synthetic source import failed');
  await invoke('save_settings', { ...session, settings: { ...created.settings, offline: false, allow_text: true, model: 'gpt-4.1' } });
  const first = await invoke('start_task', { ...session, prompt: 'Give synthetic answer one.' });
  await wait(async () => (await invoke('snapshot')).tasks.find(task => task.id === first.task_id)?.step >= 1, 'first provider dispatch');
  const second = await invoke('start_task', { ...session, prompt: 'Give synthetic answer two.' });
  if (first.task_id === second.task_id || first.conversation_id === second.conversation_id) throw new Error('Separate chats shared task or conversation identity');
  const secondCompleted = await wait(async () => {
    const snapshot = await invoke('snapshot');
    const task = snapshot.tasks.find(item => item.id === second.task_id);
    return task?.status !== 'running' ? { task, first: snapshot.tasks.find(item => item.id === first.task_id) } : null;
  }, 'second chat completion');
  if (secondCompleted.task?.status !== 'complete' || !secondCompleted.task.answer?.includes('Synthetic provider answer 2')) throw new Error('Second chat did not receive its own provider response');
  if (secondCompleted.first?.status !== 'running') throw new Error('First chat was not still active when second chat completed');
  const firstCompleted = await wait(async () => {
    const task = (await invoke('snapshot')).tasks.find(item => item.id === first.task_id);
    return task?.status !== 'running' ? task : null;
  }, 'first chat completion');
  if (firstCompleted.status !== 'complete' || !firstCompleted.answer?.includes('Synthetic provider answer 1')) throw new Error('First chat did not retain its own provider response');
  return { run, separate_conversations: true, second_finished_while_first_running: true, first_complete: true, second_complete: true };
})().catch(error => ({ native_error: String(error) }))
