import { describe, expect, it } from 'vitest';
import { suggestedMatterName, transcriptLine } from './review';
describe('source-relative transcript seeking',()=>{
  it('preserves millisecond precision and separates audio tracks from speakers',()=>{
    expect(transcriptLine('[track 2 · 01:02:03.125 → 01:02:06.500] Hello')).toEqual({start:3723.125,end:3726.5,text:'Hello'});
  });
  it('does not turn headers or invalid intervals into seek buttons',()=>{
    expect(transcriptLine('UNREVIEWED MACHINE TRANSCRIPTION')).toBeNull();
    expect(transcriptLine('[track 1 · 00:00:05 → 00:00:02] Bad')).toBeNull();
    expect(transcriptLine('[track 1 · 00:99:05 → 02:00:02] Bad')).toBeNull();
  });
});
it('suggests a matter name only from an unambiguous docket filename',()=>{
  expect(suggestedMatterName(['Eric Wilson - 26CRB00117.pdf'])).toBe('Eric Wilson · 26CRB00117');
  expect(suggestedMatterName(['Eric Wilson - 26CRB00117.pdf','Other Person - 26CRB00118.pdf'])).toBeNull();
  expect(suggestedMatterName(['WE folder.pdf'])).toBeNull();
});
