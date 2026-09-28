// Design-system primitives shared by every surface: status pills, tooltips, menus,
// popovers, combobox, toasts, skeletons, theme, model picker. Offline only.
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Command } from 'cmdk';
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, CircleDashed, CircleStop, Copy, History, Info, LoaderCircle, Lock,
  Moon, Search, Settings2, Sun, X, XCircle,
} from 'lucide-react';
import { api, citationParts } from './bridge';
import { configuredProfiles, profileKey, providerNames } from './aiProfiles';
import { MotionConfig } from 'motion/react';
import type { AIProfile, Snapshot } from './types';

/* ---------------------------------- status --------------------------------- */

export type PillState =
  | 'unreviewed' | 'running' | 'queued' | 'paused' | 'stopped' | 'complete' | 'accepted' | 'failed'
  | 'interrupted' | 'stale' | 'protected' | 'restricted' | 'needs-attention' | 'cancelled';

const pillTone: Record<PillState, string> = {
  unreviewed: 'neutral', running: 'accent', queued: 'accent', paused: 'neutral', stopped: 'neutral', complete: 'success',
  accepted: 'success', failed: 'danger', interrupted: 'danger', stale: 'warning',
  protected: 'neutral', restricted: 'restricted', 'needs-attention': 'warning', cancelled: 'neutral',
};

function pillIcon(state: PillState, size: number) {
  switch (state) {
    case 'running': case 'queued': return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
    case 'complete': case 'accepted': return <CheckCircle2 size={size} aria-hidden="true" />;
    case 'failed': return <XCircle size={size} aria-hidden="true" />;
    case 'interrupted': return <AlertTriangle size={size} aria-hidden="true" />;
    case 'stale': case 'needs-attention': return <History size={size} aria-hidden="true" />;
    case 'protected': case 'restricted': return <Lock size={size} aria-hidden="true" />;
    case 'stopped': case 'cancelled': return <CircleStop size={size} aria-hidden="true" />;
    default: return <CircleDashed size={size} aria-hidden="true" />;
  }
}

export function StatusPill({ state, label, small }: { state: PillState; label: string; small?: boolean }) {
  return <span className={`pill tone-${pillTone[state]} ${small ? 'pill-sm' : ''}`}>{pillIcon(state, small ? 12 : 13)}{label}</span>;
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
  return new Date(Date.parse(iso)).toLocaleDateString();
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

// Moving between neighbouring controls shows the next tooltip without the
// initial delay, like native toolbars.
let lastTooltipHidden = 0;

export function Tooltip({ text, shortcut, children, side = 'auto' }: { text: string; shortcut?: string; children: ReactElement; side?: 'auto' | 'top' | 'bottom' | 'right' }) {
  const id = useId();
  const [point, setPoint] = useState<{ x: number; y: number; side: 'top' | 'bottom' | 'right' } | null>(null);
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
      if (!rect) return;
      const placement = side === 'auto' ? (rect.top < 56 ? 'bottom' : 'top') : side;
      if (placement === 'right') setPoint({ x: rect.right + 10, y: rect.top + rect.height / 2, side: 'right' });
      else setPoint({ x: Math.max(16, Math.min(window.innerWidth - 16, rect.left + rect.width / 2)), y: placement === 'bottom' ? rect.bottom : rect.top, side: placement });
    };
    if (immediate || Date.now() - lastTooltipHidden < 450) display(); else timer.current = window.setTimeout(display, 450);
  };
  const hide = () => { window.clearTimeout(timer.current); setPoint(current => { if (current) lastTooltipHidden = Date.now(); return null; }); };
  useEffect(() => {
    window.addEventListener('scroll', hide, true);
    return () => { window.clearTimeout(timer.current); window.removeEventListener('scroll', hide, true); };
  }, []);
  const style: React.CSSProperties | undefined = point ? point.side === 'right'
    ? { position: 'fixed', left: point.x, top: point.y, transform: 'translateY(-50%)' }
    : { position: 'fixed', left: point.x, top: point.y, transform: point.side === 'bottom' ? 'translate(-50%, 8px)' : 'translate(-50%, calc(-100% - 8px))' } : undefined;
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
      <div id={id} className="tooltip" role="tooltip" style={style} data-side={point.side}>
        {text}{shortcut ? <span className="tooltip-keys">{shortcut.split('+').map(key => <kbd key={key}>{key}</kbd>)}</span> : null}
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
      tabIndex={-1}
      onMouseEnter={() => setHighlight(index)}
      onClick={() => { close(); item.onSelect(); }}>
      {item.icon}{item.label}{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
    </button>;
  });
  return { body, selectable };
}

