# VisLex Ultra Implementation Plan

Date: 2026-09-21
Repository: utusmant-jpg/vislex
Audit baseline: b673ad77a8a2b22d0be098587b08bc0538b5c76b
UI redesign reconciliation commit: 9916bb9e0286bd6871d56c8873f62276affc42b2

## Mission

Turn the existing VisLex application into a fast, reliable, lawyer-usable evidence intelligence workspace without restarting the product or replacing the current Tauri + Rust + React + SQLite architecture.

The product target is a complete protected journey:

import evidence -> prepare/process -> exact search -> inspect exact original -> make a source-linked finding -> review the finding -> export a pinned work product -> encrypted backup -> restore -> reopen.

Preserve what already works. Fix integration defects first, then performance, then workflow depth and UI refinement.

## Rules that must not be broken

1. Do not rewrite VisLex from scratch.
2. Preserve immutable original evidence bytes, stable source IDs, historical revisions, citation provenance, source restrictions, review status and the audit trail.
3. Do not weaken the Windows worker sandbox to gain speed.
4. Do not silently expand a case's cloud/AI permissions when it is reopened.
5. Do not treat a resolvable citation as proof that a claim is supported.
6. Do not treat extracted text as direct listening, rendered pages as reviewed pages, or sampled frames as continuous video coverage.
7. Do not treat AI review as human approval.
8. Do not delete or weaken failing tests merely to get green CI.
9. Do not re-create frontend features already introduced by the September 21 UI redesign.
10. Keep GLM/Z.ai as the coding agent separate from VisLex's runtime model integrations.
11. ACP/subscription integration is a later milestone. MCP is deferred.
12. Never upload real client evidence, credentials, case databases or diagnostic dumps to coding providers.

## First action: establish the real baseline

Before changing production code:

- git status --short
- git branch --show-current
- git rev-parse HEAD
- git log -5 --oneline
- git fetch origin
- compare HEAD with the commits named above
- inspect current README, CI, package files, Rust config, worker config and native verification scripts
- run the existing frontend build/tests and Rust tests when the environment supports them
- distinguish PASSED, FAILED, BLOCKED and NOT RUN; never relabel blocked tests as passed

Create a small canonical implementation ledger under docs/implementation/ rather than another giant roadmap. Record ticket, owner, changed files, tests run, tests not run, result, reviewer findings and next action.

## Priority 0: correctness and trust defects

### VL-001 — baseline and protected journey

Build/reproduce the complete synthetic protected journey. It becomes the integration gate for subsequent work.

Acceptance:
- synthetic case can import, process, search, navigate citations, create/review a finding, export, backup, restore and reopen
- original hashes remain identical
- restrictions remain intact after restore
- failures are recorded honestly

### VL-002 — durable case-level AI/cloud policy

Revalidate src-tauri/src/providers.rs and case-open settings behavior.

Problem to check:
global app preferences can enable online/text/image/direct-media settings when a case is opened, which can conflict with a durable per-case authorization model.

Required design:
- app defaults initialize new cases
- existing cases preserve their own grants
- case policy separately controls text, images and original media
- provider/model routing cannot silently expand permissions
- revocation is checked immediately before dispatch
- ordinary authorized local actions do not require repetitive approval dialogs

Tests:
- reopen an offline case after app defaults become online: case stays offline
- revoke image/original-media permission while task exists: later dispatch is blocked
- new case can inherit chosen defaults explicitly

### VL-003 — viewer-context removal must actually remove the next-message attachment

Revalidate src/components/AgentPanel.tsx and viewerContext.ts.

The visible “do not attach this file” state must suppress the viewer-context payload for that message. This is separate from the source remaining within the case's authorized investigation scope.

Test:
toggle attachment off, send message, inspect backend task history/request and prove no viewer-context object was attached.

### VL-004 — public-authority ingestion

Revalidate src-tauri/src/authority.rs against case.rs import guards.

