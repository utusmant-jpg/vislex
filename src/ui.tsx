// Design-system primitives shared by every surface: status pills, tooltips, menus,
// popovers, toasts, skeletons, theme, model picker. Hand-rolled to stay offline.
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, CircleDashed, Copy, History, LoaderCircle, Lock,
  Moon, Search, Sun, XCircle,
} from 'lucide-react';
import { api, citationParts } from './bridge';
import { configuredProfiles, profileKey, providerNames } from './aiProfiles';
import type { AIProfile, Snapshot } from './types';

/* ---------------------------------- status --------------------------------- */

export type PillState =
  | 'unreviewed' | 'running' | 'queued' | 'paused' | 'complete' | 'accepted' | 'failed'
  | 'interrupted' | 'stale' | 'protected' | 'restricted' | 'needs-attention' | 'cancelled';

const pillTone: Record<PillState, string> = {
  unreviewed: 'neutral', running: 'accent', queued: 'accent', paused: 'neutral', complete: 'success',
  accepted: 'success', failed: 'danger', interrupted: 'danger', stale: 'warning',
  protected: 'neutral', restricted: 'restricted', 'needs-attention': 'warning', cancelled: 'neutral',
};

function pillIcon(state: PillState, size: number) {
  switch (state) {
    case 'running': case 'queued': return <LoaderCircle size={size} className="spin" />;
    case 'complete': case 'accepted': return <CheckCircle2 size={size} />;
    case 'failed': return <XCircle size={size} />;
    case 'interrupted': return <AlertTriangle size={size} />;
    case 'stale': case 'needs-attention': return <History size={size} />;
    case 'protected': case 'restricted': return <Lock size={size} />;
    default: return <CircleDashed size={size} />;
  }
}

export function StatusPill({ state, label, small }: { state: PillState; label: string; small?: boolean }) {
  return <span className={`pill tone-${pillTone[state]} ${small ? 'pill-sm' : ''}`}>{pillIcon(state, small ? 11 : 12)}{label}</span>;
}

/* ---------------------------------- time ----------------------------------- */

export function useNow(active: unknown, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 45_000) return 'just now';
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Date(ms > 0 ? Date.now() - ms : Date.parse(iso)).toLocaleDateString();
}

export function formatClock(seconds: number, withMs = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const base = `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(Math.floor(s)).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}` : base;
}

/* --------------------------------- tooltip --------------------------------- */

export function Tooltip({ text, shortcut, children }: { text: string; shortcut?: string; children: ReactElement }) {
  const id = useId();
  const [point, setPoint] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<number>(0);
  const target = useRef<HTMLElement | null>(null);
  const original = children.props as {
    onMouseEnter?: (event: React.MouseEvent) => void; onMouseLeave?: (event: React.MouseEvent) => void;
    onFocus?: (event: React.FocusEvent) => void; onBlur?: (event: React.FocusEvent) => void;
    onKeyDown?: (event: React.KeyboardEvent) => void; ref?: React.Ref<HTMLElement>;
    'aria-describedby'?: string;
  };
  const show = (immediate: boolean) => {
    window.clearTimeout(timer.current);
    const display = () => {
      const rect = target.current?.getBoundingClientRect();
      if (rect) setPoint({ x: Math.max(12, Math.min(window.innerWidth - 12, rect.left + rect.width / 2)), y: rect.top < 48 ? rect.bottom : rect.top, below: rect.top < 48 });
    };
    if (immediate) display(); else timer.current = window.setTimeout(display, 400);
  };
  const hide = () => { window.clearTimeout(timer.current); setPoint(null); };
  useEffect(() => {
    window.addEventListener('scroll', hide, true);
    return () => { window.clearTimeout(timer.current); window.removeEventListener('scroll', hide, true); };
  }, []);
  return <>
    {cloneElement(children, {
      ref: (node: HTMLElement | null) => {
        target.current = node;
        if (typeof original.ref === 'function') original.ref(node);
        else if (original.ref && 'current' in original.ref) original.ref.current = node;
      },
      'aria-describedby': point ? [original['aria-describedby'], id].filter(Boolean).join(' ') : original['aria-describedby'],
      onMouseEnter: (event: React.MouseEvent) => { original.onMouseEnter?.(event); show(false); },
      onMouseLeave: (event: React.MouseEvent) => { original.onMouseLeave?.(event); hide(); },
      onFocus: (event: React.FocusEvent) => { original.onFocus?.(event); show(true); },
      onBlur: (event: React.FocusEvent) => { original.onBlur?.(event); hide(); },
      onKeyDown: (event: React.KeyboardEvent) => { original.onKeyDown?.(event); if (event.key === 'Escape') hide(); },
    } as Record<string, unknown>)}
    {point ? createPortal(
      <div id={id} className="tooltip" role="tooltip" style={{ left: point.x, top: point.y }} data-below={point.below}>
        {text}{shortcut ? <kbd>{shortcut}</kbd> : null}
      </div>, document.body) : null}
  </>;
}

