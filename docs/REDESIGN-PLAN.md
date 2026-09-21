# VisLex Redesign Plan — "World-class, evidence-grade"

> **Implementation status (2026-09-21):** Phases 0–4 are implemented and verified
> (tsc + vitest 13/13 + production build green; browser QA in both themes).
> Shipped: token system with dark/light themes (`styles.css` rewritten, ~960 lines, no
> stacked themes), rail navigation with five workspaces, status bar, chat with markdown +
> citation chips + hover previews + per-turn activity timeline + model picker popover +
> follow-up chips, PDF continuous scroll, image pan/zoom, custom media transport with
> filmstrip/A-B loop/frame-step/keyboard, transcript search + follow, speaker lanes,
> drag-to-draw redaction (review gate intact), Workbench/Findings as workspaces,
> settings sheet, unified command palette, onboarding hero, drag-and-drop import,
> toast system with Undo, context menus, tooltips, skeletons, motion catalog,
> `ui.tsx` primitives, `markdown.tsx` renderer, `viewerContext.ts` store (DOM scraping
> removed). Known deferred: waveform lane in the transport (needs a bounded backend
> probe), team & review mode exposure (blocked on the forced `auto/standard` save),
> virtualized lists, Windows UIA pass.

Complete UI/UX redesign plan for the VisLex desktop app, produced from a full read of the
frontend (`src/`), the Rust coordinator (`src-tauri/src/`), the Python workers, and every
design/planning doc in the repo. It covers every screen and component — shell, chat, model
selection, evidence viewer, analysis surfaces, search, settings, onboarding, color,
typography, motion — and marks what is already right and stays.

**Scope rule:** nothing here changes evidentiary behavior, honesty language, or backend
contracts. This is a presentation-and-interaction layer redesign. Where a UI change needs a
small backend accommodation (e.g. un-hiding review modes), it is called out explicitly.

---

## 0. Verdict in one page

VisLex's **information architecture is already right**: conversation-first center, evidence
tabs alongside, case tools in a rail, citations that jump to exact locators. The product's
honesty apparatus (receipts, "unreviewed" labels, limitations disclosures) is a
differentiator and is kept verbatim.

What separates the current UI from world-class is execution, not concept:

1. **The stylesheet is three stacked themes** (original dark-teal → light rewrite → Linear
   dark), ~500 lines of overrides fighting each other. This is the single biggest defect.
   Rebuild as one token-driven system.
2. **No design tokens** — hundreds of hard-coded hexes, no type/space/radius/motion scale.
3. **Typography floor is 8–9px** in places; base 13px with 10–11px UI text. Below legal-work
   readability.
4. **Almost no motion** — two keyframes total (`pulse`, `spin`). No transitions on modals,
   panels, messages, tabs, or hover states.
5. **Chat answers render as plain text** with only `**bold**` parsing — no markdown, no
   lists, tables, or code; no copy button; receipts only visible for the *latest* turn (bug).
6. **Model selection is a truncated native `<select>`** buried in the composer, despite a
   multi-provider roster with per-chat memory.
7. **Analysis power tools are hidden in two giant modals** (Workbench, Findings) with
   3-deep `<details>` nesting — the app's most differentiating features are invisible.
8. **Engineer-grade inputs where professionals expect instruments**: redaction boxes typed
   as x/y/w/h numbers, speaker "lanes" as a button list, video with bare native controls,
   no waveform, no frame stepping.
9. **Weak first-run and empty states**; single error-only toast; command palette with two
   confusing search buttons.
10. **Dead code**: ~40% of `styles.css` (`.welcome`, `.activity-rail`, `.statusbar`,
    `.dashboard`, `.metrics`, `.change-card`, `.search-result`, `.case-switch`,
    `.build-badge`, `.preview-banner`, …) is unused; 14 unused icon imports in `App.tsx`;
    the `frames` frame-strip state in `EvidenceViewer` is never populated.

The plan: **Phase 0** cleanup → **Phase 1** foundations (tokens, one theme + light mode,
motion, base components) → **Phase 2** chat → **Phase 3** viewer → **Phase 4** surfaces
(workbench/settings/palette/onboarding) → **Phase 5** polish + a11y. Details in §17.

---

## 1. What already works — keep as-is

Do not redesign these beyond token/skin application:

- **Layout skeleton**: titlebar / sidebar (chats + projects) / chat center / evidence tabs
  right. Conversation-first is correct for this product (affirmed in DESIGN.md and
  VISLEX-0.2.1).
- **Custom draggable Windows titlebar** with min/max/close and the three-bar brand mark.
- **Citations** `evidence:SOURCE#L1-L3` → opens the source at the locator. The core magic;
  extend it (§5.3), never replace it.
- **Composer context chip** ("Viewing <file> @ page/time") passed to the agent — keep, make
  it removable and multi-line-aware.
- **Honesty microcopy**: "unreviewed machine transcription", "does not establish absence",
  receipts, limitations. Keep the wording; restyle consistently (§9.4 Disclosure component).
- **Undo-able chat delete**, **F2 rename**, **Ctrl+K**, Enter-to-send with IME guard,
  `prefers-reduced-motion` block, aria-labels throughout.
- **Draft preservation** (composer via sessionStorage; record editor via in-memory map that
  survives tab switches).
- **Live streaming** via `agent-progress` events with activity label + live-draft tail.
- **Automatic case analysis** chat, `needs attention`/pending-jobs summary in the case chip,
  suggested matter name from charging-document PDFs.
- **Polling architecture** (`case-changed` + snapshot) — keep; UI just needs optimistic
  updates on top (§17 perf notes).

---

## 2. Diagnosis — the twenty issues that matter

Ordered by user impact:

