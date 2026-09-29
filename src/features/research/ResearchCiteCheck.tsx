import { useId, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';

/** The actor recorded on authorities captured from the research browser. */
export const RESEARCH_ACTOR = 'research_browser_adapter';

export const CITE_CHECKS = [
  { id: 'exists', label: 'Exists at the cited page' },
  { id: 'quote', label: 'Quote matches the opinion text' },
  { id: 'citator', label: 'Citator status checked' },
  { id: 'support', label: 'Supports the proposition' },
] as const;
export type CiteCheckId = typeof CITE_CHECKS[number]['id'];

type AuthorityContent = {
  url?: string;
  title?: string;
  citation?: { raw?: string; claimed?: string; mismatch?: boolean };
  quote?: { exact?: string; locator?: string };
  proposition?: string;
  treatment_status?: string;
  proposition_support?: string;
};

export function isResearchAuthority(object: { kind: string; actor: string }) {
  return object.kind === 'authority' && object.actor === RESEARCH_ACTOR;
}

export function parseAuthority(content: string): AuthorityContent | null {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AuthorityContent : null;
  } catch { return null; }
}

/** The note recorded with an acceptance, naming each check the reviewer ticked. */
export function citeCheckNote() {
  return `Cite-check completed: ${CITE_CHECKS.map(check => check.label.toLowerCase()).join('; ')}.`;
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const humanize = (value: string) => { const words = value.replaceAll('_', ' '); return words.charAt(0).toUpperCase() + words.slice(1); };

/** A captured authority as the reviewer needs to check it, including a citation mismatch. */
export function ResearchAuthoritySummary({ content }: { content: string }) {
  const value = parseAuthority(content);
  if (!value) return <pre className="finding-prose">{content}</pre>;
  const citation = text(value.citation?.raw) || text(value.citation?.claimed);
  return <div className="structured-finding research-authority">
    <p className="structured-finding-kind"><strong>{text(value.title) || 'Untitled authority'}</strong>{citation ? <> · <span>{citation}</span></> : null}</p>
    {value.citation?.mismatch ? <p className="research-mismatch" role="note">
      <CircleAlert size={14} aria-hidden="true" />
      <span><strong>Citation mismatch.</strong> Cited as “{text(value.citation.claimed) || 'not given'}”; the page shows “{text(value.citation.raw) || 'no citation'}”.</span>
    </p> : null}
    <dl className="finding-accounts">
      {text(value.url) ? <div><dt>Page</dt><dd className="mono research-url">{text(value.url)}</dd></div> : null}
      {text(value.quote?.exact) ? <div><dt>Quote</dt><dd><blockquote className="research-quote">{text(value.quote?.exact)}</blockquote>{text(value.quote?.locator) ? <span className="field-hint">{text(value.quote?.locator)}</span> : null}</dd></div> : null}
      {text(value.proposition) ? <div><dt>Proposition</dt><dd>{text(value.proposition)}</dd></div> : null}
      <div><dt>Citator status</dt><dd>{humanize(text(value.treatment_status) || 'not recorded')}</dd></div>
      <div><dt>Support</dt><dd>{humanize(text(value.proposition_support) || 'not assessed')}</dd></div>
    </dl>
    <details className="finding-raw"><summary>Raw provenance</summary><pre>{content}</pre></details>
  </div>;
}

/**
 * The cite-check for an authority captured from the research browser: Accept stays
 * disabled until the reviewer has ticked all four checks.
 */
export default function ResearchCiteCheck({ object, busy, onAccept }: {
  object: { id: string; revision: number; title: string; content: string; review: string; stale: boolean };
  busy?: boolean;
  onAccept: (review: { note: string; checks: CiteCheckId[] }) => void;
}) {
  const [ticked, setTicked] = useState<Set<CiteCheckId>>(() => new Set());
  const headingId = useId();
  const mismatch = !!parseAuthority(object.content)?.citation?.mismatch;
  if (object.stale || object.review === 'accepted') return null;
  const complete = CITE_CHECKS.every(check => ticked.has(check.id));
  const toggle = (id: CiteCheckId, on: boolean) => setTicked(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  return <fieldset className="research-cite-check" aria-labelledby={headingId}>
    <legend id={headingId}>Cite-check before accepting</legend>
    {mismatch ? <p className="field-hint">The citation on the page differs from the cited one; check which is correct.</p> : null}
    <ul>
      {CITE_CHECKS.map(check => <li key={check.id}><label className="settings-check">
        <input type="checkbox" checked={ticked.has(check.id)} disabled={busy} onChange={event => toggle(check.id, event.target.checked)} />
        <span>{check.label}</span>
      </label></li>)}
    </ul>
    <div className="research-cite-actions">
      <span className="field-hint" aria-live="polite">{ticked.size} of {CITE_CHECKS.length} checked</span>
      <button type="button" className="secondary review-accepted" data-size="sm" disabled={busy || !complete} onClick={() => onAccept({ note: citeCheckNote(), checks: CITE_CHECKS.map(check => check.id) })}>
        <Check size={14} aria-hidden="true" />Accept revision
      </button>
    </div>
  </fieldset>;
}
