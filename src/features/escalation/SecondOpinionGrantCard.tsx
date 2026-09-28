import { useEffect, useState } from 'react';
import { secondOpinionGrant, setSecondOpinionGrant, type Grant, type Vendor } from '../../api/secondOpinion';

const suggested: Record<Vendor, string> = { openrouter: 'google/gemini-2.5-flash', openai: 'gpt-4o-audio-preview' };
const vendorName: Record<Vendor, string> = { openrouter: 'OpenRouter', openai: 'OpenAI (existing key)' };

/** The per-case permission for the optional second opinion. It is saved on
 *  its own, audited, and never implied by any other setting. */
export default function SecondOpinionGrantCard({ caseId, sessionEpoch }: { caseId: string; sessionEpoch?: number }) {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [vendor, setVendor] = useState<Vendor>('openrouter');
  const [model, setModel] = useState(suggested.openrouter);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    secondOpinionGrant().then(value => { if (!live) return; setGrant(value.grant); if (value.grant) { setVendor(value.grant.vendor); setModel(value.grant.model); } setLoaded(true); })
      .catch(e => { if (live) { setError(String(e)); setLoaded(true); } });
    return () => { live = false; };
  }, [caseId, sessionEpoch]);
  async function save(choice: { vendor: Vendor; model: string } | null) {
    setBusy(true); setError('');
    try { setGrant((await setSecondOpinionGrant({ case_id: caseId, session_epoch: sessionEpoch }, choice)).grant); }
    catch (e) { setError(String(e).replace(/^Error: /, '')); }
    finally { setBusy(false); }
  }
  return <section className="settings-card" aria-labelledby="settings-second-opinion-title">
    <div className="settings-card-header"><div className="settings-card-heading">
      <h3 id="settings-second-opinion-title">Second opinion on uncertain audio</h3>
      <p>Optional. When the local transcript is unsure, you can send a short clip (at most 30 seconds, audio only, no file name or case text) to the model named here. Every send shows a preview and waits for your confirmation. Results stay unreviewed until you accept them.</p>
    </div></div>
    {!loaded ? <p className="field-hint">Loading…</p> : <>
      <p role="status">{grant ? `Allowed for this case: ${vendorName[grant.vendor]} · ${grant.model} (permission revision ${grant.revision}).` : 'Off for this case.'}</p>
      <div className="settings-second-opinion-form">
        <label className="field-label">Service
          <select value={vendor} disabled={busy} onChange={event => { const next = event.target.value as Vendor; setVendor(next); setModel(suggested[next]); }}>
            <option value="openrouter">OpenRouter (zero-data-retention routing)</option>
            <option value="openai">OpenAI (existing key)</option>
          </select>
        </label>
        <label className="field-label">Audio model
          <input value={model} disabled={busy} spellCheck={false} onChange={event => setModel(event.target.value)} aria-describedby="settings-second-opinion-model-hint" />
        </label>
        <p className="field-hint" id="settings-second-opinion-model-hint">Use a model that accepts audio input. Changing the model or service requires allowing it again, and earlier previews stop being sendable.</p>
      </div>
      {error ? <p role="alert" className="small danger-text">{error}</p> : null}
      <div className="card-actions">
        {grant ? <button type="button" className="quiet" disabled={busy} onClick={() => void save(null)}>Turn off for this case</button> : null}
        <button type="button" className="secondary" data-size="sm" disabled={busy || !model.trim()} onClick={() => void save({ vendor, model: model.trim() })}>{grant ? 'Update permission' : 'Allow for this case'}</button>
      </div>
    </>}
  </section>;
}
