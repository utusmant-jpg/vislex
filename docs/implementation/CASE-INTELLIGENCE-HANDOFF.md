# Case intelligence merge handoff

## Checkout and ownership

- Base: `2ebc7addc4531caccfecadfd63525b08b56a0a02`.
- Branch: `codex/case-intelligence`.
- Worktree: `C:/Users/Muhammad Tariq - ONU/.codex/worktrees/case-intelligence/New folder (3)`.
- Tested code head: `e4179e4ef250b7d3df063da809dc33a7276b2771`. The following documentation commit only records evidence.
- No merge, push, installer replacement or change to the primary checkout was performed. Its pre-existing Cargo.toml edit was left alone. All app journeys used separate synthetic cases and debug test settings; no client case or live credential was used.

| Commit | Purpose |
|---|---|
| `2edea28` | CAI task namespace and scope/grant/task-purpose tool availability |
| `ac8b492` | Worker modalities, structured preparation metadata, read-only media lease reuse and synthetic fixtures |
| `207d13c` | Persisted analysis, exact references/candidates, retrieval, scheduling, recovery and native regression harness |
| `e4179e4` | Analysis status/controls, effective model display and distinct original-source activity counts |

`CAI-01` through `CAI-08` are separate from Claude's numbered R tasks. Existing R entries were not renumbered or changed. SQLite additions use `meta.case_intelligence_schema=1` and uniquely named tables; `PRAGMA user_version` and CASE_SCHEMA were not bumped.

## Merge rules for Claude

1. Inspect the destination branch and local changes. Merge this local branch in a clean integration checkout without resetting/stashing another writer's changes. Do not cherry-pick only the UI: it depends on the backend snapshot and commands.
2. Resolve shared `agent.rs`, `automatic.rs`, `case.rs`, `desktop.rs` and DTO changes semantically. Keep the new `intelligence::next_task` dispatcher as the single automatic analysis scheduler. Legacy automatic chats and receipts remain historical data; they must not launch a competing review loop.
3. Preserve source/session fences, immutable revisions, exact support review, human review, restricted sources, uncertain-delivery refusal and Windows AppContainer. Do not resolve conflicts by dropping either branch's safeguards.
4. Merge NEXT-TASKS/NEXT-STATUS by task ID. Retain both branches' R history and all CAI evidence. `implemented` does not mean `verified`.
5. Rebuild the worker from merged sources with `scripts/build-worker.ps1`. Ignored local worker/model/build output is not in these commits. Retain the verified Codex sidecar source/pin/package from the destination branch and validate it through its existing boundary gates. This task's native executable bundled the worker only; it is not a release installer or a bundled-sidecar certification.
6. Re-run the commands below after conflict resolution. A new input/route/model change must invalidate the appropriate units; a human edit must remain preserved and cause dependent analysis to refresh. Do not promote a source to ready while permanent coverage blockers remain.

## Resulting runtime contract

Extraction and discovery settle first. The host then inventories permitted source units, dispatches bounded hidden model tasks, requires exact input-linked inspection receipts, publishes typed versioned findings, reviews each exact finding and synthesizes sources through a bounded dependency tree. New automatic analysis creates no conversation or user prompt.

Ordinary questions retrieve current findings plus immutable original proof first on both API and subscription routes. Host-issued references avoid UUID reconstruction; saved candidate IDs bind review and publication to exact wording. Answers omit bracketed internal labels, generic confidence announcements and unsolicited next steps. Relevant ambiguity still appears in natural prose when needed for a truthful answer.

Foreground chat preempts safely; pause/cancel persist; uncertain transmissions never replay. Selected model/route/effort and reported usage stay visible. Transcript corrections revisit their ordinal page and synthesis while reusing unchanged video windows, sound scans and other pages. Jobs displays extraction, analysis and human review separately.

## Verification on Windows

Recorded at 2026-09-29 03:03 UTC (2026-09-28 in America/Toronto), isolated x86_64-pc-windows-msvc checkout on this Windows machine; rustc 1.98.1, Node 24.14.1, Python 3.11.15.

