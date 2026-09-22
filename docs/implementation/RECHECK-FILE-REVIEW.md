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
