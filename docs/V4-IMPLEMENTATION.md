# VisLex V4 implementation ledger

This ledger tracks the user-supplied **VisLex Master Plan V4**. V4 is not complete. The current changes provide a usable foundation spanning provider integration, optional teams, versioned findings, manual clock proposals, and bounded sound discovery. They do not certify legal conclusions, recognize all knocks, synchronize playback automatically, or establish competitive superiority.

## Available in this implementation

- **Settings → AI & protection:** select OpenAI, Anthropic, Gemini, or xAI; store provider keys in Windows Credential Manager; retain the legacy OpenAI credential name. Configure a selected model, single/parallel execution, standard/independent/challenge review, and an optional explicitly permitted assignment model pool. An empty pool uses the selected model and key for every assignment. Switching the selected provider clears the form's modality consent.
- **Agent teams:** three scoped investigation assignments can run concurrently; a separate blind reviewer and optional draft challenger run at the completion boundary. Assignments, provider/model selection, results, errors, and merge markers persist. The lead receives proposals and must resolve disputes through source inspection. Children cannot edit shared findings or working records. Failed assignments remain gaps; no unapproved fallback occurs. Stopping the parent stops child publication. This is an initial bounded collaboration protocol, not the complete iterative V4 challenge engine.
- **Findings & clock proposals:** create and revise separate statements, observations, hypotheses, claims, entities, clocks, issues, authorities, and notes. Source citations resolve using existing adapters. Edits require the current base revision. Exact object dependencies propagate staleness transitively; human review does not transfer to a new revision. Historical content remains available through the read command. Dependency cycles and removal of retained source restrictions are rejected.
- **Clock fit lab:** calculate offset or linear drift from supplied anchors, inspect residuals and held-out checks, and save an unreviewed proposal. Three fitting anchors spanning 60 seconds permit drift estimation. This does not authenticate anchors, accept a mapping, handle resets automatically, or synchronize players.
- **Sound discovery:** decode a selected stream/channel for at most 60 seconds; retain native decoder anchors and an immutable analysis receipt; display waveform peaks, decoder gaps, candidate onsets and clipping. Burst grouping is retained in the artifact. Scores and candidate counts are explicitly uncalibrated. Analysis sample offsets are distinguished from native-file sample locators. Source transcripts are not replaced by sound candidates.
- **Agent tools:** list/read/revise structured evidence, fit clock anchors, and discover sound candidates, in addition to existing evidence tools. Ask mode cannot publish or derive these objects. Agent writes conservatively retain the whole task source scope as permission dependencies.
- **Storage:** additive schema 4 migration with pre-migration snapshots, object/revision/dependency tables, a committed change outbox, permission-filtered lexical search over current extracts/working records/objects, and indexed relations. Existing backups include the new database records. No credentials are stored in the case database.

## Engineering boundaries

The native adapters convert tool messages and results without flattening them into ordinary text. Gemini function-call continuation signatures and Claude native thinking blocks remain adapter-owned history; they are excluded from user-visible conversation retrieval. OpenAI/xAI use SSE; Claude/Gemini currently receive bounded non-streaming responses. Synthetic protocol tests are not live-provider certification.

Parallel **agents** use separate sessions; provider-returned multiple **tool calls** are treated separately. Pure read batches execute serially under existing case protection. Batches containing inspection, mutation, or completion boundaries are returned as tool errors requesting single calls. Duplicate call IDs and duplicate transmission delivery are rejected. Native history compaction retains calls required by retained tool results.

Worker execution has two local slots per application process. Recursive grants/revocations on the shared packaged runtime are serialized within that process. This does not implement cross-process scheduling, GPU resource estimation, or provider-account rate scheduling. Most legacy synchronous analysis tools still hold the case mutex; full transcription and playback already have separate worker paths. Moving every expensive derivation outside that mutex remains necessary.

No automatic retry of an uncertain provider request is introduced. HTTP failures pause the affected assignment, and its results do not disappear. Token prices remain manually entered case-wide estimates; mixed-model, cached-token, and provider-specific billing can differ.

## Requirement traceability

“Partial” means working behavior exists but the full V4 acceptance gate is not satisfied. Schema-only tables are not counted as implemented workflows.

