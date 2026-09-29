# Mocked-IPC Playwright harness

The browser preview (`/`, "Try the sample case") runs with `native === false`,
so chat, settings, jobs, the viewer's derivatives and most review surfaces are
unreachable there. The harness page `/harness.html` runs the **unmodified**
application entry (`src/main.tsx`) with `native === true` against an in-memory
synthetic backend, so Playwright can drive those real code paths.

Everything the harness serves is synthetic. Source bodies begin with
`SYNTHETIC — NOT REAL EVIDENCE`, names carry `(SYNTHETIC)`, and no real
evidence, person, recording or credential is involved.

## How it works

| Piece | Role |
|---|---|
| `harness.html` | Dev-only page. Same theme bootstrap as `index.html`; loads `src/testing/harness/entry.ts`. |
| `src/testing/harness/entry.ts` | Installs the harness, then `import('../../main')`. |
| `src/testing/harness/install.ts` | Sets `globalThis.isTauri = true` (what `isTauri()` in `@tauri-apps/api/core` reads, so `bridge.ts` computes `native === true`), calls `mockWindows('main')` and `mockIPC(..., { shouldMockEvents: true })` from `@tauri-apps/api/mocks`, overrides `convertFileSrc`, and exposes `window.__vislexHarness`. |
| `src/testing/harness/backend.ts` | `SyntheticBackend`: the `command` dispatcher (shapes follow `src-tauri/src/desktop.rs` and `case.rs`), `plugin:dialog|open/save`, `plugin:window|*`. |
| `src/testing/harness/fixtures.ts` | Deterministic synthetic cases: "Harbor Street" (250 sources across text, pdf, image, audio, video and email; restricted sources; very long names; 60 working files including reviewed, stale and locked ones; findings and clock proposals; transcripts with speaker turns; jobs in every state; cited conversation history) and a small "Riverside" case for switching. |
| `src/testing/harness/placeholders.ts` | Labelled SVG placeholders for images, rendered pages and sampled frames. Audio and video resolve to an empty `data:` URL so the viewer exercises its real "cannot decode" path. No original media is bundled. |

Behaviour the backend models because the app depends on it:

- `case_id` must match the open case (`Case changed before …`); a present `session_epoch` must match the current one, and mutations require it (`Missing session_epoch`).
- Every non-read command emits `case-event` `{case_id, session_epoch, event_seq}` then `case-changed`, as `emit_case_changed` does. Snapshots are stamped with `session_epoch` and `event_seq`.
- Paging returns 50 rows with the native cursors; `source_page`/`record_page` refuse a stale `generation`/`audit_seq`.
- `start_task` checks offline state, the text grant and the selected profile's grant, then streams `agent-progress` deltas. `stop_task` pauses the task with `Stopped by user` (as `agent::pause` does) and stops the stream.
- `open_case` bumps the session epoch and is refused while a task runs.
- `save_app_ai_settings` drops app grants when the default vendor changes without `grants_for_provider`; `save_ai_settings` (a case override) applies the same rule and refuses images without text, as `providers::apply_app_settings` does. `set_case_ai_scope` to `app` requires configured app AI (`Set up app AI first`).
- `resume_task` and `continue_paused_task` refuse during chat preparation (`setChatPause`) and for a task that is not paused. `continue_paused_task` also requires the default vendor's key, and keeps the paused task's conversation unless that chat was deleted.
- Cancelling a job records the backend's reason on it (`Cancelled by user`, `Processing cancelled before publication`), as `transcription::cancel` and `processing.rs` do.

## Running

```sh
# Linux/CI container with the bundled Chromium
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium PW_PORT=4191 CI=1 npx playwright test e2e/harness-*.spec.ts
# Interactive: start the dev server and open http://127.0.0.1:1420/harness.html
npm run dev
```

Query parameters: `?start=empty` opens with no case (onboarding); `?sources=N`
sizes the large case (8–5000) for scale checks.

Note for worktrees under `.claude/`: `vite.config.ts` ignores `**/.claude/**`
for file watching, so a long-running dev server there serves stale harness
modules after edits. Restart it (or run Playwright with `CI=1`, which starts a
fresh server).

## Scripting from a spec

`window.__vislexHarness` (typed in `e2e/harness-support.ts`):

| Call | Purpose |
|---|---|
| `calls(action?)` / `clearCalls()` | Call log with `args`, `outcome`, `error` and `result`. Assert grants, `case_id` and `session_epoch` here. |
| `hold(action)` / `release(action)` / `pending(action?)` | Late responses: the result is computed when requested (like the native dispatcher) and delivered on release. |
| `delay(action, ms)` / `fail(action, message, times?)` / `clearFailure(action)` | Latency and failures (rejections are strings, as Tauri delivers them). |
| `setScenario({ autoStream, stream: { chunks, intervalMs, complete }, lateDeltasAfterStop, dialogOpen, dialogSave, blockSwitchWhileJobsRun })` | Streaming and dialog behaviour. `lateDeltasAfterStop` (default 1) is how many text deltas still arrive within 150 ms of `stop_task`, as desktop.rs's cancellation poll allows. |
| `streamTask(taskId, options)` / `completeTask(taskId, answer?)` | Drive a running task by hand. Text deltas are `{ text }` only, as providers.rs sends them. |
| `toolCall(taskId, { name, argumentChunks, intervalMs })` | Script a provider function call in the OpenAI Responses shape: one `{ activity: name }` delta, then `{ characters }` (UTF-8 bytes) per argument chunk. Use real agent tool names (default `search_passages`). |
| `researchStep(taskId, { name, detail, args, output, recordAfterMs })` | A research job as desktop.rs reports it: one `{ activity, detail }` delta, then (unless `recordAfterMs` is null) its receipt in the task's actions. The task becomes the one `research_stop` pauses. |
| `emit(event, payload)` / `emitCaseEvent()` / `emitted(event?)` | Deliver arbitrary (including stale) events; inspect what was delivered. |
| `setJobProgress(jobId, progress, status?)` / `setChatPause(reason)` | Jobs and chat-preparation state. |
| `active()` / `task(id)` / `fixture` / `backend` | Inspect state; `fixture` holds stable ids used by the specs. |

