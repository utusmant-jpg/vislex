# Case index (case-intelligence-v2) handoff

Branch `claude/case-index`, based on local `main` 99897e4. Owner: Claude (coordinator). Worker change delegated to GLM-5.3 (max), reviewed and amended by Claude.

## Why

On the real test case `sfd.ledcase` (13 sources, 8 videos, about 2.6 hours of footage, ChatGPT subscription route) the automatic analysis had used at least 176.7M input tokens without finishing a single video unit:

| Cause | Evidence |
|---|---|
| The packaged worker was built before source leases (commit ac8b492), so every video decode failed with `…\staging\.tmpXXXX\input` ENOENT | 720 failed `inspect_video_interval`, 913 failed video jobs; worker.exe dated 09-28 17:29 vs commit 22:27 |
| `publish_analysis_unit.assessment` was a free string checked against a fixed list | 446 "Unknown epistemic assessment" failures |
| Analysis units had no step limit; the repeat-failure guard needed byte-identical inputs | about 666k input tokens and 21 tool calls per video unit, none completed |
| One tool-using conversation per 4 s of video, plus scene-frame units, per-channel-minute audio scans and 5-way recursive synthesis, one unit at a time | 3,267 planned units (2,354 video); an estimated 1.5–3B tokens for the full run |
| Every unit request carried chat instructions, dossier rules, the progress ledger, a knowledge brief keyed on the unit prompt and case-wide status | `list_source_artifacts` 11.9M characters, `query_case_knowledge` about 39 KB per page |
| `model_manifest` held the full provider config JSON and base stamps held job IDs | settings changes and interrupted full-audio jobs restarted all analysis |
| A failed ChatGPT turn only reported `"failed"` | 306 immediate failures in 50 minutes on 09-30 (subscription usage exhausted); the loop never paused |

Answers also carried "Limitations / Next steps / Open issues" padding. Nothing in the UI added it: the prompts and tool schemas asked the model for it (limitation/next_action blocks, forced-finish and dossier directives, "Unresolved checks" in saved records, and the "Open issues" fallback).

## What changed

**Worker** (`workers/worker.py`):
- New `video` `operation: "sheet"`: decodes frames every `interval` seconds (≥0.5 s, ≤64 frames, ≤180 s window) and tiles them into labelled 3×3 contact sheets. Each tile shows `#index` and source-relative time, and its metadata records every tile's PTS. Decoding is multithreaded; a 90 s window of 1080p bodycam takes about 2 s.
- Every result carries `protocol: 2`.

**Host** (`processing.rs`): refuses worker output whose protocol is not 2, with an actionable "rebuild the worker" message (`WORKER_OUTDATED`).

**Planner** (`intelligence.rs`, `ANALYSIS_VERSION = case-intelligence-v2`):
- `video_segment`: 90 s windows at 3 s sampling, with the window's transcript (±5 s) and refs included.
- `pages`: 4 PDF pages per unit.
- `text`: 200 lines, capped at 24k characters.
- `transcript`: 120 segments.
- `synthesis_group`: fan-in 10.
- Per-channel audio scans and scene-frame units are no longer planned; sound events remain available on demand.
- Plan-time markers (preparation, decode and audio gaps, unsupported sources) are `gap` state. They appear as coverage notes, are never retried, and do not block the run.

**Unit protocol:**
- `agent::start_analysis_unit` starts a unit with only its own compact prompt, not the chat inventory, saved answers or knowledge brief.
- The host reads the unit input itself and records a host-labelled `read_analysis_unit` receipt (`agent::record_host_action`, input `performed_by: host`).
- The model performs only the named inspection, records visual observations for supplied images, and publishes once.
- Each finding carries `support {state: supported|unresolved, reason}`. When every finding has one, publication also completes the unit. Findings without it still use `finish_analysis_unit`.
- Analysis units see only 14 tools (`UNIT_TOOLS`), `UNIT_INSTRUCTIONS` and no ledger or dossier text on either route.

**Guards:**
- `unit_guard` (API and subscription routes) pauses a unit at 14 steps, after 3 failures of one tool, or immediately on an outdated worker; the unit then becomes blocked with that reason.
- `circuit_breaker` pauses the run after 4 consecutive blocked units, or at once for an outdated worker. It sets `case_analysis_pause_reason`, which is shown in Jobs.
- These are bug guards, not spending caps.
- The Codex route now keeps the service's own error text (for example a usage limit).

**Identity:** `model_manifest` is route plus model only. Base stamps exclude job IDs, so identical re-runs keep completed units.

**Retrieval:**
- `query_case_knowledge` (tool path) returns compact findings: text, source-relative seconds, data, and up to 6 refs with 240-character excerpts. It takes `limit` 1–200; synthesis uses 200.
- The UI and `query_knowledge` keep full proof.
- `answer_context` uses the question's content words, with stop words removed and a crude stem, and returns up to 20 compact findings.

**Answers:**
- `INSTRUCTIONS` now requires answer-first prose with citations and no limitation, next-step or other padding sections.
- The model answers from the case index first and inspects media only at the indexed times when a finding is missing, stale, disputed or too coarse, or when asked.
- `limitation`/`next_action` are no longer offered as block kinds (saved ones still parse).
- Gaps stay in the structured `gaps` field and dossier. The "Unresolved checks" and "Open issues" texts are gone.
- Follow-up turns carry at most 2,000 characters of the prior answer.

**UI:**
- "Suggested next checks" chips removed.
- The Jobs analysis card shows the pause reason and coverage notes separately from blocked units.

## Expected call count for sfd.ledcase

About 105 video segments, 27 transcript, 5 pages, 1–2 text, the DOCX, and about 20 synthesis units: roughly 160 units at 2–4 model requests each, compared with 3,267 units at up to 21 requests each. The synthetic run below measures the real number.

## Verification

Recorded in the status section below as runs complete. Real-model quality (accuracy of answers such as handcuffing orientation) remains unverified until the ChatGPT subscription usage resets. Synthetic runs measure only call counts, request sizes and protocol correctness.

## Status

- [x] Rust unit and integration tests updated for v2 (case_intelligence 26/26).
- [ ] Full cargo suite, vitest and type check.
- [ ] Synthetic end-to-end run on a copy of sfd.ledcase.
- [ ] Real-model run and gold question set (blocked: ChatGPT subscription usage exhausted on 2026-09-30).
