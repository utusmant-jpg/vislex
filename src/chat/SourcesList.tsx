// The "Sources" footer under a saved answer: one row per cited location, in
// the answer's citation numbering, each opening the viewer at that location.
import { useId, useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { citationParts } from '../bridge';
import { SourceKindIcon, locatorWords, type CitationScope } from './citation-context';

export default function SourcesList({ citations, scope, onSource }: { citations: string[]; scope: CitationScope; onSource: (id: string, locator?: string) => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rows = citations.map(value => ({ value, parts: citationParts(value) })).filter((row): row is { value: string; parts: { sourceId: string; locator: string } } => !!row.parts);
  if (!rows.length) return null;
  const distinct = [...new Set(rows.map(row => row.parts.sourceId))];
  const first = scope.source(distinct[0]);
  const summary = first ? (distinct.length > 1 ? `${first.name} and ${distinct.length - 1} more` : first.name) : `${distinct.length} ${distinct.length === 1 ? 'source' : 'sources'}`;
  return <section className="answer-sources" aria-label="Sources">
    <button type="button" className="sources-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(value => !value)}>
      <span className="sources-stack" aria-hidden="true">{distinct.slice(0, 3).map(id => <span key={id}><SourceKindIcon kind={scope.source(id)?.kind} size={12} /></span>)}</span>
      <span className="sources-title">Sources</span>
      <span className="sources-count">{rows.length}</span>
      <span className="sources-summary">{summary}</span>
      <ChevronDown size={14} className="sources-chevron" aria-hidden="true" />
    </button>
    {open ? <ol className="sources-list" id={listId}>
      {rows.map(row => {
        const info = scope.source(row.parts.sourceId);
        const number = scope.numberOf(row.value);
        const where = locatorWords(row.parts.locator);
        return <li key={row.value}>
          <button type="button" className="source-row" onClick={() => onSource(row.parts.sourceId, row.parts.locator)} aria-label={`Open source ${number ?? ''}: ${info?.name ?? 'cited source'}, ${where}`}>
            <span className="source-number" aria-hidden="true">{number}</span>
            <span className="source-kind" aria-hidden="true"><SourceKindIcon kind={info?.kind} size={14} /></span>
            <span className="source-name">{info?.name ?? 'Cited source'}</span>
            <span className="source-where">{where}</span>
            {info?.restricted ? <span className="badge badge-restricted"><Lock size={12} aria-hidden="true" />Restricted</span> : null}
          </button>
        </li>;
      })}
    </ol> : null}
  </section>;
}
