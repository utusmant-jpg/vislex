# VisLex next plan — integration first, then speed and workflow depth

Audit base: `485882149585a1f2db34f1e7e9c29226758ba039`. This is an implementation proposal, not a claim the app is fixed or certified. Use NEXT-TASKS.json through the read-only packet helper. RECHECK-2026-09-21.md records why the priorities changed.

## Keep the work already earned

Keep immutable sources, hash-addressed artifacts, versioned records, encrypted age backups, explicit source restrictions, sandboxed workers, source/clock uncertainty, provider adapters, action receipts, workspace rail and the token theme. Preserve the newly fixed viewer-context suppression and trusted public-authority ingest, the reopen/restore permission correction, PDF artifact recognition, export rechecks and schema-6 history.

Do not implement a second findings system. InvestigationWorkbench already hosts discrepancies, hypotheses, coverage, clock replay, legal workflows and QuestionDossier; extend them. Do not assume a backend feature is user-usable merely because a test calls its function.

## What should be different after this plan

A lawyer should import a messy production, immediately see what was preserved and what can be inspected, search it without waiting for a new embedding job, open the exact source supporting a statement, compare contradictory accounts without losing context, correct a transcript without overwriting the machine original, accept a specific finding, and export precisely that reviewed state. Backup and second-machine restoration must preserve the whole chain.

The main product measures are unsupported assertions avoided, time to verified evidence, time spent by the human reviewer, responsiveness during processing and recovery without data loss. More agents, more code and more animation are not measures of success.

## Wave 1 — close the new correctness gaps

R00 characterizes actual baseline rather than restarting the old work. R01 repairs the duplicate transcript backup regression. R02 makes historical citations truly revision-bound. R03 removes heuristic claim certification and introduces structured publication. R04 finishes actual consent/review controls. R05 fixes currentness/idempotence of automatic review. R06 repairs navigation/selection/dirty exports. R07 separates cached browsing from full integrity verification.

Gate: real publication -> revisioned citation -> accepted finding -> export -> backup -> restore uses the same source versions and permissions. No fuzzy string heuristic, generation flag or source hash alone substitutes for that invariant.

## Wave 2 — eliminate the expensive architecture paths

R08 introduces bounded queries and session fences. R09 moves large copy/hash operations outside the case mutex, with short atomic publication and crash recovery. R10 reuses verified read-only recording input rather than copying a whole movie for every one-minute chunk. R11 centralizes cancellable job scheduling. R12 publishes long transcripts as segments; R13 indexes revisions in the background.

The current 60-second dual discovery passes imply about 240 full recording copies for a two-hour recording. For a hypothetical 10 GiB source that is roughly 2400 GiB of staged input writes before retries/extra EOF checks. This is an architectural calculation, NOT a measured benchmark. Eliminate the multiplicative factor while retaining the sandbox, hash verification and per-job output isolation.

Optimize in order: unnecessary I/O, long lock spans, payload/query growth, model startup/repeated decoding, and UI rendering. Do not spend a week micro-optimizing CSS while copying terabytes unnecessarily.

## Wave 3 — make the entire interaction feel coherent

R14 makes playback controls honest about exact frames, proxy transitions and clock domains. R15 fixes PDF count/geometry/prefetch/current-page behavior. R16 uses normalized case state, bounded lists, complete streaming answers and safe drafts. R17 enhances current findings and legal product workflows. R18 verifies redaction bytes and export boundaries. R21 applies responsive layout/accessibility/visual polish to these working paths.

Navigation contract: one typed target carries case/session, source or record, immutable revision, locator and optional source-relative time. Back/forward/tab/hover/search/Ask/export all consume the same contract. Viewport context cannot overwrite an explicit selected range.

Evidence inspector: source identity, exact excerpt/frame/interval, originating run/version, observed versus inferred status, contrary evidence, uncertainty, review decision and return-to-original. Every citation chip must open something meaningful and identify historical material explicitly.

Pane design: preserve rail, keep task workspace central, make evidence and chat panes resizable/collapsible, remember layout without persisting sensitive content in browser storage, and collapse into usable modes at small sizes. Comfortable and compact density must share semantic tokens; never fake density with illegibly tiny text.

State design: each action has empty/loading/queued/running/partial/failed/interrupted/ready/restricted states. Progress names its units (bytes, pages, decoded seconds, indexed passages); one decorative percentage must not conflate extraction, model inspection and human review.

## Wave 4 — providers, hardening and measured release

R19 improves provider-specific contracts/streaming and agent packet boundaries. R24 audits actual command/tool permissions and untrusted-input cases. R25 validates packaged workers and the Windows build. R22 measures evidence quality on held-out incidents. R23 is the full release gate. R20 checks optional subscription ACP only after safety boundaries; unsupported paths do not block the core release and must not become hidden credential proxies. MCP is deferred.

## Contracts to settle before parallel edits

- EvidenceLocation: source + immutable extraction/artifact revision + exact unit/range + navigation-only versus evidentiary use. Legacy ambiguity is explicit.
- CasePolicy: availability is not authorization; mode/grants belong to a durable case. Include version/epoch for dispatch and publication checks.
- Job: source/run/input version, operation/options/model manifest, attempts/dependencies/priority, typed status/reason, progress unit, cancellation and recovery record.
- AnswerDocument: typed blocks reference claim versions and assessment stamps. Edited factual wording needs assessment; citation existence is not support and support is not human acceptance.
- PublicationPlan: pinned source/derivative hashes, review receipt identities and entity revisions. Heavy bytes prepared outside the DB lock; commit revalidates the plan.
- QueryEnvelope: case ID/session epoch, response entity revision/event cursor, bounded payload and continuation. A late A response cannot mutate B.

Implement these as small explicit contracts in existing layers, not a generic framework or second database.

## Proposed measurement budgets — not current results

Reference tiers: small 25 files/~1 GB, medium 250 files/~10 GB, large 1000+ files/~40–60 GB. Record hardware, filesystem, Windows/WebView versions, commit and runtime/model versions. Do not commit the large media fixtures; keep reproducible generators and small fixtures.

Initial engineering targets to validate: cached UI p95 <100 ms; warm lexical p95 <250 ms; small recurring case summary <=256 KiB without record bodies; short publication-lock p95 <20 ms; bounded DOM and memory as a transcript grows; no discarded streaming prefix above 64 KiB; input staging approximately linear in source size. Targets can be revised with explicit measurements/reasons, never described as already achieved.

Track copy/hash bytes, worker launches, startup/first-usable time, total throughput, peak temporary disk/RAM, cancellation p50/p95/max, search quality, exact-source navigation and human review time. Separate decoder coverage from interpretation and reviewer coverage.

## Definition of a finished task

A narrow diff, production-path regression, negative cases, passing applicable tests, honest unrun checks, reviewer findings resolved, tested commit recorded and no contract regression. Existing tests may themselves encode a flawed invariant: replace such an assertion only with a documented stronger requirement and adversarial regression, not by removing coverage.

Use separate branches/worktrees for real independent writers. Share only concise evidence packets and interface decisions. One owner integrates case.rs/desktop.rs/agent.rs/migrations/DTOs/lockfiles. Read each file before changing it, but do not repeatedly send unchanged giant files to every agent.

Final acceptance requires packaged native interactions, no silent evidence/citation change, durable policy, long-case performance, accessible UI, privacy boundary tests, prior-schema migration and second-machine restoration. No plan can establish perfection or best-in-market standing by itself; comparative claims require appropriate measured evidence.
