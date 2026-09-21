# VisLex: a question-driven evidence desk

Creative product and delivery plan — September 20, 2026.

Planning only. No application changes or runtime validation are represented by this document. This proposal builds on the existing app and the earlier platform plan; it does not restart the project or remove the complete-workspace requirements.

## 1. The experience to build

A lawyer asks: **“Did the officer open the door before giving the warning?”**

VisLex creates a small investigation dossier for that question. It finds the report's account, searches recordings for the warning, inspects the door sequence, checks other cameras, reconciles clocks, and presents the evidence side by side. If the sequence remains ambiguous, the dossier shows exactly why and what evidence would resolve it.

The main result is an inspectable answer, with supporting clips and passages, competing interpretations, missing coverage, and review history. Chat remains the command surface; durable case objects hold the investigation.

Product promise to test: **get from a consequential question to a defensible, inspectable answer with substantially less manual review.**

The app should feel active and capable: it can conduct a deep investigation autonomously, reuse earlier work, and keep investigating when a new document changes the picture. It should also make its limits easy to see. Thoroughness is demonstrated by the evidence record, not by the length of its response.

## 2. Six signature experiences

### A. Question dossiers

Every substantive question becomes a persistent object with an answer, scope, relevant sources, open checks, findings, and a review state.

The dossier first displays a useful provisional answer when available. It then updates through committed findings rather than replacing the whole narrative on every pass. Users can open any claim while other analysis continues.

Example dossier:

| Field | Example content |
|---|---|
| Question | Was the warning before the door opened? |
| Provisional answer | The ordering is not yet resolved across the two recordings. |
| Established within inspected material | Camera A shows an opening; Camera B contains a warning-like utterance. |
| Remaining check | Establish clock offset and inspect the uncertain words. |
| Evidence | Report paragraph, both clips, transcript alternatives, clock anchors |
| Next useful action | Compare shared radio audio across cameras |

These example findings are illustrative, not findings from an actual case.

The agent proposes task scope from meaning and available evidence. Ordinary targeted questions should not trigger exhaustive review of a 200-hour case. Requests such as “find every warning in all recordings” require an enumerated denominator and complete declared processing. A typed contract enforces the distinction; a keyword list does not.

### B. A discrepancy workbench

Import a report and choose **Compare with the evidence**. VisLex decomposes it into assertions, then builds a table with the original wording, source observations, assessment, and next check.

Possible assessments include supported within scope, direct inconsistency, possible inconsistency, omission, changed account, ambiguous wording, timing uncertainty, extraction error, and insufficient evidence. An omission is not automatically a contradiction. A camera failing to show an event is not proof it did not happen.

Selecting a row opens both sides in context. The user can challenge the proposed comparison, correct the transcript, split an assertion, or accept a narrower formulation. Show which person, event, time, and proposition must match for a discrepancy to be meaningful.

This becomes a primary workflow for report review, witness preparation, and comparing successive accounts. Each workflow reuses the same evidence/claim machinery.

### C. Synchronized incident replay

One playhead drives aligned recordings, transcript turns, sound candidates, and relevant document references. A **Show this moment on other cameras** action opens the corresponding windows with alignment uncertainty visible.

The user can switch between source time and estimated incident time. Display uncertain event spans as intervals, not artificially exact points. If clocks are unresolved, keep the recordings separate rather than animate a false synchronization.

Event cards expose evidence separately: what was heard, what was visible, what someone reported, and what was inferred. For a knock candidate, provide the original sound, waveform detail, surrounding clip, impact-count uncertainty, and any alternative explanation.

Provide quick controls for before/after context, loop, original speed, frame stepping, channel selection, and comparison against an analysis derivative. Keep originals immediately accessible when enhancement is used.

### D. Competing-explanation mode

For disputed material issues, the user or agent can ask **What else fits this evidence?**

Create a small table of plausible explanations, distinguishing predictions, inspected evidence, and discriminating checks. Prioritize a check that could actually change the answer. Examples include another camera, an earlier interval, a different audio channel, or the source document behind a copied allegation.

Avoid generating elaborate unsupported alternatives. A proposed alternative needs a clear connection to the available evidence or a specific unresolved premise. Avoid credibility scores, guilt scores, or automatic identity conclusions.

A blind first-look reviewer examines appropriate original evidence before seeing the lead account. A subsequent critic compares the actual claims. Their agreement is not extra corroboration; both might rely on the same flawed source.

### E. A coverage map with a “next best check”

Show useful coverage by document units and recording intervals: imported, decoded, extracted, retrieved, machine-inspected, claim-checked, and human-reviewed. Each state has its own meaning.

The map identifies failed pages, unprocessed channels, sparse visual samples, uncertain transcript spans, missing attachments, and restrictions. It then proposes the next check most likely to resolve a material open question.

Examples: **“The second camera has not been inspected during this event”** or **“The claim depends on one uncertain word.”** These are actionable gaps. Avoid a single “case understanding: 92%” score, which would imply knowledge the system cannot measure.

For ordinary work, the user sees a short progress statement and a gap count. The detailed map is available on demand. Do not make the main screen a dense technical dashboard.

