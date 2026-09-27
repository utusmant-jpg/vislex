import { useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { springs } from '../lib/motion';
import { AnchoredPopover } from '../ui';
import { matchesModelFilter } from '../ui';
import type { ModelOption } from '../types';

/** Searchable model selector replacing the native <select> in settings.
 * Same accessible name contract as the old select, so aria flows unchanged. */
export default function ModelSelect({ label, value, onChange, options, loading, disabled, placeholder }: {
  label: string; value: string; onChange: (model: string) => void;
  options: ModelOption[]; loading?: boolean; disabled?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlight, setHighlight] = useState(0);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useReducedMotion();
  const rows: { id: string; name: string }[] = [
    ...(value && !options.some(option => option.id === value) ? [{ id: value, name: `${value} (saved)` }] : []),
    ...options.filter(option => matchesModelFilter(option.id, filter) || matchesModelFilter(option.name, filter)),
  ];
  const selectedName = options.find(option => option.id === value)?.name ?? (value ? `${value} (saved)` : '');
  function choose(model: string) {
    onChange(model);
    setOpen(false);
    setFilter('');
    setHighlight(0);
  }
  return <>
    <button ref={anchor} type="button" className="model-select bg-surface-2 border-border rounded-lg" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(state => !state)}>
      <span className={`model-select-value ${value ? '' : 'placeholder'}`}>{loading ? 'Loading models…' : value ? (selectedName === value ? value : `${selectedName} · ${value}`) : (placeholder ?? 'Select a model')}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <AnchoredPopover anchor={anchor.current} onClose={() => { setOpen(false); setFilter(''); setHighlight(0); }} className="model-popover">
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: -4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={springs.overlay}
        onKeyDown={event => {
          if (!rows.length) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight(state => (state + 1) % rows.length); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight(state => (state - 1 + rows.length) % rows.length); }
          else if (event.key === 'Enter' && document.activeElement?.getAttribute('aria-label') !== 'Filter models') { event.preventDefault(); choose(rows[highlight]?.id ?? rows[0].id); }
        }}
      >
        <div className="model-filter"><Search size={13} /><input autoFocus aria-label="Filter models" placeholder="Filter models…" value={filter} onChange={event => { setFilter(event.target.value); setHighlight(0); }} /></div>
        {loading ? <p className="small muted model-empty">Loading models…</p> :
          !rows.length ? <p className="small muted model-empty">{filter ? `No models match “${filter}”.` : (placeholder ?? 'Load models to choose from.')}</p> : null}
        <div className="model-group" role="listbox" aria-label={label}>
          {!value && !filter ? <button type="button" role="option" aria-selected={!value} className="model-option selected" onClick={() => choose('')}><span className="model-option-name muted">{placeholder ?? 'Select a model'}</span></button> : null}
          {rows.map((row, index) => <button
            key={row.id}
            type="button"
            role="option"
            aria-selected={value === row.id}
            className={`model-option ${value === row.id ? 'selected' : ''} ${index === highlight ? 'highlight' : ''}`}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => choose(row.id)}
          >
            <span className="model-option-name">{row.name === row.id ? row.id : `${row.name} · ${row.id}`}</span>
            {row.id.endsWith(':free') ? <span className="model-badge">Free</span> : null}
            {value === row.id ? <Check size={13} /> : null}
          </button>)}
        </div>
      </motion.div>
    </AnchoredPopover> : null}
  </>;
}
