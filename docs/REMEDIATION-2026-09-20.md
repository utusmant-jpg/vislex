# VisLex trust fixes and investigation-loop repair

Date: 2026-09-20
Build: VisLex 0.2.1 development build with trust/agent fixes

## Exact failed receipt

`1d8a42ab-02f5-4b7a-9e1e-b9ddce4c38df`

The request asked for a timestamped narrative across the shoplifting videos, quoted statements, transcript-quality concerns, and visual keyframe observations.

The saved database shows:

- 43 provider requests and 43 successful tool calls.
- 21 `read_record`, 9 `read_text`, 8 `recording_status`, 5 `search_passages` calls.
- 906,983 provider-reported input tokens, including 446,594 cached input tokens; 3,124 output tokens. These are usage counters, not a dollar bill or proof of account quota exhaustion.
- Zero visual inspection calls and zero final answer attempts.
- The third identical read of transcript record `338e3fc7-235b-49b3-b636-d4cdb07abcaf`, lines 1–200, triggered the lifetime repeated-call guard. The successful result was saved, but the run paused with an empty answer.

## Root causes and quality consequences

1. The guard counted identical calls over the entire task, including successful rereads. It treated a third successful transcript retrieval as a terminal failure. Removing the guard alone would permit more expensive looping.
2. API context was truncated after 100 KB without a durable coverage ledger or factual progress checkpoint. Older receipts remained on disk but their useful findings and already-read ranges were no longer reliably present in the model context. This creates a reread/rearchive cycle.
3. Source additions and unrelated record edits marked immutable machine transcripts stale. The agent instructions explicitly told it to reread stale material, reinforcing that cycle.
4. A media source's indexed text may be an earlier short transcription interval. Publishing a full transcript deliberately did not overwrite existing immutable line citations, but the read tool did not clearly direct the agent to the separate full transcript.
5. The agent could continue reading text indefinitely while neglecting the requested visual modality. For this receipt, there is no support for saying it inspected keyframes.
6. The trace changed passage-search terms while continuing offsets from a different query. That can skip relevant matches and produce misleading zero-result pages.
7. Transcript search results exposed working-record IDs without an immutable source locator. A subsequent user-initiated live run demonstrated repeated rejected checkpoint citations using those record IDs as evidence source IDs. Search and transcript reads now return the completed transcription job’s immutable reference; validation errors explain the distinction and provide the correct reference.
8. After visual inspection, old images could be resent on later synthesis calls even though a fresh textual visual description had already been saved. This is another avoidable input cost.

These defects affect coverage, recall, attribution, and efficiency. The failed run produced no final answer, so this investigation does not establish that a specific final claim from that run was false.

## Implemented agent changes

- Durable, source-cited, unreviewed factual checkpoints with gaps and concrete next steps, preserved across pauses and restarts. Checkpoints are visible in the chat.
- A current per-source ledger of full-transcript references, distinct retrieval ranges, receipt IDs, and sampled visual observations. It explicitly distinguishes retrieval from verification.
- Progress checkpoints before context compaction and on repeated retrieval. Context can then be reduced around a saved checkpoint without erasing what was learned or what remains unanswered.
- Identical successful retrieval no longer throws the lifetime three-call error. Repeated results prompt checkpointing and, if they still add no evidence, supported synthesis with explicit gaps.
- Invalid final-answer citations are still rejected. Repeated validation failures preserve partial findings and receipts instead of publishing unsupported findings.
- Requests explicitly asking about visual evidence are steered to frame inspection after a text-only retrieval stretch. Uninspected videos are automatically named as gaps in final output.
- Fresh visual observations must correspond to images actually supplied to that visual-review request.
- Already-described images are not resent on routine text-synthesis requests. They can be explicitly reopened when a disputed detail needs reinspection.
- Immutable processor transcripts are not falsely marked stale by unrelated changes. Human/agent-edited records keep ordinary staleness behavior.
- Media `read_text` explains its potential interval-only coverage and points to the full transcript record. Every transcript page includes source filenames, hashes, provenance links, and a machine-text warning.
- Transcript search and record pages return explicit immutable source citations and filenames. Mistaken working-record citations receive an actionable correction. ASR review instructions point to recorded segment/word diagnostics without treating them as calibrated correctness probabilities.
- Search pagination restarts when the query/evidence version/continuation changes, avoiding skipped matches.
- Instructions require attributed machine-transcript quotations, timestamp and filename context, preservation of garbled wording, and no invented ASR confidence or speaker identity.
- Streamed response progress, visible elapsed time and reported tokens, cancellation, failed-action receipts, and a saved partial-results panel.