| # | Issue | Where | Severity |
|---|---|---|---|
| 1 | Three stacked themes; specificity wars; un-maintainable CSS | `styles.css` | Critical |
| 2 | No token system (color/type/space/radius/shadow/motion) | everywhere | Critical |
| 3 | 8–11px text floor; 13px base; cramped 1.5–1.65 line-heights | global | Critical (a11y) |
| 4 | Answers not rendered as markdown; no message actions (copy/retry) | `AgentPanel` | Critical |
| 5 | Receipts/activity visible only for latest turn in a conversation | `AgentPanel.tsx:65` | Major (bug) |
| 6 | Model picker = truncated native select; no badges/search; settings loads models on focus (hidden behavior) | `AgentPanel`, `SettingsDialog` | Major |
| 7 | Workbench/Notebook = 900–1200px modals, nested `<details>` ×3, tables without virtualization | both components | Major |
| 8 | Redaction = typing rectangle coordinates | `RedactionPanel` | Major |
| 9 | Video/audio = native controls; no frame-step, speed, A–B, filmstrip, waveform | `EvidenceViewer` | Major |
| 10 | PDF = single page + prev/next only; page context scraped from DOM (`document.querySelector('.pdf-navigation')`) | `EvidenceViewer`, `AgentPanel.tsx:54` | Major |
| 11 | Only 2 animations; zero transitions on dialogs/panels/tabs/messages | global | Major |
| 12 | Palette: two buttons ("Search text" vs "Search meaning + text") instead of one blended search; no arrow-key nav | `App.tsx` palette | Major |
| 13 | No light theme; `color-scheme` declared 3× | `styles.css` | Major |
| 14 | Sidebar: two navigation models stacked; flagship tools hidden inside a collapsed `<details>`; fixed width, not resizable | `App.tsx` | Major |
| 15 | Single error-only toast; no success/info variants, no stack | `App.tsx` | Moderate |
| 16 | First-run: blank center; demo only in browser build | `App.tsx` | Moderate |
| 17 | Dead CSS ~40%, 14 unused icon imports, dead `frames` state | `styles.css`, `App.tsx`, `EvidenceViewer` | Moderate |
| 18 | Speaker turns/diarization = button list + checkbox details | `SpeakerTurns` | Moderate |
| 19 | No tooltips (title attr only), no context menus, no inline rename | global | Moderate |
| 20 | Jobs & issues = raw receipt cards; storage meter buried | file-browser | Moderate |

---

## 3. Design foundations

### 3.1 Brand & feel

Position between **Linear** (calm, keyboard-first, near-black), **Claude/ChatGPT** (chat
craft), and **Amped Replay / Everlaw** (forensic instruments). The tension to hold:
*quiet shell, loud evidence* — original documents, video and photos keep their real colors
on a neutral stage; the chrome recedes.

Name the system internally: **"Ink & Evidence"**.

### 3.2 Color tokens (dark — default)

One accent owns interaction. Move off Linear's exact brand `#5e6ad2` to a slightly deeper
indigo so the app stops looking borrowed; amber stays exclusive to evidence/citations.

```
--bg-canvas      #0b0c0e   chat canvas, deepest layer
--bg-surface-1   #101114   sidebar, titlebar, docked panels
--bg-surface-2   #15161a   composer, cards, inputs, elevated rows
--bg-surface-3   #1c1e23   popovers, menus, hover fills
--bg-inset       #0d0e11   code blocks, receipt pre, transcript text

--border-subtle #1e2025   dividers inside a surface
--border        #272930   dividers between surfaces
--border-strong #34373f   inputs, focus-adjacent frames

--text-primary  #f2f3f5
--text-secondary #a9aeb8   (≥5.5:1 on surface-1)
--text-tertiary  #787e8a   (raise from #62666d; ≥4.2:1)
--text-faint     #5b6069   decorative labels only, never interactive

--accent        #6e73f4   interactive: links, focus, primary buttons, selection
--accent-hover  #8287ff
--accent-active #5a5fe0
--accent-subtle #6e73f417  selected rows, chips
--accent-text   #b6b9ff   text on subtle accent

--evidence      #e0b25d   citations, evidence chips ONLY (existing amber, tuned)
--evidence-bg   #e0b25d1a
--success       #4cc38a   accepted/complete/verified
--warning       #e2a03f   stale, needs-attention, interrupted
--danger        #f26d7d   errors, conflicts, destructive
--info          #6cb6ff   neutral notices, indexing
--restricted    #b493f8   restricted sources (always + lock icon, never color alone)
```

Rules:
- Accent is never used for meaning (no "green means good" buttons); status comes from the
  status system (§3.5).
- Evidence amber appears only on things that link to original evidence — so "amber = click
  me to the source" becomes a reflex.
- Danger is reserved for errors/conflicts/destructive, not for "unreviewed" (which is
  neutral gray) — today unreviewed and failed feel similarly alarming.

**Light theme** (`:root[data-theme="light"]`, plus `color-scheme`): warm paper
`#faf9f7` canvas, `#f1f0ec` surfaces, ink `#26251f` text, same accent family darkened to
`#5557d6`, evidence `#8a6410`. Original documents already sit on white — light mode makes
the reading experience seamless for office work. Theme toggle in Appearance settings +
follow-system default.

### 3.3 Type

Windows-native `Segoe UI Variable` stays primary (crisp, offline, zero FOUT); bundle
Inter Variable via `@fontsource` as fallback for non-Windows dev machines. Mono stays
Cascadia Code.

| Token | Size/weight | Use |
|---|---|---|
| `display` | 30/34 · 600 | onboarding hero |
| `title-lg` | 22/28 · 600 | modal titles |
| `title` | 17/24 · 600 | panel headings, chat welcome |
| `body-lg` | 15/24 · 400 | agent answers, documents |
| `body` | 13.5/21 · 400 | UI default (base font-size 13.5px, up from 13) |
| `body-sm` | 12.5/18 · 400 | secondary UI, tree rows |
| `caption` | 11.5/16 · 500 | labels, meta, badges |
| `mono` | 12.5/20 · 400 | receipts, hashes, locators, transcripts |

- **Floor: nothing below 11.5px.** Today's 8–10px labels (`welcome-formats`, badges,
  editor-actions, doc-footer) move to `caption`.
- Line-height floor 1.5 for prose (currently 1.5–1.65 exists in places, 1.3–1.4 in others).
- Answers render at `body-lg` 15px — reading is the product.
- Density setting: Comfortable (default, above) / Compact (base 13px, 26px rows) for
  power users on 720p laptops — addresses the REMEDIATION space complaint without
  shrinking the default.

