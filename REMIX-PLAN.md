# Evidence Desk: an accessible evidence workbench

Planning proposal · 2026-09-20 · No application code changed.

## Recommendation

Build one coherent workspace for the complete loop: **bring evidence in → find and inspect → capture a supported observation → connect it to the case → write → review → export**. Combine Cursor's compact controls and continuity, Relativity's review queue, Everlaw's synchronized media review, Acrobat's focused document tools, and Amped Replay's bookmarks. Use the attached design document for visual restraint and palette, adapted to working software.

The app's purpose, inferred from its implementation, is a local evidence investigation workspace: original files remain preserved, working records are versioned, AI operates within explicit source scope, and findings retain citations and uncertainty. It is not currently a law-practice billing/calendar system or a complete forensic video suite. Prioritize the evidence workflow before adding unrelated practice-management features.

This proposal extends DESIGN-PLAN.md. That file remains the visual/control reference; this file defines product organization, workflows, dependencies, and delivery priorities. Attached documents are reference material; the user's request governs scope.

## What was actually inspected

- Live browser preview at localhost:1420: no-case screen, populated synthetic source viewer, working-record editor, and coverage screen at approximately 1280 × 720.
- Existing welcome/sample screenshots in artifacts, including the wider populated layout.
- App.tsx, styles.css, bridge.ts, types.ts, all four main components, and relevant Rust/worker code for processing, agent scope, citations, and export.
- Existing design plan and the previously read DESIGN-cursor.md.
- Official vendor documentation listed below; Everlaw's illustrated media guide was also inspected in the browser. Earlier Cursor research included full-size official demo frames.

This was a design and code audit, not native end-to-end validation. The browser sample is synthetic and cannot verify file imports, worker isolation, actual AI requests, media codecs, or backup/restore.

## Current strengths and friction

| Current observation | Design consequence |
| --- | --- |
| Evidence and working records are already distinct; restrictions, revisions, and source identity exist | Preserve these concepts and make their relationship visible |
| The dark shell is already cohesive, with a readable light document surface | Refine density and hierarchy instead of replacing every visual decision |
| The welcome screen and empty agent pane both contain prominent introductory copy | Replace repeated explanation with recent work and useful next actions |
| At 720px height, the agent composer, source coverage block, and import footer consume substantial space | Put detailed metadata in an inspector; collapse the assistant; move the import label into the import flow |
| Sources and Working files rail buttons change the tab label without reliably opening a distinct corresponding workspace | Each navigation item must reveal its named content and preserve its own selection |
| A single selected file is styled as a tab; the sidebar toggle icon is decorative | Implement genuine tabs and panel controls before suggesting those capabilities visually |
| Agent citations pass only sourceId to the viewer; the parser omits backend-supported artifact locators | Introduce exact-location navigation and a shared locator contract |
| Draft content lives inside a keyed editor that unmounts when switching records | Preserve drafts across navigation; test recovery and close/case-switch decisions |
| PDF/DOCX/XLSX extraction and image metadata/crop capabilities exist in backend code, but ordinary viewer controls do not expose them | Provide explicit local processing actions and artifact inspection, independent of AI |
| Coverage counts assume text kind/status, and the viewer displays a fixed 33%/66% coverage bar | Replace inferred percentages with factual per-capability states; reconcile the outdated coverage warning with backend capabilities |
| Changes opens record/history workflows rather than an actual revision diff | Build a comparison view before labeling the workflow as compare/review |
| Video/audio use native playback controls; transcription and exact-frame analysis are unavailable | Plan progressive media tools, clearly identifying new engine work |

## Research: what to borrow