| V4 requirement | Implementation/evidence | Remaining work |
|---|---|---|
| 1. Product decisions and capacity | Existing Windows/local stack retained; default single selected-model agent; optional teams | Full 200-hour/10,000-document lifecycle and all legal workflows unproven |
| 2.1 Responsibility separation | Rust authority, Python processors, React UI, SQLite WAL retained | Unified writer queue and removal of expensive work from all case mutex sections |
| 2.2 Explicit objects | `evidence.rs`: objects, immutable content revisions, dependencies, actor/review/stale columns | Acquisition families, entity mentions/identity candidates, atomic assertions, structured evidence packets and processor manifests |
| 2.3 Location contract | Initial typed locator enum; large sample/PTS values use strings; legacy citations continue | Persisted full union for documents/spreadsheets/email/images, verified stream/sample bounds, extraction revision migrations, printed/Bates labels |
| 2.4 Time reconciliation | Manual offset/drift fit, held-out residuals, range and uncertainty diagnostics | Six-clock records, raw metadata assertions, automatic anchor discovery, robust fitting, alternate alignments, piecewise segments, shared-clock playback |
| 2.5 Coverage and dependencies | Existing durable review ledger; object dependency invalidation; committed object/review outbox | Coverage receipt consumers, inventory/extraction/clock/entity revision propagation, source interval denominators and complete reanalysis scheduling |
| 2.6 Storage/recovery | Original preservation and existing encrypted backup remain; schema backup and restored object tables supported | Crash-safe staged publication across every artifact/index, retained-file manifest policies, tiling, bounded long-media streaming, second-machine restore test |
| 3.1 Native providers | `providers.rs`, desktop credential commands, settings UI; synthetic protocol/continuation tests | Live model capability probes; full modality/retention/region profiles; Claude/Gemini streaming; provider-specific pricing |
| 3.2 Independent settings | Single/parallel execution, selected model/approved pool, three review modes | Explicit provider-model capability evaluation and adaptive routing |
| 3.3 Single-provider path | All four providers independently complete a synthetic text workflow; local processors are provider-independent | Live tool/image investigations with each selected model, missing-modality acceptance fixtures |
| 3.4 Investigation contracts | Task policy/profile frozen at creation; existing durable progress ledger retained | Contract and obligation tables are reserved only; coverage-aware application completion validator and full state machine are not implemented |
| 3.5 Shared coordination | `teams.rs`: scoped private histories, durable roles and assignments, checked merge markers, visible status | Structured proposals/messages with evidence revision snapshots and incremental shared knowledge |
| 3.6 Independent/challenge review | Blind reviewer never receives the draft; critic does; source-based resolution instructions; failures added to final gaps | Independent assessment comparison, machine-validated discriminating checks, iterative evidence-driven rounds and no-progress stopping logic |
| 3.7 Scheduling/recovery | Up to three concurrent investigation assignments; two local worker slots; no unapproved provider fallback; duplicate delivery protection; parent cancellation | Provider-account rate scheduler, bounded backoff, leases/heartbeats, cross-process bounds, resumable child work, deduplication by input/config hash, GPU scheduling |
| 3.8 Processor selection | Existing tiny transcription model retained; deterministic transient baseline added | Evaluate/package the named ASR, diarization, OCR, visual, tracking, embedding and reranking candidates; reproducible manifests |
| 3.9 Four-pass analysis | Existing sampled frames/transcription plus bounded channel-specific transient discovery | Automatic inventory/discovery/targeted/verification orchestration, silent-action discovery, detailed speech alternatives, knock classification/calibration and exhaustive coverage |
| 3.10 Retrieval/tools | New FTS5 index and structured-object/clock/sound tools | Scoped hybrid/vector/multimodal retrieval, rank fusion/reranking, evidence packets, exhaustive enumeration, sandboxed general calculation tool |
| 3.11 Claim verification | Existing citation/support-review boundary plus separate structured claims and optional reviewers | Separate proposition/quote/timing/identity/contrary-evidence assessments and machine-enforced packet completion |
| 4.1 Interface | Compact design retained; team panel; findings/clock/sound inspectors; exact legacy source navigation | Four complete workflow views and synchronized multi-camera viewer, waveform/spectrogram/filmstrip lanes and visible buffering uncertainty |
| 4.2 Corrections/continuity | Versioned object edits and per-revision human review; existing drafts/tabs retained | Split/relabel events, transcript and time corrections, complete invalidation, multi-case background handles, accessibility/virtualization acceptance |
| 4.3 Legal workflow inventory | Existing notes/reports and source-linked investigation remain | Full reconstruction, assertion/statement matrices, discovery/privilege/production, criminal/civil issue analysis, deposition, research, motions, contracts, exhibits and authorities workflows |
| 4.4 Public U.S. legal research | No new research adapter claimed | CourtListener/GovInfo/official sources, jurisdiction/date enforcement, snapshots, quotation/proposition/treatment checks and coverage notices |
| 4.5 Exports/protection | Existing export and encrypted backup paths retained; provider keys separated; request payload hashes use native encoded bodies | Full DOCX/PDF/CSV/JSON/SRT/VTT/exhibit/offline-viewer exports, redaction leakage checks, complete restriction propagation and retention policy receipts |
| 5.1 Delivery order | Working vertical slice across foundations/providers/findings/teams/sound | Stage 0 benchmark program and all stage exit gates remain incomplete; these changes are not a stage 7 release |
| 5.2 Migration/compatibility | Additive v4 migration, backups, preserved OpenAI key name and legacy citations | Resumable backfills, feature flags and documented rollback/restore exercise across real historical cases |
| 5.3 Required tests | Core regression suite; V4 synthetic tests; sound unit/decoder tests; packaged-worker tests | Full crash injection, live provider/outage/rate tests, full legal/security/output tests and independent security review |
| 5.4 Engineering targets | No target claimed met from synthetic tests | Declared hardware/corpus distributions and held-out accuracy, recall, timing, interaction, capacity and storage benchmarks |
| 5.5 Teams/Harvey comparison | No superiority claim | Incident-level splits, blinded reviewers, repeated matched-resource comparisons, confidence intervals, ablations and actual Harvey access |
| 5.6 Definition of complete | Not complete | End-to-end supported evidence-to-output legal lifecycle with one provider, restore history intact, and passing acceptance results |

