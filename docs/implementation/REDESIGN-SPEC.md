# VisLex redesign specification — "Ink & Evidence, calibrated"

Binding brief for every surface implementer. The goal is a calm, precise, premium desktop instrument for legal evidence work: every button, row, header, empty state and dialog looks deliberate and consistent. Premium here means typography, spacing, hierarchy, feedback and honesty — not decoration.

## 1. Non-negotiables

- Do not change backend contracts, Tauri command names/arguments, DTOs, or `src/bridge.ts` behaviour unless your brief says so. Preserve every existing capability, handler, keyboard shortcut and guard (`case_id`/`session_epoch` fences, late-response checks, `run(...)` error routing).
- Keep honesty and limitation copy verbatim (e.g. "Live draft — not yet citation-validated", "does not establish absence", "Separate working contexts — not independent corroboration or human approval", "Listing alone does not verify…", "transmission may have occurred"). You may restyle and relocate it, never shorten or soften it.
- No case content (prompts, titles, excerpts, file names beyond what already exists) in `localStorage`/`sessionStorage`. In-memory maps are allowed.
- No invented progress: a determinate bar only from reported `completed/total` units; otherwise a status dot plus words naming what is happening. No fake percentages, no progress shimmer, no optimistic "almost done".
- Original evidence pixels, pages and media are never recoloured, filtered, blended or animated. Crops/derivatives are labelled.
- Model availability is not case authorization. Never imply a model may receive case material because it is selected or listed.
- Do not delete or weaken tests. If an assertion encodes old markup, update it to the new markup while asserting the same behaviour, and say so in the commit.
- Accessibility: every control keyboard reachable with visible focus (global `:focus-visible` ring — do not suppress it), icon-only buttons have `aria-label`, tooltips via `Tooltip`, correct roles (`tablist/tab/tabpanel`, `listbox/option`, `dialog`), status changes announced with `role="status"`/`aria-live` where appropriate, color never the only signal (icon + label).
- Reduced motion: motion components already honour it via `MotionConfig`; CSS animations are disabled globally. Do not add JS animation that bypasses this.

## 2. Tokens (src/tokens.css — read only)

Use semantic custom properties only; never hex/oklch literals in component CSS.

- Surfaces: `--canvas` (workspace background), `--surface-1` (chrome: titlebar, rail, sidebar, pane headers), `--surface-2` (cards, inputs, raised rows), `--surface-3` (popovers, menus), `--inset` (wells, code, tracks), `--field` (input fill), `--media-stage` (behind original media), `--reading-surface/--reading-text/--reading-muted/--reading-rule` (extracted text pages), `--page-paper` (PDF pages).
- Lines: `--border-subtle` (inside a surface), `--border` (between surfaces, card edges), `--border-control` (inputs).
- Text: `--text-1` primary, `--text-2` secondary, `--text-3` tertiary/meta (still AA), `--text-disabled` (non-informative only).
- Interaction: `--accent`, `--accent-hover`, `--accent-pressed`, `--on-accent`, `--accent-text` (links, selected text), `--accent-subtle` (selected fill), `--accent-border`, `--ring`, `--hover`, `--pressed`.
- Meaning: `--evidence(-bg/-border)` only for things that open original evidence; `--success`, `--warning`, `--danger`, `--info`, `--restricted` each with `-bg`; `--danger-fill` for destructive buttons.
- Type: `--font-sans`, `--font-mono`; sizes `--text-caption` 11.5 (floor), `--text-sm` 12.5, `--text-base` 14 (13 compact), `--text-reading` 15, `--text-lg` 17, `--text-xl` 21, `--text-2xl` 28, `--text-display` 34; weights `--weight-medium` 520 / `--weight-semibold` 600; `--tracking-tight`, `--tracking-caps`.
- Space: `--space-1..12` (4px grid). Radius: `--radius-xs 4 / sm 6 / md 8 / lg 12 / xl 16 / pill`. Density-aware: `--control-h`, `--control-h-sm`, `--control-h-lg`, `--row-h`, `--icon-button`, `--pad-panel`, `--pad-card`, `--gap-stack`, `--chrome-h` 44, `--rail-w` 52.
- Elevation: `--shadow-sm/md/lg` plus `--shadow-raised` (inner top highlight) on raised surfaces. No coloured glows.
- Motion: `--dur-fast` 90ms (hover/press), `--dur-base` 150ms (menus, popovers, tabs), `--dur-slow` 220ms (dialogs, panels), `--dur-slower` 320ms (max); `--ease-standard`, `--ease-exit`, `--ease-emphasized`. JS springs live in `src/lib/motion.ts`.

