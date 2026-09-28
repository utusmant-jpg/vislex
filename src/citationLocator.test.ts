import { describe, expect, it } from 'vitest';
import { parsePinnedTextLocator, lineStartOf } from './citationLocator';

describe('pinned text locator resolution (R02)', () => {
  it('resolves pinned citations to the exact revision and start line', () => {
    expect(parsePinnedTextLocator('R1L5-L7')).toEqual({ revision: 1, start: 5 });
    expect(parsePinnedTextLocator('R12L45-L47')).toEqual({ revision: 12, start: 45 });
  });

  it('returns null for legacy, malformed and non-text locators', () => {
    for (const bad of ['L5-L7', 'image', 'media', 'artifact:abc', 'r1L1-L2', 'R1L1', 'R01L1-L2', 'R+1L1-L2', 'R1L0-L2', '', undefined, null]) {
      expect(parsePinnedTextLocator(bad as string | undefined | null)).toBeNull();
    }
  });

  it('derives the viewer start line for both pinned and legacy locators', () => {
    expect(lineStartOf('R2L14-L20')).toBe(14);
    expect(lineStartOf('L9-L12')).toBe(9);
    expect(lineStartOf(undefined)).toBe(1);
  });
});
