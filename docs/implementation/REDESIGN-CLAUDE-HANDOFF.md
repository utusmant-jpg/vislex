# Claude redesign handoff

Durable record of the Claude-led redesign requested in `docs/CLAUDE-REDESIGN-PROMPT.md`. It is a working log, not a certification. `implemented` is not `verified`, and no test here establishes legal accuracy.

## Branch and base

- Work branch: `claude/redesign`, created from `ui/assistant-redesign` @ `c04c8c3` on 2026-09-27. Continued on 2026-09-28 in a cloud session as `claude/redesign-v14qbo` (pushed to origin; the desktop WIP snapshot was folded into real commits, not pushed as-is).
- Merged read-only from `codex/vislex-redesign` @ `3042ca0` (R20 subscription route, `d8bcaba` evidence-protocol CORS fix, SQLite contention handling). Codex worktrees under `.codex/worktrees/*` were not modified.
- Untracked user files (`CLAUDE.md`, `docs/CLAUDE-REDESIGN-PROMPT.md`, `.claude/settings.json`) are preserved and not committed by this work unless the user asks.

## Queue reconciliation

`python scripts/vislex_plan.py check` passes (26 tasks); `next` reports no ready task. The redesign is R21 work, and R21 depends on R14/R15/R16/R17, which are `implemented`, not `verified`. This work therefore does **not** mark R21 verified; it records implementation evidence under R21 and leaves the dependency gate explicit. Correctness defects found during the redesign are recorded against their owning tasks (R04, R24).

## Agents that actually ran

One read-only research workflow (`vislex-redesign-research`, run `wf_768408c9-0dd`) with seven parallel Explore agents and one completeness critic. No team feature was used; this is the Claude Code Workflow tool with subagents.

| Agent | Scope | Key contributions |
|---|---|---|
| ia-journeys | Screen inventory, journeys, state matrix, IA | Full surface inventory with commands; retention losses on rail/tab switch; chat titles persisted to `localStorage`; Stop rendered as failure; palette Enter/semantic mismatch; viewer tool stacking; proposed dock + viewer sub-tabs |
| visual-a11y | Tokens, type, contrast, motion | Confirmed `theme.css` unlayered `--accent/--border` override of legacy tokens (focus ring ≈1:1, light primary text ≈1.2:1); 13 sub-11px sizes; reduced-motion job bar reads as 34% progress; token/typography/motion proposal |
| libs-research | Library licences, maintenance, fit | Stack decision below; assistant-ui ExternalStore contract, deprecated tool UI APIs, SandboxHost remote iframe risk; React Bits Commons Clause; Aceternity Pro licence |
| arch-regression | Diff review 125140d..c04c8c3, baseline | Missing `d8bcaba`; ModelPicker duplicates models per provider; keyboard Enter picks wrong item; OpenRouter lacks data-collection policy; heuristic badges; merge recommendation; tsc 0, vitest 125/125 at c04c8c3 |
| dev-mcp | Development MCP servers | None required; optional assistant-ui docs MCP and MS Learn MCP (remote, anonymous); rejected Tauri MCP bridges (expose native IPC), Deque/Figma (paid) |
| provider-ux | Provider/model settings and capability docs | Default-provider change keeps old grant (verified below); keys cannot be saved without an open case; truthful capability fields per provider; settings IA |
| verification-infra | Tests and gaps | Chat cannot be exercised in browser preview; plan for mocked-IPC Playwright harness, matrix specs, scaling caveats, native gate map |

Agent agreement is not treated as evidence; each consequential claim below was re-checked in code by the lead.

## Lead-verified findings