Helpers in `e2e/harness-support.ts`: `openHarness`, `calls`, `lastCall` (waits
for a completed call), `axeViolations`.

## Specs

- `harness-assistant.spec.ts` — Enter/Shift+Enter and composer autosize, streaming states named with real units, neutral announced Stop, completion announcement and usage, activity receipts by keyboard, failure disclosure with composer-only retry, disabled-send reasons with the settings section, keyboard citation chips, and entrance motion only for the newly sent turn.
- `harness-chat.spec.ts` — compose, send, streamed tokens, Stop with the exact guard (late deltas after Stop do not revive the draft), scripted tool-call activity, completion with citations, citation chips opening exact (and historical) locators, draft retention across workspace and conversation switches without browser storage, chat preparation pause.
- `harness-settings.spec.ts` — appearance changes issue no IPC; saving never widens grants; model availability is not chat authorization; case override guard; save failure.
- `harness-case-switch.spec.ts` — held responses from the previous case are discarded; stale-epoch events and deltas are ignored; switch refusal is surfaced.
- `harness-jobs.spec.ts` — determinate progress only with reported totals; verbatim units; indeterminate fallback; recovery receipts and error routing.
- `harness-navigation.spec.ts` — every workspace; large-case paging; every source kind in the viewer; open-file tabs by keyboard; palette results by keyboard; records, findings and investigation surfaces.
- `harness-focus.spec.ts` — keyboard focus survives every tab close path, Send/Stop and modal errors (toasts render inside an open modal dialog); Alt+Arrow on a tab moves only the tab; checkbox focus rings and highlighted menu items under forced colours; a cancelled job's reason is neutral.
- `harness-research.spec.ts` — Settings → Research browser (per-case switch by keyboard, sign-in host validation from the backend, sign out) with axe in dark and light; the Browser rail entry's split view, the pane placement calls that follow the slot and the divider, the pane hidden while Settings is open and after leaving the view; the four-item cite-check before accepting a captured authority (`backend.seedResearchAuthority({ mismatch })`); research steps shown in the chat turn within a second of their event and listed once after the receipts arrive, the toolbar Stop (`research_stop`) reached by Tab and pressed with Enter, its failure reported, and the chat Stop still working alone. The native research webview is not part of the harness.
- `harness-a11y.spec.ts` — axe WCAG 2.x A/AA over native-only states in dark and light, with a named baseline of known violations in shared code.

Known app issues are encoded as `test.fail` (the test passes while the issue
exists and fails once it is fixed, prompting removal) or as named entries in
the axe baseline. Current entries: none. Resolved by the assistant redesign and removed: a user Stop rendered as an
error alert; the chat token count missed 4.5:1 contrast in light theme.
Resolved in integration and removed: a citation pinned to the current
extraction revision was labelled as superseded wording (the viewer now
compares the pinned revision with `extract_history`'s `active_revision`,
because case.rs `read_text_revision` always returns `historical: true`); the
Settings model combobox options were inert under the modal dialog (overlays
now render inside the open dialog); the open-file tab strip nested close
buttons in `role="tablist"` (the list now owns only tabs; Delete, Ctrl+W, the
context menu and a close button after the list close a file); the palette
results region was not keyboard-scrollable (its listbox is now a tab stop).

## Limits

- Browser mocks do not establish packaged Tauri correctness. They do not cover
  the Rust dispatcher, SQLite, the Python workers, Windows AppContainer, the
  `evidence://` protocol, file dialogs, drag and drop, window chrome, WebView2
  rendering, or real provider transport. Native gates remain required.
- The backend is a test double written from reading the Rust source; when the
  native commands change, the harness can drift. Keep DTO shapes aligned with
  `src/types.ts` and `desktop.rs`. Points it deliberately mirrors: case
  lifecycle actions and provider-key save/delete require `case_id` and
  `session_epoch` while a case is open (`provider_key_case_fence`); case-event
  is emitted after successful mutations except the early-return branches
  (`hybrid_search`, `export_word`, key and access-route actions), and also after
  `case_ai_scope` / `case_ai_access_route`, which desktop.rs does not list as
  read-only; `read_extract_revision` always reports `historical: true`, and
  `extract_history` names the `active_revision`.
- The fixture keeps display-only "running" jobs; the native backend refuses to
  switch cases while processing jobs run. Enable
  `setScenario({ blockSwitchWhileJobsRun: true })` to model that.
- No media plays: audio and video intentionally fail to decode, and playback
  derivatives, exact frame stepping, incident replay and authority retrieval
  return explicit harness errors.
- Passing harness tests do not certify legal accuracy, evidence handling, or
  the absence of bugs.

## Production bundle

`vite build` uses `index.html` only, so `harness.html` and `src/testing/**` are
not bundled. Verify with `npx vite build` then
`grep -rl "__vislexHarness\|SyntheticBackend\|SYNTHETIC PLACEHOLDER" dist` (no matches expected).
