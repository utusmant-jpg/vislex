import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleHelp, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { api, citationParts, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { CitationChip, Skeleton, StatusPill } from '../ui';

type Claim = { proposition: string; assessment: string; supporting: string[]; contrary: string[]; uncertainty: string; next_check: string };
type DossierView = {
  dossier: { revision: number; scope: string; checks: { id: string; description: string; state: string; reason: string; receipts: string[] }[]; claims: Claim[] } | null;
  stale: boolean; completion_stale: boolean;
  completion: { outcome: string; gaps: string[]; created_at: string; structured?: boolean; blocks?: { id: string; kind: string; text: string; claims: string[]; factual: boolean; review: string | null }[] } | null;
  human_reviews: ({ decision: string; note: string; stale: boolean } | null)[];
  coverage_note: string;
  coverage?: {contract: {mode:string;purpose:string} | null; units: {requirement:{source_id:string;stage:string;start:number;end:number};missing:[number,number][];complete:boolean}[]};
};
type HumanReview = DossierView['human_reviews'][number];

/** Snake-case identifiers as sentence-case labels ("issue_matrix" → "Issue matrix"). */
const humanize = (value: string) => { const text = value.replaceAll('_', ' '); return text.charAt(0).toUpperCase() + text.slice(1); };

/** A human decision on one claim, as icon + label; a stale decision says so. */
export function humanReviewPill(review: HumanReview) {
  if (!review) return <StatusPill state="unreviewed" label="Not reviewed" small />;
  if (review.stale) return <StatusPill state="stale" label={`${humanize(review.decision)} · stale`} small />;
  if (review.decision === 'accepted') return <StatusPill state="accepted" label="Accepted" small />;
  if (review.decision === 'rejected') return <StatusPill state="failed" label="Rejected" small />;
  return <StatusPill state="needs-attention" label={humanize(review.decision)} small />;
}

function checkPill(state: string) {
  return state === 'done' ? <StatusPill state="complete" label="Inspected" small /> : state === 'blocked' ? <StatusPill state="interrupted" label="Blocked" small /> : <StatusPill state="unreviewed" label="Open" small />;
}

export default function QuestionDossier({ caseId, sessionEpoch, taskId, step, status, evidenceVersion, onSource }: { caseId: string; sessionEpoch?: number; taskId: string; step: number; status: string; evidenceVersion: string; onSource: (id: string, locator?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<DossierView | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [reviewing, setReviewing] = useState<number | null>(null);
  // The review buttons are disabled while a decision saves, which drops keyboard
  // focus to the document. Once the save settles, focus returns to that finding's
  // review group (as EvidenceNotebook does): a neutral target, so a repeated
  // Enter cannot record a different decision.
  const content = useRef<HTMLDivElement>(null);
  const [restoreFocus, setRestoreFocus] = useState<number | null>(null);
  useEffect(() => {
    if (restoreFocus === null || reviewing !== null) return;
    setRestoreFocus(null);
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    content.current?.querySelector<HTMLElement>(`[data-review-index="${restoreFocus}"]`)?.focus();
  }, [restoreFocus, reviewing]);
  useEffect(() => {
    if (!open || !native) return;
    let active = true;
    setError(''); setView(null);
    api<DossierView>('read_dossier', { ...caseSessionArgs(caseId, sessionEpoch), task_id: taskId }).then(value => { if (active) {setView(value);setNotes({});} }).catch(reason => { if (active) { setError(String(reason)); setView(null); } });
    return () => { active = false; };
  }, [open, caseId, sessionEpoch, taskId, step, status, refresh, evidenceVersion]);
  function citations(values: string[]) {
    return values.length ? values.map((value, index) => {
      const citation = citationParts(value);
      return citation ? <CitationChip key={`${value}:${index}`} value={value} onOpen={onSource} /> : <span key={`${value}:${index}`} className="citation-raw">{value}</span>;
    }) : <span className="muted">None recorded</span>;
  }
  async function review(index: number, decision: string) {
    if (!view?.dossier || reviewing !== null) return;
    if (content.current?.querySelector(`[data-review-index="${index}"]`)?.contains(document.activeElement)) setRestoreFocus(index);
    setReviewing(index); setError('');
    try { setView(await api<DossierView>('review_dossier_claim', { ...caseSessionArgs(caseId, sessionEpoch), task_id: taskId, revision: view.dossier.revision, claim_index: index, decision, note: notes[index] ?? '' })); }
    catch (reason) { setError(String(reason)); }
    finally { setReviewing(null); }
  }
  const reviewed = view?.dossier ? view.human_reviews.filter(r => r && !r.stale).length : 0;
  return <details className="question-dossier" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight size={16} className="dossier-chevron" aria-hidden="true" /><span>Question dossier · evidence, checks and gaps</span></summary>
    {open ? <div className="dossier-content" ref={content}>
      {!native ? <p className="field-hint">Question dossiers are available in the desktop app.</p> : null}
      {error ? <p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" /><span>Could not load this dossier: {error}</span></p> : null}
      {native && !view && !error ? <div className="dossier-loading"><p role="status" className="status-line"><span className="activity-dot" aria-hidden="true" />Loading evidence checks…</p><Skeleton height={12} /><Skeleton height={12} className="skeleton-short" /></div> : null}
      {view ? <>
        <div className="dossier-state">{view.stale || view.completion_stale ? <StatusPill state="stale" label="Evidence changed — recheck required"/> : view.completion?.outcome === 'declared_checks_complete' ? <StatusPill state="complete" label="Declared checks complete · AI assessment"/> : view.completion?.outcome === 'partial' ? <StatusPill state="needs-attention" label="Partial investigation"/> : <StatusPill state="unreviewed" label="Unreviewed investigation"/>}{view.dossier?.claims.length ? <span className="dossier-progress">{reviewed} of {view.dossier.claims.length} findings have a current human review</span> : null}</div>
        <p className="dossier-note-text">{view.coverage_note} No human approval is implied.</p>
        {view.dossier ? <>
          <section className="dossier-section"><h4>Declared scope</h4><p>{view.dossier.scope}</p></section>
          {view.coverage?.contract ? <section className="dossier-section"><h4>Coverage · {view.coverage.contract.mode}</h4><p>{view.coverage.contract.purpose}</p><ul className="dossier-coverage">{view.coverage.units.map((row,index)=><li key={index}>{row.complete ? <StatusPill state="complete" label="Recorded" small /> : <StatusPill state="needs-attention" label="Gaps" small />}<span>{humanize(row.requirement.stage)} {row.requirement.start}–{row.requirement.end}: {row.complete?'Recorded for every declared unit':`Missing ${row.missing.map(([a,b])=>`${a}–${b}`).join(', ')}`}</span></li>)}</ul></section> : null}
          <section className="dossier-section"><h4>Inspection checks</h4>
          {view.dossier.checks.length ? <ul className="dossier-checks">{view.dossier.checks.map(check => <li key={check.id}>{checkPill(check.state)}<div className="dossier-check-text"><span>{check.description}</span>{check.reason ? <p>{check.reason}</p> : null}<small>{check.receipts.length} inspection receipts</small></div></li>)}</ul> : <p className="field-hint">No inspection obligations declared.</p>}</section>
          <section className="dossier-section"><h4>Findings and discrepancies</h4>
          {view.dossier.claims.length ? <div className="dossier-claims">{view.dossier.claims.map((claim, index) => <details className="dossier-claim" key={`${view.dossier!.revision}:${index}`}>
            <summary className="dossier-claim-summary"><ChevronRight size={14} className="dossier-chevron" aria-hidden="true" /><span className="dossier-claim-text">{claim.proposition}</span><span className="dossier-claim-state">{humanReviewPill(view.human_reviews[index] ?? null)}</span></summary>
            <div className="dossier-claim-body">
              <dl className="dossier-claim-facts">
                <div><dt>AI assessment</dt><dd><span className="badge">{humanize(claim.assessment)}</span></dd></div>
                <div><dt>Supporting material</dt><dd className="dossier-citations">{citations(claim.supporting)}</dd></div>
                <div><dt>Conflicting material</dt><dd className="dossier-citations">{citations(claim.contrary)}</dd></div>
                {claim.uncertainty ? <div><dt>Uncertainty</dt><dd>{claim.uncertainty}</dd></div> : null}
                {claim.next_check ? <div><dt>Next useful check</dt><dd>{claim.next_check}</dd></div> : null}
              </dl>
              {view.human_reviews[index] ? <p className="dossier-your-review"><strong>Your review:</strong> {humanize(view.human_reviews[index]!.decision)}{view.human_reviews[index]!.stale ? ' · stale' : ''}{view.human_reviews[index]!.note ? ` — ${view.human_reviews[index]!.note}` : ''}</p> : <p className="dossier-your-review">No human review recorded.</p>}
              <label className="field-label dossier-note">Review note<textarea aria-label={`Review note for finding ${index + 1}`} value={notes[index] ?? ''} maxLength={4000} onChange={event => setNotes(previous => ({ ...previous, [index]: event.target.value }))}/></label>
              <div className="dossier-review-actions" role="group" tabIndex={-1} data-review-index={index} aria-label={`Record your review of finding ${index + 1}`}>{([['accepted', 'Accept finding', Check], ['needs_review', 'Needs review', CircleHelp], ['rejected', 'Reject finding', X]] as const).map(([decision, label, Icon]) => <button type="button" className={`secondary review-${decision}`} data-size="sm" key={decision} disabled={view.stale || reviewing !== null} onClick={() => void review(index, decision)}><Icon size={14} aria-hidden="true" />{label}</button>)}{reviewing === index ? <span className="status-line" role="status"><span className="activity-dot" aria-hidden="true" />Saving review…</span> : null}</div>
              {view.stale ? <p className="field-hint">Evidence changed after this dossier was saved. Recheck before recording a review.</p> : null}
            </div>
          </details>)}</div> : <p className="field-hint">No structured findings recorded yet.</p>}</section>
        </> : <p className="field-hint">No structured scope or findings were recorded for this answer. An ended run does not establish evidence coverage.</p>}
        {view.completion?.blocks?.length ? <section className="dossier-section"><h4>Answer blocks</h4><ul className="dossier-blocks">{view.completion.blocks.map(block => <li key={block.id}><span className="dossier-block-kind">{humanize(block.kind)}</span><span className="dossier-block-text">{block.text}</span>{block.factual ? <small>{block.claims.length ? `bound to ${block.claims.join(', ')}` : 'no claim reference'} · {block.review === 'supported' ? 'support reviewed' : block.review === 'unsupported' ? 'support review: unsupported' : 'no bound review'}</small> : <small>non-factual · never certifies truth</small>}</li>)}</ul></section> : null}
        {view.completion?.gaps.length ? <section className="dossier-section"><h4>Gaps and limitations</h4><ul className="dossier-gaps">{view.completion.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></section> : null}
      </> : null}
      {native ? <div className="dossier-footer"><button type="button" className="quiet" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh currentness</button></div> : null}
    </div> : null}
  </details>;
}
