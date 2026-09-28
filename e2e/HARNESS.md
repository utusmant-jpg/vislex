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
- `save_app_ai_settings` drops app grants when the default vendor changes without `grants_for_provider`.

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
| `setScenario({ autoStream, stream: { chunks, intervalMs, complete }, dialogOpen, dialogSave, blockSwitchWhileJobsRun })` | Streaming and dialog behaviour. |
| `streamTask(taskId, options)` / `completeTask(taskId, answer?)` | Drive a running task by hand. |
| `emit(event, payload)` / `emitCaseEvent()` / `emitted(event?)` | Deliver arbitrary (including stale) events; inspect what was delivered. |
| `setJobProgress(jobId, progress, status?)` / `setChatPause(reason)` | Jobs and chat-preparation state. |
| `active()` / `task(id)` / `fixture` / `backend` | Inspect state; `fixture` holds stable ids used by the specs. |

Helpers in `e2e/harness-support.ts`: `openHarness`, `calls`, `lastCall` (waits
for a completed call), `axeViolations`.

## Specs

- `harness-chat.spec.ts` — compose, send, streamed tokens, Stop with the exact guard, completion with citations, citation chips opening exact (and historical) locators, draft retention across workspace and conversation switches without browser storage, chat preparation pause.
- `harness-settings.spec.ts` — appearance changes issue no IPC; saving never widens grants; model availability is not chat authorization; case override guard; save failure.
- `harness-case-switch.spec.ts` — held responses from the previous case are discarded; stale-epoch events and deltas are ignored; switch refusal is surfaced.
- `harness-jobs.spec.ts` — determinate progress only with reported totals; verbatim units; indeterminate fallback; recovery receipts and error routing.
- `harness-navigation.spec.ts` — every workspace; large-case paging; every source kind in the viewer; records, findings and investigation surfaces.
- `harness-a11y.spec.ts` — axe WCAG 2.x A/AA over native-only states in dark and light, with a named baseline of known violations in shared code.

Known app issues are encoded as `test.fail` (the test passes while the issue
exists and fails once it is fixed, prompting removal) or as named entries in
the axe baseline. Current entries: a user Stop renders as an error alert; the
Settings model combobox options are inert under the modal dialog; the open-file
tab strip nests buttons in `role="tablist"`; the palette results region is not
keyboard-scrollable; the chat token count misses 4.5:1 contrast in light theme.

## Limits

- Browser mocks do not establish packaged Tauri correctness. They do not cover
  the Rust dispatcher, SQLite, the Python workers, Windows AppContainer, the
  `evidence://` protocol, file dialogs, drag and drop, window chrome, WebView2
  rendering, or real provider transport. Native gates remain required.
- The backend is a test double written from reading the Rust source; when the
  native commands change, the harness can drift. Keep DTO shapes aligned with
  `src/types.ts` and `desktop.rs`.
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