export function MenuPanel({ items, onClose, style, className, label = 'Actions' }: { items: MenuItem[]; onClose: () => void; style?: React.CSSProperties; className?: string; label?: string }) {
  const [highlight, setHighlight] = useState(-1);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }, []);
  const { body, selectable } = menuNode(items, onClose, highlight, setHighlight);
  const move = (direction: 1 | -1) => {
    if (!selectable.length) return;
    const position = selectable.indexOf(highlight);
    const next = position === -1 ? (direction === 1 ? selectable[0] : selectable[selectable.length - 1]) : selectable[(position + direction + selectable.length) % selectable.length];
    setHighlight(next);
  };
  return createPortal(<>
    <div className="menu-scrim" onClick={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div
      className={`menu-panel ${className ?? ''}`}
      style={style}
      role="menu"
      aria-label={label}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
        else if (event.key === 'Home') { event.preventDefault(); if (selectable.length) setHighlight(selectable[0]); }
        else if (event.key === 'End') { event.preventDefault(); if (selectable.length) setHighlight(selectable[selectable.length - 1]); }
        else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); }
        else if ((event.key === 'Enter' || event.key === ' ') && highlight >= 0) { event.preventDefault(); const item = items[highlight]; onClose(); if (item !== 'separator' && !item.disabled) item.onSelect(); }
        else if (event.key.length === 1 && /\S/.test(event.key)) {
          const letter = event.key.toLowerCase();
          const match = selectable.find(index => { const item = items[index]; return item !== 'separator' && item.label.toLowerCase().startsWith(letter); });
          if (match !== undefined) setHighlight(match);
        }
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
  const clamped = (x: number, y: number) => ({ x: Math.max(8, Math.min(x, window.innerWidth - 232)), y: Math.max(8, Math.min(y, window.innerHeight - 16 - items.length * 32)) });
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

/** Non-modal anchored panel: flips above when there is no room below, closes on
 *  Escape or outside click, and returns focus to whatever opened it. */
export function AnchoredPopover({ anchor, onClose, children, className, align = 'start', width = 340, label }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; className?: string; align?: 'start' | 'end'; width?: number; label?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => {
    const active = document.activeElement;
    if (returnFocus.current?.isConnected && (!active || active === document.body || panel.current?.contains(active) || !active.isConnected)) returnFocus.current.focus();
  }, []);
  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = Math.min(width, window.innerWidth - 16);
    const left = Math.max(8, Math.min(align === 'end' ? rect.right - panelWidth : rect.left, window.innerWidth - panelWidth - 8));
    const height = panel.current?.offsetHeight ?? 0;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const flip = height > below && above > below;
    setStyle(flip
      ? { position: 'fixed', left, bottom: window.innerHeight - rect.top + 6, width: panelWidth, maxHeight: above - 8 }
      : { position: 'fixed', left, top: rect.bottom + 6, width: panelWidth, maxHeight: Math.max(160, below - 8) });
  }, [anchor, align, width, style === null]);
  if (!anchor) return null;
  return createPortal(<>
    <div className="menu-scrim" onClick={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={`popover-panel ${className ?? ''}`}
      style={style ?? { position: 'fixed', visibility: 'hidden', top: 0, left: 0, width }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); onClose(); } }}>
      {children}
    </div>
  </>, document.body);
}

