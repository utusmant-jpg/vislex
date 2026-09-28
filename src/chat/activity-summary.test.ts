import { describe, expect, it } from 'vitest';
import type { Action } from '../types';
import { clock, groupLabel, groupSteps, humanizeTool, isGroup, liveLabel, progressLabel, summarizeAction, traceRecap, workedFor } from './activity-summary';

const action = (name: string, input: unknown, output: unknown, status = 'complete'): Action => ({
  id: `${name}-id`, name, input: typeof input === 'string' ? input : JSON.stringify(input),
  output: typeof output === 'string' ? output : JSON.stringify(output), status, created_at: '2026-09-28T10:00:00Z',
});
const names: Record<string, string> = { s1: 'Statement.pdf', v1: 'Cam04.mp4', a1: 'Interview.wav' };
const nameOf = (id: string) => names[id];

describe('summarizeAction', () => {
  it('states search terms and the reported total', () => {
    const step = summarizeAction(action('search_passages', { terms: ['lease termination', 'notice'] }, { matches: [{ excerpt: 'Notice was given', locator: 'evidence:s1#R1L2-L2', title: 'Statement.pdf' }], total: 8 }), nameOf);
    expect(step).toMatchObject({ kind: 'search', verb: 'Searched for', object: '“lease termination”, “notice”', result: '8 matches' });
    expect(step.excerpts).toEqual([{ text: 'Notice was given', locator: 'evidence:s1#R1L2-L2', title: 'Statement.pdf' }]);
  });

  it('names the source and the lines actually read', () => {
    const step = summarizeAction(action('read_text', { source_id: 's1', start: 1, count: 200 }, { source_id: 's1', start: 1, end: 120, total_lines: 120 }), nameOf);
    expect(step).toMatchObject({ kind: 'read', verb: 'Read', object: 'Statement.pdf', detail: 'lines 1–120', sourceId: 's1' });
    expect(step.facts).toContainEqual({ label: 'Lines', value: '1–120' });
  });

  it('marks a historical revision read', () => {
    const step = summarizeAction(action('read_extract_revision', { source_id: 's1', revision: 1, start: 5, count: 1 }, { start: 5, end: 5, revision: 1, historical: true }), nameOf);
    expect(step.detail).toBe('line 5 · revision 1 (historical)');
  });

  it('describes page ranges, video intervals and partial coverage', () => {
    expect(summarizeAction(action('inspect_document_pages', { source_id: 's1', pages: [4, 3] }, { frames: [] }), nameOf).detail).toBe('pages 3–4');
    const video = summarizeAction(action('inspect_video_interval', { source_id: 'v1', start: 130, end: 160, interval: 5 }, { frames: [{}, {}], next_start: 150 }), nameOf);
    expect(video).toMatchObject({ verb: 'Watched', object: 'Cam04.mp4', detail: '2:10–2:40', result: '2 frames · partly covered' });
  });

  it('uses the source name from the result when the case page does not hold it', () => {
    expect(summarizeAction(action('validate_citation', { citation: 'evidence:x#L1-L2' }, { valid: true, name: 'Lease.pdf', revision_binding: 'pinned' })).object).toBe('Lease.pdf');
  });

  it('keeps failures readable with the first line of the recorded error', () => {
    const step = summarizeAction(action('read_text', { source_id: 's1' }, { error: 'Source is restricted\nstack…' }, 'failed'), nameOf);
    expect(step).toMatchObject({ failed: true, error: 'Source is restricted', verb: 'Read', object: 'Statement.pdf' });
    expect(summarizeAction(action('render_page', { source_id: 'zz' }, 'Synthetic failure: page renderer timed out.', 'failed')).error).toBe('Synthetic failure: page renderer timed out.');
  });

  it('falls back to the tool name and tolerates non-JSON payloads', () => {
    const step = summarizeAction(action('mystery_tool', 'not json', 'plain text'));
    expect(step).toMatchObject({ kind: 'other', verb: 'Mystery tool', failed: false });
  });

  it('flags repeated results reported by the backend', () => {
    expect(summarizeAction(action('read_text', { source_id: 's1' }, { start: 1, end: 2, repeat_notice: 'already retrieved' }), nameOf).repeat).toBe(true);
  });

  it('reports what finish_task returned, never more', () => {
    expect(summarizeAction(action('finish_task', { answer: 'x', citations: ['a', 'b'] }, { status: 'review_required' })).verb).toBe('Sent the answer for review');
    expect(summarizeAction(action('finish_task', { answer: 'x' }, { status: 'complete', citation_count: 3 })).result).toBe('3 citations');
  });
});

describe('trace helpers', () => {
  const steps = [
    summarizeAction(action('search_passages', { terms: ['a'] }, { total: 2, matches: [] })),
    summarizeAction(action('read_text', { source_id: 's1' }, {}), nameOf),
    summarizeAction(action('read_text', { source_id: 'v1' }, {}), nameOf),
    summarizeAction(action('read_text', { source_id: 'a1' }, {}), nameOf),
    summarizeAction(action('read_text', { source_id: 's1' }, { error: 'nope' }, 'failed'), nameOf),
  ];

  it('recaps a trace in plain words', () => {
    expect(traceRecap(steps)).toBe('1 search · consulted 3 sources · 1 failed');
    expect(traceRecap([])).toBe('No recorded actions');
  });

  it('groups three or more consecutive successful steps of one kind', () => {
    const grouped = groupSteps(steps);
    expect(grouped).toHaveLength(3);
    const group = grouped[1];
    expect(isGroup(group) && groupLabel(group)).toBe('Read 3 sources');
    // A running trace keeps its newest run open.
    expect(groupSteps(steps.slice(0, 4), true)).toHaveLength(4);
  });

  it('labels live and in-progress work', () => {
    expect(liveLabel('search_passages')).toBe('Searching the evidence');
    expect(liveLabel('inspect video interval')).toBe('Watching the video');
    expect(progressLabel(undefined)).toBe('Considering the evidence');
    expect(progressLabel(steps[1])).toBe('Reading Statement.pdf');
  });

  it('formats clocks and durations', () => {
    expect(clock(125)).toBe('2:05');
    expect(clock(3725)).toBe('1:02:05');
    expect(workedFor(42)).toBe('42s');
    expect(workedFor(72)).toBe('1m 12s');
    expect(humanizeTool('read_text')).toBe('Read text');
  });
});
