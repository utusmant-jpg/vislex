# Claude, Codex and Z.ai in VS Code

Open this repository in VS Code and use its **Claude Code** panel. Start a new conversation after changing project commands, then enter `/team <your task>`. Claude coordinates actual CLI workers and reviews their results. This does not take over existing Codex desktop chats.

## Accounts and models

- Claude Code uses your existing Claude Max login. Do not change its Anthropic endpoint to Z.ai.
- Codex CLI uses your existing ChatGPT login and configured model/reasoning. `codex login status` checks it.
- OpenCode uses the **Z.AI Coding Plan** provider, `zai-coding-plan/glm-5.3`, with max reasoning. Credentials are in the user's native OpenCode credential store, outside this repository. `opencode auth login` can replace the credential; select **Z.AI Coding Plan**, not the separately billed Z.AI provider.
- The ZCode app remains independently available. Its stored Coding Plan token was tried locally but rejected by the platform with HTTP 401. Use your Z.ai platform API key for OpenCode instead. No secret was added to source files. A ZCode login alone is not the same as a valid OpenCode API credential.
- GLM-5.3 is text-only. Use Claude or an actual vision tool for visual inspection. Provider quotas still apply; reported zero API cost does not mean zero subscription usage.

## Worker commands

On Windows ARM64, OpenCode 1.18.33's interactive terminal renderer fails with `bun:ffi dlopen() ... TinyCC is disabled`. Use `opencode web --hostname 127.0.0.1 --port 4096 --pure` for the graphical interface, or the **Agent team: Open GLM web interface (Windows ARM64)** VS Code task. The local UI is at `http://127.0.0.1:4096`. The `run` worker command does not initialize that renderer. This is an upstream compatibility issue, not a Z.ai key error: https://github.com/anomalyco/opencode/issues/38520 .

To enter the Z.ai key locally, select **Terminal > Run Task > Agent team: Connect Z.ai Coding Plan** in VS Code. Paste the platform API key at the hidden prompt and press Enter. Alternatively run `python scripts/agent_team.py connect-zai` in your terminal. Do not paste it into Claude or Codex chat. This preserves other OpenCode credentials and replaces only the Coding Plan credential. Account limits still apply.

```powershell
python scripts/agent_team.py doctor
python scripts/agent_team.py run codex --task-file .agent-team/packets/review.txt --mode review
python scripts/agent_team.py run glm --task-file .agent-team/packets/build.txt --workspace "C:\path\to\isolated-worktree" --mode build
python scripts/agent_team.py status <run-id>
python scripts/agent_team.py cancel <run-id>
```

Claude can run the worker command in the background using its shell tool. Each run saves the packet, JSON events, stderr, result, session ID and reported usage under ignored `.agent-team/runs/<run-id>/`. A follow-up uses a new packet referencing the prior result and precise remaining work. Ctrl+C also cancels a foreground run. Runs do not share conversation memory automatically.

Review mode denies edits (Codex read-only sandbox; OpenCode review agent also denies shell execution). Builds require a separate registered worktree of this repository. Codex retains its sandbox. OpenCode uses tool permissions rather than an OS sandbox, denies external-directory access and public session sharing, and prompts/blocks unapproved shell operations. Claude should run any necessary blocked check itself after inspecting the command. Never use bypass-permissions flags to work around a failure.

Task packets must contain the task and owned files, relevant current source, invariant, acceptance commands, prohibited changes, and the expected evidence report. Keep client evidence and credentials out of packets. The manager must coordinate file ownership; the helper does not lock files or merge branches. Exit zero means the CLI completed, not that the task is correct. Claude must inspect the diff, actual test evidence and reviewer findings before accepting a change. Human-review gates and the existing implementation queue remain authoritative.

## Setup evidence

Installed on Windows ARM64: Codex CLI 0.158.0 and OpenCode 1.18.33. Existing Claude Code extension 2.1.284 is authenticated with Claude Max. Codex reports ChatGPT authentication. OpenCode lists a Z.AI Coding Plan credential and GLM-5.3. VS Code's Claude panel is active after the user trusted this folder. Live worker verification is recorded below after testing; these setup checks do not verify a VisLex implementation ticket.

- Codex live smoke run `20260928-201528-465b0b38`: exit 0, exact result `TEAM_WORKER_OK`; session and actual usage saved locally.
- GLM smoke run `20260928-201528-18048801`: HTTP 401, token expired or incorrect. The ZCode token is not a verified platform credential. Awaiting local platform API key entry; GLM connectivity remains blocked.
- Independent Codex setup review `20260928-201653-944b7dff`: six findings. Corrected primary-worktree rejection, startup preparation order, stdin cancellation, termination failure reporting, cancellation-status preservation, and alternate OpenCode grep/rg access paths. OpenCode workers use file reads/globs rather than unrestricted content-search tools; these permissions are not an OS sandbox.
- `python scripts/test_agent_team.py`: five launcher behavior tests passed after correcting the process harness. Covers primary-build rejection, evidence-path traversal, non-mutating status, provider errors despite CLI exit zero, and actual child-process cancellation. These tests are not provider or VisLex acceptance results.
- `opencode web --hostname 127.0.0.1 --port 4096 --pure`: web service started. `/global/health` returned `healthy: true`, version `1.18.33`; listener verified on `127.0.0.1` only. The ARM64 terminal renderer remains unsupported in this installed build.
- Claude-to-worker end-to-end dispatch and an isolated build remain unverified. No implementation queue ticket is marked complete by this setup.
