import { describe, expect, it } from 'vitest';
import { markUncertain, stepUncertain, uncertainOrdinals } from './uncertain';

const w = (word: string, probability = 0.3) => ({ word, start: 0, end: 1, probability });

describe('markUncertain', () => {
  it('marks flagged words in order and keeps all text', () => {
    const parts = markUncertain('Meet at 4:15 sharp, not at 4:15 late', [w(' 4:15'), w(' late')]);
    expect(parts.map(part => part.text).join('')).toBe('Meet at 4:15 sharp, not at 4:15 late');
    expect(parts.filter(part => part.uncertain).map(part => part.text)).toEqual(['4:15', 'late']);
    expect(parts[1]).toMatchObject({ text: '4:15' });
  });
  it('leaves text unchanged when nothing is flagged or a word is missing', () => {
    expect(markUncertain('Plain text', [])).toEqual([{ text: 'Plain text', uncertain: null }]);
    expect(markUncertain('Plain text', undefined)).toEqual([{ text: 'Plain text', uncertain: null }]);
    const parts = markUncertain('Plain text', [w(' absent')]);
    expect(parts.map(part => part.text).join('')).toBe('Plain text');
    expect(parts.some(part => part.uncertain)).toBe(false);
  });
});

describe('uncertain navigation', () => {
  const ordinals = uncertainOrdinals([{ ordinal: 1 }, { ordinal: 3, uncertain_words: [w('x')] }, { ordinal: 7, uncertain_words: [w('y')] }, { ordinal: 9, uncertain_words: [] }]);
  it('lists only segments with flagged words', () => { expect(ordinals).toEqual([3, 7]); });
  it('steps forward and back with wrap-around', () => {
    expect(stepUncertain(ordinals, null, 1)).toBe(3);
    expect(stepUncertain(ordinals, null, -1)).toBe(7);
    expect(stepUncertain(ordinals, 3, 1)).toBe(7);
    expect(stepUncertain(ordinals, 7, 1)).toBe(3);
    expect(stepUncertain(ordinals, 3, -1)).toBe(7);
    expect(stepUncertain([], null, 1)).toBeNull();
  });
});
