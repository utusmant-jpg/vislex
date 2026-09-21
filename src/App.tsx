import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Activity, ArrowRight, FolderOpen, HardDrive, ListChecks, Maximize2, MessageSquare, Minus,
  MoreHorizontal, NotebookPen, Plus, Scale, Search, Settings, X,
} from 'lucide-react';
import { api, formatBytes, native } from './bridge';
import type { Snapshot, Selection, SearchResult, WorkingRecord } from './types';
import { suggestedMatterName } from './review';
import EvidenceViewer, { SourceIcon } from './components/EvidenceViewer';
import RecordEditor from './components/RecordEditor';
import AgentPanel from './components/AgentPanel';
import SettingsDialog from './components/SettingsDialog';
import EvidenceNotebook from './components/EvidenceNotebook';
import InvestigationWorkbench from './components/InvestigationWorkbench';
import FolderImport from './components/FolderImport';
import { ContextMenu, StatusPill, ThemeProvider, ThemeToggle, ToastStack, Tooltip, notify, relativeTime } from './ui';

type View = 'chat' | 'evidence' | 'findings' | 'review' | 'jobs';

const views: { id: View; label: string; icon: typeof MessageSquare; shortcut: string }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, shortcut: 'Ctrl+1' },
  { id: 'evidence', label: 'Evidence', icon: FolderOpen, shortcut: 'Ctrl+2' },
  { id: 'findings', label: 'Findings', icon: NotebookPen, shortcut: 'Ctrl+3' },
  { id: 'review', label: 'Review', icon: Scale, shortcut: 'Ctrl+4' },
  { id: 'jobs', label: 'Jobs', icon: ListChecks, shortcut: 'Ctrl+5' },
];

function OnboardingHero({ onCreate, onOpen, onRestore, onSample }: { onCreate: () => void; onOpen: () => void; onRestore: () => void; onSample: () => void }) {
  return <div className="onboarding">
    <div className="brand-mark large" aria-hidden="true"><span /><span /><span /></div>
    <h1>Investigate your first case</h1>
    <p>VisLex keeps your evidence local, cites every claim to the original file, and never sends anything without your permission.</p>
    <div className="onboarding-cards">
      <button className="onboarding-card" onClick={onCreate}><Plus size={18} /><strong>Create a case</strong><span>Pick a local folder for the case file</span></button>
      <button className="onboarding-card" onClick={onOpen}><FolderOpen size={18} /><strong>Open a case</strong><span>Open an existing .ledcase folder</span></button>
      <button className="onboarding-card" onClick={onRestore}><HardDrive size={18} /><strong>Restore a backup</strong><span>Open an encrypted case archive</span></button>
      {!native ? <button className="onboarding-card" onClick={onSample}><MessageSquare size={18} /><strong>Try the sample case</strong><span>Synthetic browser preview</span></button> : null}
    </div>
    <p className="onboarding-hint">Cases are offline by default · originals are copied and hashed · AI is opt-in per case</p>
  </div>;
}

