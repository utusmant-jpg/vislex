import { useEffect, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, Clapperboard, FileSearch, GitCompareArrows, History, Landmark, Minus, Pause, Play, Plus, Radar, Scale, SkipBack, SkipForward, TriangleAlert } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { api, citationParts, evidenceUrl } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { springs } from '../lib/motion';
import { incidentToSource, type ClockMapping } from '../review';
import type { Snapshot } from '../types';
import { CitationChip, Skeleton, StatusPill } from '../ui';
import ModelSelect from './ModelSelect';
import QuestionDossier from './QuestionDossier';
import { usePagedSources } from '../usePagedSources';

type Claim = {proposition:string;assessment:string;supporting:string[];contrary:string[];uncertainty:string;next_check:string};
type Investigation = {task_id:string;question:string;status:string;view:{stale:boolean;completion_stale:boolean;dossier:{revision:number;claims:Claim[]}};previous:{claims:Claim[]}|null;hypotheses:{alternatives:{explanation:string;unresolved_premise:string;prediction:string;discriminating_check:string;citations:string[]}[]}|null};
type Desk = {investigations:Investigation[];affected_objects:{id:string;title:string;kind:string;revision:number}[];next_offset:number|null};
type Coverage = {sources:{source_id:string;name:string;status:string;extracted_lines:number;rendered_pages:number[];sampled_frame_count:number;sampled_seconds:number[];inspection_receipts:number;failed_jobs:number;next_check:string}[];next_offset:number|null;note:string};
type Clock = {id:string;title:string;revision:number;review:string;stale:boolean};
type Replay = {recordings:{source_id:string;name:string;clock_id:string;clock_revision:number;fit:ClockMapping;artifact?:string}[];incident_range:[number,number];note:string};
const reviewTabs = ['Discrepancies','What changed?','Incident replay','Coverage','Legal workflows'] as const;
const tabIcons = { 'Discrepancies': Scale, 'What changed?': History, 'Incident replay': Clapperboard, 'Coverage': Radar, 'Legal workflows': Landmark } as const;
/** Snake-case identifiers as sentence-case labels ("issue_matrix" → "Issue matrix"). */
const humanize = (value: string) => { const text = value.replaceAll('_', ' '); return text.charAt(0).toUpperCase() + text.slice(1); };

/** Investigation status as icon + label. Stale evidence outranks run status. */
export function investigationPill(item: Pick<Investigation,'status'|'view'>) {
  if (item.view.stale) return <StatusPill state="stale" label="Evidence changed · recheck required" small />;
  if (item.status === 'complete') return <StatusPill state="complete" label="Complete" small />;
  if (item.status === 'running') return <StatusPill state="running" label="Running" small />;
  if (['failed','interrupted'].includes(item.status)) return <StatusPill state={item.status as 'failed'|'interrupted'} label={humanize(item.status)} small />;
  if (['stopped','cancelled','paused'].includes(item.status)) return <StatusPill state={item.status as 'stopped'|'cancelled'|'paused'} label={humanize(item.status)} small />;
  return <StatusPill state="unreviewed" label={humanize(item.status)} small />;
}

