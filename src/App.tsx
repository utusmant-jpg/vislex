import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Activity, ArrowRight, FolderOpen, HardDrive, ListChecks, Maximize2, MessageSquare, Minus,
  MoreHorizontal, NotebookPen, PanelLeftClose, PanelLeftOpen, Plus, Scale, Search, Settings, X,
} from 'lucide-react';
import { api, formatBytes, native } from './bridge';
import type { Snapshot, Selection, SearchResult, WorkingRecord, RecordSummary, Source, Job, Task } from './types';
import { suggestedMatterName } from './review';
import EvidenceViewer, { SourceIcon } from './components/EvidenceViewer';
import AgentPanel from './components/AgentPanel';
import FolderImport from './components/FolderImport';
import PaneDivider from './components/PaneDivider';
import SidebarDivider from './components/SidebarDivider';
import WorkspacePreferences from './components/WorkspacePreferences';
import { ContextMenu, StatusPill, ThemeProvider, ThemeToggle, ToastStack, Tooltip, notify, relativeTime } from './ui';

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
  return visible ? <div className={`workspace-loading ${settings ? 'settings-loading' : ''}`} role="status">{label}</div> : null;
}

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

export function EvidenceLibrary({ snapshot, onOpen, onOpenRecord, onRename, onRestrict, onSourceLoaded, onRecordLoaded }: { snapshot: Snapshot; onOpen: (id: string) => void; onOpenRecord: (id: string) => void; onRename: (id: string, name: string) => void; onRestrict: (id: string, restricted: boolean) => void; onSourceLoaded: (sources: Source[]) => void; onRecordLoaded: (records: RecordSummary[]) => void }) {
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
  return <section className="workspace-view evidence-library" aria-label="Evidence library">
    <div className="workspace-header">
      <div><div className="eyebrow">EVIDENCE</div><h2>Evidence library</h2></div>
      <div className="spacer" />
      <span className="small muted">{filtered} shown of {section === 'sources' ? sourceTotal : recordTotal} {section === 'sources' ? 'sources' : 'working files'}</span>
    </div>
    <div className="library-controls">
      <div className="search-box"><Search size={14} /><input aria-label="Filter loaded evidence" placeholder={section === 'sources' ? 'Filter loaded file names…' : 'Filter loaded titles…'} value={query} onChange={event => setQuery(event.target.value)} /></div>
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
    {pageError ? <p role="alert" className="small danger-text">Could not load more: {pageError}</p> : null}
    {(section==='sources' ? sourceCursor!==null && sources.length<sourceTotal : recordCursor!==null && records.length<recordTotal) ? <button className="quiet" disabled={loading} onClick={()=>void loadMore()}>{loading?'Loading…':`Load more ${section==='sources'?'sources':'working files'}`}</button> : null}
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
  return <details className="job-card" onToggle={event => { if (event.currentTarget.open && !receipts.length) void load(); }}>
    <summary>{issue.name.replaceAll('_', ' ')} · {issue.count} previous failure{issue.count === 1 ? '' : 's'}</summary>
    <p className="small danger-text">{issue.error}</p>
    {receipts.map(receipt => <p className="small" key={receipt.id}><code>Receipt {receipt.id}</code> · {receipt.created_at}</p>)}
    {nextOffset !== null && receipts.length ? <button className="quiet" disabled={loading} onClick={() => void load()}>More receipts</button> : null}
  </details>;
}

export function RecordDetailPanel({caseId,summary,run,refresh,onSource}:{caseId:string;summary:RecordSummary;run:(fn:()=>Promise<void>)=>void;refresh:()=>Promise<void>;onSource:(id:string,locator?:string)=>void}) {
  const [detail,setDetail]=useState<WorkingRecord|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;setDetail(null);setError('');
    void api<WorkingRecord>('record_detail',{case_id:caseId,record_id:summary.id,revision:summary.revision})
      .then(record=>{if(active)setDetail(record);})
      .catch(reason=>{if(active)setError(String(reason));});
    return ()=>{active=false;};
  },[caseId,summary.id,summary.revision,summary.updated_at,summary.protected,summary.review,summary.stale]);
  return detail?.id===summary.id && detail.revision===summary.revision
    ? <Suspense fallback={<WorkspaceLoading label="Opening working file…" />}><RecordEditor key={`${caseId}:${detail.id}`} caseId={caseId} record={detail} run={run} refresh={refresh} onSource={onSource}/></Suspense>
    : <div className="empty-state">{error?<p role="alert">Could not load working file: {error}</p>:<p>Loading working file…</p>}</div>;
}

