import { describe, expect, it } from 'vitest';
import type { Action } from '../types';
import { clock, groupLabel, groupSteps, humanizeTool, isGroup, liveLabel, progressLabel, researchDetail, researchLines, researchStepLabel, summarizeAction, traceRecap, workedFor } from './activity-summary';

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
    expect(video).toMatchObject({ verb: 'Sampled frames from', object: 'Cam04.mp4', detail: '2:10–2:40', result: '2 frames · partly covered' });
    // Direct media is only queued for the next request; the sentence must not claim playback.
    expect(summarizeAction(action('inspect_direct_media', { source_id: 'a1' }, { status: 'Original media queued for next Gemini request' }), nameOf))
      .toMatchObject({ verb: 'Queued the original of', object: 'Interview.wav', detail: 'for the model to review' });
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
    expect(summarizeAction(action('publish_saved_candidate', { candidate_id: 'c1' }, { status: 'complete', citation_count: 2 }))).toMatchObject({ kind: 'finish', verb: 'Prepared the answer', result: '2 citations' });
    expect(liveLabel('publish_saved_candidate')).toBe('Preparing the answer');
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
    expect(liveLabel('inspect video interval')).toBe('Sampling video frames');
    expect(liveLabel('transcribe_audio_interval')).toBe('Transcribing audio');
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