export default function InvestigationWorkbench({snapshot,onClose,onSource,onConversation}:{snapshot:Snapshot;onClose:()=>void;onSource:(id:string,locator?:string)=>void;onConversation:(id:string)=>void}) {
  const sourcePages=usePagedSources(snapshot);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const players=useRef<(HTMLVideoElement|null)[]>([]);
  const [coverage,setCoverage]=useState<Coverage|null>(null);const [coverageOffset,setCoverageOffset]=useState(0);
  useEffect(()=>{let active=true;void api<Coverage>('coverage_map',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),offset:coverageOffset}).then(v=>{if(active)setCoverage(v);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[snapshot.id,snapshot.session_epoch,snapshot.generation,coverageOffset]);
  const [workflow,setWorkflow]=useState('issue_matrix');const [jurisdiction,setJurisdiction]=useState('');const [relevantDate,setRelevantDate]=useState('');const [instructions,setInstructions]=useState('');const [authorityUrl,setAuthorityUrl]=useState('');const [authorityTitle,setAuthorityTitle]=useState('');
  const [desk,setDesk]=useState<Desk|null>(null);const [offset,setOffset]=useState(0);const [revision,setRevision]=useState(0);
  const [tab,setTab]=useState('Discrepancies');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const [source,setSource]=useState('');const [clocks,setClocks]=useState<Clock[]>([]);const [selected,setSelected]=useState<string[]>([]);
  const reducedMotion = useReducedMotion();
  const eligibleSources = sourcePages.sources.filter(s=>!s.restricted&&['text','pdf','other'].includes(s.kind));
  const [replay,setReplay]=useState<Replay|null>(null);const [incident,setIncident]=useState(0);const [playing,setPlaying]=useState(false);const [loop,setLoop]=useState(false);
  const evidenceVersion=`${snapshot.session_epoch ?? 'preview'}:${snapshot.generation}:${snapshot.counts?.audit_seq ?? snapshot.sources.filter(s=>s.restricted).map(s=>s.id).join(',')}`;
  useEffect(()=>{players.current.forEach(p=>p?.pause());return()=>{players.current.forEach(p=>p?.pause());};},[]);
  useEffect(()=>{let active=true;setDesk(null);setError('');void Promise.all([api<Desk>('investigation_workbench',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),offset}),api<{objects:Clock[]}>('evidence_list',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),kind:'clock',offset:0})]).then(([d,c])=>{if(active){setDesk(d);setClocks(c.objects);}}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[snapshot.id,evidenceVersion,offset,revision]);
  useEffect(()=>{players.current.forEach(p=>p?.pause());setPlaying(false);setReplay(null);},[evidenceVersion]);
  async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function investigate(prompt:string){const result=await api<{conversation_id:string}>('start_task',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),prompt});if(mounted.current){onConversation(result.conversation_id);onClose();}}
  function links(values:string[]){return values.map(value=>{const c=citationParts(value);return c?<CitationChip key={value} value={value} onOpen={(id,locator)=>{onSource(id,locator);onClose();}}/>:null;});}
  function seek(time:number){if(!replay)return;setIncident(time);replay.recordings.forEach((r,i)=>{const position=incidentToSource(time,r.fit);const p=players.current[i];if(p&&position)p.currentTime=position.seconds;});}
  function pause(){players.current.forEach(p=>p?.pause());setPlaying(false);}
  async function play(){if(!replay)return;const current=await api<Replay>('incident_replay',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),clock_ids:replay.recordings.map(r=>r.clock_id)});if(current.recordings.some((r,i)=>r.clock_revision!==replay.recordings[i].clock_revision)){pause();setReplay(null);throw new Error('Clock mapping changed. Prepare replay again.');}seek(incident>=replay.incident_range[1]?replay.incident_range[0]:incident);try{await Promise.all(players.current.map((p,i)=>{if(!p)throw new Error('Wait for both recordings to load');p.playbackRate=1/replay.recordings[i].fit.scale;return p.play();}));setPlaying(true);}catch(e){pause();throw e;}}
  function tick(index:number){if(!replay||index!==0||!playing)return;const leader=players.current[0];if(!leader)return;const time=leader.currentTime*replay.recordings[0].fit.scale+replay.recordings[0].fit.offset_seconds;if(time>=replay.incident_range[1]){if(loop)seek(replay.incident_range[0]);else {pause();seek(replay.incident_range[1]);}return;}setIncident(time);replay.recordings.forEach((r,i)=>{if(i===0)return;const position=incidentToSource(time,r.fit);const p=players.current[i];if(p&&position&&Math.abs(p.currentTime-position.seconds)>.15)p.currentTime=position.seconds;});}
  useEffect(()=>{if(!playing)return;let frame=0;const advance=()=>{tick(0);frame=requestAnimationFrame(advance);};frame=requestAnimationFrame(advance);return()=>cancelAnimationFrame(frame);},[playing,replay,loop]);
  async function prepareReplay(){pause();setReplay(null);const proposal=await api<Replay>('incident_replay',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),clock_ids:selected});for(const recording of proposal.recordings){const result=await api<{artifact_id:string}>('playback_proxy',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),source_id:recording.source_id});const info=await api<{metadata:{source_origin_seconds?:number;player_origin_seconds?:number}}>('artifact_info',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),artifact_id:result.artifact_id});if(typeof info.metadata.source_origin_seconds!=='number'||info.metadata.player_origin_seconds!==0)throw new Error('This playback derivative predates clock metadata. Create a new derivative before synchronizing.');recording.artifact=result.artifact_id;}setReplay(proposal);setIncident(proposal.incident_range[0]);}
  const loadingDesk = !desk && !error;
  const deskSkeleton = <div className="workbench-loading" aria-busy="true" aria-label="Loading question dossiers">{[0,1].map(i=><div className="card workbench-skeleton" key={i}><Skeleton height={14} className="skeleton-title" /><Skeleton height={10} /><Skeleton height={10} className="skeleton-short" /></div>)}</div>;
  const questionPager = ['Discrepancies','What changed?'].includes(tab) && (offset > 0 || desk?.next_offset) ? <nav className="workbench-pager" aria-label="Question pages"><button className="secondary" data-size="sm" disabled={offset===0} onClick={()=>setOffset(v=>Math.max(0,v-30))}>Previous questions</button><button className="secondary" data-size="sm" disabled={!desk?.next_offset} onClick={()=>setOffset(desk?.next_offset??0)}>Next questions</button></nav> : null;
  return <section className="workspace-view investigation-workbench" aria-label="Investigation workbench">
    <header className="surface-header">
      <div className="surface-header-text">
        <div className="eyebrow">Investigate</div>
        <h2>Investigation workbench</h2>
        <p>Compare accounts with case evidence, follow what changed, and check coverage. AI assessments stay unreviewed until you record a decision.</p>
      </div>
      <div className="surface-actions"><button className="quiet" onClick={onClose}><ArrowLeft size={15} />Back to chat</button></div>
    </header>
    <div className="tabs workbench-tabs" role="tablist" aria-label="Investigation views" onKeyDown={event=>{const index=reviewTabs.indexOf(tab as typeof reviewTabs[number]);const next=event.key==='ArrowRight'?(index+1)%reviewTabs.length:event.key==='ArrowLeft'?(index+reviewTabs.length-1)%reviewTabs.length:event.key==='Home'?0:event.key==='End'?reviewTabs.length-1:-1;if(next<0)return;event.preventDefault();pause();setTab(reviewTabs[next]);(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus();}}>{reviewTabs.map((t,i)=>{const Icon=tabIcons[t];return <button type="button" role="tab" id={`review-tab-${i}`} aria-controls="review-tab-panel" aria-selected={tab===t} tabIndex={tab===t?0:-1} className={tab===t?'selected':''} key={t} onClick={()=>{pause();setTab(t);}}><Icon size={15} aria-hidden="true" /><span className="workbench-tab-label">{t}</span>{tab===t?<motion.span layoutId="workbench-tab-underline" className="workbench-tab-underline" transition={reducedMotion?{duration:0}:springs.snappy} aria-hidden="true"/>:null}</button>;})}</div>
    {error?<p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" /><span>{error}</span></p>:null}
    {sourcePages.error?<p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" /><span>Could not load sources: {sourcePages.error}</span></p>:null}
    <div role="tabpanel" id="review-tab-panel" aria-labelledby={`review-tab-${reviewTabs.indexOf(tab as typeof reviewTabs[number])}`} className="workbench-panel" tabIndex={0}>
    {tab==='Discrepancies'?<>
      <section className="card workbench-start" aria-labelledby="compare-title">
        <div className="card-header"><span className="icon-tile" aria-hidden="true"><GitCompareArrows size={16} /></span><div className="workbench-start-text"><h3 className="card-title" id="compare-title">Compare an account with the evidence</h3><p>Choose a report or statement. VisLex opens a chat that decomposes its assertions into a question dossier with supporting and contrary citations.</p></div></div>
        <div className="workbench-start-row"><label className="workbench-picker"><span>Account to compare</span><ModelSelect label="Account to compare" noun="sources" value={source} onChange={setSource} placeholder="Choose report or statement" options={eligibleSources.map(s=>({id:s.id,name:s.name}))}/></label><button className="primary" disabled={busy||!source} onClick={()=>void action(()=>investigate(`Compare source ${source} with the permitted case evidence. Read its original wording and decompose material assertions into a question dossier. Declare exact coverage, inspect originals, and match persons, events and clock domains before alleging inconsistency. Save each assertion with supporting and contrary citations, uncertainty and next check. Distinguish omissions, changed accounts, extraction errors and timing uncertainty. Test plausible competing explanations with save_hypotheses. Return a qualified comparison without claiming exhaustive perception from sampled frames.`))}>Compare with evidence</button></div>
        {sourcePages.hasMore?<p className="workbench-sources-more"><span className="field-hint">{eligibleSources.length} eligible sources loaded.</span><button className="quiet" disabled={sourcePages.loading} onClick={()=>void sourcePages.loadMore()}>{sourcePages.loading?'Loading…':'Load more sources'}</button></p>:null}
      </section>
      {loadingDesk?deskSkeleton:null}
      {desk?.investigations.length?<h3 className="section-title">Question dossiers <span className="count">{desk.investigations.length}</span></h3>:null}
      {desk?.investigations.map(item=><section key={item.task_id} className="card workbench-investigation" aria-labelledby={`question-${item.task_id}`}>
        <div className="workbench-question"><h3 id={`question-${item.task_id}`}>{item.question}</h3>{investigationPill(item)}</div>
        <p className="workbench-question-meta">Dossier revision {item.view.dossier.revision} · {item.view.dossier.claims.length} assertion{item.view.dossier.claims.length===1?'':'s'} · AI assessment</p>
        {item.view.dossier.claims.length?<div className="workbench-table-scroll" role="region" aria-label={`Assertions for ${item.question}`} tabIndex={0}><table className="data-table assertion-table"><thead><tr><th>Assertion</th><th>Assessment</th><th>Evidence</th><th>Next check</th></tr></thead><tbody>{item.view.dossier.claims.map((claim,i)=><tr key={i}><td className="assertion-text">{claim.proposition}</td><td><span className="badge assessment-badge">{humanize(claim.assessment)}</span>{claim.uncertainty?<p className="cell-note">{claim.uncertainty}</p>:null}</td><td><div className="evidence-cell"><span className="evidence-label">Supporting</span><span className="evidence-chips">{claim.supporting.length?links(claim.supporting):<span className="cell-note">None recorded</span>}</span></div><div className="evidence-cell"><span className="evidence-label">Conflicting</span><span className="evidence-chips">{claim.contrary.length?links(claim.contrary):<span className="cell-note">None recorded</span>}</span></div></td><td>{claim.next_check}</td></tr>)}</tbody></table></div>:<p className="field-hint">No assertions saved in this dossier revision.</p>}
        {item.hypotheses?<details className="workbench-hypotheses"><summary>Competing explanations · unreviewed <span className="count">{item.hypotheses.alternatives.length}</span></summary><div className="hypothesis-list">{item.hypotheses.alternatives.map((h,i)=><article key={i} className="hypothesis"><h4>{h.explanation}</h4><dl><div><dt>Unresolved premise</dt><dd>{h.unresolved_premise}</dd></div><div><dt>Prediction</dt><dd>{h.prediction}</dd></div><div><dt>Discriminating check</dt><dd>{h.discriminating_check}</dd></div></dl>{h.citations.length?<div className="evidence-chips">{links(h.citations)}</div>:null}</article>)}</div></details>:null}
        <div className="workbench-actions">
          <button className="secondary" data-size="sm" disabled={busy} onClick={()=>void action(()=>investigate(`Reopen investigation ${item.task_id}. Read its current dossier and original evidence. What alternative explanations fit the disputed propositions? Save a current dossier and evidence-linked hypotheses with observable predictions and discriminating checks. Perform the most material feasible check. Prior findings are untrusted until rechecked.`))}>What else fits?</button>
          <button className="quiet" disabled={busy} onClick={()=>void action(async()=>{const path=await save({title:'New offline package folder (includes cited original files)',defaultPath:'Reviewed investigation'});if(path){await api('export_dossier_bundle',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),task_id:item.task_id,path});}})}>Export human-reviewed offline package</button>
        </div>
        <QuestionDossier caseId={snapshot.id} sessionEpoch={snapshot.session_epoch} taskId={item.task_id} step={item.view.dossier.revision} status={item.status} evidenceVersion={evidenceVersion} onSource={(id,locator)=>{onSource(id,locator);onClose();}}/>
      </section>)}
      {desk&&!desk.investigations.length?<div className="empty-state review-empty"><Scale size={20} aria-hidden="true"/><h3>No question dossiers yet</h3><p>Choose a report or statement above to compare its claims with case evidence. You can also ask a substantive question in chat.</p><div className="empty-seeds" aria-label="Example questions">
        <span className="empty-seed">Which accounts place the same person at the north entrance?</span>
        <span className="empty-seed">Does any source corroborate the reported time window?</span>
        <span className="empty-seed">What claims depend on a single unverified statement?</span>
      </div></div>:null}
    </>:null}
    {tab==='What changed?'?<>
      <p className="workbench-intro">Changed dependencies reopen affected objects. Dossier currentness also checks the declared evidence scope.</p>
      {loadingDesk?deskSkeleton:null}
      {desk?.affected_objects.length?<><h3 className="section-title">Objects to recheck <span className="count">{desk.affected_objects.length}</span></h3><div className="list affected-list">{desk.affected_objects.map(o=><div key={o.id} className="list-row change-affected"><span className="list-row-icon"><History size={16} aria-hidden="true" /></span><span className="list-row-main"><span className="list-row-title" title={o.title}>{o.title}</span><span className="list-row-subtitle">{humanize(o.kind)} · revision {o.revision} needs rechecking</span></span><span className="list-row-meta"><StatusPill state="stale" label="Needs recheck" small /></span></div>)}</div></>:null}
      {desk?.investigations.length?<h3 className="section-title">Question dossiers <span className="count">{desk.investigations.length}</span></h3>:null}
      {desk?.investigations.map(item=>{const added=item.previous?item.view.dossier.claims.filter(c=>!item.previous!.claims.some(p=>JSON.stringify(p)===JSON.stringify(c))):[];const removed=item.previous?item.previous.claims.filter(c=>!item.view.dossier.claims.some(p=>p.proposition===c.proposition)):[];return <section key={item.task_id} className="card workbench-change" aria-labelledby={`changed-${item.task_id}`}>
        <div className="workbench-question"><h3 id={`changed-${item.task_id}`}>{item.question}</h3>{item.view.stale||item.view.completion_stale?<StatusPill state="stale" label="Evidence or completion dependencies changed" small />:<StatusPill state="complete" label="Current within saved scope" small />}</div>
        {item.previous?(added.length||removed.length?<ul className="change-list">{added.map((c,i)=><li key={i} className="change-added"><Plus size={14} aria-hidden="true" /><span><span className="change-kind">New or revised:</span> {c.proposition}</span></li>)}{removed.map((c,i)=><li key={`removed-${i}`} className="change-removed"><Minus size={14} aria-hidden="true" /><span><span className="change-kind">Removed or reformulated:</span> {c.proposition}</span></li>)}</ul>:<p className="field-hint">No assertion changed since the previous saved claim set.</p>):<p className="field-hint">First saved claim set.</p>}
        <div className="workbench-actions"><button className="secondary" data-size="sm" disabled={busy} onClick={()=>void action(()=>investigate(`Reinvestigate question from task ${item.task_id}: ${item.question}. Inspect the saved dossier, determine which evidence dependencies changed, preserve findings whose support remains valid, and recheck affected claims and draft paragraphs. Save a new dossier with a clear change account and unresolved gaps.`))}>Recheck affected findings</button></div>
      </section>;})}
      {desk&&!desk.investigations.length&&!desk.affected_objects.length?<div className="empty-state review-empty"><History size={20} aria-hidden="true"/><h3>Nothing to recheck</h3><p>No saved dossier or finding depends on changed evidence. Revisions are compared here once question dossiers exist.</p></div>:null}
    </>:null}
    {tab==='Coverage'?<>
      {coverage?.note?<p className="workbench-intro">{coverage.note}</p>:null}
      {!coverage&&!error?<div className="workbench-loading" aria-busy="true" aria-label="Loading coverage"><Skeleton height={48} /><Skeleton height={48} /></div>:null}
      {coverage&&!coverage.sources.length?<div className="empty-state review-empty"><Radar size={20} aria-hidden="true"/><h3>No coverage recorded</h3><p>Coverage appears once sources are processed or inspected. It lists what was recorded, not what is absent.</p></div>:null}
      {coverage?.sources.length?<div className="coverage-list">{coverage.sources.map(s=><section key={s.source_id} className="card coverage-card" aria-labelledby={`coverage-${s.source_id}`}>
        <div className="card-header"><span className="icon-tile" aria-hidden="true"><FileSearch size={16} /></span><div className="coverage-title"><h3 className="card-title" id={`coverage-${s.source_id}`} title={s.name}>{s.name}</h3><span className="coverage-status">{s.status}</span></div><div className="card-actions"><button className="secondary evidence-link" data-size="sm" onClick={()=>{onSource(s.source_id);onClose();}}>Inspect source</button></div></div>
        <dl className="coverage-stats">
          <div className="stat"><dt className="stat-label">Extracted lines</dt><dd className="stat-value">{s.extracted_lines.toLocaleString()}</dd></div>
          <div className="stat"><dt className="stat-label">Rendered pages</dt><dd className="stat-value">{s.rendered_pages.length.toLocaleString()}</dd></div>
          <div className="stat"><dt className="stat-label">Sampled frames</dt><dd className="stat-value">{s.sampled_frame_count.toLocaleString()}</dd></div>
          <div className="stat"><dt className="stat-label">Inspection receipts</dt><dd className="stat-value">{s.inspection_receipts.toLocaleString()}</dd></div>
          <div className="stat"><dt className="stat-label">Failed/interrupted jobs</dt><dd className={`stat-value ${s.failed_jobs?'danger-text':''}`}>{s.failed_jobs.toLocaleString()}</dd></div>
        </dl>
        <p className="coverage-next"><span className="evidence-label">Next useful check</span> {s.next_check}</p>
        {s.sampled_seconds.length?<details className="coverage-seconds"><summary>Sampled source seconds (first 200)</summary><p className="mono">{s.sampled_seconds.map(t=>t.toFixed(3)).join(', ')}</p></details>:null}
      </section>)}</div>:null}
      {coverageOffset||coverage?.next_offset?<nav className="workbench-pager" aria-label="Coverage pages"><button className="secondary" data-size="sm" disabled={!coverageOffset} onClick={()=>setCoverageOffset(v=>Math.max(0,v-50))}>Previous sources</button><button className="secondary" data-size="sm" disabled={!coverage?.next_offset} onClick={()=>setCoverageOffset(coverage?.next_offset??0)}>Next sources</button></nav>:null}
    </>:null}
    {tab==='Legal workflows'?<>
      <section className="card legal-context" aria-labelledby="legal-context-title">
        <h3 className="card-title" id="legal-context-title">Matter context</h3>
        <p className="field-hint">Used by both the workflow and authority retrieval below.</p>
        <div className="form-grid"><label>Jurisdiction<input value={jurisdiction} onChange={e=>setJurisdiction(e.target.value)} placeholder="Court, state and governing law"/></label><label>Legally relevant date<input type="date" value={relevantDate} onChange={e=>setRelevantDate(e.target.value)}/></label></div>
      </section>
      <div className="legal-grid">
        <section className="card legal-card" aria-labelledby="legal-workflow-title">
          <h3 className="card-title" id="legal-workflow-title">Build a source-linked work product</h3>
          <label className="field-label">Workflow<ModelSelect label="Workflow" noun="workflows" hideIds value={workflow} onChange={setWorkflow} options={['issue_matrix','discovery','contract_review','deposition','draft','exhibit_list'].map(w=>({id:w,name:humanize(w)}))}/></label>
          <label className="field-label">Questions, documents and drafting instructions<textarea value={instructions} onChange={e=>setInstructions(e.target.value)} rows={5}/></label>
          <div className="legal-footer">{!jurisdiction.trim()||!relevantDate?<span className="field-hint">Add the jurisdiction and date above.</span>:null}<button className="primary" disabled={busy||!instructions.trim()||!jurisdiction.trim()||!relevantDate} onClick={()=>void action(()=>investigate(`Prepare a ${workflow} using save_work_product. Jurisdiction: ${jurisdiction}. Legally relevant date: ${relevantDate}. Instructions: ${instructions}. Inspect permitted originals; link each factual row to exact citations and legal propositions to retrieved authority object IDs. Distinguish original wording from proposed wording. Preserve contrary facts, unknown dates and missing productions. Treat authorities as unchecked until their text, date and treatment have been examined. Do not invent authorities or imply current-validity checking. Save reusable structured work and a readable versioned working report.`))}>Start workflow</button></div>
        </section>
        <section className="card legal-card" aria-labelledby="legal-authority-title">
          <h3 className="card-title" id="legal-authority-title">Retrieve a public authority</h3>
          <p className="field-hint">Retrieve a canonical HTTPS document from CourtListener, GovInfo, the Supreme Court, U.S. Code, U.S. Courts or eCFR. Only the entered URL is requested; no case text is sent. Treatment remains unchecked.</p>
          <label className="field-label">Document title<input value={authorityTitle} onChange={e=>setAuthorityTitle(e.target.value)}/></label>
          <label className="field-label">Public document URL<input type="url" value={authorityUrl} onChange={e=>setAuthorityUrl(e.target.value)}/></label>
          <div className="legal-footer"><button className="secondary" disabled={busy||!authorityUrl||!authorityTitle||!jurisdiction||!relevantDate} onClick={()=>void action(async()=>{await api('fetch_public_authority',{...caseSessionArgs(snapshot.id,snapshot.session_epoch),url:authorityUrl,title:authorityTitle,jurisdiction,relevant_date:relevantDate});setAuthorityUrl('');setRevision(v=>v+1);})}>Retrieve and preserve original</button></div>
        </section>
      </div>
      <p className="field-hint legal-note">Saved products and authorities appear in Findings & clock proposals, where each revision can be inspected and reviewed.</p>
    </>:null}
    {tab==='Incident replay'?<>
      <p className="workbench-intro">Choose two to four current, human-accepted clock proposals using container-relative playback seconds. Each needs independent held-out checks and overlapping supported ranges.</p>
      {loadingDesk?deskSkeleton:null}
      {desk&&!clocks.length?<div className="empty-state review-empty"><Clapperboard size={20} aria-hidden="true"/><h3>No clock proposals yet</h3><p>Fit a clock in Findings › Clock fit lab and accept it after review. Accepted proposals appear here for synchronized replay.</p></div>:null}
      {clocks.length?<fieldset className="replay-choices"><legend className="section-title">Clock proposals <span className="count">{selected.length} of 2–4 selected</span></legend><div className="list">{clocks.map(c=><label className={`list-row replay-choice ${c.review!=='accepted'||c.stale?'is-disabled':''}`} key={c.id}><input type="checkbox" disabled={c.review!=='accepted'||c.stale||busy} checked={selected.includes(c.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,c.id]:old.filter(id=>id!==c.id))}/><span className="list-row-main"><span className="list-row-title" title={c.title}>{c.title}</span><span className="list-row-subtitle">revision {c.revision}</span></span><span className="list-row-meta">{c.stale?<StatusPill state="stale" label="Stale" small />:c.review==='accepted'?<StatusPill state="accepted" label="Accepted" small />:<StatusPill state={c.review==='rejected'?'failed':'unreviewed'} label={humanize(c.review)} small />}</span></label>)}</div></fieldset>:null}
      {clocks.length?<div className="workbench-actions"><button className="primary" disabled={busy||selected.length<2||selected.length>4} onClick={()=>void action(prepareReplay)}>{busy?'Preparing playback…':'Open synchronized replay'}</button>{busy?<span className="status-line" role="status"><span className="activity-dot" aria-hidden="true" />Preparing playback derivatives</span>:null}</div>:null}
      {replay?<section className="card replay-stage" aria-label="Synchronized replay"><p className="field-hint">{replay.note}</p><div className="replay-grid">{replay.recordings.map((r,i)=><figure key={r.source_id} className="replay-tile"><figcaption><span className="replay-name" title={r.name}>{r.name}</span><span className="replay-uncertainty">Mapping uncertainty ±{r.fit.uncertainty_seconds.toFixed(3)} seconds</span></figcaption><div className="replay-media"><video ref={node=>{players.current[i]=node;}} src={evidenceUrl(`artifact/${r.artifact}`)} preload="auto" muted={i!==0} onLoadedMetadata={()=>{const position=incidentToSource(incident,r.fit);if(players.current[i]&&position)players.current[i]!.currentTime=position.seconds;}} onTimeUpdate={()=>tick(i)} onEnded={pause} onError={()=>{pause();setError('Recording could not be decoded; synchronized replay stopped.');}}/></div><button className="quiet evidence-link" onClick={()=>{onSource(r.source_id);onClose();}}>Open original</button></figure>)}</div>
        <div className="replay-transport">
          <button className="primary replay-play" onClick={()=>playing?pause():void action(play)}>{playing?<Pause size={15} />:<Play size={15} />}{playing?'Pause':'Play'}</button>
          <button className="secondary" onClick={()=>{pause();seek(Math.max(replay.incident_range[0],incident-.04));}}><SkipBack size={14} />Back 40 ms</button>
          <button className="secondary" onClick={()=>{pause();seek(Math.min(replay.incident_range[1],incident+.04));}}>Forward 40 ms<SkipForward size={14} /></button>
          <label className="replay-loop"><input type="checkbox" checked={loop} onChange={e=>setLoop(e.target.checked)}/>Loop supported range</label>
        </div>
        <label className="replay-scrub"><span className="replay-time">Incident seconds {incident.toFixed(3)}</span><input aria-label="Incident playhead" type="range" min={replay.incident_range[0]} max={replay.incident_range[1]} step="0.01" value={incident} onChange={e=>seek(Number(e.target.value))}/><span className="replay-range">{replay.incident_range[0].toFixed(2)} – {replay.incident_range[1].toFixed(2)}</span></label>
        <p className="field-hint">40 ms steps are playback steps, not exact decoded-frame selection. Other recording audio is muted to avoid overlapping sound.</p>
      </section>:null}
    </>:null}
    {questionPager}
    </div>
  </section>;
}
