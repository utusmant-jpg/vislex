import { describe, expect, it } from 'vitest';
import { buildViewerAttachment } from './viewerContext';

const source = { type: 'source' as const, id: 'src-1', locator: 'L1-L2' };

describe('buildViewerAttachment (VL-003)', () => {
  it('suppresses the entire payload when attachment is toggled off', () => {
    expect(buildViewerAttachment(source, { sourceId: 'src-1', page: 3, timeSeconds: 12.5 }, true)).toBeNull();
  });

  it('sends null when nothing is selected', () => {
    expect(buildViewerAttachment(null, { sourceId: 'src-1' }, false)).toBeNull();
  });

  it('enriches page and playback position when no exact selection exists', () => {
    expect(buildViewerAttachment({type:'source',id:'src-1'}, { sourceId: 'src-1', page: 3, timeSeconds: 12.5 }, false))
      .toEqual({ type: 'source', id: 'src-1', locator: 'page:3', time_seconds: 12.5 });
  });

  it('uses the line start when no exact selection or page is known', () => {
    expect(buildViewerAttachment({type:'source',id:'src-1'}, { sourceId: 'src-1', lineStart: 7 }, false))
      .toEqual({ type: 'source', id: 'src-1', locator: 'L7', time_seconds: null });
  });

  it('keeps a selected historical range over a generic viewport line', () => {
    expect(buildViewerAttachment({type:'source',id:'src-1',locator:'R1L5-L7'}, {sourceId:'src-1',lineStart:20}, false))
      .toEqual({type:'source',id:'src-1',locator:'R1L5-L7',time_seconds:null});
  });

  it('falls back to the selection locator when the live view belongs to another file', () => {
    expect(buildViewerAttachment(source, { sourceId: 'different', page: 9 }, false))
      .toEqual({ type: 'source', id: 'src-1', locator: 'L1-L2', time_seconds: null });
  });

  it('keeps record attachments without media enrichment', () => {
    expect(buildViewerAttachment({ type: 'record', id: 'rec-1' }, null, false))
      .toEqual({ type: 'record', id: 'rec-1', locator: null, time_seconds: null });
  });

  it('also suppresses record attachments when toggled off', () => {
    expect(buildViewerAttachment({ type: 'record', id: 'rec-1' }, null, true)).toBeNull();
  });
});
