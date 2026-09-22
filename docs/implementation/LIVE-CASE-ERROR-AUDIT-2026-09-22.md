# Live case error audit — 2026-09-22

Scope: read-only inspection of the running packaged VisLex 0.3.0-dev4 UI, its case SQLite database, registered artifact inventory, and current source. No original evidence or case database was modified. This report intentionally excludes client document content, names, paths, and source IDs.

## Observed state

- Ten original sources: one PDF, one DOCX, eight videos. Automatic preparation completed for all ten; all eight full-audio jobs completed (one video has no audio track). PDF preparation reports 17 native and 17 OCR pages. Eight transcript records exist.
- Video discovery remains incomplete: eight overview indexes queued; one OCR index queued; one OCR index running; one OCR index failed. One child video OCR job failed and another was interrupted when the app closed. The two current failures report Windows error 1450, insufficient system resources.
- SQLite `PRAGMA quick_check` returned `ok`. All 1,302 registered artifact paths exist and their metadata parses. This does not establish extraction or legal accuracy.
- The latest automatic review ran 76 provider steps, with 1,287,309 reported input tokens and 18,285 output tokens on received calls. It repeatedly called `read_dossier` (11), `list_sources` (8), `list_source_artifacts` (13 total), and `checkpoint_review` (11 total). It produced no answer and paused after a provider incomplete event with no surfaced detail. An earlier automatic review also paused with the same provider message.
- The Jobs panel counts 48 attention items, mostly historical failed agent tool calls; it presents them alongside the two failed processing jobs. The user-facing errors are real validation failures, but many do not mean an original file or registered artifact was damaged.

## Findings and fixes

### P0 — Automatic analysis starts while video discovery is pending

`automatic::start_review` checks only `auto_prepare` and `full_audio` for pending work. The automatic prompt expressly allows indexes to remain pending, despite the requested full case analysis and chat gate waiting on `video_ocr_index` and `video_overview_index`. `review_input_stamp` includes only completed discovery jobs, so a review dispatched mid-index can become stale when indexing completes. The current run began with 11 discovery jobs still pending and never reached a final answer.

Fix: make review readiness and the review fingerprint use a consistent preparation set. Start the comprehensive automatic review only after required discovery finishes or enters a terminal failure; then preserve visible incomplete coverage. Do not treat sampled discovery as complete visual review. Add a restart and late-discovery regression using a real case lifecycle.

### P0 — Recovery button cannot complete a discovery index

Jobs renders **Recover saved job** for a failed `video_ocr_index` / `video_overview_index`, but sends `resume_processing` with the parent discovery run ID. `processing::resume` expects a processor staging manifest keyed by a child job ID. Even if a child is recovered, `resume_processing` calls `publish_prepared`, not `discovery::store_chunk`, so the parent index cursor/status is not advanced.

Fix: route discovery recovery through its parent run and publish path, retaining completed chunks. Show the correct action on parent and child jobs, and test the UI action through the desktop dispatch into a completed parent run.

### P1 — Error 1450 has no controlled retry/backoff

The worker launcher allows two concurrent AppContainer workers, each with a 2 GiB process memory limit. Discovery and agent inspection can compete for those slots. Two OCR jobs failed with error 1450; the underlying resource shortage cannot be proven from the database alone. The panel offers recovery but no resource-aware scheduling, backoff, or explanation. Discovery prioritizes OCR before all overview runs, so useful video navigation stays queued behind long OCR passes.

Fix: collect worker stage, process memory, and free commit diagnostics without client data; bound concurrent memory-heavy OCR work; retry transient resource failures from the last durable chunk with backoff. Schedule overview coverage fairly. Do not relax AppContainer or original-file isolation.

### P1 — Dossier schema invites invalid tool names and retry loops

