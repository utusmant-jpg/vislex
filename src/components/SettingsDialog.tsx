import { useEffect, useRef, useState, type ReactNode } from 'react';
import BrandMark from './BrandMark';
import {
  AlertTriangle, Cpu, Globe, Info, KeyRound, Keyboard, ListChecks, Lock, Palette, Plus, RefreshCw, Save, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, defaultConfig, providerNames } from '../aiProfiles';
import { springs } from '../lib/motion';
import { StatusPill } from '../ui';
import SecondOpinionGrantCard from '../features/escalation/SecondOpinionGrantCard';
import ResearchSettings from '../features/research/ResearchSettings';
import AppearanceSettings from './AppearanceSettings';
import KeyboardSettings from './KeyboardSettings';
import ModelSelect from './ModelSelect';
import type { AIConfig, AIProfile, ModelOption, Provider, Settings, Snapshot } from '../types';

const companies = Object.keys(providerNames) as Provider[];
export const settingsSections = ['Appearance', 'Keyboard & accessibility', 'Accounts & models', 'Case permissions', 'Privacy & offline', 'Review & processing', 'Research browser', 'About'] as const;
export type SettingsSection = typeof settingsSections[number];
const sectionGroups: { label: string; items: SettingsSection[] }[] = [
  { label: 'AI and evidence', items: ['Accounts & models', 'Case permissions', 'Privacy & offline', 'Review & processing', 'Research browser'] },
  { label: 'Workspace', items: ['Appearance', 'Keyboard & accessibility'] },
  { label: 'VisLex', items: ['About'] },
];
/** Sections that edit AI settings share one draft, one scope and one save. */
const aiSections: SettingsSection[] = ['Accounts & models', 'Case permissions', 'Privacy & offline', 'Review & processing'];
const sectionIcons: Record<SettingsSection, ReactNode> = {
  'Accounts & models': <KeyRound size={16} />,
  'Case permissions': <ShieldCheck size={16} />,
  'Privacy & offline': <Lock size={16} />,
  'Review & processing': <ListChecks size={16} />,
  'Research browser': <Globe size={16} />,
  'Appearance': <Palette size={16} />,
  'Keyboard & accessibility': <Keyboard size={16} />,
  'About': <Info size={16} />,
};
const sectionSummaries: Record<SettingsSection, string> = {
  'Accounts & models': 'Provider keys, subscription sign-in and the models VisLex may call.',
  'Case permissions': 'What case material permitted models may receive.',
  'Privacy & offline': 'Where case data lives and when AI requests may leave this machine.',
  'Review & processing': 'How AI work is checked, and where processing is tracked.',
  'Research browser': 'Your legal research account in the built-in browser, per case.',
  'Appearance': 'Theme and density for this device.',
  'Keyboard & accessibility': 'Shortcuts, focus and motion.',
  'About': 'Local evidence workspace.',
};
const reviewLabels: Record<AIConfig['review'], { name: string; detail: string }> = {
  standard: { name: 'Standard', detail: 'No separate review pass is requested when an investigation completes.' },
  independent: { name: 'Independent check', detail: 'A blind reviewer re-investigates the original question in its own working context before completion.' },
  challenge: { name: 'Challenge', detail: 'A blind reviewer and a challenge reviewer re-inspect the original evidence and propose discriminating checks. Agent votes do not resolve disputes.' },
};
const executionLabels: Record<AIConfig['execution'], { name: string; detail: string }> = {
  single: { name: 'Single agent', detail: 'The investigator works alone and does not delegate assignments.' },
  parallel: { name: 'Parallel team', detail: 'Up to three assignments run together. Agents choose scoped work and return evidence for the lead to check. Stop cancels the team.' },
  auto: { name: 'Let VisLex decide', detail: 'The lead may delegate bounded assignments when useful. Stop cancels the team.' },
};
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

/** A grant is consent for one vendor. When the draft changes the default
 *  company, the backend clears the case text/image grants on save unless the
 *  request names the new vendor (it never does from here), so say so before
 *  the user saves rather than letting ticked boxes silently not persist. */
