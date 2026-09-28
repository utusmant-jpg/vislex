# VisLex functionality master plan (approved 2026-09-28)

## Context

The user wants VisLex to become the best-functioning app of its kind without breaking it:
- faster and steadier on 8–16 GB Windows laptops;
- far better document and media preview;
- a complete OpenRouter integration;
- an optional "second opinion" add-on that sends only uncertain audio or video snippets to a remote audio, video or tracking model;
- removal of redundant, headache-causing features;
- better typography.

A Claude design session is redesigning the UI at the same time, so this plan must not fight it.

**Repository state (verified 2026-09-28)**
- **Trunk.** `origin/claude/redesign-v14qbo` @ `99aa077` contains every live work stream and is 394 commits ahead of `origin/main` @ `92d364a`. The designated branch `claude/stoic-ride-1c8hns` equals `main`, and its working tree is clean.
- **How Codex pushed.** 422 commits carry the user's own identity, `utusmant-jpg`. Local Codex and desktop Claude used the user's git config and credential helper. Only the cloud commits say `Claude <noreply@anthropic.com>`.
- **Codex snapshots.** The `codex/snapshot-*-20260927` branches are WIP handoff pushes labelled "(unverified)". Three merge cleanly: assistant, harness, settings. `snapshot-subscription` carries 3 commits on a stale base, conflicts with the trunk, and duplicates the trunk's `task_access_route` scheme.
- **Design lanes.** `claude/redesign-harness`, `-workspaces` and `-assistant` are live lane refs of the design workflow (`wf_3fc12f9a-9d8`). They must not be archived. Only `worktree-wf_625c0e60-6e6-{1,2,3}` (equal to main) and `glm/vislex-ultra` (behind main) are dead.
- **CI.** It has never executed a step: 8 of 8 runs had `runner_id 0`, which points to Windows runner billing or provisioning. It also triggers only on `main`.
- **Task queue.** R00–R07 are verified. R08–R17 and R19 are implemented but not verified. R18 and R20–R25 are pending.
- **The design lead also writes Rust**, not only UI (commits `a48f88c` in `desktop.rs`/`providers.rs`/`tests/core.rs`, and `f6eebd5` in `package.json`). Ownership therefore has to be negotiated, not assumed.

**Evidence base**
- Workflow `wf_9b9158d3-f33`, 17 read-only agents: six code audits, six web research sweeps, a critic and four gap follow-ups.
- Workflow `wf_99ae1f4a-a57`, five adversarial reviewers: breakage, collisions, RAM, security and completeness. Their critical findings are folded in below.
- The egress proxy blocked some vendor docs. OpenRouter and OpenAI field names, prices and model lists must be re-verified at implementation time.

**User decisions (2026-09-28)**
1. Second-opinion sends always need human confirmation per batch; there is no automatic send mode in v1.
2. The ChatGPT-subscription (Codex) route is flagged off by default, not deleted.
3. The first remote vendors are OpenRouter plus direct OpenAI (`gpt-4o-transcribe`), using the existing key. fal.ai tracking and ElevenLabs Scribe come later.

---

## Ground rules

1. **Integration path.**
   - Fast-forward `claude/stoic-ride-1c8hns` to v14qbo. This is a fast-forward, not a force-push.
   - Use it as the functional integration branch, with topic worktrees `func/<topic>` off it.
   - Functional slices reach the trunk as PRs into `claude/redesign-v14qbo`, merged at design-slice boundaries with an announced freeze on any shared file.
   - After the user approves fast-forwarding `main`, both streams converge on `main` through PRs.
   - Never base work on `main` (until it is fast-forwarded) or on the `codex/snapshot-*` branches.
2. **Phase 0.0 ownership handoff comes before any functional Rust commit.**
   - Record a dated owner table in a new `docs/implementation/SEAMS.md`, owned by the lead. It covers: `case.rs`, `desktop.rs`, `agent.rs`, `providers.rs`, migrations, `src/types.ts`, `bridge.ts`, `caseEvents.ts`, `package.json`/lock and `NEXT-STATUS.json`.
   - The request channel is cross-session messages to the design session, with the user relaying if needed, plus `SEAMS.md` entries.
   - `NEXT-STATUS.json` gets one writer, or per-lane top-level keys that the lead merges.
3. **Where functional code lives.**
   - Rust and worker code, once owned.
   - New `src/api/*`: typed wrappers, `actions.json` and DTO types such as `src/api/transcript.ts`.
   - New `src/features/<feature>/*`, exported as self-contained panels. The lanes will not use this namespace.
   - New `src/preview/*` and `src/state/*`.
   - Edits to design-owned files happen only at agreed mount points after the lane merges. Those files are `App.tsx`, `ui.tsx`, `caseEvents.ts`, the EvidenceViewer family, `SettingsDialog.tsx`, `AgentPanel.tsx`, `tokens.css`, the styles and `bridge.ts`.
   - Every npm dependency goes through the lead's lockfile slot. Reuse the lead's planned `@tanstack/react-virtual`.
4. **Contract rule, split by timing.**
   - **Now:** a Rust match arm, an entry in an explicit new `PURE_READ` set when relevant, a typed wrapper in `src/api`, a Rust unit test, a golden JSON in `fixtures/contracts/` checked by `src/contracts.test.ts`, and an entry in `src/api/actions.json` (action, read-only flag, sample response).
   - **After the harness lane merges:** its owner adds a SYNTHETIC `case` from that manifest.
   - The browser demo defaults to "native-only; the existing error is thrown", which needs no `bridge.ts` edit. Any demo additions are batched into a single lead-approved commit.
   - The `desktop.rs` ~1175 list is the no-emit list, **not** a read-only list; `snapshot` writes.
5. **Flags and defaults.**
   - Frontend flags in `src/features.ts`; Rust gates as consts or case meta. Security-relevant gates are never a renderer-savable `Config` field.
   - New UI ships dark.
   - **Restrictive defaults win.** `OpenRouterPolicy::default()` is implemented by hand. Grants default to off. An older app drops unknown fields, so absence must mean the safe state.
