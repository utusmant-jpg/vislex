# Case intelligence implementation contract

Base: 2ebc7addc4531caccfecadfd63525b08b56a0a02. Branch: codex/case-intelligence.
Task namespace: CAI-01 through CAI-08; existing R tasks retain their identities.

## Approved behavior
Import -> extraction -> per-source analysis -> cross-source synthesis -> indexed knowledge -> answers.
The host owns a persisted manifest and bounded analysis units. No generated automatic chat appears in conversation history. Internal model instructions are versioned. Existing automatic conversations remain readable.
Every permitted source is accounted for. Documents retain all structural units and page/figure observations; audio retains tracks and transcript segments; videos use five-second windows, one-second overlap and initial ordered frames at 2 fps, with event/ambiguity refinement. Actual observations, sampling density and gaps are retained. Temporal traversal is not frame-by-frame or human review.
Store typed observations, attributed statements, events, entities, relationships, contradictions, hypotheses and legal issues in existing revisioned evidence objects. Each has exact evidence references, contrary evidence, input dependencies and distinct human-review state. Legal research uses authorized authority ingestion and known jurisdiction/date; do not guess law.
Questions retrieve current knowledge plus exact proof first. Reinspect only missing, stale, disputed or uncovered evidence or at the user's request. New wording retains exact support assessment. Normal answers lead with the answer, include detail when appropriate and place citations beside claims. No generic confidence labels, bracketed internal block labels or unsolicited next-action sections. Material uncertainty remains accurate natural language.
Model/route/effort stay selected; no cost cap or silent downgrade. Cancel and usage remain visible. Work runs while the app is open and resumes after reopening.

## Packets
CAI-01: Filter advertised and executable tools by the same scope/grant/route rules; distinct failure codes and full private receipt errors. Reproduce reported failures with synthetic sources.
CAI-02: Add additive analysis run/unit, evidence reference and candidate contracts using existing SQLite evidence/dependency/index systems. Test history, wrong owners, restrictions and backup/restore.
CAI-03: Persist dispatch/receipt/completion state; trigger after preparation settles; resume bounded work and yield to chat. Never replay uncertain deliveries or user cancellation.
CAI-04: Generate every required modality unit in host code. Only actual input-linked model results advance coverage. Reuse prepared artifacts and read-only media leases.
CAI-05: Publish typed knowledge, cross-source timeline/contradictions/legal issues, searchable indexes and precise input invalidation. AI-generated summaries cannot invalidate their own input stamp.
CAI-06: Same knowledge-first path for API and subscription. References are host-issued. Candidate IDs replace model reconstruction. Preserve exact-wording review and human gates.
CAI-07: Analysis status/controls/coverage/findings in Jobs; hide new internal jobs from chats; distinguish preparation, analysis and human review. Unique-source counts, recovered attempts and model/usage parity.
CAI-08: Full protected journey, migrations, permission changes, cancellation, case switching, provider protocols and packaged Windows/worker verification. Measure cold analysis, warm retrieval, memory, staging bytes and model usage on small/medium/40-60 GB synthetic cases.

## Verification
Use synthetic evidence only. Baseline from planning: 49 selected frontend and 36 dossier tests passed; no release certification. Every packet records actual commands and commit in NEXT-STATUS. Release stays open for unrun provider and packaged/large-case checks.
A separate diff-review pass is required; report whether it was a separate agent or a single-owner pass. Commit small coherent slices and provide Claude with a merge handoff. Do not merge main or alter the running primary checkout.

## Slice evidence
Tool availability slice: cargo test --locked --manifest-path src-tauri/Cargo.toml --test case_intelligence: exit 0, 2/2. Single-owner separate diff review checked both routes, live image revocation and task-purpose denial. Remaining reported-failure regressions belong to reference/candidate and coverage slices. No client case or provider was used.