export function providerChangeNotice(savedProvider: Provider | null, nextProvider: Provider, settings: Settings, keepGrants = false): string | null {
  if (!savedProvider || savedProvider === nextProvider || (!settings.allow_text && !settings.allow_images)) return null;
  if (keepGrants) return `Saving makes ${providerNames[nextProvider]} the default company instead of ${providerNames[savedProvider]}. You confirmed that the grants below also apply to ${providerNames[nextProvider]}, so saving keeps them.`;
  return `Saving makes ${providerNames[nextProvider]} the default company instead of ${providerNames[savedProvider]}. The case text and image grants were given for ${providerNames[savedProvider]}, so saving clears them unless you keep them for ${providerNames[nextProvider]} below.`;
}

export default function SettingsDialog({ snapshot, onClose, refresh, initialSection, initialScope }: { snapshot: Snapshot | null; onClose: () => void; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; initialSection?: SettingsSection; initialScope?: 'app' | 'case' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [section, setSection] = useState<SettingsSection>(initialSection && settingsSections.includes(initialSection) ? initialSection : 'Accounts & models');
  // A link that names "This case" opens on the case's own settings; without a
  // case there is only the app scope.
  const openingScope: 'app' | 'case' = initialScope === 'case' && snapshot ? 'case' : 'app';
  const [scope, setScope] = useState<'app' | 'case'>(openingScope);
  const scopeRef = useRef<'app' | 'case'>(openingScope);
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
  // Explicit consent to keep the shown grants for a new default company. It
  // records the scope and company it was given for, so choosing another
  // company or editing the other scope voids it. It is never pre-set.
  const [grantConsent, setGrantConsent] = useState<{ scope: 'app' | 'case'; provider: Provider } | null>(null);
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
  // Load models and Save mark themselves aria-disabled (their handlers ignore
  // repeat presses) rather than disabled while busy, so they keep keyboard focus.
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
        // Without this the backend clears grants on a company change.
        ...(keepGrants ? { grants_for_provider: nextProvider } : {}),
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
  const reducedMotion = useReducedMotion();
  const isAiSection = aiSections.includes(section);
  const lead = profiles[primary];
  const nextProvider: Provider = lead?.model ? lead.provider : config.provider;
  // The provider the current grants were consented for, as the backend compares it.
  const savedProvider: Provider | null = scope === 'app' ? (appPreferences?.configured ? appPreferences.config.provider : null) : (snapshot?.ai_config?.provider ?? null);
  const companyChange = providerChangeNotice(savedProvider, nextProvider, settings) !== null;
  const keepGrants = companyChange && grantConsent?.scope === scope && grantConsent.provider === nextProvider;
  const grantNotice = providerChangeNotice(savedProvider, nextProvider, settings, keepGrants);
  const routeValue = scope === 'case' ? caseAccess?.override : access?.route;
  const permittedModels = profiles.map((profile, index) => ({ profile, index })).filter(item => item.profile.model);

  const scopeBar = <div className="settings-scope">
    {snapshot ? <div className="settings-scope-row">
      <span className="settings-scope-label" id="settings-scope-label">Editing</span>
      <div className="segmented" role="group" aria-label="AI settings scope">
        <button type="button" className={scope === 'app' ? 'selected' : ''} aria-pressed={scope === 'app'} onClick={() => { scopeRef.current = 'app'; setScope('app'); if (appPreferences) showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); }}>App settings</button>
        <button type="button" className={scope === 'case' ? 'selected' : ''} aria-pressed={scope === 'case'} onClick={() => { scopeRef.current = 'case'; setScope('case'); showPreferences(snapshot); }}>This case{caseScope === 'case' ? ' · customized' : ' · uses app settings'}</button>
      </div>
      {scope === 'case' && caseScope === 'case' ? <button type="button" className="quiet" disabled={busy || !appPreferences?.configured} onClick={() => void api('set_case_ai_scope', { ...sessionArgs, scope: 'app' }).then(async () => { setCaseScope('app'); await refresh(); if (appPreferences) { scopeRef.current = 'app'; setScope('app'); showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); } }).catch(error => setError(String(error)))}><RefreshCw size={14} />Return this case to app settings</button> : null}
    </div> : <p className="settings-scope-row small"><span className="settings-scope-label">Editing</span>App settings · Set up AI here before creating or opening a case.</p>}
    <p className="field-hint">App AI settings apply to every case that uses app settings. Existing case restrictions stay in place until you choose to use app settings for that case.</p>
    {scope === 'case' && caseScope === 'app' ? <p className="field-hint">Saving changes here creates a case-specific override.</p> : null}
  </div>;

  return <dialog ref={dialog} className="modal settings-sheet" aria-label="Workspace settings" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {sectionGroups.map(group => <div className="settings-nav-group" key={group.label}>
          <div className="settings-nav-group-label" aria-hidden="true">{group.label}</div>
          {group.items.map(item => <button key={item} type="button" className={`settings-nav-item ${section === item ? 'selected' : ''}`} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>
            {section === item ? <motion.span layoutId="settings-nav-active" className="settings-nav-pill" transition={reducedMotion ? { duration: 0 } : springs.snappy} aria-hidden="true" /> : null}
            <span className="settings-nav-icon" aria-hidden="true">{sectionIcons[item]}</span>
            <span className="settings-nav-label">{item}</span>
          </button>)}
        </div>)}
        <div className="spacer" />
        <button type="button" className="quiet settings-nav-close" disabled={busy} onClick={onClose}>Close</button>
      </nav>
      <div className="settings-body">
        <header className="settings-heading">
          <div className="settings-heading-text"><h2>{section}</h2><p>{sectionSummaries[section]}</p></div>
          <button type="button" className="icon-button" disabled={busy} aria-label="Close settings" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="settings-scroll" role="region" aria-label={`${section} settings`} tabIndex={0}>
          {isAiSection ? scopeBar : null}
          {isAiSection && !native ? <p className="notice info"><Info size={16} aria-hidden="true" /><span>AI setup is available in the Windows desktop app. This browser is a preview.</span></p> : null}

          {isAiSection ? <fieldset disabled={saving} className="ai-setup-fields">
            {section === 'Accounts & models' ? <>
              <p className="notice info"><ShieldCheck size={16} aria-hidden="true" /><span>Select a default model for {scope === 'app' ? 'the app' : 'this case'}. Case restrictions still govern what evidence it may receive.</span></p>
              <p className="settings-note"><KeyRound size={14} aria-hidden="true" /><span>Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</span></p>

              <section className="settings-card" aria-labelledby="settings-access-title">
                <div className="settings-card-header">
                  <span className="icon-tile" aria-hidden="true"><Cpu size={16} /></span>
                  <div className="settings-card-heading"><h3 id="settings-access-title">{scope === 'app' ? 'App AI access' : 'Case AI access'}</h3><p>Choose how {scope === 'app' ? 'cases that use app settings' : 'this case'} reach AI models.</p></div>
                </div>
                <div className="segmented settings-route" role="group" aria-label="AI access route">
                  {scope === 'case' ? <button type="button" className={caseAccess?.override === 'app' ? 'selected' : ''} aria-pressed={caseAccess?.override === 'app'} disabled={!native || codexBusy} onClick={() => void codexAction(() => setRoute('app'))}>Use app default</button> : null}
                  <button type="button" className={routeValue === 'api_keys' ? 'selected' : ''} aria-pressed={routeValue === 'api_keys'} disabled={!native || codexBusy} onClick={() => void codexAction(() => setRoute('api_keys'))}>API keys</button>
                  <button type="button" className={routeValue === 'chatgpt_subscription' ? 'selected' : ''} aria-pressed={routeValue === 'chatgpt_subscription'} disabled={!native || !access?.subscription_ready || codexBusy} onClick={() => void codexAction(() => setRoute('chatgpt_subscription'))}>ChatGPT subscription</button>
                </div>
                <p className="field-hint">API usage and ChatGPT subscription usage are separate. The app route is the default for all cases; a case choice affects its new tasks only. Running tasks keep their original route.</p>
                {scope === 'case' && caseAccess ? <p className="settings-fact">Effective route for this case: {caseAccess.effective === 'api_keys' ? 'API keys' : 'ChatGPT subscription'}.</p> : null}
                {access && !access.account_ready ? <p className="field-hint" role="status">This build does not include the isolated Codex runtime. Subscription sign-in is unavailable.</p> : null}
                {!access?.subscription_ready && access ? <p className="field-hint" role="status">Subscription tasks are disabled: {access.blocker}. API tasks continue normally.</p> : null}
                <div className="settings-account">
                  <div className="settings-account-status">
                    <span className="small">ChatGPT account: {account?.connected ? `${account.email ?? 'Connected'}${account.plan ? ` · ${account.plan}` : ''}` : 'Not connected'}</span>
                    {account?.connected ? <StatusPill state="complete" label="Connected" small /> : null}
                  </div>
                  <div className="settings-account-actions">
                    {!account?.connected ? <button type="button" className="secondary" data-size="sm" disabled={!native || !access?.account_ready || codexBusy} onClick={() => void codexAction(async () => {setLogin(await api('codex_account_login'));})}>Sign in with ChatGPT</button> : <button type="button" className="secondary" data-size="sm" disabled={codexBusy} onClick={() => void codexAction(async () => {await api('codex_account_logout');setAccount({connected:false});setCodexModels([]);setCodexLimits('');})}>Sign out</button>}
                    <button type="button" className="quiet" disabled={!native || !access?.account_ready || codexBusy} onClick={() => void codexAction(async () => {setAccount(await api('codex_account_status'));})}><RefreshCw size={14} />Refresh status</button>
                  </div>
                </div>
                {login ? <div className="settings-device-code">
                  <p className="small">Enter code <strong className="device-code">{login.user_code}</strong> at <a href={login.auth_url} target="_blank" rel="noopener noreferrer">ChatGPT sign-in</a>.{account?.login?.state === 'pending' ? ` Expires in ${Math.ceil(account.login.expires_in_seconds / 60)} min.` : null}</p>
                  <div className="settings-inline-actions"><button type="button" className="quiet" onClick={() => void navigator.clipboard.writeText(login.user_code).catch(e => setCodexError(String(e)))}>Copy code</button><button type="button" className="quiet" onClick={() => void codexAction(async () => {await api('codex_account_cancel_login',{login_id:login.login_id});setLogin(null);})}>Cancel sign-in</button></div>
                </div> : null}
                {account?.login?.state === 'failed' || account?.login?.state === 'expired' ? <p role="alert" className="small danger-text">{account.login.error ?? 'ChatGPT sign-in expired. Start again.'}</p> : null}
                {account?.connected ? <div className="settings-subscription">
                  <div className="settings-inline-actions"><button type="button" className="secondary" data-size="sm" disabled={codexBusy} onClick={() => void codexAction(loadCodexModels)}>Load subscription models</button><button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {setCodexLimits(formatCodexLimits(await api<CodexLimits>('codex_account_limits')));})}>Check subscription usage</button></div>
                  {codexLimits ? <p className="settings-fact" role="status">{codexLimits}</p> : null}
                  {codexModels.length ? <div className="settings-subscription-fields"><label className="field-label">Subscription model<select aria-label="ChatGPT subscription model" value={codexModel} onChange={e => {const model=codexModels.find(m => m.id===e.target.value);setCodexModel(e.target.value);setCodexEffort(model?.default_effort ?? model?.efforts[0] ?? '');}}>{codexModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="field-label">Reasoning effort<select aria-label="ChatGPT reasoning effort" value={codexEffort} onChange={e => setCodexEffort(e.target.value)}>{(codexModels.find(m => m.id===codexModel)?.efforts ?? []).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label><div className="settings-inline-actions"><button type="button" className="secondary" disabled={codexBusy || !codexEffort} onClick={() => void codexAction(async () => {if (scope === 'case' && snapshot) {const next=await api<CaseAccess>('save_case_codex_selection',{...sessionArgs,model:codexModel,effort:codexEffort});setCaseAccess(current => current ? {...current,...next} : current);} else {await api('save_codex_selection',{model:codexModel,effort:codexEffort});setAccess(current => current ? {...current,subscription:{model:codexModel,effort:codexEffort}} : null);}})}>{scope === 'case' ? 'Save case model' : 'Save app model'}</button>{scope === 'case' && caseAccess?.selection_override ? <button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {const next=await api<CaseAccess>('save_case_codex_selection',{...sessionArgs,use_app:true});setCaseAccess(current => current ? {...current,...next} : current);})}>Use app model</button> : null}</div></div> : null}
                </div> : null}
                {codexError ? <p role="alert" className="small danger-text">{codexError}</p> : null}
              </section>

              <h3 className="section-title">API keys and models</h3>
              {companies.map(provider => <fieldset key={provider} className="settings-provider">
                <legend className="settings-provider-legend"><span className="provider-dot" data-provider={provider} aria-hidden="true" /><span className="settings-provider-name">{providerNames[provider]}</span>
                  {catalogErrors[provider] ? <StatusPill state="failed" label="Key issue" small /> : stored[provider] ? <StatusPill state="complete" label="Key saved" small /> : <StatusPill state="unreviewed" label="No key" small />}
                </legend>
                <div className="settings-key-row">
                  <input aria-label={`${providerNames[provider]} API key`} type="password" autoComplete="off" value={keys[provider] ?? ''} disabled={loading[provider]} onChange={e => setKeys(s => ({ ...s, [provider]: e.target.value }))} placeholder={stored[provider] ? 'Key saved in Windows Credential Manager' : 'Paste API key'} />
                  <button type="button" className="secondary" disabled={!native || (!loading[provider] && !stored[provider] && !keys[provider]?.trim())} aria-disabled={loading[provider] || undefined} onClick={() => void loadModels(provider)}>{loading[provider] ? 'Loading…' : keys[provider]?.trim() ? 'Save key & load models' : 'Load models'}</button>
                  {stored[provider] ? <button type="button" className="icon-button" aria-label={`Remove saved ${providerNames[provider]} key`} title="Remove stored key" onClick={() => void removeKey(provider)}><Trash2 size={16} /></button> : null}
                </div>
                {catalogErrors[provider] ? <p role="alert" className="small danger-text">{catalogErrors[provider]}</p> : null}
                {profiles.map((p, i) => p.provider !== provider ? null : <div className="settings-model" key={i}>
                  <div className="settings-model-row">
                    <label className="settings-model-select"><span>Model</span><ModelSelect
                      label={`${providerNames[provider]} model ${i + 1}`}
                      value={p.model}
                      onChange={model => { const first = !profiles.some(x => x.model); updateProfile(i, { model }); if (first) setPrimary(i); }}
                      options={models[provider] ?? []}
                      loading={loading[provider]}
                      disabled={saving}
                    /></label>
                    <label className="settings-default-choice"><input type="radio" name="default-model" checked={primary === i} onChange={() => setPrimary(i)} /> Default chat model</label>
                    {profiles.filter(x => x.provider === provider).length > 1 && primary !== i ? <button type="button" className="quiet" onClick={() => { setProfiles(ps => ps.filter((_, j) => j !== i)); if (primary > i) setPrimary(primary - 1); }}>Remove</button> : null}
                  </div>
                  {p.model && primary === i ? <p className="field-hint">The default model is governed by the case permissions in Case permissions — selecting it grants nothing by itself.</p> : null}
                  {p.model && primary !== i ? <div className="settings-grants-inline"><label><input type="checkbox" checked={p.allow_text} onChange={e => updateProfile(i, { allow_text: e.target.checked, allow_images: e.target.checked ? p.allow_images : false })} /> May receive case text</label><label><input type="checkbox" checked={p.allow_images} disabled={!p.allow_text} onChange={e => updateProfile(i, { allow_images: e.target.checked })} /> May receive case images</label></div> : null}
                </div>)}
                <button type="button" className="quiet settings-add-model" disabled={profiles.length >= 16} onClick={() => setProfiles(ps => [...ps, { provider, model: '', allow_text: false, allow_images: false }])}><Plus size={14} />Add another model</button>
              </fieldset>)}
              <p className="field-hint">Model lists come from your account. Listing alone does not verify tool or image support.</p>
            </> : null}

            {section === 'Case permissions' ? <>
              <div className="notice info settings-authorization"><ShieldCheck size={16} aria-hidden="true" /><div><strong>Model availability is not case authorization.</strong><p>A model that is configured, listed or selected receives nothing from a case unless the grants below allow it. Changing the theme, density or the selected model never broadens these grants.</p></div></div>
              <section className="settings-card" aria-labelledby="settings-grants-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-grants-title">{scope === 'app' ? 'App AI permissions' : 'Case AI permissions'}{native ? '' : ' (desktop app)'}</h3><p>{scope === 'app' ? 'Grants that cases using app settings inherit for the default model.' : 'Grants for this case’s default model.'}</p></div></div>
                <div className="settings-grants">
                  <label className="settings-check"><input type="checkbox" disabled={!native} checked={settings.allow_text} onChange={e => setSettings(current => ({ ...current, allow_text: e.target.checked, allow_images: e.target.checked ? current.allow_images : false }))} /><span>{scope === 'app' ? 'Inherited case text' : 'Case text'} may be sent to permitted models</span></label>
                  <label className="settings-check"><input type="checkbox" disabled={!native || !settings.allow_text} checked={settings.allow_images} onChange={e => setSettings(current => ({ ...current, allow_images: e.target.checked }))} /><span>{scope === 'app' ? 'Inherited case images' : 'Case images'} may be sent to permitted models</span></label>
                  <p className="field-hint">Image analysis always sends accompanying text, so images require the text grant.</p>
                </div>
                {grantNotice ? <p className="notice warning settings-grant-notice" role="status"><AlertTriangle size={16} aria-hidden="true" /><span>{grantNotice}</span></p> : null}
                {companyChange ? <label className="settings-check settings-grant-consent"><input type="checkbox" disabled={!native} checked={keepGrants} onChange={e => setGrantConsent(e.target.checked ? { scope, provider: nextProvider } : null)} /><span>Keep these grants for {providerNames[nextProvider]}: {scope === 'app' ? 'inherited case text' : 'case text'}{settings.allow_images ? ' and images' : ''} may be sent to {providerNames[nextProvider]}</span></label> : null}
              </section>
              {scope === 'case' && snapshot ? <section className="settings-card" aria-labelledby="settings-media-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-media-title">Direct media (Gemini only)</h3><p>Direct media transmits an original recording (up to 12 MiB) to Gemini when a task needs it. It requires separate, audited case consent.</p></div></div>
                <div className="segmented settings-media" role="group" aria-label="Direct media (Gemini only)">
                  <button type="button" className={directMedia === true ? 'selected' : ''} aria-pressed={directMedia === true} disabled={!native || directMedia === null} onClick={() => setDirectMedia(true)}>Permitted — original audio/video may be sent</button>
                  <button type="button" className={directMedia === false || directMedia === null ? 'selected' : ''} aria-pressed={directMedia === false || directMedia === null} disabled={!native} onClick={() => setDirectMedia(false)}>Blocked</button>
                </div>
              </section> : null}
              <section className="settings-card" aria-labelledby="settings-pool-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-pool-title">Selected models</h3><p>Each additional model carries its own grants, set in Accounts &amp; models.</p></div><div className="card-actions"><button type="button" className="quiet" onClick={() => setSection('Accounts & models')}>Edit models</button></div></div>
                {permittedModels.length ? <ul className="settings-grant-list">{permittedModels.map(({ profile, index }) => <li key={index}>
                  <span className="provider-dot" data-provider={profile.provider} aria-hidden="true" />
                  <span className="settings-grant-model"><span className="settings-grant-name" title={profile.model}>{profile.model}</span><span className="settings-grant-provider">{providerNames[profile.provider]}{index === primary ? ' · default' : ''}</span></span>
                  {index === primary
                    ? <span className="settings-grant-state">Uses the grants above</span>
                    : <span className="settings-grant-pills">
                      {profile.allow_text ? <StatusPill state="accepted" label="Text allowed" small /> : <StatusPill state="protected" label="No text" small />}
                      {profile.allow_images ? <StatusPill state="accepted" label="Images allowed" small /> : <StatusPill state="protected" label="No images" small />}
                    </span>}
                </li>)}</ul> : <p className="settings-empty">No model is selected, so no case material can be sent.</p>}
              </section>
            </> : null}

            {section === 'Privacy & offline' ? <>
              <section className="settings-card" aria-labelledby="settings-dispatch-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-dispatch-title">AI dispatch</h3><p>Going offline refuses new AI requests. A request already in flight may still be completing.</p></div>{settings.offline ? <StatusPill state="stopped" label="Offline" small /> : <StatusPill state="complete" label="Allowed" small />}</div>
                <div className="segmented" role="group" aria-label="AI dispatch">
                  <button type="button" className={!settings.offline ? 'selected' : ''} aria-pressed={!settings.offline} disabled={!native} onClick={() => setSettings(current => ({ ...current, offline: false }))}>Allowed</button>
                  <button type="button" className={settings.offline ? 'selected' : ''} aria-pressed={settings.offline} disabled={!native} onClick={() => setSettings(current => ({ ...current, offline: true }))}>Offline — stop new requests</button>
                </div>
              </section>
              {native && snapshot ? <SecondOpinionGrantCard caseId={snapshot.id} sessionEpoch={snapshot.session_epoch} /> : null}
              <section className="settings-card" aria-labelledby="settings-data-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-data-title">Where case data lives</h3></div></div>
                <ul className="settings-facts">
                  <li>Cases are stored in .ledcase folders on this machine. Originals are copied, hashed and never modified.</li>
                  <li>AI providers are contacted only when you enable them, and case text or images leave this machine solely through those enabled models.</li>
                  <li>Saved API keys live in Windows Credential Manager, not in case folders. This window is only told whether a key is saved.</li>
                  <li>OpenRouter requests are sent with its data-collection preference set to deny.</li>
                  <li>No telemetry, hosted file storage, or runtime model downloads.</li>
                </ul>
              </section>
            </> : null}

            {section === 'Review & processing' ? <>
              <section className="settings-card" aria-labelledby="settings-review-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-review-title">Review mode</h3><p>Kept exactly as configured for {scope === 'app' ? 'the app' : 'this case'} when you save. This build has no control to change it.</p></div></div>
                <dl className="settings-kv">
                  <div><dt>Review</dt><dd><strong>{reviewLabels[config.review]?.name ?? config.review}</strong><span>{reviewLabels[config.review]?.detail}</span></dd></div>
                  <div><dt>Execution</dt><dd><strong>{executionLabels[config.execution]?.name ?? config.execution}</strong><span>{executionLabels[config.execution]?.detail}</span></dd></div>
                </dl>
                <p className="field-hint">Separate working contexts — not independent corroboration or human approval. Assignments inherit the case grants; findings stay unreviewed until you accept or reject them.</p>
              </section>
              <section className="settings-card" aria-labelledby="settings-processing-title">
                <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-processing-title">Processing</h3><p>Imports are processed as jobs. Progress, failures with their receipts, and cancellation are in Jobs &amp; issues (Ctrl 5).</p></div></div>
                <p className="field-hint">Processing status does not certify evidence review. Token usage for AI work is reported in each chat turn, and a running task can be stopped there.</p>
              </section>
            </> : null}
          </fieldset> : null}

          {section === 'Research browser' ? <ResearchSettings snapshot={snapshot} /> : null}
          {section === 'Appearance' ? <AppearanceSettings /> : null}
          {section === 'Keyboard & accessibility' ? <KeyboardSettings /> : null}

          {section === 'About' ? <div className="settings-section settings-about">
            <div className="settings-about-brand"><BrandMark size={28} /><p><strong>VisLex</strong> · local evidence workspace</p></div>
            <p className="small muted">Cases are stored in .ledcase folders on this machine. Originals are copied, hashed and never modified. AI providers are contacted only when you enable them, and case text or images leave this machine solely through those enabled models. Keys live in Windows Credential Manager. No telemetry, hosted file storage, or runtime model downloads.</p>
            {snapshot ? <dl className="settings-kv compact">
              <div><dt>Case generation</dt><dd>{snapshot.generation}</dd></div>
              <div><dt>Sources</dt><dd>{(snapshot.counts?.source_count ?? snapshot.sources.length).toLocaleString()}</dd></div>
              <div><dt>Working files</dt><dd>{(snapshot.counts?.record_count ?? snapshot.records.length).toLocaleString()}</dd></div>
            </dl> : null}
          </div> : null}
        </div>

        {isAiSection ? <footer className="settings-footer">
          {grantNotice && section !== 'Case permissions' ? <p className="settings-footer-warning" role="status"><AlertTriangle size={14} aria-hidden="true" /><span>{keepGrants ? `Saving changes the default company to ${providerNames[nextProvider]} and keeps the grants you confirmed for it.` : 'Saving changes the default company and clears case grants.'} <button type="button" className="settings-link" onClick={() => setSection('Case permissions')}>Review case permissions</button></span></p> : null}
          {error ? <p role="alert" className="small danger-text">{error}</p> : null}
          <div className="settings-footer-actions"><span className="settings-footer-scope">{scope === 'app' ? 'Saving updates app AI settings' : 'Saving updates this case only'}</span><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!native || (scope === 'app' && !appPreferences)} aria-disabled={busy || undefined} onClick={() => void save()}><Save size={16} />{saving ? 'Saving…' : scope === 'app' ? 'Save app AI settings' : 'Save case AI override'}</button></div>
        </footer> : null}
      </div>
    </div>
  </dialog>;
}
