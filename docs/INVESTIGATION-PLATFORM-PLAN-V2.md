# VisLex investigation platform: upgrade plan v2

Proposed September 20, 2026. Planning document; capabilities and performance targets below are not claims of implementation or achieved superiority.

## 1. Objective and relationship to the original plan

Build the strongest practical workspace for investigating mixed legal evidence: documents, recordings, photographs, statements, and legal authorities. The competitive objective is substantially better discovery of material facts, fewer unsupported conclusions, and less human verification time on evidence-intensive cases.

This revision incorporates the complete [original supplied plan](INVESTIGATION-PLATFORM-PLAN-ORIGINAL.md). All its product requirements remain in scope, including contracts, discovery, public-source research, drafting, redaction, exhibits, backups, offline exports, and professional release gates. This document changes implementation priorities, model selection, investigation control, and evaluation requirements. Where they differ, this revision governs. The original is preserved as the detailed specification for requirements not changed here.

Retain single-user Windows, Tauri/React/Rust/Python, authoritative local cases, optional permitted cloud inference/compute, 200 recording hours and 10,000 documents per case, public U.S. legal sources, and approval for external sharing, filing, destructive actions, and purchases. No application dollar or fixed agent-step cap is introduced. Configured provider limits and machine resource bounds still apply.

The first competitive release concentrates on complete incident investigations, especially report-versus-recording comparisons and synchronized multi-camera review. Complete legal-workspace scope remains the destination; stages determine order rather than remove features.

### What competition actually establishes

