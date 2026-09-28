import { describe, expect, it } from 'vitest';
import { deriveTitle } from './titles';

describe('deriveTitle', () => {
  it('keeps short questions as written', () => {
    expect(deriveTitle('Which sources mention the grey van?')).toBe('Which sources mention the grey van?');
  });
  it('drops polite filler and capitalises', () => {
    expect(deriveTitle('please can you build a timeline of the north entrance')).toBe('Build a timeline of the north entrance');
  });
  it('uses the first sentence and trims trailing full stops', () => {
    expect(deriveTitle('Summarize the dispatch calls. Then list the times each unit arrived and left.')).toBe('Summarize the dispatch calls');
  });
  it('truncates on a word boundary', () => {
    const title = deriveTitle('Compare witness W-01 with witness W-02 about the timing of the door openings and the van');
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(53);
    expect(title).not.toMatch(/\s…$/);
  });
  it('never returns an empty title', () => {
    expect(deriveTitle('   ')).toBe('New chat');
    expect(deriveTitle('please')).toBe('Please');
  });
});
