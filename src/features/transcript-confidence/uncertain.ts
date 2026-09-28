// Low-confidence words reported by the local recogniser. The probability is a
// decoder diagnostic, not calibrated accuracy, so the UI marks words for a
// human to check against the original audio and never states a percentage.
export type UncertainWord = { word: string; start: number; end: number; probability: number };

export type MarkedPart = { text: string; uncertain: UncertainWord | null };

/** Split segment text into plain and uncertain parts. Words are matched in
 *  order, so a repeated word is marked only where the recogniser flagged it.
 *  A flagged word that cannot be found leaves the text unchanged. */
export function markUncertain(text: string, words: UncertainWord[] | undefined): MarkedPart[] {
  if (!words?.length) return [{ text, uncertain: null }];
  const parts: MarkedPart[] = [];
  let from = 0;
  for (const word of words) {
    const token = word.word.trim();
    if (!token) continue;
    const at = text.indexOf(token, from);
    if (at < 0) continue;
    if (at > from) parts.push({ text: text.slice(from, at), uncertain: null });
    parts.push({ text: text.slice(at, at + token.length), uncertain: word });
    from = at + token.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), uncertain: null });
  return parts.length ? parts : [{ text, uncertain: null }];
}

/** Ordinals of loaded segments that contain at least one flagged word. */
export function uncertainOrdinals(segments: { ordinal: number; uncertain_words?: UncertainWord[] }[]): number[] {
  return segments.filter(segment => (segment.uncertain_words?.length ?? 0) > 0).map(segment => segment.ordinal);
}

/** The next (or previous) flagged ordinal after the current one, wrapping. */
export function stepUncertain(ordinals: number[], current: number | null, direction: 1 | -1): number | null {
  if (!ordinals.length) return null;
  if (current === null) return direction === 1 ? ordinals[0] : ordinals[ordinals.length - 1];
  if (direction === 1) return ordinals.find(ordinal => ordinal > current) ?? ordinals[0];
  for (let index = ordinals.length - 1; index >= 0; index--) if (ordinals[index] < current) return ordinals[index];
  return ordinals[ordinals.length - 1];
}

export function uncertainTitle(word: UncertainWord): string {
  return 'Low recogniser confidence. Check this word against the original audio; the score is a model diagnostic, not accuracy.';
}