| Reference | Supported product pattern | Adaptation |
| --- | --- | --- |
| [Cursor interface](https://cursor.com/changelog/3-0) and [compact chats](https://cursor.com/changelog/3-4) | Adjacent working panes, flexible tabs, compact activity | Stable tabs, contextual toolbars, optional assistant, preserved focus |
| [Relativity review guide](https://help.relativity.com/PDFDownloads/R1_PDF/RelativityOne%20-%20Review%20interface%20quick%20reference%20guide.pdf) | Review queue, viewer-type tabs, related items, viewer-specific tools | Keep search results beside an open source; previous/next navigates the filtered queue |
| [Everlaw Media Review](https://support.everlaw.com/hc/en-us/articles/204898319-Media-Review) | Synchronized transcript, click-to-seek, timestamped notes, resync after manual scrolling | Player + transcript + bookmark workflow with a clear Follow playback toggle |
| [Acrobat Compare](https://helpx.adobe.com/acrobat/using/compare-documents.html) | Side-by-side comparison and navigation between changes | Compare working revisions and selected document versions with linked source context |
| [TimelinePad](https://www.litsoftware.com/timelinepad) | Events connected to evidence, filtered timeline views | A case chronology backed by citations; list and timeline views share the same events |
| [Amped Replay workflow](https://blog.ampedsoftware.com/2026/09/15/prepare-digital-multimedia-evidence-for-court-with-replay) | Frame bookmarks, descriptions, annotations, exportable viewing logs | Mark moments while watching, add observations, then produce a cited viewing log |
| [Descript](https://www.descript.com/tools/video-editor) | Transcript-centered access to audio/video content | Borrow text navigation; transcript corrections must remain separate from original media |

These are pattern references, not claims of feature parity or comparative performance. Do not import enterprise administration clutter, media-altering transcript edits, or unsupported forensic enhancement claims.

## Navigation and workspace

### Updated direction: multiple case sections

User refinement: give every case its own section and move the shell closer to Cursor/Codex in density, access and visual restraint. This supersedes the earlier separate global navigation plus evidence-list layout where they conflict.

- One persistent left sidebar contains pinned cases and other cases, each as an expandable named section. Each case owns Overview, Evidence, Casebook, Drafts, Tasks and Review, with counts only when useful. Nested rows reveal files or tasks for the selected section. Avoid an additional permanent navigation rail plus redundant source column.
- Keep the active case expanded; other cases may remain expanded at the user's choice. Highlight the active case and selected item distinctly. Collapse, pin, reorder and search cases. New case and Open case remain visible at the sidebar top; backup/restore and settings sit in the case context menu.
- Keep case identity in the workspace header, search scope, tabs and assistant context. Search defaults to the active case. A case switcher searches case names; any future cross-case content search must be an explicit, separately scoped feature.
- Each case restores its own tabs, selected evidence, scroll/playback positions, layout and recoverable drafts. Group tabs by case and show only the active case's tab group by default. Do not silently carry assistant attachments, permissions, budgets, draft text or search results into another case.
- Display a small activity badge beside a case when work needs attention. Case sections organize separate local stores; they do not merge case evidence or grant the assistant access across cases.
- The current backend supports one open case and blocks switching while an agent task runs. First delivery can provide a recent-case registry and safe switching with preserved UI state, explaining the stop requirement. Running work concurrently across cases is later backend work: per-case handles, job routing, locks, event identifiers, budgets and cancellation must be isolated before promising background continuity.

Updated shell: **case sections sidebar → tabbed working canvas → optional Notes/Details/Assistant pane**. Show the evidence results list as an expandable subpane only when browsing/searching; hide it in focused reading. The assistant may expand for an investigation and collapse back to a small access button.

Cursor/Codex-inspired treatment: compact 28–32px sidebar rows, small monochrome icons, subtle selected-row fill, thin separators, short tab headers, restrained charcoal or warm-light surfaces, plain labels and minimal card framing. Keep frequent actions adjacent to the affected file or task. Avoid oversized file tiles, repeated search boxes and always-visible form panels. Visual density must preserve readable text, keyboard focus and adequate targets. Real speed still requires profiling, cached case metadata, incremental updates and responsive job execution.

Acceptance addition: open two synthetic cases; create a draft and select an evidence location in each; switch repeatedly and confirm case identity, tabs, drafts, permissions and attachments remain correct. Test switching with a running task and missing/unavailable case folder. Never display a successful switch while the underlying case store is still the old one.

Use a labeled left navigation by default, collapsible for experienced users. Five destinations are enough:

| Destination | Contents and principal action |
| --- | --- |
| **Evidence** | All sources, saved searches/collections, document and media filters; **Import** |
| **Casebook** | Notes, claims, events, people, issues, open questions; **New entry** |
| **Drafts** | Reports and other working documents; **New draft** |
| **Tasks** | Investigations and processing jobs, with type/status filters; **New investigation** |
| **Review** | Unreviewed changes, stale findings, revision comparisons, export checks; **Review next** |

Casebook is a structured view over relevant working records, not a second copy of them. Drafts uses the same versioned record system. Existing record kinds migrate without losing identity/history. Manual to-dos can begin as open questions; a separate task scheduler is not implied.

The case menu contains recent/open/create/close, backup/restore, settings, and case details. Processing coverage lives under Tasks and is also reachable from a status indicator. Settings stays consistently accessible at the bottom of navigation. Export lives beside the document or collection being exported and in Review.

```text
Case menu ▾                 Search this case…     Commands     Import
────────────────────────────────────────────────────────────────────
Evidence    │ Results / collection │ Open tabs                 │ Inspector
Casebook    │ filters and rows     │ Source / draft / compare   │ Details
Drafts      │                     │ contextual toolbar        │ Notes
Tasks       │                     │                           │ Assistant
Review      │                     │ working canvas            │ (optional)
            │                     │ media controls when needed│
Settings    │                     │                           │
────────────────────────────────────────────────────────────────────
Local / API state          Processing 2 · Review needed 3      Status
```

This is an information layout, not a pixel specification. Use a compact navigation + results + canvas by default; the inspector opens when useful. At narrower sizes collapse the results drawer or inspector instead of squeezing all panes. Keep a visible button to restore each pane. Reading, Media, Compare, and Writing presets rearrange these same regions and preserve selection; they are not separate navigation systems. A two-item Compare selection opens split content without requiring two full applications side by side.

## Task access map

| User wants to… | Entry point | Expected result / recovery |
| --- | --- | --- |
| Resume work | Launch → recent case | Last tabs, positions, layout and recoverable drafts return |
| Create/open/restore | Launch or case menu | Clear destination selection and useful error message |
| Import sources | Persistent Import or drop into Evidence | Batch/source label entered once; receipts show imported, duplicate occurrence, failed |
| Extract document text | Source toolbar → Process, or batch selection | Available processor, local status, limitations and retry visible |
| Find something | Case search + filters | Results include source and exact hit; visible scope and processing gaps |
| Search only this file | Viewer Find / Ctrl+F | Highlight hits and navigate without losing case search |
| Inspect a document/image | Open source | Original/text/derived tabs when available; thumbnails, fit and zoom as applicable |
| Inspect a recording | Open audio/video | Playback, time navigation, bookmarks; transcript when actually available |
| Capture evidence | Select text, region or time → Add note | Note contains source location and can reopen it |
| Record a claim/event | Selection → Add to Casebook | Prefilled citation, type, author and uncertainty; review before saving |
| Compare accounts | Select two sources → Compare | Side-by-side source views plus a place to record the discrepancy |
| Build a chronology | Casebook → Events | Sortable list first; timeline and filters over the same records |
| Ask a focused question | Selection → Ask, or Assistant | Visible source chips and permission/readiness state before sending |
| Run an investigation | Tasks → New investigation | Named scope, mode and budget; durable status with stop/resume behavior |
| See changed records | Review | Before/after diff, citations, history and explicit review/restore actions |
| Write a report | Drafts | Source-linked writing, draft recovery, saved revisions, preview |
| Export work | Draft/collection → Export | Explicit format, included material and destination; success receipt |
| Restrict evidence | Source details or batch action | Persistent restriction badge; dependent output restrictions propagate |
| Check integrity/history | Source details / record history | Verification result, occurrences, revisions and relevant audit events |
| Back up the case | Case menu → Backup | Separate encrypted-backup flow, completion and failure handling |
| Configure AI/access | Settings or assistant readiness link | Local/offline state, permissions, key status and cost settings |

All major actions have a menu/button path. The command palette accelerates access but is never the only route. Preserve Ctrl/Cmd+K for case search; propose Ctrl/Cmd+Shift+P for commands, subject to platform collision checks.

## Format-specific working surfaces

**Documents and spreadsheets.** Provide Original, Extracted text, and Details views based on actual capability. Label extracted text as a derivative and show fidelity limitations on demand. PDF page navigation and document thumbnails require an integrated viewer. DOCX paragraph/table and XLSX sheet/cell locations must remain distinct from invented page numbers. Add image fit/actual size, rotate-view, region selection and cited crops. OCR is a future processor, not a cosmetic toggle.

**Video and audio.** Start with robust supported-codec playback, keyboard seek, time display, bookmarks and start/end ranges. Add a transcript pane only when an imported/aligned or generated transcript exists. Show transcript provenance and corrections separately. A selected segment can create a note, event, or task attachment. Keep media-relative time, camera-displayed time and corrected case time separate. Any clock adjustment records its basis and uncertainty. Approximate HTML playback seek must not be labeled frame-accurate. Exact frames, VFR handling, waveform generation, synchronized recordings, transcription and redacted exports need dedicated engine work and tests.

**Casebook and writing.** Separate observation, attributed statement, and inference through a small entry-type field. Claims link supporting and conflicting sources. Events can have approximate/ranged/unknown dates. Drafts initially retain Markdown with readable preview and citation insertion; consider a richer editor only after navigation and provenance work. Auto-recover local drafts independently from committing a reviewed revision.

**Assistant and tasks.** Default to a compact, optional assistant. Show selected sources and derived-record dependencies explicitly, with a count and inspectable list. Provide short modes: Ask, Investigate, Edit selected drafts. Show why an action is unavailable and a direct setup path. Task activity is collapsed by default; outcome, citations, changed records and gaps are easy to inspect. Keep processing jobs and AI investigations visibly distinct even when listed together. Proposed diffs/acceptance workflows must state whether changes are pending proposals or already-saved unreviewed revisions; the current backend writes revisions directly.

## Reliability and data work behind the design

1. Define a shared citation/locator model for text lines + extraction revision, original image, derived artifact, PDF page, sheet/cell and media range/frame. Preserve old links. Validate and resolve supported types end-to-end; clicking opens and highlights/seeks the target, with a return-to-origin action.
2. Expose typed capability and processing states. Separate preserved, previewable, extracted, indexed, failed, unsupported and human-reviewed. Review status needs real persisted data, including partial review; processing never implies review.
3. Add persistent workspace state and per-record recoverable drafts. Prevent case switching from silently losing edits; handle newer revisions and restricted dependencies.
4. Add structured annotations/events/relations behind Casebook, stable IDs, history and provenance. Keep manually asserted facts distinct from model output.
5. Create an asynchronous processing queue with progress/results/errors. Current native dispatch holds the case mutex while processing; moving work off the renderer alone does not guarantee responsive case queries. Shorten lock duration, stage processing, and commit validated results transactionally.
6. Paginate search and inventory, expose continuation rather than dropping next_offset, and cache previews. Profile large cases before introducing list virtualization. Avoid refreshing unrelated panes for every action.
7. Keep original evidence separate from derived previews, transcripts and exports. Current exports are draft MD/TXT/JSON; sanitized disclosure packages, DOCX/PDF reports, clips and verified redactions are separate future deliverables.

## Visual and accessibility rules

- Offer the current restrained dark shell and a warm light theme based on the attachment. Decide the initial default during prototype comparison; do not make recoloring the main milestone.
- Use readable 13–14px control text and 14–16px reading text; reserve tiny uppercase text for nonessential labels. Support text scaling.
- Common controls share height, icon stroke, spacing and states. Keep 28–32px compact controls where appropriate, with adequate pointer targets and larger touch affordances.
- Use explicit labels for principal actions, neutral backgrounds for routine controls, one restrained primary accent, and separate semantic status colors. Do not use color alone for restrictions, selection or review state.
- Hover, pressed, selected, focus, disabled and loading are distinct. No button size changes during loading; no bounce animation. Respect reduced motion.
- Keyboard focus order follows the workspace; menus support arrows/Escape, dialogs return focus, and resizable panes also have keyboard controls. Tooltips expose shortcuts and full truncated names.
- Empty states offer the next applicable action. Local operation errors stay next to the failed item; the job/task retains its error and retry path. Avoid repeated global toasts.

## Delivery order and completion gates

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 — Clear and dependable | Shared controls; labeled navigation; collapsible assistant/inspector; real tabs; draft retention; factual coverage; exact existing citation navigation | Open source → note → source → draft without losing location or edits; all visible navigation works |
| 2 — Useful evidence review | Search/results queue, continuation, saved filters, local processing UI, extracted-text/artifact views, source annotations, actual revision diff | Import mixed synthetic fixtures → process supported formats → find exact text → cite → review revision |
| 3 — Connected case work | Structured Casebook, events/relations, list chronology, report citation insertion, task outcome links | A finding can be traced from draft to event/note to exact source and back |
| 4 — Media investigation | Time-range bookmarks and viewing logs first; transcript alignment/generation and exact-frame engine afterward | Reopen saved media locations reliably; disclose unsupported codecs and timing uncertainty |
| 5 — Advanced output | Timeline visualization, multi-source comparison refinements, richer reports; verified media/redaction packages only with supporting engine | Export reproduces selected reviewed material, records provenance and clearly identifies draft versus prepared package |

Do not ship inactive buttons for later-phase features. Discoverability comes from supported actions and clear unavailable states, not a large toolbar of promises.

## Verification and success measures

Test with representative synthetic cases containing text, multi-page PDF, scanned PDF, DOCX, XLSX, photos, audio/video, duplicates, restricted sources, long names and failed processors. Use both a small case and a documented large-case workload. Verify native workflows separately from browser visuals.

- New user can locate import, search, note, investigate, review and export from visible labels without learning shortcuts.
- Routine tasks are within one or two navigation choices of the active workspace; creating/editing content can still require its necessary form steps.
- Citation round trip opens the exact cited location and restores the originating task/draft afterward.
- Switching tabs, layouts, cases or recovering from restart does not silently lose drafts or positions.
- At 1280×720 and a larger desktop size, the main content remains usable; no essential buttons are clipped. Check text scaling and keyboard-only use.
- Long processing does not block navigation or typing. Proposed target: p95 local control feedback under 100ms on documented hardware; measure, do not infer from animation.
- Empty, pending, unsupported, partially processed, failed, restricted, stale and reviewed states remain distinguishable.
- Export and restore tests verify provenance/revisions and restrictions; no claim of legal sufficiency is inferred from a successful file export.

The first implementation slice should be **Evidence → exact source location → note/draft → revision review**, with the improved shell around it. That establishes the reusable interaction model before expanding media and chronology features.