/* ----------------------------- menus and popovers --------------------------- */

export type MenuItem =
  | { label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | 'separator';

function menuNode(items: MenuItem[], close: () => void, highlight: number, setHighlight: (index: number) => void) {
  const selectable: number[] = [];
  const body = items.map((item, index) => {
    if (item === 'separator') return <div className="menu-separator" role="separator" key={index} />;
    if (!item.disabled) selectable.push(index);
    return <button
      key={index}
      className={`menu-item ${item.danger ? 'danger' : ''} ${highlight === index ? 'highlighted' : ''}`}
      role="menuitem"
      disabled={item.disabled}
      onMouseEnter={() => setHighlight(index)}
      onClick={() => { close(); item.onSelect(); }}>
      {item.icon}{item.label}{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
    </button>;
  });
  return { body, selectable };
}

export function MenuPanel({ items, onClose, style, className }: { items: MenuItem[]; onClose: () => void; style?: React.CSSProperties; className?: string }) {
  const [highlight, setHighlight] = useState(-1);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }, []);
  const { body, selectable } = menuNode(items, onClose, highlight, setHighlight);
  const move = (direction: 1 | -1) => {
    if (!selectable.length) return;
    const position = selectable.indexOf(highlight);
    const next = position === -1 ? (direction === 1 ? 0 : selectable.length - 1) : selectable[(position + direction + selectable.length) % selectable.length];
    setHighlight(next);
  };
  return createPortal(<>
    <div className="menu-scrim" onClick={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div
      className={`menu-panel ${className ?? ''}`}
      style={style}
      role="menu"
      aria-label="Actions"
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        else if (event.key === 'Enter' && highlight >= 0) { event.preventDefault(); const item = items[highlight]; onClose(); if (item !== 'separator' && !item.disabled) item.onSelect(); }
      }}
      tabIndex={-1}
      ref={node => node?.focus()}>
      {body}
    </div>
  </>, document.body);
}

export function ContextMenu({ items, children }: { items: MenuItem[]; children: ReactElement }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const original = children.props as { onContextMenu?: (event: React.MouseEvent) => void; onKeyDown?: (event: React.KeyboardEvent) => void };
  const clamped = (x: number, y: number) => ({ x: Math.min(x, window.innerWidth - 230), y: Math.min(y, window.innerHeight - 40 - items.length * 34) });
  return <>
    {cloneElement(children, {
      onContextMenu: (event: React.MouseEvent) => {
        original.onContextMenu?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        setPoint(clamped(event.clientX, event.clientY));
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        original.onKeyDown?.(event);
        if (event.defaultPrevented || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setPoint(clamped(rect.left + 12, rect.bottom));
      },
    } as Record<string, unknown>)}
    {point ? <MenuPanel items={items} onClose={() => setPoint(null)} style={{ left: point.x, top: point.y, position: 'fixed' }} /> : null}
  </>;
}

export function AnchoredPopover({ anchor, onClose, children, className, align = 'start' }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; className?: string; align?: 'start' | 'end';
}) {
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const left = align === 'end' ? Math.max(8, rect.right - 340) : rect.left;
    setStyle({ position: 'fixed', left: Math.min(left, window.innerWidth - 356), top: Math.min(rect.bottom + 6, window.innerHeight - 120), width: 340 });
  }, [anchor, align]);
  if (!anchor || !style) return null;
  return createPortal(<>
    <div className="menu-scrim" onClick={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div className={`popover-panel ${className ?? ''}`} style={style}>{children}</div>
  </>, document.body);
}

