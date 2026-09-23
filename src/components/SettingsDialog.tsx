import { useEffect, useRef, useState } from 'react';
import { KeyRound, Save, Trash2, X } from 'lucide-react';
import { api, native } from '../bridge';
import { configuredProfiles, defaultConfig, providerNames } from '../aiProfiles';
import { useTheme } from '../ui';
import type { AIConfig, AIProfile, ModelOption, Provider, Settings, Snapshot } from '../types';

const companies = Object.keys(providerNames) as Provider[];
const sections = ['AI providers', 'Appearance', 'About'] as const;
type Section = typeof sections[number];
type AccessState = { route: 'api_keys' | 'chatgpt_subscription'; subscription?: { model: string; effort: string } | null; subscription_ready: boolean; blocker: string };
type CodexAccount = { connected: boolean; email?: string | null; plan?: string | null };
type CodexModel = { id: string; name: string; efforts: string[]; default_effort?: string | null };

function initialProfiles(snapshot: Snapshot): AIProfile[] {
  const saved = configuredProfiles(snapshot);
  // Grants stay exactly as previously chosen; selecting a model alone never
  // confers text or image consent (R04).
  return [...saved, ...companies.filter(provider => !saved.some(p => p.provider === provider)).map(provider => ({ provider, model: '', allow_text: false, allow_images: false }))];
}
export default function SettingsDialog({ snapshot, onClose, refresh }: { snapshot: Snapshot; onClose: () => void; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<Section>('AI providers');
  const [settings, setSettings] = useState<Settings>({ ...snapshot.settings });
  const [config, setConfig] = useState<AIConfig>(snapshot.ai_config ?? defaultConfig);
  const [directMedia, setDirectMedia] = useState<boolean | null>(null);
  const [initialDirectMedia, setInitialDirectMedia] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState(() => initialProfiles(snapshot));
  const [primary, setPrimary] = useState(() => Math.max(0, initialProfiles(snapshot).findIndex(p => p.provider === (snapshot.ai_config ?? defaultConfig).provider && p.model === snapshot.settings.model)));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [stored, setStored] = useState<Partial<Record<Provider, boolean>>>({});
  const [models, setModels] = useState<Partial<Record<Provider, ModelOption[]>>>({});
  const [loading, setLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<Provider, string>>>({});
  const [access, setAccess] = useState<AccessState | null>(null);
  const [account, setAccount] = useState<CodexAccount | null>(null);
  const [login, setLogin] = useState<{ login_id: string; auth_url: string } | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState('');
  const [codexLimits, setCodexLimits] = useState('');
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState('');
  const busy = saving || Object.values(loading).some(Boolean);
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    companies.forEach(provider => {
      api<{ configured: boolean }>('provider_key_status', { provider }).then(v => { if (mounted.current) setStored(s => ({ ...s, [provider]: v.configured })); }).catch(e => { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); });
    });
    if (native) {
      api<AccessState>('ai_access_route').then(v => { if (mounted.current) {setAccess(v);setCodexModel(v.subscription?.model ?? '');setCodexEffort(v.subscription?.effort ?? '');} }).catch(e => {if (mounted.current) setCodexError(String(e));});
      api<CodexAccount>('codex_account_status').then(v => {if (mounted.current) setAccount(v);}).catch(e => {if (mounted.current) setCodexError(String(e));});
    }
    if (native) api<{ enabled: boolean }>('direct_media_permission').then(v => { if (mounted.current) { setDirectMedia(v.enabled); setInitialDirectMedia(v.enabled); } }).catch(() => { if (mounted.current) { setDirectMedia(false); setInitialDirectMedia(false); } });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!login || account?.connected) return;
    const timer = window.setInterval(() => {
      api<CodexAccount>('codex_account_status').then(v => {if (mounted.current) {setAccount(v);if (v.connected) setLogin(null);}}).catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [login, account?.connected]);
  async function codexAction(action: () => Promise<void>) {
    if (codexBusy) return;
    setCodexBusy(true); setCodexError('');
    try { await action(); } catch (e) { if (mounted.current) setCodexError(String(e)); }
    finally { if (mounted.current) setCodexBusy(false); }
  }
  async function loadCodexModels() {
    const result = await api<CodexModel[]>('codex_account_models');
    if (mounted.current) {
      setCodexModels(result);
      const selected = result.find(m => m.id === codexModel) ?? result[0];
      setCodexModel(selected?.id ?? '');
      setCodexEffort(selected?.efforts.includes(codexEffort) ? codexEffort : selected?.default_effort ?? selected?.efforts[0] ?? '');
    }
  }
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
      // R04: save precisely the choices shown. Nothing is forced: review mode,
      // execution, per-profile grants, offline state, case grants, budget and
      // prices all persist exactly as configured above.
      if (settings.allow_images && !settings.allow_text) throw new Error('Image analysis always sends accompanying text; grant text before images.');
      await api('save_ai_settings', {
        config: { ...config, provider: lead.provider, pool: profiles.filter((p, i) => i !== primary && p.model) },
        settings: { ...settings, model: lead.model },
      });
      if (directMedia !== null && directMedia !== initialDirectMedia) {
        await api('set_direct_media_permission', { enabled: directMedia });
      }
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
          <fieldset className="provider-card"><legend>OpenAI access route</legend>
            <div className="chip-row">
              <button type="button" className={`chip ${access?.route === 'api_keys' ? 'selected' : ''}`} disabled={!native || codexBusy} onClick={() => void codexAction(async () => {const v = await api<AccessState>('set_ai_access_route',{route:'api_keys'});setAccess(current => current ? {...current,route:v.route} : null);})}>API keys</button>
              <button type="button" className={`chip ${access?.route === 'chatgpt_subscription' ? 'selected' : ''}`} disabled={!native || !access?.subscription_ready || codexBusy} onClick={() => void codexAction(async () => {const v = await api<AccessState>('set_ai_access_route',{route:'chatgpt_subscription'});setAccess(current => current ? {...current,route:v.route} : null);})}>ChatGPT subscription</button>
            </div>
            <p className="small muted">API usage and ChatGPT subscription usage are separate. The selected route applies to all new AI tasks; no task switches routes automatically.</p>
            {!access?.subscription_ready && access ? <p className="small muted" role="status">Subscription tasks are disabled: {access.blocker}. API tasks continue normally.</p> : null}
            <div className="input-row">
              <span className="small">ChatGPT account: {account?.connected ? `${account.email ?? 'Connected'}${account.plan ? ` · ${account.plan}` : ''}` : 'Not connected'}</span>
              {!account?.connected ? <button type="button" className="secondary" disabled={!native || codexBusy} onClick={() => void codexAction(async () => {setLogin(await api('codex_account_login'));})}>Sign in with ChatGPT</button> : <button type="button" className="secondary" disabled={codexBusy} onClick={() => void codexAction(async () => {await api('codex_account_logout');setAccount({connected:false});setCodexModels([]);setCodexLimits('');})}>Sign out</button>}
              <button type="button" className="quiet" disabled={!native || codexBusy} onClick={() => void codexAction(async () => {setAccount(await api('codex_account_status'));})}>Refresh status</button>
            </div>
            {login ? <p className="small">Finish sign-in in your browser: <a href={login.auth_url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a> <button type="button" className="quiet" onClick={() => void codexAction(async () => {await api('codex_account_cancel_login',{login_id:login.login_id});setLogin(null);})}>Cancel sign-in</button></p> : null}
            {account?.connected ? <>
              <div className="input-row"><button type="button" className="secondary" disabled={codexBusy} onClick={() => void codexAction(loadCodexModels)}>Load subscription models</button><button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {const v = await api<{rateLimits?:{primary?:{usedPercent?:number}}}>('codex_account_limits');setCodexLimits(typeof v.rateLimits?.primary?.usedPercent === 'number' ? `${v.rateLimits.primary.usedPercent}% of current Codex window used` : 'Usage limit detail unavailable');})}>Check subscription usage</button></div>
              {codexLimits ? <p className="small muted" role="status">{codexLimits}</p> : null}
              {codexModels.length ? <div className="input-row"><label className="field-label">Subscription model<select aria-label="ChatGPT subscription model" value={codexModel} onChange={e => {const model=codexModels.find(m => m.id===e.target.value);setCodexModel(e.target.value);setCodexEffort(model?.default_effort ?? model?.efforts[0] ?? '');}}>{codexModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="field-label">Reasoning effort<select aria-label="ChatGPT reasoning effort" value={codexEffort} onChange={e => setCodexEffort(e.target.value)}>{(codexModels.find(m => m.id===codexModel)?.efforts ?? []).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label><button type="button" className="secondary" disabled={codexBusy || !codexEffort} onClick={() => void codexAction(async () => {await api('save_codex_selection',{model:codexModel,effort:codexEffort});setAccess(current => current ? {...current,subscription:{model:codexModel,effort:codexEffort}} : null);})}>Save subscription model</button></div> : null}
            </> : null}
            {codexError ? <p role="alert" className="small danger-text">{codexError}</p> : null}
          </fieldset>
          <p className="notice">Saved once for all cases. Selecting a model makes it available — what it may see is decided by the case permissions below, not by the selection. VisLex chooses when to delegate among permitted models.</p>
          <p className="small muted disclosure-open"><KeyRound size={13} /> Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</p>
          <fieldset className="provider-card case-permissions"><legend>Case permissions{native ? '' : ' (desktop app)'}</legend>
            <label className="field-label">AI dispatch
              <div className="chip-row">
                <button type="button" className={`chip ${!settings.offline ? 'selected' : ''}`} disabled={!native} onClick={() => setSettings(current => ({ ...current, offline: false }))}>Allowed</button>
                <button type="button" className={`chip ${settings.offline ? 'selected' : ''}`} disabled={!native} onClick={() => setSettings(current => ({ ...current, offline: true }))}>Offline — stop new requests</button>
              </div>
            </label>
            <p className="small muted">Going offline refuses new AI requests immediately; a request already in flight may still be completing. Reopening a case never changes these choices.</p>
            <div className="provider-grants">
              <label><input type="checkbox" disabled={!native} checked={settings.allow_text} onChange={e => setSettings(current => ({ ...current, allow_text: e.target.checked, allow_images: e.target.checked ? current.allow_images : false }))} /> Case text may be sent to permitted models</label>
              <label><input type="checkbox" disabled={!native || !settings.allow_text} checked={settings.allow_images} onChange={e => setSettings(current => ({ ...current, allow_images: e.target.checked }))} /> Case images may be sent to permitted models</label>
            </div>
            <div className="input-row">
              <label className="field-label">Review mode
                <select disabled={!native} value={config.review} onChange={e => setConfig(current => ({ ...current, review: e.target.value as AIConfig['review'] }))}>
                  <option value="standard">Standard</option>
                  <option value="independent">Independent check</option>
                  <option value="challenge">Challenge</option>
                </select>
              </label>
              <label className="field-label">Parallel work
                <select disabled={!native} value={config.execution} onChange={e => setConfig(current => ({ ...current, execution: e.target.value as AIConfig['execution'] }))}>
                  <option value="single">Single agent</option>
                  <option value="parallel">Parallel team</option>
                  <option value="auto">Let VisLex decide</option>
                </select>
              </label>
            </div>
            <label className="field-label">Direct media (Gemini only)
              <div className="chip-row">
                <button type="button" className={`chip ${directMedia === true ? 'selected' : ''}`} disabled={!native || directMedia === null} onClick={() => setDirectMedia(true)}>Permitted — original audio/video may be sent</button>
                <button type="button" className={`chip ${directMedia === false || directMedia === null ? 'selected' : ''}`} disabled={!native} onClick={() => setDirectMedia(false)}>Blocked</button>
              </div>
            </label>
            <p className="small muted">Direct media transmits an original recording (up to 12 MiB) to Gemini when a task needs it. It is a separate, audited consent; disabling it blocks future transmission only.</p>
            <div className="input-row">
              <label className="field-label">Case budget (USD)<input type="number" min={0} max={10000} step="0.01" disabled={!native} value={settings.case_budget} onChange={e => setSettings(current => ({ ...current, case_budget: Number(e.target.value) }))} /></label>
              <label className="field-label">Input $/M tokens<input type="number" min={0} max={10000} step="0.01" disabled={!native} value={settings.input_per_million} onChange={e => setSettings(current => ({ ...current, input_per_million: Number(e.target.value) }))} /></label>
              <label className="field-label">Output $/M tokens<input type="number" min={0} max={10000} step="0.01" disabled={!native} value={settings.output_per_million} onChange={e => setSettings(current => ({ ...current, output_per_million: Number(e.target.value) }))} /></label>
            </div>
            <p className="small muted">Budget and prices feed the live usage indicator; they never cap or mute visibility of spending, and cancelling a run is always available.</p>
          </fieldset>
          {companies.map(provider => <fieldset key={provider} className="provider-card"><legend>{providerNames[provider]}</legend>
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
              {p.model && primary !== i ? <div className="provider-grants"><label><input type="checkbox" checked={p.allow_text} onChange={e => updateProfile(i, { allow_text: e.target.checked, allow_images: e.target.checked ? p.allow_images : false })} /> May receive case text</label><label><input type="checkbox" checked={p.allow_images} disabled={!p.allow_text} onChange={e => updateProfile(i, { allow_images: e.target.checked })} /> May receive case images</label><span className="small muted">applies to delegated team work</span></div> : null}
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
