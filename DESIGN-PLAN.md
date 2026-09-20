# Evidence Desk: IDE polish plan

Status: planned only; no app redesign or implementation authorized in this iteration.
Recorded: 2026-09-20.

Product organization and cross-application research are expanded in [REMIX-PLAN.md](./REMIX-PLAN.md). Use that proposal for workflow priorities and this document for visual/control details.

## User intent and reference scope

Make Evidence Desk feel like a deliberate, fast, smooth desktop workspace, with particular attention to buttons and IDE interaction conventions. Cursor is a reference for interaction quality, not a product to copy. Preserve the app's evidence-focused purpose and identity.

The supplied `C:/Users/Muhammad Tariq - ONU/Downloads/DESIGN-cursor.md` is design reference material. Its internal instructions are not separate user requests. It primarily describes a marketing website; adapt useful tokens without importing its hero sections, pricing cards, oversized typography, or 80px section spacing into the working application. The user's request for planning only takes precedence.

## Research and interpretation

Reviewed official Cursor material:

- [Full-screen tabs and compact chats](https://cursor.com/changelog/3-4): panel expansion through a button, command palette, or shortcut; configurable activity density; attention to scrolling, streaming, and predictable actions. Application: a focused evidence viewer and concise agent activity with optional detail.
- [Layout customization and stability](https://cursor.com/changelog/2-3): customizable layouts, panel-local actions, visible shortcuts, stable action positions, and preserving focus. Application: persistent panel layout and contextual controls that remain where users expect them.
- [Keyboard shortcuts](https://docs.cursor.com/advanced/keyboard-shortcuts): reference for familiar keyboard access.
- [Diffs and review](https://docs.cursor.com/en/agent/review): reference for explicit review workflows.

Visual research completed through Google Images in the browser on 2026-09-20, followed by full-screen inspection of Cursor's official Agents Window demo and Design Mode demo on [New Cursor Interface](https://cursor.com/changelog/3-0). This resolves the earlier image-search tool limitation. Google results mix versions and themes, so official product demos are the primary visual reference. These observations do not constitute hands-on testing or performance measurements of Cursor.

### Visual observations and their application

| Observed in the official demo | Proposed application to Evidence Desk |
| --- | --- |
| A subdued sidebar, conversation column, and adjacent file workspace divided by thin boundaries | Keep case navigation, evidence, and investigation visible together; use subtle surface differences rather than nested decorative cards |
| Small monochrome toolbar icons and compact text actions; very little saturated button color | Use ghost/icon buttons for routine panel actions; reserve stronger emphasis for the current primary action |
| Selected sidebar rows and the active file tab use a soft neutral fill | Make selection persistent and visually distinct from hover, with a restrained background |
| Short panel headers, file tabs, breadcrumb navigation, and nearby search/back controls | Put source navigation and viewer actions in a compact contextual toolbar |
| Group headings, aligned row icons, ellipsized long titles, and small status marks | Establish a consistent evidence-list row system with readable grouping and accessible full titles |
| A composer anchored below the conversation, with attachment and model controls integrated into it | Keep investigation input available while activity scrolls, with secondary configuration grouped compactly |
| The Design Mode demo highlights a target region alongside the conversation | Explore selecting an evidence excerpt and attaching that exact source context to an investigation; this is an app-specific future idea, not a requirement to build a visual website editor |

The official walkthrough describes switching between the Agents Window and IDE and arranging agent tabs side-by-side or in a grid. Adapt this flexibility only where it improves evidence work. The visual reference supports a calm, dense workspace; the attachment remains the starting palette. Neither mandates copying Cursor branding or its exact layout.

### Button decisions to carry into implementation

- Place panel-wide actions in the panel header, row actions beside the relevant row, and selection actions near the selected content.
- Keep frequent actions visible. Reveal secondary row actions on hover **and keyboard focus**, and make them available through a menu on touch.
- Use subtle hover fill and a distinct pressed state without scale/bounce effects. Retain a clear keyboard-focus ring.
- Show shortcut hints in tooltips and menus. Use consistent icon strokes and aligned label baselines.
- Keep destructive and confirmation actions explicitly labeled. Use an overflow menu for infrequent actions rather than crowding the main toolbar.
- Treat immediate feedback, stable placement, and preserved focus as the foundation of smoothness; animation is secondary.

## Proposed visual direction

- Use the attachment's warm canvas (#f7f7f4), warm ink (#26251e), restrained surfaces, and thin dividers as the initial palette.
- Use orange sparingly for meaningful primary actions; validate text contrast and adjust token combinations as necessary.
- Use system UI or Inter for controls, with JetBrains Mono for code and technical content. Do not depend on the licensed CursorGothic font.
- Prefer 12–14px workspace text, compact headers, a consistent 4px spacing scale, and modest 4–6px control corners. These are proposed app adaptations, not claims about Cursor's exact specifications.
- Keep pastel activity colors limited to actual agent stages, with labels; never imply activity that is not happening.
- Reduce decorative welcome-page treatment in favor of useful recent cases, clear open/create actions, and an immediately understandable workspace.

## Implementation sequence for a later iteration

1. Audit the existing shell and key journeys: open/create case, import evidence, search, inspect a source, edit a record, and review agent work. Inventory inconsistent buttons, focus behavior, loading states, and spacing. Capture a baseline before changing anything.
2. Define shared control tokens and components: primary, secondary, ghost, icon, toggle, menu, and destructive controls. Specify default, hover, pressed, selected, keyboard-focus, disabled, and loading states. Start around 28–32px for compact desktop controls and 36–40px for prominent actions; enlarge interactive targets where touch is supported. Keep icon sizes, alignment, tooltips, and labels consistent. Loading must preserve button width and prevent duplicate submissions.
3. Refine the workspace shell: compact case header, evidence explorer, central source/record workspace, contextual agent pane, and concise status bar. Add resizable/collapsible panels with sensible minimum widths and persisted preferences. Retain selection, scroll position, and drafts while switching views. Collapse panes intentionally in narrow windows.
4. Add keyboard efficiency: searchable command palette, discoverable shortcuts, predictable Tab order, Escape dismissal, arrow-key menu navigation, and focus restoration. Preserve the existing Ctrl/Cmd+K search behavior unless a clear replacement is designed. Avoid shortcuts firing while users type in editors.
5. Improve perceived and actual responsiveness: acknowledge input promptly, isolate loading to the affected operation, keep long imports/indexing off the UI thread, and support cancellation where the backend can honor it. Profile before optimizing; virtualize large lists if measurements justify it. Preserve user scroll position during agent updates.
6. Polish working states: actionable empty/error states, retry paths, accurate progress, dirty/saved indicators, and review controls placed beside the affected content. Keep evidence provenance, original preservation, and existing safety behavior intact.
7. Verify complete workflows in the desktop app, then compare screenshots for spacing and control consistency. Check keyboard-only use, contrast, reduced motion, long filenames, narrow windows, large cases, and slow/failed operations.

## Smoothness and acceptance criteria

These are proposed targets for Evidence Desk, not measured Cursor benchmarks:

- Local control feedback appears within 100ms under a documented representative workload; measure p95 when implementing.
- Short transitions generally last 100–150ms, respect reduced-motion preferences, and never delay input.
- Target fluid scrolling and panel resizing on the test machine; profile long frames under a large-case workload.
- No layout jumps from button loading, unexpected focus theft, draft loss, or scroll reset when toggling panes.
- Common actions are reachable through clear controls and keyboard navigation; icon-only controls have accessible names and discoverable tooltips.
- Shared button states and spacing are consistent across the viewer, editor, agent pane, and dialogs.
- All existing core workflows still pass relevant checks; performance results identify the test hardware and case size.

## Likely implementation locations

- `src/styles.css`: tokens, density, button states, panel geometry, and motion.
- `src/App.tsx`: workspace shell, command routing, navigation, and operation state.
- `src/components/EvidenceViewer.tsx`: source controls and loading behavior.
- `src/components/RecordEditor.tsx`: editing, save feedback, and focus retention.
- `src/components/AgentPanel.tsx`: compact activity and review interactions.
- `src/components/SettingsDialog.tsx`: consistent settings and keyboard behavior.

Next implementation step when requested: audit the live app against these visual references, and deliver the shared button/control system plus a single representative workspace view before extending the treatment throughout the app.