1. **Security — evidence protocol CORS.** HEAD `c04c8c3` still sent `Access-Control-Allow-Origin: *` (`desktop.rs:1449`). Resolved by merging `d8bcaba`. Native re-test (`scripts/native-protocol-origin-test.ps1`) must be rerun on a build of this branch before claiming it here.
2. **Consent — default-provider change.** `providers::save` resets case text/image grants when the default provider changes (`providers.rs:118-126`), but `apply_app_settings` immediately re-saves the renderer's grant values (`providers.rs:985`), so a grant given for one vendor silently carries to another.
3. **Visual regression — token collision.** Live preview: `--accent` resolves to `oklch(24% 0.03 280)` instead of the legacy interactive blue; brand mark, onboarding icons, `.primary` buttons and every `var(--accent)` focus outline are affected.
4. **ModelPicker** lists every configured model under every provider heading (`ui.tsx:466`).

## Stack decision

Keep: `radix-ui` (through adapted shadcn copy-in components), Tailwind v4, `motion`, `cmdk`, `@assistant-ui/react` (ExternalStoreRuntime mirror only; Rust stays the single store; no `onEdit`/`onReload`/`setMessages`, Cloud, SandboxHost or toolkit compiler).
Upgrade: `lucide-react` 0.468 → 1.x. Add: `@tanstack/react-virtual` for long lists. Remove: npm `cn` (duplicate helper with a bin; unverified provenance) and unused `sonner`.
Rejected: Magic UI / Aceternity / React Bits (licence and marketing aesthetic), React Aria (duplicates Radix), `@virtuoso.dev/message-list` (commercial). Resizable panes stay on the existing accessible dividers.

## Visual direction — "Ink & Evidence, calibrated"

- Quiet ink-neutral chrome; evidence is the only saturated content. One interaction hue (indigo ~277 OKLCH). Amber means "opens original evidence". Violet with a lock means restricted. Status always icon + label.
- One token source (`src/tokens.css`): primitives → semantic tokens for dark/light/compact; legacy names become aliases so the old sheet keeps working while surfaces migrate. Contrast pairs are enforced by a unit test.
- Type: Inter Variable (bundled, offline) with Segoe UI Variable fallback; ramp caption 11.5 floor, body 13.5, reading 15, titles 17/22, display 30; tabular numbers for times, sizes, lines.
- Space 4px grid; radii 4/6/8/12/16; elevation = hairline border + shadow, no coloured glows.
- Motion explains state only: selection indicators, overlay origin, newly sent turns, real progress. Reduced motion collapses durations to zero. No idle breathing, no decorative shimmer on real progress, no motion inside the evidence canvas, no invented progress.

## Plan and sequence

1. **Integration and correctness prerequisites** (lead): merge Codex branch; token-collision fix; ModelPicker/ModelSelect correctness; Stop is not a failure; honest indeterminate job state; no case content in `localStorage`; consent fix for default-provider change; app-level key save without an open case; OpenRouter data-collection denial.
2. **Design foundation** (lead): tokens, Tailwind mapping, primitives (button, icon button, input, select, checkbox/switch, segmented control, tabs, tooltip, menu, popover, dialog, toast, pill, kbd, skeleton, empty state, disclosure, progress), per-surface CSS files, richer synthetic preview case, mocked-IPC Playwright harness.
3. **Surface redesign** (parallel, isolated worktrees, disjoint ownership): assistant/chat; evidence viewer family; findings/investigate/settings. Lead owns shell (titlebar, rail, sidebar, library, jobs, palette, onboarding, dialogs) and integration.
4. **Verification**: unit, Playwright interaction + axe across 1366×768/1920×1080, device-scale approximations, dark/light, reduced motion, keyboard-only, long names, large synthetic lists; performance measurements on named hardware; native gates where supported.

## Commands and results

Recorded per slice below, newest last.

- 2026-09-27 merge `codex/vislex-redesign` into `claude/redesign`: conflicts in `AgentPanel.tsx` (kept redesign motion + Codex `modelReady`/subscription route), `vite.config.ts` (kept Tailwind/alias/setupFiles + Codex `artifacts` exclusion), `NEXT-STATUS.json` (took Codex side, identical content plus `protocol_origin_fix_followup`). `npx tsc -p tsconfig.json --noEmit` exit 0; `npx vitest run` 22 files / 132 tests passed.

