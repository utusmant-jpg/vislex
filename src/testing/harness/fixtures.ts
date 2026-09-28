// Synthetic case fixtures for the mocked-IPC Playwright harness.
//
// Everything here is invented for software testing. Every source body starts
// with a SYNTHETIC banner, names are fictional, and no real person, place,
// matter or recording is represented. Nothing in this module ships in the
// production bundle (only harness.html imports it).
import type { AIConfig, Action, Job, Revision, Settings, Source, Task, WorkingRecord } from '../../types';

export const SYNTHETIC_BANNER = 'SYNTHETIC — NOT REAL EVIDENCE';

/** Small deterministic PRNG so fixtures are identical on every load. */
export function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic UUID-shaped identifier (the backend uses UUIDs for ids). */
export function syntheticId(namespace: string, index: number): string {
  const random = prng(hashString(`${namespace}:${index}`));
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function syntheticSha(seed: string): string {
  const random = prng(hashString(`sha:${seed}`));
  return Array.from({ length: 64 }, () => Math.floor(random() * 16).toString(16)).join('');
}

export type EvidenceObject = { id: string; revision: number; kind: string; title: string; content: string; source_ids: string[]; locators: string[]; review: string; stale: boolean; actor: string; start_seconds: number | null; end_seconds: number | null; dependencies: { id: string; revision: number }[] };
export type Segment = { ordinal: number; track: number; start: number; end: number; text: string; word_count?: number; uncertain_words?: { word: string; start: number; end: number; probability: number }[]; correction?: { id: string; revision: number; text: string; review: 'pending' | 'accepted' | 'rejected' } };
export type HarnessSource = Source & {
  /** Extracted text by extraction revision; absent for sources without text. */
  revisions?: Record<number, string[]>;
  currentRevision: number;
  pageCount?: number;
  durationSeconds?: number;
  /** Text original over the indexing limit: read page by page from the original, never cited by line. */
  rawOriginal?: boolean;
};
export type HarnessJob = Job & { cursor: number; priority: string; attempt: number; progress: null | { unit: string; completed?: number; total?: number; segments?: number; track?: number; tracks?: number }; result?: Record<string, unknown> };
export type Claim = { proposition: string; assessment: string; supporting: string[]; contrary: string[]; uncertainty: string; next_check: string };
export type Investigation = { task_id: string; question: string; status: string; view: { stale: boolean; completion_stale: boolean; dossier: { revision: number; claims: Claim[] } }; previous: { claims: Claim[] } | null; hypotheses: { alternatives: { explanation: string; unresolved_premise: string; prediction: string; discriminating_check: string; citations: string[] }[] } | null };

export type HarnessCase = {
  id: string; name: string; root: string; generation: number;
  settings: Settings; ai_config: AIConfig; aiScope: 'app' | 'case'; accessOverride: 'app' | 'api_keys' | 'chatgpt_subscription'; directMedia: boolean;
  sources: HarnessSource[];
  records: WorkingRecord[]; recordHistory: Record<string, Revision[]>;
  tasks: Task[]; titles: Record<string, string>; actions: Record<string, Action[]>; hiddenConversations: Set<string>;
  jobs: HarnessJob[];
  evidence: EvidenceObject[];
  investigations: Investigation[];
  transcripts: Record<string, { jobId: string; segments: Segment[]; recordId: string; status: string; progress?: Record<string, number | string> }>;
  auditSeq: number; lastUpdate: string; chatPause: string | null;
  issues: { task_id: string; name: string; error: string; count: number; latest_receipt: string; created_at: string }[];
};

/** Stable handles tests use to reach specific fixture objects. */
export const FIXTURE = {
  caseA: { id: syntheticId('case', 1), name: 'Harbor Street · synthetic harness case', root: 'C:\\Synthetic\\Harbor Street (SYNTHETIC).ledcase' },
  caseB: { id: syntheticId('case', 2), name: 'Riverside depot · synthetic second case', root: 'C:\\Synthetic\\Riverside depot (SYNTHETIC).ledcase' },
  statement: syntheticId('source', 0),
  report: syntheticId('source', 1),
  photo: syntheticId('source', 2),
  call: syntheticId('source', 3),
  camera: syntheticId('source', 4),
  email: syntheticId('source', 5),
  longName: syntheticId('source', 6),
  restricted: syntheticId('source', 7),
  timelineConversation: syntheticId('task', 0),
  jobs: {
    transcriptRunning: syntheticId('job', 0),
    videoIndexRunning: syntheticId('job', 1),
    prepareRunning: syntheticId('job', 2),
    queued: syntheticId('job', 3),
    failed: syntheticId('job', 4),
    interrupted: syntheticId('job', 5),
  },
} as const;

const statementV1 = [
  SYNTHETIC_BANNER,
  'Witness statement W-01 · Harbor Street north entrance',
  'Prepared only to exercise VisLex software. Fictional content.',
  '',
  'At about 14:30 I saw two people standing near the north entrance.',
  'One of them carried a blue holdall bag over the left shoulder.',
  'I did not recognise either person.',
  '',
  'The clock on the camera monitor read 14:32 when I looked at it.',
  'I cannot say whether that clock was accurate.',
];
const statementV2 = [
  SYNTHETIC_BANNER,
  'Witness statement W-01 · Harbor Street north entrance',
  'Prepared only to exercise VisLex software. Fictional content.',
  '',
  'At approximately 14:32 I saw two people standing near the north entrance.',
  'One of them carried a dark blue holdall bag over the right shoulder.',
  'I did not recognise either person and did not hear them speak.',
  '',
  'The clock on the camera monitor read 14:32 when I looked at it.',
  'I cannot say whether that clock was accurate.',
  '',
  'Review questions',
  '1. Can the number of people be corroborated by the camera export?',
  '2. Does the blue bag appear in more than one source?',
  '3. What uncertainty remains in the displayed time?',
];

function paragraphLines(random: () => number, title: string, count: number): string[] {
  const phrases = [
    'The synthetic observer notes the loading bay door was partly open.',
    'A grey van is described near the kerb; the registration is not legible.',
    'Lighting at the entrance is described as uneven after sunset.',
    'The account does not identify any person by name.',
    'This line exists to exercise long document paging in the viewer.',
    'The displayed time on the device has not been reconciled to a reference clock.',
    'A second account places the same vehicle on the east side instead.',
    'No conclusion should be drawn from this fictional passage.',
  ];
  const lines = [SYNTHETIC_BANNER, title, 'Fictional material generated for VisLex interface testing.', ''];
  for (let index = 0; index < count; index++) lines.push(`${index + 1}. ${phrases[Math.floor(random() * phrases.length)]}`);
  return lines;
}

function iso(now: number, minutesAgo: number) { return new Date(now - minutesAgo * 60_000).toISOString(); }

type SourceSpec = { kind: string; mime: string; ext: string; stems: string[]; statuses: string[] };
const sourceSpecs: SourceSpec[] = [
  { kind: 'pdf', mime: 'application/pdf', ext: 'pdf', stems: ['Incident report', 'Maintenance log extract', 'Delivery manifest', 'Site plan annotated', 'Shift roster', 'Insurance correspondence'], statuses: ['pages rendered · text extracted', 'pages rendered · text extracted', 'document preview available · extraction pending', 'extraction failed · original preserved'] },
  { kind: 'text', mime: 'text/plain', ext: 'txt', stems: ['Witness statement', 'Officer notebook transcription', 'Interview notes', 'Neighbour canvass notes', 'Timeline worksheet'], statuses: ['text indexed', 'text indexed', 'text indexed'] },
  { kind: 'image', mime: 'image/jpeg', ext: 'jpg', stems: ['Scene photograph', 'Doorway close-up', 'Loading bay wide shot', 'Screen capture of monitor', 'Bag detail photograph'], statuses: ['image preview ready', 'image preview ready', 'queued for processing'] },
  { kind: 'audio', mime: 'audio/wav', ext: 'wav', stems: ['Dispatch call recording', 'Interview audio', 'Voicemail export', 'Radio channel capture'], statuses: ['text transcribed · all audio tracks · unreviewed', 'transcription running', 'transcript record missing · needs attention'] },
  { kind: 'video', mime: 'video/mp4', ext: 'mp4', stems: ['North entrance camera', 'Loading bay camera', 'Street camera export', 'Body-worn camera clip', 'Phone video'], statuses: ['overview indexed · visual review pending', 'processing', 'no audio tracks · visual review pending'] },
  { kind: 'other', mime: 'message/rfc822', ext: 'eml', stems: ['Email from facilities', 'Email thread re access cards', 'Forwarded email with attachment list'], statuses: ['text extracted · unreviewed'] },
];

const LONG_NAME = '2026-09-14 Harbor Street north entrance camera 04 continuous recording segment 3 of 7 re-exported after codec failure with operator annotations and duplicate timestamps (SYNTHETIC — NOT REAL EVIDENCE) final copy for review.txt';

/** Build the large synthetic case: ~250 sources across every kind. */
export function buildHarborCase(now: number, sourceCount = 250): HarnessCase {
  const random = prng(20260914);
  const sources: HarnessSource[] = [];
  const fixed: { name: string; kind: string; mime: string; status: string; restricted?: boolean; revisions?: Record<number, string[]>; currentRevision?: number; pageCount?: number; durationSeconds?: number }[] = [
    { name: '01 · Witness statement W-01 north entrance (SYNTHETIC).txt', kind: 'text', mime: 'text/plain', status: 'text indexed', revisions: { 1: statementV1, 2: statementV2 }, currentRevision: 2 },
    { name: '02 · Incident report HS-2026-0914 (SYNTHETIC).pdf', kind: 'pdf', mime: 'application/pdf', status: 'pages rendered · text extracted', pageCount: 12, revisions: { 1: paragraphLines(random, 'Incident report HS-2026-0914', 180) } },
    { name: '03 · Scene photograph north doorway (SYNTHETIC).jpg', kind: 'image', mime: 'image/jpeg', status: 'image preview ready' },
    { name: '04 · Dispatch call recording 14-31 (SYNTHETIC).wav', kind: 'audio', mime: 'audio/wav', status: 'text transcribed · all audio tracks · unreviewed', durationSeconds: 212 },
    { name: '05 · North entrance camera 04 (SYNTHETIC).mp4', kind: 'video', mime: 'video/mp4', status: 'overview indexed · visual review pending', durationSeconds: 1800 },
    { name: '06 · Email from facilities re door alarm (SYNTHETIC).eml', kind: 'other', mime: 'message/rfc822', status: 'text extracted · unreviewed', revisions: { 1: [SYNTHETIC_BANNER, 'From: facilities@synthetic.invalid', 'To: review-team@synthetic.invalid', 'Subject: North door alarm log (fictional)', '', 'The door alarm log shows two openings between 14:28 and 14:35.', 'The alarm panel clock drifts; it was last set in an unknown month.', 'This email is fictional test data.'] } },
    { name: LONG_NAME, kind: 'text', mime: 'text/plain', status: 'text indexed', revisions: { 1: paragraphLines(random, 'Long name export notes', 1200) } },
    { name: '08 · Medical summary (SYNTHETIC, restricted).pdf', kind: 'pdf', mime: 'application/pdf', status: 'pages rendered · text extracted', restricted: true, pageCount: 3, revisions: { 1: paragraphLines(random, 'Restricted synthetic summary', 30) } },
  ];
  fixed.forEach((spec, index) => {
    sources.push({
      id: syntheticId('source', index), name: spec.name, sha256: syntheticSha(spec.name), size: Math.floor(4_000 + random() * 40_000_000),
      mime: spec.mime, kind: spec.kind, status: spec.status, restricted: !!spec.restricted, occurrences: 1 + Math.floor(random() * 2),
      created_at: iso(now, 60 * 24 * 3 - index), revisions: spec.revisions, currentRevision: spec.currentRevision ?? 1, pageCount: spec.pageCount, durationSeconds: spec.durationSeconds,
    });
  });
  for (let index = fixed.length; index < sourceCount; index++) {
    const spec = sourceSpecs[index % sourceSpecs.length];
    const stem = spec.stems[Math.floor(random() * spec.stems.length)];
    const long = index % 37 === 0;
    const name = `${String(index + 1).padStart(3, '0')} · ${stem} ${long ? 'with an unusually long descriptive file name that keeps going to test truncation and tooltips in every list ' : ''}#${index + 1} (SYNTHETIC).${spec.ext}`;
    const text = spec.kind === 'text' || spec.kind === 'other' || (spec.kind === 'pdf' && !/pending|failed/.test(spec.statuses[index % spec.statuses.length]));
    sources.push({
      id: syntheticId('source', index), name, sha256: syntheticSha(name), size: Math.floor(1_000 + random() * (spec.kind === 'video' ? 900_000_000 : 20_000_000)),
      mime: spec.mime, kind: spec.kind, status: spec.statuses[index % spec.statuses.length], restricted: index % 21 === 0, occurrences: 1,
      created_at: iso(now, 60 * 24 * 3 - index * 7), revisions: text ? { 1: paragraphLines(random, stem, 20 + Math.floor(random() * 120)) } : undefined,
      currentRevision: 1, pageCount: spec.kind === 'pdf' ? 1 + Math.floor(random() * 40) : undefined, durationSeconds: ['audio', 'video'].includes(spec.kind) ? 30 + Math.floor(random() * 3600) : undefined,
    });
  }
  // One oversized plain-text original: viewable page by page, not indexed or citable (mirrors case.rs read_original_lines).
  const oversized = sources.find((item, index) => index >= fixed.length && item.kind === 'text' && !item.restricted);
  if (oversized) Object.assign(oversized, { rawOriginal: true, status: 'text viewable · over 10 MB, not indexed', size: 48_000_000 });
  const statement = FIXTURE.statement, report = FIXTURE.report, photo = FIXTURE.photo, call = FIXTURE.call, camera = FIXTURE.camera, email = FIXTURE.email;

  const recordBase = (index: number, title: string, kind: string, content: string, extra: Partial<WorkingRecord>): WorkingRecord => ({ id: syntheticId('record', index), title, kind, content, revision: 1, actor: 'human', review: 'unreviewed', protected: false, stale: false, updated_at: iso(now, 30 + index * 11), dependencies: [], ...extra });
  const records: WorkingRecord[] = [
    recordBase(0, 'Initial review notes (SYNTHETIC)', 'note', `# Initial review\n\nThe statement reports two people near the north entrance. This is an attributed claim, not an independently verified observation.\n\nSource: evidence:${statement}#R2L5-L7\n\nSynthetic demonstration only.`, { revision: 3, dependencies: [statement], review: 'human-reviewed' }),
    recordBase(1, 'Timeline draft · north entrance (SYNTHETIC)', 'report', `# Timeline draft\n\n| Time (displayed) | Event | Source |\n|---|---|---|\n| 14:28 | Door alarm opening | evidence:${email}#L6-L6 |\n| 14:32 | Two people seen | evidence:${statement}#R2L5-L5 |\n\nDisplayed clocks are unverified.`, { revision: 5, actor: 'agent', stale: true, dependencies: [statement, email] }),
    recordBase(2, 'Dispatch call transcript (machine, unreviewed)', 'transcript', '[track 0 · 00:00:01.000 → 00:00:04.500] Synthetic caller: I can see two people at the north door.\n[track 0 · 00:00:05.000 → 00:00:08.000] Synthetic dispatcher: Can you describe them?', { actor: 'processor', dependencies: [call] }),
    recordBase(3, 'Locked chronology for counsel review (SYNTHETIC)', 'report', '# Chronology\n\nLocked against agent edits while under human review.', { revision: 2, protected: true, review: 'human-reviewed' }),
    recordBase(4, 'Camera clock reconciliation notes', 'clock', 'Anchor candidates listed; none independently checked yet.', { dependencies: [camera] }),
  ];
  for (let index = 5; index < 60; index++) records.push(recordBase(index, `Working note ${index + 1} · ${['canvass', 'exhibit list', 'issue', 'person', 'event'][index % 5]} (SYNTHETIC)`, ['note', 'report', 'issue', 'person', 'event'][index % 5], `# Working note ${index + 1}\n\nFictional working file for list and paging tests.`, { review: index % 4 === 0 ? 'human-reviewed' : 'unreviewed', stale: index % 9 === 0, protected: index % 13 === 0, actor: index % 3 === 0 ? 'agent' : 'human' }));
  const recordHistory: Record<string, Revision[]> = {};
  for (const record of records) {
    recordHistory[record.id] = Array.from({ length: record.revision }, (_, index) => ({ revision: index + 1, title: record.title, content: index + 1 === record.revision ? record.content : `${record.content}\n\n(Earlier synthetic revision ${index + 1}.)`, actor: index === 0 ? 'human' : record.actor, review: 'unreviewed', reason: index === 0 ? 'Create working record' : 'Manual editor save', task_id: null, created_at: iso(now, 400 - index * 30) }));
  }

  const tasks: Task[] = [];
  const actions: Record<string, Action[]> = {};
  const titles: Record<string, string> = {};
  const conversation0 = FIXTURE.timelineConversation;
  const makeTask = (index: number, conversation: string, prompt: string, answer: string, minutesAgo: number, extra: Partial<Task> = {}): Task => {
    const id = syntheticId('task', index);
    const task: Task = { id, conversation_id: conversation, prompt, mode: 'investigate', status: 'complete', input_tokens: 18_000 + index * 311, output_tokens: 1_200 + index * 17, step: 6, answer, error: '', generation: 1, created_at: iso(now, minutesAgo), updated_at: iso(now, minutesAgo - 1.4), title: null, ...extra };
    actions[id] = [
      { id: syntheticId('action', index * 10), name: 'search', input: '{"query":"north entrance"}', output: 'Synthetic search receipt: 3 passages matched.', status: 'complete', created_at: task.created_at },
      { id: syntheticId('action', index * 10 + 1), name: 'read_text', input: `{"source_id":"${statement}"}`, output: 'Synthetic read receipt: lines 1–15, revision 2.', status: 'complete', created_at: task.created_at },
      ...(index === 1 ? [{ id: syntheticId('action', index * 10 + 2), name: 'render_page', input: `{"source_id":"${report}","page":4}`, output: 'Synthetic failure: page renderer timed out.', status: 'failed', created_at: task.created_at }] : []),
    ];
    return task;
  };
  tasks.push(makeTask(0, conversation0, 'Build a timeline of the north entrance events from the statements', `Two synthetic accounts describe people near the north entrance around 14:30.\n\n- The current statement wording places the sighting at approximately 14:32 evidence:${statement}#R2L5-L5\n- The earlier extraction said "about 14:30" evidence:${statement}#R1L5-L5\n- The facilities email reports two door openings evidence:${email}#L6-L6\n\nDisplayed clocks remain unverified; see the incident report evidence:${report}#L10-L12.`, 180, { progress: { summary: 'Timeline drafted', citations: [], gaps: ['Camera clock not reconciled'], next_steps: [] , checkpoint_step: 6, duplicate_reads: 0 } }));
  tasks.push(makeTask(1, conversation0, 'Does the blue bag appear in more than one source?', `The bag is described in the statement evidence:${statement}#R2L6-L6 and appears in a photograph evidence:${photo}#image. The camera export has not been reviewed frame by frame evidence:${camera}#media.`, 170, { progress: { summary: 'Bag cross-check', citations: [], gaps: ['Frames between samples not inspected'], next_steps: ['Inspect camera 04 between 14:30 and 14:36', 'Compare the bag colour in the photograph with the statement'], checkpoint_step: 4, duplicate_reads: 0 } }));
  titles[conversation0] = 'North entrance timeline (SYNTHETIC)';
  const others: [string, string, number, Partial<Task>][] = [
    ['Summarize the dispatch call recording', `The synthetic caller reports two people evidence:${call}#media. The transcript is unreviewed.`, 60 * 26, {}],
    ['Which sources mention the grey van?', '', 60 * 30, { status: 'failed', error: 'Provider returned an error: synthetic rate limit reached. No answer was saved.', answer: '' }],
    ['List the exhibits for the north entrance issue', '', 60 * 50, { status: 'paused', error: 'Stopped by user', answer: '' }],
    ['What evidence is missing or unverified?', 'Several recordings have not been transcribed yet; see Jobs & issues.', 60 * 24 * 4, {}],
    ['Compare witness W-01 with the facilities email', `The email evidence:${email}#L6-L7 and statement evidence:${statement}#R2L5-L9 differ on timing.`, 60 * 24 * 9, {}],
    ['Find contradictions across the sources', 'No contradiction is asserted; three timing differences need checks.', 60 * 24 * 12, {}],
    ['Review the camera export for the bag', 'Sampled frames only; exhaustive review not performed.', 60 * 24 * 15, {}],
    ['Draft questions for the second interview', 'Draft saved as an unreviewed working file.', 60 * 24 * 20, {}],
    ['Explain the clock drift note', 'The alarm panel clock drift is unknown.', 60 * 24 * 25, {}],
  ];
  others.forEach(([prompt, answer, minutesAgo, extra], offset) => {
    const index = offset + 2;
    const task = makeTask(index, syntheticId('task', index), prompt, answer, minutesAgo, extra);
    tasks.push(task);
  });

  const jobs: HarnessJob[] = [];
  const job = (key: string, index: number, sourceIndex: number, kind: string, status: string, extra: Partial<HarnessJob> = {}): HarnessJob => ({ id: key, source_id: sources[sourceIndex].id, name: sources[sourceIndex].name, kind, status, error: '', created_at: iso(now, 90 - index), cursor: 1000 - index, priority: 'normal', attempt: 1, progress: null, superseded: false, parent_run_id: null, ...extra });
  jobs.push(job(FIXTURE.jobs.transcriptRunning, 0, 9, 'full_audio', 'running', { priority: 'interactive', progress: { unit: 'seconds processed', completed: 96.4, total: 212, segments: 31, track: 1, tracks: 1 } }));
  jobs.push(job(FIXTURE.jobs.videoIndexRunning, 1, 4, 'video_overview_index', 'running', { progress: { unit: 'seconds indexed', completed: 640 } }));
  jobs.push(job(FIXTURE.jobs.prepareRunning, 2, 12, 'auto_prepare', 'running'));
  jobs.push(job(FIXTURE.jobs.queued, 3, 15, 'full_audio', 'queued'));
  jobs.push(job(FIXTURE.jobs.failed, 4, 12 + 6, 'pdf_page', 'failed', { error: 'Synthetic failure: the PDF renderer exited before page 3. The original is unchanged; recover to retry from saved progress.' }));
  jobs.push(job(FIXTURE.jobs.interrupted, 5, 10, 'video_ocr_index', 'interrupted', { error: 'Synthetic interruption: the application closed during indexing.' }));
  jobs.push(job(syntheticId('job', 6), 6, 15, 'auto_prepare', 'cancelled'));
  jobs.push(job(syntheticId('job', 7), 7, 21, 'full_audio', 'failed', { error: 'Synthetic failure: audio decoder rejected track 2.', superseded: true }));
  for (let index = 8; index < 70; index++) jobs.push(job(syntheticId('job', index), index, 8 + (index % 200), ['auto_prepare', 'full_audio', 'video_overview_index'][index % 3], 'complete'));

  const evidence: EvidenceObject[] = [];
  const object = (index: number, kind: string, title: string, content: string, extra: Partial<EvidenceObject> = {}): EvidenceObject => ({ id: syntheticId('object', index), revision: 1, kind, title, content, source_ids: [statement], locators: [`evidence:${statement}#R2L5-L7`], review: 'unreviewed', stale: false, actor: 'agent', start_seconds: null, end_seconds: null, dependencies: [], ...extra });
  evidence.push(object(0, 'observation', 'Two people reported near the north entrance', 'Attributed claim from W-01. Not independently verified.', { review: 'accepted', revision: 2 }));
  evidence.push(object(1, 'statement', 'Bag colour differs between extraction revisions', 'Revision 1 wording: blue; revision 2: dark blue.', { locators: [`evidence:${statement}#R1L6-L6`, `evidence:${statement}#R2L6-L6`] }));
  evidence.push(object(2, 'hypothesis', 'Door alarm openings match the sighting', 'Unreviewed hypothesis; depends on unreconciled clocks.', { stale: true, source_ids: [email, statement], locators: [`evidence:${email}#L6-L6`] }));
  evidence.push(object(3, 'claim', 'Camera clock displayed 14:32', 'Displayed time only.', { review: 'rejected' }));
  evidence.push(object(4, 'clock', 'Clock proposal · North entrance camera 04', JSON.stringify({ clock_domain: 'container_relative', anchors: [], fit: { status: 'held_out_checks_passed' } }), { review: 'accepted', source_ids: [camera], locators: [] }));
  evidence.push(object(5, 'clock', 'Clock proposal · Loading bay camera', JSON.stringify({ clock_domain: 'container_relative' }), { review: 'accepted', source_ids: [sources[10].id], locators: [] }));
  evidence.push(object(6, 'clock', 'Clock proposal · Street camera (stale)', JSON.stringify({ clock_domain: 'container_relative' }), { stale: true, source_ids: [sources[16].id], locators: [] }));
  evidence.push(object(7, 'issue', 'Account comparison · W-01 vs facilities email', JSON.stringify({ schema: 'witness_comparison_v1', category: 'uncertain_clock', first: 'About 14:32', second: 'Openings 14:28–14:35', next_check: 'Reconcile the alarm panel clock' }), { source_ids: [statement, email], locators: [`evidence:${statement}#R2L5-L5`, `evidence:${email}#L6-L6`] }));
  for (let index = 8; index < 40; index++) evidence.push(object(index, ['observation', 'event', 'entity', 'note'][index % 4], `Synthetic finding ${index + 1}`, `Fictional finding ${index + 1} for paging.`, { review: index % 5 === 0 ? 'accepted' : 'unreviewed' }));

  const claim = (proposition: string, assessment: string, supporting: string[], contrary: string[]): Claim => ({ proposition, assessment, supporting, contrary, uncertainty: 'Displayed clocks are not reconciled.', next_check: 'Inspect the original camera export around the reported time.' });
  const investigations: Investigation[] = [
    { task_id: syntheticId('task', 0), question: 'Does W-01 agree with the other evidence about the north entrance?', status: 'complete', view: { stale: false, completion_stale: false, dossier: { revision: 3, claims: [claim('Two people were near the north entrance at about 14:32', 'partly_supported', [`evidence:${statement}#R2L5-L5`], [`evidence:${email}#L6-L6`]), claim('The bag was dark blue', 'unresolved', [`evidence:${statement}#R2L6-L6`], [`evidence:${statement}#R1L6-L6`])] } }, previous: { claims: [claim('Two people were near the north entrance at about 14:30', 'partly_supported', [`evidence:${statement}#R1L5-L5`], [])] }, hypotheses: { alternatives: [{ explanation: 'The witness saw staff leaving a shift', unresolved_premise: 'Shift roster timing', prediction: 'Roster lists two staff leaving at 14:30', discriminating_check: 'Compare the roster with the camera export', citations: [`evidence:${statement}#R2L5-L7`] }] } },
    { task_id: syntheticId('task', 3), question: 'Which sources mention the grey van?', status: 'running', view: { stale: true, completion_stale: false, dossier: { revision: 1, claims: [] } }, previous: null, hypotheses: null },
  ];

  const transcripts: HarnessCase['transcripts'] = {
    [call]: { jobId: syntheticId('job', 90), recordId: records[2].id, status: 'complete', segments: Array.from({ length: 60 }, (_, index) => ({ ordinal: index, track: 0, start: index * 3.5, end: index * 3.5 + 3, text: `${index % 2 ? 'Synthetic dispatcher' : 'Synthetic caller'}: fictional line ${index + 1} of the dispatch call.`, word_count: 8, ...(index === 4 || index === 7 ? { uncertain_words: [{ word: ' fictional', start: index * 3.5 + 1, end: index * 3.5 + 1.4, probability: 0.32 }] } : {}), ...(index === 2 ? { correction: { id: syntheticId('correction', 2), revision: 1, text: 'Synthetic caller: I can see two people at the north door.', review: 'pending' as const } } : {}) })) },
    [sources[9].id]: { jobId: FIXTURE.jobs.transcriptRunning, recordId: '', status: 'running', segments: [], progress: { state: 'transcribing', track_number: 1, track_count: 1, processed_seconds: 96.4, estimated_seconds: 212, segments: 31 } },
  };

  return {
    id: FIXTURE.caseA.id, name: FIXTURE.caseA.name, root: FIXTURE.caseA.root, generation: 4,
    settings: { offline: false, allow_text: true, allow_images: false, model: 'harness-model-alpha' },
    ai_config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [{ provider: 'anthropic', model: 'harness-model-beta', allow_text: true, allow_images: false }] },
    aiScope: 'app', accessOverride: 'app', directMedia: false,
    sources, records, recordHistory, tasks, titles, actions, hiddenConversations: new Set(),
    jobs, evidence, investigations, transcripts,
    auditSeq: 412, lastUpdate: iso(now, 5), chatPause: null,
    issues: [{ task_id: syntheticId('task', 1), name: 'render_page', error: 'Synthetic failure: page renderer timed out.', count: 3, latest_receipt: syntheticId('action', 12), created_at: iso(now, 170) }],
  };
}