export function JobsCenter({ snapshot, run, refresh, onConversation, pollProgress=native }: { snapshot: Snapshot; run: (fn: () => Promise<void>) => void; refresh: () => Promise<void>; onConversation?: (id: string) => void; pollProgress?:boolean }) {
  type JobProgress = {priority:string;attempt:number;progress:null|{unit:string;completed?:number;total?:number;segments?:number;track?:number;tracks?:number}};
  const mounted = useRef(true);
  const currentCaseId = useRef(snapshot.id);
  currentCaseId.current = snapshot.id;
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
  const [progressByJob,setProgressByJob]=useState<Record<string,JobProgress>>({});
  const runningJobIds=(snapshot.jobs ?? []).filter(job=>job.status==='running').map(job=>job.id).join(',');
  useEffect(()=>{
    setProgressByJob({});
    if(!pollProgress || !runningJobIds)return;
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const ids=runningJobIds.split(',');
    const poll=async()=>{
      const values=await Promise.allSettled(ids.map(id=>api<JobProgress>('job_progress',{case_id:snapshot.id,job_id:id})));
      if(active){const next:Record<string,JobProgress>={};values.forEach((value,index)=>{if(value.status==='fulfilled')next[ids[index]]=value.value;});setProgressByJob(next);timer=setTimeout(()=>{void poll();},2000);}
    };
    void poll();return()=>{active=false;clearTimeout(timer);};
  },[snapshot.id,runningJobIds,pollProgress]);
  useEffect(()=>{setOlderJobs([]);setOlderAttention([]);setJobCursor(snapshot.job_next_cursor ?? null);setAttentionCursor(snapshot.attention_next_cursor ?? null);setJobError('');setJobFilter('all');},[snapshot.id]);
  useEffect(()=>{if(!olderJobs.length)setJobCursor(snapshot.job_next_cursor ?? null);},[snapshot.job_next_cursor]);
  useEffect(()=>{if(!olderAttention.length)setAttentionCursor(snapshot.attention_next_cursor ?? null);},[snapshot.attention_next_cursor]);
  useEffect(() => {
    setStorage(null); setReclaimed(null);
    if (native) void api<Record<string, number>>('storage_usage').then(setStorage).catch(() => undefined);
  }, [snapshot.id, snapshot.generation]);
  const jobMap=new Map<string,Job>();
  for(const job of [...(snapshot.attention_jobs ?? []),...(snapshot.jobs ?? []),...olderAttention,...olderJobs])if(!jobMap.has(job.id))jobMap.set(job.id,job);
  const jobs=[...jobMap.values()];
  const currentJobs = jobs.filter(job => !job.superseded);
  const visibleJobs = currentJobs.filter(job => jobFilter === 'all' || (jobFilter === 'working' && ['queued', 'running'].includes(job.status)) || (jobFilter === 'attention' && ['failed', 'interrupted'].includes(job.status)) || (jobFilter === 'completed' && ['complete', 'cancelled'].includes(job.status)));
  const supersededFailures = jobs.filter(job => job.superseded && ['failed', 'interrupted'].includes(job.status));
  async function loadOlderJobs(){
    if(jobCursor===null||loadingJobs)return;
    const caseId=snapshot.id;setLoadingJobs(true);setJobError('');
    try {const page=await api<{jobs:Job[];next_cursor:number|null}>('job_page',{case_id:caseId,before:jobCursor});
      if(currentCaseId.current!==caseId)return;
      setOlderJobs(current=>[...current,...page.jobs.filter(job=>!current.some(existing=>existing.id===job.id))]);setJobCursor(page.next_cursor);
    }catch(error){if(currentCaseId.current===caseId)setJobError(String(error));}
    finally{if(currentCaseId.current===caseId)setLoadingJobs(false);}
  }
  async function loadOlderAttention(){
    if(attentionCursor===null||loadingJobs)return;
    const caseId=snapshot.id;setLoadingJobs(true);setJobError('');
    try {const page=await api<{jobs:Job[];next_cursor:number|null}>('attention_job_page',{case_id:caseId,before:attentionCursor});
      if(currentCaseId.current!==caseId)return;
      setOlderAttention(current=>[...current,...page.jobs.filter(job=>!current.some(existing=>existing.id===job.id))]);setAttentionCursor(page.next_cursor);
    }catch(error){if(currentCaseId.current===caseId)setJobError(String(error));}
    finally{if(currentCaseId.current===caseId)setLoadingJobs(false);}
  }
  const review = snapshot.automatic_analysis;
  const reviewOpen = !!review?.review_task && ['running', 'paused', 'failed'].includes(review.review_state);
  return <section className="workspace-view jobs-center" aria-label="Jobs and issues">
    <div className="workspace-header"><div><div className="eyebrow">ACTIVITY</div><h2>Jobs &amp; issues</h2></div><div className="spacer" /><button className="quiet" onClick={() => run(async () => { await api('transcribe_all'); await refresh(); })}>Queue missing full transcripts</button></div>
    <p className="small muted">Processing status does not certify evidence review. Historical failures remain visible with their receipts.</p>
    {currentJobs.length ? <div className="chip-row job-filters" role="group" aria-label="Filter jobs by status">
      {([['all', 'All'], ['working', 'Working'], ['attention', 'Needs attention'], ['completed', 'Completed & cancelled']] as const).map(([value, label]) => <button key={value} className={`chip ${jobFilter === value ? 'selected' : ''}`} aria-pressed={jobFilter === value} onClick={() => setJobFilter(value)}>{label}</button>)}
    </div> : null}
    {reviewOpen ? <article className={`job-card ${review?.review_state === 'failed' ? 'job-attention' : ''}`}>
      <div className="job-card-head"><strong>Automatic case analysis</strong><StatusPill state={review?.review_state === 'running' ? 'running' : review?.review_state === 'failed' ? 'failed' : 'interrupted'} label={review!.review_state} small /></div>
      {review?.review_state === 'failed' ? <p className="small danger-text">Saved progress is available. Continue in a new task to keep uncertain requests untouched.</p> : null}
      {review?.review_state === 'paused' ? <p className="small muted">The review is paused. Saved progress remains available.</p> : null}
      {review?.review_state !== 'running' ? <button className="quiet" onClick={() => run(async () => {
        const result=await api<{task_id:string;conversation_id:string}>('continue_paused_task',{case_id:snapshot.id,task_id:review!.review_task});
        await refresh();
        if (mounted.current && currentCaseId.current === snapshot.id) onConversation?.(result.conversation_id);
      })}>Continue saved review</button> : null}
      <code>Task {review!.review_task}</code>
    </article> : null}
    {visibleJobs.length ? visibleJobs.map(job => <article className={`job-card ${['failed', 'interrupted'].includes(job.status) ? 'job-attention' : ''}`} key={job.id}>
      <div className="job-card-head">
        <strong>{job.name}</strong>
        <StatusPill state={job.status === 'running' ? 'running' : job.status === 'queued' ? 'queued' : job.status === 'cancelled' ? 'cancelled' : job.status === 'failed' ? 'failed' : job.status === 'complete' ? 'complete' : 'interrupted'} label={job.status} small />
      </div>
      <p className="small muted">{job.kind}</p>
      {progressByJob[job.id] ? <p role="status" className="small muted">{progressByJob[job.id].priority} · attempt {progressByJob[job.id].attempt}{typeof progressByJob[job.id].progress?.completed==='number' ? ` · ${Math.floor(progressByJob[job.id].progress!.completed!)} ${progressByJob[job.id].progress!.unit}${typeof progressByJob[job.id].progress?.total==='number' ? ` / ${Math.ceil(progressByJob[job.id].progress!.total!)}` : ''}` : ''}{typeof progressByJob[job.id].progress?.segments==='number' ? ` · ${progressByJob[job.id].progress!.segments} segments` : ''}</p> : null}
      {job.error ? <p role="alert" className="small danger-text">{job.error}</p> : null}
      <div className="input-row">
        {job.kind === 'full_audio' && ['failed', 'interrupted'].includes(job.status) ? <button className="quiet" onClick={() => run(async () => { await api('resume_transcription', { job_id: job.id }); await refresh(); })}>Resume saved chunks</button> : null}
        {job.kind === 'full_audio' ? <button className="quiet" onClick={() => run(async () => { await api(['running', 'queued'].includes(job.status) ? 'cancel_transcription' : 'transcribe_full', { source_id: job.source_id }); await refresh(); })}>{['running', 'queued'].includes(job.status) ? 'Cancel' : 'Retry'}</button> : null}
        {job.status === 'running' ? <button className="quiet" onClick={() => run(async () => { await api('cancel_processing', { job_id: job.id }); await refresh(); })}>Cancel</button> : null}
        {['interrupted', 'failed'].includes(job.status) && job.kind !== 'auto_prepare' && job.kind !== 'full_audio' ? <button className="quiet" onClick={() => run(async () => {
          const runId = job.parent_run_id ?? (['video_ocr_index', 'video_overview_index'].includes(job.kind) ? job.id : null);
          await (runId ? api('retry_video_discovery', { run_id: runId }) : api('resume_processing', { job_id: job.id }));
          await refresh();
        })}>{job.parent_run_id || ['video_ocr_index', 'video_overview_index'].includes(job.kind) ? 'Retry index from saved progress' : 'Recover saved job'}</button> : null}
      </div>
      <code>Receipt {job.id}</code>
    </article>) : currentJobs.length ? <div className="empty-state"><ListChecks size={32} /><h3>No {jobFilter === 'working' ? 'working jobs' : jobFilter === 'attention' ? 'jobs needing attention' : 'completed jobs'} in this page</h3><p>Choose another status or load older jobs.</p></div> : !reviewOpen ? <div className="empty-state"><ListChecks size={32} /><h3>{jobCursor!==null?'No jobs in this page':'No processing jobs yet'}</h3><p>Queued work, completed jobs, and failures will appear here with their receipts.</p></div> : null}
    {jobError?<p role="alert" className="small danger-text">Could not load older jobs: {jobError}</p>:null}
    {attentionCursor!==null?<button className="quiet" disabled={loadingJobs} onClick={()=>void loadOlderAttention()}>{loadingJobs?'Loading…':'Load more current problems'}</button>:null}
    {jobCursor!==null?<button className="quiet" disabled={loadingJobs} onClick={()=>void loadOlderJobs()}>{loadingJobs?'Loading…':'Load older jobs'}</button>:null}
    {supersededFailures.length ? <details className="job-card"><summary>Earlier failures and interruptions replaced by newer runs ({supersededFailures.length})</summary>{supersededFailures.map(job => <article key={job.id}><strong>{job.name}</strong><p className="small muted">{job.kind} · {job.error || job.status}</p><code>Receipt {job.id}</code></article>)}</details> : null}
    {snapshot.issues?.length ? <details className="job-card"><summary>Previous AI tool errors ({snapshot.issues.length} group{snapshot.issues.length === 1 ? '' : 's'})</summary>{snapshot.issues.map(issue => <IssueHistory issue={issue} key={issue.latest_receipt} />)}</details> : null}
    {storage ? <div className="job-card">
      <div className="job-card-head"><strong>Case storage</strong><Tooltip text="Only abandoned import copies matching a verified original are removed. Job folders are retained."><button className="quiet" onClick={() => run(async () => { const receipt = await api<{ reclaimed_bytes: number }>('reclaim_staging'); setReclaimed(receipt.reclaimed_bytes); setStorage(await api<Record<string, number>>('storage_usage')); })}>Reclaim verified staging duplicates</button></Tooltip></div>
      {Object.entries(storage).map(([name, bytes]) => <p className="small" key={name}>{name}: {formatBytes(bytes)}</p>)}
      {reclaimed !== null ? <p role="status" className="small success-text">Reclaimed {formatBytes(reclaimed)}</p> : null}
    </div> : null}
  </section>;
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
  const [layoutPreset, setLayoutPreset] = useState<'investigate' | 'review' | 'focus'>(() => {
    const saved = localStorage.getItem('vislex-layout');
    return saved === 'review' || saved === 'focus' ? saved : 'investigate';
  });
  useEffect(() => { localStorage.setItem('vislex-layout', layoutPreset); }, [layoutPreset]);
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
  const [olderTasks, setOlderTasks] = useState<Task[]>([]);
  const [olderCursor, setOlderCursor] = useState<{ created_at: string; id: string } | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [openTabs, setOpenTabs] = useState<NonNullable<Selection>[]>([]);
  const seenViewer = useRef<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string; root: string; chats?: { id: string; title: string }[] }[]>(() => { try { return JSON.parse(localStorage.getItem('vislex-projects') ?? '[]'); } catch { return []; } });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [extraSources, setExtraSources] = useState<Source[]>([]);
  const [extraRecords, setExtraRecords] = useState<RecordSummary[]>([]);
  const caseEpoch = useRef(0);
  const refreshSequence = useRef(0);
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => { setActivePane(selection ? 'source' : 'workspace'); }, [selection?.id, selection?.locator]);
  const [navigationHistory, setNavigationHistory] = useState<{ entries: NonNullable<Selection>[]; index: number }>({ entries: [], index: -1 });
  const movingInHistory = useRef(false);
  useEffect(() => {setExtraSources([]);setExtraRecords([]);},[snapshot?.id,snapshot?.generation,snapshot?.counts?.audit_seq]);
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
  const [production] = useState('Initial production');
  const [kind, setKind] = useState('note');
  const [dropping, setDropping] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const installSnapshot = useCallback((next: Snapshot | null) => { caseEpoch.current += 1; setSnapshot(next); }, []);
  const refresh = useCallback(async () => { const epoch = caseEpoch.current; const sequence = ++refreshSequence.current; const next = await api<Snapshot | null>('snapshot'); if (caseEpoch.current === epoch && refreshSequence.current === sequence) setSnapshot(next); }, []);
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
        installSnapshot(current ?? (native && last ? await api<Snapshot>('open_case', { path: last }) : null));
      })().catch(error => notify.error('Could not reopen the last case', `${String(error)}. Choose a project from the sidebar.`));
    }
    if (!native) return;
    const cleanup = listen('case-changed', () => { void refresh(); });
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

  // Global shortcuts: palette + workspace switching.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (modal || rename || settings) return;
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(value => !value); return; }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setPalette(false); openSettings(); return; }
      if (typing || !(event.ctrlKey || event.metaKey)) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < views.length) { event.preventDefault(); setView(views[index].id); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modal, rename, settings]);

  useEffect(() => {
    if (!snapshot) return;
    localStorage.setItem('vislex-last-case', snapshot.root);
    setProjects(previous => { const next = [{ id: snapshot.id, name: snapshot.name, root: snapshot.root }, ...previous.filter(project => project.id !== snapshot.id)]; localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; });
    const saved = localStorage.getItem(`vislex-conversation:${snapshot.id}`);
    setConversationId(saved ?? (snapshot.tasks[0]?.conversation_id ?? snapshot.tasks[0]?.id ?? null));
    setSelection(null); setOpenTabs([]); setNavigationHistory({ entries: [], index: -1 }); movingInHistory.current = false; setOlderTasks([]); setOlderCursor(undefined); seenViewer.current = snapshot.viewer_request?.id ?? null;
    setView('chat');
    setStorage(null);
    void api<Record<string, number>>('storage_usage').then(setStorage).catch(() => undefined);
  }, [snapshot?.id]);

  useEffect(() => { if (snapshot) setProjects(previous => { const next = previous.map(project => project.id === snapshot.id ? { ...project, name: snapshot.name } : project); localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; }); }, [snapshot?.name]);

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
  }, [snapshot?.id, refresh]);

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
  },[snapshot?.id,snapshot?.generation,snapshot?.counts?.audit_seq,selection,extraSources,extraRecords]);

  function moveInHistory(delta: number) {
    const index = navigationHistory.index + delta;
    const target = navigationHistory.entries[index];
    if (!target) return;
    movingInHistory.current = true;
    setNavigationHistory(previous => ({ ...previous, index }));
    setSelection(target);
  }

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
      const caseId = snapshot?.id;
      if (!caseId) return;
      const epoch = caseEpoch.current;
      const removed = olderTasks.filter(task => (task.conversation_id ?? task.id) === id);
      await api('delete_conversation', { case_id: caseId, conversation_id: id });
      if (caseEpoch.current === epoch) setOlderTasks(current => current.filter(task => (task.conversation_id ?? task.id) !== id));
      notify.success('Chat deleted', undefined, { label: 'Undo', run: () => { void api('delete_conversation', { case_id: caseId, conversation_id: id, deleted: false }).then(() => { if (caseEpoch.current === epoch) setOlderTasks(current => [...current, ...removed]); return refresh(); }); } });
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
  const chatIndex = JSON.stringify(conversations.slice(0,8).map(({ id, title }) => ({ id, title })));
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
  useEffect(() => {
    if (!snapshot) return;
    setProjects(previous => { const next = previous.map(project => project.id === snapshot.id ? { ...project, chats: JSON.parse(chatIndex) } : project); localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; });
  }, [snapshot?.id, chatIndex]);

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
      const receipt = await api<{ items: { status: string; detail: { error?: string } }[] }>('import_files', { paths: Array.isArray(paths) ? paths : [paths], production });
      await refresh();
      const failed = receipt.items.filter(item => item.status === 'failed');
      if (failed.length) throw new Error(`${failed.length} import(s) failed: ${failed.map(item => item.detail.error).join('; ')}`);
      notify.success('Import finished', 'Originals are preserved and hashed.');
    }
  }
  async function openCase() {
    if (!native) { installSnapshot(await api<Snapshot>('load_demo')); setSelection(null); return; }
    const path = await open({ directory: true, title: 'Open a VisLex case folder' });
    if (typeof path === 'string') { installSnapshot(await api<Snapshot>('open_case', { path })); setSelection(null); setView('chat'); }
  }
  function showModal(type: typeof modal) { modalReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setName(''); setPassword(''); setModal(type); }
  function openSettings() { settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSettings(true); }
  async function performModal() {
    if (modal === 'create') { const parent = await open({ directory: true, title: 'Choose a local parent folder' }); if (typeof parent !== 'string') return; const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, ''); if (!safeName) throw new Error('Enter a case name.'); const path = `${parent}\\${safeName}.ledcase`; installSnapshot(await api<Snapshot>('create_case', { path, name })); setSelection(null); notify.success('Case created', 'Drop files anywhere to import evidence.'); }
    if (modal === 'note') { const created = await api<WorkingRecord>('write_record', { title: name, kind, content: `# ${name}\n\n`, base_revision: 0, source_ids: source ? [source.id] : [], reason: 'Create working record' }); await refresh(); setSelection({ type: 'record', id: created.id }); }
    if (modal === 'backup') { const path = await save({ defaultPath: 'case-backup.tar.age', filters: [{ name: 'Encrypted backup', extensions: ['age'] }] }); if (!path) return; await api('backup', { path, password }); notify.success('Encrypted backup saved', path); }
    if (modal === 'delete') {
      if (!snapshot) throw new Error('Open a case first.');
      const receipt = await api<{ deleted: boolean; bytes: number }>('delete_case', { path: snapshot.root, confirm: name });
      setProjects(previous => { const next = previous.filter(project => project.id !== snapshot.id); localStorage.setItem('vislex-projects', JSON.stringify(next)); return next; });
      if (localStorage.getItem('vislex-last-case') === snapshot.root) localStorage.removeItem('vislex-last-case');
      localStorage.removeItem(`vislex-conversation:${snapshot.id}`);
      installSnapshot(null); setSelection(null); setOpenTabs([]);
      notify.success('Case deleted', `${formatBytes(receipt.bytes)} of case data removed from disk.`);
    }
    if (modal === 'restore') { const archive = await open({ filters: [{ name: 'Encrypted case', extensions: ['age'] }] }); if (typeof archive !== 'string') return; const parent = await open({ directory: true, title: 'Choose restoration parent folder' }); if (typeof parent !== 'string') return; const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, ''); if (!safeName) throw new Error('Enter a restored case folder name.'); installSnapshot(await api<Snapshot>('restore_case', { archive, path: `${parent}\\${safeName}.ledcase`, password })); setSelection(null); }
    setPassword(''); setModal(null);
  }

  /* ------------------------------ command palette ----------------------------- */
  const paletteCommands = useMemo(() => [
    { id: 'new-chat', label: 'New chat', run: () => { chooseConversation(null); setPalette(false); } },
    { id: 'view-evidence', label: 'Go to Evidence', run: () => { setView('evidence'); setPalette(false); } },
    { id: 'view-findings', label: 'Go to Findings', run: () => { setView('findings'); setPalette(false); } },
    { id: 'view-review', label: 'Go to Review workbench', run: () => { setView('review'); setPalette(false); } },
    { id: 'view-jobs', label: 'Go to Jobs & issues', run: () => { setView('jobs'); setPalette(false); } },
    { id: 'settings', label: 'Open settings', run: () => { setPalette(false); openSettings(); } },
    { id: 'transcribe-all', label: 'Queue missing full transcripts', run: () => { setPalette(false); run(async () => { await api('transcribe_all'); await refresh(); }); } },
    { id: 'add-files', label: 'Add files to this case', run: () => { setPalette(false); run(importFiles); } },
    { id: 'delete-case', label: 'Delete this case permanently', run: () => { setPalette(false); if (snapshot && native) showModal('delete'); else notify.info('Open a native case to delete it.'); } },
  ], [run, refresh, snapshot]);
  const paletteMatches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || !snapshot) return [];
    return snapshot.sources.filter(item => item.name.toLowerCase().includes(text)).slice(0, 6);
  }, [query, snapshot]);
  const paletteItems = useMemo(() => [
    ...paletteMatches.map(item => ({ kind: 'source' as const, id: item.id, label: item.name })),
    ...(results ?? []).map((item, index) => ({ kind: 'result' as const, id: `${item.source_id}:${index}`, label: item.name, excerpt: item.excerpt, sourceId: item.source_id, locator: item.locator })),
    ...paletteCommands.filter(command => (snapshot || command.id === 'settings') && (!query.trim() || command.label.toLowerCase().includes(query.trim().toLowerCase()))).map(command => ({ kind: 'command' as const, id: command.id, label: command.label, run: command.run })),
  ], [paletteMatches, results, paletteCommands, query, snapshot]);
  useEffect(() => { setPaletteIndex(0); }, [query, results]);
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
      run(async () => {
        const response = await api<{ results: SearchResult[]; remaining_passages: number }>('hybrid_search', { query });
        setResults(response.results);
        if (response.remaining_passages > 0) notify.info('Indexing in progress', `${response.remaining_passages} passages remain unindexed; current results cover indexed text only. Repeat semantic search to continue indexing.`);
      });
    }
  }

  const statusJob = pending[0];
  const totalBytes = snapshot?.counts?.source_bytes ?? snapshot?.sources.reduce((total, item) => total + item.size, 0) ?? 0;
  const totalStorage = storage ? Object.values(storage).reduce((total, bytes) => total + bytes, 0) : 0;

  return <ThemeProvider>
    <div className={`app-shell ${dropping ? 'dropping' : ''}`}>
      <header className="titlebar" data-tauri-drag-region onDoubleClick={() => { if (native) void getCurrentWindow().toggleMaximize(); }}>
        <div className="brand-mark" data-tauri-drag-region><span /><span /><span /></div>
        <strong data-tauri-drag-region>VisLex</strong>
        <span className="title-case" data-tauri-drag-region>{snapshot?.name ?? ''}</span>
        <div className="spacer" data-tauri-drag-region />
        {snapshot ? <select className="layout-picker" aria-label="Workspace layout" value={layoutPreset} onChange={event => {
          const next = event.target.value as typeof layoutPreset;
          setLayoutPreset(next);
          if (next === 'investigate') setView('chat');
          if (next === 'review') setView('review');
        }}><option value="investigate">Investigate</option><option value="review">Review</option><option value="focus">Focus</option></select> : null}
        {busy ? <Activity className="pulse" size={13} /> : null}
        <div className="window-controls">
          <button aria-label="Minimize window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().minimize(); }}><Minus size={15} /></button>
          <button aria-label="Maximize or restore window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().toggleMaximize(); }}><Maximize2 size={13} /></button>
          <button className="window-close" aria-label="Close window" onDoubleClick={event => event.stopPropagation()} onClick={() => { if (native) void getCurrentWindow().close(); }}><X size={16} /></button>
        </div>
      </header>

      <div className="workspace" data-active-pane={activePane} data-layout={layoutPreset}>
        <nav className="rail" aria-label="Workspaces">
          {views.map(item => <Tooltip key={item.id} text={item.label} shortcut={item.shortcut}>
            <button className={`rail-button ${view === item.id ? 'active' : ''} ${item.id === 'jobs' && needsAttention ? 'attention' : ''}`} aria-label={item.label} aria-current={view === item.id} onClick={() => setView(item.id)}><item.icon size={18} /></button>
          </Tooltip>)}
          <div className="spacer" />
          <Tooltip text={sidebarOpen ? 'Hide navigation' : 'Show navigation'}><button className="rail-button" aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button></Tooltip>
          <Tooltip text="Search case" shortcut="Ctrl+K"><button className="rail-button" aria-label="Search case" onClick={() => setPalette(true)}><Search size={17} /></button></Tooltip>
        </nav>

        <aside className="sidebar" hidden={!sidebarOpen} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
          <button className="matter-identity" disabled={!snapshot} title="Rename case (F2)" onClick={() => snapshot && beginRename('case', snapshot.id, snapshot.name)} onKeyDown={event => { if (event.key === 'F2' && snapshot) { event.preventDefault(); beginRename('case', snapshot.id, snapshot.name); } }}>
            <strong>{snapshot?.name ?? 'Open a case'}</strong>
            <small>{snapshot ? `${snapshot.counts?.source_count ?? snapshot.sources.length} sources · ${formatBytes(totalBytes)} · ${pendingCount ? `${pendingCount} jobs pending` : needsAttention ? 'Needs attention' : 'Unreviewed'}` : 'Local evidence workspace'}</small>
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
            {(conversations.length > 8 || olderCursor !== null && (olderCursor !== undefined || (snapshot?.tasks.length ?? 0) === 50)) ? <button className="more-chats" onClick={() => setAllChats(value => !value)}>{allChats ? 'Show less' : 'Show all chats'}</button> : null}
            {allChats && olderCursor !== null && (olderCursor !== undefined || (snapshot?.tasks.length ?? 0) === 50) ? <button className="more-chats" disabled={loadingOlder} onClick={loadOlderChats}>{loadingOlder ? 'Loading…' : 'Load older chats'}</button> : null}
          </div>
          <div className="tree-heading">PROJECTS</div>
          <div className="project-list">
            {snapshot ? <div className="project-folder active"><FolderOpen size={15} /><button title={snapshot.root} onClick={() => beginRename('case', snapshot.id, snapshot.name)}>{snapshot.name}</button></div> : null}
            {projects.filter(project => project.id !== snapshot?.id).map(project => <details key={project.id} className="project-group"><summary><FolderOpen size={15} /><span>{project.name}</span></summary>
              <button className="project-row" title={project.root} onClick={() => run(async () => { installSnapshot(await api<Snapshot>('open_case', { path: project.root })); setView('chat'); })}>Open project</button>
              {project.chats?.slice(0, 8).map(chat => <button className="project-chat" key={chat.id} onClick={() => run(async () => { const opened = await api<Snapshot>('open_case', { path: project.root }); localStorage.setItem(`vislex-conversation:${project.id}`, chat.id); installSnapshot(opened); setView('chat'); })}>{chat.title}</button>)}
            </details>)}
          </div>
          <div className="sidebar-footer">
            <div className="sidebar-command split">
              <button className="quiet" onClick={() => showModal('create')}><Plus size={14} />Create</button>
              <button className="quiet" onClick={() => run(openCase)}><FolderOpen size={14} />Open</button>
            </div>
            <div className="sidebar-command split">
              <Tooltip text="Settings" shortcut="Ctrl+,"><button className="quiet" onClick={openSettings}><Settings size={15} />Settings</button></Tooltip>
              <ThemeToggle />
              <details className="case-menu"><summary aria-label="Case options"><MoreHorizontal size={16} /></summary><div>
                <button onClick={() => run(importFiles)}>Add files</button>
                <FolderImport hasCase={!!snapshot} run={run} refresh={refresh} />
                <button disabled={!snapshot} onClick={() => showModal('note')}>New note</button>
                <button disabled={!snapshot} onClick={() => showModal('backup')}>Export case archive</button>
                <button onClick={() => showModal('restore')}>Restore case archive</button>
                <button className="danger" disabled={!snapshot || !native} title={native ? 'Erase this case folder permanently' : 'Deleting a case requires the desktop app'} onClick={() => showModal('delete')}>Delete case…</button>
              </div></details>
            </div>
          </div>
        </aside>
        {sidebarOpen ? <SidebarDivider width={sidebarWidth} onWidthChange={setSidebarWidth} /> : null}

        <div className="center-column">
          {!snapshot && view === 'chat' ? <OnboardingHero
            onCreate={() => showModal('create')}
            onOpen={() => run(openCase)}
            onRestore={() => showModal('restore')}
            onSample={() => run(async () => { installSnapshot(await api<Snapshot>('load_demo')); })}
          /> : null}
          {visibleSnapshot && view === 'chat' ? <AgentPanel conversationId={conversationId} onConversation={chooseConversation} snapshot={visibleSnapshot} selection={selection} refresh={refresh} run={run} onSource={selectSource} onSettings={openSettings} focusRequest={focusComposerRequest} /> : null}
          {!snapshot && view !== 'chat' ? <div className="empty-state workspace-view"><FolderOpen size={32} /><h3>Open a case first</h3><p>This workspace becomes available once a case is open.</p></div> : null}
          {snapshot && view === 'evidence' ? <EvidenceLibrary
            snapshot={snapshot}
            onOpen={id => selectSource(id)}
            onOpenRecord={id => setSelection({ type: 'record', id })}
            onSourceLoaded={items => setExtraSources(current => [...current,...items.filter(item=>!current.some(existing=>existing.id===item.id))])}
            onRecordLoaded={items => setExtraRecords(current => [...current,...items.filter(item=>!current.some(existing=>existing.id===item.id))])}
            onRename={(id, value) => beginRename('source', id, value)}
            onRestrict={(id, restricted) => run(async () => { await api('set_restricted', { source_id: id, restricted }); await refresh(); })}
          /> : null}
          {visibleSnapshot && view === 'findings' ? <Suspense fallback={<WorkspaceLoading label="Opening findings…" />}><EvidenceNotebook key={snapshot!.id} snapshot={visibleSnapshot} onClose={() => setView('chat')} onSource={selectSource} /></Suspense> : null}
          {visibleSnapshot && view === 'review' ? <Suspense fallback={<WorkspaceLoading label="Opening review…" />}><InvestigationWorkbench key={snapshot!.id} snapshot={visibleSnapshot} onClose={() => setView('chat')} onSource={selectSource} onConversation={chooseConversation} /></Suspense> : null}
          {snapshot && view === 'jobs' ? <JobsCenter snapshot={snapshot} run={run} refresh={refresh} onConversation={id => { setConversationId(id); setView('chat'); }} /> : null}
        </div>

        {selection ? <PaneDivider viewerWidth={viewerWidth} onWidthChange={setViewerWidth} /> : null}
        <main className="main-panel" hidden={!selection} style={{ width: viewerWidth }}>
          <div className="tab-strip" role="tablist" aria-label="Open files">
            <button className="icon-button pane-return" aria-label="Return to workspace" onClick={() => setActivePane('workspace')}>← <span>Workspace</span></button>
            <button className="icon-button" aria-label="Previous location" disabled={navigationHistory.index <= 0} onClick={() => moveInHistory(-1)}>←</button>
            <button className="icon-button" aria-label="Next location" disabled={navigationHistory.index >= navigationHistory.entries.length - 1} onClick={() => moveInHistory(1)}>→</button>
            {openTabs.map(tab => {
              const tabTitle = tab.type === 'source' ? visibleSnapshot?.sources.find(item => item.id === tab.id)?.name : visibleSnapshot?.records.find(item => item.id === tab.id)?.title;
              return <ContextMenu key={tab.id} items={[
                { label: 'Close', onSelect: () => closeTab(tab.id) },
                { label: 'Close others', onSelect: () => { setOpenTabs([tab]); if (!(selection?.id === tab.id)) setSelection(tab); } },
                { label: 'Close tabs to the right', onSelect: () => setOpenTabs(tabs => tabs.slice(0, tabs.findIndex(item => item.id === tab.id) + 1)) },
              ]}>
                <div className={`file-tab ${selection?.id === tab.id ? 'active' : ''}`}>
                  <button role="tab" aria-selected={selection?.id === tab.id} title={tabTitle} onClick={() => setSelection(tab)} onAuxClick={event => { if (event.button === 1) closeTab(tab.id); }}>
                    {tab.type === 'source' ? <SourceIcon kind={visibleSnapshot?.sources.find(item => item.id === tab.id)?.kind ?? 'other'} /> : null}
                    <span>{tabTitle}</span>
                  </button>
                  <button className="icon-button" aria-label={`Close ${tabTitle}`} onClick={() => closeTab(tab.id)}><X size={12} /></button>
                </div>
              </ContextMenu>;
            })}
          </div>
          {source ? <EvidenceViewer key={source.id} caseId={snapshot?.id} locator={selection?.locator} source={source} run={run} refresh={refresh} onLocatorSelect={locator => setSelection(current => current ? { ...current, locator } : current)} onAsk={() => { setView('chat'); setFocusComposerRequest(value => value + 1); }} /> : null}
          {record && snapshot ? <RecordDetailPanel key={`${snapshot.id}:${record.id}`} caseId={snapshot.id} summary={record} run={run} refresh={refresh} onSource={selectSource}/> : null}
        </main>
      </div>

      {snapshot ? <footer className="statusbar">
        <span className="status-jobs" role="status">
          {statusJob ? <><Activity size={12} className="pulse" />{statusJob.name} · {statusJob.kind.replaceAll('_', ' ')}</> : null}
          {pendingCount > 1 ? <span className="small muted">+{pendingCount - 1} more</span> : null}
        </span>
        {needsAttention ? <button className="status-attention" onClick={() => setView('jobs')}><StatusPill state="needs-attention" label={`${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`} small /></button> : null}
        <div className="spacer" />
        {(snapshot.counts?.record_count ?? snapshot.records.length) || totalStorage ? <span className="small muted">{(snapshot.counts?.record_count ?? snapshot.records.length) === 1 ? '1 working file' : `${snapshot.counts?.record_count ?? snapshot.records.length} working files`}{totalStorage ? ` · ${formatBytes(totalStorage)} on disk` : ''}</span> : null}
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
          <input autoFocus role="combobox" aria-autocomplete="list" aria-controls="case-command-results" aria-expanded={paletteItems.length > 0} aria-activedescendant={paletteItems[paletteIndex] ? `case-command-item-${paletteIndex}` : undefined} aria-label={snapshot ? 'Search case — evidence, meaning, chats and commands' : 'Search commands'} value={query} onChange={event => { setQuery(event.target.value); setResults(null); }} onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex(index => Math.min(index + 1, paletteItems.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex(index => Math.max(0, index - 1)); }
            else if (event.key === 'Enter') { event.preventDefault(); paletteEnter(); }
          }} placeholder="Search evidence, meaning, chats and commands…" />
          {query.trim() && snapshot ? <span className="small muted">{results === null ? 'Enter to search' : `${results.length} results`}</span> : null}
        </div>
        <div className="palette-results">
          {query.trim() && snapshot && results === null ? <button className="tree-item palette-search-action" onClick={searchPalette}><Search size={14} /><span>Search text &amp; meaning for “{query.trim()}”<small>Hybrid search across indexed evidence</small></span></button> : null}
          <div id="case-command-results" role="listbox" aria-label="Search results and commands">
          {paletteItems.map((item, index) => <button
            className={`tree-item palette-item ${index === paletteIndex ? 'selected' : ''}`}
            id={`case-command-item-${index}`}
            role="option"
            aria-selected={index === paletteIndex}
            key={`${item.kind}:${item.id}`}
            onMouseEnter={() => setPaletteIndex(index)}
            onClick={() => { setPaletteIndex(index); activatePaletteItem(item); }}>
            {item.kind === 'source' ? <SourceIcon kind={snapshot?.sources.find(sourceItem => sourceItem.id === item.id)?.kind ?? 'other'} size={15} /> : item.kind === 'result' ? <Search size={15} /> : null}
            <span>{item.label}{'excerpt' in item && item.excerpt ? <small>{item.excerpt}</small> : item.kind === 'command' ? <small>Command</small> : null}</span>
          </button>)}
          </div>
          {results?.length === 0 ? <p className="sidebar-empty">No indexed text matches. Unprocessed evidence is not searchable.</p> : null}
          {!snapshot ? <p className="sidebar-empty">Open a case to search its evidence.</p> : null}
        </div>
        <div className="palette-footer"><span>↑↓ navigate</span><span>↵ open</span><span>Esc close</span></div>
      </dialog>

      {settings && snapshot ? <Suspense fallback={<WorkspaceLoading label="Opening settings…" settings />}><SettingsDialog snapshot={snapshot} onClose={() => setSettings(false)} refresh={refresh} run={run} /></Suspense> : null}
      {settings && !snapshot ? <WorkspacePreferences onClose={() => setSettings(false)} /> : null}

      {modal ? <dialog ref={dialog} className="modal" onCancel={() => { setModal(null); setPassword(''); }}>
        <div className="modal-heading"><h2>{modal === 'create' ? 'Create a local case' : modal === 'note' ? 'New working file' : modal === 'backup' ? 'Encrypted case backup' : modal === 'delete' ? 'Delete this case permanently' : 'Restore a case'}</h2><button className="icon-button" aria-label="Close dialog" onClick={() => { setModal(null); setPassword(''); }}><X size={20} /></button></div>
        {modal !== 'backup' ? <label className="field-label">{modal === 'note' ? 'Title' : modal === 'delete' ? 'Type the case name to confirm' : 'Case name'}<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder={modal === 'note' ? 'Review notes' : modal === 'delete' ? snapshot?.name ?? '' : 'Matter name or reference'} /></label> : null}
        {modal === 'delete' && snapshot ? <p className="small danger-text">“{snapshot.name}” and its entire folder are erased: originals, working files, chats, review decisions and any case archives stored in {snapshot.root}. This cannot be undone. Export an encrypted backup first if you may need this evidence again.</p> : null}
        {modal === 'note' ? <label className="field-label">Record type<select value={kind} onChange={event => setKind(event.target.value)}>{['note', 'report', 'claim', 'event', 'person', 'issue', 'transcript', 'clock', 'script'].map(option => <option key={option}>{option}</option>)}</select></label> : null}
        {modal === 'backup' || modal === 'restore' ? <>
          <label className="field-label">Backup passphrase<input type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters for a new backup" /></label>
          <p className="small muted">Keep this passphrase separately. There is no password recovery. Backups include originals, notes, historical revisions, and restricted material.</p>
        </> : null}
        {modal === 'create' ? <p className="small muted">Choose a local folder on the next step. The case starts offline. Do not use a shared or cloud-synchronized working directory.</p> : null}
        <div className="modal-footer"><button className="secondary" onClick={() => setModal(null)}>Cancel</button><button className={`primary ${modal === 'delete' ? 'danger-action' : ''}`} disabled={busy || (modal !== 'backup' && !name.trim()) || ((modal === 'backup' || modal === 'restore') && !password) || (modal === 'delete' && name.trim().toLowerCase() !== (snapshot?.name ?? '').trim().toLowerCase())} onClick={() => run(performModal)}>{busy ? 'Working…' : modal === 'note' ? 'Create file' : modal === 'delete' ? 'Delete case' : 'Continue'}{modal === 'delete' ? null : <ArrowRight size={14} />}</button></div>
      </dialog> : null}

      <ToastStack />
    </div>
  </ThemeProvider>;
}