/* --------------------------------- combobox --------------------------------- */

export type ComboboxOption = {
  value: string;
  label: string;
  group?: string;
  description?: string;
  keywords?: string[];
  leading?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
};

/** Searchable single-select built on cmdk: one listbox, grouped options,
 *  arrow/Enter selection from the filter, Escape closes and restores focus. */
export function Combobox({ label, value, options, onChange, trigger, placeholder = 'Select…', searchPlaceholder = 'Filter…', emptyText = 'Nothing matches.', disabled, footer, width = 340, align = 'start', className }: {
  label: string; value: string; options: ComboboxOption[]; onChange: (value: string) => void;
  trigger?: (state: { open: boolean; selected?: ComboboxOption }) => ReactNode;
  placeholder?: string; searchPlaceholder?: string; emptyText?: string; disabled?: boolean;
  footer?: (close: () => void) => ReactNode; width?: number; align?: 'start' | 'end'; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const selected = options.find(option => option.value === value);
  const groups = [...new Set(options.map(option => option.group ?? ''))];
  const close = () => setOpen(false);
  return <>
    <button
      ref={anchor}
      type="button"
      className={className ?? 'combobox-trigger'}
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(state => !state)}
      onKeyDown={event => { if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) { event.preventDefault(); setOpen(true); } }}>
      {trigger ? trigger({ open, selected }) : <>
        <span className={`combobox-value ${selected ? '' : 'placeholder'}`}>{selected?.label ?? (value || placeholder)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </>}
    </button>
    {open ? <AnchoredPopover anchor={anchor.current} onClose={close} width={width} align={align} label={label} className="combobox-popover">
      <Command
        className="combobox"
        label={label}
        loop
        defaultValue={value || undefined}
        filter={(item, search, keywords) => matchesModelFilter([item, ...(keywords ?? [])].join(' '), search) ? 1 : 0}>
        <div className="combobox-input"><Search size={14} aria-hidden="true" /><Command.Input autoFocus placeholder={searchPlaceholder} aria-label={`Filter ${label.toLowerCase()}`} /></div>
        <Command.List className="combobox-list">
          <Command.Empty className="combobox-empty">{emptyText}</Command.Empty>
          {groups.map(group => <Command.Group key={group || 'default'} heading={group || undefined} className="combobox-group">
            {options.filter(option => (option.group ?? '') === group).map(option => <Command.Item
              key={option.value}
              value={option.value}
              keywords={[option.label, ...(option.keywords ?? [])]}
              disabled={option.disabled}
              className="combobox-item"
              onSelect={() => { onChange(option.value); close(); }}>
              {option.leading}
              <span className="combobox-item-name">{option.label}{option.description ? <small className="combobox-item-description">{option.description}</small> : null}</span>
              {option.meta ? <span className="combobox-meta">{option.meta}</span> : null}
              {option.value === value ? <Check size={14} aria-label="Selected" /> : null}
            </Command.Item>)}
          </Command.Group>)}
        </Command.List>
        {footer ? <div className="combobox-footer">{footer(close)}</div> : null}
      </Command>
    </AnchoredPopover> : null}
  </>;
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
  if (!sticky) window.setTimeout(() => dismiss(id), action ? 8000 : 6000);
  return id;
}

function dismiss(id: number) { toastState = toastState.filter(toast => toast.id !== id); emit(); }

export const notify = {
  error: (title: string, detail?: string) => push('error', title, detail),
  success: (title: string, detail?: string, action?: ToastEntry['action']) => push('success', title, detail, action),
  info: (title: string, detail?: string) => push('info', title, detail),
  fromError: (prefix: string, error: unknown) => push('error', prefix, String(error).replace(/^Error:\s*/, '')),
  dismiss,
};

