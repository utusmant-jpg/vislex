import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Archive, ArrowLeft, ArrowRight, ChevronsUpDown, CircleDot, FilePlus2, FolderOpen, History, Import,
  ListChecks, Lock, Maximize2, MessageSquare, MessageSquarePlus, Minimize2, Minus, MoreHorizontal, NotebookPen, Pencil,
  Plus, RotateCcw, ScanSearch, Search, Settings, ShieldCheck, Sparkles, Trash2, X,
} from 'lucide-react';
import { api, formatBytes, native } from './bridge';
import { motion } from 'motion/react';
import { springs } from './lib/motion';
import type { Snapshot, Selection, SearchResult, WorkingRecord, RecordSummary, Source, Job, Task } from './types';
import { suggestedMatterName } from './review';
import { subscribeCaseChanges } from './caseEvents';
import EvidenceViewer, { SourceIcon } from './components/EvidenceViewer';
import AgentPanel from './components/AgentPanel';
import FolderImport from './components/FolderImport';
import PaneDivider from './components/PaneDivider';
import SidebarDivider from './components/SidebarDivider';
import { ContextMenu, MenuPanel, StatusPill, ThemeProvider, ThemeToggle, ToastStack, Tooltip, matchesModelFilter, notify, relativeTime, type MenuItem, type PillState } from './ui';

const RecordEditor = lazy(() => import('./components/RecordEditor'));
const SettingsDialog = lazy(() => import('./components/SettingsDialog'));
const EvidenceNotebook = lazy(() => import('./components/EvidenceNotebook'));
const InvestigationWorkbench = lazy(() => import('./components/InvestigationWorkbench'));

function WorkspaceLoading({ label, settings = false }: { label: string; settings?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 150);
    return () => window.clearTimeout(timer);
  }, []);
  return visible ? <div className={`workspace-loading ${settings ? 'settings-loading' : ''}`} role="status"><span className="activity-dot" aria-hidden="true" />{label}</div> : null;
}

type View = 'chat' | 'evidence' | 'findings' | 'review' | 'jobs';
type RecentCase = { id: string; name: string; root: string };
const caseGuard = (snapshot: Snapshot) => ({ case_id: snapshot.id, ...(typeof snapshot.session_epoch === 'number' ? { session_epoch: snapshot.session_epoch } : {}) });

const views: { id: View; label: string; icon: typeof MessageSquare; shortcut: string }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, shortcut: 'Ctrl+1' },
  { id: 'evidence', label: 'Evidence', icon: FolderOpen, shortcut: 'Ctrl+2' },
  { id: 'findings', label: 'Findings', icon: NotebookPen, shortcut: 'Ctrl+3' },
  { id: 'review', label: 'Investigate', icon: ScanSearch, shortcut: 'Ctrl+4' },
  { id: 'jobs', label: 'Jobs', icon: ListChecks, shortcut: 'Ctrl+5' },
];

/** Recent cases are identified by id, name and folder only. Chat titles and
 *  other case content are never kept in browser storage; older entries that
 *  carried chat titles are rewritten without them. */
function readRecentCases(): RecentCase[] {
  try {
    const parsed = JSON.parse(localStorage.getItem('vislex-projects') ?? '[]') as Partial<RecentCase>[];
    const cleaned = Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string' && typeof item.root === 'string').map(item => ({ id: item.id!, name: String(item.name ?? ''), root: item.root! })) : [];
    localStorage.setItem('vislex-projects', JSON.stringify(cleaned));
    return cleaned;
  } catch { return []; }
}
function writeRecentCases(cases: RecentCase[]) { try { localStorage.setItem('vislex-projects', JSON.stringify(cases.map(({ id, name, root }) => ({ id, name, root })))); } catch { /* storage unavailable */ } }

function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`brand-mark ${large ? 'large' : ''}`} aria-hidden="true" data-tauri-drag-region><span /><span /><span /></span>;
}

function OnboardingHero({ recent, onCreate, onOpen, onRestore, onSample, onRecent }: { recent: RecentCase[]; onCreate: () => void; onOpen: () => void; onRestore: () => void; onSample: () => void; onRecent: (item: RecentCase) => void }) {
  const cards = [
    { icon: Plus, title: 'Create a case', body: 'Start a new local case folder', run: onCreate },
    { icon: FolderOpen, title: 'Open a case', body: 'Continue an existing .ledcase folder', run: onOpen },
    { icon: RotateCcw, title: 'Restore a backup', body: 'Recover an encrypted case archive', run: onRestore },
    ...(!native ? [{ icon: Sparkles, title: 'Try the sample case', body: 'Synthetic browser preview', run: onSample }] : []),
  ];
  return <div className="onboarding">
    <div className="onboarding-inner">
      <BrandMark large />
      <h1>Investigate your first case</h1>
      <p className="onboarding-lede">VisLex keeps your evidence local, cites every claim to the original file, and never sends anything without your permission.</p>
      <div className="onboarding-cards">
        {cards.map(card => <button className="onboarding-card" key={card.title} onClick={card.run}>
          <span className="icon-tile" aria-hidden="true"><card.icon size={17} /></span>
          <span className="onboarding-card-text"><strong>{card.title}</strong><span>{card.body}</span></span>
          <ArrowRight size={15} className="onboarding-card-arrow" aria-hidden="true" />
        </button>)}
      </div>
      {native && recent.length ? <section className="onboarding-recent" aria-label="Recent cases">
        <div className="section-title">Recent cases</div>
        <div className="list">
          {recent.slice(0, 5).map(item => <button className="list-row" key={item.id} onClick={() => onRecent(item)} title={item.root}>
            <span className="list-row-icon"><FolderOpen size={16} /></span>
            <span className="list-row-main"><span className="list-row-title">{item.name || 'Untitled case'}</span><span className="list-row-subtitle">{item.root}</span></span>
            <ArrowRight size={14} className="muted" aria-hidden="true" />
          </button>)}
        </div>
      </section> : null}
      <ul className="onboarding-assurances">
        <li><ShieldCheck size={14} aria-hidden="true" />Cases start offline</li>
        <li><Lock size={14} aria-hidden="true" />Originals are copied and hashed</li>
        <li><Sparkles size={14} aria-hidden="true" />AI is opt-in per case</li>
      </ul>
    </div>
  </div>;
}

function sourceStatusPill(source: Source): { state: PillState; label: string } {
  const status = source.status.toLowerCase();
  if (/fail|error/.test(status)) return { state: 'failed', label: source.status };
  if (/queued|pending/.test(status)) return { state: 'queued', label: source.status };
  if (/running|processing|extracting|indexing/.test(status)) return { state: 'running', label: source.status };
  if (/ready|indexed|complete|extracted/.test(status)) return { state: 'complete', label: source.status };
  return { state: 'unreviewed', label: source.status };
}