### F. “What changed?” case updates

After a new recording, corrected transcript, or revised clock mapping, show:

- Findings that still stand under their existing scope.
- Findings that need rechecking and the dependency that changed.
- New candidate discrepancies or corroboration.
- Draft paragraphs that require an update.

Reinvestigate the affected questions, not the whole case automatically. A new source changes a case-wide coverage claim but does not erase a correct transcription of an existing source.

Store historical answer versions so a lawyer can see exactly what an earlier report relied on. Support and exposure lineage remain distinct: two sources may support a claim while additional confidential sources influenced the session context and constrain export.

## 3. The underlying intelligence

### A powerful model gets a better working environment

Keep a capable lead model with broad access to permitted case tools. Add durable question state, evidence packets, precise source locators, inspection history, and a queue of unresolved checks. The model can decide what to inspect next without repeatedly reconstructing the case from chat.

Use a staged loop:

1. Understand the question and propose a scoped investigation contract.
2. Retrieve candidate evidence across modalities and source families.
3. Inspect originals where the conclusion depends on perception or exact wording.
4. Build or revise claims with supporting and contrary evidence.
5. Identify the most consequential unresolved premise.
6. Perform a useful discriminating check, or state why it is unavailable.
7. Submit a specific draft and claim set for review and completion validation.

Allow parallel independent work when it improves elapsed time or discovery. Do not require a team for a simple source question. Benchmark a strong single-agent configuration against specialist teams. Preserve existing single-provider functionality.

### Use direct media APIs and local tools together when warranted

The lead agent can call a video model as one tool while retaining all case context. Local decoding, exact frame selection, audio processing, and timestamp mappings remain available for precision and verification.

Select the combination through a development benchmark. Compare direct video, the existing tool-based route, and the combined route on the same authorized fixtures. Measure missed short/silent events, sound/word recognition, source timing, false findings, latency, and cost.

Do not lock this product plan to an unverified model name or assume that a configured API model supports every modality. Treat availability, model quality, and deployment requirements as capability checks. New provider destinations and purchases remain subject to existing authorization.

## 4. Reliability mechanisms behind the experience

### Completion cannot be a model declaration

Add separate completion types for administrative reply, evidentiary answer, partial result, blocked, cancelled, and failed. Administrative answers can be citation-free. Material factual findings require structured claim assessments and source support or an explicit unresolved classification.

The final status is derived from the contract, evidence checks, and gaps. No semantic classifier can guarantee perfect detection of factual assertions; evaluate bypass cases, default ambiguous substantive answers to unreviewed, and never grant a supported status merely because a classifier called an answer administrative.

Test ordinary implicit visual questions, empty citations, inline-only citations, negative claims, failed processing, omitted tool pages, and free-text provider completion. The same gate must apply to every completion path.

### Review belongs to the exact artifact

Bind review to a canonical claim set, final draft digest, evidence/extraction revisions, scope revision, and relevant clock/entity mappings. Store reviewer result and policy version separately from human approval.

A material change invalidates affected assessments; final assembly always receives a fresh structural check. A previous task-level marker is insufficient. Permit reuse only for unchanged claims and unchanged dependencies under a documented rule. Start conservatively: invalidate on any substantive edit until semantic reuse is validated.

If reviewers request a correction, produce the new candidate and check it again. Avoid endless loops by distinguishing resolvable errors from evidence that remains ambiguous; the latter yields a qualified or partial answer, not repeated forced agreement.

### Long work does not occupy the app's control path

Prepare jobs under brief coordination, run outside the case lock, and publish through a durable protocol. Status, cancellation, playback, and navigation remain responsive. Copy/hash/decode operations check cancellation at bounded checkpoints.

Use indexed source lookups, batched statuses, paginated inventories, event-driven updates, and cached derivatives. Preserve integrity checks at defined boundaries; never infer trust from a filename or cache hit alone. Define handling for external source mutation and invalidate derived caches when integrity fails.

### Files and database recover together

Use durable job registration, staged outputs, validation, atomic filesystem publication where supported, transactional database registration, and startup reconciliation. Define recovery for each boundary, including disk-full and cross-volume behavior. Preserve recoverable outputs without exposing half-published findings.

Test process termination at every publication boundary. Each item must reappear as registered, resumable, quarantined for reconciliation, or visibly failed. A successful ordinary run is not a recovery test.

## 5. What the supplied audit establishes locally

The checkout reports commit `a08d7c5`, with additional uncommitted work. This planning pass performed limited source inspection, not runtime reproduction or a complete audit.

| Audit concern | Planning-pass observation | Next evidence required |
|---|---|---|
| Empty-citation completion | Current `finish_task` applies its extra support-review prompt only when citations are nonempty and mode is not ask | Regression covering every completion entry path |
| Review binding | Existing support check queries task-level prior review; team tests include changed-draft reuse | Draft/evidence mutation tests and precise review certificate design |
| Visual coverage trigger | Four prompt terms still trigger special handling | Meaning-based contract fixtures and enforcement tests |
| Source lookup scaling | `Case::source` still obtains the full inventory | Point-lookup regression and measured large-inventory profile |
| OCR absent | New uncommitted automatic OCR work exists | Inspect current extractor/output coverage and test packaged behavior |
| Bulk transcription cap | Working tree has changed; old numerical cap is not assumed current | Test 33+ sources, completed sources, duplicates, and cancellation against current code |
| Locking, timestamp mapping, publication recovery | Audit gives concrete risks; this pass has not reproduced them | Native fixtures, fault injection, responsiveness measurements |