`save_dossier` accepts a free-form string for each check tool, but server validation allows only eight exact inspection tools. Live failures used unsupported names such as `list_sources`, `recording_status`, `video_discovery_status`, `inspect_artifact_image`, and slash-separated tool lists. The model retried variants. Other failures used a source outside the task scope, stale dossier revision, a receipt from another tool/task, and malformed evidence locators. These failures did not overwrite the dossier.

Fix: put the exact server-supported enum in the model tool schema. Validate and return the specific offending check ID/tool and allowed replacement action; offer a structured read-only dossier template for full-case review. Preserve receipt and source validation. On revision conflict, reload the latest dossier once before asking for an edit; avoid repeated blind resubmission.

### P1 — Invalid checkpoint citations repeat across provider calls

An earlier run repeatedly invented artifact locators by appending page suffixes to an artifact UUID, including malformed source UUIDs. `checkpoint_review` correctly rejected those with `Artifact not found`, but the forced-checkpoint policy kept spending calls on near-identical invalid submissions. The current run also submitted one citation without an exact locator.

Fix: return the invalid citation and a copyable valid locator from the last source receipt; let the model omit an unsupported citation while retaining the text as an unresolved note. Add a bounded repeated-error escape that preserves saved progress and allows a qualified partial answer. Never accept fabricated citations.

### P1 — Context and request size make automatic review costly

The latest run consumed about 1.3 million reported input tokens over 76 steps, often around 18,000 to 23,000 per call. Repeated dossier/source/receipt checks and recurring checkpoint instructions dominate; the last calls still sent similar-sized requests despite context archival. The automatic prompt asks for full reading and consecutive video windows over eight recordings, an open-ended scope that cannot establish exhaustive visual perception from samples.

Fix: baseline per-call payload size by component (instructions, tool schema, ledger, history, images) and token usage before refactoring. Replace repeated full inventory and dossier bodies with compact versioned references and explicit changed-since summaries. Cache stable instruction/tool prefixes where the provider supports it. Give automatic analysis a finite per-source plan and publish a partial coverage report at a deterministic boundary. Keep model quality, user cancellation, and usage visibility.

### P1 — Provider incomplete reason is discarded

`providers::send` reads only `response.error.message`, `error.message`, or top-level `message` for `response.incomplete` and `response.failed`. Both automatic reviews stopped with the generic fallback. The event may contain `response.incomplete_details.reason`, status, or code, which the app currently does not surface. The last transmission is marked uncertain and the task cannot safely be resumed automatically.

Fix: record a small allowlisted provider status/reason/code and response ID when available, plus request step and usage already received. Distinguish output allowance, timeout, provider stop, and transport end. Never resend an uncertain transmission automatically; provide a safe continuation path in a new task using the saved checkpoint.

### P2 — Jobs panel obscures active problems

Every historical failed agent action is returned in the main snapshot and counted as needing attention, including repeated malformed checkpoint/dossier calls that were later corrected. This makes 48 attention items look like 48 current file failures. The panel also shows raw JSON error output rather than a short message for many tool failures.

Fix: separate active processing failures from historical agent tool diagnostics; group identical tool errors by task and message, show counts and latest receipt, and allow expanding history. Keep audit receipts accessible. Test the actual Jobs interaction and badge count.

### P2 — Disk amplification from video chunks

The case has approximately 2.25 GiB in staging across 144 directories. `run_prepared` copies the complete original input into a new per-job staging folder even for each 60-second discovery chunk. This is consistent with the observed storage growth, though the exact share attributable to discovery was not measured.

Fix: measure per-kind staging bytes and reuse a safely verified private source copy for chunks, or reclaim only validated completed staging copies. Keep originals immutable and preserve recovery manifests/results.

## Current operation

The automatic review is paused with no final answer and an uncertain provider transmission. Its **Resume work** control is expected to reject that uncertain transmission. Background video discovery continues independently, with one failed parent index requiring proper recovery in a future build. No live task, processor, original, artifact, or case setting was altered during this audit. A new packaged build and end-to-end run are needed to verify repairs; this audit alone does not certify the case as fully reviewed.
