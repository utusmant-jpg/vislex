# Changed-file review register

Code base: `485882149585a1f2db34f1e7e9c29226758ba039`; comparison base `9916bb9e0286bd6871d56c8873f62276affc42b2`.

Every one of the 27 changed path entries was reconciled individually. **F** means full current returned text read; **H** means changed hunks and/or relevant ranges/callers read, NOT the entire file. **M** means metadata comparison only. A static read is not execution, exhaustive path analysis or approval. No file is marked verified here.

| Changed path | Read scope | Recheck / owning packet |
|---|---|---|
| README.md | H: changed policy paragraph plus previous complete README | Existing permissions language and direct-media UI mismatch; R04/R23. |
| docs/GLM-IMPLEMENTATION-PROMPT.md | F | Replaced by current concise entrypoint; old version remains in Git history. |
| docs/VISLEX-ULTRA-IMPLEMENTATION-PLAN.md | F: 1–515 | Preserve product intent; not the execution queue now. |
| docs/implementation/LEDGER.md | F | Historical reported tests; do not relabel as independently rerun. |
| src-tauri/Cargo.toml | F | Added duplicate dev dependencies for archive tests; no stack change required. R00/R25. |
| src-tauri/src/artifact_registry.rs | F | PDF support valid; version enforcement/consumer consistency R01/R18. |
| src-tauri/src/authority.rs | F | Verified-byte ingress and extraction registration improvement. R17/R24. |
| src-tauri/src/automatic.rs | F | Incomplete input fingerprint/idempotence/state; R05. |
| src-tauri/src/backup.rs | F | New duplicate transcript paths; R01. |
| src-tauri/src/case.rs | H: migration, import/extraction/history/read, citation and export; prior unchanged core context | History preserved but ordinary locators active; R02. Strong verification/snapshots later. |
| src-tauri/src/desktop.rs | H: create/open/restore patch, new history commands, related dispatch/runtime from prior identical sections | Reopen fixed; actual UI/grants and session-fenced commands R04/R08. |
| src-tauri/src/dossier.rs | H: complete new coverage helper/completion path, prior candidate/review context | Token/citation heuristic unsafe as a gate; R03. |
| src-tauri/src/evidence.rs | H: changed text-locator validation | Historical existence + active bounds mismatch; R02. |
| src-tauri/src/exports.rs | F | Good currentness/review rechecks; hash/receipt pinning and lock scope R07/R09. |
| src-tauri/src/lib.rs | F | Registry module exported; no defect inferred. |
| src-tauri/src/processing.rs | H: changed registry and extraction publication, prior full unchanged execution/publication context | Preserve supersession; staged input and publication locks R09/R10. |
| src-tauri/src/providers.rs | H: check_permission and complete apply_app_settings; prior adapter context | Case image gate improved; save still forces grants/review R04. |
| src-tauri/src/transcription.rs | H: actual output registration and changed extraction publication; prior full module context | Proves duplicate backup shape; long output/storage R01/R12. |
| src-tauri/tests/backup_artifacts.rs | F | Synthetic transcripts are not registered as production artifacts; R01. |
| src-tauri/tests/core.rs | H: new context/permission/automatic tests and local callers | Some direct state mutations bypass orchestration; R04/R05. |
| src-tauri/tests/dossier.rs | H: authority, export-race and new coverage tests; returned tail complete | Instrument-log test encodes weak gate; strengthen R03, retain export negatives. |
| src-tauri/tests/extract_revisions.rs | F | Does not test old-range bounds; migration fixture already contains new table. R02. |
| src-tauri/tests/journey.rs | F | Valuable native-text core journey, not desktop/media acceptance. R00/R23. |
| src-tauri/tests/master_v4.rs | H: permission/config/automatic changed expectations, reported migration delta and setup | Review-mode reset is asserted; replace with justified stronger policy tests R04/R05. |
| src/components/AgentPanel.tsx | H: full attachment patch, prior complete component | Null attachment fix connected; stream/windowing and selection issues separate R06/R16. |
| src/viewerContext.test.ts | F | Suppression coverage good; range-overwrite test needs revised contract R06. |
| src/viewerContext.ts | F | Suppression fixed, explicit range priority/epoch missing R06/R08. |

## Additional current unchanged paths inspected or reconciled