## Validation commands

Run from the repository root. Commands use synthetic/local fixtures; they make no inference API calls.

```powershell
npm run build
npm test
cargo check --manifest-path src-tauri/Cargo.toml --features desktop
cargo test --manifest-path src-tauri/Cargo.toml
.venv-worker/Scripts/python.exe -m unittest discover -s workers -p test_sound_events.py
# After packaging the worker and generating the existing synthetic fixtures:
cargo test --manifest-path src-tauri/Cargo.toml --test sandbox -- --include-ignored
```

`scripts/verify-v4.ps1` writes command outputs and a machine-readable result manifest to a new timestamped directory under `artifacts`. The browser screenshots are development UI checks, not evidence of native persistence or live-provider operation. The Rust and packaged-worker tests cover those local paths separately.

The first concurrent packaged-worker test run failed while individual sound processing passed. A local two-worker gate and serialized runtime ACL mutations were added in response; keep the concurrent suite as a regression check. Do not conceal this failure in performance or reliability reporting.

Release blockers include live-provider validation, automatic synchronization, calibrated recognition, complete publication recovery, full legal/output workflows, scale benchmarks, signed installation and independent security review. No case data was sent to an inference provider during this implementation's tests.

## Latest completed local validation

The run in `artifacts/v4-verification-20260920-165000/results.json` passed all six command groups: frontend build/tests, desktop compilation check, Rust regressions, Python sound tests and explicit packaged-worker tests. It includes 15 V4 Rust tests, four sound tests and nine native sandbox tests, alongside the existing core/UI suites. Live-provider calls and a clean-machine install were not performed.

Browser checks verified the settings, separate execution/review controls, consent reset when changing provider, and findings/sound panel layout. Screenshots: `artifacts/v4-settings.png`, `artifacts/v4-evidence.png`. Browser preview cannot exercise native case storage; the native tests cover that separately.

### Supplementary packaged-desktop probe

The development executable was built with `npm exec tauri build -- --debug --features desktop --no-bundle` and copied separately to `artifacts/VisLex V4 development`. The existing packaged app directory was retained.

