import { describe, expect, it } from 'vitest';
import {
  APP_STOPPED_REASON, CHAT_PREEMPTION_REASON, COORDINATOR_STOP_REASON, USER_STOP_REASON,
  composerBlock, settingsPath, settledAnnouncement, turnOutcome, usageOf,
} from './turn-state';

describe('turnOutcome', () => {
  it('reports a user Stop as a neutral stopped state, not a failure', () => {
    expect(turnOutcome({ status: 'paused', error: USER_STOP_REASON })).toEqual({ kind: 'stopped', pill: 'stopped', label: 'Stopped' });
    expect(turnOutcome({ status: 'paused', error: COORDINATOR_STOP_REASON }).kind).toBe('stopped');
  });

  it('keeps a chat preemption or bare pause neutral', () => {
    expect(turnOutcome({ status: 'paused', error: CHAT_PREEMPTION_REASON })).toEqual({ kind: 'paused', pill: 'paused', label: 'Paused' });
    expect(turnOutcome({ status: 'paused', error: '' }).pill).toBe('paused');
  });

  it('flags a pause with an unexplained reason or an application stop for review', () => {
    expect(turnOutcome({ status: 'paused', error: 'Provider response incomplete' })).toEqual({ kind: 'paused', pill: 'needs-attention', label: 'Paused' });
    expect(turnOutcome({ status: 'paused', error: APP_STOPPED_REASON })).toEqual({ kind: 'interrupted', pill: 'needs-attention', label: 'Interrupted' });
  });

  it('reserves the failure tone for failed turns', () => {
    expect(turnOutcome({ status: 'failed', error: 'Provider returned an error' }).pill).toBe('failed');
    expect(turnOutcome({ status: 'complete', error: 'late error' }).kind).toBe('failed');
    expect(turnOutcome({ status: 'complete', error: '' })).toEqual({ kind: 'complete', pill: 'complete', label: 'Saved response' });
    expect(turnOutcome({ status: 'running', error: '' }).label).toBe('Working');
    expect(turnOutcome({ status: 'queued', error: '' }).label).toBe('Pending');
  });
});

describe('settledAnnouncement', () => {
  it('announces only the transition out of running', () => {
    expect(settledAnnouncement(undefined, { status: 'complete', error: '' })).toBeNull();
    expect(settledAnnouncement('complete', { status: 'complete', error: '' })).toBeNull();
    expect(settledAnnouncement('running', { status: 'running', error: '' })).toBeNull();
    expect(settledAnnouncement('running', { status: 'complete', error: '' })).toBe('Response saved.');
    expect(settledAnnouncement('running', { status: 'paused', error: USER_STOP_REASON })).toBe('Response stopped.');
    // Problems carry the backend's reason (its first line) into the announcement.
    expect(settledAnnouncement('running', { status: 'failed', error: 'x' })).toBe('Response did not complete: x');
    expect(settledAnnouncement('running', { status: 'failed', error: '' })).toBe('Response did not complete.');
    expect(settledAnnouncement('running', { status: 'paused', error: APP_STOPPED_REASON })).toBe(`Response interrupted: ${APP_STOPPED_REASON}`);
    expect(settledAnnouncement('running', { status: 'paused', error: 'Provider stopped before completing the response: quota\nraw body' })).toBe('Response paused: Provider stopped before completing the response: quota');
    expect(settledAnnouncement('running', { status: 'paused', error: '' })).toBe('Response paused.');
  });
});

describe('settingsPath', () => {
  it('names the scope and section where each block is changed', () => {
    expect(settingsPath('Case permissions', 'case')).toBe('Settings → Case permissions → This case');
    expect(settingsPath('Privacy & offline', 'case')).toBe('Settings → Privacy & offline → This case');
    expect(settingsPath('Accounts & models')).toBe('Settings → Accounts & models');
  });
});

describe('composerBlock', () => {
  const settings = { offline: false, allow_text: true, allow_images: false, model: 'm' };
  const base = { native: true, snapshot: { settings }, accessKnown: true, subscriptionActive: false, modelReady: true, preparing: false };

  it('allows sending when every condition holds', () => {
    expect(composerBlock(base)).toBeNull();
    expect(composerBlock({ ...base, snapshot: null })).toBeNull();
  });

  it('states the first blocking reason and the settings section that changes it', () => {
    expect(composerBlock({ ...base, native: false })?.reason).toBe('desktop');
    expect(composerBlock({ ...base, snapshot: { settings: { ...settings, offline: true, allow_text: false } } })).toMatchObject({ reason: 'offline', section: 'Privacy & offline', scope: 'case' });
    expect(composerBlock({ ...base, snapshot: { settings: { ...settings, allow_text: false } } })).toMatchObject({ reason: 'text-grant', section: 'Case permissions', scope: 'case', message: 'This case does not permit sending case text to AI.' });
    expect(composerBlock({ ...base, accessKnown: false })).toMatchObject({ reason: 'access-route', section: 'Accounts & models', scope: 'case' });
    expect(composerBlock({ ...base, modelReady: false })).toMatchObject({ reason: 'no-model', section: 'Accounts & models', scope: 'case' });
    expect(composerBlock({ ...base, modelReady: false, subscriptionActive: true })).toMatchObject({ reason: 'subscription-model', scope: 'case' });
    expect(composerBlock({ ...base, preparing: true })).toEqual({ reason: 'preparing', message: 'Preparing case files before chat is available.' });
  });

  it('checks the case text grant separately from model availability', () => {
    // A ready model does not make case text sendable.
    expect(composerBlock({ ...base, modelReady: true, snapshot: { settings: { ...settings, allow_text: false } } })?.reason).toBe('text-grant');
  });
});

describe('usageOf', () => {
  it('sums reported usage and counts only turns that reported any', () => {
    expect(usageOf([{ input_tokens: 10, output_tokens: 5 }, { input_tokens: 0, output_tokens: 0 }, { input_tokens: 1, output_tokens: 2 }]))
      .toEqual({ input: 11, output: 7, total: 18, reportedTurns: 2 });
    expect(usageOf([])).toEqual({ input: 0, output: 0, total: 0, reportedTurns: 0 });
  });
});