Tailwind utilities are available and map to these tokens (`bg-surface-2`, `text-text-3`, `border-border`, `rounded-lg`, `text-sm`, `shadow-md`…); prefer the semantic CSS classes below for anything reused.

## 3. Component vocabulary (src/styles/primitives.css, src/ui.tsx)

Buttons: `.primary` (one per region — the main forward action), `.secondary` (bordered neutral), `.quiet` (ghost, low emphasis), `.icon-button` (+ `aria-label`, wrap in `Tooltip`), `.primary.danger-action` / `.danger-button` (destructive, always explicit text). Sizes via `data-size="sm|lg"`. Labels are verbs in sentence case ("Queue transcript", not "OK").
Fields: native `input/select/textarea` are pre-styled; wrap with `.field-label` (+ `.field-hint`). `.search-box` for filter inputs with a leading `Search` icon. `Combobox` (ui.tsx) for long/searchable single-select.
Choice: `.segmented` (2–4 mutually exclusive views), `.chip`/`.chip-row` (filters, `aria-pressed`), underline `.tabs` for sibling panels.
Status: `StatusPill` (icon + label, tones by state), `.badge` (neutral facts), `kbd`.
Containers: `.surface-header` (workspace title row: `.eyebrow`, h2, p, `.surface-actions`), `.panel-bar` (44px pane header), `.toolbar`, `.section-title` (+ `.count`), `.card` (+ `.card-header`, `.card-title`, `.card-actions`, `.is-attention`), `.list` / `.list-row` (+ `-icon`, `-main`, `-title`, `-subtitle`, `-meta`), `.kv` (dl), `.stat`, `.status-line`, `.icon-tile`.
Feedback: `.notice` (+ `.warning`, `.error`, `.info`, leading lucide icon), `.empty-state` (lucide icon → framed tile automatically, h3, one-sentence p, one primary action), `Skeleton` (opacity breathe), `notify.success/info/error` toasts, `.disclosure` for limitation lists (collapsed with count).
Overlays: native `<dialog className="modal">` (`.modal-heading`, `.modal-footer` with Cancel = `.secondary` left of the `.primary`), `AnchoredPopover`, `ContextMenu`/`MenuPanel`, `Tooltip`.
Evidence: `CitationChip` (amber, opens exact locator, previews cited lines), `.provider-dot[data-provider]`.
Icons: lucide-react, `size` 16 in buttons/rows, 14 inline/pills, 18 rail/titlebar, empty states 20 inside the tile. Never an icon without a text label or `aria-label`.

## 4. Layout patterns

- Workspace view: `.workspace-view` scroll container, padding `var(--pad-panel)`; content max width 1120px for tables/lists, 760px for reading/forms; `.surface-header` first.
- Pane: `.panel-bar` then scroll area; sticky footers use `--surface-1` with a top `--border-subtle`.
- Card grids: `display:grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`.
- Dense data: `.list` rows or real `<table>` with sticky header, caption-sized uppercase `th`, `--row-h` rows, hover `--hover`, selected `--accent-subtle`, numbers tabular.
- Long names: single-line ellipsis + full value in `title`/tooltip; never let a long file name push actions off-screen (min-width: 0 on flex children).
- Must work from 1000px to 2560px wide and at 1366×768; nothing clipped, no page-level horizontal scroll.

## 5. State design (every surface)

Design explicitly for: empty (what it is + one next action), loading (skeleton or quiet status line after 150ms, never a blank flash), streaming/running (status line naming the work + real units), partial (say what is covered: "Showing 50 of 1,204"), failed (plain-language title, raw detail behind disclosure, a retry/recover action when one exists), cancelled/stopped (neutral, not red), offline / AI disabled / no permission (say which, and link to the exact settings section), restricted/locked (lock icon + why), ready, and recovery (resume/continue affordance). Copy: calm, specific, no blame, no exclamation marks.

## 6. Motion

Motion explains change: selection indicators slide (springs.snappy), popovers/menus scale from anchor (150ms), dialogs rise 8px (220ms), a newly sent chat turn fades in (only the new one — never re-animate history, loaded-older pages or case switches), determinate progress width transitions. No idle/looping decoration, no hover translate on large surfaces, no stagger beyond 3 items.

## 7. Verification each implementer runs

`npx tsc -p tsconfig.json --noEmit`, `npx vitest run` (all green, counts reported), add focused tests for new interaction/state logic, and a visual check of your surface in both themes at 1366×768 and 1920×1080 (Edge via Playwright against the synthetic preview, or the mocked-IPC harness once available). Report exact commands and results; never claim an unrun check.