### 3.4 Space, radius, elevation

- 4px grid: `4, 8, 12, 16, 20, 24, 32, 40, 48`. Panel padding 20–24; card padding 16.
- Radius: `--r-sm 6` (inputs, chips), `--r-md 8` (buttons, cards), `--r-lg 12`
  (popovers, composer), `--r-xl 16` (modals), pills 999.
- Elevation = 1px border (from tokens) + shadow:
  `--shadow-1: 0 1px 2px #00000059` (cards) · `--shadow-2: 0 4px 16px #00000073`
  (popovers) · `--shadow-3: 0 24px 80px #000000b3` (modals).
- Focus ring: `2px solid var(--accent)`, offset 2px — one global rule, keep current
  behavior but tokenized.
- Scrollbars: keep 8px overlay style; add `scrollbar-gutter: stable` to scroll containers
  to stop layout shift when bars appear.

### 3.5 Status system (one component, used everywhere)

`<StatusPill tone icon label>` replaces the ad-hoc text in chats, records, jobs, objects:

| State | Tone | Icon |
|---|---|---|
| Unreviewed | neutral | `CircleDashed` |
| Needs attention / stale | warning | `AlertTriangle` / `History` |
| Running / queued | accent | `LoaderCircle` (spin) |
| Complete / accepted | success | `CheckCircle2` |
| Failed / interrupted / conflict | danger | `XCircle` / `AlertOctagon` |
| Protected (agent edits locked) | neutral | `Lock` |
| Restricted source | restricted | `Lock` |

Color is never the only signal (icon + label always) — matching the repo's own rule.

### 3.6 CSS architecture

- **Delete all three layers; rebuild `styles.css` as ~6 ordered sections**: tokens → base
  reset → shell → components → utilities → media queries. No `!important`, no re-declared
  `:root`, no theme stacked on theme. Light theme via `[data-theme]` variable swaps only.
- Every new value references a token. PR rule: a new hex in a component block is a bug.
- Keep total CSS modular by component file boundaries (comments), single file is fine at
  this scale.

---