- 2026-09-27 `32cae98` design foundation (tokens.css single source, cascade layers, contrast unit test): tsc 0; vitest 23 files / 179 passed.
- 2026-09-27 `efdb691` shared primitives + ModelPicker/ModelSelect correctness (cmdk Combobox, Escape/focus return, no guessed capability badges, `stopped` pill): tsc 0; vitest 24 / 182 passed.
- 2026-09-28 (cloud, Linux container, Node 22.22.2, Chromium 1194 headless) `f3765ea` user instructions/brief committed; `1c71d21` shell, onboarding, evidence library and jobs redesign (desktop WIP): tsc 0; vitest 24 / 182 passed.
- 2026-09-28 `d3dcafa` Playwright runs on bundled Chromium via `PW_CHROMIUM_PATH` and a configurable `PW_PORT`: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 npx playwright test` 11/11 passed (workspace + axe WCAG A/AA spec).
- 2026-09-28 `f6eebd5` removed npm `cn` (shadcn copies now use `src/lib/utils.ts`) and unused `sonner`: tsc 0; vitest 182/182; `vite build` ok.
- 2026-09-28 `1fb6f4e` removed dead legacy palette/onboarding rules that broke the palette row layout and onboarding cards (seen in screenshots); `asyncUtilTimeout` 5 s / `testTimeout` 15 s after App.test lazy-view lookups failed intermittently under load (no assertion changed): vitest 182/182 ×3; Playwright 11/11.
- 2026-09-28 integration after merging the three surface branches (`b2bcd85`), single writer in the main checkout: `a44842d` settings links open the exact section and scope (`SettingsSection` from SettingsDialog, `initialScope`); `3b21b95` overlays render inside an open modal `<dialog>` (Settings catalogue models selectable; Escape closes only the list); `8f16fc3` pinned citation labelled superseded only when `extract_history.active_revision` differs (no Rust change); `5f9d627` open-file tablist owns only tabs (Delete/Ctrl+W/context menu/close button after the list), palette listbox is a tab stop; `756c807` evidence library columns follow table width (container query), status pills ellipsize with a title; `faeeaf2` 81 dead legacy selectors (34 classes unreferenced in src) removed from `styles.css`; `bcfc83e` `test:harness` script, unused `WorkspacePreferences.tsx` removed; `a4ff402`/`15a0e78` onboarding odd card spans, audio stage title no longer squeezed. All `test.fail` known issues and the axe baseline entries are resolved and removed. Checks at `15a0e78`: tsc 0; vitest 28 files / 262 passed (one intermittent `App.test.tsx` "discards a refresh from the previous case" failure under load, passed 3/3 alone and on the full rerun); `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 npx playwright test` 45/45 passed; `vite build` ok with no harness strings in the bundle. Visual check: throwaway screenshot script (not committed) over every workspace, pdf/audio/video/image/text viewer, settings sections, palette, streamed and stopped chat, dark and light, 1366x768 and 1920x1080.
- 2026-09-28 `5c47cd9` reviewer-confirmed defects fixed (single writer): ModelSelect clear row uses a non-empty cmdk value (arrow/Enter no longer stick); Alt+Arrow history skips keys a widget already handled; kind chips stay while a kind filter is active; citation hover card fetches and labels only the cited lines and stays open while the pointer crosses to it; onboarding/create copy says new cases follow app AI settings (no unconditional 'starts offline'); paused/interrupted/failed turns show the backend reason inline and announce it assertively; waiting line states only what was received; paused automatic analysis uses the neutral pill; cancelled job reasons are muted notes; model/access composer blocks open the case scope; checkbox/radio focus ring restored (also forced colours) and forced-colours outlines for highlighted menu/palette/theme items; focus kept on every tab close path, Send/Stop, Settings Load models/Save (aria-disabled while busy), dossier reviews and history close; menus use roving DOM focus; toasts render inside an open modal dialog; combobox names carry the value; Jobs rail name carries the attention count; hidden transcript skips per-tick row renders; redaction rectangles and transcript correction drafts survive tab switches (memory only); harness mirrors apply_app_settings for case overrides, 'Set up app AI first', resume/continue refusals and conversation, and cancel reasons. Assertions changed on purpose where behaviour changed (failed-turn reason now visible; announcements carry the reason; preview request count 1 for one cited line; waiting text; composer scope 'case'); selectors updated for value-bearing names. New `e2e/harness-focus.spec.ts` (7 tests; 6 fail on `36bda12`, the cancelled-job one because the old harness dropped the reason). Checks at `5c47cd9`: tsc 0; vitest 29 files / 277 passed (the known intermittent App.test 'discards a refresh from the previous case' failed once in 6 full runs, passed on the other 5); `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 npx playwright test`: first run 50/52 (timeouts in accessibility.spec 'Light' button and harness-a11y dark historical note; both passed alone), then 52/52 twice; `vite build` ok, no harness strings in dist. Rejected: none outright. Partly addressed: keyboard users still cannot tab into the citation card (Enter on the chip performs the same Open); the unsaved-work issue was pre-existing and is fixed by persistence, not a close confirmation. Not re-measured: focus-ring contrast ratio.

## Agents that actually ran (2026-09-28 session)

Workflow `vislex-surface-redesign` (run `wf_3fc12f9a-9d8`): four implementation writers, each in its own git worktree under `.claude/worktrees/`, never more than three writing at once — mocked-IPC harness + rich synthetic case; evidence viewer family; findings/investigation/settings; assistant chat (starts after the harness and merges it). Each writer is followed by an independent read-only adversarial reviewer and a fix pass in the same worktree. Merged into the branch at `628754d` (harness + chat, `worktree-wf_3fc12f9a-9d8-8`), `7cd2d4f` (viewer, `-2`) and `b2bcd85` (findings/settings, `-3`) without conflicts. Reviewer findings fixed in the worktrees before merge included: redaction stepper claiming unfinished steps, retry re-issuing the wrong request, transcript highlight offsets on case-changing characters, findings list unmounting on every refetch, harness `historical` flag and delta shapes diverging from Rust.

Workflow `vislex-integrate-and-review` (run `wf_62db8cf5-34b`): one integration writer in the main checkout (commits `a44842d`..`36bda12`), then five review lenses (behaviour, honesty/evidence, accessibility, test integrity, state/performance) with a separate refuting verifier per finding; 26 findings survived and were fixed in `5c47cd9` by a single writer. 35 agents, none errored.

Lead (this session): folded the desktop WIP into real commits, Playwright container support, dependency cleanup, palette/onboarding layout fix, screenshot review of every surface, and the root-cause fix for the App.test case-switch flake (`a9090e2`: tests clicked before the passive case-open effect reset the view).

- 2026-09-28 `a9090e2` final state: tsc 0; vitest 29 files / 277 passed; Playwright 52/52 at `34a19f3` (a9090e2 changes only src/App.test.tsx); vite build contains no harness code. R21 recorded as `implemented` (not verified) in NEXT-STATUS.json.

## Unrun checks and open items

Kept current at the end of each slice. State at `3b8bb88` on `integrate/redesign-final-cora77` (pushed to origin; merges `claude/redesign-v14qbo`, `claude/stoic-ride-1c8hns`, `claude/redesign-assistant` and `claude/redesign`, with conflict decisions in merge commits 09d76ce, a252aef, 0a479f2 and 022fef0).

Linux results at `3b8bb88`: `npm ci` exit 0; `tsc --noEmit` exit 0; Vitest 30 files, 294 passed; Playwright (Chromium) 58 passed; `npm run build` ok; `cargo test --tests` (host target) 238 passed, 0 failed, 4 ignored; Python workers/scripts/benchmarks 41/13/10 passed; `vislex_plan.py check` valid.

- Fixed since `a9090e2`: punctuation after a citation chip stays on the chip's line (6c48e1c); the video transcript dock stays inside the viewer at 1366×768 and 1000×680 (b8cfdf6); changing the default company keeps grants only with a consent that names the new vendor (bdfeb3e). Each has a harness test.
- Windows run at `8b2fbee` (2026-09-28, results in `docs/TESTING.md` and `windows_verification_2026_09_28` in NEXT-STATUS.json): Tier 1, the rebuilt packaged worker, the 26 sandbox tests, `npm run desktop:build`, five native journeys on the debug build and the protocol-origin test on the release exe all passed. The release build refuses chat while the saved route is `chatgpt_subscription` (compiled out by default) until the user picks an API provider.
- Still not run: `native-consent-acceptance.ps1`, `native-app-ai-acceptance.ps1`, `native-codex-account-test.ps1`; manual video scrubbing and PDF paging through `evidence://`; Windows 125/150/200 % scaling screenshots; NVDA/Narrator; Edge; performance on named hardware. The desktop session ran native journeys (commits 4c7004f, 3f763b7, 1c9b692 adjust native test mode) but recorded no results, so none are claimed.
- `cargo fmt --check` fails repo-wide (about 40 files, also on `main`); it was never enforced and is left alone to avoid churn in shared Rust files.
- Open visual item: Findings/Investigate take ~1–2 s to leave loading in the dev-server harness (unmeasured in production).
- Open behaviour items: citation hover card is not Tab-reachable (Enter on the chip does the same); remaining legacy rules in src/styles.css are for classes still in use and mostly overridden.
- Not done from the stack decision: `lucide-react` 1.x upgrade and `@tanstack/react-virtual` for long lists.
- Branches not merged, on purpose: `impl/wave1-repairs`, `codex/chatgpt-subscription` and `codex/snapshot-subscription-20260927` are an older lineage whose code is already in the 2026-09-26 snapshot root (6cac65b) this history starts from; `codex/snapshot-{assistant,harness,settings}-20260927` are unverified Codex WIP rewrites of AgentPanel, SettingsDialog and a fake backend that the redesign replaced. They stay on origin untouched.