- Full current reads: `src/components/SettingsDialog.tsx`, `src/components/EvidenceViewer.tsx` (all ranges), `src/components/FullTranscript.tsx`, `src/bridge.ts`, `src/markdown.tsx`.
- Selected current read: `src/components/InvestigationWorkbench.tsx`; confirms it imports/renders QuestionDossier and already supplies discrepancies, coverage, replay and work-product launchers. Do not implement a duplicate workspace.
- Identical-blob prior source inspection used for specific findings: `src/App.tsx`, `src/components/RecordEditor.tsx`, `src-tauri/src/semantic.rs`, `src-tauri/src/discovery.rs`, `src-tauri/src/sandbox.rs`, `src-tauri/src/coverage.rs`, relevant `agent.rs` paths, workers/full_audio.py, worker.py, video_discovery.py, sound_events.py and redaction.py. Reuse supports the stated unchanged logic, not a fresh whole-file review claim.
- Unchanged subtree hashes were compared for workers, scripts, benchmarks, fixtures, configuration and generated assets. Hash equality does not mean unreviewed source was semantically checked.

## Remaining coverage rule

Run `python scripts/vislex_plan.py inventory` locally to obtain the COMPLETE Git-index path/blob inventory, including generated/binary paths not fully returned by the connector. It emits JSON to stdout and does not inspect or transmit file contents. Capture it outside the tracked source tree or under a local ignored verification directory. Record `git status` separately because index metadata is not the working tree.

For each source/config/test before modification: read complete content plus direct consumers, note blob and inspected ranges, map a task, and record actual execution separately. Regenerate metadata only when HEAD/index changes; do not charge the model to reread unchanged files per agent. At R23, explicitly close outstanding source/config/test coverage; binaries/fixtures require format-specific checks and generated artifacts require generator/provenance checks. Do not mark them 'read line by line'.

This register intentionally does not claim the whole repository was fully audited. It prioritizes production-critical paths and every changed entry, and tells the next agent exactly which review gaps remain.

## CAI isolated implementation review (2026-09-28 Toronto)

Base `2ebc7addc4531caccfecadfd63525b08b56a0a02`; tested code head `e4179e4ef250b7d3df063da809dc33a7276b2771`, branch `codex/case-intelligence`. H denotes selected current functions/diff hunks/direct callers, not a fresh full-repository audit. Incremental unchanged source context was reused. Blob IDs identify the reviewed snapshot; they are not semantic verification. Execution evidence and unrun gates are in CASE-INTELLIGENCE-HANDOFF and NEXT-STATUS.

