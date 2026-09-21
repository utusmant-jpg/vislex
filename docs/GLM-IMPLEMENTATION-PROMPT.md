# GLM-5.3 execution prompt for VisLex

This file is designed to be read after pulling the repository. The repository plan is docs/VISLEX-ULTRA-IMPLEMENTATION-PLAN.md.

## Required repository setup

Work against the private GitHub repository utusmant-jpg/vislex.

If there is no local clone, clone it with the authenticated Git credentials available to the host, then enter the repository.

If a clone already exists:
- inspect git status before doing anything
- never delete, reset, overwrite or stash user work without authorization
- git fetch origin
- update from origin/main using a safe fast-forward only when the current worktree is clean and doing so will not destroy work
- never force-push

Record the exact branch and HEAD before editing.

## Required first read

Read, in this order:
1. docs/VISLEX-ULTRA-IMPLEMENTATION-PLAN.md
2. README.md
3. docs/EVIDENCE-DESK-IMPLEMENTATION.md
4. docs/VERIFICATION.md
5. docs/SECURITY.md
6. .github/workflows/ci.yml
7. package.json
8. src-tauri/Cargo.toml
9. the current source/tests relevant to the first ticket

Repository source is authoritative. The plan was produced from an earlier audit and must be revalidated against the current HEAD before every fix.

## Your role

Act as the implementation coordinator, not as a one-shot code generator.

Use GLM-5.3 at the highest practical reasoning setting available for difficult architecture, Rust, concurrency, migrations and cross-file changes.

Use actual subagents/worktrees if the host provides them. Do not pretend subagents ran if the host only supports one process.

Preferred structure:
- one coordinator
- up to three implementation agents on disjoint file areas
- one independent reviewer/tester

Do not allow multiple writers to concurrently modify database migrations, case.rs, desktop.rs, agent.rs, shared DTOs, lockfiles or packaging config.

## Start now

First:
- inspect git status, branch and HEAD
- compare current HEAD to b673ad77a8a2b22d0be098587b08bc0538b5c76b and 9916bb9e0286bd6871d56c8873f62276affc42b2
- inspect recent commits so you do not undo newer work
- run/characterize the current test baseline
- establish docs/implementation/ as the small canonical execution ledger if an equivalent current mechanism does not already exist
- begin VL-001
- then implement dependency-ready P0 tickets in the order in the plan

For each ticket:
1. reproduce/revalidate
2. read complete relevant files/call sites
3. write the smallest regression or baseline measurement
4. implement narrowly
5. run relevant tests
6. independently review negative cases/races/restrictions
7. record exact verification
8. commit coherently
9. rerun the protected journey after integration

Do not start another whole-app redesign. Preserve the new workspace UI. Do not weaken evidence integrity, permissions, source restrictions, review gates or the worker sandbox for convenience.

Continue autonomously through dependency-ready work during this coding session. If something is blocked, record the exact blocker and move to an independent safe ticket rather than repeatedly asking broad questions.

The end-state gate is:
import -> process -> exact search -> exact original navigation -> finding review -> pinned export -> encrypted backup -> restore -> reopen.

Do not claim a test passed unless it actually ran successfully.