## Flagship chat slice (2026-09-28, `claude/flagship-chat` from `main` 721c700)

User brief: make the chat and agent workflow feel best-in-class, remove the brand from chat and processes, show "what it did" in plain words, better citations and typography, and a sharper app, desktop and taskbar icon. The plan is in the session plan file; decisions below.

- **Decisions.** Tuned Inter (no serif), numbered citations with a per-answer Sources list, the "Aperture V" icon (two indigo blades and the amber evidence point), and small additive backend changes as the last phase. Brand stays in the title bar, onboarding and About only.
- **Frontend.**
  - `src/chat/activity-summary.ts` turns each stored action into a sentence using only its input and output; unknown tools fall back to the tool name.
  - `ActivityTrace` shows a one-line recap, grouped runs, per-step facts and "Technical receipt" for the raw JSON.
  - `citation-context.tsx`, `SourcesList.tsx` and `source-directory.ts` add per-answer numbering, source names (the loaded page, then an in-memory `source_detail` cache) and a Tab-reachable hover card. This closes the open "citation hover card is not Tab-reachable" item.
  - `live-progress.ts` holds the live stream state, still filtered by case, session epoch and task.
  - Composer keys: Esc, ↑, Ctrl+Shift+; and Ctrl+Shift+C.
  - A `route-unavailable` composer block, requested by the integration session.
  - Palette chat search and new commands, Ctrl+/ sheet, local chat titles (`src/chat/titles.ts`), chat error boundary, and a narrow-window evidence sheet in chat.
  - Removed: unused `src/components/ui/*` shadcn copies and their dependencies, and legacy chat and responsive duplicates in `src/styles.css`. One of those duplicates used `!important` in the lower layer and blocked new rules.
  - `lucide-react` upgraded to 1.48.0, closing the open stack item.
