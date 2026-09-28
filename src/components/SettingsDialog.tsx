import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleDashed, Copy, ExternalLink, FileText, Info, KeyRound, Keyboard, LoaderCircle, Lock, LogIn, LogOut, Palette, Plus, RefreshCw, Save, ShieldCheck, Trash2, TriangleAlert, Users, WifiOff, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import { configuredProfiles, defaultConfig, providerNames } from '../aiProfiles';
import { springs } from '../lib/motion';
import { Tooltip } from '../ui';
import AppearanceSettings from './AppearanceSettings';
import ModelSelect from './ModelSelect';
import type { AIConfig, AIProfile, ModelOption, Provider, Settings, Snapshot } from '../types';

const companies = Object.keys(providerNames) as Provider[];
/** Vendor names used in consent and billing sentences: the company that would
 *  receive case material or bill the account. */
export const vendorNames: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google', xai: 'xAI', openrouter: 'OpenRouter' };

export type SettingsSection = 'Appearance' | 'Keyboard & accessibility' | 'Accounts & models' | 'Case permissions' | 'Privacy & offline' | 'Review & execution' | 'About';
const aiSections: SettingsSection[] = ['Accounts & models', 'Case permissions', 'Privacy & offline', 'Review & execution'];
const sectionMeta: Record<SettingsSection, { icon: ReactNode; description: string }> = {
  'Appearance': { icon: <Palette size={16} />, description: 'Theme and density for this computer. Evidence media always keeps its original colors.' },
  'Keyboard & accessibility': { icon: <Keyboard size={16} />, description: 'Shortcuts available across VisLex, and how motion and focus behave.' },
  'Accounts & models': { icon: <KeyRound size={16} />, description: 'Connect provider accounts and choose models. A model being available is not permission to send it case material.' },
  'Case permissions': { icon: <ShieldCheck size={16} />, description: 'What this case currently permits, and whether it follows app settings.' },
  'Privacy & offline': { icon: <Lock size={16} />, description: 'Stop new AI requests, and choose what case material may leave this computer.' },
  'Review & execution': { icon: <Users size={16} />, description: 'How many working contexts an AI task may use, and whether its draft is reviewed.' },
  'About': { icon: <Info size={16} />, description: 'How VisLex stores cases and contacts providers.' },
};

const executionModes: { id: AIConfig['execution']; label: string; description: string }[] = [
  { id: 'single', label: 'Single', description: 'One model works on the task. It cannot delegate assignments.' },
  { id: 'auto', label: 'Agent-directed', description: 'The lead model may delegate focused assignments when a question warrants it.' },
  { id: 'parallel', label: 'Parallel', description: 'Each investigation starts with three assignments: source, timeline and contrary evidence. The lead model may also delegate.' },
];
const reviewModes: { id: AIConfig['review']; label: string; description: string }[] = [
  { id: 'standard', label: 'Standard', description: 'No separate review pass. The draft is returned for your review.' },
  { id: 'independent', label: 'Independent', description: 'A blind reviewer investigates the original question before seeing the draft.' },
  { id: 'challenge', label: 'Challenge', description: 'A blind reviewer, plus a challenge reviewer that tests the draft’s assumptions against the originals.' },
];

type Preferences = { ai_config?: AIConfig; settings: Settings };
type AppPreferences = { configured: boolean; config: AIConfig; settings: Settings };
const emptySettings: Settings = { offline: true, allow_text: false, allow_images: false, model: '' };
type AccessState = { route: 'api_keys' | 'chatgpt_subscription'; subscription?: { model: string; effort: string } | null; subscription_ready: boolean; account_ready: boolean; blocker: string };
type CodexAccount = { connected: boolean; email?: string | null; plan?: string | null; login?: { state: 'pending' | 'complete' | 'failed' | 'expired'; error?: string | null; expires_in_seconds: number } | null };
type CaseAccess = { override: 'app' | 'api_keys' | 'chatgpt_subscription'; effective: 'api_keys' | 'chatgpt_subscription'; selection_override?: boolean; selection?: { model: string; effort: string } | null };
type CodexModel = { id: string; name: string; efforts: string[]; default_effort?: string | null };
type CodexLimits = { rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number }; secondary?: { usedPercent?: number; resetsAt?: number } } };
type ProviderIssue = { message: string; origin: 'status' | 'catalog' | 'remove' };
type Consent = { provider: Provider; text: boolean; images: boolean };

function formatCodexLimits(value: CodexLimits): string {
  const windows = ([['Current window', value.rateLimits?.primary], ['Weekly window', value.rateLimits?.secondary]] as const)
    .filter(([, limit]) => typeof limit?.usedPercent === 'number')
    .map(([label, limit]) => `${label}: ${Math.max(0, 100 - Math.min(100, limit!.usedPercent!))}% remaining${typeof limit?.resetsAt === 'number' ? `; resets ${new Date(limit.resetsAt * 1000).toLocaleString()}` : ''}`);
  return windows.join(' · ') || 'Usage limit detail unavailable';
}

/** Plain-language class for a provider model-list failure. The raw message is
 *  always kept for the disclosure; this only names the likely cause. */