A subsequent CDP probe requested an isolated WebView2 profile, but the desktop displayed an existing case with a pending job. Read-only IPC probes timed out. The probe was stopped without submitting a synthetic case, evidence edits or inference requests, and the desktop process was left running to avoid interrupting that background work. **Packaged-desktop end-to-end smoke validation is therefore incomplete.** This does not replace or invalidate the successful explicit native worker tests, and it must not be presented as a successful UI acceptance run. Removing remaining long operations from the case mutex is still a release requirement.

Completed test count: 1 library test + 38 core tests + 15 V4 tests + 9 explicit native worker tests + 6 frontend tests + 4 Python sound tests = 73 passing tests. The frontend build, desktop compilation check and development executable build also succeeded. The upstream `proc-macro-error2` future-compatibility warning remains.


## Automatic analysis and provider setup update — 2026-09-20

The desktop now enables text/image AI access when a configured case opens. Settings expose company API keys, account-backed model dropdowns, a default model, execution mode, and verification mode; offline/enable checkboxes and dollar estimate controls were removed at the user's request. Legacy permission checks remain in the service for restriction enforcement and historical compatibility. New cases reuse saved model configuration; keys remain in Windows Credential Manager. Model catalogue lookup sends credentials only to fixed native provider endpoints, has response/time bounds and pagination, and does not certify model capabilities.

Chat can select any configured provider/model without changing other profiles. Agent-directed execution exposes list_agent_models and delegate_tasks. The coordinator creates up to three persisted, scoped concurrent assignments at a time, including same-model sessions. It merges evidence proposals, rejects unapproved models and nested delegation, and propagates cancellation. This is task-driven activity, not continuous idle inference.

Opening a case or importing a file/folder automatically queues missing local preparation and all-track transcription. Two bounded local worker slots serve the queue. PDF pages and image frames receive local OCR with bundled RapidOCR 1.4.4 weights; native text and OCR remain separate artifact units. Documents retain their format-specific extraction limitations. Media gets track/timing inventory and separate full-audio transcription. Expensive staging and worker execution for automatic preparation occur outside the case mutex. Interrupted preparation is requeued; duplicate opens do not duplicate completed jobs. Failed formats remain visible.

After preparation drains and a selected provider key is available, a scoped automatic AI investigation reviews the inventory, prepared artifacts, images and recording windows, compares sources and saves findings. A chat message preempts that background AI task and the automatic review is queued again afterwards; Stop retains the stopped state for the same inventory. All AI findings are unreviewed. Full frame-by-frame visual understanding, complete hidden document structure support, guaranteed recognition, and complete V4 coverage remain unimplemented; broad review requests and processor completion are not coverage proof.

Validation: 60 core/V4 Rust tests, 10 packaged Windows AppContainer worker tests (including local OCR), and 8 frontend tests passed. The browser layout exposes all four company model selectors with no AI-enable or dollar controls. Provider catalogue parsers and agent coordination were tested with synthetic results. Live model inference is not certified by these tests.

Provider catalogue protocol references: [OpenAI models](https://platform.openai.com/docs/api-reference/models), [Claude models](https://platform.claude.com/docs/en/api/models/list), [Gemini models](https://ai.google.dev/api/models), [xAI models](https://docs.x.ai/developers/rest-api-reference/inference/models). OCR baseline: [RapidOCR](https://github.com/RapidAI/RapidOCR). Weight hashes are in workers/ocr-model-manifest.json.


Follow-up hardening: native imports now stage/copy/hash files outside the case mutex and publish each verified item under the writer lock. An import lease prevents case switching or staging reclamation during that batch. The media-inventory dispatch regression is covered by the packaged-worker test. Preparation failures are retried when the packaged worker revision changes; historical underlying job failures remain recorded. A debug-only VISLEX_WORKER_PATH override permits testing a rebuilt worker without replacing a runtime already being used by an open application.

Native follow-up: an isolated Windows IPC test imported a synthetic PDF, image and video, completed automatic preparation for all three with zero failures, and read settings in 20 ms. The packaged media-inventory regression now asserts successful video processing, preventing the unsupported-processor fallthrough. Updated worker revisions requeue failed automatic preparation; historical failed receipts are retained and marked resolved only after a later successful run of the same processor. Live account catalogue requests returned 74 OpenAI and 7 xAI models; Gemini returned HTTP 403. These metadata checks do not certify live inference quality.
