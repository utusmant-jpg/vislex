import { describe, expect, it } from 'vitest';
import { EMPTY_PROGRESS, applyProgress } from './live-progress';

describe('applyProgress', () => {
  it('records a research step when the backend sends an activity with its detail', () => {
    let state = applyProgress(EMPTY_PROGRESS, { transmission_id: 't1', delta: { activity: 'research_act' } }, 1);
    // The provider naming the tool it requested is not a step the backend ran.
    expect(state).toMatchObject({ activity: 'research_act', detail: '', steps: [] });
    state = applyProgress(state, { transmission_id: 't1', delta: { activity: 'research_act', detail: ' duty of care /s negligence ' } }, 2);
    expect(state.detail).toBe('duty of care /s negligence');
    expect(state.steps).toEqual([{ activity: 'research_act', detail: 'duty of care /s negligence', at: 2 }]);
    // Text and character deltas keep the current activity and detail.
    state = applyProgress(state, { transmission_id: 't1', delta: { characters: 12 } }, 3);
    expect(state).toMatchObject({ activity: 'research_act', detail: 'duty of care /s negligence', characters: 12 });
  });

  it('keeps research steps across transmissions while the draft text starts again', () => {
    let state = applyProgress(EMPTY_PROGRESS, { transmission_id: 't1', delta: { activity: 'research_navigate', detail: 'next.westlaw.com/Search' } }, 1);
    state = applyProgress(state, { transmission_id: 't1', delta: { text: 'partial ' } }, 2);
    state = applyProgress(state, { transmission_id: 't2', delta: { activity: 'research_read_page', detail: 'lines 0–49' } }, 3);
    expect(state.text).toBe('');
    expect(state.transmission).toBe('t2');
    expect(state.steps.map(step => step.detail)).toEqual(['next.westlaw.com/Search', 'lines 0–49']);
  });

  it('accepts a research event without a detail as the label alone', () => {
    const state = applyProgress(EMPTY_PROGRESS, { transmission_id: 't1', delta: { activity: 'research_capture', detail: '' } }, 5);
    expect(state.steps).toEqual([{ activity: 'research_capture', detail: '', at: 5 }]);
    // A new activity with no detail clears the previous one.
    expect(applyProgress(state, { transmission_id: 't1', delta: { activity: 'finish_task' } }).detail).toBe('');
  });

  it('keeps only the latest fifty steps', () => {
    let state = EMPTY_PROGRESS;
    for (let index = 0; index < 60; index += 1) state = applyProgress(state, { transmission_id: 't1', delta: { activity: 'research_snapshot', detail: `main ${index}` } }, index);
    expect(state.steps).toHaveLength(50);
    expect(state.steps[0].detail).toBe('main 10');
  });
});
