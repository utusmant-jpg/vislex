# VisLex — current GLM implementation prompt

Repository: `utusmant-jpg/vislex`. Code audit base: `485882149585a1f2db34f1e7e9c29226758ba039` (15 commits after the earlier `9916bb9` audit).

## Mission

Improve the existing Windows evidence workspace, not a replacement application. Deliver a reliable source-to-finding-to-review-to-export workflow, fast enough for 40–60 GB cases, with precise historical citations and visible uncertainty. Keep the new workspace rail and theme. Fix integration regressions before cosmetic redesign or additional agents.

## Git setup — do this first

Use authenticated Git access already supplied by the coding host. Clone the private repository only if there is no clone. In an existing clone, inspect status, branch and HEAD before any write. Fetch origin. Fast-forward from origin/main only on a clean safe worktree; otherwise create an isolated branch/worktree from origin/main without overwriting, resetting or stashing somebody else's changes. Never force-push. Record the exact code base.

If the origin is not this repository, stop that checkout operation and use the correct isolated repository. Never run destructive cleanup on a case folder.

## Read little, but read the right material

Read AGENTS.md, this prompt and NEXT-PLAN.md once. Run:
```
python scripts/vislex_plan.py check
python scripts/vislex_plan.py next
python scripts/vislex_plan.py packet R00
```
The helper prints one bounded task. Do not load the entire JSON task book, every historical roadmap, generated schema dump, binary or lockfile into the model context. Generate their inventory and inspect relevant provenance/diffs instead. Read complete relevant source files in manageable ranges and their callers before editing. Do not mistake a search hit or file hash for semantic review.

Use the first ready task, with R01/R02/R03 as the critical repair chain. R04 and other independent work may be parallelized only without overlapping writers. Do not restart already delivered context suppression, HTML ingest or basic schema-6 history.

Current verified-by-static-inspection hazards to reproduce:
- R01: real published transcripts are registered in artifacts AND scanned again by backup, creating duplicate archive paths. The test used unregistered files and missed it.
- R02: historical revision existence is checked, but ordinary citations and text locator bounds still resolve active extraction text.
- R03: token overlap, dropping `not`/numbers, a qualifier substring or an existing citation can wrongly cover an unrelated/contrary assertion. Use structured publication, not another NLP threshold.
- R04: reopen protection is improved, but the actual Settings UI and apply_app_settings still force grants/review options; direct-media opt-in is missing from the visible UI.

These are audit findings, not proof that later HEAD still contains them. Diff against the audit base first and revalidate only affected paths. Preserve newer correct work.

## Execution loop

For each selected packet:
1. State the current code invariant and minimal failing production-path regression or measured baseline. Keep this brief.
2. Read the packet's files and direct call sites. Record newly reviewed paths/hash/sections in the local review register.
3. Write the regression. A hand-built object that bypasses production publication is insufficient for an integration defect.
4. Implement the smallest coherent slice. If the packet spans several layers, use finite child commits with explicit interface contracts; do not claim the parent verified early.
5. Run changed-path tests and the existing protected journey; after shared-schema/contract changes run all affected suites. Native/worker tests must really run in a supported environment. Unavailable checks stay NOT RUN/BLOCKED.
6. Have a separate reviewer inspect the diff and adversarial cases. If no separate agent is available, do a separate review pass and state the limitation. Agreement among agents is not correctness evidence.
7. Inspect final diff for unrelated churn, secrets, weakened assertions, hidden uploads and changes to original evidence. Commit coherently on the implementation branch; push normally to the same repository when authorized by the host workflow, never overwrite main or other writers blindly.
8. Update NEXT-STATUS with state, tested commit, evidence path, environment, exact commands/exit codes, reviewer findings and unrun checks. `verified` requires the task's acceptance, not merely code or tests existing.
9. Continue to the next dependency-ready task during the active session without asking for a new prompt after each small fix.

If the host reaches a session limit, leave a durable handoff stating exact branch/HEAD, task, changed files, failing command, pending test and next command. Do not claim work will continue after the session ends. If blocked, explain the concrete prerequisite and move only to independent safe work. Do not wave through a dependency.

## Quality and token discipline

Keep a stable compact prefix and one active task packet. Reuse source knowledge while its hash is unchanged; refresh when a dependency changes. Do not ask every subagent to audit the entire repository. Give each one the invariant, file ownership and specific negative tests. Limit simultaneous writers to three, and serialize shared Rust/DTO/migration/lockfile changes.

Use GLM-5.3 `max` reasoning for difficult coding when supported by the host; do not blindly pass unsupported flags. Official documentation currently recommends `max` and describes GLM-5.3 as text-only. Real screenshot review therefore needs a human or an available vision-capable tool, not a fabricated visual inspection. Source checked for this handoff: https://docs.z.ai/guides/llm/glm-5.3 . Recheck if configuring a different version/host.

Reduce redundant context and retries, not reasoning quality or tests. Never replace detailed acceptance with 'make it better', spawn agents to vote, or rewrite working subsystems for aesthetic consistency.

## Nonnegotiable boundaries

No real client evidence, case databases or credentials in coding prompts, repository fixtures, telemetry or public CI. No silent broadening of cloud permissions, model-quality downgrade, forced spending cap, unrestricted worker, writable hardlink to originals, fake human approval, or undocumented API billing fallback. Keep legacy evidence readable; unknown provenance is labeled unknown, not guessed. Tests cannot be deleted or weakened merely to turn green.

The endpoint is R23's measured packaged Windows journey, not 'all files edited'. R20 subscription ACP is optional and MCP remains deferred. Treat current source plus the task contracts as authoritative; old plans/LEDGER are history, not a reason to repeat completed work.