Create a narrow trusted-ingest path for bytes already downloaded by the public-authority adapter. Do not weaken the guard that prevents users from importing arbitrary files from inside the active case.

Tests:
- fresh supported HTML authority is preserved, indexed and searchable
- fresh PDF authority is preserved correctly
- importing the case database as user evidence still fails
- authority provenance retains URL, retrieval time and original hash

### VL-005 — backup/restore artifact format symmetry

Revalidate backup.rs, exports.rs and processing.rs.

Every artifact format that backup can include must be accepted and verified by restore. In particular, test reviewed redaction PDF artifacts.

Create one versioned artifact registry/manifest contract rather than duplicated extension lists.

Tests:
- backup with JSON/JPG/MP4/PDF/transcript artifacts restores successfully
- tampered hashes fail
- unsafe archive paths fail
- unknown formats fail deliberately
- restored originals hash-identical to source case

### VL-006 — pin exports to the reviewed evidence snapshot

An export plan must contain the exact source/artifact hashes and revision/review state it was prepared from. Revalidate all those facts immediately before publishing the output.

Do not allow an export prepared against one state to silently complete after source restriction, record revision, finding review or dependency currentness changes.

### VL-007 — automatic analysis state machine

Do not mark an inventory as successfully analyzed merely because an automatic task was created.

Persist distinct states:
planned/queued/running/paused/failed/complete, plus a completion fingerprint that is written only after successful completion.

Resume missing work without replaying uncertain provider transmissions.

### VL-008 / VL-009 — claim-support coverage of final answers

The final prose must not be able to add material factual assertions that were never represented in the support-review structure.

Preferred design:
- structured factual assertion blocks linked to exact claim/evidence revisions
- separate analysis/hypothesis/limitation/recommendation blocks
- final readable prose compiled from validated blocks
- unsupported or unresolved factual blocks stay visibly qualified
- source support, contrary evidence, timing assumptions and identity assumptions are explicit

Avoid brittle “claim proposition string must appear verbatim” gates.

### VL-010 — extraction/transcript version consistency

A completed full transcript must not leave an older partial media extraction as the implied active searchable text.

Move toward immutable extraction revisions plus an explicit active/current index revision. Historical citations must remain resolvable to the historical wording.

## Priority 1: performance and responsiveness

### VL-011 — eliminate repeated whole-recording copies

Current discovery architecture must be profiled carefully.

Do not solve this by granting sandbox workers unrestricted access to originals.

Build a verified read-only staging lease/cache per source + worker revision + operation family. Reuse it across discovery chunks and transcription/inspection jobs when provenance and permissions match.

Measure:
- bytes copied
- bytes hashed
- worker launches
- elapsed time
- peak disk usage

Use at least small, medium and large synthetic recordings.

### VL-012 — explicit job scheduler

Replace ad hoc background kick loops with a durable scheduler abstraction that understands:
- interactive vs background priority
- source locks
- CPU/memory slots
- cancellation
- retries
- dependency readiness
- crash recovery
- case switching
- fairness

Keep worker concurrency resource-bounded.

### VL-013 — responsive cancellation

Cancellation must interrupt:
- staging copy
- worker execution
- long indexing
- transcription
- discovery
- export/backup where safely interruptible

Measure stop latency.

### VL-019 / VL-020 / VL-021 — replace whole-case polling

The UI should not serialize broad case state every three seconds forever.

Split snapshot data into:
- compact case metadata
- paginated source list
- paginated records
- paginated conversations
- jobs/issues
- targeted detail queries

Use Tauri change events for invalidation and a lightweight reconciliation poll only where needed.

Add a case/session epoch so a late async response from an old case cannot replace current state.

Virtualize large source lists, transcript lists and activity feeds.

### VL-022 / VL-023 — make semantic search read-fast

Search should not discover and embed hundreds of new passages while the user waits.

Create background, revision-aware passage indexing jobs. Keep lexical results immediate. Merge semantic results when the appropriate revision index exists.