/* ---------------------------------- toasts --------------------------------- */

export type ToastKind = 'error' | 'success' | 'info';
type ToastEntry = { id: number; kind: ToastKind; title: string; detail?: string; action?: { label: string; run: () => void } };
type Listener = (toasts: ToastEntry[]) => void;
let toastState: ToastEntry[] = [];
let toastListeners: Listener[] = [];
let toastId = 1;

function emit() { for (const listener of toastListeners) listener(toastState); }

function push(kind: ToastKind, title: string, detail?: string, action?: ToastEntry['action'], sticky = kind === 'error') {
  const existing = toastState.find(toast => toast.kind === kind && toast.title === title && toast.detail === detail);
  if (existing) return existing.id;
  const id = toastId++;
  toastState = [...toastState.slice(-2), { id, kind, title, detail, action }];
  emit();
  if (!sticky) window.setTimeout(() => dismiss(id), 6000);
  return id;
}

function dismiss(id: number) { toastState = toastState.filter(toast => toast.id !== id); emit(); }

export const notify = {
  error: (title: string, detail?: string) => push('error', title, detail),
  success: (title: string, detail?: string, action?: ToastEntry['action']) => push('success', title, detail, action),
  info: (title: string, detail?: string) => push('info', title, detail),
  fromError: (prefix: string, error: unknown) => push('error', prefix, String(error)),
  dismiss,
};

export function ToastStack() {
  const [toasts, setToasts] = useState(toastState);
  useEffect(() => { toastListeners = [...toastListeners, setToasts]; return () => { toastListeners = toastListeners.filter(listener => listener !== setToasts); }; }, []);
  return createPortal(<div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
    {toasts.map(toast => <div className={`toast toast-${toast.kind}`} key={toast.id}>
      <div className="toast-body">
        <strong>{toast.title}</strong>
        {toast.detail ? <details className="toast-detail"><summary>Show detail</summary><span>{toast.detail}</span></details> : null}
      </div>
      {toast.action ? <button className="toast-action" onClick={() => { toast.action?.run(); dismiss(toast.id); }}>{toast.action.label}</button> : null}
      <button className="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>✕</button>
    </div>)}
  </div>, document.body);
}

/* --------------------------------- skeletons -------------------------------- */

export function Skeleton({ className, height }: { className?: string; height?: number }) {
  return <div className={`skeleton ${className ?? ''}`} style={height ? { height } : undefined} />;
}

export function SkeletonPage() {
  return <div className="skeleton-page" aria-hidden="true">
    <Skeleton className="skeleton-title" />
    {Array.from({ length: 9 }, (_, index) => <Skeleton key={index} height={12} className={index % 4 === 3 ? 'skeleton-short' : ''} />)}
  </div>;
}

/* ---------------------------------- theme ---------------------------------- */

export type ThemePreference = 'dark' | 'light' | 'system';
export type DensityPreference = 'comfortable' | 'compact';
type ResolvedTheme = 'dark' | 'light';
const ThemeContext = createContext<{
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  density: DensityPreference;
  setDensity: (density: DensityPreference) => void;
}>({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {}, density: 'comfortable', setDensity: () => {} });

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
}

function storedTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem('vislex-theme');
    return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'dark';
  } catch { return 'dark'; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(storedTheme);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const [density, setDensityState] = useState<DensityPreference>(() => {
    try { return localStorage.getItem('vislex-density') === 'compact' ? 'compact' : 'comfortable'; }
    catch { return 'comfortable'; }
  });
  const resolvedTheme = theme === 'system' ? system : theme;
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystem(media.matches ? 'dark' : 'light');
    changed();
    media.addEventListener?.('change', changed);
    return () => media.removeEventListener?.('change', changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'dark' ? '#111318' : '#f7f8fa');
  }, [resolvedTheme]);
  useEffect(() => { document.documentElement.dataset.density = density; }, [density]);
  const setTheme = (next: ThemePreference) => {
    setThemeState(next);
    try { localStorage.setItem('vislex-theme', next); } catch { /* storage unavailable */ }
  };
  const setDensity = (next: DensityPreference) => {
    setDensityState(next);
    try { localStorage.setItem('vislex-density', next); } catch { /* storage unavailable */ }
  };
  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, density, setDensity }}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return <Tooltip text={resolvedTheme === 'dark' ? 'Light appearance' : 'Dark appearance'}>
    <button className="icon-button" aria-label="Toggle color theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  </Tooltip>;
}

/* -------------------------------- copy button ------------------------------- */

export function CopyButton({ text, label, small }: { text: string; label?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <Tooltip text={copied ? 'Copied' : label ?? 'Copy'}>
    <button
      className={`icon-button ${small ? 'icon-button-sm' : ''}`}
      aria-label={label ?? 'Copy to clipboard'}
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}>
      {copied ? <Check size={small ? 12 : 14} /> : <Copy size={small ? 12 : 14} />}
    </button>
  </Tooltip>;
}

/* -------------------------------- citations --------------------------------- */

export function citationLabel(locator: string): string {
  const pinned = /^R(\d+)L(\d+)-L(\d+)$/.exec(locator);
  if (pinned) return `rev ${pinned[1]} · ${pinned[2]}–${pinned[3]}`;
  if (/^L\d+-L\d+$/.test(locator)) return locator.replaceAll('L', '');
  if (locator === 'image') return 'Image';
  if (locator === 'media') return 'Media';
  if (locator.startsWith('artifact:')) return 'View source';
  return locator;
}

type CitationPreview = { lines: { number: number; text: string }[] } | 'loading' | null;

export function CitationChip({ value, onOpen, previewable = true }: { value: string; onOpen: (sourceId: string, locator: string) => void; previewable?: boolean }) {
  const parts = citationParts(value);
  const [preview, setPreview] = useState<CitationPreview>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number>(0);
  const host = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!parts) return <span className="citation-raw">{value}</span>;
  const lineMatch = /^L(\d+)-L(\d+)$/.exec(parts.locator);
  const pinnedMatch = /^R(\d+)L([1-9]\d*)-L[1-9]\d*$/.exec(parts.locator);
  const startLine = lineMatch ? Number(lineMatch[1]) : pinnedMatch ? Number(pinnedMatch[2]) : null;
  const pinnedRevision = pinnedMatch ? Number(pinnedMatch[1]) : null;
  const supported = previewable && startLine !== null;
  return <span className="citation-host">
    <button
      ref={host}
      className="citation"
      title={value}
      onClick={() => onOpen(parts.sourceId, parts.locator)}
      onMouseEnter={() => {
        if (!supported) return;
        if (preview === null) loadPreview();
        timer.current = window.setTimeout(() => setOpen(true), 350);
      }}
      onMouseLeave={() => { window.clearTimeout(timer.current); setOpen(false); }}>
      {citationLabel(parts.locator)}
    </button>
    {open && supported ? <AnchoredPopover anchor={host.current} onClose={() => setOpen(false)} className="citation-preview">
      {preview === 'loading' ? <p className="small muted citation-preview-loading">Loading lines…</p> : null}
      {preview && preview !== 'loading' ? <div className="citation-preview-lines">
        {preview.lines.map(line => <div className="citation-preview-line" key={line.number}><span className="line-number">{line.number}</span><span>{line.text}</span></div>)}
        <button className="quiet citation-preview-open" onClick={() => onOpen(parts.sourceId, parts.locator)}>Open in viewer</button>
      </div> : null}
    </AnchoredPopover> : null}
  </span>;

  function loadPreview() {
    if (startLine === null) return;
    setPreview('loading');
    // Hover previews show the pinned revision's wording for R-form citations,
    // so a superseded extraction cannot silently preview as current text.
    const request = pinnedRevision !== null
      ? api<{ text: string; start: number }>('read_extract_revision', { source_id: parts!.sourceId, revision: pinnedRevision, start: startLine, count: 10 })
      : api<{ text: string; start: number }>('read_text', { source_id: parts!.sourceId, start: startLine, count: 10 });
    request
      .then(page => {
        const lines = page.text.split('\n').map((text, offset) => ({ number: page.start + offset, text })).filter(line => line.text.trim());
        setPreview({ lines: lines.slice(0, 8) });
      })
      .catch(() => setPreview(null));
  }
}