Preserve ongoing changes. Recheck relevant files before implementation. Do not revert new work to fit an old audit or claim a source-level risk is a reproduced defect.

## 6. Build sequence: earn each added layer

| Phase | User-visible result | Engineering gate |
|---|---|---|
| 1. Trustworthy finish | Answers accurately show complete-for-scope, partial, or unresolved | Citation-free bypass tests; draft-bound review; scoped completion checks |
| 2. Responsive case | Work continues while the user views, navigates, and cancels | Short-lock job execution, point lookups, cancellation and recovery fixtures |
| 3. First question dossier | One report-versus-recording question produces inspectable claims and clips | Correct locator/playback mapping, assertion comparison, evidence packets, review screen |
| 4. Incident reconstruction | Other cameras and accounts open at the relevant event | Alignment fixtures, uncertainty propagation, sound/visual coverage, discrepancy workbench |
| 5. Continuing investigation | New evidence updates affected findings and drafts | Dependency/currentness propagation and exposure restrictions |
| 6. Complete legal workflow | Findings connect to issues, checked authorities, reviewed draft, and export | Jurisdiction/date handling, public-source authority checks, export/redaction/restore gates |
| 7. Competitive proof | A released build has measured workflow advantages | Clean-machine/native acceptance, held-out comparison, independent review |

The first implementation batch should be small: completion entry paths, exact-draft review binding, and point lookup, with a regression for each. Inspect contract/state compatibility before schema changes. Treat general lock refactoring and publication recovery as separately reviewable work packages. No cosmetic redesign or additional model integration should displace these priorities.

Prototype the dossier and comparison screen against a fixed synthetic case while defining contracts. Reuse existing viewers and inspectors. Add synchronized playback only after source-to-player timestamps are proven. Ship vertical working paths rather than a collection of disconnected panels.

Each implementation ticket needs one declared behavior, impacted paths, acceptance fixture, minimal patch boundary, verification command, and stopping condition. An implementation ledger records implemented, runtime-tested, benchmarked, and release-accepted separately.

## 7. The demonstration that should sell the product

Use an authorized, adjudicated mixed-evidence case: several cameras, a report, a witness statement, an uncertain utterance, a repeated location, and a clock offset. Include at least one apparent contradiction that disappears after proper alignment.

The user performs one workflow:

1. Import and inspect intake gaps.
2. Ask whether the report's key sequence matches the recordings.
3. Open the discrepancy table and replay the linked evidence.
4. Correct an uncertain transcript phrase.
5. Watch the affected finding reopen while unrelated findings remain current.
6. Add a missing recording and inspect what changed.
7. Export a reviewed account with factual sources, unresolved questions, and an issue matrix.

The demonstration passes only if it runs through the packaged app without developer repairs, hidden database edits, or hand-inserted conclusions. Record the exact build, model settings, external processing, failures, and time spent by the reviewer.

## 8. Evidence of advantage

Keep the earlier plan's held-out, incident-level comparison design. Evaluate current VisLex, a competent same-model agent baseline, direct-media processing, the proposed system, and actual competitor products when legitimately accessible. Do not treat unavailable competitor functionality or access as a win.

Prioritize material-fact precision/recall, correct attribution, false contradiction rate, coverage honesty, final-draft support, reviewer correction time, and complete-workflow time. Report cost and runtime separately. Repeat runs, blind reviewers where practical, adjudicate disagreements, and report case-clustered confidence intervals.

Use the earlier 15-percentage-point recall improvement at matched precision and 40% reviewer-time reduction as provisional objectives, not promises. Freeze final thresholds before the held-out evaluation. A result that misses the target informs the next version; it is not relabeled a significant win.

Subcomponent excellence is insufficient if the lawyer must repair the final workflow. Conversely, a smaller set of deeply integrated tools can be valuable if it reliably finds more relevant evidence and makes verification faster.

## 9. Full scope stays intact

Retain discovery/production tracking, public U.S. legal research, issue matrices, deposition preparation, contracts/redlines/obligations, motion and memo drafting, exhibits, redaction, encrypted backup/restore, and offline linked exports from the earlier plans.

The incident-investigation workflow provides the reusable foundation: propositions, evidence packets, dependencies, review, and scoped completion. Extend those same objects into the wider legal workspace rather than build separate incompatible tools.

Public-authority retrieval must preserve source passages, jurisdiction, relevant date/version, and treatment-check status. “Treatment not checked” remains visible. No public-source-only plan promises commercial-citator completeness.

Success is a system that can pursue a difficult question autonomously while letting a user inspect, challenge, correct, and reproduce every material part of its answer. The creative advantage is how these capabilities work together around a real investigation.
