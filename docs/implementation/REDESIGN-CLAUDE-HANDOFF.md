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

## Agents that actually ran (2026-09-28 session)

Workflow `vislex-surface-redesign` (run `wf_3fc12f9a-9d8`): four implementation writers, each in its own git worktree under `.claude/worktrees/`, never more than three writing at once — mocked-IPC harness + rich synthetic case; evidence viewer family; findings/investigation/settings; assistant chat (starts after the harness and merges it). Each writer is followed by an independent read-only adversarial reviewer and a fix pass in the same worktree. Results are recorded below once integrated.

## Unrun checks and open items

Kept current at the end of each slice.