Do not build a second unrelated truth/search database.

### VL-024 / VL-037 — long transcript addressing and virtualization

Store transcript content in immutable bounded segments with timestamps and diagnostics rather than relying on a single giant editable record.

UI:
- virtualized transcript rendering
- search within transcript
- follow playback
- exact seek
- segment correction/review without rewriting the immutable machine artifact

## Priority 2: analysis quality

Build one evidence-state vocabulary across the app:

available -> decoded/extracted -> retrieved -> supplied to model -> interpreted -> human reviewed.

Never collapse these into one “reviewed” boolean.

For every substantive disputed proposition, support:
- proposition
- source-linked supporting evidence
- source-linked contrary evidence
- identity assumptions
- timing/clock assumptions
- extraction/transcription uncertainty
- alternative explanation
- discriminating next check
- currentness
- human review state

Agent teams are for division of labor, not voting. Multiple agents agreeing does not create corroboration.

A lead/coordinator should merge evidence packets only after checking decisive points against originals.

## Priority 3: product workflow and UI

Preserve the new Chat / Evidence / Findings / Review / Jobs workspace direction.

Do not launch another full visual redesign.

Improve:

### Evidence review
- persistent tabs and back/forward source navigation
- resizable panels
- source + transcript + finding visible together when useful
- exact citation chips open the correct original location
- robust long filenames
- loading/progress states
- keyboard access
- text scaling and reduced motion
- Surface-sized layouts

### Video/audio
- do not label 1/30-second browser seeking as an exact “one frame” operation
- approximate playback step should say approximate
- exact forensic frame navigation must use decoder PTS and return an exact artifact locator
- preserve A/B looping and speed controls
- keep transcript/follow-playback integration
- show sampled-video coverage honestly

### Documents
- continuous/lazy PDF viewing should preserve exact physical page identity
- distinguish native text extraction, OCR and visual page interpretation
- page/citation navigation must be deterministic

### Redaction
- preserve the human page-review export gate
- test drag/draw coordinate mapping under zoom, rotation and image orientation
- prove exported derivative is flattened and original hidden content is absent
- never imply redaction based solely on how an overlay looks in the viewer

### Findings/work products
Replace raw JSON-first editing with structured forms/tables for common objects:
- observation
- statement
- event
- issue
- clock proposal
- authority
- issue matrix
- discovery item
- deposition outline
- draft
- exhibit list

Keep a raw/provenance view available for advanced inspection.

### Draft safety
Refreshes and agent updates must not silently erase unsaved:
- notes
- finding review comments
- work-product edits
- composer drafts

When exporting, make clear whether the saved revision or unsaved draft is being exported.

## Priority 4: provider/runtime architecture

Keep provider adapters behind one capability contract.

For every enabled model/profile, validate capabilities rather than inferring them from a catalogue name:
- text
- tool calling
- images
- direct media
- streaming
- context size assumptions
- reasoning controls

A model being listed by a provider is not proof that VisLex's complete agent protocol works with it.

Add synthetic adapter contract tests.

ACP is the later subscription-agent integration target. MCP is explicitly deferred. Do not mix that milestone into the P0 correctness work.

## Priority 5: engineering structure

Avoid monolithic growth.

Refactor only behind passing characterization tests.

Suggested boundaries:
- case repository / migrations
- evidence store
- processing job store
- scheduler
- search/index service
- provider protocol
- agent coordinator
- export service
- backup service
- Tauri command layer

Keep SQLite as the canonical local case store unless measured evidence justifies a change.

Do not introduce a second source-of-truth database.

## Multi-agent coding strategy

Use real subagents only when the coding host actually supports them.

Recommended maximum initial parallelism:
- coordinator
- up to three implementation agents on disjoint areas
- one independent reviewer/tester

Good parallel work:
- frontend-only accessibility work
- read-only profiling
- test fixture creation
- documentation/repro analysis
- isolated worker tests

