import { useEffect, useRef, useState } from 'react';
import { X, Save } from 'lucide-react';
import { api, native } from '../bridge';
import { configuredProfiles, defaultConfig, providerNames } from '../aiProfiles';
import type { AIConfig, AIProfile, ModelOption, Provider, Settings, Snapshot } from '../types';

const companies = Object.keys(providerNames) as Provider[];
function initialProfiles(snapshot: Snapshot): AIProfile[] {
  const saved = configuredProfiles(snapshot);
  return [...saved.map(p => ({ ...p, allow_text: true, allow_images: true })), ...companies.filter(provider => !saved.some(p => p.provider === provider)).map(provider => ({ provider, model: '', allow_text: false, allow_images: false }))];
}
export default function SettingsDialog({ snapshot, onClose, refresh }: { snapshot: Snapshot; onClose: () => void; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [settings] = useState<Settings>({ ...snapshot.settings, offline: false, allow_text: true, allow_images: true, case_budget: 0, input_per_million: 0, output_per_million: 0 });
  const [config, setConfig] = useState<AIConfig>(snapshot.ai_config ?? defaultConfig);
  const [profiles, setProfiles] = useState(() => initialProfiles(snapshot));
  const [primary, setPrimary] = useState(() => Math.max(0, initialProfiles(snapshot).findIndex(p => p.provider === (snapshot.ai_config ?? defaultConfig).provider && p.model === snapshot.settings.model)));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [stored, setStored] = useState<Partial<Record<Provider, boolean>>>({});
  const [models, setModels] = useState<Partial<Record<Provider, ModelOption[]>>>({});
  const [loading, setLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<Provider, string>>>({});
  const busy = saving || Object.values(loading).some(Boolean);
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    companies.forEach(provider => {
      api<{ configured: boolean }>('provider_key_status', { provider }).then(v => { if (mounted.current) setStored(s => ({ ...s, [provider]: v.configured })); }).catch(e => { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); });
    });
    return () => { mounted.current = false; };
  }, []);
  function updateProfile(index: number, change: Partial<AIProfile>) { setProfiles(ps => ps.map((p, i) => i === index ? { ...p, ...change } : p)); }
  async function loadModels(provider: Provider) {
    if (loading[provider]) return;
    setLoading(s => ({ ...s, [provider]: true })); setCatalogErrors(s => ({ ...s, [provider]: '' }));
    try {
      if (keys[provider]?.trim()) {
        await api('save_provider_key', { provider, key: keys[provider] });
        if (!mounted.current) return;
        setKeys(s => ({ ...s, [provider]: '' })); setStored(s => ({ ...s, [provider]: true }));
      }
      const result = await api<ModelOption[]>('provider_models', { provider });
      if (mounted.current) { setModels(s => ({ ...s, [provider]: result })); if (!result.length) setCatalogErrors(s => ({ ...s, [provider]: 'No chat models were returned for this account.' })); }
    } catch (e) { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); }
    finally { if (mounted.current) setLoading(s => ({ ...s, [provider]: false })); }
  }
  async function save() {
    if (busy) return;
    setSaving(true); setError('');
    try {
      const lead = profiles[primary];
      if (!lead?.model) throw new Error('Select a default model from one of the company dropdowns.');
      for (const provider of companies) {
        if (keys[provider]?.trim()) { await api('save_provider_key', { provider, key: keys[provider] }); setKeys(s => ({ ...s, [provider]: '' })); setStored(s => ({ ...s, [provider]: true })); }
      }
      if (!settings.offline) {
        const enabled = [...new Set(profiles.filter(p => p.model).map(p => p.provider))];
        for (const provider of enabled) {
          const status = await api<{ configured: boolean }>('provider_key_status', { provider });
          if (!status.configured) throw new Error(`Add an API key for ${providerNames[provider]}, or remove its selected model.`);
        }
      }
      await api('save_ai_settings', { config: { ...config, provider: lead.provider, pool: profiles.filter((p, i) => i !== primary && p.model).map(p => ({ ...p, allow_text: true, allow_images: true })) }, settings: { ...settings, model: lead.model, allow_text: true, allow_images: true } });
      await refresh(); onClose();
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="modal settings-modal" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <div className="modal-heading"><div><div className="eyebrow">CASE SETTINGS</div><h2>AI providers & agents</h2></div><button className="icon-button" disabled={busy} aria-label="Close settings" onClick={onClose}><X size={20}/></button></div>
    {!native ? <p className="notice">AI setup is available in the Windows desktop app. This browser is a preview.</p> : null}
    <fieldset disabled={saving} className="ai-setup-fields">
    <p className="notice">AI is always enabled once a model is configured. All selected models can analyze case text and images. Add keys and choose models below.</p>
    <p className="small muted">Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</p>
    {companies.map(provider => <fieldset key={provider} className="provider-card"><legend>{providerNames[provider]}</legend>
      <div className="input-row"><input aria-label={`${providerNames[provider]} API key`} type="password" autoComplete="off" value={keys[provider] ?? ''} disabled={loading[provider]} onChange={e => setKeys(s => ({ ...s, [provider]: e.target.value }))} placeholder={stored[provider] ? 'Key saved in Windows Credential Manager' : 'Paste API key'}/><button className="secondary" disabled={!native || loading[provider] || (!stored[provider] && !keys[provider]?.trim())} onClick={() => void loadModels(provider)}>{loading[provider] ? 'Loading…' : keys[provider]?.trim() ? 'Save key & load models' : 'Load models'}</button></div>
      {catalogErrors[provider] ? <p role="alert">{catalogErrors[provider]}</p> : null}
      {profiles.map((p, i) => p.provider !== provider ? null : <div className="provider-model" key={i}>
        <label>Model<select aria-label={`${providerNames[provider]} model ${i + 1}`} value={p.model} onFocus={() => { if (native && stored[provider] && !settings.offline && !models[provider] && !loading[provider] && !catalogErrors[provider]) void loadModels(provider); }} onChange={e => { const first = !profiles.some(x => x.model); updateProfile(i, { model: e.target.value, allow_text: true, allow_images: true }); if (first) setPrimary(i); }}><option value="">{loading[provider] ? 'Loading models…' : 'Select a model'}</option>{p.model && !models[provider]?.some(m => m.id === p.model) ? <option value={p.model}>{p.model} (saved)</option> : null}{models[provider]?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}</select></label>
        <div className="provider-permissions"><label><input type="radio" name="default-model" checked={primary === i} onChange={() => setPrimary(i)}/> Default chat model</label>{p.model ? <span className="badge">Enabled</span> : null}{profiles.filter(x => x.provider === provider).length > 1 && primary !== i ? <button className="quiet" onClick={() => { setProfiles(ps => ps.filter((_, j) => j !== i)); if (primary > i) setPrimary(primary - 1); }}>Remove</button> : null}</div>
      </div>)}
      <button className="quiet" disabled={profiles.length >= 16} onClick={() => setProfiles(ps => [...ps, { provider, model: '', allow_text: false, allow_images: false }])}>Add another model</button>
    </fieldset>)}
    <p className="small muted">Model lists come from your account. Listing alone does not verify tool or image support. Enabled providers remain available; agents send requests while doing assigned work.</p>
    <div className="form-grid"><label>Agent execution<select value={config.execution} onChange={e => setConfig(c => ({ ...c, execution: e.target.value as AIConfig['execution'] }))}><option value="single">Single agent</option><option value="auto">Agent decides when to delegate</option><option value="parallel">Start a team, then allow delegation</option></select></label><label>Verification<select value={config.review} onChange={e => setConfig(c => ({ ...c, review: e.target.value as AIConfig['review'] }))}><option value="standard">Standard support review</option><option value="independent">Independent review</option><option value="challenge">Independent + challenge review</option></select></label></div>
    <p className="small muted">Up to three assignments run together, using one or several configured models. Agents choose scoped work and return evidence for the lead to check. Stop cancels the team. Additional agents can increase cost.</p>

    </fieldset>
    <div className="ai-save-footer">{error ? <p role="alert">{error}</p> : null}<div className="modal-footer"><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={!native || busy} onClick={() => void save()}><Save size={15}/>{saving ? 'Saving…' : 'Save settings & keys'}</button></div></div>
  </dialog>;
}