## 4. App shell

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◢◢◢ VisLex · Eric Wilson · 26CRB00117            [🔍] [☕ 2]   – □ ✕ │ 40px
├────────────┬───────────────────────────────┬─────────────────────────────┤
│ ▸ Chat ⌘1  │                               │ Tab: bodycam.mp4  Tab: … ✕  │
│ ▸ Evidence │                               │ ┌─────────────────────────┐ │
│   ⌘2       │        Conversation           │ │                         │ │
│ ▸ Findings │        (markdown,             │ │     Evidence canvas     │ │
│   ⌘3       │      citations,               │ │   (per-media chrome)    │ │
│ ▸ Review ⌘4│      activity)                │ │                         │ │
│            │                               │ └─────────────────────────┘ │
│ CHATS      │  ┌──────────────────────┐     │ Transcript / Speakers /     │
│ • timeline │  │ composer + model    │     │ Discovery drawers            │
│ • doors?   │  └──────────────────────┘     │                              │
├────────────┴───────────────────────────────┴─────────────────────────────┤
│ ● 2 jobs running · 1 needs attention            case storage 12.4 GB    │ 28px
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Navigation model (fixes issue #14)

Replace the current "Case tools & files `<details>` + PROJECTS tree + chat list +
project-list" stack with **one rail of five destinations**, each a real workspace the
center pane switches to (chat remains the default and the biggest):

1. **Chat** ⌘1 — current AgentPanel + conversations (default)
2. **Evidence** ⌘2 — library table (see §9.3) replacing the floating file-browser
3. **Findings** ⌘3 — structured objects, dossiers, clocks (the notebook, un-modalized, §8.2)
4. **Review** ⌘4 — the Workbench views (discrepancies, what changed, replay, coverage,
   legal workflows) (§8.1)
5. **Jobs** — activity center (§9.2)

Sidebar stays 240px, **resizable 200–360px** (drag handle, persisted), collapsible to
44px icon rail. Projects/cases list lives at the sidebar bottom as today (keep the
project-group + per-project chat expansion pattern — it's good), with a case switcher
dropdown at the top.

### 4.2 Status bar (new, 28px, opt-in detail)

The docs deliberately removed footers to de-densify — keep that spirit, but a *single*
quiet line returns real value: left = live job ticker ("Transcribing bodycam.mp4 · track
2/3") + needs-attention pill (click → Jobs); right = case storage summary. It replaces
the currently buried storage meter and makes background work visible without opening
Jobs. Hidden entirely when idle and nothing needs attention.

### 4.3 Tabs

Keep the tab strip concept; upgrade: active tab gets 2px accent top inset (exists),
**middle-click closes**, right-click menu (Close / Close others / Close right), overflow
scroll with chevrons, dirty-record dot indicator, tooltips with full name + kind +
locator. Tabs animate width 160ms on open/close. `Ctrl+W`, `Alt+1..9`, `Ctrl+Tab` wired.

### 4.4 Menus, tooltips, context menus (new base components)

Build three primitives once (all keyboard-navigable, aria menu/menuitem, Escape closes,
click-outside closes, 120ms scale-fade):

- **Menu** (anchored dropdown) — powers context menus on chats/sources/tabs/jobs
  (Rename F2, Delete w/ undo, Restrict source, Verify hash, Reveal in Explorer where
  backend allows).
- **Tooltip** (300ms delay, 240ms fade) — replaces all `title=` attributes, which are
  slow and unstyleable; shortcuts shown right-aligned in kbd chips.
- **Popover** (non-modal anchored panel) — powers the model picker (§6.2), citation
  previews (§5.3), status filters.

---

## 5. Chat — the heart of the app

### 5.1 Message rendering (fixes issue #4)

Adopt `react-markdown` + `remark-gfm` (bundled, offline; the only new runtime deps this
plan requires). Custom renderers:

- Citations `evidence:…#…` → the existing amber chip (keep!), inline in prose.
- Tables → bordered, sticky-header, `caption` size.
- Code → `--bg-inset` mono block with copy button.
- `**bold**`, lists, headings scaled to the type ramp.

Message anatomy:

- **User**: right-aligned bubble (surface-2, radius 16 with 4px corner at bottom-right),
  max-width 75%, `body` size. Context chip ("Viewing bodycam.mp4 @ 00:42") rendered as a
  small evidence-amber footer inside the bubble when the message carried viewer context.
- **Agent**: no bubble — full-width column (max 780px, centered as today) at `body-lg`.
  Beneath the answer, a **meta row**: model pill (`GPT-5.2` etc.), tokens (backend already
  reports input/output per task), elapsed, receipt count, actions on hover: **Copy**,
  **Copy with citations**, **View activity**.
- Error answers keep the danger notice + receipt, as today.
- Timestamps: relative (`2m ago`) in meta row; day separators between sessions
  ("Today", "Sep 18").

**Fix the receipts bug (#5):** every turn gets its own collapsible activity — remove the
`turn.id === task?.id` gate. Historical turns show "12 actions · View receipts" collapsed.

### 5.2 Streaming & activity timeline

Replace the `<details>`-tree with a **vertical timeline** shown while running (and
re-openable after):

```
● Reading bodycam transcript (L1–L200)          ✓ 0.4s
● Searched: "door open warning"                 ✓ 0.2s
● Inspecting video 00:41–00:44                  ⟳ running…
```

- One line per action: icon by tool family (read/search/media/record), name in
  human tense, status, duration. Expand a row → input/output receipt in mono with copy.
- While streaming: activity label as a shimmer line above **progressively rendered
  markdown** (ghost text) with a blinking caret; drop the separate `<pre>` live-draft
  tail, but keep its honesty caption ("live draft — not yet citation-validated") until
  the task completes.
- Completion: soft fade-in of the meta row; if the run failed, timeline stays open with
  the failed action highlighted.
- Team panel (parallel/challenge review) renders as a **card row** (avatar-initial,
  role, model, status pill, expandable proposal) instead of nested `<details>` — keep the
  "not independent corroboration" disclaimer line.

### 5.3 Citations, upgraded (signature interaction)

Keep click-to-open. Add:

- **Hover preview** (350ms dwell): popover showing the cited lines (via `read_text`) or
  frame thumbnail (via `artifact_info`) *without leaving the chat* — the "world's best"
  move for an evidence tool. Prefetch on render for the first two citations of the
  visible answer.
- Chips label with human locators: `L5–L9`, `p.3`, `00:41.2`, `frame` — computed from the
  locator type (backend `validate_citation` already distinguishes).
- "Copy citation" on right-click.

### 5.4 Composer

Keep: rounded card, focus ring, context chip, Enter/Shift-Enter, per-conversation draft.
Upgrade:

- Model picker as a proper popover control (§6.2) — left of send, replacing the truncated
  select.
- Context chip becomes **removable (×)** and shows locator detail ("p.3" / "00:42").
- **Attach-from-viewer**: in the text/PDF viewer, selecting lines shows
  "Ask about L12–L18" — jumps to chat with the chip set (extends existing viewer_context;
  removes the fragile `document.querySelector('.pdf-navigation')` DOM scrape by passing
  page/time from viewer state through React context instead of the DOM).
- Disabled states explain themselves inline ("Set up AI in Settings →" link — exists,
  keep; add "case is offline" variant).
- Textarea autogrows to 8 lines then scrolls (exists), character/token ghost counter
  appears past ~2000 chars.

### 5.5 Conversation management

- Chat list rows: title, relative time, running spinner (keep `pulse` concept →
  StatusPill), hover actions (rename, delete) — **rename inline** (double-click / F2)
  instead of modal; keep the separate icon buttons for discoverability until inline is
  learned.
- **Search chats** filter above the list; "Show all" graduates to scroll (list capped at
  ~30, then virtualized).
- Welcome screen: keep the glyph + headline + starters; starters become
  **evidence-aware** ("What has no transcript yet?", "Timeline the door events" derived
  from snapshot: sources without transcripts, pending jobs) — static three only as
  fallback; each starter notes Enter-to-send.
- Follow-up suggestions after a completed investigation: up to three chips derived from
  the dossier's `next_check` fields (already in `task.progress.next_steps`).

---

## 6. Model selection & AI settings

### 6.1 Principles

Model choice is a first-class, always-visible control — like ChatGPT/Claude/Cursor — but
never noisy. Roster comes from live `provider_models` (already implemented); nothing is
hardcoded.

### 6.2 The model picker (fixes issue #6)

Composer control: `[◆ gpt-5.2 ▾]` — provider glyph (simple 2-letter monogram chip in
provider brand hue: OpenAI teal-on-dark, Anthropic clay, Gemini blue, xAI slate), model
name, chevron. Opens a 320px popover:

```
┌───────────────────────────────┐
│ 🔍 Filter models…             │
│ ── OpenAI ──────────────────  │
│ ◆ gpt-5.2        ★ Default    │
│ ◆ o4-mini        ⚡ Fast       │
│ ── Anthropic ───────────────  │
│ ◆ claude-…-sonnet Reasoning   │
│ ── Gemini ──────────────────  │
│ ◆ gemini-2.5-pro  Vision      │
│ ───────────────────────────── │
│ ＋ Manage models & keys…      │
└───────────────────────────────┘
```

- Rows: name, provider group, heuristic badges (**Default** = the saved primary;
  **Fast** / **Reasoning** / **Vision** from id patterns — labeled as heuristics in
  tooltip, since listing "does not verify capability" per the existing disclaimer).
- Keyboard: ↑↓ Enter, type-to-filter; Escape closes. Footer link → Settings.
- Per-conversation memory already exists (sessionStorage) — move to localStorage keyed
  `vislex-model:{case}:{chat}` so it survives restarts.
- Empty state (no models configured): "Configure AI →" opens Settings.
- While a run is active the picker disables with tooltip "Next message uses this model —
  the current run is locked to its model" (matches backend freeze-at-start behavior).

### 6.3 Settings — from dialog wall to settings sheet (fixes issue #7 half)

A 880×640 **sheet with left nav** (modal-level focus, not a desktop window):

| Section | Contents |
|---|---|
| **AI providers** | Today's provider cards, restyled: key field + status dot, "Load models" button (explicit, not on-focus), model rows with badges, add/remove (up to 16), remove-key action (`delete_provider_key` already exists, currently unexposed) |
| **Team & review** | Execution: Single / Parallel / Auto (visual: one path vs three lanes); Review: Standard / Independent / Challenge — *requires un-forcing `execution:'auto', review:'standard'` in `save()` (SettingsDialog.tsx:65) and the Rust side; ship UI behind the existing backend enum* |
| **Privacy & data** | Offline toggle (per case), allow_text/allow_images explained as plain sentences, direct media permission (Gemini whole-file ≤12 MiB) toggle, key storage explainer |
| **Transcription & playback** | Default ASR profile (tiny/small) with quality/speed tradeoff copy, auto-transcribe-on-import toggle (maps to automatic pipeline), proxy-on-demand note |
| **Appearance** | Theme: Dark / Light / System; Density: Comfortable / Compact; UI zoom |
| **Case storage** | `storage_usage` breakdown as a horizontal stacked bar + reclaim button (moves the buried Jobs card here) |
| **Shortcuts** | The full keyboard map (§14), searchable |
| **About** | Version, build, "evidence never leaves this machine" statement, licenses link |

Keep every existing disclaimer sentence — they go in the section bodies, styled as the
Disclosure component (§9.4), not as walls of 10px text.

---

## 7. Evidence viewer — from adequate to forensic-grade

Per-kind chrome; the canvas itself stays neutral (`#0d0e11`) so originals read true.

### 7.1 Text / extracted documents

- Keep the paper page metaphor (white page, line numbers, doc-rule) — it's already good.
- Add: **selection → "Ask about L12–L18"** and **"Copy citation"** buttons on selection;
  in-page find (Ctrl+F within tab); line-range URL persisted in tab state.
- PDF-view parity: show extracted text and rendered page side-by-side toggle.

### 7.2 PDF (fixes issue #10)

- **Continuous vertical scroll** of rendered pages (reuse `render_page`, virtualize to
  ±1 page), replacing the one-page+arrows model. Page input box, current page indicator,
  thumbnail rail (toggleable, 96px, generated from existing page renders), zoom 50–200%.
- Kill the `iframe` fallback path for PDFs (rendered JPEGs are already the primary).
- Page context passed to the agent via React state (with §5.4), not DOM scraping.

### 7.3 Images

- Real pan/zoom: cursor-grab panning at zoom >100%, wheel-zoom with Ctrl, double-click
  toggles 100%/fit, zoom presets (25/50/100/200/400%), rotation kept. Replace
  `transform:scale` clipping with a proper transform+overflow stage.
- Keep EXIF/on-error fallback behavior. Add "Open frame at 100%" for derived crops.

### 7.4 Video & audio — the instrument panel (fixes issue #9)

Custom transport under the media (replacing bare native controls — keep native controls
available via a toggle during transition):

```
◀◀ 30s   ◀◀ 1s   ▶/⏸   1s ▶▶   30s ▶▶   | ⏱ 00:41.208 / 12:03.944   0.5× ▾   🔊   [A–B] ⏳
```

- **Frame-step** ←/→ (1 frame at detected fps), J/K/L shuttle, Space play/pause,
  Shift+←/→ 1s, speed 0.25–2.0 (dropdown incl. 0.5 for testimony review), **A–B loop**
  with amber range on the progress bar, time display to milliseconds (forensic norm).
- **Filmstrip** along the bottom: frames from `video_overview` samples (already
  generated); click seeks; current position marked; scene boundaries ticked.
- **Waveform lane** (audio + video): peaks from the sound-scan decoder (already returns
  `waveform` bins) rendered under the scrubber, with decoder-gap hatching in danger tone —
  the honest-buffering-uncertainty the MEDIA-ANALYSIS plan asked for.
- Audio page: big center stage kept (icon + title + waveform + transport); drop the raw
  `<audio>` element look.
- Multi-clip compare lives in Review → Incident replay (§8.1).

### 7.5 Transcript + speakers (fixes issue #18)

The transcript pane graduates to a **scrolling caption column with speaker lanes**:

- Rows `[00:41.2–00:43.8] Officer? — "…show me your hands"` — click seeks (exists),
  active-line highlight (exists) + **auto-follow toggle** (scroll locks to playhead).
- Speaker labels come from saved annotations (exists) shown inline; rename inline.
- **Search within transcript**; jump-list of matches.
- Speaker turns visual: horizontal lanes (one per cluster, labeled, colored in a
  6-hue muted rotation) instead of the checkbox `<details>` list — assignment via a
  small popover per turn (multi-select for overlap kept).
- Keep every honesty caption verbatim ("identity never verified", run-local labels).

### 7.6 Video discovery (OCR/overview)

Keep the Overview / Text-in-video tabs and time-range filter; restyle grid to hover-lift
cards (thumbnail, timestamp, scene chip); "Play" is the primary click target, "View
frame" secondary; status line becomes a thin progress strip ("indexing · chunks through
640s · gaps reported" — no invented percentages, per repo rule). Move
interval/rebuild/cancel into a small "Index settings" popover instead of a nested
`<details>`.

### 7.7 Redaction — draw, don't type (fixes issue #8)

The pane becomes an **annotation mode on the rendered page**:

- "Redact" toolbar button on PDFs/images → crosshair cursor → **drag rectangles** on the
  page render; boxes render as translucent danger overlays with handles; drag to move,
  corner handles resize, Del removes; numeric nudge (arrow keys, 1pt) in an inspector
  popover for precision; box list with per-box delete; page navigation keeps boxes.
- The mandatory per-page human review gate before export **stays exactly as designed**
  (checkbox per page, note, two-step accept/export) — it's the right legal pattern; it
  just gets the same visual system.
- The existing numeric path remains accessible via the inspector (keyboard/precision
  users), but is never the primary flow.

### 7.8 Opening states

- Skeletons (shimmering page-block placeholders) while `render_page`/`process_source`
  run — replacing the text-only "Opening source…" line.
- The "About this preview" limitations disclosure keeps its content, restyled per §9.4,
  collapsed by default with count badge ("3 limitations").

---

## 8. Analysis surfaces — out of the modals (fixes issue #7)

### 8.1 Review workspace (InvestigationWorkbench today)

Becomes the **Review** destination (§4.1) — a full center-pane workspace with its five
views as a proper segmented tab bar (Discrepancies · What changed? · Incident replay ·
Coverage · Legal workflows), not a 1200px dialog. Content upgrades:

- **Discrepancies**: assertion table becomes a real table component — sticky header,
  zebra, per-row status pills, citation chips (with hover previews §5.3), row expand for
  uncertainty/next-check, "What else fits?" and export actions in a row-action bar.
  Launch flow stays (pick account → "Compare with evidence" spawns the investigation
  chat).
- **What changed?**: render an actual **diff** — additions in success tint, removals
  struck in danger tint, unchanged collapsed (backend already returns previous claims).
- **Incident replay**: keep the multi-video sync engine (it's excellent). UI upgrades:
  unified master scrubber spanning all lanes with incident-second scale, per-recording
  offset badges ("−0.42s ±0.05"), keyboard transport (Space/J/K/L/40ms steps exist as
  buttons — add keys), loop toggle in the transport, uncertainty bands on the scrubber.
- **Coverage**: per-source coverage as compact bars per stage (text/pages/frames) with
  **real counts** (backend supplies them) + "next useful check" as an action chip that
  starts that check.
- **Legal workflows + authority retrieval**: a small form card as today, but with
  workflow picker as icon cards (Issue matrix, Discovery, Contract review, Deposition,
  Draft, Exhibit list) instead of a bare `<select>`.

### 8.2 Findings workspace (EvidenceNotebook today)

Becomes the **Findings** destination: a three-pane browser —

- Left: kind filter as vertical icon list (the 17 object kinds grouped: Case objects /
  Analysis / Work products), with counts.
- Center: object cards (title, kind chip, revision, StatusPill, staleness, citation
  chips) in a virtualized list; the existing editor becomes a slide-over panel on
  "Revise".
- The **Clock lab** and **Sound discovery** graduate to first-class cards at top of
  Findings (they create objects) — clock fit results visualize the fit (residual
  scatter, held-out checks, valid range on a mini timeline) instead of a raw table;
  sound discovery keeps its SVG waveform but rendered as an interactive scrubber
  (click a candidate → seek).

### 8.3 Dossiers inline

`QuestionDossier` currently nests inside workbench sections. Render the dossier as a
**structured answer card inside the chat** (collapsed: "Question dossier · 6 findings ·
2 accepted" with StatusPill; expanded: the existing scope/checks/claims/review UI
restructured with the status system and citation previews), and keep the workbench copy
as the cross-question table. Claim review buttons (Accept / Needs review / Reject) get
distinct visual weights — Accept is the only filled button.

---

## 9. Jobs, notifications, feedback

### 9.1 Optimistic updates

Every mutating action (rename, restrict, review, delete, cancel) applies instantly with
an optimistic state and rolls back + toasts on error. The 3s snapshot poll remains the
reconciler but should stop being the *visual* driver.

### 9.2 Jobs center (§4.1 destination 5)

- **Now** section: running/queued jobs as cards with indeterminate progress (activity
  label + elapsed — no fake %), cancel button.
- **Needs attention**: failed/interrupted grouped by source with Resume / Recover saved
  job / Retry (backend actions all exist) and one **"Retry all failed"** affordance.
- **History**: superseded/resolved, collapsed by default with counts.
- Job cards show source chips that open the viewer; receipts copy on click.

### 9.3 Evidence library (replaces floating file-browser)

A dockable **Evidence** destination + the compact popover from the sidebar (keep both
entry points): searchable/filterable table (name, kind icon, status pill, size, hash
prefix on hover), sort by name/date/size, filters by kind/status/restricted, bulk select
→ restrict/unrestrict, "Queue transcripts" (surfaces the unused `transcribe_all`),
drag-out import target. Row actions: open, rename, restrict, verify hash
(`verify_source`, currently unexposed), reveal details.

### 9.4 Disclosure component (one honesty primitive)

Every limitations/limitations-notice/provenance paragraph across the app renders as:

```
ⓘ Disclosure  ▾   (3)
```

muted caption-size text, icon `Info`, collapsed by default with count, expands to the
verbatim sentences. Today these live as full-width paragraphs of 10px text competing
with content; this keeps every word while reclaiming calm. (Hover shows first line
preview.)

### 9.5 Toasts (fixes issue #15)

Bottom-center stack (max 3), variants: error (sticky, danger edge, detail disclosure
with the raw receipt), success (6s, check icon, optional **Undo** action — chat delete
migrates here), info (neutral). Single `notify()` API replacing `setError(String(e))`;
errors get a friendly title + expandable raw string (raw `Error: …` strings as the only
message is unacceptable for non-technical users).

---

## 10. Search & command palette (fixes issue #12)

One palette (Ctrl+K), one input, **no mode buttons**:

```
┌──────────────────────────────────────┐
│ 🔍 _                                │
│──────────────────────────────────────│
│ EVIDENCE   bodycam-summary.pdf       │
│            door-warning.txt          │
│ MEANING+TEXT  "officer gave warning" │
│   → bodycam transcript L214–L222 ⌵   │
│ CHATS      Timeline of door events   │
│ COMMANDS   ⊕ New chat  ⚙ Settings    │
│            ▣ Transcribe all evidence │
│──────────────────────────────────────│
│ ↑↓ navigate · ↵ open · ⇧↵ reveal     │
└──────────────────────────────────────┘
```

- As-you-type (150ms debounce): filename matches first (instant), then hybrid search
  results (one action — merge today's "Search text" / "Search meaning + text" buttons;
  the hybrid path already fuses both), then chats, then commands.
- Results show **match-type badges** (Name / Text / Meaning) — meaning results carry the
  existing honesty note about unindexed passages as a footer chip
  ("indexing · 1,204 passages remaining"), never a blocking error.
- Full arrow-key/enter navigation, recent searches (localStorage), `>` prefix for
  commands-only mode.
- Extend to records + evidence objects via the currently-unused `evidence_search`.

---

## 11. Onboarding, empty states, first run

- **First run** (no case): the chat canvas becomes a guided hero — brand glyph, "Investigate
  your first case", four cards: **Create a case** / **Open a folder** / **Restore backup** /
  **Try the sample case** (packages the synthetic fixture as a real `.ledcase` so the demo
  works natively — today `load_demo` is browser-only). Below, a compact 3-step checklist
  with progress that persists per install: *Import evidence → Ask your first question →
  Review a finding*.
- **Empty states** (every list gets one): icon line-art (reuse brand bars motif), one
  sentence, one action button — e.g. Evidence: "No evidence yet — drop files anywhere or
  browse"; Chats: starter prompts; Findings: "Ask a question with citations and findings
  appear here".
- **Drag-and-drop import**: dropping files/folders anywhere on the window runs the
  existing `import_files`/`import_folder` flow with a full-window drop veil
  ("Drop to import into *Eric Wilson* — originals are preserved"). Biggest single
  ease-of-use win available; backend ready.
- Import progress: quiet status-bar ticker (§4.2) + toast summary with failure details.

---

## 12. Motion & micro-interaction catalog (fixes issue #11)

Tokens: `--dur-1 100ms · --dur-2 160ms · --dur-3 240ms · --dur-4 400ms`;
`--ease-out cubic-bezier(.25,1,.5,1)` (default) · `--ease-in-out cubic-bezier(.6,0,.4,1)`
· `--ease-spring cubic-bezier(.34,1.56,.64,1)` (panels only). Everything disabled under
the existing `prefers-reduced-motion` block — extend it to cover every item below.

| Element | Motion |
|---|---|
| Dialogs/modals | scale 0.98→1 + fade, 160ms ease-out; backdrop fade 200ms |
| Popovers/menus | scale 0.97→1 (transform-origin at anchor) + fade, 120ms |
| Sidebar rail switch | pane cross-fade 160ms (no slide — avoids disorientation) |
| Chat message in | fade + 4px translateY, 180ms, staggered 30ms |
| Streaming caret | 1.1s blink; activity label shimmer sweep 2s |
| Timeline action complete | row check draws in 160ms; running dot pulse (exists) |
| Tabs open/close | width 0↔auto 160ms; active indicator slides 160ms |
| Tree/chat row hover | background 100ms (exists as instant — add duration) |
| Buttons | press scale 0.98, 80ms; primary hover brightens 120ms |
| Citations | hover chip lift + amber border 120ms; preview popover 120ms |
| Toasts | slide-up 8px + fade 200ms; auto-dismiss fade 240ms |
| Viewer skeleton | shimmer sweep 1.6s |
| Filmstrip hover | card lift (translateY −2px + shadow-2) 120ms |
| Video scrub | playhead 60fps (already rAF in replay — keep) |
| Job cards | status change pulses once 240ms |
| Drop veil (drag import) | fade + dashed border dash-march 800ms |
| StatusPill changes | cross-fade 160ms |
| Undo toast | same as toasts; Undo button emphasis flash 240ms |

Rules: no motion longer than 400ms; nothing animates layout-affecting properties except
tabs (width) — everything else transforms/opacity only; 60fps budget; no parallax, no
gratuitous movement in the evidence canvas itself (evidence is solemn, chrome is alive).

---

## 13. Accessibility & readability (fixes issue #3)

- Type floor 11.5px, base 13.5px, answers 15px (§3.3); line-length capped 780px.
- Contrast: all text ≥4.5:1; tertiary ≥4.2:1 and never used for interactive text; test
  both themes with automated contrast checks in CI (`npm test` addition).
- Hit targets ≥24×24 (icon buttons currently 27px — keep; some chat-delete 24px ok).
- Full keyboard operability: palette, menus, tabs, model picker, video transport,
  redaction drawing (keyboard box entry preserved §7.7). Roving tabindex in lists.
- Screen readers: `aria-live="polite"` on status bar and toast region (off during token
  streaming; announce "Answer complete" at end); keep every existing aria-label; add
  `role="log"` to chat scroll.
- Windows UIA: run the (already-planned) UIA pass against the new components; custom
  titlebar buttons already expose names.
- Density and zoom settings (§6.3) as accessibility features, not just preference.

---

## 14. Keyboard map (complete, documented in Settings → Shortcuts)

| Keys | Action |
|---|---|
| Ctrl+K | Palette (§10) · Ctrl+Shift+P commands-only |
| Ctrl+N / Ctrl+Shift+N | New chat / new case |
| Ctrl+O | Open case · Ctrl+I import files |
| Ctrl+1..4 | Chat / Evidence / Findings / Review |
| Alt+1..9, Ctrl+Tab | Switch evidence tabs · Ctrl+W close tab |
| F2 | Rename selected (exists) |
| Enter / Shift+Enter | Send / newline (exists) |
| Esc | Close topmost layer (dialog/popover/menu — unify) |
| Space, J/K/L, ←/→, Shift+←/→ | Viewer transport; , / . frame step; [ ] A–B loop |
| Ctrl+= / − / 0 | UI zoom |
| ? | Shortcut overlay |

---

## 15. Cleanup list (do first, do mechanically)

- `styles.css`: delete unused blocks — `.welcome*`, `.activity-rail`, `.statusbar`,
  `.dashboard`, `.metrics`, `.change-card`, `.coverage-*`, `.search-result`,
  `.case-switch`, `.build-badge`, `.preview-banner`, `.connection`, `.dot` variants,
  `.tree-heading>span`, `.sidebar-navigation`, `.starter-prompts svg` duplicates —
  then the three-layer consolidation (§3.6). Verify each against a className usage pass
  (dynamic template classes included).
- `App.tsx`: remove 14 unused lucide imports (ChevronRight, Files, GitCompareArrows,
  ShieldCheck, ArrowUpRight, Upload, ChevronDown, Archive, Database, Clock3, ListChecks,
  Sparkles, Lock, FolderPlus).
- `EvidenceViewer`: remove dead `frames`/`setFrames` frame-strip state or wire it to
  `processing_status` frame samples.
- `AgentPanel`: fix the `turn.id === task?.id` receipts gate (§5.1); replace text
  `✓`/`⚠` glyphs with lucide icons.
- Replace `document.querySelector('.pdf-navigation')` DOM scrape with state (§5.4).
- Standardize `new Date()` clock effects (one shared `useNow(running)` hook).
- Toast API replaces raw `setError(String(e))` strings (§9.5).

---

## 16. Component disposition matrix

| Component / area | Verdict | Notes |
|---|---|---|
| App shell & layout | **Keep** | + resizable sidebar, status bar, rail nav (§4) |
| Titlebar | **Keep** | tokens only |
| Sidebar chat/project lists | **Refresh** | inline rename, search, context menu, virtualize |
| File browser → Evidence library | **Rebuild** | docked destination + popover (§9.3) |
| Command palette | **Rebuild** | §10 |
| AgentPanel chat | **Rebuild** (rendering) | markdown, timeline, meta row, follow-ups; keep streaming logic |
| Composer | **Refresh** | keep; model picker + attach-from-viewer |
| Model picker | **Rebuild** | §6.2 |
| SettingsDialog | **Rebuild** | settings sheet (§6.3) |
| EvidenceViewer text/pdf/image/video/audio | **Rebuild** (chrome) | keep all processing logic, locators, fallbacks |
| FullTranscript | **Refresh** | captions + speakers + follow + search (§7.5) |
| SpeakerTurns | **Rebuild** | lanes UI (§7.5) |
| VideoDiscovery | **Refresh** | cards + status strip (§7.6) |
| SoundDiscovery | **Refresh** | interactive waveform (§8.2) |
| RedactionPanel | **Rebuild** | draw boxes; keep review gate (§7.7) |
| RecordEditor | **Refresh** | preview toggle, insert-citation helper, diff history |
| EvidenceNotebook | **Rebuild** | Findings workspace (§8.2) |
| InvestigationWorkbench | **Rebuild** (container) | Review workspace; keep replay engine (§8.1) |
| QuestionDossier | **Refresh** | status system + inline chat card (§8.3) |
| FolderImport | **Refresh** | merge into drop + import flow (§11) |
| Toasts | **Rebuild** | §9.5 |
| tokens/theme/motion | **New** | §3, §12 |
| Tooltip/Menu/Popover/StatusPill/Skeleton | **New** | base components |

**New runtime dependencies:** `react-markdown`, `remark-gfm`, `@fontsource-variable/inter`
(optional). Everything else is hand-rolled — no component library (keeps bundle and
offline constraints).

---

## 17. Phased roadmap

Each phase ships independently usable; `npm run check` green is the gate every phase.

**Phase 0 — Cleanup (half day).** §15 entirely; no visual change.
*Accept:* styles.css ≤ 60% of prior size with zero visual diff; tsc/vitest/cargo green.

**Phase 1 — Foundations (2–3 days).** Tokens, single-theme CSS, light theme + toggle,
density, motion tokens, base components (Tooltip, Menu, Popover, StatusPill, Skeleton,
Button/IconButton normalization), toast API, focus/scrollbar polish.
*Accept:* no hex outside tokens.css; both themes pass contrast checks; every existing
screen re-skinned and functional; reduced-motion honored.

**Phase 2 — Chat (3–4 days).** Markdown + citations renderer, meta rows + copy,
receipts-per-turn fix, activity timeline, team cards, streaming polish, model picker,
composer upgrades, chat list upgrades, follow-up chips, welcome starters v2.
*Accept:* a full investigation session is readable end-to-end without opening a single
`<details>`; receipts reachable for every historical turn; model switchable in ≤2 clicks.

**Phase 3 — Viewer (4–5 days).** PDF continuous + thumbs; image pan/zoom; video/audio
transport + filmstrip + waveform; transcript captions + speaker lanes; redaction
drawing; discovery restyle; skeletons; drag-drop import; citation hover previews;
attach-from-viewer.
*Accept:* every media kind openable/navigable by keyboard alone; redaction creatable
without typing a number; locator context flows via state (no DOM scraping).

**Phase 4 — Surfaces (3–4 days).** Rail nav + Evidence/Findings/Review/Jobs
destinations; workbench views upgraded (diff, replay transport, coverage bars); dossier
inline card; settings sheet; palette v2; onboarding + empty states; status bar.
*Accept:* zero feature regressions vs the two modals (checklist audit of every backend
action in §inventory); first-run path create→import→ask→review completes without docs.

**Phase 5 — Polish (2–3 days).** Motion catalog pass on every surface; light-theme QA
screenshot audit; a11y pass (contrast automation + manual keyboard walk); perf
(virtualized lists ≥500 items; memoized snapshot slices so 3s poll doesn't re-render
idle panes); UIA smoke.
*Accept:* interaction latency <100ms; 60fps animations; keyboard-only full case review
possible; both themes screenshot-diffed clean.

---

## 18. Guardrails — do not break

1. **Honesty language verbatim** wherever it exists today; restyled, never shortened.
2. **No invented progress** (percentages, fake step counts) — indeterminate indicators only.
3. **Color never the sole signal** — icon + label always accompany tone.
4. **Offline-first**: no CDN fonts, no telemetry, no runtime downloads; new deps bundled.
5. **No layout jumps or draft loss** — drafts survive navigation, case switches, crashes.
6. **Destructive actions labeled explicitly** and reversible where the backend allows.
7. **Evidence renders true**: canvas neutral, originals uncropped-by-default, derivatives
   labeled as derivatives.
8. **Every action has a visible menu path** — the palette is a shortcut, never the only
   route (repo rule, kept).
9. **Reduced motion respected** across everything §12 adds.
10. **Single-running-task invariant and viewer_request behavior unchanged** — the UI
    redesign must not touch coordinator semantics.