- **Backend (additive).**
  - `providers.rs`: Anthropic and Gemini emit `{activity}` and `{characters}` for tool use like OpenAI, with a unit test.
  - `desktop.rs`: the subscription route emits an activity delta per tool and a case event after each saved receipt, both outside case locks.
  - `case.rs`: `task_page` and `conversation_detail` add `updated_at`, used for "Took …" on completed turns.
  - Coordinated with the research-browser and integration sessions before editing.
- **Icon.** `app-icon.svg` (1024 master) and `app-icon-small.svg` (hand-tuned for 16–48 px). `npx tauri icon` generated the set; the 16/24/32/48 frames of `icon.ico` and `32x32.png` come from the small master.
- **Measured.** 300 streaming updates of a 7,353-character answer in happy-dom, median of 3: old renderer 915 ms, new 94 ms, and 176 ms with the word fade. This is not a production or named-hardware measurement.
- **Results at 8cb7cd5 (Windows, before review fixes).**
  - `npm run build` passed.
  - Vitest: 32 files, 313 passed.
  - Playwright (Edge): 58 passed. This includes the harness a11y scans in both themes with an empty baseline.
  - `cargo test` (host): 246 passed, 0 failed. Worker-dependent tests need `src-tauri/resources/worker`; they were run against the main checkout's packaged worker via a local junction.
  - Interactive harness walkthrough in the browser pane:
    - new chat, send, stream and Esc stop, then Resume shown;
    - trace expand and step detail;
    - citation hover card and whole-image card;
    - Sources list opening the viewer;
    - palette chat search, and the Ctrl+/ sheet;
    - light theme;
    - narrow 1000 px sheet.