const toastIcon = { error: XCircle, success: CheckCircle2, info: Info } as const;

export function ToastStack() {
  const [toasts, setToasts] = useState(toastState);
  useEffect(() => { toastListeners = [...toastListeners, setToasts]; return () => { toastListeners = toastListeners.filter(listener => listener !== setToasts); }; }, []);
  return createPortal(<div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
    {toasts.map(toast => {
      const Icon = toastIcon[toast.kind];
      return <div className={`toast toast-${toast.kind}`} key={toast.id} role={toast.kind === 'error' ? 'alert' : 'status'}>
        <Icon size={17} className="toast-icon" aria-hidden="true" />
        <div className="toast-body">
          <strong>{toast.title}</strong>
          {toast.detail && toast.kind !== 'error' ? <p className="toast-message">{toast.detail}</p> : null}
          {toast.detail && toast.kind === 'error' ? <details className="toast-detail"><summary>Show detail</summary><span>{toast.detail}</span></details> : null}
        </div>
        {toast.action ? <button className="toast-action" onClick={() => { toast.action?.run(); dismiss(toast.id); }}>{toast.action.label}</button> : null}
        <button className="icon-button icon-button-sm" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><X size={14} /></button>
      </div>;
    })}
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
}>({ theme: 'system', resolvedTheme: 'dark', setTheme: () => {}, density: 'comfortable', setDensity: () => {} });

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
}

function storedTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem('vislex-theme');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  } catch { return 'system'; }
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'dark' ? '#121419' : '#f6f5f1');
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
  // Motion components honour the OS reduced-motion preference everywhere.
  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, density, setDensity }}><MotionConfig reducedMotion="user">{children}</MotionConfig></ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return <Tooltip text={resolvedTheme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance'}>
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
      {copied ? <Check size={small ? 13 : 15} /> : <Copy size={small ? 13 : 15} />}
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

type CitationPreview = { lines: { number: number; text: string }[]; revision?: number } | 'loading' | 'failed' | null;

/** Amber chip that opens the exact cited source. Hovering or focusing it shows
 *  the cited lines (the pinned revision for R-form citations) without leaving
 *  the current view. */
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
  const reveal = (delay: number) => {
    if (!supported) return;
    if (preview === null) loadPreview();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const conceal = () => { window.clearTimeout(timer.current); setOpen(false); };
  return <span className="citation-host">
    <button
      ref={host}
      className="citation"
      title={value}
      aria-label={`Open cited evidence, ${citationLabel(parts.locator)}`}
      onClick={() => { conceal(); onOpen(parts.sourceId, parts.locator); }}
      onMouseEnter={() => reveal(350)}
      onMouseLeave={conceal}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) reveal(0); }}
      onBlur={conceal}
      onKeyDown={event => { if (event.key === 'Escape') conceal(); }}>
      {citationLabel(parts.locator)}
    </button>
    {open && supported ? createPortal(<CitationPreviewCard anchor={host.current} preview={preview} pinnedRevision={pinnedRevision} onOpen={() => { conceal(); onOpen(parts.sourceId, parts.locator); }} onEnter={() => window.clearTimeout(timer.current)} onLeave={conceal} />, document.body) : null}
  </span>;

  function loadPreview() {
    if (startLine === null) return;
    setPreview('loading');
    // Hover previews show the pinned revision's wording for R-form citations,
    // so a superseded extraction cannot silently preview as current text.
    const request = pinnedRevision !== null
      ? api<{ text: string; start: number; revision?: number }>('read_extract_revision', { source_id: parts!.sourceId, revision: pinnedRevision, start: startLine, count: 10 })
      : api<{ text: string; start: number; revision?: number }>('read_text', { source_id: parts!.sourceId, start: startLine, count: 10 });
    request
      .then(page => {
        const lines = page.text.split('\n').map((text, offset) => ({ number: page.start + offset, text })).filter(line => line.text.trim());
        setPreview({ lines: lines.slice(0, 8), revision: page.revision });
      })
      .catch(() => setPreview('failed'));
  }
}

