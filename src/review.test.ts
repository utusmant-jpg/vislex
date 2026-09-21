import { describe, expect, it } from 'vitest';
import { suggestedMatterName, transcriptLine, transcriptPlaybackLine, incidentToSource } from './review';
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

it('maps delayed audio tracks and refuses missing or negative clock mappings',()=>{
  const line='[track 2 · 00:00:03.125 → 00:00:06.500] Hello';
  expect(transcriptPlaybackLine(line,{container_origin_seconds:10,tracks:[{index:2,origin_seconds:12}]})).toEqual({start:5.125,end:8.5,text:'Hello'});
  expect(transcriptPlaybackLine(line)).toBeNull();
  expect(transcriptPlaybackLine(line,{container_origin_seconds:20,tracks:[{index:2,origin_seconds:12}]})).toBeNull();
});
it('inverts drift mappings only inside their supported interval',()=>{
  const mapping={scale:1.01,offset_seconds:20,valid_source_range:[0,100] as [number,number],uncertainty_seconds:0.5};
  expect(incidentToSource(70.5,mapping)?.seconds).toBeCloseTo(50);
  expect(incidentToSource(122,mapping)).toBeNull();
  expect(incidentToSource(70.5,{...mapping,scale:0})).toBeNull();
});
