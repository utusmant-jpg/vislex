# Media analysis and storage improvement plan

Proposed scope, September 20, 2026. This document is a plan; these capabilities are not yet implemented.

## Outcome

Turn recordings into a searchable, reviewable timeline of speech, sounds, and visible activity. Every finding should open the relevant original interval, explain how it was detected, and retain its review history. Prioritize detecting and timing knocks and other short sounds before adding broad scene narratives.

## Existing foundation

Code reviewed: workers/worker.py, workers/full_audio.py, workers/model-manifest.json, src-tauri/src/case.rs, src-tauri/src/transcription.rs, src-tauri/src/processing.rs, src/components/EvidenceViewer.tsx, and src/types.ts.

- Originals are copied, hashed, and retained separately from derived artifacts. SQLite stores sources, artifacts, jobs, records, revisions, and audit receipts; encrypted backups already exist.
- Full transcription decodes every audio track to EOF, using a pinned tiny multilingual Whisper model, 60-second chunks, two-second lookahead, and word timestamps. It derives mono 16 kHz input and reports decoding gaps.
- Video sampling retains decoded PTS and timebase but is limited to selected intervals and sampled frames. It does not establish what occurred between samples.
- No dedicated environmental-sound detector, waveform, spectrogram, or structured multimedia event index exists in the reviewed paths.
- Full transcription has background jobs and partial journals, but automatic resumption is outstanding. Other processors need the same asynchronous foundation. Existing first-extraction indexing does not provide complete search over later analyses.

## 1. Accurate media clocks and resumable analysis

Build this first because every later feature depends on trustworthy timestamps.

- Inventory tracks, channels, sample rates, start offsets, timebases, durations, and decoder gaps once per source.
- Preserve native PTS/timebase and sample indices as authoritative locators. Map each track into a common source playback clock without discarding its offset. Keep wall-clock hypotheses separate, with provenance and uncertainty.
- Validate original-to-playback-proxy mappings, including variable frame rates and nonzero stream starts. A player seek is approximate; precise frame inspection must decode to the requested PTS.
- Generalize the full-transcription job flow into persisted stage/chunk jobs with cancellation, checkpoint/resume, retry limits, progress, disk-space checks, and CPU/GPU/memory limits.
- Key reusable results by source hash, track, interval, processor/model hash, settings, and schema version. Allow deliberate reanalysis with a different model; do not let a previous completed job block it.
- Publish artifacts through staging plus transactional registration and startup reconciliation. An interrupted job must never look complete.
- Record coverage separately for decoding, speech, sound detection, and visual inspection. Unprocessed areas remain visible.

Acceptance: restart during a long recording, resume verified completed chunks without duplicate events, and correctly synchronize offset audio tracks and variable-frame-rate video.

## 2. Sound events, including knocks

Use two complementary passes: broad sound classification identifies candidate types; short-time transient analysis refines onset timing and separates repeated impacts.

- Initial classes: knock/tap, generic impact, door-like slam, footsteps, bell, alarm, glass-like sound, dog bark, speech, and unknown sound. Final supported labels depend on held-out evaluation.
- Analyze overlapping windows across the entire selected audio coverage, including non-speech sections. Speech VAD must not suppress environmental-sound analysis.
- Preserve original channels and native-rate timing; create model-specific resampled derivatives independently. Inspect channels separately where useful rather than relying only on the existing mono speech input.
- Use amplitude change and spectral flux to propose individual impact onsets, then classify with surrounding context. Group likely repeated knocks into a burst while retaining each candidate impact and count uncertainty.
- Store competing labels and raw scores. Show a calibrated confidence only when calibration has been validated; a model score is not a probability that the conclusion is true.
- Mark clipping, low signal-to-noise, overlap, and disagreement. Let the detector abstain with “unknown impact.”
- Each event card supports replay with context, loop, slow playback, waveform zoom, accept/reject/relabel, and boundary correction.
- Denoising and source separation can be optional comparison aids later. Preserve and provide immediate access to the original audio because processing can introduce or remove transients.

