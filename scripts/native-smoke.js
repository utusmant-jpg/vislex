// Run with agent-browser eval --stdin against the development app's explicit CDP test port.
// Uses only synthetic fixture files. No key or provider request is made.
(async () => {
  const invoke = (action, args = {}) => window.__TAURI_INTERNALS__.invoke('command', { action, args });
  const root = window.__smokeRoot;
  if (!root) throw new Error('Use scripts/test-native.ps1 to supply the synthetic fixture root.');
  const path = `${root}\\artifacts\\native-smoke-${Date.now()}.ledcase`;
  await invoke('create_case', { path, name: 'Synthetic native acceptance' });
  const names = ['statement.pdf', 'photograph.png', 'table.xlsx', 'notes.docx', 'variable-timing.mp4', 'synthetic-speech.wav'];
  const receipt = await invoke('import_files', { paths: names.map(name => `${root}\\fixtures\\generated\\${name}`), production: 'Synthetic demonstration' });
  if (receipt.items.some(item => item.status === 'failed')) throw new Error(JSON.stringify(receipt));
  const snapshot = await invoke('snapshot');
  if (snapshot.sources.length !== 6 || !snapshot.settings.offline) throw new Error('Import or offline invariant failed');
  const source = snapshot.sources.find(source => source.name === 'statement.pdf');
  await invoke('process_source', { source_id: source.id });
  const text = await invoke('read_text', { source_id: source.id, start: 1, count: 20 });
  await invoke('validate_citation', { citation: text.locator });
  const record = await invoke('write_record', { base_revision: 0, title: 'Synthetic review notes', kind: 'report', content: `# Native acceptance\n\nMachine extraction; human verification needed.\n\n${text.locator}`, source_ids: [source.id], reason: 'Synthetic native test' });
  window.__nativeSmoke = { path, record, sources: snapshot.sources };
  return { case_path: path, source_count: snapshot.sources.length, citation: text.locator, record_revision: record.revision, offline: true };
})()