export function classifyProviderError(message: string): string {
  const status = /\bHTTP\s*(\d{3})\b/i.exec(message)?.[1] ?? /\bstatus(?:\s*code)?\s*:?\s*(\d{3})\b/i.exec(message)?.[1];
  const code = status ? Number(status) : 0;
  if (code === 401 || code === 403) return 'Key rejected';
  if (code === 429) return 'Rate limited';
  if (code >= 500 && code < 600) return 'Provider unavailable';
  if (!code && /\b(unauthori[sz]ed|forbidden|invalid api key|incorrect api key)\b/i.test(message)) return 'Key rejected';
  if (!code && /timed out|timeout|could not reach|couldn't reach|network|connection (refused|reset|failed)|dns|unreachable|error sending request/i.test(message)) return 'Couldn’t reach provider';
  return 'Model list error';
}

function initialProfiles(preferences: Preferences): AIProfile[] {
  const saved = configuredProfiles(preferences as Snapshot);
  // Grants stay exactly as previously chosen; selecting a model alone never
  // confers text or image consent (R04).
  return [...saved, ...companies.filter(provider => !saved.some(p => p.provider === provider)).map(provider => ({ provider, model: '', allow_text: false, allow_images: false }))];
}
function primaryIndex(profiles: AIProfile[], preferences: Preferences) {
  return Math.max(0, profiles.findIndex(p => p.provider === (preferences.ai_config ?? defaultConfig).provider && p.model === preferences.settings.model));
}
function preferenceKey(settings: Settings, config: AIConfig, profiles: AIProfile[], primary: number) {
  return JSON.stringify([settings, config.review, config.execution, profiles, primary]);
}

function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean }) {
  return <div className="segmented settings-segmented" role="group" aria-label={label}>
    {options.map(option => <button type="button" key={option.id} aria-pressed={value === option.id} className={value === option.id ? 'selected' : ''} disabled={disabled} onClick={() => onChange(option.id)}>{option.label}</button>)}
  </div>;
}

function SettingsCard({ title, description, icon, actions, children, className = '' }: { title: string; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return <section className={`settings-card ${className}`} aria-labelledby={id}>
    <div className="settings-card-head">
      {icon ? <span className="icon-tile settings-card-icon" aria-hidden="true">{icon}</span> : null}
      <div className="settings-card-text"><h3 id={id}>{title}</h3>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="settings-card-actions">{actions}</div> : null}
    </div>
    {children ? <div className="settings-card-body">{children}</div> : null}
  </section>;
}