function CitationPreviewCard({ anchor, preview, pinnedRevision, onOpen, onEnter, onLeave }: { anchor: HTMLElement | null; preview: CitationPreview; pinnedRevision: number | null; onOpen: () => void; onEnter: () => void; onLeave: () => void }) {
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const height = card.current?.offsetHeight ?? 200;
    const top = rect.bottom + height + 12 > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
    setStyle({ position: 'fixed', left, top, width });
  }, [anchor, preview]);
  return <div ref={card} className="popover-panel citation-preview" style={style} role="group" aria-label="Cited lines preview" onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <div className="citation-preview-head">{pinnedRevision !== null ? `Extraction revision ${pinnedRevision} · as cited` : 'Current extraction'}</div>
    {preview === 'loading' || preview === null ? <p className="small muted citation-preview-loading">Loading cited lines…</p> : null}
    {preview === 'failed' ? <p className="small muted citation-preview-loading">Preview unavailable. Open the source to inspect it.</p> : null}
    {preview && typeof preview === 'object' ? <div className="citation-preview-lines">
      {preview.lines.map(line => <div className="citation-preview-line" key={line.number}><span className="line-number">{line.number}</span><span>{line.text}</span></div>)}
    </div> : null}
    <button className="quiet citation-preview-open" onClick={onOpen}>Open in viewer</button>
  </div>;
}

/* ------------------------------- model picker ------------------------------- */

/** Only facts VisLex actually knows: the saved default, and OpenRouter's
 *  published ":free" variant naming. Capability is never guessed from a name. */
export function modelBadges(model: string, isDefault: boolean): string[] {
  const badges: string[] = [];
  if (isDefault) badges.push('Default');
  if (/:free$/i.test(model)) badges.push('Free variant');
  return badges;
}

/** Subsequence fuzzy match: every filter character appears in order. */
export function matchesModelFilter(model: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  const haystack = model.toLowerCase();
  if (haystack.includes(needle)) return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

export function ModelPicker({ snapshot, selected, onSelect, onManage, disabled }: {
  snapshot: Snapshot | null; selected: AIProfile | undefined; onSelect: (profile: AIProfile) => void;
  onManage: () => void; disabled?: boolean;
}) {
  const profiles = snapshot ? configuredProfiles(snapshot).filter(profile => profile.allow_text) : [];
  const defaultKey = snapshot ? `${snapshot.ai_config?.provider ?? 'openai'}:${snapshot.settings.model}` : '';
  const options: ComboboxOption[] = profiles.map(profile => ({
    value: profileKey(profile),
    label: profile.model,
    group: providerNames[profile.provider],
    keywords: [providerNames[profile.provider]],
    leading: <span className="provider-dot" data-provider={profile.provider} aria-hidden="true" />,
    meta: modelBadges(profile.model, profileKey(profile) === defaultKey).map(badge => <span className="badge" key={badge}>{badge}</span>),
  }));
  return <Combobox
    label="Model for your next message"
    value={selected ? profileKey(selected) : ''}
    options={options}
    disabled={disabled || !profiles.length}
    className="model-picker"
    width={360}
    searchPlaceholder="Filter permitted models…"
    emptyText="No permitted model matches."
    onChange={key => { const profile = profiles.find(item => profileKey(item) === key); if (profile) onSelect(profile); }}
    trigger={() => <>
      <span className="provider-dot" data-provider={selected?.provider} aria-hidden="true" />
      <span className="model-name">{selected?.model ?? 'Configure AI'}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </>}
    footer={close => <button className="menu-item" onClick={() => { close(); onManage(); }}><Settings2 size={15} />Manage models &amp; permissions…</button>}
  />;
}
