import { useEffect, useRef, useState } from 'react';
import { KeyRound, Save, Trash2, X } from 'lucide-react';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, defaultConfig, providerNames } from '../aiProfiles';
import AppearanceSettings from './AppearanceSettings';
import type { AIConfig, AIProfile, ModelOption, Provider, Settings, Snapshot } from '../types';

const companies = Object.keys(providerNames) as Provider[];
const sections = ['Providers & models', 'AI permissions', 'Appearance', 'About'] as const;
type Section = typeof sections[number];
type Preferences = { ai_config?: AIConfig; settings: Settings };
type AppPreferences = { configured: boolean; config: AIConfig; settings: Settings };
const emptySettings: Settings = { offline: true, allow_text: false, allow_images: false, model: '' };

function initialProfiles(preferences: Preferences): AIProfile[] {
  const saved = configuredProfiles(preferences as Snapshot);
  // Grants stay exactly as previously chosen; selecting a model alone never
  // confers text or image consent (R04).
  return [...saved, ...companies.filter(provider => !saved.some(p => p.provider === provider)).map(provider => ({ provider, model: '', allow_text: false, allow_images: false }))];
}
export default function SettingsDialog({ snapshot, onClose, refresh }: { snapshot: Snapshot | null; onClose: () => void; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [section, setSection] = useState<Section>('Providers & models');
  const [scope, setScope] = useState<'app' | 'case'>('app');
  const [caseScope, setCaseScope] = useState<'app' | 'case' | null>(null);
  const [appPreferences, setAppPreferences] = useState<AppPreferences | null>(null);
  const [settings, setSettings] = useState<Settings>({ ...(snapshot?.settings ?? emptySettings) });
  const [config, setConfig] = useState<AIConfig>(snapshot?.ai_config ?? defaultConfig);
  const [directMedia, setDirectMedia] = useState<boolean | null>(null);
  const [initialDirectMedia, setInitialDirectMedia] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState(() => initialProfiles(snapshot ?? { settings: emptySettings }));
  const [primary, setPrimary] = useState(() => Math.max(0, initialProfiles(snapshot ?? { settings: emptySettings }).findIndex(p => p.provider === (snapshot?.ai_config ?? defaultConfig).provider && p.model === snapshot?.settings.model)));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [stored, setStored] = useState<Partial<Record<Provider, boolean>>>({});
  const [models, setModels] = useState<Partial<Record<Provider, ModelOption[]>>>({});
  const [loading, setLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<Provider, string>>>({});
  const busy = saving || Object.values(loading).some(Boolean);
  const sessionArgs = snapshot ? caseSessionArgs(snapshot.id, snapshot.session_epoch) : {};
  function showPreferences(next: Preferences) {
    setSettings({ ...next.settings });
    setConfig(next.ai_config ?? defaultConfig);
    const nextProfiles = initialProfiles(next);
    setProfiles(nextProfiles);
    setPrimary(Math.max(0, nextProfiles.findIndex(p => p.provider === (next.ai_config ?? defaultConfig).provider && p.model === next.settings.model)));
  }
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    if (native) {
      api<AppPreferences>('app_ai_settings').then(value => { if (mounted.current) { setAppPreferences(value); showPreferences({ ai_config: value.config, settings: value.settings }); } }).catch(error => { if (mounted.current) setError(String(error)); });
      if (snapshot) api<{scope:'app'|'case'}>('case_ai_scope',caseSessionArgs(snapshot.id,snapshot.session_epoch)).then(value => { if (mounted.current) setCaseScope(value.scope); }).catch(error => { if (mounted.current) setError(String(error)); });
    }
    if (native) companies.forEach(provider => {
      api<{ configured: boolean }>('provider_key_status', { provider }).then(v => { if (mounted.current) setStored(s => ({ ...s, [provider]: v.configured })); }).catch(e => { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); });
    });
    if (native && snapshot) api<{ enabled: boolean }>('direct_media_permission',caseSessionArgs(snapshot.id,snapshot.session_epoch)).then(v => { if (mounted.current) { setDirectMedia(v.enabled); setInitialDirectMedia(v.enabled); } }).catch(() => { if (mounted.current) { setDirectMedia(false); setInitialDirectMedia(false); } });
    return () => { mounted.current = false; };
  }, []);
  function updateProfile(index: number, change: Partial<AIProfile>) { setProfiles(ps => ps.map((p, i) => i === index ? { ...p, ...change } : p)); }
  async function loadModels(provider: Provider) {
    if (loading[provider]) return;
    setLoading(s => ({ ...s, [provider]: true })); setCatalogErrors(s => ({ ...s, [provider]: '' }));
    try {
      if (keys[provider]?.trim()) {
        await api('save_provider_key', { ...sessionArgs, provider, key: keys[provider] });
        if (!mounted.current) return;
        setKeys(s => ({ ...s, [provider]: '' })); setStored(s => ({ ...s, [provider]: true }));
      }
      const result = await api<ModelOption[]>('provider_models', { ...sessionArgs, provider });
      if (mounted.current) { setModels(s => ({ ...s, [provider]: result })); if (!result.length) setCatalogErrors(s => ({ ...s, [provider]: 'No chat models were returned for this account.' })); }
    } catch (e) { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); }
    finally { if (mounted.current) setLoading(s => ({ ...s, [provider]: false })); }
  }
  async function removeKey(provider: Provider) {
    setCatalogErrors(s => ({ ...s, [provider]: '' }));
    try { await api('delete_provider_key', { ...sessionArgs, provider }); if (mounted.current) setStored(s => ({ ...s, [provider]: false })); }
    catch (e) { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); }
  }
  async function save() {
    if (busy) return;
    setSaving(true); setError('');
    try {
      const lead = profiles[primary];
      if (!lead?.model && !settings.offline) throw new Error('Select a default model from one of the company dropdowns.');
      for (const provider of companies) {
        if (keys[provider]?.trim()) { await api('save_provider_key', { ...sessionArgs, provider, key: keys[provider] }); setKeys(s => ({ ...s, [provider]: '' })); setStored(s => ({ ...s, [provider]: true })); }
      }
      if (!settings.offline) {
        const enabled = [...new Set(profiles.filter(p => p.model).map(p => p.provider))];
        for (const provider of enabled) {
          const status = await api<{ configured: boolean }>('provider_key_status', { provider });
          if (!status.configured) throw new Error(`Add an API key for ${providerNames[provider]}, or remove its selected model.`);
        }
      }
      // R04: save precisely the choices shown. Nothing is forced: review mode,
      // execution, per-profile grants, offline state, and case grants persist
      // exactly as configured above.
      if (settings.allow_images && !settings.allow_text) throw new Error('Image analysis always sends accompanying text; grant text before images.');
      const saved = await api<{ current_case_updated?: boolean }>(scope === 'app' ? 'save_app_ai_settings' : 'save_ai_settings', {
        ...(scope === 'case' ? sessionArgs : {}),
        config: { ...config, provider: lead?.model ? lead.provider : config.provider, pool: profiles.filter((p, i) => i !== primary && p.model) },
        settings: { ...settings, model: lead?.model ?? '' },
      });
      if (scope === 'case' && snapshot && directMedia !== null && directMedia !== initialDirectMedia) {
        await api('set_direct_media_permission', { ...sessionArgs, enabled: directMedia });
      }
      if (scope === 'app' && saved?.current_case_updated === false) {
        setError('App settings were saved. This case will adopt them when its current AI task has finished.');
        await refresh();
        return;
      }
      await refresh(); onClose();
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="modal settings-sheet" aria-label="Workspace settings" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="eyebrow">SETTINGS</div>
        {sections.map(item => <button key={item} className={section === item ? 'selected' : ''} onClick={() => setSection(item)}>{item}</button>)}
        <div className="spacer" />
        <button className="quiet" disabled={busy} onClick={onClose}>Close</button>
      </nav>
      <div className="settings-body">
        <div className="settings-heading"><h2>{section}</h2><button className="icon-button" disabled={busy} aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>
        {section !== 'Appearance' && section !== 'About' ? <div className="settings-section">
          <p className="small muted">App AI settings apply to every case that uses app settings. Existing case restrictions stay in place until you choose to use app settings for that case.</p>
          {snapshot ? <div className="chip-row" role="group" aria-label="AI settings scope">
            <button type="button" className={`chip ${scope === 'app' ? 'selected' : ''}`} onClick={() => { setScope('app'); if (appPreferences) showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); }}>App settings</button>
            <button type="button" className={`chip ${scope === 'case' ? 'selected' : ''}`} onClick={() => { setScope('case'); showPreferences(snapshot); }}>This case{caseScope === 'case' ? ' · customized' : ' · uses app settings'}</button>
          </div> : <p className="small muted">Set up AI here before creating or opening a case.</p>}
          {snapshot && scope === 'case' && caseScope === 'case' ? <button type="button" className="quiet" disabled={busy || !appPreferences?.configured} onClick={() => void api('set_case_ai_scope', { ...sessionArgs, scope: 'app' }).then(async () => { setCaseScope('app'); await refresh(); if (appPreferences) { setScope('app'); showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); } }).catch(error => setError(String(error)))}>Return this case to app settings</button> : null}
          {scope === 'case' && caseScope === 'app' ? <p className="small muted">Saving changes here creates a case-specific override.</p> : null}
        </div> : null}

        {section !== 'Appearance' && section !== 'About' ? <fieldset disabled={saving} className="ai-setup-fields">
          {!native ? <p className="notice">AI setup is available in the Windows desktop app. This browser is a preview.</p> : null}
          {section === 'Providers & models' ? <>
            <p className="notice">Select a default model for {scope === 'app' ? 'the app' : 'this case'}. Case restrictions still govern what evidence it may receive.</p>
            <p className="small muted disclosure-open"><KeyRound size={13} /> Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</p>
          </> : null}
          {section === 'AI permissions' ? <fieldset className="provider-card case-permissions"><legend>{scope === 'app' ? 'App AI permissions' : 'Case AI permissions'}{native ? '' : ' (desktop app)'}</legend>
            <label className="field-label">AI dispatch
              <div className="chip-row">
                <button type="button" className={`chip ${!settings.offline ? 'selected' : ''}`} disabled={!native} onClick={() => setSettings(current => ({ ...current, offline: false }))}>Allowed</button>
                <button type="button" className={`chip ${settings.offline ? 'selected' : ''}`} disabled={!native} onClick={() => setSettings(current => ({ ...current, offline: true }))}>Offline — stop new requests</button>
              </div>
            </label>
            <p className="small muted">Going offline refuses new AI requests. A request already in flight may still be completing.</p>
            <div className="provider-grants">
              <label><input type="checkbox" disabled={!native} checked={settings.allow_text} onChange={e => setSettings(current => ({ ...current, allow_text: e.target.checked, allow_images: e.target.checked ? current.allow_images : false }))} /> {scope === 'app' ? 'Inherited case text' : 'Case text'} may be sent to permitted models</label>
              <label><input type="checkbox" disabled={!native || !settings.allow_text} checked={settings.allow_images} onChange={e => setSettings(current => ({ ...current, allow_images: e.target.checked }))} /> {scope === 'app' ? 'Inherited case images' : 'Case images'} may be sent to permitted models</label>
            </div>
            {scope === 'case' && snapshot ? <><label className="field-label">Direct media (Gemini only)
              <div className="chip-row">
                <button type="button" className={`chip ${directMedia === true ? 'selected' : ''}`} disabled={!native || directMedia === null} onClick={() => setDirectMedia(true)}>Permitted — original audio/video may be sent</button>
                <button type="button" className={`chip ${directMedia === false || directMedia === null ? 'selected' : ''}`} disabled={!native} onClick={() => setDirectMedia(false)}>Blocked</button>
              </div>
            </label>
            <p className="small muted">Direct media transmits an original recording (up to 12 MiB) to Gemini when a task needs it. It requires separate, audited case consent.</p></> : null}
          </fieldset> : null}
          {section === 'Providers & models' ? companies.map(provider => <fieldset key={provider} className="provider-card"><legend>{providerNames[provider]}</legend>
            <div className="input-row">
              <input aria-label={`${providerNames[provider]} API key`} type="password" autoComplete="off" value={keys[provider] ?? ''} disabled={loading[provider]} onChange={e => setKeys(s => ({ ...s, [provider]: e.target.value }))} placeholder={stored[provider] ? 'Key saved in Windows Credential Manager' : 'Paste API key'} />
              <button className="secondary" disabled={!native || loading[provider] || (!stored[provider] && !keys[provider]?.trim())} onClick={() => void loadModels(provider)}>{loading[provider] ? 'Loading…' : keys[provider]?.trim() ? 'Save key & load models' : 'Load models'}</button>
              {stored[provider] ? <button className="icon-button" aria-label={`Remove saved ${providerNames[provider]} key`} title="Remove stored key" onClick={() => void removeKey(provider)}><Trash2 size={14} /></button> : null}
            </div>
            {catalogErrors[provider] ? <p role="alert" className="small danger-text">{catalogErrors[provider]}</p> : null}
            {profiles.map((p, i) => p.provider !== provider ? null : <div className="provider-model" key={i}>
              <label>Model<select aria-label={`${providerNames[provider]} model ${i + 1}`} value={p.model} onChange={e => { const first = !profiles.some(x => x.model); updateProfile(i, { model: e.target.value }); if (first) setPrimary(i); }}><option value="">{loading[provider] ? 'Loading models…' : 'Select a model'}</option>{p.model && !models[provider]?.some(m => m.id === p.model) ? <option value={p.model}>{p.model} (saved)</option> : null}{models[provider]?.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} · ${m.id}`}</option>)}</select></label>
              <div className="provider-permissions"><label><input type="radio" name="default-model" checked={primary === i} onChange={() => setPrimary(i)} /> Default chat model</label>{p.model ? <span className="badge">Selected</span> : null}{profiles.filter(x => x.provider === provider).length > 1 && primary !== i ? <button className="quiet" onClick={() => { setProfiles(ps => ps.filter((_, j) => j !== i)); if (primary > i) setPrimary(primary - 1); }}>Remove</button> : null}</div>
              {p.model && primary === i ? <p className="small muted">The default model is governed by the case permissions above — selecting it grants nothing by itself.</p> : null}
              {p.model && primary !== i ? <div className="provider-grants"><label><input type="checkbox" checked={p.allow_text} onChange={e => updateProfile(i, { allow_text: e.target.checked, allow_images: e.target.checked ? p.allow_images : false })} /> May receive case text</label><label><input type="checkbox" checked={p.allow_images} disabled={!p.allow_text} onChange={e => updateProfile(i, { allow_images: e.target.checked })} /> May receive case images</label></div> : null}
            </div>)}
            <button className="quiet" disabled={profiles.length >= 16} onClick={() => setProfiles(ps => [...ps, { provider, model: '', allow_text: false, allow_images: false }])}>Add another model</button>
          </fieldset>) : null}
          {section === 'Providers & models' ? <p className="small muted">Model lists come from your account. Listing alone does not verify tool or image support.</p> : null}
        </fieldset> : null}

        {section === 'Appearance' ? <AppearanceSettings /> : null}

        {section === 'About' ? <div className="settings-section">
          <p><strong>VisLex</strong> · local evidence workspace</p>
          <p className="small muted">Cases are stored in .ledcase folders on this machine. Originals are copied, hashed and never modified. AI providers are contacted only when you enable them, and case text or images leave this machine solely through those enabled models. Keys live in Windows Credential Manager. No telemetry, hosted file storage, or runtime model downloads.</p>
          {snapshot ? <p className="small muted">Case generation {snapshot.generation} · {snapshot.counts?.source_count ?? snapshot.sources.length} sources · {snapshot.counts?.record_count ?? snapshot.records.length} working files.</p> : null}
        </div> : null}

        {section !== 'Appearance' && section !== 'About' ? <div className="ai-save-footer">
          {error ? <p role="alert" className="small danger-text">{error}</p> : null}
          <div className="modal-footer"><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={!native || busy || (scope === 'app' && !appPreferences)} onClick={() => void save()}><Save size={15} />{saving ? 'Saving…' : scope === 'app' ? 'Save app AI settings' : 'Save case AI override'}</button></div>
        </div> : null}
      </div>
    </div>
  </dialog>;
}
