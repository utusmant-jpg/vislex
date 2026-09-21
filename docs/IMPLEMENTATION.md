> **Superseded — September 21, 2026.** See docs/EVIDENCE-DESK-IMPLEMENTATION.md and docs/V4-IMPLEMENTATION.md for current capabilities. Retained as a historical record of the 0.1.x/0.2.x acceptance sessions.

# Implementation status and continuation plan

The requested seven-milestone plan is the public-release target. This repository implements an initial vertical slice across milestones 0–3 plus selected media and backup functionality. No milestone is represented as fully accepted.

| Area | Implemented | Limits / outstanding work |
|---|---|---|
| Desktop | Tauri 2, React/TypeScript, Rust coordinator, dark workspace, source tree, editor, agent panel, history, coverage | One selected viewer; complete multi-tab workspace, waveform/timeline tracks, accessible keyboard audit still needed |
| Local case | SQLite WAL/FTS5, exclusive editor lock, managed copies, hashes, occurrence and failed-item receipts | File imports only; reference imports, recursive inventory, reliable synchronized-folder detection, recovery reconciliation and medium-scale profiling outstanding |
| Originals | Hash-verified copies, read-only flags, original orientation retained | OS-protected plaintext, not application encryption; owner can change filesystem permissions |
| Documents | PDF native text and page rendering, DOCX paragraphs/tables, TXT, XLSX formula/cached-value pairs | PDF 2,000-page extraction limit; comments/revisions/footnotes/attachments not fully extracted; no OCR, sanitized HTML/email or CSV cell model |
| Images | Original viewer, zoom/rotation, EXIF metadata, orientation-corrected previews/crops, source-linked artifacts | JPEG/PNG/WebP direct agent inputs; other decodable formats via preview. Multipage TIFF identities, OCR boxes, image embeddings/similarity and comparison UI outstanding |
| Audio | Local tiny multilingual transcription, selected track and interval, timestamps, probabilities, explicit gaps | 60-second intervals; no direct model audio inspection, diarization, translations, waveform, full recording coverage, or validated multilingual accuracy |
| Video | Playback and AppContainer frame sampling, actual decoded PTS and rational timebase, repeated agent requests | Paginated sampling, at most 24 frames per response with explicit continuation; no exhaustive interval coverage, all-track review or full exact-frame navigation suite |
| Agent | Responses `store:false`, persisted conversation/tool receipts, bounded autonomous loop, source and record scopes, repeated-call stop, pause/resume | No application spending or step cap; one active task; live desktop API tools exercised, no arbitrary Python execution, no attachment region enforcement beyond tool-selected regions |
| Edits | SQLite-backed working records, CAS revisions, AI/unreviewed labels, protection, human approval, per-record rollback, source dependencies | Not ordinary files editable by outside editors; no atomic bulk rollback UI, semantic diff, structured clock/event schema or complete dependency graph |
| Search | SQLite FTS5 and native text | No semantic/image/entity/time retrieval; first immutable extraction only is indexed |
| Privacy | Offline default, fixed API destination, text/image permissions, restricted-source exclusion, Credential Manager keys, preflight reservations | Coarse source-level restrictions, no redaction-before-transmission, exact per-payload locator ledger/usage reconciliation still needed; no packet-capture offline audit |
| Backups | SQLite backup snapshot, manifest hashes, authenticated age archive, strict restore paths, preservation of artifacts/history | Verified locally into a separate folder; not yet restored on a second machine or under interruption/disk-full matrices |
| Exports | Clearly labeled draft Markdown/TXT/JSON, restriction checks | No PDF/DOCX/offline HTML reports, disclosure redaction, hidden-content removal or reviewed export gate |
| Professional review | Generic claim/event/person/issue/clock records and review flags | Production-register UI, privilege queues, dossiers, authority validation, contradiction model, competing clock mappings and exhibits outstanding |
| Release | Locked JS/Rust/Python dependency lists, x64 worker packaging, synthetic tests | No signing, clean installation certification, independent security audit, model held-out evaluations, full license redistribution review or target-scale benchmarks |

## Full-transcription follow-up

The full-recording workflow now supports asynchronous local transcription of every audio track, progress, cancellation, and source-linked TXT/JSON/SRT publication. It uses bounded 60-second chunks with lookahead, preserves a private partial-job journal, and indexes a full transcript when no prior extraction exists. The editable transcript remains a separate unreviewed revision. The saved files are included in encrypted backups. This workflow supports 16 GiB inputs, a 12-hour timestamp bound, and a two-hour processing wall-clock cap. Interrupted jobs are explicitly marked interrupted; automatic partial-journal resumption is not implemented.

The original short-interval processing bounds in the table still apply to frame sampling and targeted reprocessing. Whole-recording transcription releases the coordinator lock while the worker runs; other processors still require the asynchronous-job refactor. The requested general private-pipe job framework and model-quality acceptance remain outstanding.

## Current operational bounds

- Document/image processor inputs are at most 250 MiB; media inputs support up to 16 GiB. Each sandbox has a 120-second wall-clock limit, a 2 GiB process memory cap, and a one-process limit. Full-recording transcription has a separate two-hour worker timeout; the 200-hour case target is not benchmarked.
- Tool text pages are bounded to 200 lines and source searches have explicit pagination. UI case inventory is currently loaded as a whole, so the 10,000-file target needs pagination/virtualization and measured tuning.
- Native source text/extraction revision 1 stays immutable. Reprocessing generates separate immutable artifacts rather than overwriting indexed text. Audio interval transcripts have immutable artifact citations.
- Worker requests/results currently use private, job-scoped files rather than the planned private pipe protocol. Workers receive a copied input and a scoped output directory, never database handles.
- Processing currently holds the coordinator case lock while a worker runs. The Stop button can interrupt a network request, but a processing action finishes or reaches its timeout before cancellation takes effect. Refactor to leased asynchronous jobs before long jobs are enabled.
- Drafts survive switching records in memory. Save revisions before closing the application; unsaved drafts are not a crash-recovery feature.
- Backups include restricted sources and historical revisions. Draft report exports are not sanitized disclosure packages.

## Next implementation gates

1. Validate the existing tool loop against a configured multimodal API using synthetic fixtures, including a forced second video/audio inspection and a conflicting human edit. Record cost and citation support separately from tool success.
2. Move processors onto persisted asynchronous leases and private pipes. Add crash injection, transaction/publication reconciliation, cancellation, and sandbox escape regression fixtures. Confirm installer ACLs on a clean machine.
3. Build the complete versioned locator/coverage contract: page and region transforms, multipage images, track/sample ranges, media clock hypotheses, structured cells, and extraction revisions. Add local OCR and embeddings with explicit coverage.
4. Implement task changesets and atomic rollback, revision-aware dependency edges, file-backed validated Markdown editing, stale-answer display, and complete transmission receipts.
5. Add the professional workbench, safely parsed email/archives, deterministic redaction, report formats and reviewed-export gates.
6. Execute the requested demonstration on complete synthetic sources, restore on another machine, then evaluate scale, accessibility, security and held-out model quality. Reforecast the provisional 12–18+ month solo-development allowance from measured results.

Agent workflow updates (0.1.7): desktop tasks always use case-wide investigation; application dollar/step/context-size stops are removed. Older large receipts and images remain retrievable, and image inspection receives a fresh narrative-free visual pass before returning to the main investigation. Cited findings are persisted as unreviewed working reports after a support-review stage. Full Codex-equivalent capabilities, arbitrary analysis execution, reliable visual recognition and the remaining public-release gates are not claimed.