/* ------------------------------- model picker ------------------------------- */

export function modelBadges(model: string, isDefault: boolean): string[] {
  const id = model.toLowerCase();
  const badges: string[] = [];
  if (isDefault) badges.push('Default');
  if (/o1|o3|o4|reason|thinking|opus|r1/.test(id)) badges.push('Reasoning');
  else if (/mini|flash|haiku|fast|nano/.test(id)) badges.push('Fast');
  if (/vision|4o|gemini|gpt-5|sonnet|opus/.test(id)) badges.push('Vision');
  return badges.slice(0, 2);
}

export function ModelPicker({ snapshot, selected, onSelect, onManage, disabled }: {
  snapshot: Snapshot | null; selected: AIProfile | undefined; onSelect: (profile: AIProfile) => void;
  onManage: () => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const anchor = useRef<HTMLButtonElement | null>(null);
  const profiles = (snapshot ? configuredProfiles(snapshot).filter(profile => profile.allow_text) : []);
  const groups = Object.entries(providerNames)
    .map(([provider, name]) => ({ provider, name, models: profiles.filter(profile => profile.provider === provider && profile.model.toLowerCase().includes(filter.toLowerCase())) }))
    .filter(group => group.models.length);
  const defaultKey = snapshot ? `${snapshot.ai_config?.provider ?? 'openai'}:${snapshot.settings.model}` : '';
  return <>
    <Tooltip text="Choose the model for your next message">
      <button ref={anchor} className="model-picker" disabled={disabled || !profiles.length} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="model-provider-dot" data-provider={selected?.provider} />
        <span className="model-name">{selected?.model ?? 'Configure AI'}</span>
        <ChevronDown size={13} />
      </button>
    </Tooltip>
    {open ? <AnchoredPopover anchor={anchor.current} onClose={() => { setOpen(false); setFilter(''); }} className="model-popover">
      <div className="model-filter"><Search size={13} /><input autoFocus aria-label="Filter models" placeholder="Filter models…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
      {!profiles.length ? <p className="small muted model-empty">No models configured. Add a provider key and choose models.</p> :
        !groups.length ? <p className="small muted model-empty">No models match “{filter}”.</p> : null}
      {groups.map(group => <div key={group.provider} className="model-group" role="listbox" aria-label={group.name}>
        <div className="model-group-label">{group.name}</div>
        {group.models.map(profile => {
          const key = profileKey(profile);
          return <button key={key} role="option" aria-selected={selected ? profileKey(selected) === key : false} className={`model-option ${selected && profileKey(selected) === key ? 'selected' : ''}`} onClick={() => { onSelect(profile); setOpen(false); setFilter(''); }}>
            <span className="model-provider-dot" data-provider={profile.provider} />
            <span className="model-option-name">{profile.model}</span>
            {modelBadges(profile.model, key === defaultKey).map(badge => <span className="model-badge" key={badge}>{badge}</span>)}
            {selected && profileKey(selected) === key ? <Check size={13} /> : null}
          </button>;
        })}
      </div>)}
      <button className="model-manage" onClick={() => { setOpen(false); onManage(); }}>Manage models &amp; keys…</button>
    </AnchoredPopover> : null}
  </>;
}
