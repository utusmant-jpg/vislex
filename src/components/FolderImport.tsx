import { useRef, useState } from 'react';
import { api, native } from '../bridge';

export default function FolderImport({ caseId, sessionEpoch, hasCase, run, refresh }: { caseId?: string; sessionEpoch?: number; hasCase: boolean; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState('');
  const [name, setName] = useState('Evidence review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openExisting, setOpenExisting] = useState(false);

  async function importFolder() {
    setBusy(true); setError('');
    try {
      if (openExisting && !hasCase) {
        await api('open_case', { path });
        await refresh(); dialog.current?.close(); setOpenExisting(false);
        return;
      }
      let targetCase = caseId;
      let targetEpoch = sessionEpoch;
      if (!hasCase) {
        const safe = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, '');
        if (!safe) throw new Error('Enter a valid case name');
        const created = await api<{ id: string; session_epoch?: number }>('create_case', { path: `${path.replace(/[\\/]$/, '')}\\${safe}.ledcase`, name });
        targetCase = created.id;
        targetEpoch = created.session_epoch;
      }
      if (!targetCase) throw new Error('Open a case first.');
      const receipt = await api<{ items: { status: string; detail: { error?: string } }[]; skipped?: { path: string; reason: string }[] }>('import_folder', { case_id: targetCase, session_epoch: targetEpoch, path, production: 'Folder import' });
      await refresh();
      const failed = receipt.items.filter(item => item.status === 'failed');
      if (failed.length) throw new Error(`${failed.length} files failed: ${failed.map(item => item.detail.error).join('; ')}`);
      if (receipt.skipped?.length) setError(`Imported ${receipt.items.length} files. Skipped: ${receipt.skipped.map(item => `${item.path} (${item.reason})`).join('; ')}`);
      else dialog.current?.close();
    } catch (reason) { setError(String(reason)); await refresh(); }
    finally { setBusy(false); }
  }

  return <>
    <button className="quiet" disabled={!native} onClick={() => { setError(''); dialog.current?.showModal(); }}>Import folder</button>
    <dialog ref={dialog} className="modal">
      <h2>{openExisting ? 'Open an existing case folder' : hasCase ? 'Import evidence folder' : 'Create a case from a folder'}</h2>
      {!hasCase ? <label className="field-label"><span><input type="checkbox" aria-label="Open existing case folder" checked={openExisting} onChange={event => setOpenExisting(event.target.checked)}/> Open an existing .ledcase folder</span></label> : null}
      <label className="field-label">{openExisting ? 'Case folder path' : 'Evidence folder path'}<input aria-label="Evidence folder path" value={path} onChange={event => setPath(event.target.value)} placeholder="C:\Evidence\Matter"/></label>
      {!hasCase && !openExisting ? <label className="field-label">New case name<input aria-label="New folder case name" value={name} onChange={event => setName(event.target.value)}/></label> : null}
      <p className="small muted">Imports this folder and all subfolders as managed copies. Existing case folders and links are skipped. Original files are unchanged.{!hasCase ? ' A new case folder will be created inside it.' : ''}</p>
      {error ? <div className="notice error">{error}</div> : null}
      <div className="modal-footer"><button className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button className="primary" disabled={busy || !path.trim() || (!hasCase && !name.trim())} onClick={() => run(importFolder)}>{busy ? 'Importing managed copies…' : openExisting && !hasCase ? 'Open case folder' : 'Import folder files'}</button></div>
    </dialog>
  </>;
}
