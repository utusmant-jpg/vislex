# VisLex implementation ledger

Execution record for the VisLex ultra plan (docs/VISLEX-ULTRA-IMPLEMENTATION-PLAN.md).
This file records what was actually done, verified and not verified. It is not a roadmap.

Statuses: PASS / FAIL / BLOCKED / NOT RUN.

## Baseline (2026-09-21)

- Branch `glm/vislex-ultra` cut from `origin/main` at `5fcff7d` (plan upload).
- Frontend `npm test`: PASS 13/13. `npm run build`: PASS.
- Rust `cargo test`: PASS, all non-ignored suites, exit 0.
- Sandbox suite (`--ignored`, 21 tests): NOT RUN — requires packaged worker.
- Worker/benchmark python suites: NOT RUN at baseline.

## Tickets executed

### VL-001 — protected journey gate — PASS
- `src-tauri/tests/journey.rs` (4 tests): import → process (native text
  extraction/indexing) → search → exact citation → source-linked finding →
  human review → pinned export → restriction propagation → encrypted backup →
  restore → reopen. Hash/restriction/review/audit integrity across the loop;
  tampered archives and restore-into-existing-folder fail closed; reopened
  cases keep their own policy shape.
- Worker-bound media processing is covered by the sandbox suite (NOT RUN here).

### VL-003 — viewer-context suppression — PASS
- Defect: the composer's "do not attach" toggle only dropped page/playback
  enrichment but still sent the viewer_context object.
- Fix: `buildViewerAttachment()` (src/viewerContext.ts) returns a null payload
  when suppressed; AgentPanel sends it. Backend regression proves a null
  context adds no workspace-view history entry while the source remains in
  case scope. 7 frontend unit tests + 1 backend test.

### VL-004 — public-authority ingest — PASS
- Defect 1: `authority::publish` staged downloaded bytes inside case staging
  then called `import_files`, whose case-internal guard rejected the import —
  every authority retrieval failed ("Query returned no rows" downstream).
- Defect 2: structural HTML text was never searchable (importer's empty FTS
  row made the adapter's `if !indexed` guard skip insertion).
- Fix: `PreparedImport::from_verified_bytes` narrow trusted-ingest (never
  accepts an external path; user import guard unchanged — regression asserts
  the case database import still fails) + FTS row replacement.
- Provenance (URL, retrieval time, original hash) retained.

### VL-005 — backup/restore artifact symmetry — PASS
- Defect: restore hard-coded [json,jpg,mp4], so redaction PDF artifacts could
  be backed up but never restored. Transcripts were accepted by restore but
  never written by backup (dead acceptance path).
- Fix: `artifact_registry` module — single versioned contract (json/jpg/mp4/
  pdf) used by publication and restore; backups now include hash-verified
  working/transcripts files; manifests record artifact format version.
- Tests: every format + transcripts round-trips; reviewed redaction PDF still
  exports from a restored case and refuses export after post-review tampering;
  unknown formats, unsafe paths (raw-header crafted archives) and tampered
  hashes all fail deliberately.

### VL-002 — durable case-level AI/cloud policy — PASS
- Defect: every case open/restore re-applied app defaults, forcing the case
  online with text+image+direct-media transmission enabled; pool-profile
  image grants were not gated by the case-level image grant.
- Fix: defaults initialize new cases only; `check_permission` enforces the
  case-level image grant for every profile; direct media is never enabled
  implicitly (separate explicit per-case opt-in); README updated.
- Tests: pool-profile dispatch blocked after case-level revoke; direct-media
  revoke blocks an existing task's dispatch; defaults never enable direct
  media. Two master_v4 expectations strengthened to the plan's invariants.

### VL-006 — exports pinned to the reviewed snapshot — PASS
- Defect: dossier publication re-checked only restrictions, so late evidence,
  withdrawn reviews or revised dossiers could silently publish.
- Fix: `publish_dossier_bundle` revalidates view staleness, dossier revision,
  per-claim current human acceptance, and per-copy source/artifact hashes;
  document exports pin dependency hashes at preparation and reverify.
- Tests: 4 TOCTOU regressions (late evidence, withdrawn review, revised
  dossier, revised draft) fail closed with nothing published.

### VL-007 — automatic analysis state machine — PASS
- Defect: the inventory fingerprint was written when the automatic AI task was
  created, so paused/crashed/failed reviews counted as completed analysis.
- Fix: persisted states (planned/running/paused/failed/complete) with live
  reconciliation; completion fingerprint written only after observed success;
  dispatched-inventory fingerprint per task; chat-preempted reviews resume the
  same task while user stops/interruptions stay down; uncertain transmissions
  are never silently replayed.
- Tests: fingerprint absent at dispatch; uncertain delivery blocks resume with
  no duplicate; resume semantics; completion writes once; changed inventory
  plans a fresh review.

### VL-008/009 — structural claim-support coverage — PASS (bounded scope)
- Replaced the brittle verbatim-proposition gate in `dossier::completion` with
  sentence-level structural coverage: material factual sentences must map to an
  assessed claim (stopword-filtered content overlap) or cite dossier-mapped
  evidence; otherwise they stay visibly qualified as gaps. Qualifier sentences
  pass without mapping. Full structured-assertion-block compilation remains
  future work; this delivers the plan's no-unrepresented-assertions invariant
  without the verbatim gate.
- Tests: 3 new coverage regressions (dossier suite 28/28).

### VL-010 — extraction/full-transcript revision consistency — PASS
- Defect: a completed full transcription inserted text only when no extract
  existed (first-wins), so an older partial extraction permanently remained the
  implied active searchable text.
- Fix: schema 6 adds append-only `extract_revisions`; `publish_extract`
  centralizes activation (extracts row = ACTIVE pointer, FTS refresh,
  generation bump, dependent staleness). Full transcriptions always supersede;
  partials never clobber an active full text; historical wording is retrievable
  via `read_text_revision`/`extract_history` (+ desktop commands); `read_text`
  reports the real active revision; text locators validate any recorded
  revision; migration snapshots and backfills.
- Tests: `extract_revisions.rs` (4) + migration expectations updated to v6.
  All suites green (115 tests).

## Verification state at last commit

- `npm run build`: PASS. `npm test`: PASS 20/20.
- `cargo test`: PASS 115/115 across 9 suites.
- `cargo check --features desktop`: PASS, no warnings.
- Sandbox suite (21 worker tests): NOT RUN — requires packaged worker build.
- Worker/benchmark python suites: NOT RUN this session.
- Live-provider tests: NOT RUN (synthetic responses only).

## Next dependency-ready work

1. Security/untrusted-rendering audit.
2. Performance baselines before optimizing (VL-011 staging reuse needs
   measurement first; sandbox suite must run with the packaged worker).
3. VL-012 scheduler/cancellation; VL-022/023 background indexing;
   VL-019-021 snapshot/pagination; VL-024 transcript segmentation.
4. Full VL-008/009 structured-assertion-block compilation if deeper support
   coverage is needed beyond the sentence-coverage gate.
