# VisLex: current implementation instructions

Use `docs/GLM-IMPLEMENTATION-PROMPT.md` as the entry point. The current task queue is `docs/implementation/NEXT-TASKS.json`, based on code commit `485882149585a1f2db34f1e7e9c29226758ba039`.

Do not restart VL-001 or reread every historical design plan on each task. Read the current source for the selected task, its callers, and relevant tests. Earlier plans/LEDGER are historical evidence; the recheck corrects their completion assumptions without erasing history.

Commands:
```
python scripts/vislex_plan.py check
python scripts/vislex_plan.py next
python scripts/vislex_plan.py packet R01
```

Preserve Tauri/Rust/React/SQLite/Python, original bytes/IDs, immutable revisions, case grants, restricted derivatives, source provenance, human-review gates and Windows AppContainer. Do not rewrite the app, weaken tests, force-push, reset/stash user work, expose client data, or fake test/subagent results.

One owner at a time for case.rs, desktop.rs, agent.rs, migrations, DTOs and lockfiles. Use actual isolated agents/worktrees only when available. Commit small reviewed changes; performance refactors need measured baselines. UI changes need interaction tests, not only screenshots.

Update NEXT-STATUS with actual evidence, commit and remaining blockers. `implemented` is not `verified`. No script or passing test count establishes legal accuracy or product certification. No arbitrary API-cost ceiling or model downgrade should be added under the guise of this plan; retain usage visibility and cancellation. ACP is optional later work; MCP remains deferred.
