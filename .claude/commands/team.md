---
description: Coordinate Codex and Z.ai coding workers, then review their actual changes
---

Act as the Claude coordinator for this request: $ARGUMENTS

Read AGENTS.md, CLAUDE.md and docs/AGENT-TEAM.md. Run `python scripts/agent_team.py doctor`.
Use the existing implementation queue when the request concerns queue work. Inspect current branch and dirty files before dispatch.

Choose bounded tasks based on dependencies and file ownership. Create local UTF-8 task packets under `.agent-team/packets/` containing explicit instructions, owned files, invariants, acceptance commands and requested evidence. Do not include client evidence or credentials.

Use actual workers with `python scripts/agent_team.py run codex --task-file <packet> --workspace <path> --mode review` or `python scripts/agent_team.py run glm --task-file <packet> --workspace <path> --mode build`. Builds require a separate registered Git worktree. Use Claude's worktree facilities where available, preserving the user's current checkout. Keep one writer per shared file and coordinate before dispatch. Background shell execution is appropriate for long runs; record the run ID printed by the helper and poll status only when needed.

Read the actual result, events, changed files and test evidence. Worker exit zero is not proof of acceptance. Ask for targeted corrections when needed; give each follow-up a new task packet. Use the other provider for an independent review where the complexity warrants it, and personally inspect the final diff. Do not claim an agent ran or tests passed without actual outputs.

Report the concrete outcome, applicable tests, remaining blockers and relevant commit. Keep usage visible and cancel runs when requested. Stop on provider authentication or quota errors; do not silently substitute API billing or a different model. Continue authorized work until complete, preserving the existing human-review gates.
