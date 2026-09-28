import { useEffect, useState } from 'react';
import { AlertTriangle, Play, ShieldCheck } from 'lucide-react';
import { native } from '../../bridge';
import {
  cancelSecondOpinion, decideSecondOpinion, formatSpan, listSecondOpinions, prepareSecondOpinion, secondOpinionCandidates,
  secondOpinionGrant, sendSecondOpinion, type Candidate, type Grant, type Preview, type SecondOpinion, type Triage,
} from '../../api/secondOpinion';

type Props = {
  caseId?: string; sessionEpoch?: number; sourceId: string; runId: string;
  /** Local text for loaded segments, keyed by ordinal, for side-by-side review. */
  localText: (ordinal: number) => string | undefined;
  onSeek: (time: number) => void;
  /** Called after a reviewer decision creates transcript corrections. */
  onDecided?: () => void;
};

const statusLabel: Record<SecondOpinion['status'], string> = {
  clipping: 'Preparing clip', previewed: 'Ready to send', sending: 'Sending', received: 'Received · unreviewed',
  failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Outcome uncertain',
};

/** Local uncertainty triage plus the optional, human-confirmed second opinion.
 *  Triage never sends anything; sending needs the case grant and a click on
 *  the preview that states exactly what leaves the machine. */
export default function SecondOpinionPanel({ caseId, sessionEpoch, sourceId, runId, localText, onSeek, onDecided }: Props) {
  const [triage, setTriage] = useState<Triage | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [history, setHistory] = useState<SecondOpinion[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [active, setActive] = useState<SecondOpinion | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const guard = caseId ? { case_id: caseId, session_epoch: sessionEpoch } : null;

  useEffect(() => { setTriage(null); setPreview(null); setActive(null); setError(''); }, [sourceId, runId]);
  async function refreshHistory() { if (native || caseId) { try { setHistory(await listSecondOpinions(sourceId)); } catch { /* shown on next action */ } } }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError('');
    try { await action(); } catch (e) { setError(String(e).replace(/^Error: /, '')); } finally { setBusy(''); }
  }
  const find = () => run('find', async () => {
    if (!guard) return;
    const [found, access] = await Promise.all([secondOpinionCandidates(guard, sourceId, runId), secondOpinionGrant()]);
    setTriage(found); setGrant(access.grant); await refreshHistory();
  });
  const prepare = (candidate: Candidate) => run(`prepare-${candidate.start}`, async () => {
    if (!guard) return;
    const next = await prepareSecondOpinion(guard, sourceId, runId, candidate);
    setPreview(next); setActive(null); await refreshHistory();
  });
  const send = () => run('send', async () => {
    if (!guard || !preview) return;
    setActive({ ...preview.second_opinion, status: 'sending' });
    const done = await sendSecondOpinion(guard, preview.second_opinion.id);
    setActive(done); setPreview(null); await refreshHistory();
  });
  const cancel = () => { if (guard && active) void cancelSecondOpinion(guard, active.id).catch(e => setError(String(e))); };
  const decide = (decision: NonNullable<SecondOpinion['decision']>) => run(`decide-${decision}`, async () => {
    if (!guard || !active) return;
    const done = await decideSecondOpinion(guard, active.id, decision);
    setActive(done.second_opinion); await refreshHistory();
    if (done.corrections.length) onDecided?.();
  });

  if (!caseId) return null;
  return <section className="second-opinion" aria-label="Second opinion on uncertain audio">
    <div className="second-opinion-head">
      <strong>Uncertain spans</strong>
      {triage ? <span className="second-opinion-count">{triage.candidates.length} {triage.candidates.length === 1 ? 'span' : 'spans'} from {triage.flagged_segments} flagged of {triage.segments} segments</span> : null}
      <button type="button" className="secondary" data-size="sm" disabled={!!busy} onClick={() => void find()}>{triage ? 'Refresh' : 'Find uncertain spans'}</button>
    </div>
    {triage ? <p className="field-hint">{triage.note}</p> : <p className="field-hint">The local recogniser's own diagnostics mark spans worth checking against the audio. Nothing is sent.</p>}
    {error ? <p role="alert" className="notice error"><AlertTriangle size={14} aria-hidden="true" /><span>{error}</span></p> : null}
    {triage && !grant ? <p className="notice info" role="status"><ShieldCheck size={14} aria-hidden="true" /><span>Sending a clip for a second opinion is off for this case. It can be allowed in Settings → Privacy &amp; offline; each send still needs your confirmation.</span></p> : null}

    {triage?.candidates.length ? <ol className="second-opinion-list" aria-label="Uncertain spans">
      {triage.candidates.map(candidate => <li key={`${candidate.track}-${candidate.start}`} className="second-opinion-item">
        <div className="second-opinion-row">
          <span className="mono">{formatSpan(candidate.start, candidate.end)}</span>
          <span className="second-opinion-reason">{candidate.reasons[0]?.detail ?? 'Flagged'}</span>
          <button type="button" className="quiet" data-size="sm" aria-label={`Play ${formatSpan(candidate.start, candidate.end)}`} onClick={() => onSeek(candidate.start)}><Play size={14} aria-hidden="true" />Play</button>
          {grant ? <button type="button" className="quiet" data-size="sm" disabled={!!busy} onClick={() => void prepare(candidate)}>Prepare clip</button> : null}
        </div>
        {candidate.reasons.length > 1 ? <p className="field-hint">{candidate.reasons.slice(1, 3).map(reason => reason.detail).join(' · ')}</p> : null}
      </li>)}
    </ol> : triage ? <p className="field-hint">No spans were flagged. That does not mean the transcript is verified.</p> : null}

    {preview ? <div className="second-opinion-preview" role="group" aria-label="Second opinion preview">
      <p><strong>Recipient:</strong> {preview.recipient}</p>
      <p><strong>What leaves this machine:</strong> {preview.sends}</p>
      <p className="notice warning"><AlertTriangle size={14} aria-hidden="true" /><span>{preview.disclosure}</span></p>
      <p className="field-hint">{preview.estimate.note}</p>
      <div className="card-actions">
        <button type="button" className="quiet" onClick={() => setPreview(null)}>Discard</button>
        <button type="button" className="primary" data-size="sm" disabled={!!busy} onClick={() => void send()}>Send for second opinion</button>
      </div>
    </div> : null}

    {active ? <div className="second-opinion-result" role="group" aria-label="Second opinion result">
      <p><strong>{statusLabel[active.status]}</strong> · {active.model}{active.usage?.upstream_provider ? ` via ${active.usage.upstream_provider}` : ''}{typeof active.usage?.cost === 'number' ? ` · $${active.usage.cost.toFixed(4)} reported` : ''}</p>
      {active.status === 'sending' ? <button type="button" className="secondary" data-size="sm" onClick={cancel}>Cancel request</button> : null}
      {active.error ? <p className="small danger-text">{active.error}</p> : null}
      {active.result ? <>
        <p className="field-hint">{active.result.label}</p>
        <table className="second-opinion-diff">
          <thead><tr><th scope="col">Segment</th><th scope="col">Local transcript</th><th scope="col">Second opinion</th></tr></thead>
          <tbody>{active.ordinals.map(ordinal => <tr key={ordinal}>
            <th scope="row" className="mono">{ordinal}</th>
            <td>{localText(ordinal) ?? '(not loaded)'}</td>
            <td>{active.result!.segments.find(segment => segment.ordinal === ordinal)?.text ?? '(no text returned)'}</td>
          </tr>)}</tbody>
        </table>
        {active.result.notes ? <p className="field-hint">Model note: {active.result.notes}</p> : null}
        {active.result.raw ? <p className="field-hint">Unparsed reply: {active.result.raw}</p> : null}
      </> : null}
      {!active.decision && ['received', 'failed', 'cancelled', 'uncertain'].includes(active.status) ? <div className="card-actions">
        {active.status === 'received' && active.result?.segments.length ? <button type="button" className="primary" data-size="sm" disabled={!!busy} onClick={() => void decide('accepted_remote')}>Use second opinion</button> : null}
        {active.status === 'received' ? <button type="button" className="secondary" data-size="sm" disabled={!!busy} onClick={() => void decide('kept_local')}>Keep local</button> : null}
        <button type="button" className="quiet" disabled={!!busy} onClick={() => void decide('unresolved')}>Leave unresolved</button>
      </div> : active.decision ? <p role="status">Decision recorded: {active.decision === 'accepted_remote' ? 'second opinion used as an accepted correction' : active.decision === 'kept_local' ? 'local transcript kept' : active.decision === 'edited' ? 'edited correction saved' : 'left unresolved'}.</p> : null}
    </div> : null}

    {history.length ? <details className="disclosure second-opinion-history"><summary>Earlier second opinions ({history.length})</summary>
      <ul>{history.map(item => <li key={item.id}><button type="button" className="quiet" onClick={() => { setActive(item); setPreview(null); }}>{formatSpan(item.start, item.end)} · {statusLabel[item.status]}{item.decision ? ` · ${item.decision.replace('_', ' ')}` : ''}</button></li>)}</ul>
    </details> : null}
  </section>;
}