6. **Invariants.**
   - Original bytes and IDs, immutable revisions and exact historical citations.
   - Provenance, per-case grants and restricted derivatives.
   - Human-review gates, the per-job AppContainer, and keys only in Credential Manager.
   - Usage visibility and cancellation, with no spend caps and no silent model, provider or endpoint change.
   - Remote output is always an unreviewed interpretation and never overwrites local output.
7. **Verify before rewriting.**
   - No Phase 1–4 change touches code of an implemented-but-unverified task (R08–R17, R19) until that task's recorded `unrun_checks` have been attempted and recorded (Wave A0).
   - Performance changes need baselines measured with Phase 0.5 telemetry.
   - "Implemented" is not "verified".
8. **Commits and writers.** Small reviewed commits, each with an `Agent:` trailer. At most three parallel writers, each in its own worktree.

## Mapping onto the task queue

Register each new slice in `NEXT-TASKS.json` with `owned_files`, `depends_on` and acceptance criteria, and run `vislex_plan.py check` in the same commit.

| Plan area | Existing task | New task |
|---|---|---|
| CI tiers, packaging, signing, model packs, diagnostics | R25 | — |
| Events/fence (P1 #6–7), case switch (#2), scheduler (#3), lease (#14) | R08, R09, R11, R10 | — |
| ASR signals and transcript DTOs | R12 | R30 word confidence |
| Search scale and embeddings | R13 | — |
| Media lanes and frames; PDF preview | R14, R15 | R29 preview v2 (text/office/email/images) |
| Case store | R16 | — |
| Chronology, custody report, grid, reels | R17 (+R18 before exports) | R31 chronology + custody, R32 grid/reels/near-dup/entities |
| OpenRouter policy, catalogue, cost | R19 | R26 |
| Generic OpenAI-compatible endpoint | R19/R24 | R27 |
| Second opinion | R24 (security pass) | R28 |
| Codex flag-off | R20 | — |
| Model/routing/escalation quality | R22 | — |
| Design system and accessibility | R21 (design session) | — |
| Release gate | R23, last | — |

---

## Phase 0: Safety net, ownership and hygiene

**0.0 Ownership handoff** (rule 2) and **Codex-route decision delivery.**
- Send the "flag off" decision to the settings-lane owner **before that lane merges**.
- Define the Rust blocker payload now, for example `{route:"unavailable", reason:"subscription route disabled in this build; choose an API provider"}`, so the lane and the harness can render it.

**0.1 Branches.**
- Fast-forward `claude/stoic-ride-1c8hns`.
- Tell the lead that the snapshots exist. Integrating lane commits is the lead's job; do not hand lanes their own commits back.
- Port the route-survival idea from `snapshot-subscription` as a test against `task_access_route`.
- Propose archiving only `worktree-wf_*` and `glm/vislex-ultra`, with user approval before any deletion.
- Fast-forward `main` to the trunk only with approval, after the lanes integrate and checks pass.
- Add `.codex/` to `.gitignore`. Require the `Agent:` trailer. Make `fixtures/generated/statement.pdf` generation deterministic, owned by the harness lane.

**0.2 CI that runs** (R25; `.github/workflows/ci.yml` needs a lead or R25 owner).
- **Tier 0 job** on `ubuntu-latest`, for every PR and for pushes to `main`, `claude/**` and `func/**`:
  - `npm ci`, `tsc` + `vite build`, `vitest`;
  - `npx playwright install --with-deps chromium`, then Playwright and axe;
  - Python unit tests for workers, benchmarks and scripts;
  - host-target `cargo test` without the `desktop` feature;
  - `vislex_plan.py check`.
- Add `concurrency` and `timeout-minutes`.
- Gate `src-tauri/tests/worker_video_e2e.rs` with `#![cfg(windows)]` and `#[ignore]`. It needs the packaged worker.
- Write `docs/TESTING.md`, covering the Linux cargo target and which suites are Windows-only.
- **User action:** fix GitHub Actions billing or the Windows runner, or add a self-hosted runner.
  - Tier 1 (Windows): `fmt`, `clippy`, `cargo test --locked`, `check --features desktop`.
  - Tier 2 (nightly, real R8 laptop): packaged worker, ignored `sandbox` tests, native CDP journeys and `perf.json`.
- One verify entry point shared by CI and local runs, so `verify-v4.ps1` and CI cannot drift.

**0.3 Protected-journey tests** (after the harness lane merges, using role/label selectors agreed with the lead). The 10 journeys:
1. import → process → transcript → cite → review → export;
2. restricted-source denial;
3. grant off means no provider call;
4. chat stream, cancel and usage;
5. stale-epoch case switch;
6. backup and restore, including escalation clips;
7. historical citation;
8. settings and grants persistence;
9. drafts survive switches;
10. job failure and recovery.

Until then, contract golden tests (rule 4) carry the load.

**0.4 Compatibility prerequisites.** These come before any schema, artifact or model change.
- `backup.rs` ~296: accept `1..=ARTIFACT_FORMAT_VERSION` against a registry of `(ext, mime, since_version)`.
- Write the manifest as the first tar entry, with `case_schema` and `app_version`, and refuse newer backups before extracting. Keep accepting a manifest that comes last.
- One `pub const CASE_SCHEMA`, replacing the literal 8 at `case.rs` ~259 and ~1370.
- A numbered additive-only migration step table: snapshot, then `BEGIN IMMEDIATE`, then set `user_version`. Never DROP, rename or rewrite evidence tables. Bring `discovery_*` and `semantic_passages` into the chain at v9.
- Frozen real-release fixtures at v5, v7 and v8. Tests:
  - chained upgrade;
  - a newer case or backup refused with nothing written;
  - a v1 backup restores under a v2 registry;
  - pinned citations resolve to identical bytes after upgrade;
  - the OpenAI credential name `openai-api-key` is unchanged.
- **Downgrade path.** Forward-refusal plus the pre-migration snapshot, documented in the user guide.

**0.5 Telemetry and diagnostics** (R25).
- **Worker metrics** (`sandbox.rs` ~355–410). A Job-handle guard whose `Drop` queries `JobObjectExtendedLimitInformation.PeakProcessMemoryUsed` plus basic accounting **on every exit path**:
  - it records the outcome (`ok`, `cancelled`, `timeout`, `exit_code`, `memory_limit`, `launch_failed`, with the stage);
  - it also records `GlobalMemoryStatusEx` available physical memory and pagefile at admission and on failure;
  - rows are persisted in a `worker_metrics` table and in job provenance.
- **App diagnostics.**
  - A panic hook plus a rotating app log outside cases, with no content, hashed paths and never keys.
  - An "Export diagnostics" action (versions, resource profile, `perf.json`, `worker_metrics`, failure reasons, migration history) with a preview.
  - A test asserting no case text or key material appears in the bundle.
- **`scripts/perf-run.ps1`.**
  - Runs the **packaged release** build in a **visible foreground** window at 1366×768 on R8.
  - Uses in-page PerformanceObserver (long tasks, event timing) on named interactions: open case, open a 500-page PDF, scrub 1 h of video, switch source, open a transcript at hour 9.
  - Worker memory comes from Job telemetry; UI memory comes from a light sampler with no WMI in the hot loop.
  - At least 5 repetitions, reporting median and p95 with spread.
- Until Tier 2 runs on real R8/R16 hardware, every perf-gated item stays "unverified".
- **Initial budgets, for calibration only:** full_audio_tiny ≤700 MiB, small ≤1800 MiB, interaction p95 <100 ms, cancel p95 ≤2 s (interim ≤5 s until P1 #10). The tree budget equals UI plus the sum of admitted reservations. Add search p95 and re-embed time at the R23 case tiers.

**Wave A0: verify before rewriting.** Attempt and record the `unrun_checks` of R08–R11, R13–R16 and R19 on the trunk. Rewrite that code only afterwards.

---

## Phase 1: Speed, stability and memory (guarded)

Each item carries a named regression test. Items that would weaken an invariant have been redesigned per the review.

| # | Change | Guard / test | Where |
|---|---|---|---|
| 1 | **Evidence protocol.** Register it with `register_asynchronous_uri_scheme_protocol` + `spawn_blocking`. Add a new `artifact_descriptor` + `file_hash_cached` path **used only by the protocol**; `processing::artifact()` stays strong for redaction, exports, agent reads and crops. Remove the 64 MiB whole-body path by requiring ranges, and keep the 4 MiB range cap (Tauri needs an owned body). Return 404/409/416 with `X-VisLex-Reason`. Extract a pure `serve_range()`. Keep the app-origin restriction (`d8bcaba`, no `ACAO:*`) and the display MIME allowlist (extended only for FLAC/WAV clip playback). | A same-size, mtime-restored tampered artifact must still fail `export_redaction`, `read_artifact` and crop. `serve_range` unit tests. | `desktop.rs` ~1654–1819 |
| 2 | **Case open, open-restore and restore outside the mutex.** Set a `switching` AtomicBool under the lock and reject `with_case_expected`, `automatic::next`, task start and every job start while it is set. At swap time, recheck `case_id`, epoch and `running==0`, and refuse a concurrent switch. Restore hashes while extracting. Warm the hash cache in the background after open. | A queued `auto_prepare` must not start during a slow restore. A second concurrent open is refused. | `desktop.rs` ~472–589, `backup.rs` |
| 2b | **Audit checkpoint.** An incremental checkpoint anchored **outside** the mutable table (a separate hashed file). Full verification stays on restore and on "Verify case". A failed background verify blocks exports, backups and provider sends and shows a persistent integrity banner. | Tamper with a pre-checkpoint row: exports are blocked after the background verify. | `case.rs` ~378/430 |
| 3 | **Scheduler for 8–16 GB.** Read total RAM and cores to get tier S (<11 GiB reported), M (<23) or L, exposed by `resource_profile`. **Reservation-based admission:** each kind reserves its telemetry p95 commit plus a margin for the permit's life, and is admitted only when the reservations fit the tier budget and `ullAvailPageFile` minus reservations stays above a floor. Otherwise it queues with a visible reason. Per-kind Job caps come from measured p99 and are never below what passing fixtures need. Threads are passed in a separate `runtime.json` that is **excluded from every cache key**; concurrent workers together use at most physical cores minus one. `playback`/proxy and `media_clip` count as heavy until measured. `frame_at` is light. The gate sits behind a flag until the Jobs UI shows the queued reason (a lead edit in Wave C/D); until then admission works as today. | Unit tests for the 8/16 GB tier functions. No 1450 errors on the R8 fixture. | `sandbox.rs` ~78–140, 367 |
| 3b | **Preemption.** Add a distinct `preempt.request` signal and a `preempted` status that resume accepts, kept separate from cancel. Preempt only for a waiting heavy interactive kind. Hysteresis: a minimum run time and a maximum number of preemptions per hour. The `full_audio` timeout accumulates or scales with media duration × RTF. **Requires the #14 lease for `full_audio` first**, so preemption does not re-copy multi-GB sources. Record the resume overhead. | Resuming after preemption produces an identical transcript. | `transcription.rs` ~113–147, `sandbox.rs` |
| 4 | **Chat becomes available after `auto_prepare`.** This depends on #3 and #3b and on the staleness fix for transcript publishes (#5). Tools such as `read_text` and search return "transcription pending for X", so coverage is enforced in tool results, not only in the prompt. | Native R8 test: chat during `full_audio` completes with no 1450 errors and no false "complete coverage" claim. | `automatic.rs` ~321, `desktop.rs` ~1048/1124/1150 |
| 5 | **Staleness.** Scope **only** the extract and transcript publication triggers by source intersection (`case.rs` ~590, `transcription.rs` ~314/414). Import, restriction and record saves stay globally conservative until typed record→record dependencies exist; those are added later in a migration, as `{kind:'record',id,revision}`. | An import after a claim record still marks it stale. Editing a referenced record flags its dependents once typed dependencies land. | `case.rs`, `transcription.rs` |
| 6 | **Coalesced events.** Coalesce `case-event` **and** the legacy `case-changed` together, with exactly one `event_seq` per emission. Add an optional `changed` mask that `caseEvents.ts` may ignore; its adoption goes through the lead, with no parallel hook. `render_page` stays an evidence derivative, because redaction and agent inspection use it. For viewer derivatives, keep one coalesced emit when job rows are created and only skip `kick_semantic`. | Rapid page renders produce ≤4 snapshot refreshes per second. No `event_seq` gaps. | `desktop.rs` ~50–59, 299–323 |
| 7 | **Pagination.** Keep the fence, but replace `audit_seq` with a dedicated `listing_version` counter bumped on source, record, restriction and stale changes, not on unrelated audits. Adopting it in `App.tsx` is a lead edit. Make `sources()` a single JOIN, add a content-free `records_meta()`, and compute ledger line counts in SQL. | Update a record on page 2 while page 1 is loaded: nothing is lost or duplicated. | `desktop.rs` ~625/632, `case.rs` ~451–483/816/844 |
| 8 | **Read pool.** An explicit `PURE_READ` set that excludes `snapshot`, or split `snapshot` into read and sync parts. The pool lives **inside `Case`**, so dropping the case drops the readers. Assert zero readers before delete, restore or switch. Budget `cache_size` and `mmap_size` on R8. | Every `PURE_READ` action succeeds on a `query_only` connection. `delete_case` works on Windows with the pool active. | `desktop.rs`, `case.rs` |
| 9 | **Cache keys.** `{source_sha, kind, processor_version, model_id+sha, params}`. `processor_version` is **derived at build time from a hash of each kind's worker sources**, and CI fails when it drifts. Reused results show "reused from worker X". Transcription **resume keeps strict worker equality**, unless per-chunk worker and version provenance is recorded and published. Add `vad_filter`, `beam_size` and the model hash to the `full_audio` chunk key. | Resuming across a `processor_version` change refuses, or records both versions. A VAD, beam or model change misses the cache. | `processing.rs` ~137, `transcription.rs` ~122, `full_audio.py` ~50, `discovery.rs` |
| 10 | **Worker launch cost.** **Keep per-job AppContainer SIDs.** Grant runtime RX once to a capability SID (`DeriveCapabilitySidsFromName`) or to ALL APPLICATION PACKAGES, for read-only binaries only. Remove the runtime from the per-job recursive `icacls` grant and revoke. | Job A cannot open job B's directory or lease while both run. Budget job start and cancel latency. | `sandbox.rs` ~249–282 |
| 11 | **Import hashing.** Tee-hash the source stream plus **one read-back hash of the staged file**, saving one full read. Keep a strong source re-hash where mtime resolution is coarse. Batch each import item into one transaction. Add `cache_size`, `mmap_size` and `optimize` on close. | Corrupting the stage between copy and publish is detected. | `case.rs` ~1475, 369 |
| 12 | **Robustness.** Replace `unwrap()`s held under the lock (`desktop.rs` ~1396), wrap multi-statement mutations in savepoints, and dedupe `kick_automatic`. | Existing suites. | `desktop.rs`, `case.rs` |
| 13 | **Paginate large payloads:** `investigation_workbench`, `coverage_map` (SQL `json_extract`), `artifact_info` and `processing_status`. Lane adoption follows. | Contract goldens. | `workbench.rs`, `desktop.rs` ~818–854 |
| 14 | **Read-only source lease** for all interval media kinds, `full_audio` first. OCR sparse-text PDF pages first and queue the rest as an explicit coverage pass. | Discovery and lease tests. | `processing.rs` ~170, `transcription.rs` ~128–136, `worker.py` ~316 |

---

## Phase 2: Evidence understanding quality (local, offline, evaluated)

Every model or parameter change is gated on **R22 quality evaluation** with thresholds fixed in advance, on synthetic or de-identified sets: WER and critical-token error for ASR, CER for OCR, recall@k plus negation and wrong-person tests for embeddings. It is also gated on `perf.json` for its RAM tier. A new run never rewrites old ones; each new run gets a new `run_id` or revision.

- **ASR signals.** Store `compression_ratio`, `temperature`, `avg_logprob` and `no_speech_prob` in `transcript_segments.metadata` (a JSON column, so no schema change), plus the per-frame `content_val` from scene detection. Bump the method strings.
- **Language handling.** A per-source language hint or override, recorded in the revision and cache key. Per-chunk detection in "auto" mode. Show the detected language in the transcript header.
- **Word confidence** (R30).
  - Keep word data **out of the page DTO**. Instead:
    - add a `segment_words(run_id, ordinal_range)` fetch for the visible window;
    - send per-page low-confidence words and a count;
    - evict pages outside a window around the playhead;
    - set a renderer-heap budget on a 10 h transcript fixture.
  - Types go in `src/api/transcript.ts`.
  - The UI (underline plus icon, "next/previous uncertain", per-source count) is a `src/features/transcript-confidence/*` panel mounted by the viewer lane.
- **Silero VAD.** Skipped spans are shown as "no speech detected" coverage; the cache key changes.
- **Model tiers.** The tier only **suggests** a model. The choice is written to case meta once, at creation or by explicit user choice, and never recomputed from the current machine. Opt-in `large-v3-turbo` and `Parakeet-TDT-0.6B-v3` (CC-BY-4.0 attribution) are offered only after R22 and `perf.json` pass on R16. The quoted "1.5 GB turbo" figure is GPU memory.
- **OCR.** RapidOCR 3.x PP-OCRv5 through an A/B test with a CER acceptance threshold; keep v4 selectable. Use `opencv-python-headless` if the pins allow.
- **Search at scale** (R13).
  - FTS5 bm25 over passage-level rows becomes the lexical arm of RRF; today a substring scan returns at most one hit per source, capped at 30.
  - Query embedding goes through a persistent embedding path instead of a worker per query, following the service rules in Phase 3.
  - Vectors are f32/int8 blobs with a kind/source prefilter and bounded top-k.
  - Index currency is tracked incrementally from revision events.
  - Add facets: kind, date, custodian, reviewed/uncertain, speaker.
  - multilingual-e5-small is **not a drop-in**: it needs prefixes, a separate model id and a resumable background re-embed. MiniLM stays the default until the evaluations pass.
- **Sound events.** sherpa-onnx CED-small or Zipformer int8 labels on existing transients, as unreviewed suggestions.
- **Diarization.** A known-speaker-count input, a TitaNet-large or WeSpeaker trial, and a speaker-merge shortcut. Embeddings stay case-scoped and are purgeable (Phase 7).
- **Export fonts** (`workers/document_export.py`, 38 lines, Vera at line 24).
  - Add Noto for Latin, Greek, Cyrillic and CJK, with the CJK size budgeted.
  - For scripts that need shaping (Arabic, Urdu, Indic), **keep the explicit refusal**, pointing to Word export, until a shaping path passes golden render tests.
- **Playback.**
  - Remux when the source is already H.264/AAC. Otherwise the proxy is a heavy queued job with progress and cancel, a 1 s GOP, faststart, and resolution capped at 720p on tier S.
  - **Choose the encoder now** through a licence review: the bundled libx264 versus openh264 or Media Foundation.
  - Cite source PTS only. Collapse the two playback paths.
- **Excluded:** Surya, Moondream 3, extract-msg (GPL) and PyTorch stacks. A local VLM is a later opt-in for tier L.

---

## Phase 3: Document and media preview

Parsing stays in the sandboxed worker, which emits derivatives, and the renderer draws them plus overlays. There is no pdf.js in the renderer, because of the CVE-2024-4367 class of bug.

- **`src/preview/` registry.** `<PreviewHost>` takes EvidenceViewer's exact props `{source, locator, run, refresh, onLocatorSelect, onAsk, caseId, sessionEpoch}`. Adapters load lazily. The viewer lane swaps in a single mount point for its kind branches (`EvidenceViewer.tsx` ~368–458).
- **Unified locator** in `src/preview/locator.ts` and `src-tauri/src/locator.rs`, sharing `fixtures/locators.json`.
  - Forms: `R<rev>L`, `page:N[;bbox]@render_rev`, `time:S-E;track`, `frame:pts@tb`, `block:n`, `sheet:Name!A1`, `email:part`, `artifact`.
  - One "Copy citation" action. New code writes only pinned forms.
- **PDF.**
  - **Measure first.** After P1 #10, use `worker_metrics` to measure per-page render latency and memory for `pdf_page`, now rendered at viewport × DPR (≤1600 px) and batched N±3 pages per job.
  - **Build a persistent render service only if p95 still misses the budget.** If built, it:
    - covers exactly one `(case, source, sha, policy_epoch)` with one read-only lease;
    - gets a dedicated `run_service` path with a handle list limited to two pipes;
    - has its own Job cap (for example 512 MiB), counted in admission reservations;
    - has an idle timeout of about 60 s and a maximum lifetime;
    - is killed on case switch, restriction or epoch change.
  - **Text geometry** is a per-page, lazily fetched JSON artifact with quantised coordinates and a size cap, mapped to the extraction offsets that citations use and versioned by extractor. It drives selection, find, and search and citation highlights.
  - **Tiles** use a memory LRU of about 64 MiB for the viewport plus one ring. The disk cache has a per-case size cap and LRU, is served only by opaque id with a containment lookup, and is purged on restriction, epoch change or case close. `render_page` evidence artifacts stay separate from the non-evidence tiles.
  - Exact page offsets, a single observer, at most ±2 decoded pages.
- **Text.** A lazy line-offset index and `read_text_range` remove the 10 MB limit. `VirtualLines` uses `@tanstack/react-virtual`, with highlight, find and `dir="auto"`.
- **Office** (R29). The worker emits a versioned JSON model:
  - DOCX: blocks, tables, comments, tracked changes, headers and footers;
  - XLSX: a sparse grid with formulas, cached values and hidden flags, shown in a virtual grid with A1 locators;
  - PPTX: slides with notes.
  Opening a file becomes read-only: derivatives are queued at import, with an explicit Prepare/Retry action. LibreOffice is out of scope; it cannot run under `ActiveProcessLimit=1`.
- **Email** (R29).
  - EML and mbox via stdlib; MSG via `olefile` plus MAPI.
  - Attachments become child sources with `derived_from`. **Restriction is transitive over `derived_from`.** An attachment that dedupes onto an existing unrestricted source needs confirmation. Recursion depth, count and size are capped.
  - HTML is sanitized with `nh3` in the worker and rendered via `srcdoc` in `<iframe sandbox>` (no scripts, same-origin, popups or top-navigation) with a `csp` attribute. Remote content is blocked and a notice is shown. Narrow `frame-src` in `tauri.conf.json` to what is used.
  - Tests:
    - a remote `<img>` or CSS `url()` makes no request;
    - meta refresh and form submit do nothing;
    - the iframe cannot reach `__TAURI_INTERNALS__` or `ipc.localhost`.
- **Images.** Decoder-only `pillow-heif`, the RAW embedded preview, multipage TIFF, and an explicit EXIF orientation view.
- **Media.**
  - Waveform peaks come from the existing `full_audio` or `media_inventory` decode pass, not a new full decode.
  - One time-aligned lane view (waveform, transcript, speakers, sound events, scenes) replaces the four stacked panels, with SoundDiscovery moved there.
  - A media clock store with binary search. `,` and `.` step exact decoder frames when paused.
- **Search hits** open at the exact page with a bbox or line highlight. Add a server-side transcript search.
- **Keyboard.** A `useViewerKeymap` hook (paging, zoom, pan, Ctrl+F, Ctrl+Tab), plus an accessibility plan for the new surfaces (lanes, grid, uncertain-word navigation, review queue) under R21.
- **Redaction scope (R18).** Only PDF and images can be redacted. Office, email and HEIC show "not redactable yet". Add coordinate and hidden-content tests for the new adapters.
- **Typography**, proposed to the lead as tokens:
  - Inter subset, with `cv05 cv08 zero`;
  - `--font-reading`: Source Serif 4 at 16–17 px, line-height 1.6, 72ch, with a sans toggle;
  - bundled Cascadia Mono for hashes, IDs and timecodes;
  - `--numeric: tabular-nums slashed-zero`;
  - a CJK/Arabic/Thai fallback stack;
  - fix the legacy sub-11.5 px sizes;
  - `--confidence-low` (underline plus icon).
- **Later (Wave E):** a pop-out viewer or transcript window for dual monitors. This needs capability and protocol-origin changes.

---

## Phase 4: AI providers (R19, R26, R27)

- **Wave A (behaviour-preserving).**
  - Surface a mid-stream `error` chunk or `finish_reason:"error"` verbatim, bounded (~594).
  - Refuse `:online` suffixes **and** search-native families (perplexity/sonar, `*-search-preview`) in `validate_model`/`select_profile` at send time. Never emit `plugins` or `web_search_options`.
  - **Cost capture:**
    - persist the first chunk's `id` immediately in `transmissions.usage` while the row is pending;
    - keep `usage.cost`, cached tokens, reasoning tokens and the upstream provider;
    - write `transmissions.actual` and sum it per task;
    - add an optional Task DTO `cost`, shown as "not reported" when null.
  - Optional `X-Title: VisLex` and a fixed `HTTP-Referer`, never containing case identifiers.
- **Policy (R26).**
  - `OpenRouterPolicy` with a hand-written `Default` of `zdr:true`. `data_collection:"deny"` is not configurable.
  - Validated `order`/`only`/`ignore`, `allow_fallbacks:false` when pinned, and `require_parameters`. `max_price` is a routing filter, not a cap.
  - **Existing users' requests are not narrowed silently.** On save and before a task starts, check the chosen model against the catalogue and show an explicit blocker naming compatible alternatives. Add a harness journey for a previously saved non-ZDR model.
  - The frozen `teams::policy(case, task)` is passed into `encode`; nothing reads live config mid-task. Audited.
- **Catalogue.**
  - `input_modalities`/`output_modalities`, `supported_parameters`, `context_length` and `pricing` replace the substring filter (~903).
  - Cached per app, never in cases.
  - The ":free" badge becomes "compatible with no-retention policy".
- **Credits and backfill.**
  - `GET /api/v1/key` shown read-only.
  - The `/generation` backfill runs only for rows with a stored id, through `catalogue_client` (no redirects, bounded).
  - `actual` is marked `reported_after_cancel`, and a set value is never overwritten.
  - **All new app-level network calls honour offline mode.**
- **Reasoning and context.**
  - Normalise `vendor/model` ids (`agent.rs` ~1415/1446) and map `reasoning:{effort}`, preserving `reasoning_details`.
  - Derive the history trim budget from the catalogue's `context_length`, not the fixed 100,000 bytes.
  - Keep a **stable cached prefix** (instructions, tools, initial request) and trim in large steps after the cache breakpoint. Add `cache_control` for `anthropic/*` and `google/*`.
  - Large-case agent test: bounded request size and a stable prefix.
- **Modality grants.**
  - `input_audio`, `video_url` and file grants live in **case-only meta**, like `gemini_direct_media`, and never on `Profile`. `apply_app_settings` copies `Profile.allow_*` from app defaults.
  - Avoid `body.clone()` of base64 payloads.
- **Generic OpenAI-compatible endpoint (R27).**
  - `endpoint_id` is derived from the normalised origin (scheme, host, port, path prefix). The credential is stored as `endpoint:<id>`; **changing the origin deletes the key** and resets `allow_text`/`allow_images`, with an audit entry.
  - Grants and pool profiles are keyed on `(provider, endpoint_id, model)`. The origin is frozen in `task_profile`, and a send is refused if it differs. The origin is recorded in the transmission.
  - Plain HTTP is allowed only for the literal addresses `127.0.0.1` and `::1`. Userinfo, fragments and non-loopback private IPs over HTTP are refused. No redirects. No `Authorization` header is sent to loopback unless the user sets a key. The per-case text grant is still required. Local endpoints are labelled "user-declared local", not "on-device".
  - OpenCode Zen: only its `/chat/completions` models. Free models are blocked, and OpenAI/Anthropic via Zen are labelled as having 30-day retention. **OpenCode Go is excluded** by its terms.
- **Tests.** Policy encoding, the frozen policy surviving a config change, `{}` and legacy config deserialising to `zdr:true`, search-model refusal, error chunks, cost passthrough and backfill (cancel after or before the first chunk), modality gating, and an OpenRouter twin of the Gemini `prepare_request` test. Endpoint tests: an origin change leaves no key or grant, `http://localhost.example` and `http://10.0.0.1` are refused, and a 302 is not followed.

---

## Phase 5: "Second opinion" add-on (R28; optional, off by default, human-confirmed)

With no key or grant, the app is unchanged. The local triage queue is still useful on its own.

1. **Triage.** New module `src-tauri/src/escalation.rs`, local and without network, run after `publish_staged_transcript` and `discovery::store_chunk`.
   - Risk score:
     - f1 `sigmoid((-1-avg_logprob)/0.25)`;
     - f2 `no_speech_prob` when the text is non-empty;
     - f3 compression ratio 1.8→2.4;
     - f4 share of words with p<0.5;
     - f5 lowest word probability, weighted ×2 for digits, names and negations;
     - f6 temperature fallback;
     - f7 words per second outside 0.5–6;
     - f9 low `language_probability` or a language change between chunks;
     - optional f8, tiny-vs-small disagreement, run sequentially on flagged spans only.
   - Also flags diarization overlap and short turns, transients with no transcript, low-score OCR blocks, and discovery failures.
   - Thresholds come from conformal risk control on **synthetic** data. Scores are shown as diagnostics, never percentages. Spans go into `uncertainty_spans` (v9).
2. **Clip derivative.** Worker kind `media_clip`, using the read-only lease, and **heavy until measured**.
   - Merge gaps under 1.5 s, pad 0.5 s, snap to low energy, never cut inside a word, and cap at 30 s.
   - Audio: 16 kHz mono FLAC or WAV. Video: ≤720p, 1–2 fps, ROI crop, capped decoder threads, downscaling during decode. Stills: PNG.
   - Metadata is stripped with `-map_metadata -1 -map_chapters -1 -fflags +bitexact` plus the bitexact codec flags and SEI stripping, then verified with ffprobe. Uploads use a constant filename such as `clip.flac`.
   - Records the parent sha, clip sha, origin offset, encoder args and worker version.
   - **Clips are always included in backups**; they are excluded only from disclosure exports.
   - Add `audio/flac` and `audio/wav` to the registry, together with the 0.4 restore fix in the same release, and to the protocol playback allowlist.
3. **Grant.** Case-only meta `second_opinion`: `{vendor, endpoint, model, modalities, max_clip_s, revision}`.
   - Audited and never inherited from app defaults. Revoked by offline mode. Independent of `gemini_direct_media`, which is untouched.
   - **Restricted sources, and descendants of restricted sources, are never escalated.** Checked at preview and again at send.
   - A **"privileged" flag** is defined concretely: a v9 source flag or privilege label, checked everywhere `restricted` is.
4. **Preview, confirm, send.**
   - The preview shows clip count and seconds, estimated tokens and cost (±30%), the recipient chain (OpenRouter → upstream, or OpenAI direct), the ZDR status, per-clip play and checkboxes, and each vendor's retention disclosure. OpenAI keeps data up to 30 days unless the org has ZDR.
   - It carries this disclosure: **cancelling may not stop billing on Google, Groq, Bedrock or Mistral upstreams.**
   - ZDR is shown only where it is actually enforced for that endpoint. Otherwise the send is refused or needs explicit re-consent.
   - The single-use `preview_id` is persisted in the database and bound to `case_id`, session epoch, grant revision, endpoint, policy hash, clip shas and restriction state.
   - At send, re-read each clip through strong `processing::artifact` and recheck restriction.
   - Rust sends; the sandbox never gets network access. Requests go 2–3 at a time and can be cancelled.
   - **Usage accounting:** a task row with `mode='escalation'`, excluded from the chat list, auto-review and the continue/pause paths. The `transmissions` rows then satisfy `task_id NOT NULL`, and a v9 `escalations` ledger links clip to request to result. Usage totals in the UI and in reports include escalation usage.
5. **Vendors (v1)** behind `RemoteMediaTarget`:
   - OpenRouter `/api/v1/audio/transcriptions` (Whisper-large-v3 class);
   - OpenRouter chat `input_audio` to Gemini-class models (foreign language, faint sounds);
   - OpenRouter `video_url` base64 to Gemini with fps 2–5, with Qwen3-VL as the second opinion;
   - direct OpenAI `gpt-4o-transcribe` with logprobs;
   - still frames to a vision model.
   Later: fal.ai SAM 3 tracking, shown as overlays on exact local frames and never as identification, and ElevenLabs Scribe v2. Built-in guards for Deepgram and AssemblyAI if they are ever added. Gemini free-tier keys are refused.
6. **Results.**
   - **Not** added to the shared `evidence::write` allowlist.
   - A dedicated `evidence::write_remote_interpretation` is callable only from the escalation receive path, with the actor taken from the frozen ledger row.
   - `evidence::write` rejects `remote_interpretation` for every other actor on create and on revision, with a server-side kind check in `agent.rs` ~503.
   - Clip-relative times are converted to source times, and out-of-window times are rejected.
   - The review queue reuses the dossier's accept/needs-review/reject vocabulary, with a word-level diff, clip playback and ±5 s playback from the original.
   - A human decision creates a human-attributed correction citing both machine texts. Agreement between the models is never auto-accepted.
7. **Agent.** A `propose_escalation` tool only records a suggestion; sends are always human-confirmed. Excluded from the Codex route.
8. **Evaluation (R22 format, under `benchmarks/`).** About 500 synthetic clips, split 60/20/20. Measure WER and critical-token error, risk–coverage and AUROC, cost per hour, realised versus target α, and a small reviewer acceptance study.
9. **Security pass (R24)** over the new IPC actions and tools before release: permission matrix and prompt injection.

---

## Phase 6: Workflow features from the best apps (R17, R31, R32)

**Prerequisite:** R18 (redaction and disclosure boundaries) comes before any new export type. Define three export types, each with a manifest: archive, reviewed work product and sanitized derivative.

- **P0 Chronology.** A work product with date, date precision, event, people, issue and citations, plus a timeline view. AI proposes rows and a human approves them.
- **P0 Chain-of-custody and processing report.** Compiled from the audit chain, occurrences, derivatives (worker, model, version, settings), reviews, transmissions including escalations, exports and the verify result.
- **P1 Question grid.** Cells are pinned to a revision and sha and stay proposed until approved, with per-cell usage and cancel. It runs locally without a grant and is batched via `job_schedule`.
- **P1 Clip designations and reels.** Exported as sanitized derivatives with a manifest.
- **P1 Near-duplicate and thread grouping.** MinHash/SimHash plus a perceptual hash. Groups are "related, not merged".
- **P2 Entity mentions.** Regex first, then an optional ONNX NER model under 100 MB, with human-confirmed person resolution.
- **P2 Saved searches, hotkey tags and keyboard review.**
- **P3 Privilege log and Bates on exports only.** No DAT/OPT load files.

---

## Phase 7: Remove redundancy and headaches

**Delete, porting tests first**
- The unreachable `export_redaction` arm (`desktop.rs` ~1016).
- The legacy OpenAI-only key commands and `key_entry`. Pin the credential-name test and update `native-integrity-acceptance.js` ~45. The `bridge.ts` demo change goes in the batched lead commit.
- `WorkspacePreferences.tsx`, with the lead's approval.
- The dead publishers (`transcription::publish`, `automatic::publish`, `discovery::publish`, `publish_prepared`), **after** porting their invariant tests (cancel-before-publish, 1450 handling, transcript backup symmetry) to the `publish_staged*` paths.

**Debug-gate**
- `extract_history`, `evidence_search`, `processing_recovery`, `read_coverage` and `transcript_segment_detail` (unless word confidence reuses it).
- `video_discovery_status`, after updating `native-acceptance.js`.

**Merge**
- Forward `save_settings` and `save_ai_config` through a shim to the `save_ai_settings` shape. Decide explicitly whether preemption applies, then re-run `native-provider-race` and `native-concurrent-chats`.
- One refresh mechanism, through `caseEvents.ts` and the lead. Stop the pollers that keep running after work is done (FullTranscript 2 s, VideoDiscovery 4 s).
- One playback path.
- One per-kind descriptor table in `processing.rs`/`sandbox.rs`.
- One external-content FTS index (v9+ migration, rebuilt outside the lock with progress).

**Codex route flag-off (R20)**
- A Rust const or build flag, not a renderer-savable field.
- `case_access_route` returns `Unavailable`. All five sites (`case_access_route`, `start_task`, `continue_paused_task`, `run_session`, `start_automatic_review`) fail with the explicit blocker.
- Running subscription tasks pause with that reason.
- The `codex_account_*` actions and `set_ai_access_route(chatgpt_subscription)` are refused.
- Old meta and transmissions rows are preserved.
- Test: a case with `ai_access_override=chatgpt_subscription` **and** an API key makes zero provider calls and shows the blocker.

**Deletion and retention**
- A "purge derivative bytes" action (diarization embeddings, clips, preview cache). It keeps the hash, writes a tombstone audit entry, and makes citations fail explicitly.
- Per-case retention settings. Vendor retention and ZDR status recorded in the escalation ledger.

**UX simplification** (lane and lead decisions)
- One "Copy citation" action.
- Move the video-discovery sampling knob to advanced settings.
- Media lanes.
- Layout presets instead of focus mode, sidebar toggle and pane persistence.

**Housekeeping**
- Prune pre-migration snapshots to the latest 2–3 and show them in storage usage.
- After the design workflow integrates: archive about 20 historical docs with `git mv` to `docs/archive/<date>/` plus an `INDEX.md`, and rewrite `AGENTS.md`/`CLAUDE.md` to point at the live set.
- Put the native scripts on the raw-CDP runner and delete `test-native.ps1` and `native-smoke.js`.
- Packaging: a docs allowlist and a derived version string. Keep the app identifier.

---

## Distribution, onboarding and scale (R25 and product completeness)

- **Offline model packs.** Hash-pinned and signed. Importable from a file and verified in Rust against a committed manifest, with licence notices. Never downloaded by the worker. The base installer keeps tiny and small.
- **Signing and updates.** Authenticode for the app and the worker exe, which also reduces Defender and AppContainer friction. An update channel with a pre-migration snapshot and a documented downgrade path.
- **First-run onboarding** (content for the lead's onboarding surface): what is local versus remote, provider and key setup, model-pack import, and a SYNTHETIC sample case.
- **Backup UX.** Size preview, verify-after-backup and optional reminders.
- **Scale targets** at the R23 tiers (25, 250 and 1000 files; up to 1000 h of media): throughput and RTF per tier, queue-time estimates and resume after sleep, all in `perf-budgets.json`.
- **Localization.** Extract UI strings, and check RTL layout of the app shell later (lead-owned).

---

## Coordination with the design session

| Functional deliverable | Seam | Waits for |
|---|---|---|
| Ownership of Rust, DTOs, `bridge.ts`, lock, NEXT-STATUS | `SEAMS.md` handoff (0.0) | Lead acknowledgement |
| Codex blocker payload | Rust payload shape, sent to settings lane | Before settings lane merges |
| Preview registry, text layer, lanes | `<PreviewHost>` mount; `overlay` render-prop on PDF page | Viewer lane |
| Word confidence | `src/api/transcript.ts`, `segment_words`, `--confidence-low` token | Viewer lane + lead |
| OpenRouter policy, credits, second-opinion grant and queue | `src/features/{openrouter,escalation}/*` panels mounted in the settings sections the lane defines | Settings lane |
| Cost display, escalation cards | Optional Task `cost`; assistant writer renders | Assistant lane |
| Case store, pagination key, Jobs queued reason, polling | `src/state/caseStore.ts`, `caseEvents.ts` extension, `App.tsx` adoption | Lead |
| Typography tokens | Token proposal | Lead |
| Harness fixtures | `src/api/actions.json` manifest → harness owner | Harness lane |

## Sequencing

| Wave | Contents |
|---|---|
| **A** | 0.0 ownership handoff and Codex decision delivery; 0.1; 0.2; 0.4; 0.5; Phase 4 Wave-A items |
| **A0** | Verify R08–R11, R13–R16 and R19 on the trunk |
| **B** | P1 #1, #2, #2b, #5 (publication triggers only), #6, #7 (`listing_version`), #11, #12; Phase 2 signals and language hint; word-confidence backend; Codex flag-off in Rust |
| **C** | P1 #14 (lease), #3 (flagged), #3b, then #4; #8, #9, #10, #13; Phase 2 VAD, OCR A/B, playback, search scale; Phase 4 policy, catalogue, generic endpoint; Phase 5 triage, clip, grant, ledger backend; purge action; diagnostics |
| **D** | After the lanes merge: Phase 3 preview UI, R18, Phase 5 preview and review UI, the Jobs queued reason, pagination adoption, Phase 7 UI items, onboarding content |
| **E** | Phase 6; model tiers after R22 and `perf.json`; FTS consolidation; model packs, signing and updates; doc archive; pop-out windows |
| **Last** | R23 release gate |

## Verification

- **Linux cloud, every slice:**
  ```
  npm ci && npx tsc -p tsconfig.json --noEmit && npx vitest run && npx vite build
  PW_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 npx playwright test
  python -m unittest discover -s workers -p "test_*.py"
  python -m unittest discover -s scripts -p "test_*.py"
  python -m unittest discover -s benchmarks -p "test_*.py"
  RUSTUP_TOOLCHAIN=stable cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu
  python scripts/vislex_plan.py check
  ```
  The `PW_CHROMIUM_PATH` value is local; CI uses `playwright install`. The cargo line applies after the `worker_video_e2e` gating.
- **Windows Tier 1/2:** `cargo test --locked`, clippy, `check --features desktop`, `build-worker.ps1`, `cargo test --test sandbox -- --include-ignored`, the native CDP journeys (acceptance, integrity, large-session, provider-race, consent, protocol-origin), and `perf-run.ps1` on R8 and R16.
- **Named guard tests** are listed per item in the Phase 1 table, Phase 4, Phase 5 and Phase 7. They include tamper detection on protected paths, switch races, pagination, cross-job isolation, staleness, the forged `remote_interpretation` refusal, endpoint key binding, email iframe isolation, and backup/restore of clips.
- **Accessibility:** axe checks at 1366×768 and 1920×1080, light and dark, reduced motion, keyboard-only, plus scripted checks on the new surfaces.
- Record real evidence in `NEXT-STATUS.json` through its single writer. Nothing here certifies legal accuracy.
