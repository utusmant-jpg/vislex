import { useEffect, useState } from 'react';
import { Save, History, Lock, Unlock, Check, Download, RotateCcw, FilePenLine, Eye, PenLine } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { api } from '../bridge';
import { Markdown } from '../markdown';
import type { WorkingRecord, Revision } from '../types';

// Keep unsaved drafts while switching tabs; never put case content in browser storage.
const drafts = new Map<string, { content: string; title: string; base: number }>();

export default function RecordEditor({ caseId, record, refresh, run, onSource }: { caseId: string; record: WorkingRecord; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; onSource: (id: string, locator?: string) => void }) {
  const draftKey = `${caseId}:${record.id}`;
  const [content, setContent] = useState(drafts.get(draftKey)?.content ?? record.content); const [title, setTitle] = useState(drafts.get(draftKey)?.title ?? record.title);
  const [base, setBase] = useState(drafts.get(draftKey)?.base ?? record.revision); const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => { if (content !== record.content || title !== record.title) drafts.set(draftKey, { content, title, base }); else drafts.delete(draftKey); }, [draftKey, record.content, record.title, content, title, base]);
  const dirty = content !== record.content || title !== record.title;
  const changed = base !== record.revision;
  return <div className="record-view">
    <div className="viewer-tools"><span className="badge"><FilePenLine size={13}/>{record.kind.toUpperCase()}</span><span className={record.stale ? 'amber-text' : 'muted'}>{record.stale ? 'Needs recheck' : record.review}</span><div className="spacer"/>
      <button className="quiet" onClick={() => run(async () => setRevisions(await api<Revision[]>('revisions', { record_id: record.id })))}><History size={14}/>History</button>
      <button className="quiet" title="Export the saved revision" onClick={() => run(async () => { const expected_revision = record.revision; const path = await save({ defaultPath: `${record.title.replace(/[^a-zA-Z0-9 -]/g, '')}.md`, filters: [{ name: 'Saved report', extensions: ['md', 'json', 'txt', 'docx', 'pdf'] }] }); if (path) await api(/\.(docx|pdf)$/i.test(path)?'export_word':'export_record', { record_id: record.id, expected_revision, path }); })}><Download size={14}/>Export saved revision</button>
    </div>
    {changed ? <div className="notice warning">A newer revision exists. Your local draft has been preserved. <button onClick={() => { setContent(record.content); setTitle(record.title); setBase(record.revision); }}>Load latest revision</button></div> : null}
    {dirty ? <p className="small muted">Export uses the saved revision. Save your changes first to include them.</p> : null}
    <div className="editor-heading"><input aria-label="Working file title" value={title} onChange={e => setTitle(e.target.value)} /><div><span className="mono">REV {base}</span><span>{record.actor === 'agent' ? 'AI-updated / unreviewed' : record.actor === 'processor' ? 'Machine transcript / unreviewed' : 'Manual working file'}</span><span>{dirty ? 'Unsaved changes' : 'Saved in case database'}</span></div></div>
    {preview ? <div className="markdown-editor record-preview"><Markdown text={content} onSource={onSource} /></div>
      : <textarea className="markdown-editor" aria-label="Working file content" spellCheck={false} value={content} onChange={e => setContent(e.target.value)} />}
    <div className="editor-actions">
      <button className="quiet" aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? <PenLine size={14}/> : <Eye size={14}/>}{preview ? 'Edit' : 'Preview'}</button>
      <button className="quiet" onClick={() => run(async () => { await api('review_record', { record_id: record.id, revision: record.revision, protected: !record.protected }); await refresh(); })}>{record.protected ? <Lock size={14}/> : <Unlock size={14}/>} {record.protected ? 'Agent edits locked' : 'Allowing agent edits'}</button><div className="spacer"/><button className="quiet" disabled={dirty || record.stale} onClick={() => run(async () => { await api('review_record', { record_id: record.id, revision: record.revision }); await refresh(); })}><Check size={14}/>Mark reviewed</button><button className="primary" disabled={!dirty || changed} onClick={() => run(async () => { const r = await api<WorkingRecord>('write_record', { record_id: record.id, base_revision: base, title, kind: record.kind, content, source_ids: record.dependencies, reason: 'Manual editor save' }); setBase(r.revision); await refresh(); })}><Save size={14}/>Save revision</button></div>
    {revisions ? <div className="history-panel"><div className="section-label">REVISION HISTORY <button className="quiet" onClick={() => setRevisions(null)}>Close</button></div>{revisions.map(r => <details key={r.revision}><summary><span>Revision {r.revision} · {r.actor}</span><span>{r.reason}</span></summary><pre>{r.content}</pre><button className="quiet" disabled={r.revision === record.revision || dirty} onClick={() => run(async () => { const restored = await api<WorkingRecord>('rollback', { record_id: record.id, target: r.revision, base_revision: record.revision }); setContent(restored.content); setTitle(restored.title); setBase(restored.revision); setRevisions(null); await refresh(); })}><RotateCcw size={13}/>Restore as new revision</button></details>)}</div> : null}
  </div>;
}