function EvidenceLibrary({ snapshot, onOpen, onOpenRecord, onRename, onRestrict }: { snapshot: Snapshot; onOpen: (id: string) => void; onOpenRecord: (id: string) => void; onRename: (id: string, name: string) => void; onRestrict: (id: string, restricted: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [section, setSection] = useState<'sources' | 'records'>('sources');
  const kinds = [...new Set(snapshot.sources.map(source => source.kind))];
  const filteredSources = snapshot.sources.filter(source =>
    (!kind || source.kind === kind) && source.name.toLowerCase().includes(query.toLowerCase()));
  const filteredRecords = snapshot.records.filter(record => record.title.toLowerCase().includes(query.toLowerCase()));
  const filtered = section === 'sources' ? filteredSources.length : filteredRecords.length;
  return <section className="workspace-view evidence-library" aria-label="Evidence library">
    <div className="workspace-header">
      <div><div className="eyebrow">EVIDENCE</div><h2>Evidence library</h2></div>
      <div className="spacer" />
      <span className="small muted">{filtered} of {section === 'sources' ? snapshot.sources.length : snapshot.records.length} {section === 'sources' ? `sources · ${formatBytes(snapshot.sources.reduce((total, source) => total + source.size, 0))}` : 'working files'}</span>
    </div>
    <div className="library-controls">
      <div className="search-box"><Search size={14} /><input aria-label="Filter evidence" placeholder={section === 'sources' ? 'Filter by file name…' : 'Filter by title…'} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="segmented">
        <button className={section === 'sources' ? 'selected' : ''} onClick={() => { setSection('sources'); setKind(''); }}>Sources</button>
        <button className={section === 'records' ? 'selected' : ''} onClick={() => { setSection('records'); setKind(''); }}>Working files</button>
      </div>
      {section === 'sources' ? <div className="chip-row">
        <button className={`chip ${kind === '' ? 'selected' : ''}`} onClick={() => setKind('')}>All</button>
        {kinds.map(option => <button key={option} className={`chip ${kind === option ? 'selected' : ''}`} onClick={() => setKind(option)}>{option}</button>)}
      </div> : null}
    </div>
    {section === 'sources' ? (filteredSources.length ? <div className="library-table" role="list">
      {filteredSources.map(source => <ContextMenu key={source.id} items={[
        { label: 'Open', onSelect: () => onOpen(source.id) },
        { label: 'Rename display name', shortcut: 'F2', onSelect: () => onRename(source.id, source.name) },
        { label: source.restricted ? 'Allow AI analysis' : 'Restrict from AI analysis', onSelect: () => onRestrict(source.id, !source.restricted) },
      ]}>
        <button className="library-row" role="listitem" onClick={() => onOpen(source.id)} title={`${source.name} · SHA-256 ${source.sha256}`}>
          <SourceIcon kind={source.kind} size={16} />
          <span className="library-name">{source.name}</span>
          {source.restricted ? <StatusPill state="restricted" label="Restricted" small /> : null}
          <span className="small muted">{source.status}</span>
          <span className="small muted mono">{formatBytes(source.size)}</span>
        </button>
      </ContextMenu>)}
    </div> : <div className="empty-state"><FolderOpen size={32} /><h3>No evidence matches</h3><p>Drop files anywhere in the window, or use Add files in the case menu.</p></div>) : null}
    {section === 'records' ? (filteredRecords.length ? <div className="library-table" role="list">
      {filteredRecords.map(record => <button className="library-row" role="listitem" key={record.id} onClick={() => onOpenRecord(record.id)} title={record.title}>
        <NotebookPen size={16} />
        <span className="library-name">{record.title}</span>
        <span className="badge">{record.kind}</span>
        {record.stale ? <StatusPill state="stale" label="Needs recheck" small /> : record.review === 'human-reviewed' ? <StatusPill state="accepted" label="Reviewed" small /> : <StatusPill state="unreviewed" label="Unreviewed" small />}
        {record.protected ? <StatusPill state="protected" label="Locked" small /> : null}
      </button>)}
    </div> : <div className="empty-state"><NotebookPen size={32} /><h3>No working files yet</h3><p>Notes, reports and transcripts you or the investigator create appear here.</p></div>) : null}
  </section>;
}

function JobsCenter({ snapshot, run, refresh }: { snapshot: Snapshot; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void> }) {
  const [storage, setStorage] = useState<Record<string, number> | null>(null);
  const [reclaimed, setReclaimed] = useState<number | null>(null);
  useEffect(() => {
    setStorage(null); setReclaimed(null);
    if (native) void api<Record<string, number>>('storage_usage').then(setStorage).catch(() => undefined);
  }, [snapshot.id, snapshot.generation]);
  const active = snapshot.jobs?.filter(job => !job.superseded && ['queued', 'running', 'failed', 'interrupted', 'cancelled'].includes(job.status)) ?? [];
  const supersededFailures = snapshot.jobs?.filter(job => job.superseded && job.status === 'failed') ?? [];
  return <section className="workspace-view jobs-center" aria-label="Jobs and issues">
    <div className="workspace-header"><div><div className="eyebrow">ACTIVITY</div><h2>Jobs &amp; issues</h2></div><div className="spacer" /><button className="quiet" onClick={() => run(async () => { await api('transcribe_all'); await refresh(); })}>Queue missing full transcripts</button></div>
    <p className="small muted">Processing status does not certify evidence review. Historical failures remain visible with their receipts.</p>
    {active.length ? active.map(job => <article className={`job-card ${['failed', 'interrupted'].includes(job.status) ? 'job-attention' : ''}`} key={job.id}>
      <div className="job-card-head">
        <strong>{job.name}</strong>
        <StatusPill state={job.status === 'running' ? 'running' : job.status === 'queued' ? 'queued' : job.status === 'cancelled' ? 'cancelled' : 'interrupted'} label={job.status} small />
      </div>
      <p className="small muted">{job.kind}</p>
      {job.error ? <p role="alert" className="small danger-text">{job.error}</p> : null}
      <div className="input-row">
        {job.kind === 'full_audio' && ['failed', 'interrupted'].includes(job.status) ? <button className="quiet" onClick={() => run(async () => { await api('resume_transcription', { job_id: job.id }); await refresh(); })}>Resume saved chunks</button> : null}
        {job.kind === 'full_audio' ? <button className="quiet" onClick={() => run(async () => { await api(['running', 'queued'].includes(job.status) ? 'cancel_transcription' : 'transcribe_full', { source_id: job.source_id }); await refresh(); })}>{['running', 'queued'].includes(job.status) ? 'Cancel' : 'Retry'}</button> : null}
        {job.status === 'running' ? <button className="quiet" onClick={() => run(async () => { await api('cancel_processing', { job_id: job.id }); await refresh(); })}>Cancel</button> : null}
        {['interrupted', 'failed'].includes(job.status) && job.kind !== 'auto_prepare' ? <button className="quiet" onClick={() => run(async () => { await api('resume_processing', { job_id: job.id }); await refresh(); })}>Recover saved job</button> : null}
      </div>
      <code>Receipt {job.id}</code>
    </article>) : <div className="empty-state"><ListChecks size={32} /><h3>No failed tools or unfinished jobs</h3><p>Background transcription, indexing and analysis runs appear here while they work.</p></div>}
    {supersededFailures.length ? <details className="job-card"><summary>Previous failures resolved by a later run ({supersededFailures.length})</summary>{supersededFailures.map(job => <article key={job.id}><strong>{job.name}</strong><p className="small muted">{job.kind} · {job.error}</p><code>Receipt {job.id}</code></article>)}</details> : null}
    {snapshot.issues?.map(issue => <details className="job-card job-attention" key={issue.id}><summary>{issue.name.replaceAll('_', ' ')} · failed</summary><pre>{issue.error}</pre><code>Receipt {issue.id}</code></details>)}
    {storage ? <div className="job-card">
      <div className="job-card-head"><strong>Case storage</strong><Tooltip text="Only abandoned import copies matching a verified original are removed. Job folders are retained."><button className="quiet" onClick={() => run(async () => { const receipt = await api<{ reclaimed_bytes: number }>('reclaim_staging'); setReclaimed(receipt.reclaimed_bytes); setStorage(await api<Record<string, number>>('storage_usage')); })}>Reclaim verified staging duplicates</button></Tooltip></div>
      {Object.entries(storage).map(([name, bytes]) => <p className="small" key={name}>{name}: {formatBytes(bytes)}</p>)}
      {reclaimed !== null ? <p role="status" className="small success-text">Reclaimed {formatBytes(reclaimed)}</p> : null}
    </div> : null}
  </section>;
}

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [storage, setStorage] = useState<Record<string, number> | null>(null);
  const [palette, setPalette] = useState(false);
  const [rename, setRename] = useState<{ kind: string; id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameDialog = useRef<HTMLDialogElement>(null);
  const paletteDialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const [allChats, setAllChats] = useState(false);
  const [openTabs, setOpenTabs] = useState<NonNullable<Selection>[]>([]);
  const seenViewer = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string; root: string; chats?: { id: string; title: string }[] }[]>(() => { try { return JSON.parse(localStorage.getItem('vislex-projects') ?? '[]'); } catch { return []; } });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [modal, setModal] = useState<'create' | 'note' | 'backup' | 'restore' | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [production] = useState('Initial production');
  const [kind, setKind] = useState('note');
  const [dropping, setDropping] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async () => { setSnapshot(await api<Snapshot | null>('snapshot')); }, []);
  const run = useCallback((fn: () => Promise<void>) => {
    setBusy(true);
    void fn().catch(error => notify.fromError('Something went wrong', error)).finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void (async () => {
        const current = await api<Snapshot | null>('snapshot');
        const last = localStorage.getItem('vislex-last-case') ?? JSON.parse(localStorage.getItem('vislex-projects') ?? '[]')[0]?.root;
        setSnapshot(current ?? (native && last ? await api<Snapshot>('open_case', { path: last }) : null));
      })().catch(error => notify.error('Could not reopen the last case', `${String(error)}. Choose a project from the sidebar.`));
    }
    if (!native) return;
    const cleanup = listen('case-changed', () => { void refresh(); });
    return () => { void cleanup.then(fn => fn()); };
  }, [refresh]);

  useEffect(() => { if (modal) dialog.current?.showModal(); }, [modal]);
  useEffect(() => { if (rename) { setRenameValue(rename.name); renameDialog.current?.showModal(); } }, [rename]);
  useEffect(() => { if (palette) paletteDialog.current?.showModal(); else paletteDialog.current?.close(); }, [palette]);

  // Global shortcuts: palette + workspace switching.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(value => !value); return; }
      if (typing || !(event.ctrlKey || event.metaKey)) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < views.length) { event.preventDefault(); setView(views[index].id); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    localStorage.setItem('vislex-last-case', snapshot.root);
    setProjects(previous => { const next = [{ id: snapshot.id, name: snapshot.name, root: snapshot.root }, ...previous.filter(project => project.id !== snapshot.id)]; localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; });
    const saved = localStorage.getItem(`vislex-conversation:${snapshot.id}`);
    setConversationId(saved ?? (snapshot.tasks[0]?.conversation_id ?? snapshot.tasks[0]?.id ?? null));
    setSelection(null); setOpenTabs([]); seenViewer.current = snapshot.viewer_request?.id ?? null;
    setView('chat');
    setStorage(null);
    void api<Record<string, number>>('storage_usage').then(setStorage).catch(() => undefined);
  }, [snapshot?.id]);

  useEffect(() => { if (snapshot) setProjects(previous => { const next = previous.map(project => project.id === snapshot.id ? { ...project, name: snapshot.name } : project); localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; }); }, [snapshot?.name]);

  useEffect(() => {
    if (!snapshot) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await refresh(); } catch (error) { if (active) notify.fromError('Case refresh failed', error); } if (active) timer = setTimeout(poll, 3000); };
    timer = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [snapshot?.id, refresh]);

  useEffect(() => {
    if (selection) setOpenTabs(tabs => {
      const found = tabs.some(tab => tab.type === selection.type && tab.id === selection.id);
      return found ? tabs.map(tab => tab.type === selection.type && tab.id === selection.id ? selection : tab) : [...tabs, selection];
    });
  }, [selection]);

  useEffect(() => {
    const request = snapshot?.viewer_request;
    if (!request || request.id === seenViewer.current) return;
    seenViewer.current = request.id;
    setSelection({ type: 'source', id: request.source_id, locator: request.time_seconds != null ? `time:${request.time_seconds}` : request.page != null ? `page:${request.page}` : undefined });
    setView('chat');
  }, [snapshot?.viewer_request?.id]);

  // Drag-and-drop import: files land in the case without touching originals.
  useEffect(() => {
    if (!native) return;
    let cleanup: (() => void) | undefined;
    let active = true;
    void getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter' || payload.type === 'over') setDropping(true);
      else if (payload.type === 'drop') {
        setDropping(false);
        const paths = payload.paths;
        if (!paths?.length) return;
        run(async () => {
          if (!snapshot) throw new Error('Create or open a case first.');
          const receipt = await api<{ items: { status: string; detail: { error?: string } }[] }>('import_files', { paths, production });
          await refresh();
          const failed = receipt.items.filter(item => item.status === 'failed');
          if (failed.length) throw new Error(`${failed.length} import(s) failed: ${failed.map(item => item.detail.error).join('; ')}`);
          notify.success(`Imported ${receipt.items.length} file${receipt.items.length === 1 ? '' : 's'}`, 'Originals are preserved and hashed.');
        });
      } else setDropping(false);
    }).then(fn => { if (active) cleanup = fn; else fn(); });
    return () => { active = false; cleanup?.(); };
  }, [snapshot?.id, snapshot, production, run, refresh]);

  function beginRename(kind: string, id: string, name: string) { setRename({ kind, id, name }); }
  function chooseConversation(id: string | null) {
    setConversationId(id);
    setView('chat');
    if (snapshot) {
      if (id) localStorage.setItem(`vislex-conversation:${snapshot.id}`, id);
      else localStorage.removeItem(`vislex-conversation:${snapshot.id}`);
    }
  }
  function closeTab(id: string) { setOpenTabs(tabs => { const rest = tabs.filter(tab => tab.id !== id); if (selection?.id === id) setSelection(rest.at(-1) ?? null); return rest; }); }
  function removeChat(id: string) {
    run(async () => {
      await api('delete_conversation', { conversation_id: id });
      notify.success('Chat deleted', undefined, { label: 'Undo', run: () => { void api('delete_conversation', { conversation_id: id, deleted: false }).then(refresh); } });
      if (conversationId === id) chooseConversation(null);
      await refresh();
    });
  }
  const conversations = (snapshot?.tasks ?? []).filter((task, index, all) => all.findIndex(other => (other.conversation_id ?? other.id) === (task.conversation_id ?? task.id)) === index)
    .map(task => ({
      id: task.conversation_id ?? task.id,
      title: task.title ?? snapshot?.tasks.filter(other => (other.conversation_id ?? other.id) === (task.conversation_id ?? task.id)).at(-1)?.prompt ?? task.prompt,
      running: task.status === 'running',
      when: task.created_at,
    }));
  const chatIndex = JSON.stringify(conversations.map(({ id, title }) => ({ id, title })));
  useEffect(() => {
    if (!snapshot) return;
    setProjects(previous => { const next = previous.map(project => project.id === snapshot.id ? { ...project, chats: JSON.parse(chatIndex) } : project); localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; });
  }, [snapshot?.id, chatIndex]);

  const source = selection?.type === 'source' ? snapshot?.sources.find(item => item.id === selection.id) : undefined;
  const record = selection?.type === 'record' ? snapshot?.records.find(item => item.id === selection.id) : undefined;
  const suggestedName = suggestedMatterName(snapshot?.sources.map(item => item.name) ?? []);
  const pending = snapshot?.jobs?.filter(job => ['queued', 'running'].includes(job.status)) ?? [];
  const needsAttention = (snapshot?.issues?.length ?? 0) + (snapshot?.jobs?.filter(job => !job.superseded && ['failed', 'interrupted'].includes(job.status)).length ?? 0);
  const selectSource = (id: string, locator?: string) => { setSelection({ type: 'source', id, locator }); };

  async function importFiles() {
    if (!snapshot) throw new Error('Create or open a case first.');
    const paths = await open({ multiple: true, directory: false, title: 'Import evidence — originals will be preserved' });
    if (paths) {
      const receipt = await api<{ items: { status: string; detail: { error?: string } }[] }>('import_files', { paths: Array.isArray(paths) ? paths : [paths], production });
      await refresh();
      const failed = receipt.items.filter(item => item.status === 'failed');
      if (failed.length) throw new Error(`${failed.length} import(s) failed: ${failed.map(item => item.detail.error).join('; ')}`);
      notify.success('Import finished', 'Originals are preserved and hashed.');
    }
  }
  async function openCase() {
    if (!native) { setSnapshot(await api<Snapshot>('load_demo')); setSelection(null); return; }
    const path = await open({ directory: true, title: 'Open a VisLex case folder' });
    if (typeof path === 'string') { setSnapshot(await api<Snapshot>('open_case', { path })); setSelection(null); setView('chat'); }
  }
  function showModal(type: typeof modal) { setName(''); setPassword(''); setModal(type); }
  async function performModal() {
    if (modal === 'create') { const parent = await open({ directory: true, title: 'Choose a local parent folder' }); if (typeof parent !== 'string') return; const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, ''); if (!safeName) throw new Error('Enter a case name.'); const path = `${parent}\\${safeName}.ledcase`; setSnapshot(await api<Snapshot>('create_case', { path, name })); setSelection(null); notify.success('Case created', 'Drop files anywhere to import evidence.'); }
    if (modal === 'note') { const created = await api<WorkingRecord>('write_record', { title: name, kind, content: `# ${name}\n\n`, base_revision: 0, source_ids: source ? [source.id] : [], reason: 'Create working record' }); await refresh(); setSelection({ type: 'record', id: created.id }); }
    if (modal === 'backup') { const path = await save({ defaultPath: 'case-backup.tar.age', filters: [{ name: 'Encrypted backup', extensions: ['age'] }] }); if (!path) return; await api('backup', { path, password }); notify.success('Encrypted backup saved', path); }
    if (modal === 'restore') { const archive = await open({ filters: [{ name: 'Encrypted case', extensions: ['age'] }] }); if (typeof archive !== 'string') return; const parent = await open({ directory: true, title: 'Choose restoration parent folder' }); if (typeof parent !== 'string') return; const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, ''); if (!safeName) throw new Error('Enter a restored case folder name.'); setSnapshot(await api<Snapshot>('restore_case', { archive, path: `${parent}\\${safeName}.ledcase`, password })); setSelection(null); }
    setPassword(''); setModal(null);
  }

  /* ------------------------------ command palette ----------------------------- */
  const paletteCommands = useMemo(() => [
    { id: 'new-chat', label: 'New chat', run: () => { chooseConversation(null); setPalette(false); } },
    { id: 'view-evidence', label: 'Go to Evidence', run: () => { setView('evidence'); setPalette(false); } },
    { id: 'view-findings', label: 'Go to Findings', run: () => { setView('findings'); setPalette(false); } },
    { id: 'view-review', label: 'Go to Review workbench', run: () => { setView('review'); setPalette(false); } },
    { id: 'view-jobs', label: 'Go to Jobs & issues', run: () => { setView('jobs'); setPalette(false); } },
    { id: 'settings', label: 'Open settings', run: () => { setPalette(false); if (snapshot) setSettings(true); else notify.info('Open a case to configure its API permissions.'); } },
    { id: 'transcribe-all', label: 'Queue missing full transcripts', run: () => { setPalette(false); run(async () => { await api('transcribe_all'); await refresh(); }); } },
    { id: 'add-files', label: 'Add files to this case', run: () => { setPalette(false); run(importFiles); } },
  ], [run, refresh, snapshot]);
  const paletteMatches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || !snapshot) return [];
    return snapshot.sources.filter(item => item.name.toLowerCase().includes(text)).slice(0, 6);
  }, [query, snapshot]);
  const paletteItems = useMemo(() => [
    ...paletteMatches.map(item => ({ kind: 'source' as const, id: item.id, label: item.name })),
    ...(results ?? []).map((item, index) => ({ kind: 'result' as const, id: `${item.source_id}:${index}`, label: item.name, excerpt: item.excerpt })),
    ...paletteCommands.filter(command => !query.trim() || command.label.toLowerCase().includes(query.trim().toLowerCase())).map(command => ({ kind: 'command' as const, id: command.id, label: command.label, run: command.run })),
  ], [paletteMatches, results, paletteCommands, query]);
  useEffect(() => { setPaletteIndex(0); }, [query, results]);
  function paletteEnter() {
    const item = paletteItems[paletteIndex];
    if (item?.kind === 'source') { selectSource(item.id); setPalette(false); return; }
    if (item?.kind === 'command') { item.run(); return; }
    if (query.trim() && snapshot) {
      run(async () => {
        const response = await api<{ results: SearchResult[]; remaining_passages: number }>('hybrid_search', { query });
        setResults(response.results);
        if (response.remaining_passages > 0) notify.info('Indexing in progress', `${response.remaining_passages} passages remain unindexed; current results cover indexed text only. Repeat semantic search to continue indexing.`);
      });
    }
  }

  const statusJob = pending[0];
  const totalBytes = snapshot?.sources.reduce((total, item) => total + item.size, 0) ?? 0;
  const totalStorage = storage ? Object.values(storage).reduce((total, bytes) => total + bytes, 0) : 0;

  return <ThemeProvider>
    <div className={`app-shell ${dropping ? 'dropping' : ''}`}>
      <header className="titlebar" data-tauri-drag-region onDoubleClick={() => { if (native) void getCurrentWindow().toggleMaximize(); }}>
        <div className="brand-mark" data-tauri-drag-region><span /><span /><span /></div>
        <strong data-tauri-drag-region>VisLex</strong>
        <span className="title-case" data-tauri-drag-region>{snapshot?.name ?? ''}</span>
        <div className="spacer" data-tauri-drag-region />
        {busy ? <Activity className="pulse" size={13} /> : null}
        <div className="window-controls">
          <button aria-label="Minimize window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().minimize(); }}><Minus size={15} /></button>
          <button aria-label="Maximize or restore window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().toggleMaximize(); }}><Maximize2 size={13} /></button>
          <button className="window-close" aria-label="Close window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().close(); }}><X size={16} /></button>
        </div>
      </header>

      <div className="workspace">
        <nav className="rail" aria-label="Workspaces">
          {views.map(item => <Tooltip key={item.id} text={item.label} shortcut={item.shortcut}>
            <button className={`rail-button ${view === item.id ? 'active' : ''} ${item.id === 'jobs' && needsAttention ? 'attention' : ''}`} aria-label={item.label} aria-current={view === item.id} onClick={() => setView(item.id)}><item.icon size={18} /></button>
          </Tooltip>)}
          <div className="spacer" />
          <Tooltip text="Search case" shortcut="Ctrl+K"><button className="rail-button" aria-label="Search case" onClick={() => setPalette(true)}><Search size={17} /></button></Tooltip>
        </nav>

        <aside className="sidebar">
          <button className="matter-identity" disabled={!snapshot} title="Rename case (F2)" onClick={() => snapshot && beginRename('case', snapshot.id, snapshot.name)} onKeyDown={event => { if (event.key === 'F2' && snapshot) { event.preventDefault(); beginRename('case', snapshot.id, snapshot.name); } }}>
            <strong>{snapshot?.name ?? 'Open a case'}</strong>
            <small>{snapshot ? `${snapshot.sources.length} sources · ${formatBytes(totalBytes)} · ${pending.length ? `${pending.length} jobs pending` : needsAttention ? 'Needs attention' : 'Unreviewed'}` : 'Local evidence workspace'}</small>
          </button>
          {suggestedName && suggestedName !== snapshot?.name ? <button className="quiet" title="Suggested from PDF filename; confirm against the charging document" onClick={() => snapshot && beginRename('case', snapshot.id, suggestedName)}>Use suggested matter name</button> : null}
          <Tooltip text="Search case" shortcut="Ctrl+K"><button className="sidebar-command" disabled={!snapshot} onClick={() => setPalette(true)}><Search size={15} />Search case<kbd className="shortcut">Ctrl K</kbd></button></Tooltip>
          <Tooltip text="Start a new conversation"><button className="sidebar-command" onClick={() => chooseConversation(null)}><MessageSquare size={15} />New chat<Plus size={13} /></button></Tooltip>
          <div className="tree-heading">CHATS</div>
          <div className="sidebar-scroll">
            {conversations.length ? (allChats ? conversations : conversations.slice(0, 8)).map(chat => <ContextMenu key={chat.id} items={[
              { label: 'Rename chat', shortcut: 'F2', onSelect: () => beginRename('chat', chat.id, chat.title) },
              { label: 'Delete chat', danger: true, disabled: chat.running, onSelect: () => removeChat(chat.id) },
            ]}>
              <div className={`chat-item ${conversationId === chat.id ? 'selected' : ''}`} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); beginRename('chat', chat.id, chat.title); } }}>
                <button className="chat-open" title={chat.title} onClick={() => chooseConversation(chat.id)}>
                  <span>{chat.title}</span>
                  <small className="chat-when">{chat.running ? null : relativeTime(chat.when)}</small>
                  {chat.running ? <Activity size={12} className="pulse" /> : null}
                </button>
                <button className="icon-button chat-delete" aria-label={`Rename chat: ${chat.title}`} title="Rename chat (F2)" onClick={() => beginRename('chat', chat.id, chat.title)}><MoreHorizontal size={12} /></button>
                <button className="chat-delete icon-button" aria-label={`Delete chat: ${chat.title}`} disabled={chat.running} onClick={() => removeChat(chat.id)}><X size={12} /></button>
              </div>
            </ContextMenu>) : <p className="sidebar-empty">{snapshot ? 'No conversations yet. Ask your first question.' : 'Open a case to see its chats.'}</p>}
            {conversations.length > 8 ? <button className="more-chats" onClick={() => setAllChats(value => !value)}>{allChats ? 'Show less' : 'Show all chats'}</button> : null}
          </div>
          <div className="tree-heading">PROJECTS</div>
          <div className="project-list">
            {snapshot ? <div className="project-folder active"><FolderOpen size={15} /><button title={snapshot.root} onClick={() => beginRename('case', snapshot.id, snapshot.name)}>{snapshot.name}</button></div> : null}
            {projects.filter(project => project.id !== snapshot?.id).map(project => <details key={project.id} className="project-group"><summary><FolderOpen size={15} /><span>{project.name}</span></summary>
              <button className="project-row" title={project.root} onClick={() => run(async () => { setSnapshot(await api<Snapshot>('open_case', { path: project.root })); setView('chat'); })}>Open project</button>
              {project.chats?.slice(0, 8).map(chat => <button className="project-chat" key={chat.id} onClick={() => run(async () => { const opened = await api<Snapshot>('open_case', { path: project.root }); localStorage.setItem(`vislex-conversation:${project.id}`, chat.id); setSnapshot(opened); setView('chat'); })}>{chat.title}</button>)}
            </details>)}
          </div>
          <div className="sidebar-footer">
            <div className="sidebar-command split">
              <button className="quiet" onClick={() => showModal('create')}><Plus size={14} />Create</button>
              <button className="quiet" onClick={() => run(openCase)}><FolderOpen size={14} />Open</button>
            </div>
            <div className="sidebar-command split">
              <Tooltip text="Settings"><button className="quiet" disabled={!snapshot} onClick={() => setSettings(true)}><Settings size={15} />Settings</button></Tooltip>
              <ThemeToggle />
              <details className="case-menu"><summary aria-label="Case options"><MoreHorizontal size={16} /></summary><div>
                <button onClick={() => run(importFiles)}>Add files</button>
                <FolderImport hasCase={!!snapshot} run={run} refresh={refresh} />
                <button disabled={!snapshot} onClick={() => showModal('note')}>New note</button>
                <button disabled={!snapshot} onClick={() => showModal('backup')}>Export case archive</button>
                <button onClick={() => showModal('restore')}>Restore case archive</button>
              </div></details>
            </div>
          </div>
        </aside>

        <div className="center-column">
          {!snapshot && view === 'chat' ? <OnboardingHero
            onCreate={() => showModal('create')}
            onOpen={() => run(openCase)}
            onRestore={() => showModal('restore')}
            onSample={() => run(async () => { setSnapshot(await api<Snapshot>('load_demo')); })}
          /> : null}
          {snapshot && view === 'chat' ? <AgentPanel conversationId={conversationId} onConversation={chooseConversation} snapshot={snapshot} selection={selection} refresh={refresh} run={run} onSource={selectSource} onSettings={() => setSettings(true)} /> : null}
          {!snapshot && view !== 'chat' ? <div className="empty-state workspace-view"><FolderOpen size={32} /><h3>Open a case first</h3><p>This workspace becomes available once a case is open.</p></div> : null}
          {snapshot && view === 'evidence' ? <EvidenceLibrary
            snapshot={snapshot}
            onOpen={id => selectSource(id)}
            onOpenRecord={id => setSelection({ type: 'record', id })}
            onRename={(id, value) => beginRename('source', id, value)}
            onRestrict={(id, restricted) => run(async () => { await api('set_restricted', { source_id: id, restricted }); await refresh(); })}
          /> : null}
          {snapshot && view === 'findings' ? <EvidenceNotebook key={snapshot.id} snapshot={snapshot} onClose={() => setView('chat')} onSource={selectSource} /> : null}
          {snapshot && view === 'review' ? <InvestigationWorkbench key={snapshot.id} snapshot={snapshot} onClose={() => setView('chat')} onSource={selectSource} onConversation={chooseConversation} /> : null}
          {snapshot && view === 'jobs' ? <JobsCenter snapshot={snapshot} run={run} refresh={refresh} /> : null}
        </div>

        <main className="main-panel" hidden={!selection}>
          <div className="tab-strip" role="tablist" aria-label="Open files">
            {openTabs.map(tab => {
              const tabTitle = tab.type === 'source' ? snapshot?.sources.find(item => item.id === tab.id)?.name : snapshot?.records.find(item => item.id === tab.id)?.title;
              return <ContextMenu key={tab.id} items={[
                { label: 'Close', onSelect: () => closeTab(tab.id) },
                { label: 'Close others', onSelect: () => { setOpenTabs([tab]); if (!(selection?.id === tab.id)) setSelection(tab); } },
                { label: 'Close tabs to the right', onSelect: () => setOpenTabs(tabs => tabs.slice(0, tabs.findIndex(item => item.id === tab.id) + 1)) },
              ]}>
                <div className={`file-tab ${selection?.id === tab.id ? 'active' : ''}`}>
                  <button role="tab" aria-selected={selection?.id === tab.id} title={tabTitle} onClick={() => setSelection(tab)} onAuxClick={event => { if (event.button === 1) closeTab(tab.id); }}>
                    {tab.type === 'source' ? <SourceIcon kind={snapshot?.sources.find(item => item.id === tab.id)?.kind ?? 'other'} /> : null}
                    <span>{tabTitle}</span>
                  </button>
                  <button className="icon-button" aria-label={`Close ${tabTitle}`} onClick={() => closeTab(tab.id)}><X size={12} /></button>
                </div>
              </ContextMenu>;
            })}
          </div>
          {source ? <EvidenceViewer key={source.id} locator={selection?.locator} source={source} run={run} refresh={refresh} onLocatorSelect={locator => setSelection(current => current ? { ...current, locator } : current)} /> : null}
          {record ? <RecordEditor key={record.id} record={record} run={run} refresh={refresh} /> : null}
        </main>
      </div>

      {snapshot ? <footer className="statusbar">
        <span className="status-jobs" role="status">
          {statusJob ? <><Activity size={12} className="pulse" />{statusJob.name} · {statusJob.kind.replaceAll('_', ' ')}</> : null}
          {pending.length > 1 ? <span className="small muted">+{pending.length - 1} more</span> : null}
        </span>
        {needsAttention ? <button className="status-attention" onClick={() => setView('jobs')}><StatusPill state="needs-attention" label={`${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`} small /></button> : null}
        <div className="spacer" />
        {snapshot.records.length || totalStorage ? <span className="small muted">{snapshot.records.length === 1 ? '1 working file' : `${snapshot.records.length} working files`}{totalStorage ? ` · ${formatBytes(totalStorage)} on disk` : ''}</span> : null}
      </footer> : null}

      {dropping ? <div className="drop-veil" aria-hidden="true"><div className="drop-veil-card"><Plus size={22} /><strong>Drop to import into {snapshot?.name ?? 'a case'}</strong><span>Originals are preserved and hashed. Copies are stored inside the case.</span></div></div> : null}

      {rename ? <dialog ref={renameDialog} className="modal" onCancel={() => setRename(null)}>
        <h2>Rename {rename.kind === 'source' ? 'evidence display name' : rename.kind}</h2>
        <label className="field-label">Name<input autoFocus maxLength={240} value={renameValue} onChange={event => setRenameValue(event.target.value)} /></label>
        <p className="small muted">Original bytes, import receipts, hashes and citations are preserved. Evidence display names retain their file extension.</p>
        <div className="modal-footer"><button className="secondary" onClick={() => setRename(null)}>Cancel</button><button className="primary" disabled={busy || !renameValue.trim()} onClick={() => run(async () => { await api('rename', { kind: rename.kind, id: rename.id, name: renameValue }); await refresh(); setRename(null); })}>Save name</button></div>
      </dialog> : null}

      <dialog ref={paletteDialog} className="modal command-palette" onCancel={() => setPalette(false)}>
        <div className="palette-input-row">
          <Search size={16} />
          <input autoFocus aria-label="Search case — evidence, meaning, chats and commands" value={query} onChange={event => { setQuery(event.target.value); setResults(null); }} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex(index => Math.min(index + 1, paletteItems.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex(index => Math.max(0, index - 1)); }
            else if (event.key === 'Enter') { event.preventDefault(); paletteEnter(); }
          }} placeholder="Search evidence, meaning, chats and commands…" />
          {query.trim() && snapshot ? <span className="small muted">{results === null ? 'Enter to search' : `${results.length} results`}</span> : null}
        </div>
        <div className="palette-results">
          {query.trim() && snapshot && results === null ? <button className="tree-item palette-search-action" onClick={paletteEnter}><Search size={14} /><span>Search text &amp; meaning for “{query.trim()}”<small>Hybrid search across indexed evidence</small></span></button> : null}
          {paletteItems.map((item, index) => <button
            className={`tree-item palette-item ${index === paletteIndex ? 'selected' : ''}`}
            key={`${item.kind}:${item.id}`}
            onMouseEnter={() => setPaletteIndex(index)}
            onClick={() => { setPaletteIndex(index); paletteEnter(); }}>
            {item.kind === 'source' ? <SourceIcon kind={snapshot?.sources.find(sourceItem => sourceItem.id === item.id)?.kind ?? 'other'} size={15} /> : item.kind === 'result' ? <Search size={15} /> : null}
            <span>{item.label}{'excerpt' in item && item.excerpt ? <small>{item.excerpt}</small> : item.kind === 'command' ? <small>Command</small> : null}</span>
          </button>)}
          {results?.length === 0 ? <p className="sidebar-empty">No indexed text matches. Unprocessed evidence is not searchable.</p> : null}
          {!snapshot ? <p className="sidebar-empty">Open a case to search its evidence.</p> : null}
        </div>
        <div className="palette-footer"><span>↑↓ navigate</span><span>↵ open</span><span>Esc close</span></div>
      </dialog>

      {settings && snapshot ? <SettingsDialog snapshot={snapshot} onClose={() => setSettings(false)} refresh={refresh} run={run} /> : null}

      {modal ? <dialog ref={dialog} className="modal" onCancel={() => { setModal(null); setPassword(''); }}>
        <div className="modal-heading"><h2>{modal === 'create' ? 'Create a local case' : modal === 'note' ? 'New working file' : modal === 'backup' ? 'Encrypted case backup' : 'Restore a case'}</h2><button className="icon-button" aria-label="Close dialog" onClick={() => { setModal(null); setPassword(''); }}><X size={20} /></button></div>
        {modal !== 'backup' ? <label className="field-label">{modal === 'note' ? 'Title' : 'Case name'}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={modal === 'note' ? 'Review notes' : 'Matter name or reference'} /></label> : null}
        {modal === 'note' ? <label className="field-label">Record type<select value={kind} onChange={event => setKind(event.target.value)}>{['note', 'report', 'claim', 'event', 'person', 'issue', 'transcript', 'clock', 'script'].map(option => <option key={option}>{option}</option>)}</select></label> : null}
        {modal === 'backup' || modal === 'restore' ? <>
          <label className="field-label">Backup passphrase<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters for a new backup" /></label>
          <p className="small muted">Keep this passphrase separately. There is no password recovery. Backups include originals, notes, historical revisions, and restricted material.</p>
        </> : null}
        {modal === 'create' ? <p className="small muted">Choose a local folder on the next step. The case starts offline. Do not use a shared or cloud-synchronized working directory.</p> : null}
        <div className="modal-footer"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary" disabled={busy || (modal !== 'backup' && !name.trim()) || ((modal === 'backup' || modal === 'restore') && !password)} onClick={() => run(performModal)}>{busy ? 'Working…' : modal === 'note' ? 'Create file' : 'Continue'}<ArrowRight size={14} /></button></div>
      </dialog> : null}

      <ToastStack />
    </div>
  </ThemeProvider>;
}
