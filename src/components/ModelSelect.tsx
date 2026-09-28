import { ChevronDown, LoaderCircle } from 'lucide-react';
import { Combobox, modelBadges } from '../ui';
import type { ModelOption } from '../types';

/** Searchable single-select used for model catalogues and other long option
 *  lists. Keeps the accessible name of the native <select> it replaced; a saved
 *  value missing from the list stays visible as "(saved)" instead of being
 *  silently replaced. */
export default function ModelSelect({ label, value, onChange, options, loading, disabled, placeholder, noun = 'models', hideIds = false }: {
  label: string; value: string; onChange: (model: string) => void;
  options: ModelOption[]; loading?: boolean; disabled?: boolean; placeholder?: string; noun?: string;
  /** Show only display names in the trigger and list (ids still match the filter). */
  hideIds?: boolean;
}) {
  const rows: (ModelOption & { saved?: boolean })[] = [
    ...(value && !options.some(option => option.id === value) ? [{ id: value, name: `${value} (saved)`, saved: true }] : []),
    ...options,
  ];
  const clearLabel = placeholder ?? 'No selection';
  const items = [
    ...(value ? [{ value: '', label: clearLabel }] : []),
    ...rows.map(row => ({
      value: row.id,
      label: row.name === row.id ? row.id : row.name,
      description: row.name === row.id || row.saved || hideIds ? undefined : row.id,
      keywords: [row.id],
      meta: modelBadges(row.id, false, row).map(badge => <span className="badge" key={badge}>{badge}</span>),
    })),
  ];
  const selected = rows.find(row => row.id === value);
  return <Combobox
    label={label}
    value={value}
    options={items}
    disabled={disabled}
    className="model-select"
    searchPlaceholder={`Filter ${noun}…`}
    emptyText={loading ? `Loading ${noun}…` : rows.length ? `No ${noun} match.` : (placeholder ?? `Load ${noun} to choose from.`)}
    onChange={onChange}
    trigger={() => <>
      <span className={`model-select-value ${value ? '' : 'placeholder'}`}>
        {loading ? `Loading ${noun}…` : selected ? (selected.name === selected.id || selected.saved || hideIds ? selected.name : `${selected.name} · ${selected.id}`) : (placeholder ?? 'Select a model')}
      </span>
      {loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </>}
  />;
}