Illustrative output, not a measured result: “00:12.43–00:13.08: three candidate impacts, possibly knocks; unreviewed.” Do not infer which person caused them or what surface was struck from sound alone.

Candidate baseline: YAMNet provides 521 audio-event classes and embeddings. Benchmark it before selection; coarse classification windows alone will not provide precise knock boundaries. See [TensorFlow tutorial](https://www.tensorflow.org/tutorials/audio/transfer_learning_audio) and [model repository](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet).

Acceptance: evaluate held-out recordings of real knocks plus confusing taps, footsteps, handling noise, keyboard sounds, speech, and slams. Report event precision/recall, false alarms per hour, onset error, and burst-count error separately.

## 3. Better speech and speaker timelines

- Add Fast and Detailed profiles with pinned local model packages; benchmark a larger speech model against the existing tiny baseline on the actual languages and recording conditions.
- Add forced alignment for improved word boundaries, with an explicit unaligned state. Alignment does not prove the recognized words are correct.
- Add speaker-turn diarization using anonymous labels such as Speaker A/B, overlapping-speech markers, and user corrections. Link names only through separately reviewed annotations.
- Highlight uncertain names/numbers and offer targeted retranscription of selected intervals. Keep each model run and human revision separately.
- Preserve chunk overlap, source offsets, decoder gaps, and word-boundary deduplication across all profiles.

Candidate: [WhisperX](https://github.com/m-bain/whisperX) combines transcription, alignment, and diarization. Evaluate Windows packaging, model licenses, download requirements, supported languages, runtime, and memory before adoption.

Acceptance: compare word error rate, word-boundary error, speaker-turn error, and performance on noisy/overlapping speech against the current implementation.

## 4. More visual evidence

- Generate a seekable thumbnail strip and scene-change index; offer contact sheets for long recordings.
- Combine regular temporal sampling with denser inspection around sound events, motion changes, and scene boundaries. Sparse frames can miss brief actions; show sampling coverage explicitly.
- Start with observable features: motion regions, candidate person/object tracks, and on-screen text with bounding boxes. Persistent track IDs mean within-recording tracks, not verified identities.
- Review short before/during/after sequences for proposed actions such as a door opening. A scene change or a single image is insufficient to establish an action.
- Store visible observations separately from audio observations. Link temporal coincidences without automatically asserting causation: a knock-like sound near visible hand motion remains a hypothesis.
- Reinspect original frames around candidate events before writing detailed summaries. Retain supporting frame locators and alternative interpretations.

Candidate for shot boundaries: [PySceneDetect](https://www.scenedetect.com/cli/). Shot detection is useful navigation infrastructure, not action recognition.

Acceptance: measure missed short actions, false visual events, and timestamp error using labeled video; include low light, camera movement, occlusion, and continuous shots.

## 5. A synchronized analysis workspace

One playhead drives the video, transcript, selected event, and these zoomable lanes:

| Lane | User value |
|---|---|
| Per-channel waveform | Locate impacts and compare sound intensity |
| On-demand spectrogram | Inspect a sound's frequency structure |
| Words and speaker turns | Read, seek, correct, and compare speech |
| Sound events | Find and replay candidate knocks, alarms, and other sounds |
| Filmstrip and visual events | See relevant frames and visible changes |
| Coverage and quality | See unprocessed intervals, gaps, clipping, and uncertain regions |
| Review annotations | Distinguish machine suggestions from accepted/corrected findings |

Use tiled waveform peaks and spectrograms with multiple zoom levels, virtualized lists, keyboard navigation, text alternatives, and event markers that do not rely on color alone. Load only the visible interval.

Search examples: “all candidate knocks,” “sounds before Speaker B starts,” and “door activity within five seconds of an impact.” Search results open source intervals and expose review state. Add semantic search only after structured event/time search is dependable.

## 6. Storage that supports investigation and reanalysis

Keep SQLite for structured metadata and store large binary artifacts on disk. No server or replacement database is necessary for the first release.

Proposed additive tables:

| Table | Purpose |
|---|---|
| media_tracks | Native clocks, offsets, channels, and stream metadata |
| analysis_runs | Processor/model hashes, settings, versions, state, and parent run |
| analysis_chunks | Checkpoints, leases, retries, interval, and artifact references |
| coverage_intervals | Per-stage processed ranges, missing ranges, and reasons |
| media_events | Type, track, native and normalized bounds, scores, and run |
| event_evidence | Links to audio ranges, frames, transcript versions, and artifacts |
| event_revisions | Human corrections, review state, author, and previous version |
| event_relations | Coincidence, sequence, candidate duplication, and reviewed links |
| search_documents | Version-aware searchable words, events, OCR, and annotations |

- Index events by source, track, type, and time; page results by visible interval. Preserve all runs while selecting an explicit current run per analysis type.
- Extend artifact metadata with content hashes and derivation recipes. Deduplicate within a case; preserve distinct source occurrences and permissions.
- Separate originals, retained analysis artifacts, and disposable rendering caches. Cache eviction must never remove originals, annotations, or cited historical outputs.
- Avoid permanent decoded full-length WAVs and storing every frame. Stream analysis, retain useful thumbnails/keyframes, and regenerate display tiles as needed.
- Show storage used by originals, retained results, models, and caches; estimate additional processing space before starting. Allow cache quotas and deterministic rebuilding.
- Keep review edits versioned. Reanalysis creates new machine findings and marks dependent summaries stale; it must not silently replace human corrections.
- Extend backup/restore to cover new schemas and referenced artifacts. Caches may be excluded with explicit rebuild recipes; never silently exclude evidence needed to support a saved finding.
- Include source restrictions in every search, event retrieval, preview, and agent transmission path.

Acceptance: reopen/migrate an existing case, reanalyze one source, retain both runs and corrections, search the selected run, purge only disposable caches, and restore a backup with all cited evidence intact.

## 7. Agent capabilities

Expose bounded, source-scoped tools for requesting analysis, querying events, retrieving coverage, inspecting event evidence, and requesting targeted reanalysis. Reuse the app's offline and transmission controls.

Answers should cite stored event IDs plus original media locators. Summaries must distinguish observed signals, candidate interpretations, and reviewed conclusions. “No knock detected” must include coverage and detector limitations; it does not mean no knock occurred.

Human corrections improve case retrieval immediately. They do not automatically retrain a model. Any later fine-tuning needs an explicit dataset workflow and a held-out evaluation.

## Delivery order and release gates

| Phase | Deliverable | Exit gate |
|---|---|---|
| 1 | Clock contract, generalized resumable jobs, event schema, waveform | Correct seeking/offsets; crash recovery; original hashes unchanged |
| 2 | Knock/impact detector, burst markers, event cards, review and search | Held-out timing/accuracy evaluation; full scan coverage shown |
| 3 | Detailed transcription, alignment, speaker lanes | Measured improvement over tiny baseline; usable hardware profile |
| 4 | Filmstrip, scenes, OCR/motion candidates, sound-triggered visual inspection | Labeled visual evaluation and correct source-linked replay |
| 5 | Cross-recording search, optional clock alignment, storage dashboard, richer reports | Verified backup/restore, scale benchmarks, reviewed event export |

First useful release: Phases 1–2. It should find candidate knocks, show where they occur, let the user replay/correct them, and reliably save that work.

Before committing numerical accuracy promises, create a labeled evaluation set split by recording/session so similar clips cannot leak between tuning and testing. Include faint and distant knocks, reverberation, silence, simultaneous speech, codec artifacts, different channels, nonzero offsets, corrupt packets, and variable frame rates. Use multiple annotators for ambiguous events and timing ranges where exact truth is uncertain.

Report precision/recall by event class, false positives per hour, median and 95th-percentile timing error, review workload, wall-clock runtime per media hour, peak memory, storage growth, and recovery behavior. Compare detector thresholds on validation data; freeze thresholds before final test evaluation. Benchmark on the user's Windows hardware before estimating delivery throughput or selecting default models.

Do not start with automatic identity attribution, emotion/intent inference, or a promise that a general model understands every second. The highest-value foundation is accurate event retrieval with direct playback and retained provenance.