| Command / journey | Actual result |
|---|---|
| `npm ci` | exit 0, 232 packages, zero audit vulnerabilities |
| `npm run test` | exit 0, 317 tests / 32 files |
| `npm run build` | exit 0; existing Vite bundle-size warning remains |
| `npx playwright test` (PW_PORT=4178, CI=1) | 54 passed, 5 initial page-load timeouts during a concurrent cold native build |
| `npx playwright test --last-failed --workers=1` with same port/config | exit 0, all 5 failed cases passed; all 59 covered, no assertions/timeouts weakened |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --test case_intelligence` | exit 0, all 25 passed, including the 1,100-finding production publication/synthesis regression |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --skip synthesis_tree_publishes_over_one_thousand_findings_without_dropping_dependencies` | exit 0, 271 passed, 33 ignored; skipped stress test passed separately above |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --features subscription` | exit 0 with warnings, TAURI_CONFIG resource override; not a warning-free claim |
| PyInstaller worker rebuild using the existing pinned worker venv/models | exit 0; no new model downloads, source built from this worktree |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --test sandbox -- --ignored --nocapture --test-threads=1` | exit 0, 28/28 real packaged-worker AppContainer checks, including new physical-image/embedded-image and dense-video lease tests |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml --features subscription,tauri/custom-protocol` | exit 0 with TAURI_CONFIG worker-only resources; actual bundled frontend/debug native executable |
| `scripts/native-intelligence-acceptance.ps1` on that executable | exit 0: automatic ready, hidden tasks, exact proof, preserved human revision, human-edit reconciliation, pause/resume; 3 units / 3 findings |
| Warm native knowledge reads in the latest synthetic run | five reads, 22.6–28.5 ms; no additional mock-model requests, concurrent Rust test activity; not a large-case benchmark |
| `scripts/native-app-ai-acceptance.ps1` on the preceding branch debug build | exit 0: app defaults inherited, explicit override preserved, reopen inheritance retained, zero provider calls; defaults paths unchanged by final review fixes |
| `python scripts/vislex_plan.py check`, `git diff --check` | exit 0; schema/whitespace checks do not verify product behavior |

Final tested debug EXE SHA-256: `2CFE9662FC7EFCC0C7F66212C6D6A0554F7802D9C489E445B8A43543DE96371A`.
Rebuilt worker EXE SHA-256: `9DBC14D7CEF0E188BA29A12F8B7E87E44D856552DAE4D02AFA0DF44FEC0BCFE5` (its accompanying onedir runtime/models are also required).
Ignored local evidence: `artifacts/case-intelligence-rust-final.log`, `artifacts/case-intelligence-clippy.log`, `artifacts/native-intelligence-acceptance.json` and screenshot. These contain synthetic test data only.

The worker-only native test build used this PowerShell resource override. This is a debug fixture build; use the normal desktop packaging commands and verified sidecar for release acceptance.

```powershell
$env:TAURI_CONFIG='{"bundle":{"resources":["resources/worker/**/*"]}}'
cargo build --locked --manifest-path src-tauri/Cargo.toml --features subscription,tauri/custom-protocol
Remove-Item Env:TAURI_CONFIG
& scripts/native-intelligence-acceptance.ps1
```

## Review and open acceptance

A separate read-only reviewer agent inspected the diff and adversarial contracts. Its concrete findings were fixed: bounded synthesis dependencies, live permission revocation, human-edit wake-up, physical image rendering, tool catalogue parity, historical scoped-status filtering, unknown audio channels and overbroad transcript-correction invalidation. Final bounded review found no remaining concrete blocker in those fixes. The reviewer did not run tests; results above are the owner's actual runs. Static agreement is not legal accuracy evidence.

Release acceptance remains open. No real provider or ChatGPT subscription case turn, verified-sidecar installer journey, 40–60 GB case analysis, comparable cold-analysis/memory/API-usage benchmark, scaling or screen-reader matrix was run. Two-hour lease and 32 MiB publication benchmarks and ignored discovery/semantic/video-index suites outside sandbox were not re-run here.

Office charts/embedded document objects, unrendered PPTX/ODT structure, additional video tracks, unknown PDF extent, decode gaps and old audio receipts lacking verified channel counts remain explicit coverage blockers. The app accounts for these inputs and refuses full-coverage readiness; their extraction/inspection paths are still required for those source types. Full-case understanding means supported current inputs have been analyzed, not omniscience, continuous video perception or human/legal certification.

## Merge result (Claude, 2026-09-28)

Merged into `claude/merge-case-intelligence` (merge commit `cdb47ac`, main `172f850` + this branch `44e3b04`) in the isolated worktree `.claude/worktrees/merge-ci`. Not pushed and not merged into `main`. The primary checkout is untouched.

- Conflicts were resolved semantically. `available_tools` is now the single catalogue for both routes and includes main's research-browser tools only when `research::tools::exposed` allows them. Internal analysis tasks never get them. Research calls keep main's own `consume_result` gate, so switching research off mid-job still discards the stashed page.
- Two integration fixes came out of the separate review.
  - Research-browser captures are legal authority, not case evidence. Sources whose only occurrences come from research captures are excluded from automatic analysis runs. A regression test covers this and was confirmed to fail without the fix.
  - The intelligence acceptance script now sets `VISLEX_TEST_CASE_ROOT`, which main's test-mode case guard requires.
- The worker was not rebuilt. Its sources are byte-identical to this branch, so the existing build was reused after checking its hash (`9DBC…FCE5`).
- Results on the merged tree:
  - Frontend: 355/355 passed.
  - Rust (`subscription,research`): 348 passed, 0 failed, 36 ignored.
  - Clippy: exit 0, with warnings.
  - Native intelligence, research and app-AI acceptance journeys: all exit 0.
  - Playwright: all 67 covered. 6 cold-start load timeouts passed when re-run serially, with no changes to assertions or timeouts.
- Not re-run on the merged tree:
  - The AppContainer `--ignored` sandbox suite.
  - Everything listed under "Release acceptance remains open" above.
- Full evidence is in NEXT-STATUS `additional_work.CAI-MERGE-2026-09-28`.