describe('research browser steps', () => {
  it('describes each research tool in a plain sentence', () => {
    expect(summarizeAction(action('research_status', {}, { open: true }))).toMatchObject({ kind: 'check', verb: 'Checked the research browser' });
    expect(summarizeAction(action('research_navigate', { url: 'https://1.next.westlaw.com/Document/I0abc?transitionType=Default' }, { url: 'https://1.next.westlaw.com/Document/I0abc', snapshot: {} })))
      .toMatchObject({ kind: 'browse', verb: 'Opened', object: '1.next.westlaw.com/Document/I0abc' });
    expect(summarizeAction(action('research_navigate', { url: 'https://next.westlaw.com/' }, {})).object).toBe('next.westlaw.com');
    expect(summarizeAction(action('research_snapshot', { scope: 'interactive', find: 'search box' }, { snapshot: {} }))).toMatchObject({ verb: 'Looked over the page', object: '(interactive)' });
    const typed = summarizeAction(action('research_act', { action: 'type', ref: 'e12', snapshot_version: 3, text: 'duty of care /s negligence', key: null }, { performed: 'type' }));
    expect(typed).toMatchObject({ kind: 'search', verb: 'Searched:', object: 'duty of care /s negligence' });
    expect(typed.facts).toContainEqual({ label: 'Query', value: 'duty of care /s negligence' });
    expect(summarizeAction(action('research_act', { action: 'click', ref: 'e4', snapshot_version: 3, text: null, key: null }, {})).verb).toBe('Clicked on the page');
    expect(summarizeAction(action('research_act', { action: 'press', ref: null, snapshot_version: null, text: null, key: 'Enter' }, {})).verb).toBe('Pressed Enter');
    expect(summarizeAction(action('research_act', { action: 'scroll_down', ref: null, snapshot_version: null, text: null, key: null }, {})).verb).toBe('Scrolled down');
    // Line numbers are the n values research_read_page returned (from 0), which captures cite.
    const read = summarizeAction(action('research_read_page', { offset: 0, count: 200 }, { title: 'Synthetic v. Example', lines: [{ n: 0 }, { n: 1 }, { n: 2 }], total_lines: 900 }));
    expect(read).toMatchObject({ kind: 'read', verb: 'Read', object: 'lines 0–2' });
    expect(read.facts).toContainEqual({ label: 'Page', value: 'Synthetic v. Example' });
    expect(summarizeAction(action('research_read_page', { offset: 0, count: 50 }, 'Research result is not available')).object).toBe('lines 0–49');
    const captured = summarizeAction(action('research_capture', { title: 'Synthetic v. Example', citation_text: '123 F.3d 456', proposition: 'A duty is owed.' }, { title: 'Synthetic v. Example', locator: 'evidence:s9#R1L4-L5' }));
    expect(captured).toMatchObject({ kind: 'save', verb: 'Captured', object: '123 F.3d 456' });
    expect(captured.facts).toEqual([{ label: 'Title', value: 'Synthetic v. Example' }, { label: 'Proposition', value: 'A duty is owed.' }, { label: 'Locator', value: 'evidence:s9#R1L4-L5' }]);
  });

  it('derives the same one-line detail from a receipt that the backend sends live', () => {
    expect(researchDetail('research_act', { action: 'type', text: 'duty of care /s negligence' })).toBe('duty of care /s negligence');
    expect(researchDetail('research_act', { action: 'press', key: 'Enter' })).toBe('press Enter');
    expect(researchDetail('research_act', { action: 'click', ref: 'e4' })).toBe('click');
    expect(researchDetail('research_navigate', { url: 'https://1.next.westlaw.com/Document/I0abc?x=1#frag' })).toBe('1.next.westlaw.com/Document/I0abc');
    expect(researchDetail('research_read_page', { offset: 10, count: 5 })).toBe('lines 10–14');
    expect(researchDetail('research_read_page', { offset: 3, count: 1 })).toBe('line 3');
    expect(researchDetail('research_capture', { citation_text: '123 F.3d 456' })).toBe('123 F.3d 456');
    expect(researchDetail('research_snapshot', { scope: 'main' })).toBe('main');
    expect(researchDetail('research_status', {})).toBeUndefined();
    // Live details as the backend sends them read as the same sentences.
    expect(researchStepLabel('research_act', 'duty of care /s negligence')).toBe('Searched: duty of care /s negligence');
    expect(researchStepLabel('research_act', 'click')).toBe('Clicked on the page');
    expect(researchStepLabel('research_act', 'press Enter')).toBe('Pressed Enter');
    expect(researchStepLabel('research_act', 'Enter')).toBe('Pressed Enter');
    expect(researchStepLabel('research_act', 'scroll_up')).toBe('Scrolled up');
    expect(researchStepLabel('research_navigate', '1.next.westlaw.com/Document/I0abc')).toBe('Opened 1.next.westlaw.com/Document/I0abc');
    expect(researchStepLabel('research_read_page', 'lines 0–50')).toBe('Read lines 0–50');
    expect(researchStepLabel('research_capture', '123 F.3d 456')).toBe('Captured 123 F.3d 456');
    // A missing detail shows just the label.
    expect(researchStepLabel('research_capture')).toBe('Captured an authority');
    expect(researchStepLabel('research_act', '')).toBe('Worked on the research page');
  });

  it('lists research steps once: receipts first, then live steps without a receipt yet', () => {
    const at = Date.parse('2026-09-28T10:00:00Z');
    const receipt = summarizeAction({ ...action('research_act', { action: 'type', text: 'duty of care /s negligence' }, { performed: 'type' }), id: 'r1', created_at: '2026-09-28T10:00:01Z' });
    const other = summarizeAction(action('search_passages', { terms: ['x'] }, { matches: [], total: 0 }));
    const live = [
      { activity: 'research_act', detail: 'duty of care /s negligence', at },
      { activity: 'research_navigate', detail: '1.next.westlaw.com/Document/I0abc', at: at + 2000 },
    ];
    const lines = researchLines([other, receipt], live);
    expect(lines.map(line => [line.label, line.pending])).toEqual([
      ['Searched: duty of care /s negligence', false],
      ['Opened 1.next.westlaw.com/Document/I0abc', true],
    ]);
    // A receipt recorded well before the live step is an earlier, separate step.
    const earlier = summarizeAction({ ...action('research_act', { action: 'type', text: 'duty of care /s negligence' }, {}), id: 'r0', created_at: '2026-09-28T09:50:00Z' });
    expect(researchLines([earlier], live.slice(0, 1)).map(line => line.pending)).toEqual([false, true]);
    expect(researchLines([], [], 6)).toEqual([]);
    expect(researchLines([], Array.from({ length: 9 }, (_, index) => ({ activity: 'research_read_page', detail: `line ${index}`, at: at + index })), 6).map(line => line.label).at(0)).toBe('Read line 3');
  });

  it('says when a sign-in page is showing and when an action opened a new page', () => {
    const status = summarizeAction(action('research_status', {}, { open: true, on_research_site: false, host: 'signon.thomsonreuters.com', action_needed: 'Ask the user to sign in.' }));
    expect(status).toMatchObject({ verb: 'Checked the research browser', result: 'sign-in or outside page showing' });
    expect(status.facts).toEqual([{ label: 'Page', value: 'signon.thomsonreuters.com' }, { label: 'Next', value: 'Ask the user to sign in.' }]);
    expect(summarizeAction(action('research_status', {}, { open: true, on_research_site: true, url: 'https://next.westlaw.com/x', title: 'Search results' })).facts).toEqual([{ label: 'Page', value: 'Search results' }]);
    const click = summarizeAction(action('research_act', { action: 'click', ref: 'e4', snapshot_version: 3, text: null, key: null }, { performed: 'click', url: 'https://next.westlaw.com/Document/X', navigated: true, snapshot: {} }));
    expect(click).toMatchObject({ verb: 'Clicked on the page', result: 'opened a page on next.westlaw.com' });
    expect(summarizeAction(action('research_act', { action: 'scroll_down', ref: null, snapshot_version: null, text: null, key: null }, { performed: 'scroll_down', url: 'https://next.westlaw.com/Document/X', navigated: false, snapshot: {} })).result).toBeUndefined();
  });

  it('labels research tools while they run instead of calling them team work', () => {
    expect(liveLabel('research_navigate')).toBe('Opening a research page');
    expect(liveLabel('research_act')).toBe('Working in the research browser');
    expect(liveLabel('research_read_page')).toBe('Reading the research page');
    expect(liveLabel('research_capture')).toBe('Saving an authority');
    expect(liveLabel('request_more_research')).toBe('Briefing the team');
  });

  it('adds the backend detail to a running research step, and only to research steps', () => {
    expect(liveLabel('research_act', 'duty of care /s negligence')).toBe('Searched: duty of care /s negligence');
    expect(liveLabel('research_navigate', '1.next.westlaw.com/Document/I0abc')).toBe('Opened 1.next.westlaw.com/Document/I0abc');
    expect(liveLabel('research_act', '')).toBe('Working in the research browser');
    expect(liveLabel('search_passages', 'ignored')).toBe('Searching the evidence');
  });
});