export function EvidenceLibrary({ snapshot, onOpen, onOpenRecord, onRename, onRestrict, onSourceLoaded, onRecordLoaded, onImport }: { snapshot: Snapshot; onOpen: (id: string) => void; onOpenRecord: (id: string) => void; onRename: (id: string, name: string) => void; onRestrict: (id: string, restricted: boolean) => void; onSourceLoaded: (sources: Source[]) => void; onRecordLoaded: (records: RecordSummary[]) => void; onImport?: () => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [section, setSection] = useState<'sources' | 'records'>('sources');
  const [olderSources, setOlderSources] = useState<Source[]>([]);
  const [olderRecords, setOlderRecords] = useState<RecordSummary[]>([]);
  const [sourceCursor, setSourceCursor] = useState<{created_at:string;id:string}|null|undefined>(undefined);
  const [recordCursor, setRecordCursor] = useState<{updated_at:string;id:string}|null|undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const pageKey = `${snapshot.id}:${snapshot.generation}:${snapshot.counts?.audit_seq ?? 0}`;
  const pageKeyRef = useRef(pageKey); pageKeyRef.current = pageKey;
  useEffect(() => {setOlderSources([]);setOlderRecords([]);setSourceCursor(undefined);setRecordCursor(undefined);setPageError('');},[pageKey]);
  const sources = [...snapshot.sources, ...olderSources.filter(source => !snapshot.sources.some(current => current.id === source.id))];
  const records = [...snapshot.records, ...olderRecords.filter(record => !snapshot.records.some(current => current.id === record.id))];
  const kinds = [...new Set(sources.map(source => source.kind))];
  const filteredSources = sources.filter(source =>
    (!kind || source.kind === kind) && source.name.toLowerCase().includes(query.toLowerCase()));
  const filteredRecords = records.filter(record => record.title.toLowerCase().includes(query.toLowerCase()));
  const filtered = section === 'sources' ? filteredSources.length : filteredRecords.length;
  const sourceTotal = snapshot.counts?.source_count ?? sources.length;
  const recordTotal = snapshot.counts?.record_count ?? records.length;
  const restrictedCount = sources.filter(source => source.restricted).length;
  async function loadMore() {
    if (loading) return;
    const key = pageKey;
    setLoading(true);setPageError('');
    try {
      if (section === 'sources') {
        const before = sourceCursor ?? snapshot.source_next_cursor ?? (snapshot.sources.at(-1) ? {created_at:snapshot.sources.at(-1)!.created_at,id:snapshot.sources.at(-1)!.id}:null);
        if (!before) return;
        const page=await api<{sources:Source[];next_cursor:{created_at:string;id:string}|null}>('source_page',{case_id:snapshot.id,generation:snapshot.generation,audit_seq:snapshot.counts?.audit_seq ?? 0,before});
        if (pageKeyRef.current!==key) return;
        setOlderSources(current=>[...current,...page.sources.filter(source=>!current.some(existing=>existing.id===source.id))]);
        onSourceLoaded(page.sources);setSourceCursor(page.next_cursor);
      } else {
        const before = recordCursor ?? snapshot.record_next_cursor ?? (snapshot.records.at(-1) ? {updated_at:snapshot.records.at(-1)!.updated_at,id:snapshot.records.at(-1)!.id}:null);
        if (!before) return;
        const page=await api<{records:RecordSummary[];next_cursor:{updated_at:string;id:string}|null}>('record_page',{case_id:snapshot.id,generation:snapshot.generation,audit_seq:snapshot.counts?.audit_seq ?? 0,before});
        if (pageKeyRef.current!==key) return;
        setOlderRecords(current=>[...current,...page.records.filter(record=>!current.some(existing=>existing.id===record.id))]);
        onRecordLoaded(page.records);setRecordCursor(page.next_cursor);
      }
    } catch (error) {if(pageKeyRef.current===key)setPageError(String(error));}
    finally {if(pageKeyRef.current===key)setLoading(false);}
  }
  const hasMore = section==='sources' ? sourceCursor!==null && sources.length<sourceTotal : recordCursor!==null && records.length<recordTotal;
  return <section className="workspace-view evidence-library" aria-label="Evidence library">
    <header className="surface-header">
      <div className="surface-header-text">
        <div className="eyebrow">Evidence</div>
        <h2>Evidence library</h2>
        <p>{sourceTotal.toLocaleString()} original source{sourceTotal === 1 ? '' : 's'} · {recordTotal.toLocaleString()} working file{recordTotal === 1 ? '' : 's'}{restrictedCount ? ` · ${restrictedCount} restricted in view` : ''}</p>
      </div>
      {onImport ? <div className="surface-actions"><button className="primary" disabled={!native} title={native ? undefined : 'Importing files requires the desktop app'} onClick={onImport}><FilePlus2 size={15} />Add files</button></div> : null}
    </header>
    <div className="library-controls">
      <div className="segmented" role="group" aria-label="Library section">
        <button className={section === 'sources' ? 'selected' : ''} aria-pressed={section === 'sources'} onClick={() => { setSection('sources'); setKind(''); }}>Sources</button>
        <button className={section === 'records' ? 'selected' : ''} aria-pressed={section === 'records'} onClick={() => { setSection('records'); setKind(''); }}>Working files</button>
      </div>
      <div className="search-box"><Search size={15} aria-hidden="true" /><input aria-label="Filter loaded evidence" placeholder={section === 'sources' ? 'Filter loaded file names…' : 'Filter loaded titles…'} value={query} onChange={event => setQuery(event.target.value)} />{query ? <button className="icon-button icon-button-sm" aria-label="Clear filter" onClick={() => setQuery('')}><X size={13} /></button> : null}</div>
      <span className="library-count" aria-live="polite">{filtered.toLocaleString()} shown of {(section === 'sources' ? sourceTotal : recordTotal).toLocaleString()}</span>
    </div>
    {section === 'sources' && kinds.length > 1 ? <div className="chip-row library-kinds" role="group" aria-label="Filter by kind">
      <button className={`chip ${kind === '' ? 'selected' : ''}`} aria-pressed={kind === ''} onClick={() => setKind('')}>All kinds</button>
      {kinds.map(option => <button key={option} className={`chip ${kind === option ? 'selected' : ''}`} aria-pressed={kind === option} onClick={() => setKind(option)}><SourceIcon kind={option} size={13} />{option}</button>)}
    </div> : null}
    {section === 'sources' ? (filteredSources.length ? <div className="library-table" role="list" aria-label="Sources">
      <div className="library-head" aria-hidden="true"><span>Name</span><span>Status</span><span>Size</span><span>Added</span></div>
      {filteredSources.map(source => { const pill = sourceStatusPill(source); return <ContextMenu key={source.id} items={[
        { label: 'Open', icon: <FolderOpen size={15} />, onSelect: () => onOpen(source.id) },
        { label: 'Rename display name', icon: <Pencil size={15} />, shortcut: 'F2', onSelect: () => onRename(source.id, source.name) },
        'separator',
        { label: source.restricted ? 'Allow AI analysis' : 'Restrict from AI analysis', icon: <Lock size={15} />, onSelect: () => onRestrict(source.id, !source.restricted) },
      ]}>
        <button className="library-row" role="listitem" onClick={() => onOpen(source.id)} title={`${source.name}\nSHA-256 ${source.sha256}`} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); onRename(source.id, source.name); } }}>
          <span className="library-name-cell">
            <span className="library-kind"><SourceIcon kind={source.kind} size={16} /></span>
            <span className="library-name-text"><span className="library-name">{source.name}</span><span className="library-sub">{source.kind}{source.sha256 ? ` · ${source.sha256.slice(0, 10)}` : ''}</span></span>
            {source.restricted ? <StatusPill state="restricted" label="Restricted" small /> : null}
          </span>
          <span className="library-cell"><StatusPill state={pill.state} label={pill.label} small /></span>
          <span className="library-cell mono">{formatBytes(source.size)}</span>
          <span className="library-cell">{relativeTime(source.created_at)}</span>
        </button>
      </ContextMenu>; })}
    </div> : <div className="empty-state">{query || kind ? <Search size={20} /> : <FolderOpen size={20} />}<h3>{query || kind ? 'No evidence matches' : 'No evidence yet'}</h3><p>{query || kind ? 'Try a different name or kind. Only loaded pages are filtered here — use Search (Ctrl K) for the whole case.' : 'Drop files anywhere in the window, or add files. Originals are copied into the case and hashed; the files you choose are never modified.'}</p>{!query && !kind && onImport && native ? <button className="primary" onClick={onImport}><FilePlus2 size={15} />Add files</button> : null}</div>) : null}
    {section === 'records' ? (filteredRecords.length ? <div className="library-table" role="list" aria-label="Working files">
      <div className="library-head" aria-hidden="true"><span>Title</span><span>Review</span><span>Revision</span><span>Updated</span></div>
      {filteredRecords.map(record => <button className="library-row" role="listitem" key={record.id} onClick={() => onOpenRecord(record.id)} title={record.title}>
        <span className="library-name-cell">
          <span className="library-kind"><NotebookPen size={16} /></span>
          <span className="library-name-text"><span className="library-name">{record.title}</span><span className="library-sub">{record.kind}{record.actor ? ` · ${record.actor}` : ''}</span></span>
          {record.protected ? <StatusPill state="protected" label="Locked" small /> : null}
        </span>
        <span className="library-cell">{record.stale ? <StatusPill state="stale" label="Needs recheck" small /> : record.review === 'human-reviewed' ? <StatusPill state="accepted" label="Reviewed" small /> : <StatusPill state="unreviewed" label="Unreviewed" small />}</span>
        <span className="library-cell mono">rev {record.revision}</span>
        <span className="library-cell">{relativeTime(record.updated_at)}</span>
      </button>)}
    </div> : <div className="empty-state"><NotebookPen size={20} /><h3>{query ? 'No working files match' : 'No working files yet'}</h3><p>Notes, reports and transcripts you or the investigator create appear here, each with its own revision history.</p></div>) : null}
    {pageError ? <p role="alert" className="notice error">Could not load more: {pageError}</p> : null}
    {hasMore ? <div className="library-more"><button className="secondary" disabled={loading} onClick={()=>void loadMore()}>{loading?'Loading…':`Load more ${section==='sources'?'sources':'working files'}`}</button></div> : null}
  </section>;
}

function IssueHistory({ issue }: { issue: NonNullable<Snapshot['issues']>[number] }) {
  const [receipts, setReceipts] = useState<{id:string;created_at:string}[]>([]);
  const [nextOffset, setNextOffset] = useState<number|null>(0);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (nextOffset === null || loading) return;
    setLoading(true);
    try {
      const page = await api<{receipts:{id:string;created_at:string}[];next_offset:number|null}>('issue_history', { receipt_id: issue.latest_receipt, offset: nextOffset });
      setReceipts(previous => [...previous, ...page.receipts]); setNextOffset(page.next_offset);
    } finally { setLoading(false); }
  };
  return <details className="history-item" onToggle={event => { if (event.currentTarget.open && !receipts.length) void load(); }}>
    <summary>{issue.name.replaceAll('_', ' ')} · {issue.count} previous failure{issue.count === 1 ? '' : 's'}</summary>
    <p className="small danger-text">{issue.error}</p>
    {receipts.map(receipt => <p className="small" key={receipt.id}><code>Receipt {receipt.id}</code> · {receipt.created_at}</p>)}
    {nextOffset !== null && receipts.length ? <button className="quiet" disabled={loading} onClick={() => void load()}>More receipts</button> : null}
  </details>;
}

export function RecordDetailPanel({caseId,sessionEpoch,summary,run,refresh,onSource}:{caseId:string;sessionEpoch?:number;summary:RecordSummary;run:(fn:()=>Promise<void>)=>void;refresh:()=>Promise<void>;onSource:(id:string,locator?:string)=>void}) {
  const [detail,setDetail]=useState<WorkingRecord|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;setDetail(null);setError('');
    void api<WorkingRecord>('record_detail',{case_id:caseId,session_epoch:sessionEpoch,record_id:summary.id,revision:summary.revision})
      .then(record=>{if(active)setDetail(record);})
      .catch(reason=>{if(active)setError(String(reason));});
    return ()=>{active=false;};
  },[caseId,sessionEpoch,summary.id,summary.revision,summary.updated_at,summary.protected,summary.review,summary.stale]);
  return detail?.id===summary.id && detail.revision===summary.revision
    ? <Suspense fallback={<WorkspaceLoading label="Opening working file…" />}><RecordEditor key={`${caseId}:${sessionEpoch}:${detail.id}`} caseId={caseId} sessionEpoch={sessionEpoch} record={detail} run={run} refresh={refresh} onSource={onSource}/></Suspense>
    : <div className="empty-state">{error?<p role="alert">Could not load working file: {error}</p>:<p>Loading working file…</p>}</div>;
}

const jobState = (status: string): PillState => status === 'running' ? 'running' : status === 'queued' ? 'queued' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : status === 'complete' ? 'complete' : 'interrupted';
const storageLabels: Record<string, string> = { originals: 'Originals', artifacts: 'Derived files', staging: 'Import staging', jobs: 'Job workspaces', database: 'Case database', backups: 'Backups', other: 'Other' };