## Exact-receipt offline replay

`src-tauri/examples/replay-review.rs` copies the database into a disposable local case. It never calls the provider or modifies the source database.

The replay retained 10 sources and 24 distinct read ranges. Its first recovery tool was `checkpoint_review`; after a deterministic diagnostic placeholder checkpoint, its next tool was `inspect_video_interval`. Zero provider requests were sent. This validates recovery control flow, not live model answer quality or cost savings.

## Earlier report fixes included

- Docked Library with separate Evidence, Transcripts, Notes & reports, Timeline records, and Jobs & issues sections; Chats and Recent cases are separate.
- Ctrl+K search palette with file navigation and indexed-text results.
- Case/chat/evidence-display rename, F2 on relevant focused rows, full-name tooltips, and short evidence hashes. Evidence aliases retain their extension and preserve source bytes/citations.
- The open WE case display name was changed through the audited application API to **Eric Wilson · 26CRB00117**. Its folder and original evidence bytes were not renamed.
- An unambiguous charging-PDF filename suggests the matter display name; this is a filename suggestion, not a claim of legal document extraction.
- Last-case reopening, recent-case persistence, and queued transcription continuation on opening a case. Interrupted processing remains explicitly retryable.
- Source audio status derives from completed jobs and transcript records instead of trusting a stale display string.
- Recursive folder import, with case-directory/link/reparse-point exclusions and a visible skip receipt.
- Case-wide failed-tool receipts and queued/running/failed/interrupted jobs with full-transcription cancel/retry controls.
- Player plus expanded transcript, exact source-relative click-to-seek, and active-line highlighting, including audio playback.
- Storage meter for originals, staging, artifacts, and working files. Cleanup only removes UUID-named root staging files that hash-match a verified managed original; it refuses active/queued work and retains unknown files and job folders.
- Citation amber and quieter visual chrome; processing completion is not represented as legal readiness.

## Validation

- Frontend TypeScript/production build and 6 unit tests.
- 47 Rust tests passed: 38 core tests, one stream/unit test, and eight native sandbox tests (serial).
- Rust core/integrity/agent tests, including repeat-read recovery, pause/reopen checkpoints, citation rejection, visual coverage, search continuation, rename integrity, recursive import, transcript status, and safe staging cleanup.
- Native AppContainer/media tests run serially. Five parallel sandbox tests failed with worker exits on this machine; all eight passed serially. The exact concurrency cause was not established.
- Actual Tauri/WebView smoke test using synthetic PDF/image/document/video/audio fixtures: managed import, native PDF extraction, citation validation, and record creation.
- Native UI: case rename saved; Library remained docked; Ctrl+K search worked; a transcript line sought audio to exactly 2.440 seconds and highlighted; no browser console errors were observed in that smoke pass.

## Remaining limits

This is a development build, not a signed lawyer-ready release. Assistant-run replay and regression tests sent no provider requests. The user separately initiated a live run in the first updated build; it reached saved checkpoints and eight frame inspections, but was still running at the last observation. That observation exposed the citation-contract defect corrected in VisLex-next.exe. Live final-answer quality and total cost have not been benchmarked against a human-reviewed reference. The existing tiny ASR engine and its errors remain; speaker diarization is not implemented. Checkpoints and visual descriptions are unreviewed AI output, not certified evidence.

Still outstanding from the larger report: robust resumable multi-file ingest/quarantine, full 60 GB load testing, cancel responsiveness during synchronous processor tool execution, broad automatic staging policy, evidence removal/reclaim workflow, richer coverage bars and frame strips, timestamp/page citation chips across every artifact type, a contradiction workbench, captioned clip export, better ASR/diarization, complete Windows UIA testing, signed installer, and second-machine restore validation. The Timeline section currently exposes existing event records rather than a new timeline editor.

Existing cases retain their originals, receipt history, and audit chain. The failed receipt is preserved and can be resumed in the updated build; recovery uses its existing material rather than requiring a new chat.

Streaming implementation reference: https://platform.openai.com/docs/api-reference/responses-streaming
