import { useEffect, useRef, useState } from 'react';
import { Save, History, Lock, Unlock, Check, Download, RotateCcw, FilePenLine, Eye, PenLine, X, AlertTriangle } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { api } from '../bridge';
import { Markdown } from '../markdown';
import { Tooltip } from '../ui';
import type { WorkingRecord, Revision } from '../types';

// Keep unsaved drafts while switching tabs; never put case content in browser storage.
const drafts = new Map<string, { content: string; title: string; base: number }>();
type Props={ caseId: string; sessionEpoch?: number; record: WorkingRecord; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; onSource: (id: string, locator?: string) => void };

/** Human wording for a record's review state; the raw value is never hidden, only formatted. */
export function reviewLabel(record: Pick<WorkingRecord, 'review' | 'stale'>): { tone: 'warning' | 'success' | 'neutral'; label: string } {
  if (record.stale) return { tone: 'warning', label: 'Needs recheck' };
  const text = record.review.replaceAll(/[-_]/g, ' ').trim();
  const label = text ? text[0].toUpperCase() + text.slice(1) : 'Unreviewed';
  return { tone: /reviewed|accepted/i.test(record.review) && !/^unreviewed$/i.test(record.review) ? 'success' : 'neutral', label };
}

function actorLabel(actor: string) {
  return actor === 'agent' ? 'AI-updated / unreviewed' : actor === 'processor' ? 'Machine transcript / unreviewed' : 'Manual working file';
}

export default function RecordEditor(props:Props){return <RecordEditorBody key={`${props.caseId}:${props.sessionEpoch}:${props.record.id}`} {...props}/>;}

