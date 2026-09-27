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
type AccessState = { route: 'api_keys' | 'chatgpt_subscription'; subscription?: { model: string; effort: string } | null; subscription_ready: boolean; account_ready: boolean; blocker: string };
type CodexAccount = { connected: boolean; email?: string | null; plan?: string | null; login?: { state: 'pending' | 'complete' | 'failed' | 'expired'; error?: string | null; expires_in_seconds: number } | null };
type CaseAccess = { override: 'app' | 'api_keys' | 'chatgpt_subscription'; effective: 'api_keys' | 'chatgpt_subscription'; selection_override?: boolean; selection?: { model: string; effort: string } | null };
type CodexModel = { id: string; name: string; efforts: string[]; default_effort?: string | null };
type CodexLimits = { rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number }; secondary?: { usedPercent?: number; resetsAt?: number } } };

function formatCodexLimits(value: CodexLimits): string {
  const windows = ([['Current window', value.rateLimits?.primary], ['Weekly window', value.rateLimits?.secondary]] as const)
    .filter(([, limit]) => typeof limit?.usedPercent === 'number')
    .map(([label, limit]) => `${label}: ${Math.max(0, 100 - Math.min(100, limit!.usedPercent!))}% remaining${typeof limit?.resetsAt === 'number' ? `; resets ${new Date(limit.resetsAt * 1000).toLocaleString()}` : ''}`);
  return windows.join(' · ') || 'Usage limit detail unavailable';
}

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
  const scopeRef = useRef<'app' | 'case'>('app');
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
  const [access, setAccess] = useState<AccessState | null>(null);
  const [caseAccess, setCaseAccess] = useState<CaseAccess | null>(null);
  const [account, setAccount] = useState<CodexAccount | null>(null);
  const [login, setLogin] = useState<{ login_id: string; auth_url: string; user_code: string } | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState('');
  const [codexLimits, setCodexLimits] = useState('');
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState('');
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
      api<AppPreferences>('app_ai_settings').then(value => { if (mounted.current) { setAppPreferences(value); if (scopeRef.current === 'app') showPreferences({ ai_config: value.config, settings: value.settings }); } }).catch(error => { if (mounted.current) setError(String(error)); });
      if (snapshot) api<{scope:'app'|'case'}>('case_ai_scope',caseSessionArgs(snapshot.id,snapshot.session_epoch)).then(value => { if (mounted.current) setCaseScope(value.scope); }).catch(error => { if (mounted.current) setError(String(error)); });
    }
    if (native) companies.forEach(provider => {
      api<{ configured: boolean }>('provider_key_status', { provider }).then(v => { if (mounted.current) setStored(s => ({ ...s, [provider]: v.configured })); }).catch(e => { if (mounted.current) setCatalogErrors(s => ({ ...s, [provider]: String(e) })); });
    });
    if (native && snapshot) api<{ enabled: boolean }>('direct_media_permission',caseSessionArgs(snapshot.id,snapshot.session_epoch)).then(v => { if (mounted.current) { setDirectMedia(v.enabled); setInitialDirectMedia(v.enabled); } }).catch(() => { if (mounted.current) { setDirectMedia(false); setInitialDirectMedia(false); } });
    if (native && snapshot) api<CaseAccess>('case_ai_access_route',caseSessionArgs(snapshot.id,snapshot.session_epoch)).then(v => {if (mounted.current) setCaseAccess(v);}).catch(e => {if (mounted.current) setCodexError(String(e));});
    if (native) {
      api<AccessState>('ai_access_route').then(v => {
        if (!mounted.current) return;
        setAccess(v);setCodexModel(v.subscription?.model ?? '');setCodexEffort(v.subscription?.effort ?? '');
        if (v.account_ready) api<CodexAccount>('codex_account_status').then(account => {if (mounted.current) setAccount(account);}).catch(e => {if (mounted.current) setCodexError(String(e));});
      }).catch(e => {if (mounted.current) setCodexError(String(e));});
    }
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!login || account?.connected) return;
    const timer = window.setInterval(() => {
      api<CodexAccount>('codex_account_status').then(v => {if (mounted.current) {setAccount(v);if (v.connected || v.login?.state === 'expired' || v.login?.state === 'failed') setLogin(null);}}).catch(e => {if (mounted.current) setCodexError(String(e));});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [login, account?.connected]);
  useEffect(() => {
    const selection = scope === 'case' ? caseAccess?.selection ?? access?.subscription : access?.subscription;
    setCodexModel(selection?.model ?? '');
    setCodexEffort(selection?.effort ?? '');
  }, [scope, caseAccess?.selection, access?.subscription]);
  async function codexAction(action: () => Promise<void>) {
    if (codexBusy) return;
    setCodexBusy(true); setCodexError('');
    try { await action(); } catch (e) { if (mounted.current) setCodexError(String(e)); }
    finally { if (mounted.current) setCodexBusy(false); window.dispatchEvent(new Event('vislex:ai-access-changed')); }
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
  async function setRoute(route: 'app' | 'api_keys' | 'chatgpt_subscription') {
    if (scope === 'case' && snapshot) {
      const next = await api<CaseAccess>('set_case_ai_access_route',{...sessionArgs,route});
      setCaseAccess(next);
    } else if (route !== 'app') {
      const next = await api<AccessState>('set_ai_access_route',{route});
      setAccess(current => current ? {...current,route:next.route} : null);
      if (caseAccess?.override === 'app') setCaseAccess({override:'app',effective:next.route});
    }
  }
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
      const subscription = (scope === 'case' ? caseAccess?.effective : access?.route) === 'chatgpt_subscription';
      if (!lead?.model && !settings.offline && !subscription) throw new Error('Select a default model from one of the company dropdowns.');
      for (const provider of companies) {
        if (keys[provider]?.trim()) { await api('save_provider_key', { ...sessionArgs, provider, key: keys[provider] }); setKeys(s => ({ ...s, [provider]: '' })); setStored(s => ({ ...s, [provider]: true })); }
      }
      if (!settings.offline && !subscription) {
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
            <button type="button" className={`chip ${scope === 'app' ? 'selected' : ''}`} onClick={() => { scopeRef.current = 'app'; setScope('app'); if (appPreferences) showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); }}>App settings</button>
            <button type="button" className={`chip ${scope === 'case' ? 'selected' : ''}`} onClick={() => { scopeRef.current = 'case'; setScope('case'); showPreferences(snapshot); }}>This case{caseScope === 'case' ? ' · customized' : ' · uses app settings'}</button>
          </div> : <p className="small muted">Set up AI here before creating or opening a case.</p>}
          {snapshot && scope === 'case' && caseScope === 'case' ? <button type="button" className="quiet" disabled={busy || !appPreferences?.configured} onClick={() => void api('set_case_ai_scope', { ...sessionArgs, scope: 'app' }).then(async () => { setCaseScope('app'); await refresh(); if (appPreferences) { scopeRef.current = 'app'; setScope('app'); showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); } }).catch(error => setError(String(error)))}>Return this case to app settings</button> : null}
          {scope === 'case' && caseScope === 'app' ? <p className="small muted">Saving changes here creates a case-specific override.</p> : null}
        </div> : null}

        {section !== 'Appearance' && section !== 'About' ? <fieldset disabled={saving} className="ai-setup-fields">
          {!native ? <p className="notice">AI setup is available in the Windows desktop app. This browser is a preview.</p> : null}
          {section === 'Providers & models' ? <>
            <p className="notice">Select a default model for {scope === 'app' ? 'the app' : 'this case'}. Case restrictions still govern what evidence it may receive.</p>
            <p className="small muted disclosure-open"><KeyRound size={13} /> Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</p>
          </> : null}
          {section === 'Providers & models' ? <fieldset className="provider-card"><legend>{scope === 'app' ? 'App AI access' : 'Case AI access'}</legend>
            <div className="chip-row">
              {scope === 'case' ? <button type="button" className={`chip ${caseAccess?.override === 'app' ? 'selected' : ''}`} disabled={!native || codexBusy} onClick={() => void codexAction(() => setRoute('app'))}>Use app default</button> : null}
              <button type="button" className={`chip ${(scope === 'case' ? caseAccess?.override : access?.route) === 'api_keys' ? 'selected' : ''}`} disabled={!native || codexBusy} onClick={() => void codexAction(() => setRoute('api_keys'))}>API keys</button>
              <button type="button" className={`chip ${(scope === 'case' ? caseAccess?.override : access?.route) === 'chatgpt_subscription' ? 'selected' : ''}`} disabled={!native || !access?.subscription_ready || codexBusy} onClick={() => void codexAction(() => setRoute('chatgpt_subscription'))}>ChatGPT subscription</button>
            </div>
            <p className="small muted">API usage and ChatGPT subscription usage are separate. The app route is the default for all cases; a case choice affects its new tasks only. Running tasks keep their original route.</p>
            {scope === 'case' && caseAccess ? <p className="small muted">Effective route for this case: {caseAccess.effective === 'api_keys' ? 'API keys' : 'ChatGPT subscription'}.</p> : null}
            {access && !access.account_ready ? <p className="small muted" role="status">This build does not include the isolated Codex runtime. Subscription sign-in is unavailable.</p> : null}
            {!access?.subscription_ready && access ? <p className="small muted" role="status">Subscription tasks are disabled: {access.blocker}. API tasks continue normally.</p> : null}
            <div className="input-row">
              <span className="small">ChatGPT account: {account?.connected ? `${account.email ?? 'Connected'}${account.plan ? ` · ${account.plan}` : ''}` : 'Not connected'}</span>
              {!account?.connected ? <button type="button" className="secondary" disabled={!native || !access?.account_ready || codexBusy} onClick={() => void codexAction(async () => {setLogin(await api('codex_account_login'));})}>Sign in with ChatGPT</button> : <button type="button" className="secondary" disabled={codexBusy} onClick={() => void codexAction(async () => {await api('codex_account_logout');setAccount({connected:false});setCodexModels([]);setCodexLimits('');})}>Sign out</button>}
              <button type="button" className="quiet" disabled={!native || !access?.account_ready || codexBusy} onClick={() => void codexAction(async () => {setAccount(await api('codex_account_status'));})}>Refresh status</button>
            </div>
            {login ? <p className="small">Enter code <strong>{login.user_code}</strong> at <a href={login.auth_url} target="_blank" rel="noopener noreferrer">ChatGPT sign-in</a>. <button type="button" className="quiet" onClick={() => void navigator.clipboard.writeText(login.user_code).catch(e => setCodexError(String(e)))}>Copy code</button> <button type="button" className="quiet" onClick={() => void codexAction(async () => {await api('codex_account_cancel_login',{login_id:login.login_id});setLogin(null);})}>Cancel sign-in</button>{account?.login?.state === 'pending' ? ` Expires in ${Math.ceil(account.login.expires_in_seconds / 60)} min.` : null}</p> : null}
            {account?.login?.state === 'failed' || account?.login?.state === 'expired' ? <p role="alert" className="small danger-text">{account.login.error ?? 'ChatGPT sign-in expired. Start again.'}</p> : null}
            {account?.connected ? <>
              <div className="input-row"><button type="button" className="secondary" disabled={codexBusy} onClick={() => void codexAction(loadCodexModels)}>Load subscription models</button><button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {setCodexLimits(formatCodexLimits(await api<CodexLimits>('codex_account_limits')));})}>Check subscription usage</button></div>
              {codexLimits ? <p className="small muted" role="status">{codexLimits}</p> : null}
              {codexModels.length ? <div className="input-row"><label className="field-label">Subscription model<select aria-label="ChatGPT subscription model" value={codexModel} onChange={e => {const model=codexModels.find(m => m.id===e.target.value);setCodexModel(e.target.value);setCodexEffort(model?.default_effort ?? model?.efforts[0] ?? '');}}>{codexModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="field-label">Reasoning effort<select aria-label="ChatGPT reasoning effort" value={codexEffort} onChange={e => setCodexEffort(e.target.value)}>{(codexModels.find(m => m.id===codexModel)?.efforts ?? []).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label><button type="button" className="secondary" disabled={codexBusy || !codexEffort} onClick={() => void codexAction(async () => {if (scope === 'case' && snapshot) {const next=await api<CaseAccess>('save_case_codex_selection',{...sessionArgs,model:codexModel,effort:codexEffort});setCaseAccess(current => current ? {...current,...next} : current);} else {await api('save_codex_selection',{model:codexModel,effort:codexEffort});setAccess(current => current ? {...current,subscription:{model:codexModel,effort:codexEffort}} : null);}})}>{scope === 'case' ? 'Save case model' : 'Save app model'}</button>{scope === 'case' && caseAccess?.selection_override ? <button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {const next=await api<CaseAccess>('save_case_codex_selection',{...sessionArgs,use_app:true});setCaseAccess(current => current ? {...current,...next} : current);})}>Use app model</button> : null}</div> : null}
            </> : null}
            {codexError ? <p role="alert" className="small danger-text">{codexError}</p> : null}
          </fieldset> : null}
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