/** A small second case used for case-switch and late-response tests. */
export function buildRiversideCase(now: number): HarnessCase {
  const random = prng(8801);
  const sources: HarnessSource[] = Array.from({ length: 8 }, (_, index) => {
    const spec = sourceSpecs[index % sourceSpecs.length];
    const name = `R${index + 1} · Riverside ${spec.stems[0].toLowerCase()} (SYNTHETIC).${spec.ext}`;
    return { id: syntheticId('riverside-source', index), name, sha256: syntheticSha(name), size: 2_000 + Math.floor(random() * 5_000_000), mime: spec.mime, kind: spec.kind, status: spec.statuses[0], restricted: false, occurrences: 1, created_at: iso(now, 600 - index), revisions: ['text', 'other', 'pdf'].includes(spec.kind) ? { 1: paragraphLines(random, `Riverside ${spec.stems[0]}`, 30) } : undefined, currentRevision: 1, pageCount: spec.kind === 'pdf' ? 4 : undefined, durationSeconds: ['audio', 'video'].includes(spec.kind) ? 120 : undefined };
  });
  return {
    id: FIXTURE.caseB.id, name: FIXTURE.caseB.name, root: FIXTURE.caseB.root, generation: 1,
    settings: { offline: false, allow_text: true, allow_images: false, model: 'harness-model-alpha' },
    ai_config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [] },
    aiScope: 'app', accessOverride: 'app', directMedia: false,
    sources, records: [], recordHistory: {}, tasks: [], titles: {}, actions: {}, hiddenConversations: new Set(),
    jobs: [], evidence: [], investigations: [], transcripts: {},
    auditSeq: 3, lastUpdate: iso(now, 600), chatPause: null, issues: [],
  };
}