| Current path | Git blob at tested head | Read scope / packet |
|---|---|---|
| `src-tauri/src/intelligence.rs` | `4863a98a42a82a2c276d9287cd13a26522f30bc1` | H: migrations, source/unit stamps, host inventory, scheduler, input/receipt publication, bounded synthesis, scoped retrieval/status, controls; new module and adversarial reviewer passes. CAI-02 through CAI-06. |
| `src-tauri/src/agent.rs` | `18c4c301adbd24ed8d5f0ef61ea4c89e7ce3e5fa` | H: catalogue/execution parity, both route contexts, internal tool handling, exact candidates, live authorization, receipt persistence. CAI-01/03/06. |
| `src-tauri/src/desktop.rs` | `1f13f9f771ac517ffff93e77310d1ce95c564963` | H: dispatcher mutation wake-ups, model selection, native subscription/API cancellation, internal scheduling and commands. CAI-03/06/07. |
| `src-tauri/src/automatic.rs` | `f638b6d85e314a1e3d05bb8448666fe3f3fc35c6` | H: preparation result metadata, legacy status bridge and current scheduler callers. CAI-03/04. |
| `src-tauri/src/case.rs` | `ae75dadf7cee4afb497d3839ff68b8c55619c949` | H: additive migration hook, snapshot/task page/conversation visibility and source/citation/current-revision callers. CAI-02/07. |
| `src-tauri/src/dossier.rs` | `425a5457a578c8a9411f0a585ae8f505a929ac96` | H: exact candidate support/publication callers and shared block rendering. CAI-06. |
| `src-tauri/src/processing.rs` | `99d863ca8e69cc7c12dc5dee7666e09d566b6795` | H: readonly source lease selection, processor normalization, artifact and prepared/staged publication. CAI-04. |
| `src-tauri/src/review_progress.rs` | `f5c46a0e3c0719378443f8cd4b58d5b946514ceb` | H: duplicate receipt comparison and retrieval callers. CAI-01/06. |
| `src-tauri/src/lib.rs` | `3dfb98ea584375a88760bdb608e4d85b4a4e7e7d` | H: new module export. CAI-02. |
| `workers/worker.py` | `4287bf8b4c53e1ccc7cccc31d37bd4d93257cbd1` | H: readonly input selection, physical image frames, bounded Office package-image extraction and request handlers. CAI-04. |
| `workers/full_audio.py` | `b02cfd5a8e8bfa92c70a9b15ca8529698926cdf1` | H: verified decoded-track channel metadata publication and existing transcript output. CAI-04. |
| `src-tauri/tests/case_intelligence.rs` | `7eed718c48c7f2bf9e54559f1dc20e9b0af7125a` | H: all new regression families, production agent receive/publication/review helpers, legacy metadata fixtures; current 25 executed. CAI-01 through CAI-08. |
| `src-tauri/tests/core.rs` | `8cd850121d257ab4287a15d7c04fbd521b2bd89d` | H: changed automatic reasoning expectation and existing duplicate-read/permission/recovery callers. CAI-03/06. |
| `src-tauri/tests/dossier.rs` | `93de6e0b94f5f70f675c347b4361cdfb8216bc58` | H: changed plain-render assertions and support-review/publication regressions. CAI-06. |
| `src-tauri/tests/sandbox.rs` | `956750648a363277ba7dec7d73c2ccb3d891a949` | H: new physical/embedded-image and dense-video lease tests plus actual native worker invocation; all 28 ignored checks explicitly executed. CAI-04/08. |
| `src/App.tsx` | `a50a372f974b5460cc381c535629a01723ae4a63` | H: JobsCenter analysis controls, captured case guards, case status and effective model footer; direct API/type consumers. CAI-07. |
| `src/App.test.tsx` | `752c4f58eb847976c0f686c4d451aaa5d7812bd9` | H: control interaction and blocked-analysis regressions. CAI-07. |
| `src/types.ts` | `e6dd25f232300be333f8ad9e89bb538447f1a4bf` | H: analysis/effective-model snapshot DTO additions. CAI-07. |
| `src/chat/activity-summary.ts` | `d123b9daa2992c31cdbd3ed7e119dffda3ece334` | H: original-source identity aggregation and changed tool labels. CAI-07. |
| `src/chat/activity-summary.test.ts` | `e1269082cbd9fc556a26f95c8474a5524343d2e8` | H: distinct-source regression and direct trace callers. CAI-07. |
| `scripts/generate-fixtures.py` | `9f3d87a0f2c4d098ef2e574e24bed86cc2143c2c` | H: deterministic dense-video, embedded-image and physical TIFF generation; generated timestamp drift on old Office fixtures restored to their exact base bytes. CAI-04/08. |
| `scripts/native-intelligence-acceptance.ps1` | `4783af00c82d619b2e5fdbb56944bcaaf41d3239` | F: complete new isolated debug/native lifecycle harness; runs own mock/app, profile and defaults only. CAI-08. |
| `scripts/native-intelligence-acceptance.js` | `be429f9d4f904d015ed2aed340a3ffbf58f90988` | F: complete new native command/proof/edit/control acceptance fixture. CAI-08. |
| `scripts/native-intelligence-cdp.mjs` | `3ad2012edd5fa9202366043b885d28475fddd9ee` | F: complete new fixed loopback fixture controls through CDP; application CSP unchanged. CAI-08. |
| `scripts/native-intelligence-mock.mjs` | `7d4a3fc44d3a140cc37c8bebf9ea1e0730629a83` | F: complete new synthetic provider fixture; no real credentials/evidence. CAI-08. |

Synthetic binary fixtures (`dense-timing.mp4`, embedded-image DOCX, single/multipage TIFF) were checked by format-specific real sandbox jobs, provenance metadata, decoder timestamps and immutable-original hashes, not claimed as text reads. Generated Tauri schemas had no semantic Git diff and were not independently audited. Ignored worker/model binaries were rebuilt and exercised in AppContainer; the native debug EXE and worker hashes are recorded in the handoff.

A separate read-only reviewer agent performed adversarial diff passes. Eight concrete issues (dependency overflow, live revocation, human-edit wake-up, physical images, tool parity, scoped historical metadata, channel uncertainty and correction invalidation) were addressed with regressions. The final bounded pass found no remaining concrete blocker in those fixes; it did not run tests or certify release/legal accuracy. Current execution evidence remains the owner's responsibility.
