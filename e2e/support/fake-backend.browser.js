/*
 * VisLex mocked-IPC harness — in-page synthetic backend.
 *
 * Classic (non-module) script injected with page.addInitScript before any app
 * code runs. It installs `globalThis.isTauri = true` and a fake
 * `window.__TAURI_INTERNALS__` so the PRODUCTION React UI behaves as if it were
 * running inside the native shell, while every `invoke('command', {action,args})`
 * is answered here from a clearly SYNTHETIC dataset.
 *
 * Nothing in this file reads or writes real case data. All names, people,
 * statements and media are fictional and labelled SYNTHETIC.
 *
 * Options are read from `window.__VISLEX_FAKE_OPTIONS__` (set by the loader):
 *   dataset      'rich' | 'empty' | 'large'         (default 'rich')
 *   openAtStart  boolean — the first `snapshot` returns an open case (default true)
 *   streamMode   'auto' | 'manual' — whether start_task streams and completes by itself
 *   streamMs     approximate duration of an automatic stream (default 2000)
 *   latencyMs    default response latency for every command (default 4)
 *
 * Test controls live on `window.__vislexFake` (see the bottom of this file).
 */
(() => {
  'use strict';
  if (window.__vislexFake) return;
  const options = Object.assign({ dataset: 'rich', openAtStart: true, streamMode: 'auto', streamMs: 2000, latencyMs: 4 }, window.__VISLEX_FAKE_OPTIONS__ || {});

  /* ------------------------------------------------------------------ utils */
  function prng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const nowMs = Date.now();
  const iso = minutesAgo => new Date(nowMs - minutesAgo * 60_000).toISOString();
  const hex = (rand, length) => Array.from({ length }, () => Math.floor(rand() * 16).toString(16)).join('');
  const pick = (rand, list) => list[Math.floor(rand() * list.length)];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  class HarnessError extends Error {}

  /* ------------------------------------------------------- tauri internals */
  const callbacks = new Map();
  let nextCallback = 1;
  const listeners = new Map(); // event -> Map<eventId, callbackId>
  let nextEventId = 1;
  const calls = [];
  const unhandled = [];
  const delays = {};
  const failures = {};
  const dialogQueue = { open: [], save: [], ask: [], confirm: [], message: [] };

  function transformCallback(callback, once = false) {
    const id = nextCallback++;
    callbacks.set(id, data => { if (once) callbacks.delete(id); return callback && callback(data); });
    return id;
  }
  function runCallback(id, data) { const callback = callbacks.get(id); if (callback) callback(data); }
  function emit(event, payload) {
    const registered = listeners.get(event);
    if (!registered) return 0;
    let delivered = 0;
    for (const [eventId, callbackId] of [...registered]) { runCallback(callbackId, { event, id: eventId, payload: clone(payload) }); delivered += 1; }
    return delivered;
  }
  function convertFileSrc(filePath, protocol = 'asset') { return `http://${protocol}.localhost/${encodeURIComponent(filePath)}`; }

  async function invoke(cmd, args = {}, _options) {
    const entry = { cmd, action: cmd === 'command' ? args.action : null, args: clone(cmd === 'command' ? args.args ?? {} : args), at: Date.now() };
    calls.push(entry);
    if (cmd === 'plugin:event|listen') {
      const id = nextEventId++;
      if (!listeners.has(args.event)) listeners.set(args.event, new Map());
      listeners.get(args.event).set(id, args.handler);
      return id;
    }
    if (cmd === 'plugin:event|unlisten') { listeners.get(args.event)?.delete(args.eventId); return null; }
    if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') { emit(args.event, args.payload); return null; }
    if (cmd.startsWith('plugin:dialog|')) {
      const kind = cmd.slice('plugin:dialog|'.length);
      const queue = dialogQueue[kind];
      const value = queue && queue.length ? queue.shift() : null;
      return value;
    }
    if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:webview|') || cmd.startsWith('plugin:app|')) {
      if (cmd.endsWith('|is_maximized') || cmd.endsWith('|is_fullscreen') || cmd.endsWith('|is_minimized')) return false;
      if (cmd.endsWith('|scale_factor')) return window.devicePixelRatio || 1;
      return null;
    }
    if (cmd !== 'command') { unhandled.push(cmd); throw `Synthetic harness: unsupported IPC command ${cmd}`; }
    const action = args.action;
    const payload = args.args ?? {};
    const wait = delays[action] ?? options.latencyMs;
    if (wait) await delay(wait);
    const failure = failures[action];
    if (failure) { if (failure.once) delete failures[action]; throw failure.message; }
    try {
      return clone(handle(action, payload));
    } catch (error) {
      if (error instanceof HarnessError) throw error.message;
      throw String(error && error.message ? error.message : error);
    }
  }

  globalThis.isTauri = true;
  window.__TAURI_INTERNALS__ = Object.assign(window.__TAURI_INTERNALS__ || {}, {
    invoke, transformCallback, convertFileSrc, runCallback,
    unregisterCallback: id => callbacks.delete(id),
    callbacks,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    plugins: {},
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = Object.assign(window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {}, {
    unregisterListener(event, eventId) { const callbackId = listeners.get(event)?.get(eventId); listeners.get(event)?.delete(eventId); if (callbackId) callbacks.delete(callbackId); },
  });

  /* ------------------------------------------------------------ dataset */
  const CASE_ID = 'case-harbor-synthetic';
  const CASE_NAME = 'Harbor Street · synthetic matter';
  const CASE_ROOT = 'C:\\Synthetic\\Harbor Street (SYNTHETIC).ledcase';
  const PROVIDER_MODELS = {
    openai: [{ id: 'gpt-4.1', name: 'gpt-4.1' }, { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini' }, { id: 'o4-mini', name: 'o4-mini' }],
    anthropic: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }, { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }],
    gemini: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    xai: [{ id: 'grok-4', name: 'Grok 4' }],
    openrouter: [{ id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' }, { id: 'mistralai/mistral-large', name: 'Mistral Large' }],
  };

  function filler(rand, count, topic) {
    const openers = ['I recall that', 'To the best of my memory', 'I noticed that', 'Later I saw that', 'I am unsure whether', 'I was told by a colleague that', 'From where I stood'];
    const subjects = ['the delivery van', 'a cyclist', 'the kiosk attendant', 'a person in a red cap', 'the security guard', 'two office workers', 'a taxi', 'the loading bay door'];
    const verbs = ['moved toward', 'stood near', 'passed', 'waited beside', 'looked at', 'walked away from', 'stopped by'];
    const places = ['the north entrance', 'Harbor Street', 'the bus shelter', 'the side gate', 'the car park barrier', 'the café terrace'];
    const endings = ['.', ', but I did not see their face.', ', although it was raining lightly.', ' for about a minute.', ' — I cannot be precise about the time.', '.'];
    return Array.from({ length: count }, (_, i) => i % 9 === 8 ? '' : `${pick(rand, openers)} ${pick(rand, subjects)} ${pick(rand, verbs)} ${pick(rand, places)}${pick(rand, endings)} [${topic}, SYNTHETIC]`);
  }
  function document(seed, count, header, featured) {
    const rand = prng(seed);
    const lines = [...header, ...filler(rand, Math.max(0, count - header.length), 'filler')].slice(0, count);
    for (const [line, text] of Object.entries(featured || {})) lines[Number(line) - 1] = text;
    return lines;
  }
  const banner = ['SYNTHETIC DEMONSTRATION — NOT REAL EVIDENCE', ''];

  function richSources() {
    const rand = prng(20260920);
    const alvarez = document(11, 240, [...banner, 'Witness statement of R. Alvarez (fictional person)', 'Taken 2026-09-20 at 16:10 by Officer J. Park (fictional)', '', 'I have read this statement and it is true to the best of my recollection.', '', 'Background', 'I work at the newsagent kiosk opposite the north entrance on Harbor Street.', 'My shift that day began at 09:00.', ''], {
      12: 'At approximately 14:32 I was standing by the kiosk opposite the north entrance.',
      13: 'I saw two people near the north entrance doors.',
      14: 'One of them, the taller one, wore a grey hooded jacket.',
      15: 'The other carried a blue holdall with a silver zipper.',
      16: 'They spoke briefly and then walked toward Harbor Street.',
      17: 'I did not see either of them enter the building.',
      18: 'I am not sure of the exact time; I checked my phone a few minutes later.',
    });
    const oseiCurrent = document(12, 120, [...banner, 'I saw two or three people by the north door; one of them may have been waiting for a taxi.', 'The group was there for a short time, perhaps two minutes.', 'I could not see whether anyone carried a bag.', 'The light was poor because the canopy lamp was off.', 'I left at about 14:40.'], {});
    const oseiRev1 = oseiCurrent.slice();
    oseiRev1[2] = 'I saw three people by the north d0or; one of them may have been waiting for a taxi.';
    oseiRev1[3] = 'The gr0up was there for a short time, perhaps tw0 minutes.';
    oseiRev1[4] = 'I could n0t see whether anyone carried a bag.';
    oseiRev1[6] = 'I left at ab0ut 14:40. [superseded OCR extraction — SYNTHETIC]';
    const dispatch = Array.from({ length: 400 }, (_, i) => {
      if (i < 2) return banner[i];
      const seconds = 14 * 3600 + 20 * 60 + i * 7;
      const stamp = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (i === 39) return `${stamp} CALL 5521 — caller reports a disturbance near the north entrance (SYNTHETIC)`;
      if (i === 40) return `${stamp} UNIT 12 assigned; ETA 6 minutes (SYNTHETIC)`;
      if (i === 41) return `${stamp} CALLER adds: two people, one with a blue bag (SYNTHETIC)`;
      if (i === 42) return `${stamp} UNIT 12 en route (SYNTHETIC)`;
      if (i === 43) return `${stamp} NOTE camera 3 clock reported as running fast; not verified (SYNTHETIC)`;
      return `${stamp} ${pick(rand, ['STATUS', 'UNIT 7', 'UNIT 12', 'NOTE', 'CALL'])} ${pick(rand, ['routine patrol update', 'radio check', 'no further information', 'awaiting callback', 'area quiet'])} (SYNTHETIC)`;
    });
    const chen = document(13, 80, [...banner, 'Supplementary statement — M. Chen (fictional person)', 'I arrived at the north entrance at about 14:45, after the people had left.', 'A blue holdall was lying near the second bollard.', 'I did not touch it and told the guard.'], {});
    const longName = document(14, 60, [...banner, 'Supplementary annotations for the witness bundle (SYNTHETIC).', 'Cross references are illustrative only.'], {});
    const rtl = document(15, 64, [...banner, 'إفادة شاهد — نص اصطناعي للاختبار فقط (SYNTHETIC)', 'رأيت شخصين قرب المدخل الشمالي.', 'لا أعرف الوقت بدقة.'], {});
    const medical = document(16, 90, [...banner, 'Medical note — restricted (SYNTHETIC)', 'This source is restricted from AI analysis in the synthetic matter.'], {});
    const roster = ['SYNTHETIC DEMONSTRATION — NOT REAL EVIDENCE', 'Sheet 1 · Shift roster', 'Name\tRole\tStart\tEnd', ...Array.from({ length: 57 }, (_, i) => `Staff ${String(i + 1).padStart(2, '0')} (fictional)\t${pick(rand, ['Guard', 'Reception', 'Cleaner', 'Facilities'])}\t${String(6 + (i % 10)).padStart(2, '0')}:00\t${String(14 + (i % 8)).padStart(2, '0')}:00`)];
    const memo = document(17, 110, [...banner, 'Internal memo — building facilities (SYNTHETIC)', 'Subject: canopy lamp outage at the north entrance', 'The canopy lamp was reported faulty on 2026-09-18 and repaired on 2026-09-21.'], {});
    const call = document(18, 70, [...banner, 'Transcript extract placeholder (SYNTHETIC)'], {});
    const sha = seed => hex(prng(seed), 64);
    const base = [
      { id: 'txt-witness-alvarez', name: '01 · Witness statement — R. Alvarez (SYNTHETIC).txt', mime: 'text/plain', kind: 'text', status: 'text indexed', revisions: { 1: alvarez } },
      { id: 'txt-witness-osei', name: '02 · Witness statement — K. Osei (SYNTHETIC).txt', mime: 'text/plain', kind: 'text', status: 'text indexed · re-extracted', revisions: { 1: oseiRev1, 2: oseiCurrent } },
      { id: 'txt-dispatch-log', name: '03 · Dispatch log excerpt (SYNTHETIC).txt', mime: 'text/plain', kind: 'text', status: 'text indexed', revisions: { 1: dispatch } },
      { id: 'pdf-incident-report', name: '04 · Incident report (SYNTHETIC).pdf', mime: 'application/pdf', kind: 'pdf', status: 'pages rendered · text indexed', pages: 6, revisions: { 1: document(19, 180, [...banner, 'Incident report (SYNTHETIC)'], {}) } },
      { id: 'img-north-entrance', name: '05 · North entrance photograph (SYNTHETIC).png', mime: 'image/png', kind: 'image', status: 'image prepared' },
      { id: 'img-blue-holdall', name: '06 · Blue holdall close-up (SYNTHETIC).png', mime: 'image/png', kind: 'image', status: 'image prepared' },
      { id: 'vid-cctv-north', name: '07 · CCTV north entrance 14-30 (SYNTHETIC).mp4', mime: 'video/mp4', kind: 'video', status: 'overview sampled · OCR interrupted' },
      { id: 'aud-emergency-call', name: '08 · Emergency call recording (SYNTHETIC).wav', mime: 'audio/wav', kind: 'audio', status: 'transcript saved', revisions: { 1: call } },
      { id: 'doc-shift-roster', name: '09 · Shift roster (SYNTHETIC).xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'other', status: 'text indexed', revisions: { 1: roster } },
      { id: 'doc-facilities-memo', name: '10 · Facilities memo (SYNTHETIC).docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'other', status: 'text indexed', revisions: { 1: memo } },
      { id: 'txt-annotations-long', name: '11 · Ṡupplementary annotations très‑longues — 証拠写真 北口 — witness bundle cross references with extended commentary, second revision, final final (SYNTHETIC).txt', mime: 'text/plain', kind: 'text', status: 'text indexed', revisions: { 1: longName } },
      { id: 'txt-medical-note', name: '12 · Medical note (SYNTHETIC, restricted).txt', mime: 'text/plain', kind: 'text', status: 'text indexed', restricted: true, revisions: { 1: medical } },
      { id: 'txt-witness-chen', name: '13 · Supplementary statement — M. Chen (SYNTHETIC).txt', mime: 'text/plain', kind: 'text', status: 'text indexed', revisions: { 1: chen } },
      { id: 'txt-witness-rtl', name: '14 · إفادة شاهد — نص اصطناعي (SYNTHETIC).txt', mime: 'text/plain', kind: 'text', status: 'text indexed', revisions: { 1: rtl } },
    ];
    const sizes = { text: 18_000, pdf: 482_113, image: 5_103, video: 4_432, audio: 333_590, other: 36_625 };
    return base.map((source, index) => ({
      restricted: false, occurrences: index === 4 ? 2 : 1, created_at: iso(600 - index * 7), sha256: sha(100 + index),
      size: source.revisions ? source.revisions[Object.keys(source.revisions).length].join('\n').length + sizes[source.kind] % 997 : sizes[source.kind],
      ...source,
    })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  function richRecords() {
    return [
      { id: 'rec-timeline', title: 'Timeline — north entrance (SYNTHETIC)', kind: 'report', revision: 3, actor: 'agent', review: 'unreviewed', protected: false, stale: false, updated_at: iso(18), dependencies: ['txt-witness-alvarez', 'txt-dispatch-log'], content: '# Timeline — north entrance (SYNTHETIC)\n\nDisplayed camera clock only; not reconciled to a reference clock.\n\n- 14:29 dispatcher logs call 5521 — evidence:txt-dispatch-log#R1L40-L42\n- 14:32 witness reports two people — evidence:txt-witness-alvarez#R1L12-L18\n- 14:45 holdall found near bollard — evidence:txt-witness-chen#R1L4-L5\n' },
      { id: 'rec-review-notes', title: 'Review notes — witness accounts (SYNTHETIC)', kind: 'note', revision: 5, actor: 'human', review: 'human-reviewed', protected: false, stale: false, updated_at: iso(45), dependencies: ['txt-witness-alvarez', 'txt-witness-osei'], content: '# Review notes (SYNTHETIC)\n\nAlvarez reports two people; Osei (current extraction) reports two or three.\n\nSources: evidence:txt-witness-alvarez#R1L13-L13 and evidence:txt-witness-osei#R2L3-L3\n' },
      { id: 'rec-stale-summary', title: 'Summary of the emergency call (SYNTHETIC)', kind: 'report', revision: 2, actor: 'agent', review: 'unreviewed', protected: false, stale: true, updated_at: iso(160), dependencies: ['aud-emergency-call', 'txt-witness-osei'], content: '# Emergency call summary (SYNTHETIC)\n\nThis summary cites an extraction revision that has since been superseded: evidence:txt-witness-osei#R1L3-L7\n' },
      { id: 'rec-transcript-call', title: 'Transcript — emergency call (machine, unreviewed)', kind: 'transcript', revision: 1, actor: 'agent', review: 'unreviewed', protected: false, stale: false, updated_at: iso(200), dependencies: ['aud-emergency-call'], content: '[track 1 · 00:00:00.000 → 00:00:04.200] Emergency, which service? (SYNTHETIC)\n[track 1 · 00:00:04.200 → 00:00:09.900] There are two people by the north entrance. (SYNTHETIC)\n' },
      { id: 'rec-open-questions', title: 'Open questions (SYNTHETIC)', kind: 'note', revision: 4, actor: 'human', review: 'human-reviewed', protected: true, stale: false, updated_at: iso(320), dependencies: [], content: '# Open questions (SYNTHETIC)\n\n1. Reconcile the CCTV clock with the dispatch log.\n2. Obtain the canopy lamp maintenance record.\n' },
    ];
  }

  const answerTimeline = [
    '## Timeline — north entrance (SYNTHETIC)',
    '',
    'All times below are the **camera\'s displayed clock** or the times stated by witnesses. None has been reconciled to a reference clock.',
    '',
    '| Displayed time | Event | Source |',
    '|---|---|---|',
    '| 14:29 | Dispatcher logs call 5521 about a disturbance | evidence:txt-dispatch-log#R1L40-L42 |',
    '| ~14:32 | Witness Alvarez reports two people near the north entrance | evidence:txt-witness-alvarez#R1L12-L18 |',
    '| ~14:45 | Chen finds a blue holdall near the second bollard | evidence:txt-witness-chen#R1L4-L5 |',
    '',
    '### What is uncertain',
    '',
    '- Alvarez says she is "not sure of the exact time" — evidence:txt-witness-alvarez#R1L18-L18.',
    '- Dispatch notes that camera 3 may run fast; this is **not verified** — evidence:txt-dispatch-log#R1L44-L44.',
    '',
    '> This is an AI-assisted working summary. It is not a finding of fact and has not been reviewed.',
  ].join('\n');
  const answerCount = [
    'The accounts differ on **how many people** were present:',
    '',
    '1. Alvarez: two people — evidence:txt-witness-alvarez#R1L13-L13',
    '2. Osei, *superseded* extraction: three people — evidence:txt-witness-osei#R1L3-L7',
    '3. Osei, current extraction: "two or three" — evidence:txt-witness-osei#L3-L7',
    '',
    'The earlier Osei wording came from an OCR pass that has since been re-extracted. Treat the revision-1 wording as historical.',
  ].join('\n');
  const answerCompare = [
    '### Comparison of the two main accounts (SYNTHETIC)',
    '',
    '- **Agreement:** both place people at the north entrance shortly after 14:30 — evidence:txt-witness-alvarez#R1L12-L13, evidence:txt-witness-osei#L3-L4',
    '- **Difference:** only Alvarez mentions a blue holdall — evidence:txt-witness-alvarez#R1L15-L15',
    '- **Context:** the canopy lamp was out, which may explain Osei\'s uncertainty — evidence:doc-facilities-memo#R1L4-L5',
    '',
    'Next check: inspect CCTV frames around the displayed 14:32 mark.',
  ].join('\n');
  const streamAnswer = [
    'Reviewing the witness statement and the dispatch log for the requested window (SYNTHETIC).',
    '',
    '**Finding (unreviewed):** Alvarez places two people at the north entrance at about 14:32 — evidence:txt-witness-alvarez#R1L12-L18.',
    '',
    'The dispatcher recorded call 5521 three minutes earlier — evidence:txt-dispatch-log#R1L40-L42. The camera clock remains unreconciled, so the order of events is provisional.',
  ].join('\n');

  function task(id, conversation, prompt, minutesAgo, extra) {
    return Object.assign({ id, conversation_id: conversation, prompt, title: null, mode: 'investigate', status: 'complete', input_tokens: 18_422, output_tokens: 1_307, step: 7, answer: '', error: '', generation: 3, created_at: iso(minutesAgo), answer_truncated: false }, extra);
  }
  function richTasks() {
    return [
      task('task-timeline-2', 'conv-timeline', 'Which sources disagree about the number of people?', 12, { answer: answerCount, step: 5, input_tokens: 9_812, output_tokens: 644, progress: { summary: 'Compared people counts across statements.', citations: ['evidence:txt-witness-alvarez#R1L13-L13'], gaps: ['CCTV frames not yet inspected'], next_steps: ['Inspect CCTV frames around 14:32 displayed time', 'Ask whether Osei wore glasses that evening'], checkpoint_step: 5, duplicate_reads: 0 } }),
      task('task-timeline-1', 'conv-timeline', 'Build a timeline of what happened at the north entrance between 14:25 and 14:45.', 26, { title: 'Timeline of the north entrance incident', answer: answerTimeline, step: 9, input_tokens: 31_204, output_tokens: 1_902 }),
      task('task-compare-1', 'conv-compare', 'Compare the two main witness accounts.', 95, { title: 'Compare the two witness accounts', answer: answerCompare, step: 12, input_tokens: 52_110, output_tokens: 2_406 }),
      task('task-call-1', 'conv-call', 'Summarize the emergency call and list every time reference.', 180, { title: 'Summarize the emergency call', status: 'paused', answer: '', error: 'Stopped by user', step: 3, input_tokens: 6_120, output_tokens: 211 }),
      task('task-cctv-1', 'conv-cctv', 'Identify the people visible on the CCTV between 14:30 and 14:35.', 260, { title: 'Review CCTV 14:30–14:35', status: 'failed', answer: '', error: 'The provider returned HTTP 529 (overloaded) after 3 attempts. Saved progress is available; no answer was produced. (SYNTHETIC)', step: 4, input_tokens: 12_882, output_tokens: 0 }),
    ];
  }
  function actionsFor(taskId) {
    const at = minutesAgo => iso(minutesAgo);
    const lists = {
      'task-timeline-1': [
        ['search_passages', 'complete', '{"query":"north entrance"}', '6 passages matched across 3 sources (SYNTHETIC).'],
        ['read_text', 'complete', '{"source_id":"txt-witness-alvarez","start":1,"count":60}', 'Read evidence:txt-witness-alvarez#R1L1-L60 (60 lines).'],
        ['read_text', 'complete', '{"source_id":"txt-dispatch-log","start":30,"count":30}', 'Read evidence:txt-dispatch-log#R1L30-L59 (30 lines).'],
        ['inspect_video_frames', 'failed', '{"source_id":"vid-cctv-north","start":120,"end":140}', 'Frame sampler timed out at 00:02:10 (synthetic fault). Frames sampled before this point remain valid.'],
        ['inspect_video_frames', 'complete', '{"source_id":"vid-cctv-north","start":120,"end":130}', 'Inspected 11 sampled frames. Sampling does not establish absence of events between samples.'],
        ['write_record', 'complete', '{"title":"Timeline — north entrance (SYNTHETIC)"}', 'Saved working file "Timeline — north entrance (SYNTHETIC)" revision 3.'],
        ['finish_task', 'complete', '{}', 'Answer submitted with 5 citations; 5 validated.'],
      ],
      'task-timeline-2': [
        ['search_passages', 'complete', '{"query":"people"}', '9 passages matched across 4 sources (SYNTHETIC).'],
        ['read_extract_revision', 'complete', '{"source_id":"txt-witness-osei","revision":1}', 'Read historical revision 1 lines 1–20.'],
        ['read_text', 'complete', '{"source_id":"txt-witness-osei"}', 'Read current revision 2 lines 1–20.'],
        ['finish_task', 'complete', '{}', 'Answer submitted with 3 citations; 3 validated.'],
      ],
      'task-compare-1': [
        ['delegate_team', 'complete', '{"roles":["reader","challenger"]}', 'Started 2 assignments in separate working contexts.'],
        ['read_text', 'complete', '{"source_id":"txt-witness-alvarez"}', 'Read 60 lines.'],
        ['read_text', 'complete', '{"source_id":"txt-witness-osei"}', 'Read 40 lines.'],
        ['finish_task', 'complete', '{}', 'Answer submitted with 5 citations; 5 validated.'],
      ],
      'task-call-1': [
        ['read_text', 'complete', '{"source_id":"aud-emergency-call"}', 'Read transcript segments 1–12.'],
        ['search_passages', 'complete', '{"query":"time"}', '3 passages matched.'],
      ],
      'task-cctv-1': [
        ['inspect_video_frames', 'complete', '{"source_id":"vid-cctv-north","start":0,"end":60}', 'Inspected 13 sampled frames.'],
        ['inspect_video_frames', 'failed', '{"source_id":"vid-cctv-north","start":60,"end":120}', 'Provider request failed: HTTP 529 overloaded (SYNTHETIC).'],
      ],
    };
    const live = state && state.liveActions[taskId];
    if (live) return live;
    return (lists[taskId] || []).map(([name, status, input, output], index) => ({ id: `rcpt-${taskId}-${index + 1}`, name, input, output, status, created_at: at(30 - index) }));
  }
  function richJobs() {
    return [
      { id: 'job-transcribe-call', source_id: 'aud-emergency-call', name: '08 · Emergency call recording (SYNTHETIC).wav', kind: 'full_audio', status: 'running', error: '', created_at: iso(9) },
      { id: 'job-video-overview', source_id: 'vid-cctv-north', name: '07 · CCTV north entrance 14-30 (SYNTHETIC).mp4', kind: 'video_overview_index', status: 'running', error: '', created_at: iso(11) },
      { id: 'job-ocr-photo', source_id: 'img-blue-holdall', name: '06 · Blue holdall close-up (SYNTHETIC).png', kind: 'image_ocr', status: 'queued', error: '', created_at: iso(12) },
      { id: 'job-render-pdf', source_id: 'pdf-incident-report', name: '04 · Incident report (SYNTHETIC).pdf', kind: 'render_pdf', status: 'failed', error: 'Page 5 could not be rendered: synthetic decoder fault (exit code 3). Pages 1–4 remain available.', created_at: iso(40) },
      { id: 'job-video-ocr', source_id: 'vid-cctv-north', name: '07 · CCTV north entrance 14-30 (SYNTHETIC).mp4', kind: 'video_ocr_index', status: 'interrupted', error: 'Interrupted when the app closed at 00:41:12 of 01:12:00. 492 sampled frames were saved.', created_at: iso(70) },
      { id: 'job-extract-alvarez', source_id: 'txt-witness-alvarez', name: '01 · Witness statement — R. Alvarez (SYNTHETIC).txt', kind: 'extract_text', status: 'complete', error: '', created_at: iso(300) },
      { id: 'job-extract-memo', source_id: 'doc-facilities-memo', name: '10 · Facilities memo (SYNTHETIC).docx', kind: 'extract_text', status: 'cancelled', error: '', created_at: iso(310) },
      { id: 'job-render-pdf-old', source_id: 'pdf-incident-report', name: '04 · Incident report (SYNTHETIC).pdf', kind: 'render_pdf', status: 'failed', error: 'Renderer crashed before page 1 (synthetic).', superseded: true, parent_run_id: null, created_at: iso(500) },
    ];
  }
  const jobProgress = {
    'job-transcribe-call': { priority: 'interactive', attempt: 1, progress: { unit: 'seconds', completed: 84, total: 212, segments: 31 } },
    'job-video-overview': { priority: 'background', attempt: 2, progress: null },
  };
  function richFindings() {
    return [
      { id: 'ev-claim-two-people', revision: 2, kind: 'claim', title: 'Two people were near the north entrance at about 14:32 (SYNTHETIC)', content: 'Attributed to Alvarez; partly corroborated by Osei (current extraction).', source_ids: ['txt-witness-alvarez', 'txt-witness-osei'], locators: ['evidence:txt-witness-alvarez#R1L12-L18', 'evidence:txt-witness-osei#R1L3-L7'], review: 'accepted', stale: false, actor: 'human', start_seconds: null, end_seconds: null, dependencies: [] },
      { id: 'ev-event-call', revision: 1, kind: 'event', title: 'Emergency call 5521 logged (SYNTHETIC)', content: 'Dispatcher entry at displayed 14:29:07.', source_ids: ['txt-dispatch-log'], locators: ['evidence:txt-dispatch-log#R1L40-L42'], review: 'unreviewed', stale: false, actor: 'agent', start_seconds: 0, end_seconds: 30, dependencies: [] },
      { id: 'ev-issue-count', revision: 3, kind: 'issue', title: 'Head count differs between statements (SYNTHETIC)', content: JSON.stringify({ schema: 'witness_comparison_v1', category: 'changed_account', first: 'Two people (Alvarez).', second: 'Three people (Osei, superseded extraction).', next_check: 'Inspect CCTV frames at displayed 14:32.' }), source_ids: ['txt-witness-alvarez', 'txt-witness-osei'], locators: ['evidence:txt-witness-alvarez#R1L13-L13', 'evidence:txt-witness-osei#R1L3-L7'], review: 'unreviewed', stale: true, actor: 'agent', start_seconds: null, end_seconds: null, dependencies: [{ id: 'ev-claim-two-people', revision: 1 }] },
      { id: 'ev-clock-cctv', revision: 1, kind: 'clock', title: 'CCTV camera 3 clock mapping (SYNTHETIC)', content: 'Offset-only fit from two anchors; unreviewed.', source_ids: ['vid-cctv-north'], locators: ['evidence:vid-cctv-north#media'], review: 'unreviewed', stale: false, actor: 'agent', start_seconds: 0, end_seconds: 600, dependencies: [] },
    ];
  }

  function largeData() {
    const rand = prng(10_000);
    const words = ['statement', 'invoice', 'bodycam', 'photo', 'ledger', 'memo', 'transcript', 'email export', 'receipt', 'site plan', 'interview', 'dispatch'];
    const rtlNames = ['إفادة شاهد', 'דוח אירוע', 'سجل المكالمات', 'תמליל ראיון'];
    const kinds = [['txt', 'text', 'text/plain', '.txt'], ['pdf', 'pdf', 'application/pdf', '.pdf'], ['img', 'image', 'image/png', '.png'], ['vid', 'video', 'video/mp4', '.mp4'], ['aud', 'audio', 'audio/wav', '.wav']];
    const sources = [];
    for (let i = 1; i <= 10_000; i += 1) {
      const [prefix, kind, mime, ext] = kinds[i % 17 === 0 ? 3 : i % 13 === 0 ? 4 : i % 7 === 0 ? 2 : i % 5 === 0 ? 1 : 0];
      const n = String(i).padStart(5, '0');
      let name = `${n} · ${pick(rand, words)} ${Math.floor(rand() * 900 + 100)} (SYNTHETIC)${ext}`;
      if (i % 37 === 0) name = `${n} · ${pick(rand, words)} — an exceptionally long synthetic evidence file name used to exercise ellipsis handling across the library, tabs and viewer headers without overflowing (SYNTHETIC)${ext}`;
      if (i % 53 === 0) name = `${n} · ${pick(rand, rtlNames)} — اسم ملف اصطناعي طويل (SYNTHETIC)${ext}`;
      sources.push({ id: `${prefix}-lg-${n}`, name, sha256: hex(rand, 64), size: Math.floor(rand() * 40_000_000), mime, kind, status: kind === 'text' ? 'text indexed' : 'prepared', restricted: i % 211 === 0, occurrences: 1, created_at: new Date(nowMs - i * 61_000).toISOString(), revisions: kind === 'text' ? null : undefined });
    }
    const records = [];
    for (let i = 1; i <= 5_000; i += 1) {
      const n = String(i).padStart(5, '0');
      records.push({ id: `rec-lg-${n}`, title: i % 41 === 0 ? `${n} · Working note with a deliberately long synthetic title that must ellipsize cleanly in every list (SYNTHETIC)` : i % 59 === 0 ? `${n} · ملاحظة عمل اصطناعية (SYNTHETIC)` : `${n} · ${pick(rand, ['Note', 'Report', 'Timeline', 'Issue'])} ${Math.floor(rand() * 900 + 100)} (SYNTHETIC)`, kind: pick(rand, ['note', 'report', 'issue', 'event']), content: `# Synthetic record ${n}\n\nSYNTHETIC content only.`, revision: 1 + (i % 4), actor: i % 3 ? 'human' : 'agent', review: i % 4 === 0 ? 'human-reviewed' : 'unreviewed', protected: i % 97 === 0, stale: i % 29 === 0, updated_at: new Date(nowMs - i * 47_000).toISOString(), dependencies: [] });
    }
    return { sources, records };
  }

  function buildCase(dataset, name) {
    const empty = dataset === 'empty';
    const large = dataset === 'large' ? largeData() : null;
    const sources = empty ? [] : large ? large.sources : richSources();
    const records = empty ? [] : large ? large.records : richRecords();
    return {
      id: CASE_ID, name: name || (dataset === 'large' ? 'Harbor Street · synthetic scale matter' : CASE_NAME), root: CASE_ROOT, generation: 3, session_epoch: 7, event_seq: 40, audit_seq: 120,
      dataset, sources, records,
      tasks: empty || large ? [] : richTasks(),
      jobs: empty ? [] : large ? [] : richJobs(),
      findings: empty ? [] : richFindings(),
      settings: { offline: false, allow_text: true, allow_images: true, model: 'gpt-4.1' },
      ai_config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', allow_text: true, allow_images: false }, { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', allow_text: true, allow_images: false }] },
      automatic_analysis: empty ? { files: 0, prepared: 0, pending: 0, failed: 0, review_task: null, review_state: 'idle', note: 'No files yet.' } : { files: sources.length, prepared: Math.max(0, sources.length - 3), pending: 2, failed: 1, review_task: large ? null : 'task-auto-review', review_state: large ? 'idle' : 'paused', note: 'Automatic preparation of every file (SYNTHETIC). Review is paused; saved progress remains available.' },
      issues: empty || large ? [] : [{ task_id: 'task-cctv-1', name: 'inspect_video_frames', error: 'Provider request failed: HTTP 529 overloaded (SYNTHETIC).', count: 2, latest_receipt: 'rcpt-task-cctv-1-2', created_at: iso(250) }],
      directMedia: false, caseScope: 'app',
    };
  }

  let state = null;
  function reset(dataset, open) {
    state = {
      dataset,
      open: open ? buildCase(dataset) : null,
      keys: { openai: true, anthropic: true, openrouter: true, gemini: false, xai: false },
      app: { configured: true },
      appRoute: 'api_keys',
      streamMode: options.streamMode,
      liveActions: {},
      timers: [],
      taskCounter: 0,
      recordCounter: 0,
    };
  }
  reset(options.dataset, options.openAtStart);

  /* ------------------------------------------------------------- helpers */
  const PAGE = 100;
  function requireCase(args) {
    const current = state.open;
    if (!current) throw new HarnessError('No case is open.');
    if (args && args.case_id !== undefined && args.case_id !== current.id) throw new HarnessError('The case changed. Reload before continuing.');
    if (args && typeof args.session_epoch === 'number' && args.session_epoch !== current.session_epoch) throw new HarnessError('The case session changed. Reload before continuing.');
    return current;
  }
  const sourceSummary = source => { const { revisions, pages, ...summary } = source; return summary; };
  const recordSummary = record => { const { content, ...summary } = record; return summary; };
  function counts(c) {
    const current = c.jobs.filter(job => !job.superseded);
    return {
      audit_seq: c.audit_seq, source_count: c.sources.length, source_bytes: c.sources.reduce((sum, s) => sum + s.size, 0), record_count: c.records.length,
      task_count: c.tasks.length, job_count: c.jobs.length,
      jobs_queued: current.filter(job => job.status === 'queued').length, jobs_running: current.filter(job => job.status === 'running').length,
      jobs_failed: current.filter(job => job.status === 'failed').length, jobs_attention: current.filter(job => ['failed', 'interrupted'].includes(job.status)).length,
      jobs_complete: current.filter(job => job.status === 'complete').length, chat_pause: null,
    };
  }
  function snapshot() {
    const c = state.open;
    if (!c) return null;
    const sources = c.sources.slice(0, PAGE);
    const records = c.records.slice(0, PAGE);
    return {
      id: c.id, name: c.name, root: c.root, generation: c.generation, session_epoch: c.session_epoch, event_seq: c.event_seq,
      sources: sources.map(sourceSummary), records: records.map(recordSummary),
      source_next_cursor: c.sources.length > PAGE ? { created_at: sources.at(-1).created_at, id: sources.at(-1).id } : null,
      record_next_cursor: c.records.length > PAGE ? { updated_at: records.at(-1).updated_at, id: records.at(-1).id } : null,
      settings: c.settings, ai_config: c.ai_config, tasks: c.tasks.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50),
      jobs: c.jobs, job_next_cursor: null, attention_jobs: [], attention_next_cursor: null,
      issues: c.issues, counts: counts(c), automatic_analysis: c.automatic_analysis, viewer_request: null,
    };
  }
  function changed({ audit = true } = {}) {
    const c = state.open;
    if (!c) return;
    if (audit) c.audit_seq += 1;
    c.event_seq += 1;
    emit('case-event', { case_id: c.id, session_epoch: c.session_epoch, event_seq: c.event_seq });
  }
  function source(id) { const found = requireCase().sources.find(item => item.id === id); if (!found) throw new HarnessError(`Unknown source ${id}`); return found; }
  function currentRevision(item) { return item.revisions ? Math.max(...Object.keys(item.revisions).map(Number)) : 1; }
  function linesOf(item, revision) {
    if (item.revisions && item.revisions[revision]) return item.revisions[revision];
    if (item.revisions === null) return document(Number(item.id.replace(/\D/g, '')) || 1, 80, [...banner, `${item.name}`], {});
    throw new HarnessError('This source has no extracted text.');
  }
  function textPage(item, revision, start, count, historical) {
    const lines = linesOf(item, revision);
    const first = Math.max(1, Number(start) || 1);
    const end = Math.min(lines.length, first - 1 + (Number(count) || 200));
    return { text: lines.slice(first - 1, end).join('\n'), start: first, end, total_lines: lines.length, revision, historical, locator: `evidence:${item.id}#R${revision}L${first}-L${end}`, truncated_long_lines: false };
  }
  function cursorPage(list, before, key) {
    const index = before ? list.findIndex(item => item.id === before.id) : -1;
    const page = list.slice(index + 1, index + 1 + PAGE);
    const last = page.at(-1);
    return { page, next: last && index + 1 + PAGE < list.length ? { [key]: last[key], id: last.id } : null };
  }
  function taskById(id) { const found = requireCase().tasks.find(item => item.id === id); if (!found) throw new HarnessError(`Unknown task ${id}`); return found; }

  /* --------------------------------------------------------- live tasks */
  function streamChunks(text, pieces) {
    const size = Math.ceil(text.length / pieces);
    return Array.from({ length: pieces }, (_, i) => text.slice(i * size, (i + 1) * size)).filter(Boolean);
  }
  function emitProgress(taskId, delta) {
    const c = state.open;
    if (!c) return 0;
    const payload = { case_id: c.id, session_epoch: c.session_epoch, task_id: taskId, transmission_id: `tx-${taskId}`, delta: Object.assign({ characters: (delta && delta.text ? delta.text.length : 0) }, delta) };
    return emit('agent-progress', payload);
  }
  function addLiveAction(taskId, name, status, output) {
    const list = state.liveActions[taskId] || (state.liveActions[taskId] = []);
    list.push({ id: `rcpt-${taskId}-${list.length + 1}`, name, input: '{}', output, status, created_at: new Date().toISOString() });
  }
  function completeTask(taskId, answer) {
    const item = taskById(taskId);
    if (item.status !== 'running') return false;
    Object.assign(item, { status: 'complete', answer: answer || streamAnswer, error: '', step: item.step + 2, output_tokens: 846, input_tokens: 14_310, progress: { summary: 'Placed the reported sighting against the dispatch log.', citations: ['evidence:txt-witness-alvarez#R1L12-L18'], gaps: ['Camera clock not reconciled'], next_steps: ['Reconcile the CCTV clock against call 5521', 'Inspect frames near displayed 14:32'], checkpoint_step: item.step + 2, duplicate_reads: 0 } });
    addLiveAction(taskId, 'finish_task', 'complete', 'Answer submitted with 2 citations; 2 validated.');
    changed();
    return true;
  }
  function failTask(taskId, error) {
    const item = taskById(taskId);
    Object.assign(item, { status: 'failed', error: error || 'The provider connection closed unexpectedly (SYNTHETIC). Saved progress is available.' });
    addLiveAction(taskId, 'provider_request', 'failed', item.error);
    changed();
  }
  function scheduleStream(taskId) {
    const chunks = streamChunks(streamAnswer, 14);
    const step = Math.max(40, Math.floor(options.streamMs / (chunks.length + 3)));
    const activities = ['search_passages', 'read_text', 'read_text', 'composing_answer'];
    let t = 450;
    activities.forEach((activity, index) => {
      state.timers.push(setTimeout(() => { const item = state.open?.tasks.find(x => x.id === taskId); if (item?.status !== 'running') return; addLiveAction(taskId, activity === 'composing_answer' ? 'write_answer' : activity, 'complete', `${activity.replaceAll('_', ' ')} (SYNTHETIC)`); item.step += 1; emitProgress(taskId, { activity, characters: 0 }); }, t + index * step));
    });
    t += activities.length * step;
    chunks.forEach((chunk, index) => state.timers.push(setTimeout(() => { if (state.open?.tasks.find(x => x.id === taskId)?.status === 'running') emitProgress(taskId, { text: chunk, activity: 'composing_answer' }); }, t + index * step)));
    state.timers.push(setTimeout(() => { if (state.open?.tasks.find(x => x.id === taskId)?.status === 'running') completeTask(taskId); }, t + chunks.length * step + 150));
  }

  /* ----------------------------------------------------------- handlers */
  function handle(action, args) {
    switch (action) {
      case 'snapshot': return snapshot();
      case 'open_case': case 'restore_case': {
        if (!args.path) throw new HarnessError('Choose a case folder.');
        const dataset = /empty/i.test(args.path) ? 'empty' : /scale|large/i.test(args.path) ? 'large' : state.dataset === 'empty' ? 'rich' : state.dataset;
        state.open = buildCase(dataset);
        if (state.open) state.open.session_epoch = 7 + Math.floor(calls.filter(x => x.action === 'open_case' || x.action === 'create_case' || x.action === 'restore_case').length);
        return snapshot();
      }
      case 'create_case': { state.open = buildCase('empty', String(args.name || 'New synthetic case')); state.open.id = `case-new-${calls.length}`; return snapshot(); }
      case 'close_case': state.open = null; return null;
      case 'delete_case': { const c = requireCase(args); const bytes = counts(c).source_bytes; state.open = null; return { deleted: true, bytes }; }
      case 'case_summary': {
        const c = requireCase(args);
        const n = counts(c);
        return { case_id: c.id, generation: c.generation, audit_seq: c.audit_seq, action_rowid: 0, transmission_rowid: 0, viewer_request_hash: null, task_update: c.tasks.map(t => `${t.id}:${t.status}:${t.step}`).join(','), tasks_running: c.tasks.filter(t => t.status === 'running').length, tasks_paused: c.tasks.filter(t => t.status === 'paused').length, tasks_complete: c.tasks.filter(t => t.status === 'complete').length, ...n };
      }
      case 'storage_usage': { const c = requireCase(); const bytes = counts(c).source_bytes; return { originals: bytes, derivatives: Math.floor(bytes * 0.42), 'job folders': 12_582_912, staging: 3_145_728 }; }
      case 'reclaim_staging': requireCase(args); return { reclaimed_bytes: 3_145_728 };

      /* AI configuration — never echoes credentials */
      case 'ai_config': return state.open ? state.open.ai_config : { provider: 'openai', execution: 'auto', review: 'standard', pool: [] };
      case 'app_ai_settings': return { configured: state.app.configured, config: state.open ? state.open.ai_config : { provider: 'openai', execution: 'auto', review: 'standard', pool: [] }, settings: state.open ? state.open.settings : { offline: false, allow_text: true, allow_images: false, model: 'gpt-4.1' } };
      case 'save_app_ai_settings': case 'save_ai_settings': { if (state.open) { state.open.ai_config = args.config; state.open.settings = args.settings; if (action === 'save_ai_settings') state.open.caseScope = 'case'; changed(); } return { current_case_updated: true }; }
      case 'provider_key_status': case 'key_status': return { configured: !!state.keys[args.provider] };
      case 'save_provider_key': if (!args.key || String(args.key).length < 8) throw new HarnessError('That key is too short.'); state.keys[args.provider] = true; return null;
      case 'delete_provider_key': state.keys[args.provider] = false; return null;
      case 'provider_models': if (!state.keys[args.provider]) throw new HarnessError('Add an API key first.'); return PROVIDER_MODELS[args.provider] || [];
      case 'case_ai_scope': requireCase(args); return { scope: state.open.caseScope };
      case 'set_case_ai_scope': requireCase(args); state.open.caseScope = args.scope; changed(); return null;
      case 'direct_media_permission': requireCase(args); return { enabled: state.open.directMedia };
      case 'set_direct_media_permission': requireCase(args); state.open.directMedia = !!args.enabled; changed(); return null;
      case 'ai_access_route': return { route: state.appRoute, subscription: null, subscription_ready: false, account_ready: false, blocker: 'the synthetic harness has no subscription runtime' };
      case 'set_ai_access_route': state.appRoute = args.route; return { route: args.route };
      case 'case_ai_access_route': requireCase(args); return { override: 'app', effective: state.appRoute, selection_override: false, selection: null };
      case 'set_case_ai_access_route': requireCase(args); return { override: args.route, effective: args.route === 'app' ? state.appRoute : args.route, selection_override: false, selection: null };
      case 'codex_account_status': return { connected: false, email: null, plan: null, login: null };
      case 'team_status': return args.task_id === 'task-compare-1' ? [
        { id: 'member-reader', role: 'Reader', phase: 'evidence_reading', provider: 'anthropic', model: 'claude-sonnet-4-5', status: 'complete', step: 6, answer: 'Both statements place people at the north entrance — evidence:txt-witness-alvarez#R1L12-L13', error: '' },
        { id: 'member-challenger', role: 'Challenger', phase: 'challenge', provider: 'openai', model: 'gpt-4.1', status: 'complete', step: 4, answer: 'The Osei count relies on a re-extracted line — evidence:txt-witness-osei#L3-L3', error: '' },
        { id: 'member-clock', role: 'Clock checker', phase: 'clock_review', provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', status: 'failed', step: 2, answer: '', error: 'Assignment stopped: provider rate limit (SYNTHETIC).' },
      ] : [];

      /* chats */
      case 'conversation_detail': {
        const c = requireCase(args);
        const turns = c.tasks.filter(t => (t.conversation_id || t.id) === args.conversation_id).sort((a, b) => b.created_at.localeCompare(a.created_at));
        const index = args.before ? turns.findIndex(t => t.id === args.before.id) : -1;
        const page = turns.slice(index + 1, index + 21);
        return { tasks: page, next_cursor: index + 21 < turns.length ? { created_at: page.at(-1).created_at, id: page.at(-1).id } : null };
      }
      case 'task_page': { requireCase(args); return { tasks: [], next_cursor: null }; }
      case 'actions': return actionsFor(args.task_id);
      case 'start_task': {
        const c = requireCase(args);
        if (!String(args.prompt || '').trim()) throw new HarnessError('Enter a task.');
        if (c.settings.offline) throw new HarnessError('AI is offline for this case.');
        state.taskCounter += 1;
        const parent = args.parent_task_id ? c.tasks.find(t => t.id === args.parent_task_id) : null;
        const id = `task-live-${state.taskCounter}`;
        const conversation = parent ? parent.conversation_id || parent.id : `conv-live-${state.taskCounter}`;
        c.tasks.push(task(id, conversation, String(args.prompt), 0, { created_at: new Date().toISOString(), status: 'running', step: 1, input_tokens: 0, output_tokens: 0, title: parent ? null : String(args.prompt).slice(0, 60) }));
        state.liveActions[id] = [];
        changed();
        if (state.streamMode === 'auto') scheduleStream(id);
        return { task_id: id, conversation_id: conversation };
      }
      case 'stop_task': {
        const item = taskById(args.task_id); requireCase(args);
        if (item.status === 'running') { Object.assign(item, { status: 'paused', error: 'Stopped by user' }); addLiveAction(item.id, 'stop_requested', 'complete', 'Stopped by user. A request already in flight may still complete; its transmission may have occurred.'); changed(); }
        return null;
      }
      case 'resume_task': { const item = taskById(args.task_id); requireCase(args); Object.assign(item, { status: 'running', error: '' }); changed(); if (state.streamMode === 'auto') scheduleStream(item.id); return null; }
      case 'continue_paused_task': {
        const c = requireCase(args); state.taskCounter += 1;
        const original = c.tasks.find(t => t.id === args.task_id);
        const id = `task-live-${state.taskCounter}`; const conversation = `conv-live-${state.taskCounter}`;
        c.tasks.push(task(id, conversation, original ? `Continue: ${original.prompt}` : 'Continue saved review', 0, { created_at: new Date().toISOString(), status: 'running', step: 1, title: 'Continued task' }));
        state.liveActions[id] = [];
        changed(); if (state.streamMode === 'auto') scheduleStream(id);
        return { task_id: id, conversation_id: conversation };
      }
      case 'delete_conversation': {
        const c = requireCase(args);
        if (args.deleted === false) { c.tasks.push(...(c.deletedTasks || [])); c.deletedTasks = []; }
        else { c.deletedTasks = c.tasks.filter(t => (t.conversation_id || t.id) === args.conversation_id); c.tasks = c.tasks.filter(t => (t.conversation_id || t.id) !== args.conversation_id); }
        changed(); return null;
      }
      case 'rename': {
        const c = requireCase(args);
        if (args.kind === 'case') c.name = String(args.name);
        else if (args.kind === 'source') { const s = source(args.id); s.name = String(args.name); }
        else if (args.kind === 'chat') c.tasks.filter(t => (t.conversation_id || t.id) === args.id).forEach(t => { t.title = String(args.name); });
        changed(); return null;
      }

      /* sources and records */
      case 'source_page': { const c = requireCase(args); const { page, next } = cursorPage(c.sources, args.before, 'created_at'); return { sources: page.map(sourceSummary), next_cursor: next }; }
      case 'record_page': { const c = requireCase(args); const { page, next } = cursorPage(c.records, args.before, 'updated_at'); return { records: page.map(recordSummary), next_cursor: next }; }
      case 'source_detail': return sourceSummary(source(args.source_id));
      case 'record_summary': { const r = requireCase(args).records.find(x => x.id === args.record_id); if (!r) throw new HarnessError('Unknown working file.'); return recordSummary(r); }
      case 'record_detail': { const r = requireCase(args).records.find(x => x.id === args.record_id); if (!r || r.revision !== args.revision) throw new HarnessError('Case or record revision changed'); return r; }
      case 'write_record': {
        const c = requireCase(args);
        const old = c.records.find(r => r.id === args.record_id);
        if (old && old.revision !== args.base_revision) throw new HarnessError('This record changed. Reload before saving.');
        state.recordCounter += 1;
        const record = { id: old ? old.id : `rec-new-${state.recordCounter}`, title: String(args.title), kind: String(args.kind), content: String(args.content), revision: Number(args.base_revision) + 1, actor: 'human', review: 'unreviewed', protected: old ? old.protected : false, stale: false, updated_at: new Date().toISOString(), dependencies: args.source_ids || [] };
        c.records = [record, ...c.records.filter(r => r.id !== record.id)];
        changed(); return record;
      }
      case 'review_record': { const c = requireCase(args); const r = c.records.find(x => x.id === args.record_id); if (r) { if (typeof args.protected === 'boolean') r.protected = args.protected; else r.review = 'human-reviewed'; r.updated_at = new Date().toISOString(); } changed(); return null; }
      case 'revisions': { const r = requireCase().records.find(x => x.id === args.record_id); return r ? Array.from({ length: r.revision }, (_, i) => ({ revision: r.revision - i, title: r.title, content: i ? `${r.content}\n\n(earlier revision ${r.revision - i}, SYNTHETIC)` : r.content, actor: i % 2 ? 'agent' : r.actor, review: i ? 'unreviewed' : r.review, reason: i ? 'Agent revision (SYNTHETIC)' : 'Latest save', task_id: null, created_at: iso(30 + i * 20) })) : []; }
      case 'rollback': { const c = requireCase(args); const r = c.records.find(x => x.id === args.record_id); if (!r) throw new HarnessError('Unknown working file.'); r.revision += 1; r.updated_at = new Date().toISOString(); changed(); return r; }
      case 'set_restricted': { requireCase(args); source(args.source_id).restricted = !!args.restricted; changed(); return null; }
      case 'read_text': { const s = source(args.source_id); return textPage(s, currentRevision(s), args.start, args.count, false); }
      case 'read_extract_revision': { const s = source(args.source_id); const revision = Number(args.revision); if (!s.revisions || !s.revisions[revision]) throw new HarnessError('Unknown extraction revision'); return textPage(s, revision, args.start, args.count, revision < currentRevision(s)); }
      case 'probe_pdf': { const s = source(args.source_id); return { metadata: { page_count: s.pages || 3, first_page_size_points: [612, 792] } }; }
      case 'render_page': { const s = source(args.source_id); return { published: [{ artifact_id: `page-${s.id}-${args.page}`, metadata: { page: Number(args.page), page_count: s.pages || 3, page_size_points: [612, 792] } }], limitations: ['Pages are rasterised derivatives of the original PDF for viewing (SYNTHETIC). The original file is preserved unchanged.'] }; }
      case 'process_source': { const s = source(args.source_id); return s.kind === 'image' ? { published: [{ artifact_id: `frame-${s.id}-derived` }], limitations: [] } : { published: [], limitations: ['Office documents are converted to text for reading; layout, comments and embedded objects are not shown (SYNTHETIC).'] }; }
      case 'artifact_info': return { mime: 'image/png', content: null, metadata: { source_origin_seconds: 0, player_origin_seconds: 0 } };
      case 'playback_proxy': return { artifact_id: `proxy-${args.source_id}` };
      case 'browse_video_discovery': return { samples: Array.from({ length: 8 }, (_, i) => ({ artifact_id: `frame-${args.source_id}-${i}`, locator: `evidence:${args.source_id}#artifact:frame-${args.source_id}-${i}`, metadata: { source_relative_seconds: i * 0.5, playback_seconds: i * 0.5, scene_boundary: i === 3, ...(args.kind === 'video_ocr' ? { ocr: { text: i % 2 ? 'CAM 3 14:32:0' + i : '' } } : {}) } })), next_offset: null, status: { jobs: [], note: 'Frames are sampled at intervals; sampling does not establish absence of events between samples (SYNTHETIC).' } };
      case 'full_transcription_status': {
        const s = source(args.source_id);
        if (s.kind === 'audio') return { job_id: 'job-transcribe-call-done', status: 'complete', error: '', progress: {}, result: { segments: 12, segmented: true, metadata: { container_origin_seconds: 0, tracks: [{ index: 1, origin_seconds: 0 }] } }, record: state.open.records.find(r => r.id === 'rec-transcript-call') || null };
        if (s.kind === 'video') return { job_id: 'job-transcribe-video', status: 'running', error: '', progress: { state: 'transcribing', track_number: 1, track_count: 1, processed_seconds: 42, estimated_seconds: 96, segments: 7 }, result: {}, record: null };
        return null;
      }
      case 'transcript_segment_page': return { segments: args.cursor ? [] : Array.from({ length: 12 }, (_, i) => ({ ordinal: i + 1, track: 1, start: i * 0.4, end: i * 0.4 + 0.4, text: ['Emergency, which service?', 'Police, please. There are two people by the north entrance.', 'Can you describe them?', 'One has a blue bag. The other is taller, grey hood.', 'Are they still there?', 'They are walking toward Harbor Street now.', 'What time did you first see them?', 'Just now, maybe a couple of minutes ago.', 'Stay on the line.', 'Okay.', 'Units are on the way.', 'Thank you.'][i] + ' (SYNTHETIC)', ...(i === 3 ? { correction: { id: 'corr-1', revision: 1, text: 'One has a blue holdall. The other is taller, grey hood.', review: 'pending' } } : {}) })), next_cursor: null };
      case 'processing_status': return [];
      case 'job_progress': return jobProgress[args.job_id] || { priority: 'normal', attempt: 1, progress: null };
      case 'job_page': case 'attention_job_page': return { jobs: [], next_cursor: null };
      case 'issue_history': return { receipts: [{ id: 'rcpt-task-cctv-1-2', created_at: iso(250) }, { id: 'rcpt-task-cctv-1-1', created_at: iso(255) }], next_offset: null };
      case 'resume_processing': case 'retry_video_discovery': case 'resume_transcription': {
        const c = requireCase(args); const job = c.jobs.find(j => j.id === (args.job_id || args.run_id)); if (job) { job.status = 'queued'; job.error = ''; } changed(); return null;
      }
      case 'cancel_processing': case 'cancel_transcription': { const c = requireCase(args); const job = c.jobs.find(j => j.id === args.job_id || (j.source_id === args.source_id && j.kind === 'full_audio')); if (job) job.status = 'cancelled'; changed(); return null; }
      case 'transcribe_full': case 'transcribe_all': case 'set_asr_profile': requireCase(args); changed(); return null;
      case 'hybrid_search': case 'search': {
        const c = requireCase(args); const query = String(args.query || '').toLowerCase().trim();
        const results = [];
        for (const s of c.sources) {
          if (!s.revisions || s.restricted) continue;
          const revision = currentRevision(s); const lines = s.revisions[revision];
          lines.forEach((line, i) => { if (query && line.toLowerCase().includes(query) && results.length < 12) results.push({ source_id: s.id, name: s.name, excerpt: line, locator: `evidence:${s.id}#R${revision}L${i + 1}-L${Math.min(lines.length, i + 2)}` }); });
        }
        return action === 'search' ? { results, next_offset: null } : { results, remaining_passages: 0 };
      }
      case 'evidence_list': { const c = requireCase(args); const objects = c.findings.filter(o => !args.kind || o.kind === args.kind); return { objects: objects.slice(args.offset || 0, (args.offset || 0) + 50), next_offset: null }; }
      case 'evidence_read': { const o = requireCase(args).findings.find(x => x.id === args.id); if (!o) throw new HarnessError('Unknown finding.'); return o; }
      case 'evidence_write': { const c = requireCase(args); const object = Object.assign({ review: 'unreviewed', stale: false, actor: 'human' }, args.object); if (!object.id) object.id = `ev-new-${c.findings.length + 1}`; object.revision = (object.base_revision || 0) + 1; c.findings = [object, ...c.findings.filter(o => o.id !== object.id)]; changed(); return object; }
      case 'fit_clock': requireCase(args); return { status: 'offset_only', scale: 1, offset_seconds: 3.25, uncertainty_seconds: 0.5, drift_estimated: false, held_out_checks_passed: true, valid_source_range: [0, 600], residuals: [{ residual_seconds: 0.12, held_out: false, within_tolerance: true }, { residual_seconds: -0.2, held_out: true, within_tolerance: true }], limitations: ['Two anchors support an offset only; drift is not estimated (SYNTHETIC).'] };
      case 'investigation_workbench': { const c = requireCase(args); return c.dataset !== 'rich' ? { investigations: [], affected_objects: [], next_offset: null } : { investigations: [{ task_id: 'task-compare-1', question: 'Do the Alvarez and Osei accounts agree on the number of people? (SYNTHETIC)', status: 'complete', view: { stale: false, completion_stale: false, dossier: { revision: 2, claims: [
        { proposition: 'Two people were at the north entrance at about 14:32', assessment: 'partly_supported', supporting: ['evidence:txt-witness-alvarez#R1L13-L13'], contrary: ['evidence:txt-witness-osei#R1L3-L3'], uncertainty: 'Osei revision 1 is a superseded OCR reading.', next_check: 'Inspect CCTV frames near displayed 14:32.' },
        { proposition: 'One person carried a blue holdall', assessment: 'single_source', supporting: ['evidence:txt-witness-alvarez#R1L15-L15', 'evidence:txt-witness-chen#R1L4-L4'], contrary: [], uncertainty: 'Chen saw the holdall later, not the person carrying it.', next_check: 'Compare the holdall photograph with the CCTV.' },
      ] } }, previous: null, hypotheses: { alternatives: [{ explanation: 'The third person was waiting for a taxi and unrelated (SYNTHETIC).', unresolved_premise: 'Whether a taxi stopped at 14:32.', prediction: 'A taxi appears in the CCTV between 14:31 and 14:34.', discriminating_check: 'Inspect CCTV frames 14:31–14:34.', citations: ['evidence:txt-witness-osei#L3-L3'] }] } }], affected_objects: [{ id: 'ev-issue-count', title: 'Head count differs between statements (SYNTHETIC)', kind: 'issue', revision: 3 }], next_offset: null }; }
      case 'read_dossier': case 'review_dossier_claim': requireCase(args); return { dossier: { revision: 2, scope: 'Both witness statements and the dispatch log (SYNTHETIC).', checks: [{ id: 'chk-1', description: 'Read both statements in full', state: 'done', reason: '', receipts: ['rcpt-1', 'rcpt-2'] }, { id: 'chk-2', description: 'Inspect CCTV frames 14:31–14:34', state: 'blocked', reason: 'Video OCR index interrupted.', receipts: [] }], claims: [{ proposition: 'Two people were at the north entrance at about 14:32', assessment: 'partly_supported', supporting: ['evidence:txt-witness-alvarez#R1L13-L13'], contrary: ['evidence:txt-witness-osei#R1L3-L3'], uncertainty: 'Superseded OCR reading.', next_check: 'Inspect CCTV.' }] }, stale: false, completion_stale: false, completion: { outcome: 'partial', gaps: ['CCTV not inspected'], created_at: iso(90) }, human_reviews: [action === 'review_dossier_claim' ? { decision: args.decision, note: args.note || '', stale: false } : null], coverage_note: 'Coverage is declared by the agent and limited to the listed checks (SYNTHETIC).' };
      case 'coverage_map': { const c = requireCase(args); return { sources: c.sources.slice(0, 50).map((s, i) => ({ source_id: s.id, name: s.name, status: s.status, extracted_lines: s.revisions ? linesOf(s, currentRevision(s)).length : 0, rendered_pages: s.kind === 'pdf' ? [1, 2, 3, 4] : [], sampled_frame_count: s.kind === 'video' ? 492 : 0, sampled_seconds: s.kind === 'video' ? [0, 5, 10, 15] : [], inspection_receipts: i % 3, failed_jobs: c.jobs.filter(j => j.source_id === s.id && j.status === 'failed' && !j.superseded).length, next_check: s.kind === 'video' ? 'Resume the interrupted OCR index.' : 'Read unread line ranges.' })), next_offset: null, note: 'Coverage counts what was recorded; it does not establish that unrecorded parts contain nothing relevant (SYNTHETIC).' }; }
      case 'incident_replay': throw new HarnessError('Incident replay needs two reviewed clock mappings (synthetic harness).');
      case 'import_files': case 'import_folder': { requireCase(args); const paths = args.paths || [args.path]; changed(); return { items: paths.map(() => ({ status: 'imported', detail: {} })), skipped: [] }; }
      case 'backup': case 'export_record': case 'export_word': case 'export_redaction': case 'export_dossier_bundle': requireCase(args); return null;
      case 'fetch_public_authority': throw new HarnessError('Network retrieval is disabled in the synthetic harness.');
      default:
        unhandled.push(action);
        throw new HarnessError(`Synthetic harness does not implement "${action}".`);
    }
  }

  /* ------------------------------------------------------ test controls */
  window.__vislexFake = {
    options,
    get state() { return state; },
    calls,
    unhandled,
    callsFor(action) { return calls.filter(entry => entry.action === action || entry.cmd === action); },
    clearCalls() { calls.length = 0; },
    listenerCount(event) { return listeners.get(event)?.size ?? 0; },
    emit(event, payload) { return emit(event, payload); },
    emitProgress,
    completeTask(taskId, answer) { return completeTask(taskId, answer); },
    failTask(taskId, error) { return failTask(taskId, error); },
    emitCaseEvent() { changed({ audit: false }); },
    setDelay(action, ms) { if (ms == null) delete delays[action]; else delays[action] = ms; },
    setError(action, message, once = false) { if (message == null) delete failures[action]; else failures[action] = { message, once }; },
    setStreamMode(mode) { state.streamMode = mode; },
    setDialogResult(kind, value) { (dialogQueue[kind] || (dialogQueue[kind] = [])).push(value); },
    runningTasks() { return (state.open?.tasks || []).filter(t => t.status === 'running').map(t => t.id); },
    loadDataset(dataset, open = true) { state.timers.forEach(clearTimeout); const previous = state.open; reset(dataset, open); if (previous && state.open) state.open.session_epoch = previous.session_epoch + 1; emit('case-event', { case_id: state.open ? state.open.id : null, session_epoch: state.open ? state.open.session_epoch : 0, event_seq: state.open ? state.open.event_seq + 1 : 1 }); },
  };
})();
