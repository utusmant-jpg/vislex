# VisLex: Claude Code project instructions

Read and follow `AGENTS.md` and `docs/GLM-IMPLEMENTATION-PROMPT.md` before work. Read `docs/implementation/NEXT-PLAN.md` once and use the bounded task helper rather than loading the whole historical task book. Inspect current branch, HEAD, status, and relevant current source; preserve newer working changes.

The user's redesign brief is `docs/CLAUDE-REDESIGN-PROMPT.md`. It explicitly authorizes Claude to research, use actual parallel agents, make its own design plan, and implement a comprehensive visual and interaction redesign of the existing application. This changes the earlier preference to retain the exact theme/rail; it does not relax any evidence, security, permissions, review, or compatibility invariant. Reconcile the redesign with the existing implementation queue, recording genuine dependencies and blockers rather than declaring old tickets complete.

Preserve Tauri/Rust/React/SQLite/Python, original bytes and IDs, immutable revisions, case grants, restricted derivatives, provenance, human-review gates, Windows AppContainer, and working workflows. Never replace the application or create a second source of truth. Claude Max used for development is separate from the app's runtime provider configuration; do not insert subscription credentials into VisLex.

One writer at a time for shared files, especially case.rs, desktop.rs, agent.rs, migrations, DTOs, central styles, and lockfiles. Parallel research/review is welcome; parallel implementation requires isolated worktrees and explicit ownership. Never reset/stash user work, force-push, weaken tests, expose case data, fabricate agent activity, or claim unrun tests passed. Coordinate before another coding tool writes to this checkout.

UI changes need meaningful interaction and accessibility checks, not screenshots alone. Measure performance before claiming gains. Preserve usage visibility and cancellation without arbitrary spending caps or model downgrades. Runtime MCP remains deferred and ACP remains optional; research development MCP tools separately without exposing real evidence.

Record actual evidence, tested commit, reviewer findings, and blockers in the existing NEXT-STATUS format when implementing queue work. Keep redesign progress and decisions in a separate durable handoff. Implemented is not verified; no tests certify legal accuracy or guarantee zero bugs.

## Claude-led development team

Claude is the coordinator. Use `/team` and `docs/AGENT-TEAM.md` to delegate bounded development tasks to actual Codex CLI or OpenCode/Z.ai workers through `python scripts/agent_team.py`. Use `doctor` before dispatch. Codex retains the user's configured model and ChatGPT authentication; GLM uses only `zai-coding-plan/glm-5.3` with max reasoning. Never switch Claude's provider to Z.ai or insert development credentials into VisLex.

Every task packet must state the task, owned files, invariant, acceptance checks, and expected report. Read-only reviews can use this checkout; builds require a separate registered worktree of this repository. Preserve uncommitted work. Use isolated worktrees and coordinate shared-file ownership before edits. Wait for actual worker results, inspect their diffs and test evidence, and request corrections before accepting them. When useful, have the other provider review a change, then perform your own final review. Do not force every trivial task through all three models.

Run the helper through the shell tool; background execution is supported by the host shell tool. It saves local events, usage, session IDs and results in ignored `.agent-team/runs/`. To stop a run, use its `cancel` command. Do not read credentials or expose case data. No API billing fallback, arbitrary spending ceiling, lower-quality model substitution, or bypass-permissions flag is part of this workflow. CLI delegation does not control existing Codex desktop chats.
