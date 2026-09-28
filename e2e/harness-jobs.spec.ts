import { expect, test } from '@playwright/test';
import { calls, lastCall, openHarness } from './harness-support';

// Jobs show only units the backend reports: determinate progress needs both a
// completed and total count; everything else stays indeterminate.

test('jobs show real units only, with determinate progress only when a total is reported', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+5');
  await expect(page.getByRole('heading', { name: 'Jobs & issues' })).toBeVisible();
  const card = (jobId: string) => page.locator('article.job-card').filter({ hasText: `Receipt ${jobId}` });

  const transcript = card(fx.jobs.transcriptRunning);
  const bar = transcript.getByRole('progressbar');
  await expect(bar).toHaveAttribute('aria-valuenow', String(Math.round((96.4 / 212) * 100)));
  await expect(transcript.getByRole('status')).toHaveText('interactive · attempt 1 · 96 seconds processed / 212 · 31 segments');

  // Seconds indexed without a total: units shown, no percentage bar.
  const video = card(fx.jobs.videoIndexRunning);
  await expect(video.getByRole('status')).toHaveText('normal · attempt 1 · 640 seconds indexed');
  await expect(video.getByRole('progressbar')).toHaveCount(0);

  // No measurable units: no invented number.
  const prepare = card(fx.jobs.prepareRunning);
  await expect(prepare.getByRole('status')).toHaveText('normal · attempt 1');
  await expect(prepare.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(1);
  for (const call of await calls(page, 'job_progress')) expect(call.args).toMatchObject({ case_id: fx.caseA.id, session_epoch: 1 });

  // New backend units flow through on the next poll.
  await page.evaluate(id => window.__vislexHarness!.setJobProgress(id, { unit: 'seconds processed', completed: 150, total: 212, segments: 48, track: 1, tracks: 1 }), fx.jobs.transcriptRunning);
  await expect(bar).toHaveAttribute('aria-valuenow', '71', { timeout: 8000 });

  // When progress cannot be read, running jobs fall back to an honest indeterminate state.
  await page.evaluate(() => window.__vislexHarness!.fail('job_progress', 'Synthetic failure: progress unavailable'));
  await page.evaluate(() => window.__vislexHarness!.emitCaseEvent());
  await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 8000 });
  await expect(page.getByText('Running · no measurable units reported yet')).toHaveCount(3);
});

test('failed and interrupted jobs recover with exact receipts, and failures surface', async ({ page }) => {
  const fx = await openHarness(page);
  await page.keyboard.press('Control+5');
  await page.getByRole('button', { name: 'Needs attention', exact: true }).click();
  const failed = page.locator('article.job-card').filter({ hasText: `Receipt ${fx.jobs.failed}` });
  await expect(failed.getByRole('alert')).toContainText('PDF renderer exited before page 3');
  await failed.getByRole('button', { name: 'Recover saved job' }).click();
  expect((await lastCall(page, 'resume_processing')).args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, job_id: fx.jobs.failed });

  const interrupted = page.locator('article.job-card').filter({ hasText: `Receipt ${fx.jobs.interrupted}` });
  await interrupted.getByRole('button', { name: 'Retry index from saved progress' }).click();
  expect((await lastCall(page, 'retry_video_discovery')).args).toEqual({ case_id: fx.caseA.id, session_epoch: 1, run_id: fx.jobs.interrupted });

  // A backend refusal is routed to the error toast and the card stays actionable.
  await page.getByRole('button', { name: 'Working', exact: true }).click();
  await page.evaluate(() => window.__vislexHarness!.fail('cancel_processing', 'Synthetic failure: job already finished', 1));
  const video = page.locator('article.job-card').filter({ hasText: `Receipt ${fx.jobs.videoIndexRunning}` });
  await video.getByRole('button', { name: 'Cancel' }).click();
  const toast = page.getByRole('alert').filter({ hasText: 'Something went wrong' });
  await expect(toast).toBeVisible();
  await toast.getByText('Show detail').click();
  await expect(toast).toContainText('job already finished');
  await expect(video.getByRole('button', { name: 'Cancel' })).toBeEnabled();

  // History keeps superseded failures and tool-error receipts visible.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByText('Earlier failures and interruptions replaced by newer runs (1)').click();
  await expect(page.getByText('audio decoder rejected track 2')).toBeVisible();
  await page.getByText(/Previous AI tool errors/).click();
  await page.getByText('render page · 3 previous failures').click();
  await expect.poll(async () => (await calls(page, 'issue_history')).length).toBe(1);
});