describe('research step actions', () => {
  it('reads a typed query that starts with "click" as a search, not a click', () => {
    expect(researchStepLabel('research_act', 'click-wrap enforceability', 'type')).toBe('Searched: click-wrap enforceability');
    expect(researchStepLabel('research_act', 'click', 'click')).toBe('Clicked on the page');
    expect(researchStepLabel('research_act', 'press Enter', 'press')).toBe('Pressed Enter');
    expect(researchStepLabel('research_act', 'scroll_down', 'scroll_down')).toBe('Scrolled down');
  });
  it('labels saved receipts from their arguments, so a click-like query stays a search after refresh', () => {
    const summary = summarizeAction({ id: 'a1', name: 'research_act', input: JSON.stringify({ action: 'type', ref: 'e4', snapshot_version: 2, text: 'click-wrap enforceability', key: null }), output: '{}', status: 'complete', created_at: '2026-09-28T00:00:00Z' } as never);
    expect(`${summary.verb} ${summary.object}`).toBe('Searched: click-wrap enforceability');
  });
});

it('counts distinct original sources rather than receipt IDs or working notes', () => {
  const steps=[summarizeAction(action('read_record',{}, {title:'Derived note'})),summarizeAction(action('read_receipt',{},{})),summarizeAction(action('inspect_artifact_image',{source_id:'s1'},{})),summarizeAction(action('inspect_automatic_video_batch',{}, {frames:[{source_id:'s1'},{source_id:'v1'},{source_id:'v1'}]}))];
  expect(traceRecap(steps)).toBe('consulted 2 sources');
});
