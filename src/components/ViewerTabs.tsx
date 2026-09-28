import { useId, useRef, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { springs } from '../lib/motion';

export type ViewerTab<T extends string> = { id: T; label: string; icon?: ReactNode; detail?: string };

/** Index of the tab that a tablist key press moves to, or -1 when the key is not a tab key. */
export function nextTabIndex(key: string, index: number, count: number): number {
  if (count <= 0) return -1;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index + count - 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

export function tabIds(prefix: string, id: string) {
  return { tab: `${prefix}-tab-${id}`, panel: `${prefix}-panel-${id}` };
}

/**
 * Underline tablist for sibling viewer panels. Roving tabindex, automatic
 * activation on Arrow/Home/End, and a sliding selection indicator that
 * collapses to an instant change under reduced motion. The indicator is
 * chrome only; nothing here touches the evidence canvas.
 */
export function ViewerTabs<T extends string>({ tabs, value, onChange, label, prefix, className }: {
  tabs: ViewerTab<T>[]; value: T; onChange: (value: T) => void; label: string; prefix: string; className?: string;
}) {
  const reducedMotion = useReducedMotion();
  const indicator = useId();
  const list = useRef<HTMLDivElement>(null);
  return <div ref={list} className={`tabs viewer-tabs ${className ?? ''}`} role="tablist" aria-label={label} onKeyDown={event => {
    const index = tabs.findIndex(tab => tab.id === value);
    const next = nextTabIndex(event.key, index, tabs.length);
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }}>
    {tabs.map(tab => {
      const selected = tab.id === value;
      const ids = tabIds(prefix, tab.id);
      return <button key={tab.id} type="button" role="tab" id={ids.tab} aria-controls={ids.panel} aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={() => onChange(tab.id)}>
        {tab.icon}<span>{tab.label}</span>{tab.detail ? <span className="viewer-tab-detail">{tab.detail}</span> : null}
        {selected ? <motion.span className="viewer-tab-indicator" layoutId={indicator} transition={reducedMotion ? { duration: 0 } : springs.snappy} aria-hidden="true" /> : null}
      </button>;
    })}
  </div>;
}

export function tabPanelProps(prefix: string, id: string, active: boolean) {
  const ids = tabIds(prefix, id);
  return { role: 'tabpanel' as const, id: ids.panel, 'aria-labelledby': ids.tab, hidden: !active };
}