- **Independent review.** Codex run on `gpt-6-astra` at high reasoning, read-only, against 8cb7cd5. It found no critical or high issues and four medium ones. All four were verified and fixed:
  1. Activity wording overstated media work. "Played" is now "Queued the original of … for the model to review", sampled video frames are no longer "Watched", and grouped transcription says "Transcribed".
  2. Enter bypassed the route-unavailable block. `submit` now honours every composer block, with a unit test.
  3. A resumed turn reshowed its stopped draft. The live state resets per run, and the subscription stream id is now `subscription:<task>:<transmission>`.
  4. Escape from the citation card reopened it.
  My own regression test for item 4 then showed that Tab past the portalled card jumped to the top of the page. Tab now continues after the marker, covered by a harness test repeated 6×. `selectSource` in App is now a stable callback, so memoised answer blocks skip case polls.
- **Results after fixes (Windows).** `npm run build` passed. Vitest: 314 passed. Playwright (Edge): 59 passed. `cargo test`: 246 passed, 0 failed.
- **Test wording updated where markup changed (same behaviour asserted).**
  - `harness-assistant`: activity toggle name and failure line.
  - `harness-chat`: plain tool label, same 39-character count.
  - `AgentPanel.test`: greeting heading.
- **Not run.**
  - Native app with the new icon on the taskbar, Start, Alt-Tab and desktop shortcut at 100/125/150 %.
  - Live provider streams for the new Anthropic/Gemini activity deltas and the subscription events.
  - NVDA/Narrator.
  - Performance on named hardware.

## Final build (2026-09-28, evening)

`main` 4818598 (this flagship slice) was merged into `integrate/redesign-final` together with the ChatGPT-subscription changes. Two decisions came from the user:
- Desktop npm scripts build with `--features subscription`. Headless `cargo test` still builds without Tauri.
- The Codex sidecar was rebuilt from the pinned commit and patch, and its SHA-256 re-pinned to `DFD16FFD…5577`. The rebuild differed from the old pin; the boundary probe held in both modes before the re-pin.

Dev runs use `scripts/desktop-dev-codex.ps1`. It copies the sidecar outside `src-tauri`, because the app's sandbox grant on that folder otherwise makes `tauri dev` restart the app.

`scripts/native-acceptance.js` now matches the chat title case-insensitively, because the redesigned list capitalises the title. Results are in `docs/TESTING.md` → Final Windows build.

## Next action

- Optional: have the other provider review the sidecar re-pin, and the patch diff against the pinned Codex commit.
- Still unrun: live subscription chat (needs the user's explicit go-ahead for a synthetic probe), consent and app-AI native journeys, scaling screenshots, NVDA/Narrator.