export function JobsCenter({ snapshot, run, refresh, onConversation, pollProgress=native }: { snapshot: Snapshot; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void>; onConversation?: (id: string) => void; pollProgress?:boolean }) {
  type JobProgress = {priority:string;attempt:number;progress:null|{unit:string;completed?:number;total?:number;segments?:number;track?:number;tracks?:number}};
  const mounted = useRef(true);
  const caseSessionKey = `${snapshot.id}:${snapshot.session_epoch ?? 'preview'}`;
  const currentCaseId = useRef(caseSessionKey);
  currentCaseId.current = caseSessionKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [storage, setStorage] = useState<Record<string, number> | null>(null);
  const [reclaimed, setReclaimed] = useState<number | null>(null);
  const [olderJobs, setOlderJobs] = useState<Job[]>([]);
  const [jobCursor, setJobCursor] = useState<number|null>(snapshot.job_next_cursor ?? null);
  const [olderAttention, setOlderAttention] = useState<Job[]>([]);
  const [attentionCursor, setAttentionCursor] = useState<number|null>(snapshot.attention_next_cursor ?? null);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [jobError, setJobError] = useState('');
  const [jobFilter, setJobFilter] = useState<'all' | 'working' | 'attention' | 'completed'>('all');
  const pendingKeys = useRef(new Set<string>());
  const [pendingActions, setPendingActions] = useState<string[]>([]);
  const seenJobs = useRef(new Set<string>());
  function jobAction(key: string, action: () => Promise<void>) {
    const scopedKey = `${caseSessionKey}:${key}`;
    if (pendingKeys.current.has(scopedKey)) return;
    pendingKeys.current.add(scopedKey);
    setPendingActions([...pendingKeys.current]);
    run(async () => {
      try { await action(); }
      finally { pendingKeys.current.delete(scopedKey); setPendingActions([...pendingKeys.current]); }
    });
  }
  const pending = (key: string) => pendingActions.includes(`${caseSessionKey}:${key}`);
  const [progressByJob,setProgressByJob]=useState<Record<string,JobProgress>>({});
  const runningJobIds=(snapshot.jobs ?? []).filter(job=>job.status==='running').map(job=>job.id).join(',');
  useEffect(()=>{
    setProgressByJob({});
    if(!pollProgress || !runningJobIds)return;
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const ids=runningJobIds.split(',');
    const poll=async()=>{
      const values=await Promise.allSettled(ids.map(id=>api<JobProgress>('job_progress',{...caseGuard(snapshot),job_id:id})));
      if(active){const next:Record<string,JobProgress>={};values.forEach((value,index)=>{if(value.status==='fulfilled')next[ids[index]]=value.value;});setProgressByJob(next);timer=setTimeout(()=>{void poll();},2000);}
    };
    void poll();return()=>{active=false;clearTimeout(timer);};
  },[caseSessionKey,runningJobIds,pollProgress]);
  useEffect(()=>{setOlderJobs([]);setOlderAttention([]);setJobCursor(snapshot.job_next_cursor ?? null);setAttentionCursor(snapshot.attention_next_cursor ?? null);setJobError('');setJobFilter('all');seenJobs.current=new Set();},[caseSessionKey]);
  useEffect(()=>{if(!olderJobs.length)setJobCursor(snapshot.job_next_cursor ?? null);},[snapshot.job_next_cursor]);
  useEffect(()=>{if(!olderAttention.length)setAttentionCursor(snapshot.attention_next_cursor ?? null);},[snapshot.attention_next_cursor]);
  useEffect(() => {
    setStorage(null); setReclaimed(null);
    let active=true;
    if (native) void api<Record<string, number>>('storage_usage',caseGuard(snapshot)).then(value=>{if(active)setStorage(value);}).catch(() => undefined);
    return ()=>{active=false;};
  }, [caseSessionKey, snapshot.generation]);
  const jobMap=new Map<string,Job>();
  for(const job of [...(snapshot.attention_jobs ?? []),...(snapshot.jobs ?? []),...olderAttention,...olderJobs])if(!jobMap.has(job.id))jobMap.set(job.id,job);
  const jobs=[...jobMap.values()];
  const currentJobs = jobs.filter(job => !job.superseded);
  const visibleJobs = currentJobs.filter(job => jobFilter === 'all' || (jobFilter === 'working' && ['queued', 'running'].includes(job.status)) || (jobFilter === 'attention' && ['failed', 'interrupted'].includes(job.status)) || (jobFilter === 'completed' && ['complete', 'cancelled'].includes(job.status)));
  const supersededFailures = jobs.filter(job => job.superseded && ['failed', 'interrupted'].includes(job.status));
  const counts = {
    working: currentJobs.filter(job => ['queued', 'running'].includes(job.status)).length,
    attention: currentJobs.filter(job => ['failed', 'interrupted'].includes(job.status)).length,
    completed: currentJobs.filter(job => ['complete', 'cancelled'].includes(job.status)).length,
  };
  async function loadOlderJobs(){
    if(jobCursor===null||loadingJobs)return;
    const sessionKey=caseSessionKey;setLoadingJobs(true);setJobError('');
    try {const page=await api<{jobs:Job[];next_cursor:number|null}>('job_page',{...caseGuard(snapshot),before:jobCursor});
      if(currentCaseId.current!==sessionKey)return;
      setOlderJobs(current=>[...current,...page.jobs.filter(job=>!current.some(existing=>existing.id===job.id))]);setJobCursor(page.next_cursor);
    }catch(error){if(currentCaseId.current===sessionKey)setJobError(String(error));}
    finally{if(currentCaseId.current===sessionKey)setLoadingJobs(false);}
  }
  async function loadOlderAttention(){
    if(attentionCursor===null||loadingJobs)return;
    const sessionKey=caseSessionKey;setLoadingJobs(true);setJobError('');
    try {const page=await api<{jobs:Job[];next_cursor:number|null}>('attention_job_page',{...caseGuard(snapshot),before:attentionCursor});
      if(currentCaseId.current!==sessionKey)return;
      setOlderAttention(current=>[...current,...page.jobs.filter(job=>!current.some(existing=>existing.id===job.id))]);setAttentionCursor(page.next_cursor);
    }catch(error){if(currentCaseId.current===sessionKey)setJobError(String(error));}
    finally{if(currentCaseId.current===sessionKey)setLoadingJobs(false);}
  }
  const review = snapshot.automatic_analysis;
  const reviewOpen = !!review?.review_task && ['running', 'paused', 'failed'].includes(review.review_state);
  const storageTotal = storage ? Object.values(storage).reduce((sum, bytes) => sum + bytes, 0) : 0;
  const firstRender = !seenJobs.current.size;
  return <section className="workspace-view jobs-center" aria-label="Jobs and issues">
    <header className="surface-header">
      <div className="surface-header-text">
        <div className="eyebrow">Activity</div>
        <h2>Jobs &amp; issues</h2>
        <p>Processing status does not certify evidence review. Historical failures remain visible with their receipts.</p>
      </div>
      <div className="surface-actions"><button className="secondary" disabled={pending('transcribe-all')} onClick={() => jobAction('transcribe-all', async () => { await api('transcribe_all', caseGuard(snapshot)); await refresh(); })}>{pending('transcribe-all') ? 'Queuing…' : 'Queue missing full transcripts'}</button></div>
    </header>
    <div className="jobs-summary" aria-label="Activity summary">
      <div className="stat"><span className="stat-value">{counts.working}</span><span className="stat-label">In progress or queued</span></div>
      <div className="stat"><span className={`stat-value ${counts.attention ? 'danger-text' : ''}`}>{counts.attention}</span><span className="stat-label">Need attention</span></div>
      <div className="stat"><span className="stat-value">{counts.completed}</span><span className="stat-label">Completed or cancelled</span></div>
      {storage ? <div className="stat"><span className="stat-value">{formatBytes(storageTotal)}</span><span className="stat-label">Case storage on disk</span></div> : null}
    </div>
    {currentJobs.length ? <div className="chip-row job-filters" role="group" aria-label="Filter jobs by status">
      {([['all', 'All'], ['working', 'Working'], ['attention', 'Needs attention'], ['completed', 'Completed & cancelled']] as const).map(([value, label]) => <button key={value} className={`chip ${jobFilter === value ? 'selected' : ''}`} aria-pressed={jobFilter === value} onClick={() => setJobFilter(value)}>{label}</button>)}
    </div> : null}
    {reviewOpen ? <article className={`card job-card ${review?.review_state === 'failed' ? 'is-attention' : ''}`}>
      <div className="card-header"><span className="icon-tile" aria-hidden="true"><Sparkles size={16} /></span><div className="job-card-title"><strong className="card-title">Automatic case analysis</strong><span className="job-kind">AI review of prepared sources</span></div><div className="card-actions"><StatusPill state={review?.review_state === 'running' ? 'running' : review?.review_state === 'failed' ? 'failed' : 'interrupted'} label={review!.review_state} small /></div></div>
      {review?.review_state === 'failed' ? <p className="small danger-text">Saved progress is available. Continue in a new task to keep uncertain requests untouched.</p> : null}
      {review?.review_state === 'paused' ? <p className="small muted">The review is paused. Saved progress remains available.</p> : null}
      <div className="job-card-footer">
        <code>Task {review!.review_task}</code>
        {review?.review_state !== 'running' ? <button className="secondary" data-size="sm" disabled={pending(`continue-review:${review!.review_task}`)} onClick={() => jobAction(`continue-review:${review!.review_task}`, async () => {
          const result=await api<{task_id:string;conversation_id:string}>('continue_paused_task',{...caseGuard(snapshot),task_id:review!.review_task});
          await refresh();
          if (mounted.current && currentCaseId.current === caseSessionKey) onConversation?.(result.conversation_id);
        })}>{pending(`continue-review:${review!.review_task}`) ? 'Continuing…' : 'Continue saved review'}</button> : null}
      </div>
    </article> : null}
    {visibleJobs.length ? <div className="job-list">{visibleJobs.map(job => {
      const isNew = !firstRender && !seenJobs.current.has(job.id);
      seenJobs.current.add(job.id);
      const progress = progressByJob[job.id]?.progress;
      const determinate = job.status === 'running' && progress && typeof progress.completed === 'number' && typeof progress.total === 'number' && progress.total > 0;
      const percent = determinate ? Math.min(100, Math.max(0, (progress!.completed! / progress!.total!) * 100)) : 0;
      return <motion.article
        className={`card job-card ${['failed', 'interrupted'].includes(job.status) ? 'is-attention job-attention' : ''}`}
        key={job.id}
        initial={isNew ? { opacity: 0, y: 6 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={springs.gentle}
      >
        <div className="card-header">
          <span className="icon-tile" aria-hidden="true">{['failed', 'interrupted'].includes(job.status) ? <History size={16} /> : job.status === 'complete' ? <CircleDot size={16} /> : <ListChecks size={16} />}</span>
          <div className="job-card-title"><strong className="card-title" title={job.name}>{job.name}</strong><span className="job-kind">{job.kind.replaceAll('_', ' ')}</span></div>
          <div className="card-actions"><StatusPill state={jobState(job.status)} label={job.status} small /></div>
        </div>
        {progressByJob[job.id] ? <p role="status" className="status-line">{progressByJob[job.id].priority} · attempt {progressByJob[job.id].attempt}{typeof progress?.completed==='number' ? <span className="units"> · {Math.floor(progress!.completed!)} {progress!.unit}{typeof progress?.total==='number' ? ` / ${Math.ceil(progress!.total!)}` : ''}</span> : null}{typeof progress?.segments==='number' ? <span className="units"> · {progress!.segments} segments</span> : null}</p> : null}
        {job.status === 'running' ? determinate
          ? <div className="job-progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label={`${job.name} progress`}><div className="job-progress-fill" style={{ width: `${percent}%` }} /></div>
          : !progressByJob[job.id] ? <p className="job-activity"><span className="activity-dot" aria-hidden="true" />Running · no measurable units reported yet</p> : null
          : null}
        {job.error ? <p role="alert" className="job-error">{job.error}</p> : null}
        <div className="job-card-footer">
          <code>Receipt {job.id}</code>
          <div className="job-actions">
            {job.kind === 'full_audio' && ['failed', 'interrupted'].includes(job.status) ? <button className="secondary" data-size="sm" disabled={pending(`transcript:${job.id}`)} onClick={() => jobAction(`transcript:${job.id}`, async () => { await api('resume_transcription', { ...caseGuard(snapshot), job_id: job.id }); await refresh(); })}>{pending(`transcript:${job.id}`) ? 'Resuming…' : 'Resume saved chunks'}</button> : null}
            {job.kind === 'full_audio' ? <button className="quiet" disabled={pending(`transcript:${job.id}`)} onClick={() => jobAction(`transcript:${job.id}`, async () => { await api(['running', 'queued'].includes(job.status) ? 'cancel_transcription' : 'transcribe_full', { ...caseGuard(snapshot), source_id: job.source_id }); await refresh(); })}>{pending(`transcript:${job.id}`) ? 'Working…' : ['running', 'queued'].includes(job.status) ? 'Cancel' : 'Retry'}</button> : null}
            {job.status === 'running' && job.kind !== 'full_audio' ? <button className="quiet" disabled={pending(`cancel:${job.id}`)} onClick={() => jobAction(`cancel:${job.id}`, async () => { await api('cancel_processing', { ...caseGuard(snapshot), job_id: job.id }); await refresh(); })}>{pending(`cancel:${job.id}`) ? 'Cancelling…' : 'Cancel'}</button> : null}
            {['interrupted', 'failed'].includes(job.status) && job.kind !== 'auto_prepare' && job.kind !== 'full_audio' ? <button className="secondary" data-size="sm" disabled={pending(`recover:${job.parent_run_id ?? job.id}`)} onClick={() => jobAction(`recover:${job.parent_run_id ?? job.id}`, async () => {
              const runId = job.parent_run_id ?? (['video_ocr_index', 'video_overview_index'].includes(job.kind) ? job.id : null);
              await (runId ? api('retry_video_discovery', { ...caseGuard(snapshot), run_id: runId }) : api('resume_processing', { ...caseGuard(snapshot), job_id: job.id }));
              await refresh();
            })}>{pending(`recover:${job.parent_run_id ?? job.id}`) ? 'Recovering…' : job.parent_run_id || ['video_ocr_index', 'video_overview_index'].includes(job.kind) ? 'Retry index from saved progress' : 'Recover saved job'}</button> : null}
          </div>
        </div>
      </motion.article>;
    })}</div> : currentJobs.length ? <div className="empty-state"><ListChecks size={20} /><h3>No {jobFilter === 'working' ? 'working jobs' : jobFilter === 'attention' ? 'jobs needing attention' : 'completed jobs'} in this page</h3><p>Choose another status or load older jobs.</p></div> : !reviewOpen ? <div className="empty-state"><ListChecks size={20} /><h3>{jobCursor!==null?'No jobs in this page':'No processing jobs yet'}</h3><p>Queued work, completed jobs, and failures will appear here with their receipts.</p></div> : null}
    {jobError?<p role="alert" className="notice error">Could not load older jobs: {jobError}</p>:null}
    <div className="library-more">
      {attentionCursor!==null?<button className="secondary" disabled={loadingJobs} onClick={()=>void loadOlderAttention()}>{loadingJobs?'Loading…':'Load more current problems'}</button>:null}
      {jobCursor!==null?<button className="secondary" disabled={loadingJobs} onClick={()=>void loadOlderJobs()}>{loadingJobs?'Loading…':'Load older jobs'}</button>:null}
    </div>
    {supersededFailures.length || snapshot.issues?.length ? <div className="section-title">History</div> : null}
    {supersededFailures.length ? <details className="card history-card"><summary>Earlier failures and interruptions replaced by newer runs ({supersededFailures.length})</summary>{supersededFailures.map(job => <article className="history-item" key={job.id}><strong>{job.name}</strong><p className="small muted">{job.kind} · {job.error || job.status}</p><code>Receipt {job.id}</code></article>)}</details> : null}
    {snapshot.issues?.length ? <details className="card history-card"><summary>Previous AI tool errors ({snapshot.issues.length} group{snapshot.issues.length === 1 ? '' : 's'})</summary>{snapshot.issues.map(issue => <IssueHistory issue={issue} key={issue.latest_receipt} />)}</details> : null}
    {storage ? <>
      <div className="section-title">Case storage</div>
      <div className="card storage-card">
        <div className="storage-bar" role="img" aria-label={`Case storage ${formatBytes(storageTotal)}`}>
          {Object.entries(storage).filter(([, bytes]) => bytes > 0).map(([name, bytes], index) => <span key={name} className={`storage-segment segment-${index % 6}`} style={{ flexGrow: bytes }} title={`${storageLabels[name] ?? name}: ${formatBytes(bytes)}`} />)}
        </div>
        <dl className="storage-legend">
          {Object.entries(storage).map(([name, bytes], index) => <div key={name}><dt><span className={`storage-swatch segment-${index % 6}`} aria-hidden="true" />{storageLabels[name] ?? name}</dt><dd className="mono">{formatBytes(bytes)}</dd></div>)}
        </dl>
        <div className="job-card-footer">
          {reclaimed !== null ? <p role="status" className="small success-text">Reclaimed {formatBytes(reclaimed)}</p> : <span className="small muted">Only abandoned import copies that match a verified original are removed.</span>}
          <Tooltip text="Only abandoned import copies matching a verified original are removed. Job folders are retained."><button className="secondary" data-size="sm" disabled={pending('reclaim-staging')} onClick={() => jobAction('reclaim-staging', async () => { const sessionKey = caseSessionKey; const receipt = await api<{ reclaimed_bytes: number }>('reclaim_staging', caseGuard(snapshot)); if (currentCaseId.current !== sessionKey) return; const usage = await api<Record<string, number>>('storage_usage',caseGuard(snapshot)); if (currentCaseId.current === sessionKey) { setReclaimed(receipt.reclaimed_bytes); setStorage(usage); } })}>{pending('reclaim-staging') ? 'Checking staging…' : 'Reclaim verified staging duplicates'}</button></Tooltip>
        </div>
      </div>
    </> : null}
  </section>;
}

function dayGroup(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'Earlier';
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return 'Today';
  if (time >= start.getTime() - 86_400_000) return 'Yesterday';
  if (time >= start.getTime() - 7 * 86_400_000) return 'Previous 7 days';
  return 'Earlier';
}

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('vislex-sidebar') !== 'closed');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('vislex-sidebar-width'));
    return Number.isFinite(saved) && saved >= 220 && saved <= 320 ? saved : 248;
  });
  const [viewerWidth, setViewerWidth] = useState(() => {
    const saved = Number(localStorage.getItem('vislex-viewer-width'));
    return Number.isFinite(saved) && saved >= 360 && saved <= 1000 ? saved : 520;
  });
  const [activePane, setActivePane] = useState<'workspace' | 'source'>('workspace');
  const [focusMode, setFocusMode] = useState(() => localStorage.getItem('vislex-layout') === 'focus');
  useEffect(() => { localStorage.setItem('vislex-layout', focusMode ? 'focus' : 'investigate'); }, [focusMode]);
  useEffect(() => {
    if (window.innerWidth > 0 && window.innerWidth < 1200) setSidebarOpen(false);
    const resized = () => { if (window.innerWidth > 0 && window.innerWidth < 1200) setSidebarOpen(false); };
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  useEffect(() => { localStorage.setItem('vislex-sidebar', sidebarOpen ? 'open' : 'closed'); }, [sidebarOpen]);
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem('vislex-sidebar-width', String(Math.round(sidebarWidth))), 200);
    return () => window.clearTimeout(timer);
  }, [sidebarWidth]);
  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem('vislex-viewer-width', String(Math.round(viewerWidth))), 200);
    return () => window.clearTimeout(timer);
  }, [viewerWidth]);
  const [storage, setStorage] = useState<Record<string, number> | null>(null);
  const [palette, setPalette] = useState(false);
  const [rename, setRename] = useState<{ kind: string; id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameDialog = useRef<HTMLDialogElement>(null);
  const paletteDialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const [allChats, setAllChats] = useState(false);
  const [chatFilter, setChatFilter] = useState('');
  const [olderTasks, setOlderTasks] = useState<Task[]>([]);
  const [olderCursor, setOlderCursor] = useState<{ created_at: string; id: string } | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [openTabs, setOpenTabs] = useState<NonNullable<Selection>[]>([]);
  const seenViewer = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [projects, setProjects] = useState<RecentCase[]>(readRecentCases);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const activeSnapshot = useRef<Snapshot | null>(null);
  const [extraSources, setExtraSources] = useState<Source[]>([]);
  const [extraRecords, setExtraRecords] = useState<RecordSummary[]>([]);
  const caseEpoch = useRef(0);
  const refreshSequence = useRef(0);
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => { setActivePane(selection ? 'source' : 'workspace'); }, [selection?.id, selection?.locator]);
  const [navigationHistory, setNavigationHistory] = useState<{ entries: NonNullable<Selection>[]; index: number }>({ entries: [], index: -1 });
  const movingInHistory = useRef(false);
  useEffect(() => {setExtraSources([]);setExtraRecords([]);},[snapshot?.id,snapshot?.session_epoch,snapshot?.generation,snapshot?.counts?.audit_seq]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [focusComposerRequest, setFocusComposerRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const [modal, setModal] = useState<'create' | 'note' | 'backup' | 'restore' | 'delete' | null>(null);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [production] = useState('Initial production');
  const [kind, setKind] = useState('note');
  const [dropping, setDropping] = useState(false);
  const [caseMenu, setCaseMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const installSnapshot = useCallback((next: Snapshot | null) => { caseEpoch.current += 1; activeSnapshot.current = next; setSnapshot(next); }, []);
  const refresh = useCallback(async () => { const epoch = caseEpoch.current; const sequence = ++refreshSequence.current; const next = await api<Snapshot | null>('snapshot'); if (caseEpoch.current === epoch && refreshSequence.current === sequence) { const previous = activeSnapshot.current; if (previous?.id !== next?.id || previous?.session_epoch !== next?.session_epoch) caseEpoch.current += 1; activeSnapshot.current = next; setSnapshot(next); } }, []);
  const run = useCallback((fn: () => Promise<void>) => {
    setBusy(true);
    void fn().catch(error => notify.fromError('Something went wrong', error)).finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void (async () => {
        const current = await api<Snapshot | null>('snapshot');
        const last = localStorage.getItem('vislex-last-case') ?? readRecentCases()[0]?.root;
        installSnapshot(current ?? (native && last ? await api<Snapshot>('open_case', { path: last }) : null));
      })().catch(error => notify.error('Could not reopen the last case', `${String(error)}. Choose a case from the case menu.`));
    }
    if (!native) return;
    const cleanup = subscribeCaseChanges(listen, () => activeSnapshot.current, refresh,
      (caseId, epoch) => api('case_summary', { case_id: caseId, session_epoch: epoch }));
    return () => { void cleanup.then(fn => fn()); };
  }, [refresh, installSnapshot]);

  useEffect(() => {
    if (!modal) return;
    dialog.current?.showModal();
    return () => { if (modalReturnFocus.current?.isConnected) modalReturnFocus.current.focus(); };
  }, [modal]);
  useEffect(() => {
    if (settings) return;
    if (settingsReturnFocus.current?.isConnected) settingsReturnFocus.current.focus();
    settingsReturnFocus.current = null;
  }, [settings]);
  useEffect(() => { if (rename) { setRenameValue(rename.name); renameDialog.current?.showModal(); } }, [rename]);
  useEffect(() => { if (palette) paletteDialog.current?.showModal(); else paletteDialog.current?.close(); }, [palette]);

  // Global shortcuts: palette, settings, workspaces, navigation, tabs.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (modal || rename || settings) return;
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(value => !value); return; }
      if (mod && event.key === ',') { event.preventDefault(); setPalette(false); openSettings(); return; }
      if (event.altKey && !mod && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !typing) { event.preventDefault(); moveInHistory(event.key === 'ArrowLeft' ? -1 : 1); return; }
      if (typing || !mod) return;
      const key = event.key.toLowerCase();
      if (key === 'b') { event.preventDefault(); setSidebarOpen(value => !value); return; }
      if (key === 'n' && !event.shiftKey && snapshot) { event.preventDefault(); chooseConversation(null); setFocusComposerRequest(value => value + 1); return; }
      if (key === 'w' && selection) { event.preventDefault(); closeTab(selection.id); return; }
      const index = Number(event.key) - 1;
      if (index >= 0 && index < views.length) { event.preventDefault(); setView(views[index].id); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  useEffect(() => {
    if (!snapshot) return;
    localStorage.setItem('vislex-last-case', snapshot.root);
    setProjects(previous => { const next = [{ id: snapshot.id, name: snapshot.name, root: snapshot.root }, ...previous.filter(project => project.id !== snapshot.id)].slice(0, 12); writeRecentCases(next); return next; });
    const saved = localStorage.getItem(`vislex-conversation:${snapshot.id}`);
    setConversationId(saved ?? (snapshot.tasks[0]?.conversation_id ?? snapshot.tasks[0]?.id ?? null));
    setSelection(null); setOpenTabs([]); setNavigationHistory({ entries: [], index: -1 }); movingInHistory.current = false; setOlderTasks([]); setOlderCursor(undefined); setChatFilter(''); seenViewer.current = snapshot.viewer_request?.id ?? null;
    setView('chat');
    setStorage(null);
    void api<Record<string, number>>('storage_usage').then(setStorage).catch(() => undefined);
  }, [snapshot?.id, snapshot?.session_epoch]);

  useEffect(() => { if (snapshot) setProjects(previous => { const next = previous.map(project => project.id === snapshot.id ? { ...project, name: snapshot.name } : project); writeRecentCases(next); return next; }); }, [snapshot?.name]);

  useEffect(() => {
    if (!snapshot) return;
    let active = true; let timer: ReturnType<typeof setTimeout>; let lastStamp = ''; let checks = 0;
    const caseId = snapshot.id;
    const epoch = caseEpoch.current;
    const poll = async () => {
      try {
        const summary = await api<Record<string, unknown>>('case_summary', { case_id: caseId });
        if (!active || caseEpoch.current !== epoch) return;
        const stamp = JSON.stringify(summary);
        if (stamp !== lastStamp || ++checks % 10 === 0) { lastStamp = stamp; await refresh(); }
      } catch (error) { if (active && caseEpoch.current === epoch) notify.fromError('Case refresh failed', error); }
      if (active) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [snapshot?.id, snapshot?.session_epoch, refresh]);

  useEffect(() => {
    if (selection) setOpenTabs(tabs => {
      const found = tabs.some(tab => tab.type === selection.type && tab.id === selection.id);
      return found ? tabs.map(tab => tab.type === selection.type && tab.id === selection.id ? selection : tab) : [...tabs, selection];
    });
  }, [selection]);

  useEffect(() => {
    if (!selection || !snapshot || !([...snapshot.sources, ...snapshot.records, ...extraSources, ...extraRecords].some(item => item.id === selection.id))) return;
    if (movingInHistory.current) { movingInHistory.current = false; return; }
    setNavigationHistory(previous => {
      const current = previous.entries[previous.index];
      if (current?.type === selection.type && current.id === selection.id && current.locator === selection.locator) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), selection].slice(-100);
      return { entries, index: entries.length - 1 };
    });
  }, [selection, snapshot?.id, extraSources, extraRecords]);

  useEffect(() => {
    if (!snapshot || !selection) return;
    if (selection.type === 'source' && !snapshot.sources.some(item=>item.id===selection.id) && !extraSources.some(item=>item.id===selection.id)) {
      let active=true;const caseId=snapshot.id;
      void api<Source>('source_detail',{case_id:caseId,source_id:selection.id}).then(source=>{if(active)setExtraSources(current=>[...current.filter(item=>item.id!==source.id),source]);}).catch(error=>{if(active)notify.fromError('Could not open evidence',error);});
      return ()=>{active=false;};
    }
    if (selection.type === 'record' && !snapshot.records.some(item=>item.id===selection.id) && !extraRecords.some(item=>item.id===selection.id)) {
      let active=true;const caseId=snapshot.id;
      void api<RecordSummary>('record_summary',{case_id:caseId,record_id:selection.id}).then(record=>{if(active)setExtraRecords(current=>[...current.filter(item=>item.id!==record.id),record]);}).catch(error=>{if(active)notify.fromError('Could not open working file',error);});
      return ()=>{active=false;};
    }
  },[snapshot?.id,snapshot?.session_epoch,snapshot?.generation,snapshot?.counts?.audit_seq,selection,extraSources,extraRecords]);

  function moveInHistory(delta: number) {
    const index = navigationHistory.index + delta;
    const target = navigationHistory.entries[index];
    if (!target) return;
    movingInHistory.current = true;
    setNavigationHistory(previous => ({ ...previous, index }));
    setSelection(target);
  }

  // The investigator can ask the viewer to show a source; the evidence dock
  // opens it beside whatever workspace the user is in rather than yanking them.
  useEffect(() => {
    const request = snapshot?.viewer_request;
    if (!request || request.id === seenViewer.current) return;
    seenViewer.current = request.id;
    setSelection({ type: 'source', id: request.source_id, locator: request.time_seconds != null ? `time:${request.time_seconds}` : request.page != null ? `page:${request.page}` : undefined });
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
          const receipt = await api<{ items: { status: string; detail: { error?: string } }[] }>('import_files', { ...caseGuard(snapshot), paths, production });
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
      const caseId = snapshot?.id;
      if (!caseId) return;
      const epoch = caseEpoch.current;
      const removed = olderTasks.filter(task => (task.conversation_id ?? task.id) === id);
      await api('delete_conversation', { ...caseGuard(snapshot), conversation_id: id });
      if (caseEpoch.current === epoch) setOlderTasks(current => current.filter(task => (task.conversation_id ?? task.id) !== id));
      notify.success('Chat deleted', undefined, { label: 'Undo', run: () => { void api('delete_conversation', { ...caseGuard(snapshot), conversation_id: id, deleted: false }).then(() => { if (caseEpoch.current === epoch) setOlderTasks(current => [...current, ...removed]); return refresh(); }).catch(error => notify.fromError('Could not restore chat', error)); } });
      if (conversationId === id) chooseConversation(null);
      await refresh();
    });
  }
  const allTaskSummaries = [...(snapshot?.tasks ?? []), ...olderTasks.filter(task => !snapshot?.tasks.some(current => current.id === task.id))];
  const conversationRows = new Map<string, { newest: Task; firstPrompt: string }>();
  for (const task of allTaskSummaries) {
    const id = task.conversation_id ?? task.id;
    const row = conversationRows.get(id);
    if (row) row.firstPrompt = task.prompt;
    else conversationRows.set(id, { newest: task, firstPrompt: task.prompt });
  }
  const conversations = [...conversationRows].map(([id, { newest, firstPrompt }]) => ({
    id, title: newest.title ?? firstPrompt, running: newest.status === 'running', when: newest.created_at,
  }));
  const filteredConversations = chatFilter.trim() ? conversations.filter(chat => matchesModelFilter(chat.title, chatFilter)) : conversations;
  const listedConversations = allChats || chatFilter.trim() ? filteredConversations : filteredConversations.slice(0, 8);
  const groupedConversations: { label: string; items: typeof conversations }[] = [];
  for (const chat of listedConversations) {
    const label = dayGroup(chat.when);
    const group = groupedConversations.find(item => item.label === label);
    if (group) group.items.push(chat); else groupedConversations.push({ label, items: [chat] });
  }
  function loadOlderChats() {
    if (!snapshot || loadingOlder || olderCursor === null) return;
    const before = olderCursor ?? (snapshot.tasks.at(-1) ? { created_at: snapshot.tasks.at(-1)!.created_at, id: snapshot.tasks.at(-1)!.id } : null);
    if (!before) return;
    const caseId = snapshot.id;
    const epoch = caseEpoch.current;
    setLoadingOlder(true);
    void api<{ tasks: Task[]; next_cursor: { created_at: string; id: string } | null }>('task_page', { case_id: caseId, before })
      .then(page => { if (caseEpoch.current !== epoch) return; setOlderTasks(current => [...current, ...page.tasks.filter(task => !current.some(existing => existing.id === task.id))]); setOlderCursor(page.next_cursor); })
      .catch(error => notify.fromError('Could not load older chats', error))
      .finally(() => setLoadingOlder(false));
  }

  const visibleSnapshot: Snapshot | null = snapshot ? {...snapshot,sources:[...snapshot.sources,...extraSources.filter(item=>!snapshot.sources.some(current=>current.id===item.id))],records:[...snapshot.records,...extraRecords.filter(item=>!snapshot.records.some(current=>current.id===item.id))]} : null;
  const source = selection?.type === 'source' ? visibleSnapshot?.sources.find(item => item.id === selection.id) : undefined;
  const record = selection?.type === 'record' ? visibleSnapshot?.records.find(item => item.id === selection.id) : undefined;
  const suggestedName = suggestedMatterName(snapshot?.sources.map(item => item.name) ?? []);
  const pending = snapshot?.jobs?.filter(job => ['queued', 'running'].includes(job.status)) ?? [];
  const pendingCount = snapshot?.counts ? snapshot.counts.jobs_queued + snapshot.counts.jobs_running : pending.length;
  const needsAttention = (snapshot?.counts?.jobs_attention ?? snapshot?.jobs?.filter(job => !job.superseded && !job.parent_run_id && ['failed', 'interrupted'].includes(job.status)).length ?? 0)
    + (snapshot?.automatic_analysis?.review_state === 'failed' ? 1 : 0);
  const selectSource = (id: string, locator?: string) => { setSelection({ type: 'source', id, locator }); setActivePane('source'); };

  async function importFiles() {
    if (!snapshot) throw new Error('Create or open a case first.');
    const paths = await open({ multiple: true, directory: false, title: 'Import evidence — originals will be preserved' });
    if (paths) {
      const receipt = await api<{ items: { status: string; detail: { error?: string } }[] }>('import_files', { ...caseGuard(snapshot), paths: Array.isArray(paths) ? paths : [paths], production });
      await refresh();
      const failed = receipt.items.filter(item => item.status === 'failed');
      if (failed.length) throw new Error(`${failed.length} import(s) failed: ${failed.map(item => item.detail.error).join('; ')}`);
      notify.success('Import finished', 'Originals are preserved and hashed.');
    }
  }
  async function openCase() {
    if (!native) { installSnapshot(await api<Snapshot>('load_demo')); setSelection(null); return; }
    const path = await open({ directory: true, title: 'Open a VisLex case folder' });
    if (typeof path === 'string') { installSnapshot(await api<Snapshot>('open_case', { ...(snapshot ? caseGuard(snapshot) : {}), path })); setSelection(null); setView('chat'); }
  }
  function openRecent(item: RecentCase) {
    run(async () => { installSnapshot(await api<Snapshot>('open_case', { ...(snapshot ? caseGuard(snapshot) : {}), path: item.root })); setView('chat'); });
  }
  function showModal(type: typeof modal) { modalReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setName(''); setPassword(''); setPasswordConfirm(''); setModal(type); }
  function openSettings() { settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSettings(true); }
  async function performModal() {
    if (modal === 'create') { const parent = await open({ directory: true, title: 'Choose a local parent folder' }); if (typeof parent !== 'string') return; const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, ''); if (!safeName) throw new Error('Enter a case name.'); const path = `${parent}\\${safeName}.ledcase`; installSnapshot(await api<Snapshot>('create_case', { ...(snapshot ? caseGuard(snapshot) : {}), path, name })); setSelection(null); notify.success('Case created', 'Drop files anywhere to import evidence.'); }
    if (modal === 'note') { if (!snapshot) throw new Error('Open a case first.'); const created = await api<WorkingRecord>('write_record', { ...caseGuard(snapshot), title: name, kind, content: `# ${name}\n\n`, base_revision: 0, source_ids: source ? [source.id] : [], reason: 'Create working record' }); await refresh(); setSelection({ type: 'record', id: created.id }); }
    if (modal === 'backup') { if (!snapshot) throw new Error('Open a case first.'); if (password !== passwordConfirm) throw new Error('The passphrases do not match.'); const path = await save({ defaultPath: 'case-backup.tar.age', filters: [{ name: 'Encrypted backup', extensions: ['age'] }] }); if (!path) return; await api('backup', { ...caseGuard(snapshot), path, password }); notify.success('Encrypted backup saved', path); }
    if (modal === 'delete') {
      if (!snapshot) throw new Error('Open a case first.');
      const receipt = await api<{ deleted: boolean; bytes: number }>('delete_case', { ...caseGuard(snapshot), path: snapshot.root, confirm: name });
      setProjects(previous => { const next = previous.filter(project => project.id !== snapshot.id); writeRecentCases(next); return next; });
      if (localStorage.getItem('vislex-last-case') === snapshot.root) localStorage.removeItem('vislex-last-case');
      localStorage.removeItem(`vislex-conversation:${snapshot.id}`);
      installSnapshot(null); setSelection(null); setOpenTabs([]);
      notify.success('Case deleted', `${formatBytes(receipt.bytes)} of case data removed from disk.`);
    }
    if (modal === 'restore') { const archive = await open({ filters: [{ name: 'Encrypted case', extensions: ['age'] }] }); if (typeof archive !== 'string') return; const parent = await open({ directory: true, title: 'Choose restoration parent folder' }); if (typeof parent !== 'string') return; const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, ''); if (!safeName) throw new Error('Enter a restored case folder name.'); installSnapshot(await api<Snapshot>('restore_case', { ...(snapshot ? caseGuard(snapshot) : {}), archive, path: `${parent}\\${safeName}.ledcase`, password })); setSelection(null); }
    setPassword(''); setPasswordConfirm(''); setModal(null);
  }

  /* ------------------------------ command palette ----------------------------- */
  const paletteCommands = useMemo(() => [
    { id: 'new-chat', label: 'New chat', hint: 'Ctrl+N', run: () => { chooseConversation(null); setPalette(false); } },
    { id: 'view-evidence', label: 'Go to Evidence', hint: 'Ctrl+2', run: () => { setView('evidence'); setPalette(false); } },
    { id: 'view-findings', label: 'Go to Findings', hint: 'Ctrl+3', run: () => { setView('findings'); setPalette(false); } },
    { id: 'view-review', label: 'Go to Investigation workbench', hint: 'Ctrl+4', run: () => { setView('review'); setPalette(false); } },
    { id: 'view-jobs', label: 'Go to Jobs & issues', hint: 'Ctrl+5', run: () => { setView('jobs'); setPalette(false); } },
    { id: 'settings', label: 'Open settings', hint: 'Ctrl+,', run: () => { setPalette(false); openSettings(); } },
    { id: 'transcribe-all', label: 'Queue missing full transcripts', hint: '', run: () => { setPalette(false); run(async () => { if (!snapshot) throw new Error('Open a case first.'); await api('transcribe_all', caseGuard(snapshot)); await refresh(); }); } },
    { id: 'add-files', label: 'Add files to this case', hint: '', run: () => { setPalette(false); run(importFiles); } },
    { id: 'toggle-focus', label: focusMode ? 'Leave focus mode' : 'Enter focus mode', hint: '', run: () => { setPalette(false); setFocusMode(value => !value); } },
    { id: 'delete-case', label: 'Delete this case permanently', hint: '', run: () => { setPalette(false); if (snapshot && native) showModal('delete'); else notify.info('Open a native case to delete it.'); } },
  ], [run, refresh, snapshot, focusMode]);
  const paletteMatches = useMemo(() => {
    const text = query.trim();
    if (!text || !snapshot) return [];
    return snapshot.sources.filter(item => matchesModelFilter(item.name, text)).slice(0, 6);
  }, [query, snapshot]);
  const paletteItems = useMemo(() => [
    ...paletteMatches.map(item => ({ kind: 'source' as const, id: item.id, label: item.name })),
    ...(results ?? []).map((item, index) => ({ kind: 'result' as const, id: `${item.source_id}:${index}`, label: item.name, excerpt: item.excerpt, sourceId: item.source_id, locator: item.locator })),
    ...paletteCommands.filter(command => (snapshot || command.id === 'settings') && (!query.trim() || matchesModelFilter(command.label, query))).map(command => ({ kind: 'command' as const, id: command.id, label: command.label, hint: command.hint, run: command.run })),
  ], [paletteMatches, results, paletteCommands, query, snapshot]);
  useEffect(() => { setPaletteIndex(0); }, [query, results]);
  useEffect(() => { document.getElementById(`case-command-item-${paletteIndex}`)?.scrollIntoView?.({ block: 'nearest' }); }, [paletteIndex]);
  function activatePaletteItem(item: (typeof paletteItems)[number]) {
    if (item?.kind === 'source') { selectSource(item.id); setPalette(false); return; }
    if (item?.kind === 'result') { selectSource(item.sourceId, item.locator.split('#')[1]); setPalette(false); return; }
    if (item?.kind === 'command') { item.run(); return; }
  }
  function paletteEnter() {
    const item = paletteItems[paletteIndex];
    if (item) { activatePaletteItem(item); return; }
    searchPalette();
  }
  function searchPalette() {
    if (query.trim() && snapshot) {
      const epoch = caseEpoch.current;
      run(async () => {
        const response = await api<{ results: SearchResult[]; remaining_passages: number }>('hybrid_search', { ...caseGuard(snapshot), query });
        if (caseEpoch.current !== epoch) return;
        setResults(response.results);
        if (response.remaining_passages > 0) notify.info('Indexing in progress', `${response.remaining_passages} passages remain unindexed; current results cover indexed text only. Repeat semantic search to continue indexing.`);
      });
    }
  }

  const statusJob = pending[0];
  const totalBytes = snapshot?.counts?.source_bytes ?? snapshot?.sources.reduce((total, item) => total + item.size, 0) ?? 0;
  const totalStorage = storage ? Object.values(storage).reduce((total, bytes) => total + bytes, 0) : 0;
  const recordCount = snapshot?.counts?.record_count ?? snapshot?.records.length ?? 0;
  const aiState = !snapshot ? null : snapshot.settings.offline ? { label: 'AI off for this case', tone: 'off' } : !snapshot.settings.allow_text ? { label: 'AI may not read case text', tone: 'off' } : { label: snapshot.settings.model ? `AI permitted · ${snapshot.settings.model}` : 'AI permitted', tone: 'on' };
  const sourceCount = snapshot ? snapshot.counts?.source_count ?? snapshot.sources.length : 0;
  const caseStatus: { state: PillState; label: string } | null = !snapshot ? null : pendingCount ? { state: 'running', label: `${pendingCount} job${pendingCount === 1 ? '' : 's'} in progress` } : needsAttention ? { state: 'needs-attention', label: `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention` } : { state: 'complete', label: 'Processing up to date' };
  const otherCases = projects.filter(project => project.id !== snapshot?.id);
  const caseMenuItems: MenuItem[] = [
    ...otherCases.slice(0, 8).map(project => ({ label: project.name || 'Untitled case', icon: <FolderOpen size={15} />, onSelect: () => openRecent(project) }) as MenuItem),
    ...(otherCases.length ? ['separator' as const] : []),
    { label: 'Create a case…', icon: <Plus size={15} />, onSelect: () => showModal('create') },
    { label: native ? 'Open a case folder…' : 'Open the sample case', icon: <FolderOpen size={15} />, onSelect: () => run(openCase) },
    { label: 'Restore from encrypted backup…', icon: <RotateCcw size={15} />, onSelect: () => showModal('restore') },
    ...(snapshot ? ['separator' as const,
      { label: 'Rename case…', icon: <Pencil size={15} />, shortcut: 'F2', onSelect: () => beginRename('case', snapshot.id, snapshot.name) },
      { label: 'Export encrypted backup…', icon: <Archive size={15} />, onSelect: () => showModal('backup') },
      { label: 'Delete case…', icon: <Trash2 size={15} />, danger: true, disabled: !native, onSelect: () => showModal('delete') }] as MenuItem[] : []),
  ];
  const moreMenuItems: MenuItem[] = [
    { label: 'New working file…', icon: <NotebookPen size={15} />, disabled: !snapshot, onSelect: () => showModal('note') },
    { label: 'Export encrypted backup…', icon: <Archive size={15} />, disabled: !snapshot, onSelect: () => showModal('backup') },
    { label: 'Restore from encrypted backup…', icon: <RotateCcw size={15} />, onSelect: () => showModal('restore') },
    'separator',
    { label: 'Delete case…', icon: <Trash2 size={15} />, danger: true, disabled: !snapshot || !native, onSelect: () => showModal('delete') },
  ];
  const modalTitle = modal === 'create' ? 'Create a local case' : modal === 'note' ? 'New working file' : modal === 'backup' ? 'Encrypted case backup' : modal === 'delete' ? 'Delete this case permanently' : 'Restore a case';
  const modalLede = modal === 'create' ? 'A case is a local folder that holds hashed copies of your evidence, chats and findings.' : modal === 'note' ? 'Working files keep every revision. The current source is linked when one is open.' : modal === 'backup' ? 'Creates one encrypted archive with originals, notes, historical revisions and restricted material.' : modal === 'delete' ? 'This erases the case folder from disk.' : 'Choose the encrypted archive and where to restore it on the next steps.';
  const passphraseMismatch = modal === 'backup' && !!passwordConfirm && password !== passwordConfirm;

  return <ThemeProvider>
    <div className={`app-shell ${dropping ? 'dropping' : ''}`}>
      <header className="titlebar" data-tauri-drag-region onDoubleClick={() => { if (native) void getCurrentWindow().toggleMaximize(); }}>
        <div className="titlebar-brand" data-tauri-drag-region><BrandMark /><strong data-tauri-drag-region>VisLex</strong></div>
        {snapshot ? <button className="case-switcher" aria-haspopup="menu" aria-expanded={!!caseMenu} aria-label={`Switch or manage case (current: ${snapshot.name})`} onDoubleClick={event => event.stopPropagation()} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setCaseMenu(caseMenu ? null : { x: rect.left, y: rect.bottom + 6 }); }}>
          <FolderOpen size={14} aria-hidden="true" />
          <span className="title-case">{snapshot.name}</span>
          <ChevronsUpDown size={13} aria-hidden="true" />
        </button> : null}
        <div className="spacer" data-tauri-drag-region />
        <button className="command-bar" onDoubleClick={event => event.stopPropagation()} onClick={() => setPalette(true)} aria-label={snapshot ? 'Search case and run commands' : 'Search commands'}>
          <Search size={14} aria-hidden="true" /><span>{snapshot ? 'Search evidence, meaning and commands' : 'Search commands'}</span><span className="command-bar-keys" aria-hidden="true"><kbd>Ctrl</kbd><kbd>K</kbd></span>
        </button>
        <div className="spacer" data-tauri-drag-region />
        <div className="titlebar-tools">
          {busy ? <span className="titlebar-busy" role="status" aria-label="Working"><span className="activity-dot" aria-hidden="true" /></span> : null}
          {snapshot ? <Tooltip text={focusMode ? 'Leave focus mode' : 'Focus mode: one pane at a time'}><button className="icon-button" aria-label="Focus mode" aria-pressed={focusMode} onDoubleClick={event => event.stopPropagation()} onClick={() => setFocusMode(value => !value)}>{focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></Tooltip> : null}
        </div>
        <div className="window-controls">
          <button aria-label="Minimize window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().minimize(); }}><Minus size={15} /></button>
          <button aria-label="Maximize or restore window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().toggleMaximize(); }}><svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="0.5" y="0.5" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" /></svg></button>
          <button className="window-close" aria-label="Close window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().close(); }}><X size={16} /></button>
        </div>
      </header>

      <div className="workspace" data-active-pane={activePane} data-layout={focusMode ? 'focus' : 'investigate'}>
        <nav className="rail" aria-label="Workspaces">
          {views.map(item => <Tooltip key={item.id} text={item.label} shortcut={item.shortcut} side="right">
            <motion.button
              className={`rail-button ${view === item.id ? 'active' : ''} ${item.id === 'jobs' && needsAttention ? 'attention' : ''}`}
              aria-label={item.label}
              aria-current={view === item.id}
              onClick={() => setView(item.id)}
              whileTap={{ scale: 0.94 }}
              transition={springs.snappy}
            >
              {view === item.id ? <motion.span layoutId="rail-active" className="rail-active-pill" transition={springs.snappy} aria-hidden="true" /> : null}
              <item.icon size={18} />
              {item.id === 'jobs' && needsAttention ? <span className="rail-badge" aria-hidden="true">{needsAttention > 9 ? '9+' : needsAttention}</span> : null}
            </motion.button>
          </Tooltip>)}
          <div className="spacer" />
          <Tooltip text={sidebarOpen ? 'Hide navigation' : 'Show navigation'} shortcut="Ctrl+B" side="right"><button className="rail-button" aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelToggleIcon open /> : <PanelToggleIcon open={false} />}</button></Tooltip>
        </nav>

        <aside className="sidebar" hidden={!sidebarOpen} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} aria-label="Case navigation">
          <div className="sidebar-case">
            <button className="matter-identity" disabled={!snapshot} title="Rename case (F2)" onClick={() => snapshot && beginRename('case', snapshot.id, snapshot.name)} onKeyDown={event => { if (event.key === 'F2' && snapshot) { event.preventDefault(); beginRename('case', snapshot.id, snapshot.name); } }}>
              <span className="matter-name">{snapshot?.name ?? 'No case open'}</span>
              <span className="matter-meta">{snapshot ? `${sourceCount.toLocaleString()} source${sourceCount === 1 ? '' : 's'} · ${formatBytes(totalBytes)}` : 'Local evidence workspace'}</span>
            </button>
            {caseStatus ? <button className="matter-status" onClick={() => setView('jobs')} aria-label={`Case status: ${caseStatus.label}. Open activity`}><StatusPill state={caseStatus.state} label={caseStatus.label} small /></button> : null}
            {suggestedName && suggestedName !== snapshot?.name ? <button className="quiet suggest-name" title="Suggested from PDF filename; confirm against the charging document" onClick={() => snapshot && beginRename('case', snapshot.id, suggestedName)}>Use suggested matter name</button> : null}
          </div>
          <div className="sidebar-actions">
            <button className="secondary sidebar-new-chat" disabled={!snapshot} onClick={() => { chooseConversation(null); setFocusComposerRequest(value => value + 1); }}><MessageSquarePlus size={15} />New chat<kbd>Ctrl N</kbd></button>
            {snapshot && conversations.length > 4 ? <div className="search-box sidebar-filter"><Search size={13} aria-hidden="true" /><input aria-label="Filter chats" placeholder="Filter chats" value={chatFilter} onChange={event => setChatFilter(event.target.value)} /></div> : null}
          </div>
          <nav className="sidebar-scroll" aria-label="Chats">
            {groupedConversations.length ? groupedConversations.map(group => <div className="chat-group" key={group.label}>
              <div className="tree-heading">{group.label}</div>
              {group.items.map(chat => <ContextMenu key={chat.id} items={[
                { label: 'Rename chat', icon: <Pencil size={15} />, shortcut: 'F2', onSelect: () => beginRename('chat', chat.id, chat.title) },
                { label: 'Delete chat', icon: <Trash2 size={15} />, danger: true, disabled: chat.running, onSelect: () => removeChat(chat.id) },
              ]}>
                <div className={`chat-item ${conversationId === chat.id ? 'selected' : ''}`} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); beginRename('chat', chat.id, chat.title); } }}>
                  <button className="chat-open" title={chat.title} aria-current={conversationId === chat.id ? 'page' : undefined} onClick={() => chooseConversation(chat.id)}>
                    <span className="chat-title">{chat.title}</span>
                    {chat.running ? <span className="chat-running"><span className="activity-dot" aria-hidden="true" />Working</span> : <small className="chat-when">{relativeTime(chat.when)}</small>}
                  </button>
                  <button className="icon-button icon-button-sm chat-action" aria-label={`Rename chat: ${chat.title}`} title="Rename chat (F2)" onClick={() => beginRename('chat', chat.id, chat.title)}><Pencil size={12} /></button>
                  <button className="icon-button icon-button-sm chat-action chat-delete" aria-label={`Delete chat: ${chat.title}`} disabled={chat.running} onClick={() => removeChat(chat.id)}><Trash2 size={12} /></button>
                </div>
              </ContextMenu>)}
            </div>) : <p className="sidebar-empty">{!snapshot ? 'Open a case to see its chats.' : chatFilter ? 'No chats match this filter.' : 'No conversations yet. Ask your first question.'}</p>}
            {!chatFilter && (conversations.length > 8 || olderCursor !== null && (olderCursor !== undefined || (snapshot?.tasks.length ?? 0) === 50)) ? <button className="more-chats" onClick={() => setAllChats(value => !value)}>{allChats ? 'Show less' : 'Show all chats'}</button> : null}
            {allChats && olderCursor !== null && (olderCursor !== undefined || (snapshot?.tasks.length ?? 0) === 50) ? <button className="more-chats" disabled={loadingOlder} onClick={loadOlderChats}>{loadingOlder ? 'Loading…' : 'Load older chats'}</button> : null}
          </nav>
          <div className="sidebar-footer">
            {snapshot ? <div className="sidebar-import">
              <button className="quiet" disabled={!native} title={native ? 'Add files to this case' : 'Importing requires the desktop app'} onClick={() => run(importFiles)}><Import size={15} />Add files</button>
              <FolderImport caseId={snapshot?.id} sessionEpoch={snapshot?.session_epoch} hasCase={!!snapshot} run={run} refresh={refresh} />
            </div> : null}
            <div className="sidebar-footer-row">
              <button className="quiet" onClick={() => showModal('create')}><Plus size={15} />Create</button>
              <button className="quiet" onClick={() => run(openCase)}><FolderOpen size={15} />Open</button>
            </div>
            <div className="sidebar-footer-row">
              <Tooltip text="Settings" shortcut="Ctrl+,"><button className="quiet sidebar-settings" onClick={openSettings}><Settings size={15} />Settings</button></Tooltip>
              <div className="spacer" />
              <ThemeToggle />
              <Tooltip text="Case options"><button className="icon-button" aria-label="Case options" aria-haspopup="menu" aria-expanded={!!moreMenu} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMoreMenu(moreMenu ? null : { x: Math.max(8, rect.right - 232), y: rect.top - 8 - 5 * 34 }); }}><MoreHorizontal size={16} /></button></Tooltip>
            </div>
          </div>
        </aside>
        {sidebarOpen ? <SidebarDivider width={sidebarWidth} onWidthChange={setSidebarWidth} /> : null}

        <div className="center-column">
          {!snapshot && view === 'chat' ? <OnboardingHero
            recent={projects}
            onCreate={() => showModal('create')}
            onOpen={() => run(openCase)}
            onRestore={() => showModal('restore')}
            onSample={() => run(async () => { installSnapshot(await api<Snapshot>('load_demo')); })}
            onRecent={openRecent}
          /> : null}
          {visibleSnapshot && view === 'chat' ? <AgentPanel key={`${snapshot!.id}:${snapshot!.session_epoch ?? 'preview'}`} conversationId={conversationId} onConversation={chooseConversation} snapshot={visibleSnapshot} selection={selection} refresh={refresh} run={run} onSource={selectSource} onSettings={openSettings} focusRequest={focusComposerRequest} /> : null}
          {!snapshot && view !== 'chat' ? <div className="empty-state workspace-view"><FolderOpen size={20} /><h3>Open a case first</h3><p>This workspace becomes available once a case is open.</p><button className="primary" onClick={() => setView('chat')}>Choose a case</button></div> : null}
          {snapshot && view === 'evidence' ? <EvidenceLibrary
            snapshot={snapshot}
            onOpen={id => selectSource(id)}
            onOpenRecord={id => setSelection({ type: 'record', id })}
            onImport={() => run(importFiles)}
            onSourceLoaded={items => setExtraSources(current => [...current,...items.filter(item=>!current.some(existing=>existing.id===item.id))])}
            onRecordLoaded={items => setExtraRecords(current => [...current,...items.filter(item=>!current.some(existing=>existing.id===item.id))])}
            onRename={(id, value) => beginRename('source', id, value)}
            onRestrict={(id, restricted) => run(async () => { await api('set_restricted', { ...caseGuard(snapshot), source_id: id, restricted }); await refresh(); })}
          /> : null}
          {visibleSnapshot && view === 'findings' ? <Suspense fallback={<WorkspaceLoading label="Opening findings…" />}><EvidenceNotebook key={`${snapshot!.id}:${snapshot!.session_epoch ?? 'preview'}`} snapshot={visibleSnapshot} onClose={() => setView('chat')} onSource={selectSource} /></Suspense> : null}
          {visibleSnapshot && view === 'review' ? <Suspense fallback={<WorkspaceLoading label="Opening review…" />}><InvestigationWorkbench key={`${snapshot!.id}:${snapshot!.session_epoch ?? 'preview'}`} snapshot={visibleSnapshot} onClose={() => setView('chat')} onSource={selectSource} onConversation={chooseConversation} /></Suspense> : null}
          {snapshot && view === 'jobs' ? <JobsCenter snapshot={snapshot} run={run} refresh={refresh} onConversation={chooseConversation} /> : null}
        </div>

        {selection ? <PaneDivider viewerWidth={viewerWidth} onWidthChange={setViewerWidth} /> : null}
        <main className="main-panel" hidden={!selection} style={{ width: viewerWidth }} aria-label="Evidence viewer">
          <div className="tab-strip">
            <button className="quiet pane-return" aria-label="Return to workspace" onClick={() => setActivePane('workspace')}><ArrowLeft size={14} /><span>Workspace</span></button>
            <div className="tab-history">
              <Tooltip text="Previous location" shortcut="Alt+←"><button className="icon-button" aria-label="Previous location" disabled={navigationHistory.index <= 0} onClick={() => moveInHistory(-1)}><ArrowLeft size={15} /></button></Tooltip>
              <Tooltip text="Next location" shortcut="Alt+→"><button className="icon-button" aria-label="Next location" disabled={navigationHistory.index >= navigationHistory.entries.length - 1} onClick={() => moveInHistory(1)}><ArrowRight size={15} /></button></Tooltip>
            </div>
            <div className="tab-list" role="tablist" aria-label="Open files">
              {openTabs.map(tab => {
                const tabTitle = tab.type === 'source' ? visibleSnapshot?.sources.find(item => item.id === tab.id)?.name : visibleSnapshot?.records.find(item => item.id === tab.id)?.title;
                return <ContextMenu key={tab.id} items={[
                  { label: 'Close', shortcut: 'Ctrl+W', onSelect: () => closeTab(tab.id) },
                  { label: 'Close others', onSelect: () => { setOpenTabs([tab]); if (!(selection?.id === tab.id)) setSelection(tab); } },
                  { label: 'Close tabs to the right', onSelect: () => setOpenTabs(tabs => tabs.slice(0, tabs.findIndex(item => item.id === tab.id) + 1)) },
                ]}>
                  <div className={`file-tab ${selection?.id === tab.id ? 'active' : ''}`}>
                    <button role="tab" aria-selected={selection?.id === tab.id} title={tabTitle} onClick={() => setSelection(tab)} onAuxClick={event => { if (event.button === 1) closeTab(tab.id); }}>
                      {tab.type === 'source' ? <SourceIcon kind={visibleSnapshot?.sources.find(item => item.id === tab.id)?.kind ?? 'other'} size={14} /> : <NotebookPen size={14} aria-hidden="true" />}
                      <span>{tabTitle}</span>
                    </button>
                    <button className="icon-button icon-button-sm" aria-label={`Close ${tabTitle}`} onClick={() => closeTab(tab.id)}><X size={12} /></button>
                  </div>
                </ContextMenu>;
              })}
            </div>
          </div>
          {source ? <EvidenceViewer key={`${snapshot?.id}:${snapshot?.session_epoch}:${source.id}`} caseId={snapshot?.id} sessionEpoch={snapshot?.session_epoch} locator={selection?.locator} source={source} run={run} refresh={refresh} onLocatorSelect={locator => setSelection(current => current ? { ...current, locator } : current)} onAsk={() => { setView('chat'); setFocusComposerRequest(value => value + 1); }} /> : null}
          {record && snapshot ? <RecordDetailPanel key={`${snapshot.id}:${snapshot.session_epoch}:${record.id}`} caseId={snapshot.id} sessionEpoch={snapshot.session_epoch} summary={record} run={run} refresh={refresh} onSource={selectSource}/> : null}
        </main>
      </div>

      {snapshot ? <footer className="statusbar">
        <span className="status-jobs" role="status">
          {statusJob ? <><span className="activity-dot" aria-hidden="true" /><span className="status-job-name">{statusJob.name}</span><span className="muted"> · {statusJob.kind.replaceAll('_', ' ')}</span></> : <span className="muted">No processing running</span>}
          {pendingCount > 1 ? <span className="muted">+{pendingCount - 1} more</span> : null}
        </span>
        {needsAttention ? <button className="status-attention" onClick={() => setView('jobs')}><StatusPill state="needs-attention" label={`${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`} small /></button> : null}
        <div className="spacer" />
        {aiState ? <button className={`status-ai ${aiState.tone}`} onClick={openSettings} title="Open AI permissions"><span className="status-ai-dot" aria-hidden="true" />{aiState.label}</button> : null}
        {recordCount || totalStorage ? <span className="muted">{recordCount === 1 ? '1 working file' : `${recordCount} working files`}{totalStorage ? ` · ${formatBytes(totalStorage)} on disk` : ''}</span> : null}
      </footer> : null}

      {dropping ? <div className="drop-veil" aria-hidden="true"><div className="drop-veil-card"><span className="icon-tile"><Import size={20} /></span><strong>Drop to import into {snapshot?.name ?? 'a case'}</strong><span>Originals are preserved and hashed. Copies are stored inside the case.</span></div></div> : null}

      {caseMenu ? <MenuPanel label="Case" items={caseMenuItems} onClose={() => setCaseMenu(null)} style={{ position: 'fixed', left: caseMenu.x, top: caseMenu.y }} /> : null}
      {moreMenu ? <MenuPanel label="Case options" items={moreMenuItems} onClose={() => setMoreMenu(null)} style={{ position: 'fixed', left: moreMenu.x, top: Math.max(8, moreMenu.y) }} /> : null}

      {rename ? <dialog ref={renameDialog} className="modal" aria-label={`Rename ${rename.kind === 'source' ? 'evidence display name' : rename.kind}`} onCancel={() => setRename(null)}>
        <div className="modal-heading"><div><h2>Rename {rename.kind === 'source' ? 'evidence display name' : rename.kind}</h2><p>Original bytes, import receipts, hashes and citations are preserved.</p></div><button className="icon-button" aria-label="Close dialog" onClick={() => setRename(null)}><X size={18} /></button></div>
        <label className="field-label">Name<input autoFocus maxLength={240} value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && renameValue.trim() && !busy) { event.preventDefault(); (event.currentTarget.closest('dialog')?.querySelector('.modal-footer .primary') as HTMLButtonElement | null)?.click(); } }} /></label>
        {rename.kind === 'source' ? <p className="field-hint">Evidence display names retain their file extension.</p> : null}
        <div className="modal-footer"><button className="secondary" onClick={() => setRename(null)}>Cancel</button><button className="primary" disabled={busy || !renameValue.trim()} onClick={() => run(async () => { if (!snapshot) throw new Error('Open a case first.'); await api('rename', { ...caseGuard(snapshot), kind: rename.kind, id: rename.id, name: renameValue }); await refresh(); setRename(null); })}>Save name</button></div>
      </dialog> : null}

      <dialog ref={paletteDialog} className="modal command-palette" aria-label="Search and commands" onCancel={() => setPalette(false)} onClick={event => { if (event.target === event.currentTarget) setPalette(false); }}>
        <div className="palette-input-row">
          <Search size={17} aria-hidden="true" />
          <input autoFocus role="combobox" aria-autocomplete="list" aria-controls="case-command-results" aria-expanded={paletteItems.length > 0} aria-activedescendant={paletteItems[paletteIndex] ? `case-command-item-${paletteIndex}` : undefined} aria-label={snapshot ? 'Search case — evidence, meaning, chats and commands' : 'Search commands'} value={query} onChange={event => { setQuery(event.target.value); setResults(null); }} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex(index => Math.min(index + 1, paletteItems.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex(index => Math.max(0, index - 1)); }
            else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); searchPalette(); }
            else if (event.key === 'Enter') { event.preventDefault(); paletteEnter(); }
          }} placeholder={snapshot ? 'Search evidence, meaning and commands…' : 'Search commands…'} />
          {query.trim() && snapshot ? <span className="palette-state">{results === null ? <><kbd>Ctrl</kbd><kbd>↵</kbd> search text</> : `${results.length} result${results.length === 1 ? '' : 's'}`}</span> : null}
        </div>
        <div className="palette-results">
          {query.trim() && snapshot && results === null ? <button className="palette-search-action" onClick={searchPalette}><span className="icon-tile" aria-hidden="true"><Search size={15} /></span><span>Search text &amp; meaning for “{query.trim()}”<small>Hybrid search across indexed evidence · Ctrl+Enter</small></span></button> : null}
          <div id="case-command-results" role="listbox" aria-label="Search results and commands">
          {(['source', 'result', 'command'] as const).map(groupKind => {
            const members = paletteItems.map((item, index) => ({ item, index })).filter(entry => entry.item.kind === groupKind);
            if (!members.length) return null;
            const heading = groupKind === 'source' ? 'Evidence' : groupKind === 'result' ? 'Text & meaning' : 'Commands';
            return <div role="group" aria-label={heading} key={groupKind} className="palette-section">
              <div className="palette-group" aria-hidden="true">{heading}</div>
              {members.map(({ item, index }) => <button
                key={`${item.kind}:${item.id}`}
                className={`palette-item ${index === paletteIndex ? 'selected' : ''}`}
                id={`case-command-item-${index}`}
                role="option"
                aria-selected={index === paletteIndex}
                tabIndex={-1}
                onMouseMove={() => { if (paletteIndex !== index) setPaletteIndex(index); }}
                onClick={() => { setPaletteIndex(index); activatePaletteItem(item); }}>
                <span className="palette-item-icon" aria-hidden="true">{item.kind === 'source' ? <SourceIcon kind={snapshot?.sources.find(sourceItem => sourceItem.id === item.id)?.kind ?? 'other'} size={15} /> : item.kind === 'result' ? <Search size={15} /> : <ArrowRight size={15} />}</span>
                <span className="palette-item-text">{item.label}{'excerpt' in item && item.excerpt ? <small>{item.excerpt}</small> : null}</span>
                {item.kind === 'command' && item.hint ? <span className="palette-kbd">{item.hint.split('+').map(key => <kbd key={key}>{key}</kbd>)}</span> : null}
              </button>)}
            </div>;
          })}
          </div>
          {results?.length === 0 ? <p className="palette-empty">No indexed text matches. Unprocessed evidence is not searchable.</p> : null}
          {!snapshot ? <p className="palette-empty">Open a case to search its evidence.</p> : null}
        </div>
        <div className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span>{snapshot ? <span><kbd>Ctrl</kbd><kbd>↵</kbd> search text</span> : null}<span><kbd>Esc</kbd> close</span></div>
      </dialog>

      {settings ? <Suspense fallback={<WorkspaceLoading label="Opening settings…" settings />}><SettingsDialog key={snapshot ? `${snapshot.id}:${snapshot.session_epoch ?? 'preview'}` : 'app'} snapshot={snapshot} onClose={() => setSettings(false)} refresh={refresh} run={run} /></Suspense> : null}

      {modal ? <dialog ref={dialog} className="modal lifecycle-modal" aria-label={modalTitle} onCancel={() => { setModal(null); setPassword(''); setPasswordConfirm(''); }}>
        <div className="modal-heading"><div><h2>{modalTitle}</h2><p>{modalLede}</p></div><button className="icon-button" aria-label="Close dialog" onClick={() => { setModal(null); setPassword(''); setPasswordConfirm(''); }}><X size={18} /></button></div>
        {modal !== 'backup' ? <label className="field-label">{modal === 'note' ? 'Title' : modal === 'delete' ? 'Type the case name to confirm' : 'Case name'}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={modal === 'note' ? 'Review notes' : modal === 'delete' ? snapshot?.name ?? '' : 'Matter name or reference'} /></label> : null}
        {modal === 'delete' && snapshot ? <div className="notice error" role="note"><Trash2 size={16} /><span>“{snapshot.name}” and its entire folder are erased: originals, working files, chats, review decisions and any case archives stored in {snapshot.root}. This cannot be undone. Export an encrypted backup first if you may need this evidence again.</span></div> : null}
        {modal === 'note' ? <label className="field-label">Record type<select value={kind} onChange={event => setKind(event.target.value)}>{['note', 'report', 'claim', 'event', 'person', 'issue', 'transcript', 'clock', 'script'].map(option => <option key={option}>{option}</option>)}</select></label> : null}
        {modal === 'backup' || modal === 'restore' ? <>
          <label className="field-label">Backup passphrase<input type="password" autoComplete="off" autoFocus={modal === 'backup'} value={password} onChange={event => setPassword(event.target.value)} placeholder={modal === 'backup' ? 'At least 12 characters' : 'Passphrase used for this backup'} /></label>
          {modal === 'backup' ? <label className="field-label">Confirm passphrase<input type="password" autoComplete="off" value={passwordConfirm} onChange={event => setPasswordConfirm(event.target.value)} aria-invalid={passphraseMismatch} aria-describedby="passphrase-note" />{passphraseMismatch ? <span className="field-hint danger-text" role="alert">The passphrases do not match.</span> : null}</label> : null}
          <p className="field-hint" id="passphrase-note">Keep this passphrase separately. There is no password recovery. Backups include originals, notes, historical revisions, and restricted material.</p>
        </> : null}
        {modal === 'create' ? <p className="field-hint">Choose a local folder on the next step. The case starts offline. Do not use a shared or cloud-synchronized working directory.</p> : null}
        <div className="modal-footer"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className={`primary ${modal === 'delete' ? 'danger-action' : ''}`} disabled={busy || (modal !== 'backup' && !name.trim()) || ((modal === 'backup' || modal === 'restore') && !password) || (modal === 'backup' && password !== passwordConfirm) || (modal === 'delete' && name.trim().toLowerCase() !== (snapshot?.name ?? '').trim().toLowerCase())} onClick={() => run(performModal)}>{busy ? 'Working…' : modal === 'note' ? 'Create file' : modal === 'delete' ? 'Delete case' : 'Continue'}{modal === 'delete' ? null : <ArrowRight size={14} />}</button></div>
      </dialog> : null}

      <ToastStack />
    </div>
  </ThemeProvider>;
}

function PanelToggleIcon({ open }: { open: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
    {open ? <path d="M15.5 10 13.5 12l2 2" /> : <path d="M13.5 10l2 2-2 2" />}
  </svg>;
}
