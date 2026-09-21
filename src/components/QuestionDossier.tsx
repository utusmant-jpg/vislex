import { useEffect, useState } from 'react';
import { api, citationParts, native } from '../bridge';
import { CitationChip, StatusPill } from '../ui';

type Claim = { proposition: string; assessment: string; supporting: string[]; contrary: string[]; uncertainty: string; next_check: string };
type DossierView = {
  dossier: { revision: number; scope: string; checks: { id: string; description: string; state: string; reason: string; receipts: string[] }[]; claims: Claim[] } | null;
  stale: boolean; completion_stale: boolean;
  completion: { outcome: string; gaps: string[]; created_at: string } | null;
  human_reviews: ({ decision: string; note: string; stale: boolean } | null)[];
  coverage_note: string;
  coverage?: {contract: {mode:string;purpose:string} | null; units: {requirement:{source_id:string;stage:string;start:number;end:number};missing:[number,number][];complete:boolean}[]};
};

export default function QuestionDossier({ taskId, step, status, evidenceVersion, onSource }: { taskId: string; step: number; status: string; evidenceVersion: string; onSource: (id: string, locator?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<DossierView | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [reviewing, setReviewing] = useState<number | null>(null);
  useEffect(() => {
    if (!open || !native) return;
    let active = true;
    setError(''); setView(null);
    api<DossierView>('read_dossier', { task_id: taskId }).then(value => { if (active) {setView(value);setNotes({});} }).catch(reason => { if (active) { setError(String(reason)); setView(null); } });
    return () => { active = false; };
  }, [open, taskId, step, status, refresh, evidenceVersion]);
  function citations(values: string[]) {
    return values.length ? values.map((value, index) => {
      const citation = citationParts(value);
      return citation ? <CitationChip key={`${value}:${index}`} value={value} onOpen={onSource} /> : <span key={`${value}:${index}`}>{value}</span>;
    }) : <span className="muted">None recorded</span>;
  }
  async function review(index: number, decision: string) {
    if (!view?.dossier || reviewing !== null) return;
    setReviewing(index); setError('');
    try { setView(await api<DossierView>('review_dossier_claim', { task_id: taskId, revision: view.dossier.revision, claim_index: index, decision, note: notes[index] ?? '' })); }
    catch (reason) { setError(String(reason)); }
    finally { setReviewing(null); }
  }
  return <details className="question-dossier" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Question dossier · evidence, checks and gaps</summary>
    {open ? <div className="dossier-content">
      {!native ? <p>Question dossiers are available in the desktop app.</p> : null}
      {error ? <p role="alert">Could not load this dossier: {error}</p> : null}
      {native && !view && !error ? <p role="status">Loading evidence checks…</p> : null}
      {view ? <>
        <div className="dossier-state">{view.stale || view.completion_stale ? <StatusPill state="stale" label="Evidence changed — recheck required"/> : view.completion?.outcome === 'declared_checks_complete' ? <StatusPill state="complete" label="Declared checks complete · AI assessment"/> : view.completion?.outcome === 'partial' ? <StatusPill state="needs-attention" label="Partial investigation"/> : <StatusPill state="unreviewed" label="Unreviewed investigation"/>}</div>
        <p className="small muted">{view.coverage_note} No human approval is implied.</p>
        {view.dossier ? <>
          <h3>Declared scope</h3><p>{view.dossier.scope}</p>
          {view.coverage?.contract ? <><h3>Coverage · {view.coverage.contract.mode}</h3><p>{view.coverage.contract.purpose}</p><ul>{view.coverage.units.map((row,index)=><li key={index}>{row.requirement.stage.replaceAll('_',' ')} {row.requirement.start}–{row.requirement.end}: {row.complete?'Recorded for every declared unit':`Missing ${row.missing.map(([a,b])=>`${a}–${b}`).join(', ')}`}</li>)}</ul></> : null}
          <h3>Inspection checks</h3>
          {view.dossier.checks.length ? <ul className="dossier-checks">{view.dossier.checks.map(check => <li key={check.id}><strong>{check.state === 'done' ? 'Inspected' : check.state === 'blocked' ? 'Blocked' : 'Open'}:</strong> {check.description}{check.reason ? <p>{check.reason}</p> : null}<small>{check.receipts.length} inspection receipts</small></li>)}</ul> : <p>No inspection obligations declared.</p>}
          <h3>Findings and discrepancies</h3>
          {view.dossier.claims.length ? view.dossier.claims.map((claim, index) => <details className="dossier-claim" key={`${view.dossier!.revision}:${index}`}><summary>{claim.proposition}</summary><p><strong>AI assessment:</strong> {claim.assessment.replaceAll('_', ' ')}</p><p><strong>Supporting material</strong></p><div>{citations(claim.supporting)}</div><p><strong>Conflicting material</strong></p><div>{citations(claim.contrary)}</div>{claim.uncertainty ? <p><strong>Uncertainty:</strong> {claim.uncertainty}</p> : null}{claim.next_check ? <p><strong>Next useful check:</strong> {claim.next_check}</p> : null}
            {view.human_reviews[index] ? <p><strong>Your review:</strong> {view.human_reviews[index]!.decision.replaceAll('_', ' ')}{view.human_reviews[index]!.stale ? ' · stale' : ''}{view.human_reviews[index]!.note ? ` — ${view.human_reviews[index]!.note}` : ''}</p> : <p>No human review recorded.</p>}
            <label className="dossier-note">Review note<textarea aria-label={`Review note for finding ${index + 1}`} value={notes[index] ?? ''} maxLength={4000} onChange={event => setNotes(previous => ({ ...previous, [index]: event.target.value }))}/></label>
            <div className="dossier-review-actions">{[['accepted', 'Accept finding'], ['needs_review', 'Needs review'], ['rejected', 'Reject finding']].map(([decision, label]) => <button type="button" className="quiet" key={decision} disabled={view.stale || reviewing !== null} onClick={() => void review(index, decision)}>{label}</button>)}</div>
          </details>) : <p>No structured findings recorded yet.</p>}
        </> : <p>No structured scope or findings were recorded for this answer. An ended run does not establish evidence coverage.</p>}
        {view.completion?.gaps.length ? <><h3>Gaps and limitations</h3><ul>{view.completion.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></> : null}
      </> : null}
      {native ? <button type="button" className="quiet" onClick={() => setRefresh(value => value + 1)}>Refresh currentness</button> : null}
    </div> : null}
  </details>;
}
