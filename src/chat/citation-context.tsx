// Shared citation plumbing for answers: the citation grammar, per-answer
// numbering by first appearance, and a lookup that gives each cited source its
// display name. Kept free of UI imports so ui.tsx and markdown.tsx can use it.
import { createContext, useContext } from 'react';
import { FileText, Film, Image as ImageIcon, Volume2 } from 'lucide-react';

/** evidence:<source>#R<rev>L<a>-L<b> | L<a>-L<b> | image | media | artifact:<id> */
export const citationPattern = /(evidence:[a-zA-Z0-9-]+#(?:R[1-9]\d*L[1-9]\d*-L[1-9]\d*|L\d+-L\d+|image|media|artifact:[a-zA-Z0-9-]+))/g;

export type SourceInfo = { name: string; kind: string; restricted: boolean };

export type CitationScope = {
  /** 1-based number of a citation within the current answer, by first appearance. */
  numberOf: (value: string) => number | undefined;
  /** Display facts for a source, when known (may trigger a lazy lookup). */
  source: (sourceId: string) => SourceInfo | undefined;
};

export const CitationContext = createContext<CitationScope | null>(null);
export const useCitationScope = () => useContext(CitationContext);

/** Unique citations in order of first appearance. Appending text never renumbers earlier ones. */
export function citationOrder(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(citationPattern)) seen.add(match[1]);
  return [...seen];
}

export function numbering(values: string[]): (value: string) => number | undefined {
  const index = new Map(values.map((value, position) => [value, position + 1]));
  return value => index.get(value);
}

export function SourceKindIcon({ kind, size = 14 }: { kind?: string; size?: number }) {
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : kind === 'audio' ? Volume2 : FileText;
  return <Icon size={size} aria-hidden="true" />;
}

/** Plain-words locator, e.g. "Lines 5–9 · revision 2", "Line 6", "Image". */
export function locatorWords(locator: string): string {
  const pinned = /^R(\d+)L(\d+)-L(\d+)$/.exec(locator);
  const lines = (a: string, b: string) => a === b ? `Line ${a}` : `Lines ${a}–${b}`;
  if (pinned) return `${lines(pinned[2], pinned[3])} · revision ${pinned[1]}`;
  const plain = /^L(\d+)-L(\d+)$/.exec(locator);
  if (plain) return lines(plain[1], plain[2]);
  if (locator === 'image') return 'Whole image';
  if (locator === 'media') return 'Recording';
  if (locator.startsWith('artifact:')) return 'Derived view';
  return locator;
}