Serialize ownership of:
- database migrations
- src-tauri/src/case.rs
- src-tauri/src/desktop.rs
- src-tauri/src/agent.rs
- shared TypeScript/Rust DTOs
- Cargo/npm lockfiles
- packaging configuration

Each writer uses a separate worktree/branch. The coordinator merges after review. Never force-push over another agent.

## Per-ticket loop

For every ticket:

1. Revalidate the issue against current HEAD.
2. Read the full relevant files and call sites.
3. Create the smallest useful failing regression or baseline measurement.
4. State the invariant.
5. Implement the narrowest coherent fix.
6. Run changed-path tests and related suites.
7. Run native checks where required.
8. Have an independent reviewer inspect negative cases, races, restrictions and migration behavior.
9. Review the final diff for accidental changes, secrets and weakened checks.
10. Commit one coherent ticket with verification notes.
11. Rerun the protected journey after integration.

Do not fix tests by:
- deleting them
- weakening assertions without justification
- switching off the sandbox
- hiding exceptions
- arbitrarily inflating timeouts
- disabling source/review checks

## Performance acceptance

Create repeatable named synthetic case tiers, for example:

Small:
- 25 files
- 1 GB media total

Medium:
- 250 files
- 10 GB media total

Large:
- 1,000+ files
- 40–60 GB media total

Measure:
- case open time
- import hashing throughput
- search latency
- time to first usable transcript
- transcript throughput
- video discovery throughput
- UI interaction latency while background jobs run
- cancellation latency
- backup/restore time
- peak disk amplification
- peak memory
- restart/recovery time

Do not advertise performance numbers until measured on named hardware and a pinned commit.

## Quality benchmark

Keep the existing adjudication-driven benchmark idea.

Do not use the same model as an ungrounded judge of its own output.

Held-out evaluation should score at least:
- material fact recall
- precision/support rate
- attribution accuracy
- unsupported assertion rate
- false contradiction rate
- coverage honesty
- human review seconds
- runtime
- provider cost/usage when applicable

Competitive claims require real paired evaluation against named baselines. Synthetic fixtures only verify the harness.

## Release gates

A professional-release candidate is not done until:

- clean Windows build succeeds
- frontend tests pass
- Rust tests pass
- native sandbox tests pass serially and intended concurrency behavior is understood
- worker tests pass
- signed installer/release process is defined
- second-machine backup restore is demonstrated
- migration from prior supported case schemas is demonstrated
- crash/restart recovery is tested
- restricted evidence never leaks into unauthorized model/export/search paths
- accessibility/native UI checks are performed
- the complete protected journey passes
- benchmark limitations are documented

## Suggested execution sequence

1. VL-001 baseline/protected journey.
2. VL-003 viewer-context regression.
3. VL-004 authority-ingest regression/fix.
4. VL-005 backup/PDF restore regression/fix.
5. VL-002 durable case permissions.
6. VL-006 export pinning.
7. VL-007 automatic-run state machine.
8. VL-008/009 structured final-answer support coverage.
9. VL-010 extraction/transcript revisions.
10. Security/untrusted-rendering audit.
11. Measure current performance before optimizing.
12. VL-011 staging reuse.
13. Scheduler/cancellation.
14. Background revisioned indexing.
15. Snapshot/pagination/event-driven UI.
16. Transcript segmentation/virtualization.
17. Evidence-workflow UX improvements.
18. Provider capability contracts.
19. ACP integration.
20. Packaging, migration, restore and held-out release evaluation.

## Definition of done

Do not declare VisLex “finished” because code exists.

The release must prove, on a pinned commit and named environment:

import -> process -> exact search -> exact original navigation -> source-linked finding -> human review -> pinned export -> encrypted backup -> restore -> reopen.

The app must preserve provenance and restrictions through that complete loop, remain responsive under realistic case sizes, recover from interruption, and make its uncertainty/coverage limits visible.

Begin by revalidating this document against the actual current HEAD.