function RecordEditorBody({ caseId, sessionEpoch, record, refresh, run, onSource }: Props) {
  const draftKey = `${caseId}:${sessionEpoch}:${record.id}`;
  const [content, setContent] = useState(drafts.get(draftKey)?.content ?? record.content); const [title, setTitle] = useState(drafts.get(draftKey)?.title ?? record.title);
  const [base, setBase] = useState(drafts.get(draftKey)?.base ?? record.revision); const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const previousServer=useRef({content:record.content,title:record.title,revision:record.revision});
  useEffect(()=>{
    const previous=previousServer.current;
    if(previous.content===record.content&&previous.title===record.title&&previous.revision===record.revision)return;
    if(content===previous.content&&title===previous.title&&base===previous.revision){setContent(record.content);setTitle(record.title);setBase(record.revision);}
    previousServer.current={content:record.content,title:record.title,revision:record.revision};
  },[record.content,record.title,record.revision,content,title,base]);
  useEffect(() => { if (content !== record.content || title !== record.title) drafts.set(draftKey, { content, title, base }); else drafts.delete(draftKey); }, [draftKey, record.content, record.title, content, title, base]);
  const dirty = content !== record.content || title !== record.title;
  const changed = base !== record.revision;
  const review = reviewLabel(record);
  const openHistory = () => { setHistoryOpen(true); setRevisions(null); run(async () => { try { setRevisions(await api<Revision[]>('revisions', { record_id: record.id })); } catch (reason) { setHistoryOpen(false); throw reason; } }); };
  const closeHistory = () => { setHistoryOpen(false); setRevisions(null); };
  return <div className={`record-view ${historyOpen ? 'with-history' : ''}`}>
    <div className="record-toolbar viewer-tools">
      <span className="badge"><FilePenLine size={13} aria-hidden="true"/>{record.kind.toUpperCase()}</span>
      <span className={`pill pill-sm tone-${review.tone} record-review`}>{review.tone === 'warning' ? <AlertTriangle size={12} aria-hidden="true"/> : review.tone === 'success' ? <Check size={12} aria-hidden="true"/> : <PenLine size={12} aria-hidden="true"/>}{review.label}</span>
      <div className="spacer"/>
      <div className="segmented record-mode" role="group" aria-label="Editor mode">
        <button aria-pressed={!preview} onClick={() => setPreview(false)}><PenLine size={13} aria-hidden="true"/>Edit</button>
        <button aria-pressed={preview} onClick={() => setPreview(true)}><Eye size={13} aria-hidden="true"/>Preview</button>
      </div>
      <Tooltip text={historyOpen ? 'Close revision history' : 'Revision history'}><button className="quiet record-tool" aria-label="History" aria-pressed={historyOpen} onClick={() => historyOpen ? closeHistory() : openHistory()}><History size={14} aria-hidden="true"/><span>History</span></button></Tooltip>
      <Tooltip text="Export the saved revision"><button className="quiet record-tool" aria-label="Export saved revision" onClick={() => run(async () => { const expected_revision = record.revision; const path = await save({ defaultPath: `${record.title.replace(/[^a-zA-Z0-9 -]/g, '')}.md`, filters: [{ name: 'Saved report', extensions: ['md', 'json', 'txt', 'docx', 'pdf'] }] }); if (path) await api(/\.(docx|pdf)$/i.test(path)?'export_word':'export_record', { case_id: caseId, session_epoch: sessionEpoch, record_id: record.id, expected_revision, path }); })}><Download size={14} aria-hidden="true"/><span>Export saved revision</span></button></Tooltip>
    </div>
    {changed ? <div className="notice warning record-notice" role="status"><AlertTriangle size={16} aria-hidden="true"/><span>A newer revision exists. Your local draft has been preserved. <button onClick={() => { setContent(record.content); setTitle(record.title); setBase(record.revision); }}>Load latest revision</button></span></div> : null}
    <div className="record-body">
      <div className="record-main">
        <div className="editor-heading">
          <input aria-label="Working file title" value={title} onChange={e => setTitle(e.target.value)} />
          <div className="editor-meta">
            <span className="mono record-rev">REV {base}</span>
            <span>{actorLabel(record.actor)}</span>
            <span className={`record-save-state ${dirty ? 'dirty' : ''}`}><span className="record-save-dot" aria-hidden="true"/>{dirty ? 'Unsaved changes' : 'Saved in case database'}</span>
          </div>
          {dirty ? <div className="record-dirty-notes"><p>Export uses the saved revision. Save your changes first to include them.</p><p>Unsaved drafts stay in memory for this app session and are lost if the app closes or crashes.</p></div> : null}
        </div>
        {preview ? <div className="markdown-editor record-preview"><Markdown text={content} onSource={onSource} /></div>
          : <textarea className="markdown-editor" aria-label="Working file content" spellCheck={false} value={content} onChange={e => setContent(e.target.value)} />}
      </div>
      {historyOpen ? <aside className="history-panel" aria-label="Revision history">
        <div className="history-head"><span className="section-title">Revision history{revisions ? <span className="count">{revisions.length}</span> : null}</span><button className="icon-button" aria-label="Close revision history" onClick={closeHistory}><X size={15}/></button></div>
        {revisions === null ? <p className="history-loading status-line" role="status"><span className="activity-dot" aria-hidden="true"/>Loading revisions…</p> : null}
        {revisions?.length === 0 ? <p className="history-empty">No saved revisions are listed for this working file.</p> : null}
        {revisions ? <ol className="history-list">{revisions.map(r => <li key={r.revision} className={r.revision === record.revision ? 'current' : ''}>
          <details><summary>
            <span className="history-rev mono">Rev {r.revision}</span>
            <span className="history-main"><span className="history-reason">{r.reason || 'No reason recorded'}</span><span className="history-meta">{r.actor}{r.created_at ? ` · ${new Date(r.created_at).toLocaleString()}` : ''}</span></span>
            {r.revision === record.revision ? <span className="badge">Current</span> : null}
          </summary>
            <pre>{r.content}</pre>
            <button className="secondary" data-size="sm" disabled={r.revision === record.revision || dirty} onClick={() => run(async () => { const restored = await api<WorkingRecord>('rollback', { case_id: caseId, session_epoch: sessionEpoch, record_id: record.id, target: r.revision, base_revision: record.revision }); setContent(restored.content); setTitle(restored.title); setBase(restored.revision); closeHistory(); await refresh(); })}><RotateCcw size={13} aria-hidden="true"/>Restore as new revision</button>
            {r.revision !== record.revision && dirty ? <p className="history-hint">Save or discard your draft before restoring.</p> : null}
          </details>
        </li>)}</ol> : null}
      </aside> : null}
    </div>
    <div className="editor-actions">
      <button className="quiet" aria-pressed={record.protected} onClick={() => run(async () => { await api('review_record', { case_id: caseId, session_epoch: sessionEpoch, record_id: record.id, revision: record.revision, protected: !record.protected }); await refresh(); })}>{record.protected ? <Lock size={14} aria-hidden="true"/> : <Unlock size={14} aria-hidden="true"/>} {record.protected ? 'Agent edits locked' : 'Allowing agent edits'}</button>
      <div className="spacer"/>
      <button className="secondary" disabled={dirty || record.stale} onClick={() => run(async () => { await api('review_record', { case_id: caseId, session_epoch: sessionEpoch, record_id: record.id, revision: record.revision }); await refresh(); })}><Check size={14} aria-hidden="true"/>Mark reviewed</button>
      <button className="primary" disabled={!dirty || changed} onClick={() => run(async () => { const r = await api<WorkingRecord>('write_record', { case_id: caseId, session_epoch: sessionEpoch, record_id: record.id, base_revision: base, title, kind: record.kind, content, source_ids: record.dependencies, reason: 'Manual editor save' }); setBase(r.revision); await refresh(); })}><Save size={14} aria-hidden="true"/>Save revision</button>
    </div>
  </div>;
}