Harvey publicly describes multi-model cloud agents and large-scale review, so generic tool use, multiple models, and document chat are not sufficient differentiation. Its multimedia announcement describes video transcription and separately describes image understanding; its precise video-vision implementation remains unverified. Absence of public documentation is not evidence of absence. [Harvey agent infrastructure](https://www.harvey.ai/blog/why-we-built-our-own-cloud-agent-infrastructure), [multimedia announcement](https://www.harvey.ai/blog/audio-video-image-understanding), [Vault](https://www.harvey.ai/platform/vault).

Compete on measurable outcomes:

| User outcome | Required VisLex behavior | Proof |
|---|---|---|
| Find a decisive event that lasts under a second | Search broadly, inspect candidate windows densely, expose remaining gaps | Held-out short-event recall and false findings |
| Reconstruct an incident across recordings | Versioned clock mappings with uncertainty and shared anchors | Alignment error and false-match rate |
| Test whether a report matches recordings | Atomize assertions, retrieve support and conflicts, preserve qualifications | Material discrepancy precision/recall |
| Understand why a conclusion was reached | Open the exact passage, clip, surrounding context, and dependency history | Reviewer verification time and support accuracy |
| Continue when new evidence arrives | Reopen only affected conclusions and coverage obligations | Update latency and stale-finding escape rate |
| Review a large case without silent omissions | Explicit inventory and modality-specific coverage accounting | Denominator reconciliation and missed-evidence rate |

No universal superiority claim follows from winning one workflow. Legal-research breadth, enterprise collaboration, contract work, and incident analysis receive separate scorecards.

## 2. Baseline and immediate corrections

Reviewed README.md, docs/IMPLEMENTATION.md, docs/MEDIA-ANALYSIS-PLAN.md, and relevant agent/processing/coordinator code. Status documents contain older entries followed by updates; reconcile them against tested behavior before implementation planning estimates.

Existing foundations include preserved source copies and hashes, occurrence records, SQLite/FTS, versioned working records, encrypted backups, an OpenAI tool loop, native document extraction, image inspection, PTS-based video sampling, background full-recording transcription, and a fresh visual-description pass.

Current gaps include tiny-model speech recognition, no direct audio understanding in the documented tool loop, limited visual sampling, missing structured event/clock/claim objects, incomplete retrieval over later analysis revisions, incomplete automatic job resumption, and expensive processing under the broad case lock in some paths. Citation existence is not evidence-support verification.

The first deliverable is an executable baseline report: imported units, actual tools exercised, failed/unsupported units, recognition quality, elapsed time, provider usage, and human verification time. Preserve the known wrong-scene-at-correct-timestamp example as a regression fixture. Do not silently convert current saved prose into verified structured evidence.

## 3. A persistent investigation contract

Replace reliance on a long system prompt with application-enforced investigation state. Strong models choose and execute useful work; deterministic code governs permissions, revisions, coverage accounting, and completion rules.

Each investigation starts with a typed contract:

- Question, deliverable, relevant legal/factual issues, and user-supplied hypotheses labeled as hypotheses.
- Source inventory revision, eligible sources, restrictions, and explicit exclusions.
- Required modalities, time ranges, document families, and review depth.
- Exhaustive or targeted scope, with separate completion criteria.
- Materiality tiers for findings and the required verification for each tier.
- Outstanding missing inputs, processing failures, and permitted fallbacks.
- Reusable completed work, its dependencies, and currentness.

Maintain durable task states: queued, running, waiting-on-job, needs-input, paused, completed-with-gaps, verified-complete, failed, cancelled. Application verification means defined checks passed; it never means a proposition is legally established or human-approved.

### Application-enforced completion

`finish_task` proposes completion; a validator checks the contract. It cannot accept a case-wide conclusion while required sources are undiscovered, tool pages remain unconsumed, required processing is incomplete, or material findings lack support checks. Return the remaining obligations to the coordinator for repair.

Permit an explicitly partial answer when processing fails or evidence is missing. Explain the exact gap. Do not force endless retries or manufacture certainty to obtain a green completion status. Detect lack of progress from changes in evidence, coverage, and unresolved obligations, not only identical tool calls.

Capture user-readable action receipts and decision summaries, not hidden chain-of-thought. Checkpoint state outside conversational context so compaction and restarts cannot erase outstanding work.

## 4. Evidence architecture that supports reliable autonomy

Retain the original plan's source/occurrence, artifact/run, evidence unit, metadata assertion, entity/mention, observation, statement, event hypothesis, clock/anchor/mapping, claim/issue/authority, relationship, review/correction, and work-product objects.

Add explicit `InvestigationContract`, `CoverageObligation`, `CoverageReceipt`, `EvidencePacket`, `ClaimAssessment`, `HypothesisTest`, `ReviewDecision`, `CapabilityProfile`, and `BenchmarkRun` records.

Every derived object records stable ID, revision, input revisions, source locators, provenance, restrictions, processing settings, producer, currentness, and human review separately from machine checks. A source re-exported or quoted elsewhere retains its lineage; repeated copies do not count as independent corroboration.

### Coverage is several measurements

For every source and modality, distinguish inventoried, decoded, extracted, indexed, model-inspected, finding-checked, and human-reviewed. Include errors, skipped regions, sampling density, and algorithm/model version.

For documents, retain unit denominators and unsupported structures. For audio, retain track/channel/sample ranges. For video, retain sampled frame PTS and clip spans plus gaps between inspected samples. Passing a ten-minute clip to a provider does not mean every frame was inspected. If provider sampling is undisclosed, label it unknown.

Negative claims such as “no warning was given” require the relevant complete intervals, suitable audio quality, language/track coverage, and a documented search method. Otherwise state “no warning was found in the inspected material.” Coverage alone cannot establish that a detector would recognize an event.

### Retrieval and storage

Use SQLite as authority and FTS5 for lexical search; select a rebuildable embedded vector index after a small Windows packaging/performance spike. LanceDB and the original BGE candidates remain candidates, not mandatory architecture commitments.

Combine exact, semantic, temporal, entity, and relationship retrieval, then rerank and expand context. Preserve filters and permissions at both retrieval and source-read boundaries. Human corrections and newer extraction revisions must be searchable without erasing historical versions.

Separate original evidence, attributed statements, machine observations, and AI work product in retrieval. Saved summaries can guide the next search but cannot substitute for source inspection or corroborate themselves.

Implement query plans with inspectable filters and result denominators. Exhaustive tasks enumerate eligible units rather than treat top-k retrieval as complete review. Structured event queries support before/after, overlap, uncertain time ranges, and cross-recording windows.

Use a single SQLite writer queue, concurrent readers, short transactions, leased persistent jobs, heartbeat/expiry, idempotent publication, staging directories, and a transactional outbox. Expensive work stays outside transactions and the case mutex. Reconcile staged files, published records, and index revisions after restart. Do not promise exactly-once execution across provider calls; support duplicate-safe publication and explicit uncertain request receipts.

## 5. Model strategy: strongest useful system, replaceable components

Use the strongest evaluated reasoning model available to the configured account for planning, difficult synthesis, and material-claim adjudication. A model name in this plan does not establish API availability, modality support, or account access. Discover and validate those through a capability registry before exposing a selection.

Each adapter declares tool calling, structured output, text/image/audio/video support, context/file limits, timestamp conventions, retention behavior, permitted region, cancellation behavior, and billing observations. Pin available model versions; record aliases and provider response metadata when an exact version cannot be pinned.

Keep model selection visible and allow an explicit model lock. Never silently downgrade a user-selected quality profile. Smaller models may handle routine work only after non-inferiority tests on that workload. No automatic new subscription, purchase, or destination authorization follows from selecting maximum quality.

### Evaluate three media approaches

| Approach | Intended role | Main evaluation question |
|---|---|---|
| Direct audio/video model API | Broad temporal understanding and discovery of candidates | Does it find relevant events and locate them accurately? |
| Local decoding, detailed speech, sound detectors, exact frame/clip tools | Precise timing, targeted inspection, reproducible source linkage | Does it reduce misses and unsupported interpretations? |
| Combined workflow | Broad discovery followed by targeted verification | Does added processing improve quality enough to justify latency/cost? |

Google documents both static frame sampling and on-demand agentic video processing. Direct video input is therefore a useful processing option inside VisLex, not an incompatible replacement for the case agent. Do not duplicate a provider's work unless benchmarks show a benefit. [Gemini video processing](https://ai.google.dev/gemini-api/docs/video-understanding).

Benchmark the original local/open-model candidates against permitted hosted alternatives using the same recordings. Keep tiny transcription for preview; choose the detailed speech, diarization, audio-event, visual, embedding, and reranking components by measured task performance, licensing, deployment feasibility, and supported languages. Larger is not an automatic promotion criterion.

## 6. Adaptive multimedia investigation

### Pass 1: inventory and inexpensive complete signal processing

Inventory every track/channel, PTS/timebase, offsets, decoder gaps, document unit, attachment, and file-family relationship. Build metadata, waveforms, shot/motion signals, quality indicators, OCR where applicable, and speech/sound coverage. Stream and checkpoint processing; do not expand every recording permanently into WAVs and frames.

### Pass 2: broad semantic discovery

Analyze overlapping windows through the selected media profile. Use transcripts, sounds, visual content, metadata, and documents to propose candidate events. Always include regular visual coverage independent of audio triggers; silent events must have a discovery path. Record contextual overlap and deduplicate candidates through shared source locators, retaining conflicting interpretations.

### Pass 3: issue-directed inspection

Prioritize candidate actions by materiality, uncertainty, missing coverage, available corroboration, and expected ability to distinguish competing explanations. These are auditable scheduling heuristics, not a claim of mathematically optimal information gain.

Let the agent request native audio, per-channel clips, alternate transcription, exact frames, dense sequences, image crops, full-resolution regions, neighboring passages, or another camera. Let it run scoped reproducible calculations and alignment tests. Retain generic tools so a new question does not require a new hard-coded workflow.

### Pass 4: verification of decisive intervals

Reopen original context before/after a candidate event, check relevant tracks and camera views, confirm timestamp transformations, and test alternatives. Use an independent neutral first look when it can reveal anchoring. Then provide the competing claims and request an explicit comparison. Store both passes and unresolved disagreements.

For “three knocks before entry,” separately establish candidate impacts, burst count and uncertainty, visual entry interval, cross-track timing, and the support for identifying the sound as knocking. Do not infer intent, the actor, or a struck surface from an audio label alone.

### Cross-recording time and entity handling

Retain all six time concepts and typed locators from the original plan. Estimate offset/drift with anchor provenance, residuals, alternative mappings, and uncertainty; use piecewise mappings for discontinuities. Test held-out anchors and competing alignments, not just fit residuals. Three anchors across sixty seconds is an initial heuristic, not a universal guarantee of reliable drift estimation.

Use uncertain time intervals in joins. Assert temporal ordering only when the mapped uncertainty supports it. Preserve original timestamps and historical mappings in reports. Account for propagation delay and radio retransmission; reject ambiguous repeated-sound matches.

Entity links remain reversible candidate associations. A tracking ID, speaker cluster, name in a transcript, and camera owner are distinct until supported. Do not infer personal identity from appearance alone. Show the actual evidence behind proposed links.

## 7. Claim assessment and competing explanations

Break reports and proposed findings into atomic propositions: actor, action, object, place, time interval, qualifiers, and source attribution. Preserve negation and uncertainty. An officer's statement that an event happened remains a statement object, distinct from a visual observation.

Every material claim gets an evidence packet containing:

1. Exact proposition and its materiality to the current question.
2. Supporting evidence with context and immutable locators.
3. Conflicting evidence and alternative readings.
4. Search methods, eligible scope, completed coverage, and gaps.
5. Source lineage and dependence between purported corroborators.
6. Perception, clock, identity, and legal assumptions.
7. Machine assessment and separate human review state.
8. Dependencies that would reopen the finding after a change.

Assessment states: supported within scope, partly supported, contested, contradicted within scope, insufficient evidence, or stale. Machine states must not overwrite human review. User disagreement is stored as a correction or competing interpretation with provenance; it is not automatically proof.

Verification checks location, quotation fidelity, proposition support, temporal/identity assumptions, and contrary evidence separately. Deterministic quotation matching must point to the correct extraction revision; a match against erroneous OCR does not prove the original says it. Inspect original page/clip for material disputed quotations.

Maintain a hypothesis table with predictions, evidence that would distinguish explanations, tests performed, and results. Distinguish genuine contradictions from different observation times, uncertainty, incomplete vantage points, or ambiguous language. Do not manufacture a balanced alternative where no evidence supports it.

Fresh reviewers add a perspective; their votes are not independent corroboration. Reserve extra model passes for material, ambiguous, or failed checks rather than multiplying calls for every sentence. High-impact disagreement becomes a review item or a qualified finding.

## 8. Persistent agent execution and tools

The coordinator owns the contract, current evidence snapshot, task graph, unresolved hypotheses, and publish decisions. Bounded specialists can inspect independent modalities/issues using scoped evidence packets. This describes product architecture, not a requirement to delegate every task.

Start with four agent subtasks, two heavy local jobs, and one heavy job per available GPU, then tune with measured resource contention. Each task receives explicit scope, deduplication key, input revisions, output schema, and completion requirements. Writes use compare-and-swap revisions. Detect cycles and duplicate work. A slow or failed specialist must not freeze the whole interface.

Tools include the original search, read, inspect, reanalyze, synchronize, compare, trace, research, draft, verify, coverage, exhibit, and redaction families. Add:

- `get_investigation_contract`, `list_open_obligations`, `get_case_delta`.
- `inspect_audio_interval` distinct from `transcribe_audio_interval`.
- `inspect_clip`, `compare_camera_windows`, `get_sampling_receipt`.
- `get_claim_packet`, `test_hypothesis`, `find_contrary_evidence`.
- `request_deep_review`, `explain_dependency`, `propose_completion`.

Every result carries source/run revisions, locators, modalities actually processed, omissions, continuation tokens, job state, and actionable error information. Pagination and truncated output are explicit obligations when exhaustive scope requires consumption.

The script sandbox remains isolated, read-only over granted inputs, credential-free, network-free, with approved libraries, private output storage, bounded resources, and retained script/output hashes. Scripts cannot install packages or modify the host. Evidence content never grants tool permissions.

Track provider/model, calls, actual or estimated usage, latency, retries, and uncertain billing receipts. Let users cancel or set an optional budget; resource exhaustion produces a checkpointed partial result. Do not silently stop at an arbitrary cost/step ceiling or keep running after a completion obligation becomes impossible.

## 9. Human review should take seconds per finding

Make the main workspace question-centered, with progressive disclosure rather than every panel open simultaneously:

- **Investigate:** ask a question, see meaningful progress, discoveries, gaps, and provisional findings.
- **Review a finding:** claim beside exact passage/clip, linked cameras, surrounding context, support/conflict tabs, and corrections.
- **Timeline:** synchronized recordings, source and incident clocks, speaker/sound/event lanes, waveform, optional spectrogram, uncertainty, and coverage.
- **Prepare work product:** approved or explicitly unreviewed findings, currentness warnings, citations, and package preview.

One click should open the decisive evidence; a second should expose its original context and provenance. Event labels are readable descriptions, not internal model names. Show uncertainty in normal language. Advanced model and processing receipts belong in an inspector.

Offer rapid accept, reject, split event, correct time/text, relabel speaker, and propose alternative. Corrections create revisions and invalidate affected claims. Preserve unsaved edits through crash recovery and prevent background publication from overwriting them.

Synchronize media through tiled/virtualized UI data, quality-aware seek behavior, and exact decoded-frame inspection where requested. Mark buffering or unsupported synchronization rather than silently letting cameras drift. Keyboard navigation and accessible text alternatives are release requirements.

## 10. Complete workspace and legal research

Retain every workflow from the original: chronologies, report/statement comparison, discovery inventories and production tracking, criminal/civil issue matrices, deposition preparation, research memoranda, motion drafts, contract comparison/obligations/redlines, exhibits, clip lists, and tables of authorities.

Connect each issue matrix to factual elements/questions, disputed propositions, supporting/conflicting evidence, missing evidence, and authority records. Avoid mechanically converting uncertain facts into a legal conclusion. Jurisdiction and relevant date are mandatory inputs for jurisdiction-dependent analysis.

Public-source adapters retain original URLs, snapshots, retrieval times, court/jurisdiction, effective dates, citation resolution, proposition support, and known treatment. Distinguish source coverage from search success. Do not represent public-source treatment searches as equivalent to a comprehensive commercial citator.

Draft from current evidence packets, then verify factual and legal citations separately. Edits that change a proposition reopen support checks. Never let polished prose conceal unresolved factual premises. Exports identify stale, disputed, machine-checked, and human-reviewed material accurately.

Preserve the original storage, content-addressing, encrypted-backup, verified-restore, immutable artifact retention, redaction, hidden-content inspection, and offline evidence-viewer requirements. Cloud jobs check current permissions immediately before transmission, retain payload provenance, and disclose provider retention settings. Deletion after processing must not be labeled zero retention without a supported provider guarantee.

## 11. Prove a significant competitive advantage

### Benchmark before more architecture

Create a benchmark runner and adjudicated reference set during the first stage. Begin with a development pilot of at least 12 distinct incident bundles; freeze a separate final evaluation set of at least 30 independent bundles, increasing it after a variance/power analysis. These are planning minima, not a statistical guarantee. Split by incident and recording origin so clips from one incident cannot appear in both development and final sets.

Use synthetic edge fixtures for deterministic timing/recovery tests and consented or otherwise authorized realistic material for recognition and reviewer-time tests. Include negative cases, silent actions, false premises, incomplete recordings, overlapping speech, names/numbers, low light, conflicting clocks, duplicated reports, missing attachments, and irrelevant distractors. Ground truth is independently annotated, adjudicated, and allowed to remain ambiguous.

Comparison arms:

1. Current VisLex with pinned configuration.
2. A strong direct-video baseline with the same eligible evidence supplied as its product permits.
3. A competent basic agent using the same main model and comparable resource allowance.
4. Upgraded VisLex; ablations remove clock reconciliation, coverage enforcement, claim checking, or specialist processing separately.
5. Harvey's accessible current product, with supported settings and a competent operator, when legitimate access is available.

Do not substitute a home-built approximation for Harvey. If access is unavailable, mark that arm unmeasured and publish no Harvey superiority claim. Researching this plan does not authorize buying a license or uploading private case material.

Run both matched-resource comparisons and best-available-product comparisons. Record model/product version, input limits, supported modalities, prompts, operator effort, preprocessing, excluded material, elapsed time, and total cost. Report ingestion failures as outcomes. Predeclare handling of capacity limits and incomplete runs. Use blinded reviewers and randomize output order; measure repeated runs because model outputs vary.

### Proposed competitive release gate

These thresholds are objectives to freeze after development-only feasibility work, before the final set is opened:

| Metric | Proposed target |
|---|---|
| Recall of adjudicated material facts/discrepancies | At least 15 percentage points above comparator at a matched 95% material-finding precision operating point |
| Unsupported material-claim rate | At most 2%, and at least 50% relative reduction where comparator errors are sufficient to estimate a reduction |
| Human time to verify a correct final report | At least 40% lower median with no reduction in verified completeness |
| Machine-checkable locator/revision validity | 100% in release evaluation; unsupported formats remain explicitly unresolved |
| Update after correction/new evidence | All materially dependent findings reopened; no silent stale finding in regression fixtures |
| Deterministic recovery and original preservation | No source changes, duplicate publications, or falsely completed jobs across fault fixtures |

Report paired effect sizes and 95% confidence intervals clustered by incident, not by treating related clips/claims as independent cases. Claim a significant margin only when the relevant interval supports the predeclared margin. A near-ceiling comparator may make the 15-point target impossible; do not move the final goalposts. Report the actual improvement or failure, then start a new versioned evaluation if strategy changes.

Avoid a single composite score that hides regressions. Report false findings per recording hour, missed material events, per-condition precision/recall, attribution errors, transcription name/number accuracy, timing error, calibration/abstention, reviewer workload, latency, and cost separately. Track performance on uncertainty cases so abstaining on everything cannot win precision alone.

Retain the original engineering targets for impact detection, onset timing, suitable-signal alignment, retrieval, and UI response as provisional subcomponent goals. Add alignment rejection accuracy, silent-event recall, and retrieval recall by modality/condition. Conditional alignment accuracy must be reported alongside the fraction of recordings accepted for alignment.

For scale, use 200 media hours/10,000 documents and separately a one-million-page stress corpus. Publish page, byte, track, duration, and resolution distributions. Measure on a documented reference machine; provisioned remote compute is a separate profile. Benchmark bounded RAM/disk, first useful finding, full processing time, interaction during load, cancellation, and restart. No unstated GPU or RAM availability assumptions.

## 12. Implementation order and deliverables

| Stage | Concrete deliverable | Exit gate |
|---|---|---|
| 0. Baseline and feasibility | Benchmark runner, frozen development fixtures, present-system report, direct-video/speech challengers, updated capability inventory | Reproduce the known scene failure; quantify primary error sources; choose first workflow |
| 1. Durable evidence core | Additive schemas/locators, source inventory/coverage, writer queue, resumable jobs, transactional publication/outbox, capability adapters | Migration/rollback and crash fixtures pass; originals and old citations survive |
| 2. First complete investigation | Detailed audio, candidate sounds, clip/frame tools, assertion comparison, evidence packets, claim review UI | One end-to-end report-versus-recording case works with support/conflict checks and honest gaps |
| 3. Multi-recording superiority candidate | Clock hypotheses, held-out anchors, synchronized views, temporal/entity search, silent-event coverage | Multi-camera cases improve measured discovery and verification time without false alignment growth |
| 4. Reliable autonomy at scale | Persistent contracts, scheduler/specialists, coverage-enforced completion, scoped scripting, delta investigations | Interrupted work resumes; large eligible scopes reconcile; new evidence reopens affected claims |
| 5. Complete legal workflows | Public-law adapters, issue matrices, drafting, discovery/contract workflows, verified citations | End-to-end workflow-specific acceptance tests and source-coverage reporting |
| 6. Professional product and comparison | Redaction/exhibits, offline viewer, complete exports, restore/recovery, accessibility, packaging/security, final blinded benchmark | Release gates pass; comparative claims match measured results and scope |

Stage 2 is deliberately a full usable investigation before the entire platform is complete. Do not postpone user validation until all schemas, models, and specialists exist. Preserve vertical working paths throughout migration. Use feature flags for new engines and a legacy-citation adapter for historical cases.

### First implementation backlog

1. Reconcile current status documents and create a machine-readable capability inventory.
2. Build reference fixtures and baseline runner with result/support/coverage schemas.
3. Add analysis-run and typed locator adapters around existing artifacts; add coverage receipts without changing original bytes.
4. Move one existing processor onto leased resumable jobs, then fault-test publication and cancellation before migrating others.
5. Add a detailed speech challenger and direct audio/video adapter under existing transmission permissions; evaluate on authorized fixtures.
6. Build atomic report-assertion extraction with supporting/conflicting evidence packets.
7. Deliver the finding-review view and completion validator for that first workflow.
8. Measure the full workflow, identify the dominant remaining errors, and prioritize synchronization/tracking/search accordingly.

### Engineering ownership boundaries

Evolve `src-tauri/src/agent.rs` from monolithic instructions/tool dispatch toward contract, scheduler, tool-registry, evidence-packet, and verification modules. Refactor `processing.rs`, `transcription.rs`, and `desktop.rs` for leased jobs and brief case/database access. Keep case schema migration and permissions in the Rust authority layer. Extend Python workers through versioned request/result contracts. React renders committed revisions and job events; it does not independently decide evidence truth or permissions.

Finalize actual module names after a deeper implementation inspection. Add tests at behavior boundaries: migrations, timestamps, permissions, coverage, support, recovery, and source-to-output integrity. Avoid tests that merely assert prompt wording or mirror implementation details.

## 13. Decisions and completion criteria

Adopt now: versioned evidence, durable contracts, modality-specific coverage, claim packets, targeted verification, combined media options, reproducible evaluation, and a complete first investigation workflow.

Decide through measured spikes: exact ASR/diarization/VLM/embedding providers, vector storage, local GPU requirements, routing policy, concurrency, and event classes that are accurate enough to release. Keep the original named models as challengers until they earn promotion.

Retain all full-product requirements from the supplied plan. Every requirement must map to a deliverable and acceptance result; unresolved or untested requirements remain visibly incomplete. Before release, produce a traceability table covering the original plan and this revision.

Success means a user imports a case, asks a consequential question, receives findings that survive source verification, discovers meaningful conflicts or gaps, corrects evidence without losing history, produces reviewed work product, and can reproduce the material basis later. A competitive claim requires the matched comparison to show the promised margin. Powerful models and many tools are inputs; better investigations are the output to prove.
