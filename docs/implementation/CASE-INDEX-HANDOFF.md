# Case index (case-intelligence-v3) handoff

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

## Verification (2026-09-30, branch claude/case-index)

Synthetic end-to-end run with `scripts/native-case-index-run.ps1` on a copy of sfd.ledcase (the original was never opened by the test build):
- Setup: real desktop debug build, real worker and contact sheets, API-key route pointed at the loopback synthetic provider (`scripts/native-case-index-mock.mjs`).
- The provider publishes placeholder findings citing real refs; it assesses no evidence.
- Token figures are estimated from request sizes: 4 characters per text token and 1,105 per 1920x1080 image.

| | v1 (logged on the real case) | v2 (measured, synthetic) |
|---|---|---|
| Units | 3,267 (0 video units complete) | 177: 170 complete, 7 coverage notes, 0 blocked, state `ready` |
| Requests | >5,000 and still running | 427 |
| Input tokens | ≥176.7M reported (300 failed turns unreported) | ≈2.55M estimated |
| Wall time | never finished | 21.2 min |

Per-kind estimates:
- `video_segment`: 216 requests, about 1.39M tokens, plus 113 visual-review requests (435 sheet/page images, about 0.72M).
- `transcript`: about 0.15M.
- Synthesis: about 0.21M.
- Pages and text: about 0.07M.
- Largest single request: about 10.5k tokens.

A real model writes longer publications, so expect several million tokens, not 2.55M exactly.

Tests:
- `cargo test --features subscription,research --no-fail-fast`: all binaries pass (case_intelligence 31, core 93, lib 83, others unchanged).
- `npx tsc -b --noEmit`: clean.
- `npx vitest run`: 365/365.
- `npx playwright test e2e/accessibility.spec.ts e2e/harness-chat.spec.ts`: 9/9.
- `scripts/native-intelligence-acceptance.ps1`: automatic_ready, hidden_tasks, exact_proof, human_revision_preserved, human_edit_reconciled and pause_and_resume all true; warm retrieval about 15 ms.
- Worker unittests: contact_sheet 4, exact_frame 3, result_safety 6, video_discovery 5.

Independent review: GLM-5.3 (max, read-only), run 20260930-043420-68548d96. No invariant breach found. Findings were fixed by Claude:
- The image-revocation fence now covers the new kinds.
- A failed host read no longer strands a running unit.
- The sheet decode limit scales with frame rate.
- Coverage checks allow the recording's own frame gap.
- The count of units with no findings is shown.
- Subscription context keeps the host-read input.
- The audio inventory host receipt is accepted.
- Playback output passes the protocol gate.
- The speech truncation note is added.

One finding was not applicable: cross-turn Codex error bleed. Each unit runs its own single-turn ephemeral thread.

Not verified:
- Real-model answer quality, and the real-model token figures for this case. The ChatGPT subscription usage was exhausted on 2026-09-30, so no real model could run.
- The gold question set (for example which way the suspect faced when handcuffed) still needs a real-model run: re-run the analysis on the case copy with the subscription route, then ask questions in the app.

## Status

- [x] Rust, frontend, accessibility and native acceptance suites.
- [x] Synthetic end-to-end run on a copy of sfd.ledcase.
- [x] Independent review and fixes.
- [ ] Real-model run and gold question set (blocked on subscription usage).
- [ ] Packaged release build for the installed app. The dev worker in the primary checkout must be rebuilt after merging (protocol 2).

## v3: denser video review (2026-10-01)

v2 reviewed video only as 640 px contact-sheet tiles every 3 s, with no scene-cut frames and no in-unit refinement. Brief actions (a strike, a grab, a draw, a throw, the moment of handcuffing, which way someone faced) could fall between tiles, and the chat agent answered from the index first. v3 spends more on images, which were a small share of v2's cost, instead of adding conversations:

- `video_segment` samples every 1.5 s (60 tiles per 90 s window; the sheet limit is 64). The prompt reports changes between tiles with both tile times and marks the motion in between as unresolved instead of describing it.
- New `video_focus` units: dense looks at flagged moments, 0.5 s frames on 2x2 sheets of 960 px tiles (`inspect_video_sheets` `layout: "detail"`, at most 30 s). The planner (`focus_windows`) takes cues from the immutable transcript (strong cues: force, weapons, restraints, flight and commands such as "get on the ground"; procedural cues: hands, search, consent, injury) and from discovery scene changes. Each cue opens a window 3 s before to 7 s after it; overlapping windows merge up to 16 s. The strongest are kept within a budget of one per 120 s of footage (at least two per recording), in time order. Identical inputs plan identical units.
- Publication of a `video_focus` unit requires the detail-layout sheets to cover the window. It is part of the image-permission fence and the retry set like the other visual kinds.
- Model-facing findings carry `coverage` (`overview_sheets` / `dense_sheets` / `frames`, window, sample seconds, tile width). The chat instructions say that overview findings cannot settle a brief action on their own. When no dense look covers that moment, the agent inspects at 0.5 s or denser around the indexed time, and an absent finding is not evidence that nothing happened.
- `ANALYSIS_VERSION = case-intelligence-v3`, so existing cases re-plan.

Synthetic end-to-end run (same method, the same sfd.ledcase copy, debug build of this branch):

| | v2 | v3 |
|---|---|---|
| Units | 177 | 230: 223 complete, 7 coverage notes, 0 blocked, state `ready` (49 dense looks) |
| Requests | 427 | 582 |
| Images sent | 435 | 1,061 |
| Estimated input tokens | about 2.55M | about 4.63M |
| Wall time | 21.2 min | 33.4 min |

Output tokens are not measured, because the synthetic provider returns a fixed reply. Real-model quality is still unverified.

Tests: `cargo test --features subscription,research --no-fail-fast` all pass (case_intelligence 32 with the new `flagged_moments_get_bounded_dense_looks_in_time_order`, core 93, lib 83); `npx tsc -b --noEmit` clean; `npx vitest run` 365/365. The worker is unchanged; layouts use the existing sheet parameters.
