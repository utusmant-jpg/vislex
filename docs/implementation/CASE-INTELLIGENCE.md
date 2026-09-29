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

## Implemented contracts

- `intelligence.rs` owns persisted runs, modality units, retry attempts, exact proof references, revisioned knowledge and immutable answer candidates. Schema additions use `meta.case_intelligence_schema=1`; they do not consume a numbered `PRAGMA user_version` migration slot.
- The desktop dispatcher schedules one hidden analysis unit after required preparation settles. Foreground chat wins; safe app-stop/preemption resumes retain task delivery state. Uncertain transmissions are blocked from replay. Pause/cancel remain stopped until explicit resume.
- Text ranges cover all extracted lines, including exact Unicode fragments for long lines. Physical PDF pages, image frames, Office images, transcript pages, verified audio channels and overlapping video windows are separate inputs. Completion requires actual matching inspection receipts and observations of every supplied image.
- Five-child synthesis groups bound each dependency set to at most 500 findings. All original findings stay searchable; synthesis summaries do not replace their proof. A 1,100-finding production publication regression exercises this boundary.
- Transcript corrections invalidate the affected ordinal page and synthesis. Unchanged visual windows, audio signals and other transcript pages retain their unit identity. Source/case manifests still notice every correction. Publication and retrieval calculate the same unit stamps.
- Current knowledge excludes stale, unsupported, unreviewed or out-of-scope findings. Scoped briefs filter historical run metadata against current source permissions, including restrictions made before manifest reconciliation. Model support review and human review remain distinct.
- Both access routes receive the same knowledge-first brief and host-issued references. Saved candidate IDs keep review and publication bound to exact wording. Answers render ordinary prose with source citations; internal confidence labels and unsolicited next actions are no longer required.
- Jobs shows analysis coverage, findings, recorded usage, blockers and pause/cancel/resume/retry. Internal tasks do not create conversations. The header distinguishes extraction from analysis; the footer reflects the effective selected route/model. Activity counts distinct original source IDs.

## Coverage and release limits

The host accounts for every permitted source and records unsupported units as gaps. It does not claim an extractor can decode every structure. Office charts/embedded document objects, unrendered PPTX/ODT layout, additional video tracks, unknown PDF extent, decode gaps and missing/unsupported audio channel inventory remain explicit blockers. Older completed audio receipts missing channel counts are never silently treated as mono. These need supported extraction paths or verified replacement preparation before full coverage can become ready.

The native synthetic journey verifies automatic scheduling, hidden tasks, exact proof, human-edit reconciliation, controls and warm retrieval. It is not a real-model semantic accuracy test. See `CASE-INTELLIGENCE-HANDOFF.md` and NEXT-STATUS for commands, reviewer findings, commit references and unrun release gates. No client case was inspected or changed, and no installed/live app was replaced.
