import { useEffect, useRef, useState } from 'react';
import { KeyRound, Save, Trash2, X } from 'lucide-react';
import { api, native } from '../bridge';
import { configuredProfiles, defaultConfig, providerNames } from '../aiProfiles';
import { useTheme } from '../ui';
import type { AIConfig, AIProfile, ModelOption, Provider, Settings, Snapshot } from '../types';

const companies = Object.keys(providerNames) as Provider[];
const sections = ['AI providers', 'Appearance', 'About'] as const;
type Section = typeof sections[number];

function initialProfiles(snapshot: Snapshot): AIProfile[] {
  const saved = configuredProfiles(snapshot);
  return [...saved.map(p => ({ ...p, allow_text: true, allow_images: true })), ...companies.filter(provider => !saved.some(p => p.provider === provider)).map(provider => ({ provider, model: '', allow_text: false, allow_images: false }))];
}
export default function SettingsDialog({ snapshot, onClose, refresh }: { snapshot: Snapshot; onClose: () => void; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<Section>('AI providers');
  const [settings] = useState<Settings>({ ...snapshot.settings, offline: false, allow_text: true, allow_images: true, case_budget: 0, input_per_million: 0, output_per_million: 0 });
  const [config] = useState<AIConfig>(snapshot.ai_config ?? defaultConfig);
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
  async function removeKey(provider: Provider) {
    setCatalogErrors(s => ({ ...s, [provider]: '' }));
    try { await api('delete_provider_key', { provider }); if (mounted.current) setStored(s => ({ ...s, [provider]: false })); }
    catch (e) { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); }
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
      await api('save_ai_settings', { config: { ...config, execution: 'auto', review: 'standard', provider: lead.provider, pool: profiles.filter((p, i) => i !== primary && p.model).map(p => ({ ...p, allow_text: true, allow_images: true })) }, settings: { ...settings, model: lead.model, allow_text: true, allow_images: true } });
      await refresh(); onClose();
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="modal settings-sheet" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="eyebrow">SETTINGS</div>
        {sections.map(item => <button key={item} className={section === item ? 'selected' : ''} onClick={() => setSection(item)}>{item}</button>)}
        <div className="spacer" />
        <button className="quiet" disabled={busy} onClick={onClose}>Close</button>
      </nav>
      <div className="settings-body">
        <div className="settings-heading"><h2>{section}</h2><button className="icon-button" disabled={busy} aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>

        {section === 'AI providers' ? <fieldset disabled={saving} className="ai-setup-fields">
          {!native ? <p className="notice">AI setup is available in the Windows desktop app. This browser is a preview.</p> : null}
          <p className="notice">Saved once for all cases. VisLex chooses when to delegate and which enabled tools to use. AI is always enabled once a model is configured. All selected models can analyze case text and images. Add keys and choose models below.</p>
          <p className="small muted disclosure-open"><KeyRound size={13} /> Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</p>
          {companies.map(provider => <fieldset key={provider} className="provider-card"><legend>{providerNames[provider]}</legend>
            <div className="input-row">
              <input aria-label={`${providerNames[provider]} API key`} type="password" autoComplete="off" value={keys[provider] ?? ''} disabled={loading[provider]} onChange={e => setKeys(s => ({ ...s, [provider]: e.target.value }))} placeholder={stored[provider] ? 'Key saved in Windows Credential Manager' : 'Paste API key'} />
              <button className="secondary" disabled={!native || loading[provider] || (!stored[provider] && !keys[provider]?.trim())} onClick={() => void loadModels(provider)}>{loading[provider] ? 'Loading…' : keys[provider]?.trim() ? 'Save key & load models' : 'Load models'}</button>
              {stored[provider] ? <button className="icon-button" aria-label={`Remove saved ${providerNames[provider]} key`} title="Remove stored key" onClick={() => void removeKey(provider)}><Trash2 size={14} /></button> : null}
            </div>
            {catalogErrors[provider] ? <p role="alert" className="small danger-text">{catalogErrors[provider]}</p> : null}
            {profiles.map((p, i) => p.provider !== provider ? null : <div className="provider-model" key={i}>
              <label>Model<select aria-label={`${providerNames[provider]} model ${i + 1}`} value={p.model} onChange={e => { const first = !profiles.some(x => x.model); updateProfile(i, { model: e.target.value, allow_text: true, allow_images: true }); if (first) setPrimary(i); }}><option value="">{loading[provider] ? 'Loading models…' : 'Select a model'}</option>{p.model && !models[provider]?.some(m => m.id === p.model) ? <option value={p.model}>{p.model} (saved)</option> : null}{models[provider]?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}</select></label>
              <div className="provider-permissions"><label><input type="radio" name="default-model" checked={primary === i} onChange={() => setPrimary(i)} /> Default chat model</label>{p.model ? <span className="badge">Enabled</span> : null}{profiles.filter(x => x.provider === provider).length > 1 && primary !== i ? <button className="quiet" onClick={() => { setProfiles(ps => ps.filter((_, j) => j !== i)); if (primary > i) setPrimary(primary - 1); }}>Remove</button> : null}</div>
            </div>)}
            <button className="quiet" disabled={profiles.length >= 16} onClick={() => setProfiles(ps => [...ps, { provider, model: '', allow_text: false, allow_images: false }])}>Add another model</button>
          </fieldset>)}
          <p className="small muted">Model lists come from your account. Listing alone does not verify tool or image support. Enabled providers remain available; agents send requests while doing assigned work.</p>
          <p className="small muted">Up to three assignments run together, using one or several configured models. Agents choose scoped work and return evidence for the lead to check. Stop cancels the team. Additional agents can increase cost.</p>
        </fieldset> : null}

        {section === 'Appearance' ? <div className="settings-section">
          <label className="field-label">Theme
            <div className="chip-row">
              <button className={`chip ${theme === 'dark' ? 'selected' : ''}`} onClick={() => setTheme('dark')}>Dark</button>
              <button className={`chip ${theme === 'light' ? 'selected' : ''}`} onClick={() => setTheme('light')}>Light</button>
            </div>
          </label>
          <p className="small muted">Evidence pages, photographs and video always keep their original colors on a neutral canvas in both themes.</p>
        </div> : null}

        {section === 'About' ? <div className="settings-section">
          <p><strong>VisLex</strong> · local evidence workspace</p>
          <p className="small muted">Cases are stored in .ledcase folders on this machine. Originals are copied, hashed and never modified. AI providers are contacted only when you enable them, and case text or images leave this machine solely through those enabled models. Keys live in Windows Credential Manager. No telemetry, hosted file storage, or runtime model downloads.</p>
          <p className="small muted">Case generation {snapshot.generation} · {snapshot.sources.length} sources · {snapshot.records.length} working files.</p>
        </div> : null}

        {section === 'AI providers' ? <div className="ai-save-footer">
          {error ? <p role="alert" className="small danger-text">{error}</p> : null}
          <div className="modal-footer"><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={!native || busy} onClick={() => void save()}><Save size={15} />{saving ? 'Saving…' : 'Save settings & keys'}</button></div>
        </div> : null}
      </div>
    </div>
  </dialog>;
}
