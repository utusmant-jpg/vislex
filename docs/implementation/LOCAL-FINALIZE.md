# Finalizing on Windows

The cloud session built and tested this branch on Linux only. This page is the handoff to a local Claude agent on the user's Windows machine, which can run what the cloud cannot: the packaged worker in the AppContainer, the MSVC desktop build, the ignored sandbox tests and the native journeys.

GitHub Actions has never started a run on this repository. Every run reported `runner_id 0`, which points to an account billing or runner setting. That is the user's to fix and does not block local verification.

## Prompt for the local agent

Paste this into Claude Code on the Windows machine, from the repository root.

```
You are finishing and verifying work on VisLex on this Windows machine. Read CLAUDE.md,
docs/GLM-IMPLEMENTATION-PROMPT.md, docs/TESTING.md, docs/implementation/FUNCTIONAL-PLAN.md
and docs/implementation/LOCAL-FINALIZE.md first. Do not reset, stash or force-push, do not
weaken tests, never use real case data, and never claim a check passed that you did not run.

Branch: claude/stoic-ride-1c8hns (a fast-forward of claude/redesign-v14qbo plus ~25 commits
by a cloud session). All Linux checks pass there; nothing has run on Windows. A separate
Claude design session owns UI files; coordinate via docs/implementation/SEAMS.md before
touching App.tsx, ui.tsx, SettingsDialog.tsx, EvidenceViewer.tsx, styles or lockfiles.

1. Sync: git fetch origin; check out claude/stoic-ride-1c8hns; confirm a clean tree and that
   HEAD matches origin. If local work exists, stop and ask the user.

2. Tier 1 (record exact command, exit code and counts for each):
   npm ci; npx tsc -p tsconfig.json --noEmit; npm test -- --run; npx vite build;
   npx playwright test
   cargo fmt --manifest-path src-tauri/Cargo.toml --check
   cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --features desktop
   cargo test --locked --manifest-path src-tauri/Cargo.toml
   cargo check --locked --manifest-path src-tauri/Cargo.toml --features desktop
   cargo check --locked --manifest-path src-tauri/Cargo.toml --features subscription
   python scripts/vislex_plan.py check

3. Tier 2 (packaged worker and sandbox):
   - Run scripts/build-worker.ps1. Confirm the bundle contains the new worker modules
     email_extract, docx_extract, pptx_extract, xlsx_hidden and media_clip
     (they are imported inside functions; check PyInstaller picked them up).
   - Regenerate fixtures (scripts/generate-fixtures.py, scripts/generate-audio.ps1), then
     cargo test --locked --manifest-path src-tauri/Cargo.toml --test sandbox -- --ignored --nocapture --test-threads=1
     and the worker_video_e2e test with -- --ignored.
   - In the packaged worker, process a synthetic .eml, a .docx with a tracked insertion,
     a reordered .pptx with notes, an .xlsx with a hidden row/sheet, a >10 MB .txt, and a
     media_clip of fixtures/generated/synthetic-speech.wav. Check the outputs match
     workers/test_*.py expectations.

4. Native journeys against a built debug app: scripts/native-acceptance.ps1,
   native-integrity-acceptance.ps1, native-consent-acceptance.ps1, native-large-session.ps1,
   native-provider-race.ps1, native-concurrent-chats.ps1, native-protocol-origin-test.ps1.
   Windows-specific risks to watch:
   - evidence:// range serving now hashes via a cached descriptor (commit cb0798d);
     video scrubbing and PDF pages must still load, and exports must still reject a
     tampered artifact.
   - The ChatGPT-subscription route is compiled out by default (11fb451): the UI must show
     the "subscription route disabled in this build" blocker and make zero provider calls.
     native-codex-account-test.ps1 needs --features subscription.
   - Legacy key commands were removed (ae351e5); the OpenAI key must still save/load via
     provider_key commands under the credential name openai-api-key.
   - Second opinion is off by default; with no grant, the transcript panel must never send.
     Do NOT send any live request unless the user explicitly authorizes a synthetic probe.

5. Fix what fails. Root-cause each failure; small commits with the trailer
   "Agent: local-claude-finalize". A failure that is Windows-only and outside this branch's
   diff: record it as a blocker instead of widening the change. Re-run the affected tier.

6. Record evidence in docs/implementation/NEXT-STATUS.json (Windows version, rustc, commit,
   commands with counts, what remained unrun). Move R26, R28, R29 or R30 to "verified" only
   if every acceptance line of that task is met; otherwise keep "implemented" and list gaps.
   Run python scripts/vislex_plan.py check and push to claude/stoic-ride-1c8hns.

7. Report to the user: what passed, what failed and was fixed, what is still blocked, and
   whether the branch is ready for a PR into claude/redesign-v14qbo. Open that PR only if
   the user asks. GitHub Actions never starts runs (runner_id 0); that is an account
   billing setting for the user, not something to work around.
```

## What changed on this branch and what Windows must confirm

| Commit | Change | Task | Windows risk to check |
|---|---|---|---|
| b9ccf2e | Settings opens on the section a chat link names | R21 seam | Native settings journey |
| c018007 | OpenRouter error chunks, search-model refusal, reported cost | R26 | Provider race and concurrent chats journeys |
| c804ac6 | Backups restore across artifact-format versions; `CASE_SCHEMA` const | Phase 0.4 | Backup and restore of an older case |
| 8a24e52 | Linux CI tier in `ci.yml` | R25 | None locally; blocked by billing |
| 2cc0002 | Low-confidence transcript words | R30 | Real faster-whisper output carries word probabilities |
| 11fb451, fbdcf22 | ChatGPT-subscription route compiled out by default | R20 area | Blocker shown, zero provider calls; `--features subscription` still builds |
| ca1eb3f | Only dependent records go stale on text changes | Phase 1 #5 | Integrity journey |
| cb0798d | Protocol serves display artifacts from a cached hash | Phase 1 #1 | Video scrubbing, PDF pages, protocol-origin test, tampered export refused |
| ae351e5 | Legacy OpenAI-only key commands removed | Phase 7 | OpenAI key saves and loads through the provider key commands |
| 8a93ccc, e8fbf87, 6576ce3 | Second-opinion triage, clip worker, grant, confirmed send, panels | R28 | `media_clip` runs in the AppContainer; nothing sends without a grant |
| 89c0d30 | Only superseded revisions are labelled historical | R02 area | Historical citation journey |
| 51309a6, 3e145f8 | OpenRouter catalogue by capability; reasoning effort for vendor models | R26 | Settings model list with a real catalogue (synthetic key only if authorized) |
| 1225158 | Text originals over 10 MB readable page by page | R29 | Large text file opens in the app |
| 0476d80 | `.eml` extraction in the sandbox | R29 | Worker bundle includes `email_extract` |
| 56f6a3d | DOCX keeps tracked insertions; lists changes, comments, notes | R29 | Worker bundle includes `docx_extract` |
| 6f3eb60 | PPTX presentation order, hidden slides, speaker notes | R29 | Worker bundle includes `pptx_extract` |
| 9fcbd50 | XLSX hidden sheets, rows and columns | R29 | Worker bundle includes `xlsx_hidden` |

Linux results for the tested commit are in `docs/TESTING.md`. Task evidence and unrun checks are in `docs/implementation/NEXT-STATUS.json`.