export default function SettingsDialog({ snapshot, onClose, refresh, initialSection }: { snapshot: Snapshot | null; onClose: () => void; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; initialSection?: SettingsSection }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const sections: SettingsSection[] = ['Appearance', 'Keyboard & accessibility', 'Accounts & models', ...(snapshot ? ['Case permissions' as const] : []), 'Privacy & offline', 'Review & execution', 'About'];
  const [section, setSectionState] = useState<SettingsSection>(() => initialSection && (initialSection !== 'Case permissions' || snapshot) ? initialSection : 'Accounts & models');
  const [scope, setScope] = useState<'app' | 'case'>('app');
  const scopeRef = useRef<'app' | 'case'>('app');
  const [caseScope, setCaseScope] = useState<'app' | 'case' | null>(null);
  const [appPreferences, setAppPreferences] = useState<AppPreferences | null>(null);
  const [settings, setSettings] = useState<Settings>({ ...(snapshot?.settings ?? emptySettings) });
  const [config, setConfig] = useState<AIConfig>(snapshot?.ai_config ?? defaultConfig);
  const [savedProvider, setSavedProvider] = useState<Provider>((snapshot?.ai_config ?? defaultConfig).provider);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [directMedia, setDirectMedia] = useState<boolean | null>(null);
  const [initialDirectMedia, setInitialDirectMedia] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState(() => initialProfiles(snapshot ?? { settings: emptySettings }));
  const [primary, setPrimary] = useState(() => primaryIndex(initialProfiles(snapshot ?? { settings: emptySettings }), snapshot ?? { settings: emptySettings }));
  const [baseline, setBaseline] = useState(() => { const p = initialProfiles(snapshot ?? { settings: emptySettings }); return preferenceKey({ ...(snapshot?.settings ?? emptySettings) }, snapshot?.ai_config ?? defaultConfig, p, primaryIndex(p, snapshot ?? { settings: emptySettings })); });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [stored, setStored] = useState<Partial<Record<Provider, boolean>>>({});
  const [models, setModels] = useState<Partial<Record<Provider, ModelOption[]>>>({});
  const [loading, setLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [issues, setIssues] = useState<Partial<Record<Provider, ProviderIssue | null>>>({});
  const [confirmRemove, setConfirmRemove] = useState<Provider | null>(null);
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
  const reducedMotion = useReducedMotion();
  function setSection(next: SettingsSection) {
    setSectionState(next);
    body.current?.scrollTo?.({ top: 0 });
  }
  function showPreferences(next: Preferences) {
    const nextSettings = { ...next.settings };
    const nextConfig = next.ai_config ?? defaultConfig;
    const nextProfiles = initialProfiles(next);
    const nextPrimary = primaryIndex(nextProfiles, next);
    setSettings(nextSettings);
    setConfig(nextConfig);
    setSavedProvider(nextConfig.provider);
    setConsent(null);
    setProfiles(nextProfiles);
    setPrimary(nextPrimary);
    setBaseline(preferenceKey(nextSettings, nextConfig, nextProfiles, nextPrimary));
  }
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    if (native) {
      api<AppPreferences>('app_ai_settings').then(value => { if (mounted.current) { setAppPreferences(value); if (scopeRef.current === 'app') showPreferences({ ai_config: value.config, settings: value.settings }); } }).catch(error => { if (mounted.current) setError(String(error)); });
      if (snapshot) api<{scope:'app'|'case'}>('case_ai_scope',caseSessionArgs(snapshot.id,snapshot.session_epoch)).then(value => { if (mounted.current) setCaseScope(value.scope); }).catch(error => { if (mounted.current) setError(String(error)); });
    }
    if (native) companies.forEach(provider => {
      api<{ configured: boolean }>('provider_key_status', { provider }).then(v => { if (mounted.current) setStored(s => ({ ...s, [provider]: v.configured })); }).catch(e => { if (mounted.current) setIssues(s => ({ ...s, [provider]: { message: String(e), origin: 'status' } })); });
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
    setLoading(s => ({ ...s, [provider]: true })); setIssues(s => ({ ...s, [provider]: null }));
    try {
      if (keys[provider]?.trim()) {
        await api('save_provider_key', { ...sessionArgs, provider, key: keys[provider] });
        if (!mounted.current) return;
        setKeys(s => ({ ...s, [provider]: '' })); setStored(s => ({ ...s, [provider]: true }));
      }
      const result = await api<ModelOption[]>('provider_models', { ...sessionArgs, provider });
      if (mounted.current) setModels(s => ({ ...s, [provider]: result }));
    } catch (e) { if (mounted.current) setIssues(s => ({ ...s, [provider]: { message: String(e), origin: 'catalog' } })); }
    finally { if (mounted.current) setLoading(s => ({ ...s, [provider]: false })); }
  }
  async function removeKey(provider: Provider) {
    setIssues(s => ({ ...s, [provider]: null }));
    try {
      await api('delete_provider_key', { ...sessionArgs, provider });
      if (mounted.current) { setStored(s => ({ ...s, [provider]: false })); setModels(s => ({ ...s, [provider]: undefined })); setConfirmRemove(null); }
    }
    catch (e) { if (mounted.current) { setIssues(s => ({ ...s, [provider]: { message: String(e), origin: 'remove' } })); setConfirmRemove(null); } }
  }
  const lead = profiles[primary];
  const effectiveProvider: Provider = lead?.model ? lead.provider : config.provider;
  const providerChanged = effectiveProvider !== savedProvider;
  const activeConsent = consent && consent.provider === effectiveProvider ? consent : null;
  const consentText = !!activeConsent?.text;
  const consentImages = consentText && !!activeConsent?.images;
  async function save() {
    if (busy) return;
    setSaving(true); setError('');
    try {
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
      // A grant is consent for one vendor. When the default vendor changes, the
      // previous grant is never carried over: case text and images are sent
      // only when the person ticked consent naming the new provider.
      const grants = providerChanged ? { allow_text: consentText, allow_images: consentImages } : { allow_text: settings.allow_text, allow_images: settings.allow_images };
      const saved = await api<{ current_case_updated?: boolean }>(scope === 'app' ? 'save_app_ai_settings' : 'save_ai_settings', {
        ...(scope === 'case' ? sessionArgs : {}),
        config: { ...config, provider: lead?.model ? lead.provider : config.provider, pool: profiles.filter((p, i) => i !== primary && p.model) },
        settings: { ...settings, ...grants, model: lead?.model ?? '' },
        ...(providerChanged && consentText ? { grants_for_provider: effectiveProvider } : {}),
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
  function chooseScope(next: 'app' | 'case') {
    scopeRef.current = next; setScope(next);
    if (next === 'app') { if (appPreferences) showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); }
    else if (snapshot) showPreferences(snapshot);
  }
  const dirty = preferenceKey(settings, config, profiles, primary) !== baseline || (directMedia !== null && directMedia !== initialDirectMedia) || Object.values(keys).some(value => value?.trim()) || !!activeConsent;
  const isAI = aiSections.includes(section);
  const scopeNoun = scope === 'app' ? 'the app' : 'this case';

  function providerStatus(provider: Provider): { tone: string; icon: ReactNode; label: string } {
    const issue = issues[provider];
    if (loading[provider]) return { tone: 'accent', icon: <LoaderCircle size={12} className="spin" aria-hidden="true" />, label: 'Loading models…' };
    if (issue) return { tone: 'danger', icon: <TriangleAlert size={12} aria-hidden="true" />, label: issue.origin === 'status' ? 'Key status unavailable' : issue.origin === 'remove' ? 'Key not removed' : classifyProviderError(issue.message) };
    const list = models[provider];
    if (list) return list.length ? { tone: 'success', icon: <CircleCheck size={12} aria-hidden="true" />, label: `${list.length} ${list.length === 1 ? 'model' : 'models'} loaded` } : { tone: 'warning', icon: <TriangleAlert size={12} aria-hidden="true" />, label: 'No models returned' };
    if (stored[provider]) return { tone: 'neutral', icon: <KeyRound size={12} aria-hidden="true" />, label: 'Key stored — not yet checked' };
    return { tone: 'neutral', icon: <CircleDashed size={12} aria-hidden="true" />, label: 'No key' };
  }

  const scopeBar = <div className="settings-scope">
    {snapshot ? <>
      <div className="settings-scope-row">
        <span className="settings-scope-label" id="settings-scope-label">Editing</span>
        <div className="segmented settings-segmented" role="group" aria-label="AI settings scope">
          <button type="button" aria-pressed={scope === 'app'} className={scope === 'app' ? 'selected' : ''} onClick={() => chooseScope('app')}>App settings</button>
          <button type="button" aria-pressed={scope === 'case'} className={scope === 'case' ? 'selected' : ''} onClick={() => chooseScope('case')}>This case{caseScope === 'case' ? ' · customized' : ' · uses app settings'}</button>
        </div>
        {scope === 'case' && caseScope === 'case' ? <button type="button" className="quiet" disabled={busy || !appPreferences?.configured} onClick={() => void api('set_case_ai_scope', { ...sessionArgs, scope: 'app' }).then(async () => { setCaseScope('app'); await refresh(); if (appPreferences) { scopeRef.current = 'app'; setScope('app'); showPreferences({ ai_config: appPreferences.config, settings: appPreferences.settings }); } }).catch(error => setError(String(error)))}>Return this case to app settings</button> : null}
      </div>
      <p className="settings-scope-note">App AI settings apply to every case that uses app settings. Existing case restrictions stay in place until you choose to use app settings for that case.{scope === 'case' && caseScope === 'app' ? ' Saving changes here creates a case-specific override.' : ''}</p>
    </> : <p className="settings-scope-note">App AI settings apply to every case that uses app settings. Existing case restrictions stay in place until you choose to use app settings for that case. Set up AI here before creating or opening a case.</p>}
    {!native ? <p className="notice info settings-preview-note"><Info size={16} aria-hidden="true" /><span>AI setup is available in the Windows desktop app. This browser is a preview.</span></p> : null}
  </div>;

  const routeValue = scope === 'case' ? caseAccess?.override : access?.route;
  const accessCard = <SettingsCard title={scope === 'app' ? 'App AI access' : 'Case AI access'} icon={<KeyRound size={16} />} description="Choose whether new tasks use your API keys or the isolated ChatGPT subscription route.">
    <div className="segmented settings-segmented" role="group" aria-label="AI access route">
      {scope === 'case' ? <button type="button" aria-pressed={routeValue === 'app'} className={routeValue === 'app' ? 'selected' : ''} disabled={!native || codexBusy} onClick={() => void codexAction(() => setRoute('app'))}>Use app default</button> : null}
      <button type="button" aria-pressed={routeValue === 'api_keys'} className={routeValue === 'api_keys' ? 'selected' : ''} disabled={!native || codexBusy} onClick={() => void codexAction(() => setRoute('api_keys'))}>API keys</button>
      <button type="button" aria-pressed={routeValue === 'chatgpt_subscription'} className={routeValue === 'chatgpt_subscription' ? 'selected' : ''} disabled={!native || !access?.subscription_ready || codexBusy} onClick={() => void codexAction(() => setRoute('chatgpt_subscription'))}>ChatGPT subscription</button>
    </div>
    <p className="settings-hint">API usage and ChatGPT subscription usage are separate. The app route is the default for all cases; a case choice affects its new tasks only. Running tasks keep their original route.</p>
    {scope === 'case' && caseAccess ? <p className="settings-fact"><span className="settings-fact-label">Effective route</span><span>Effective route for this case: {caseAccess.effective === 'api_keys' ? 'API keys' : 'ChatGPT subscription'}.</span></p> : null}
    {access && !access.account_ready ? <p className="settings-hint" role="status">This build does not include the isolated Codex runtime. Subscription sign-in is unavailable.</p> : null}
    {!access?.subscription_ready && access ? <p className="settings-hint" role="status">Subscription tasks are disabled: {access.blocker}. API tasks continue normally.</p> : null}
  </SettingsCard>;

  const accountCard = <SettingsCard title="ChatGPT account" icon={<LogIn size={16} />} description={account?.connected ? `${account.email ?? 'Connected'}${account.plan ? ` · ${account.plan}` : ''}` : 'Not connected'}
    actions={<>
      {!account?.connected ? <button type="button" className="secondary" data-size="sm" disabled={!native || !access?.account_ready || codexBusy} onClick={() => void codexAction(async () => {setLogin(await api('codex_account_login'));})}><LogIn size={14} aria-hidden="true" />Sign in with ChatGPT</button> : <button type="button" className="secondary" data-size="sm" disabled={codexBusy} onClick={() => void codexAction(async () => {await api('codex_account_logout');setAccount({connected:false});setCodexModels([]);setCodexLimits('');})}><LogOut size={14} aria-hidden="true" />Sign out</button>}
      <button type="button" className="quiet" disabled={!native || !access?.account_ready || codexBusy} onClick={() => void codexAction(async () => {setAccount(await api('codex_account_status'));})}><RefreshCw size={14} aria-hidden="true" />Refresh status</button>
    </>}>
    <p className="settings-sr-status visually-hidden">ChatGPT account: {account?.connected ? `${account.email ?? 'Connected'}${account.plan ? ` · ${account.plan}` : ''}` : 'Not connected'}</p>
    {login ? <div className="device-code" role="group" aria-label="ChatGPT sign-in code">
      <p className="device-code-step">Enter this code at <a href={login.auth_url} target="_blank" rel="noopener noreferrer">ChatGPT sign-in<ExternalLink size={12} aria-hidden="true" /></a></p>
      <div className="device-code-row"><strong className="device-code-value">{login.user_code}</strong>
        <button type="button" className="secondary" data-size="sm" onClick={() => void navigator.clipboard.writeText(login.user_code).catch(e => setCodexError(String(e)))}><Copy size={14} aria-hidden="true" />Copy code</button>
        <button type="button" className="quiet" onClick={() => void codexAction(async () => {await api('codex_account_cancel_login',{login_id:login.login_id});setLogin(null);})}>Cancel sign-in</button>
      </div>
      <p className="status-line settings-waiting"><span className="activity-dot" aria-hidden="true" />Waiting for you to approve the sign-in{account?.login?.state === 'pending' ? `. Expires in ${Math.ceil(account.login.expires_in_seconds / 60)} min.` : '.'}</p>
    </div> : null}
    {account?.login?.state === 'failed' || account?.login?.state === 'expired' ? <p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" />{account.login.error ?? 'ChatGPT sign-in expired. Start again.'}</p> : null}
    {account?.connected ? <>
      <div className="settings-inline-actions"><button type="button" className="secondary" data-size="sm" disabled={codexBusy} onClick={() => void codexAction(loadCodexModels)}>Load subscription models</button><button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {setCodexLimits(formatCodexLimits(await api<CodexLimits>('codex_account_limits')));})}>Check subscription usage</button></div>
      {codexLimits ? <p className="settings-hint" role="status">{codexLimits}</p> : null}
      {codexModels.length ? <div className="settings-field-row">
        <label className="field-label">Subscription model<select aria-label="ChatGPT subscription model" value={codexModel} onChange={e => {const model=codexModels.find(m => m.id===e.target.value);setCodexModel(e.target.value);setCodexEffort(model?.default_effort ?? model?.efforts[0] ?? '');}}>{codexModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="field-label">Reasoning effort<select aria-label="ChatGPT reasoning effort" value={codexEffort} onChange={e => setCodexEffort(e.target.value)}>{(codexModels.find(m => m.id===codexModel)?.efforts ?? []).map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
        <div className="settings-field-actions">
          <button type="button" className="secondary" disabled={codexBusy || !codexEffort} onClick={() => void codexAction(async () => {if (scope === 'case' && snapshot) {const next=await api<CaseAccess>('save_case_codex_selection',{...sessionArgs,model:codexModel,effort:codexEffort});setCaseAccess(current => current ? {...current,...next} : current);} else {await api('save_codex_selection',{model:codexModel,effort:codexEffort});setAccess(current => current ? {...current,subscription:{model:codexModel,effort:codexEffort}} : null);}})}>{scope === 'case' ? 'Save case model' : 'Save app model'}</button>
          {scope === 'case' && caseAccess?.selection_override ? <button type="button" className="quiet" disabled={codexBusy} onClick={() => void codexAction(async () => {const next=await api<CaseAccess>('save_case_codex_selection',{...sessionArgs,use_app:true});setCaseAccess(current => current ? {...current,...next} : current);})}>Use app model</button> : null}
        </div>
      </div> : null}
    </> : null}
    {codexError ? <p role="alert" className="notice error"><TriangleAlert size={16} aria-hidden="true" /><span>{codexError}</span></p> : null}
  </SettingsCard>;

  const leadSummary = lead?.model ? <><span className="provider-dot" data-provider={lead.provider} aria-hidden="true" /><strong>{lead.model}</strong><span className="settings-muted">· {providerNames[lead.provider]}</span></> : <span className="settings-muted">No default model selected</span>;

  function providerCard(provider: Provider) {
    const status = providerStatus(provider);
    const issue = issues[provider];
    const selected = profiles.map((p, i) => ({ ...p, index: i })).filter(p => p.provider === provider && p.model);
    return <section key={provider} className="settings-card provider-account" aria-label={providerNames[provider]}>
      <div className="settings-card-head">
        <span className="provider-mark" aria-hidden="true"><span className="provider-dot" data-provider={provider} /></span>
        <div className="settings-card-text"><h3>{providerNames[provider]}</h3><p>Billed to your {vendorNames[provider]} API account. A Claude or ChatGPT app subscription is separate and is not used.</p></div>
        <span className={`pill pill-sm tone-${status.tone} provider-status`} role="status">{status.icon}{status.label}</span>
      </div>
      <div className="settings-card-body">
        <div className="provider-key-row">
          <input aria-label={`${providerNames[provider]} API key`} type="password" autoComplete="off" value={keys[provider] ?? ''} disabled={loading[provider]} onChange={e => setKeys(s => ({ ...s, [provider]: e.target.value }))} placeholder={stored[provider] ? 'Key saved in Windows Credential Manager' : 'Paste API key'} />
          <button type="button" className="secondary" disabled={!native || loading[provider] || (!stored[provider] && !keys[provider]?.trim())} onClick={() => void loadModels(provider)}>{loading[provider] ? 'Loading…' : keys[provider]?.trim() ? 'Save key & load models' : 'Load models'}</button>
          {stored[provider] ? <Tooltip text="Remove stored key"><button type="button" className="icon-button" aria-label={`Remove saved ${providerNames[provider]} key`} aria-expanded={confirmRemove === provider} disabled={busy} onClick={() => setConfirmRemove(current => current === provider ? null : provider)}><Trash2 size={16} /></button></Tooltip> : null}
        </div>
        {confirmRemove === provider ? <div className="remove-confirm" role="group" aria-label={`Confirm removing the ${vendorNames[provider]} key`}>
          <TriangleAlert size={16} aria-hidden="true" />
          <div className="remove-confirm-text">
            <strong>Remove the stored {vendorNames[provider]} key?</strong>
            <p>{selected.length ? <>These selected models will stop working until a key is added again: {selected.map((p, i) => <span key={p.index}>{i ? ', ' : ''}<span className="mono">{p.model}</span>{p.index === primary ? ' (default)' : ''}</span>)}.</> : 'No selected models use this key.'} Keys are shared by every case on this computer.</p>
            <div className="remove-confirm-actions"><button type="button" className="secondary" data-size="sm" onClick={() => setConfirmRemove(null)}>Keep key</button><button type="button" className="danger-button" data-size="sm" autoFocus onClick={() => void removeKey(provider)}>Remove key</button></div>
          </div>
        </div> : null}
        {issue ? <div role="alert" className="notice error provider-issue"><TriangleAlert size={16} aria-hidden="true" /><div><strong>{status.label}</strong>{issue.origin === 'catalog' ? <span> · The model list could not be loaded. Check the key and your connection, then retry.</span> : null}<details className="provider-issue-detail"><summary>Show provider message</summary><p className="mono">{issue.message}</p></details></div></div> : null}
        {models[provider] && !models[provider]!.length ? <p className="settings-hint" role="status">No chat models were returned for this account.</p> : null}
        <div className="provider-models">
          {profiles.map((p, i) => p.provider !== provider ? null : <div className={`provider-model ${primary === i && p.model ? 'is-default' : ''}`} key={i}>
            <div className="provider-model-main">
              <ModelSelect label={`${providerNames[provider]} model ${i + 1}`} value={p.model} onChange={model => { const first = !profiles.some(x => x.model); updateProfile(i, { model }); if (first) setPrimary(i); }} options={models[provider] ?? []} loading={loading[provider]} disabled={saving} />
              <label className="provider-default"><input type="radio" name="default-model" checked={primary === i} onChange={() => setPrimary(i)} /> Default chat model</label>
              {profiles.filter(x => x.provider === provider).length > 1 && primary !== i ? <button type="button" className="quiet" onClick={() => { setProfiles(ps => ps.filter((_, j) => j !== i)); if (primary > i) setPrimary(primary - 1); }}>Remove</button> : null}
            </div>
            {p.model && primary === i ? <p className="settings-hint">The default model is governed by the permissions in Privacy &amp; offline — selecting it grants nothing by itself.</p> : null}
            {p.model && primary !== i ? <div className="provider-grants"><span className="provider-grants-label">Additional model permissions</span><label className="check-row"><input type="checkbox" checked={p.allow_text} onChange={e => updateProfile(i, { allow_text: e.target.checked, allow_images: e.target.checked ? p.allow_images : false })} /><span>May receive case text</span></label><label className="check-row"><input type="checkbox" checked={p.allow_images} disabled={!p.allow_text} onChange={e => updateProfile(i, { allow_images: e.target.checked })} /><span>May receive case images</span></label></div> : null}
          </div>)}
        </div>
        <button type="button" className="quiet provider-add" disabled={profiles.length >= 16} onClick={() => setProfiles(ps => [...ps, { provider, model: '', allow_text: false, allow_images: false }])}><Plus size={14} aria-hidden="true" />Add another model</button>
      </div>
    </section>;
  }

  const accountsSection = <>
    <div className="settings-summary" role="group" aria-label="Default model">
      <div className="settings-summary-main"><span className="settings-summary-label">Default model for {scopeNoun}</span><span className="settings-summary-value">{leadSummary}</span></div>
      {providerChanged ? <button type="button" className="quiet" onClick={() => setSection('Privacy & offline')}>Review consent for {vendorNames[effectiveProvider]}</button> : null}
    </div>
    <p className="notice info"><Info size={16} aria-hidden="true" /><span>Select a default model for {scope === 'app' ? 'the app' : 'this case'}. Case restrictions still govern what evidence it may receive. <strong>Available</strong> means a key is stored and the model list loaded; <strong>permitted</strong> means {scopeNoun} allows sending material to that model.</span></p>
    {accessCard}
    {accountCard}
    <h3 className="section-title">API providers <span className="count">{companies.filter(p => stored[p]).length} of {companies.length} with keys</span></h3>
    <p className="settings-hint settings-key-note"><KeyRound size={13} aria-hidden="true" /> Keys are stored in Windows Credential Manager. Loading models contacts that company without sending case evidence.</p>
    <div className="provider-list">{companies.map(providerCard)}</div>
    <p className="settings-hint">Model lists come from your account. Listing alone does not verify tool or image support.</p>
  </>;

  const grantLabelText = scope === 'app' ? 'Inherited case text' : 'Case text';
  const grantLabelImages = scope === 'app' ? 'Inherited case images' : 'Case images';
  const vendor = vendorNames[effectiveProvider];
  const privacySection = <>
    <SettingsCard title={scope === 'app' ? 'App AI permissions' : 'Case AI permissions'} icon={<WifiOff size={16} />} description={`AI dispatch${native ? '' : ' (desktop app)'} — whether ${scopeNoun} may start new AI requests.`}>
      <Segmented label="AI dispatch" value={settings.offline ? 'offline' : 'allowed'} disabled={!native} options={[{ id: 'allowed', label: 'Allowed' }, { id: 'offline', label: 'Offline — stop new requests' }]} onChange={value => setSettings(current => ({ ...current, offline: value === 'offline' }))} />
      <p className="settings-hint">Going offline refuses new AI requests. A request already in flight may still be completing.</p>
    </SettingsCard>
    <SettingsCard title="Case material sent to models" icon={<FileText size={16} />} description={`Default model: ${lead?.model ? `${lead.model} · ${providerNames[lead.provider]}` : 'none selected'}. Only permitted material leaves this computer.`}>
      {providerChanged ? <div className="consent-block" role="group" aria-labelledby="provider-consent-title">
        <div className="notice warning"><TriangleAlert size={16} aria-hidden="true" /><div><strong id="provider-consent-title">The default provider changes from {vendorNames[savedProvider]} to {vendor}.</strong> Consent given for {vendorNames[savedProvider]} does not carry over. Nothing is sent to {vendor} unless you allow it here.</div></div>
        <label className="check-row"><input type="checkbox" disabled={!native} checked={consentText} onChange={e => setConsent({ provider: effectiveProvider, text: e.target.checked, images: e.target.checked ? consentImages : false })} /><span>{scope === 'app' ? `Allow ${vendor} to receive text from cases that use app settings` : `Allow ${vendor} to receive this case's text`}</span></label>
        <label className="check-row"><input type="checkbox" disabled={!native || !consentText} checked={consentImages} onChange={e => setConsent({ provider: effectiveProvider, text: consentText, images: e.target.checked })} /><span>{scope === 'app' ? `Allow ${vendor} to receive images from cases that use app settings` : `Allow ${vendor} to receive this case's images`}</span></label>
        <p className="settings-hint" role="status">{consentText ? `Saving records your consent for ${vendor}${consentImages ? ' for text and images' : ' for text only'}.` : `Saving without this consent turns case text and images off for ${vendor}.`}</p>
      </div> : <div className="grant-list">
        <label className="check-row"><input type="checkbox" disabled={!native} checked={settings.allow_text} onChange={e => setSettings(current => ({ ...current, allow_text: e.target.checked, allow_images: e.target.checked ? current.allow_images : false }))} /><span>{grantLabelText} may be sent to permitted models</span></label>
        <label className="check-row"><input type="checkbox" disabled={!native || !settings.allow_text} checked={settings.allow_images} onChange={e => setSettings(current => ({ ...current, allow_images: e.target.checked }))} /><span>{grantLabelImages} may be sent to permitted models</span></label>
        <p className="settings-hint">Image analysis always sends accompanying text, so images require text. Each additional model has its own permissions in Accounts &amp; models.</p>
      </div>}
    </SettingsCard>
    <SettingsCard title="Stored on this computer" icon={<Lock size={16} />}>
      <ul className="settings-facts">
        <li>Keys live in Windows Credential Manager, never in the case folder.</li>
        <li>Originals are copied, hashed and never modified.</li>
        <li>No telemetry, hosted file storage, or runtime model downloads.</li>
      </ul>
    </SettingsCard>
  </>;

  const caseSection = snapshot ? <>
    <SettingsCard title="Settings source" icon={<ShieldCheck size={16} />} description={caseScope === 'case' ? 'This case has its own AI settings. App changes do not reach it until you return it to app settings.' : caseScope === 'app' ? 'This case uses app settings. Saving under This case creates a case-specific override.' : 'Checking whether this case uses app settings…'}>
      {scope === 'app' ? <button type="button" className="secondary" data-size="sm" onClick={() => chooseScope('case')}>Edit this case’s settings</button> : null}
    </SettingsCard>
    <SettingsCard title="Currently permitted for this case" icon={<CircleCheck size={16} />} description="As last saved. Unsaved changes in these settings are not included.">
      <dl className="kv settings-kv">
        <dt>AI dispatch</dt><dd>{snapshot.settings.offline ? 'Offline — new requests refused' : 'Allowed'}</dd>
        <dt>Default model</dt><dd>{snapshot.settings.model ? `${snapshot.settings.model} · ${providerNames[(snapshot.ai_config ?? defaultConfig).provider]}` : 'None selected'}</dd>
        <dt>Case text</dt><dd>{snapshot.settings.allow_text ? 'Permitted' : 'Not permitted'}</dd>
        <dt>Case images</dt><dd>{snapshot.settings.allow_images ? 'Permitted' : 'Not permitted'}</dd>
        <dt>Direct media</dt><dd>{initialDirectMedia === null ? 'Checking…' : initialDirectMedia ? 'Permitted' : 'Blocked'}</dd>
        {caseAccess ? <><dt>AI route</dt><dd>{caseAccess.effective === 'api_keys' ? 'API keys' : 'ChatGPT subscription'}</dd></> : null}
      </dl>
    </SettingsCard>
    <SettingsCard title={`Direct media (Gemini only)${native ? '' : ' (desktop app)'}`} icon={<ShieldCheck size={16} />} description="Direct media transmits an original recording (up to 12 MiB) to Gemini when a task needs it. It requires separate, audited case consent.">
      {scope === 'case' ? <div className="segmented settings-segmented" role="group" aria-label="Direct media (Gemini only)">
        <button type="button" aria-pressed={directMedia === true} className={directMedia === true ? 'selected' : ''} disabled={!native || directMedia === null} onClick={() => setDirectMedia(true)}>Permitted — original audio/video may be sent</button>
        <button type="button" aria-pressed={directMedia === false || directMedia === null} className={directMedia === false || directMedia === null ? 'selected' : ''} disabled={!native} onClick={() => setDirectMedia(false)}>Blocked</button>
      </div> : <p className="settings-hint">Direct media is always a per-case choice. Choose “This case” above to change it.</p>}
    </SettingsCard>
  </> : null;

  const reviewSection = <>
    <SettingsCard title="Execution" icon={<Users size={16} />} description="Assignments run on the default model and on additional models permitted to receive case text. More assignments use more of your provider usage.">
      <Segmented label="Execution" value={config.execution} disabled={!native} options={executionModes} onChange={value => setConfig(current => ({ ...current, execution: value }))} />
      <p className="settings-choice-description" aria-live="polite">{executionModes.find(mode => mode.id === config.execution)?.description}</p>
    </SettingsCard>
    <SettingsCard title="Review" icon={<ShieldCheck size={16} />} description="An optional review pass after the draft, in separate working contexts.">
      <Segmented label="Review" value={config.review} disabled={!native} options={reviewModes} onChange={value => setConfig(current => ({ ...current, review: value }))} />
      <p className="settings-choice-description" aria-live="polite">{reviewModes.find(mode => mode.id === config.review)?.description}</p>
      <p className="notice"><Info size={16} aria-hidden="true" /><span>Separate working contexts — not independent corroboration or human approval. Agent votes do not resolve disputes; you decide what is accepted.</span></p>
    </SettingsCard>
  </>;

  const shortcutGroups: { title: string; rows: [ReactNode, string][] }[] = [
    { title: 'Anywhere', rows: [
      [<><kbd>Ctrl</kbd><kbd>K</kbd></>, 'Open the command palette'],
      [<><kbd>Ctrl</kbd><kbd>,</kbd></>, 'Open settings'],
      [<><kbd>Ctrl</kbd><kbd>1</kbd>–<kbd>5</kbd></>, 'Chat, Evidence library, Findings, Investigation workbench, Jobs & issues'],
      [<kbd>F2</kbd>, 'Rename the focused case or chat'],
      [<kbd>Esc</kbd>, 'Close the open dialog or menu'],
    ] },
    { title: 'Composer', rows: [
      [<kbd>Enter</kbd>, 'Send'],
      [<><kbd>Shift</kbd><kbd>Enter</kbd></>, 'New line'],
    ] },
    { title: 'Media playback (player focused)', rows: [
      [<><kbd>Space</kbd> or <kbd>K</kbd></>, 'Play or pause'],
      [<><kbd>J</kbd> / <kbd>L</kbd></>, 'Back or forward 10 seconds'],
      [<><kbd>←</kbd> / <kbd>→</kbd></>, 'Back or forward 5 seconds (with Shift: 1 second)'],
      [<><kbd>,</kbd> / <kbd>.</kbd></>, 'Approximate step back or forward'],
      [<><kbd>[</kbd> / <kbd>]</kbd></>, 'Set loop start or end'],
    ] },
  ];
  const keyboardSection = <>
    {shortcutGroups.map(group => <div className="shortcut-group" key={group.title}>
      <h3 className="section-title">{group.title}</h3>
      <table className="shortcut-table"><caption className="visually-hidden">{group.title} shortcuts</caption><thead className="visually-hidden"><tr><th scope="col">Keys</th><th scope="col">Action</th></tr></thead>
        <tbody>{group.rows.map(([keysCell, action]) => <tr key={action}><th scope="row"><span className="shortcut-keys">{keysCell}</span></th><td>{action}</td></tr>)}</tbody>
      </table>
    </div>)}
    <SettingsCard title="Motion and focus" icon={<Keyboard size={16} />}>
      <ul className="settings-facts">
        <li>Reduced motion follows your Windows setting (Settings › Accessibility › Visual effects › Animation effects). {reducedMotion ? 'Motion is currently reduced.' : 'Motion is currently on.'}</li>
        <li>Every control shows a visible focus ring when reached from the keyboard.</li>
        <li>Status changes are announced to screen readers; color is never the only signal.</li>
      </ul>
    </SettingsCard>
  </>;

  const aboutSection = <div className="settings-about">
    <div className="settings-about-brand"><span className="brand-mark" aria-hidden="true"><span/><span/><span/></span><div><p><strong>VisLex</strong> · local evidence workspace</p></div></div>
    <p className="settings-about-text">Cases are stored in .ledcase folders on this machine. Originals are copied, hashed and never modified. AI providers are contacted only when you enable them, and case text or images leave this machine solely through those enabled models. Keys live in Windows Credential Manager. No telemetry, hosted file storage, or runtime model downloads.</p>
    {snapshot ? <p className="settings-hint">Case generation {snapshot.generation} · {snapshot.counts?.source_count ?? snapshot.sources.length} sources · {snapshot.counts?.record_count ?? snapshot.records.length} working files.</p> : null}
  </div>;

  const footerStatus = saving ? <span className="status-line"><LoaderCircle size={14} className="spin" aria-hidden="true" />Saving…</span>
    : providerChanged && !consentText ? <span className="status-line settings-footer-warning"><TriangleAlert size={14} aria-hidden="true" />Case text and images will be off for {vendor} after saving.</span>
    : dirty ? <span className="status-line"><span className="settings-dirty-dot" aria-hidden="true" />Unsaved changes</span>
    : <span className="status-line settings-muted">No unsaved changes</span>;

  return <dialog ref={dialog} className="modal settings-sheet" aria-label="Workspace settings" onCancel={e => { if (busy) e.preventDefault(); else onClose(); }}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {sections.map(item => {
          const groupStart = item === 'Appearance' ? 'Workspace' : item === 'Accounts & models' ? 'AI' : null;
          return <div key={item} className={`settings-nav-slot ${item === 'About' ? 'is-last' : ''}`}>
            {groupStart ? <div className="settings-nav-group" aria-hidden="true">{groupStart}</div> : null}
            <button type="button" className={`settings-nav-item ${section === item ? 'selected' : ''}`} aria-current={section === item ? 'page' : undefined} onClick={() => setSection(item)}>
              {section === item ? <motion.span layoutId="settings-nav-active" className="settings-nav-pill" transition={reducedMotion ? { duration: 0 } : springs.snappy} aria-hidden="true" /> : null}
              <span className="settings-nav-icon" aria-hidden="true">{sectionMeta[item].icon}</span>
              <span className="settings-nav-label">{item}</span>
              {item === 'Privacy & offline' && settings.offline ? <span className="settings-nav-meta" aria-hidden="true">Offline</span> : null}
            </button>
          </div>;
        })}
      </nav>
      <div className="settings-main">
        <header className="settings-heading">
          <div className="settings-heading-text"><h2>{section}</h2><p>{sectionMeta[section].description}</p></div>
          <Tooltip text="Close" shortcut="Esc"><button type="button" className="icon-button" disabled={busy} aria-label="Close settings" onClick={onClose}><X size={18} /></button></Tooltip>
        </header>
        <div className="settings-body" ref={body}>
          {isAI ? scopeBar : null}
          {isAI ? <fieldset disabled={saving} className="ai-setup-fields">
            {section === 'Accounts & models' ? accountsSection : null}
            {section === 'Case permissions' ? caseSection : null}
            {section === 'Privacy & offline' ? privacySection : null}
            {section === 'Review & execution' ? reviewSection : null}
          </fieldset> : null}
          {section === 'Appearance' ? <AppearanceSettings /> : null}
          {section === 'Keyboard & accessibility' ? keyboardSection : null}
          {section === 'About' ? aboutSection : null}
        </div>
        {isAI ? <footer className="ai-save-footer">
          {error ? <p role="alert" className="notice error settings-save-error"><TriangleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
          <div className="settings-footer-row">
            <div className="settings-footer-status" aria-live="polite">{footerStatus}</div>
            <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="primary" disabled={!native || busy || (scope === 'app' && !appPreferences)} onClick={() => void save()}><Save size={15} aria-hidden="true" />{saving ? 'Saving…' : scope === 'app' ? 'Save app AI settings' : 'Save case AI override'}</button>
          </div>
        </footer> : null}
      </div>
    </div>
  </dialog>;
}
