# VisLex redesign coverage and reference disposition

Base: `298ab4291659ab4235c9c7e497a7a74190c0a6e0` on isolated `codex/vislex-redesign`.
Only synthetic browser data may be used for design captures. A row is **verified** only after its interaction and relevant native behavior have been exercised on the combined candidate.

| Surface / actions to preserve | Current owner or handler | Redesign state | Verification still required |
|---|---|---|---|
| Startup, create, open, restore, recent cases, sample preview | `App` | In progress: new tokens, two-column entry layout, named create/restore dialogs | Native dialogs, missing folders, complete synthetic walkthrough |
| Case rename, import files/folders, note, backup, delete | `App`, `FolderImport` | Pending | Confirmations, failure preservation, native lifecycle |
| Titlebar, five workspace shortcuts, sidebar, chats, projects | `App` | In progress: collapse, persisted adjustable width, and layout presets | Native focus and case switching |
| Search/command palette, source and command results | `App` | Implemented: keyboard result semantics, case-independent settings command | Native focus and case switch; exact locator DOM tests pass |
| Conversation list, history paging, delete/undo | `App`, `AgentPanel` | Pending | Interaction tests |
| Composer, context, model, send/stop, drafts | `AgentPanel` | In progress: auto-growing input, case summary, task suggestions, isolated frame-batched stream | Native IME, draft retention, blocked reasons, streaming responsiveness |
| Tool receipts, team activity, error, resume/continue | `AgentPanel` | In progress: clearer saved/running/paused/error labels | Existing functional tests and native journey |
| Evidence and working-file library, filter, paging, restriction | `EvidenceLibrary` | In progress: responsive filter controls | Paged rows, restriction, case fences |
| Viewer tabs, back/forward, source locator | `App`, `EvidenceViewer` | In progress: keyboard-resizable pane, narrow return tested in synthetic browser | Exact revision and scroll preservation |
| Text/image/PDF, copy citation, zoom and limits | `EvidenceViewer` | Pending | Native and historical citation journey |
| Audio/video controls and discovery | `EvidenceViewer`, discovery components | R14 exact-frame control and native worker integration cherry-picked; visual redesign pending | Packaged transport, frame/clock gates on combined candidate |
| Transcript, speaker turns, corrections | `FullTranscript`, `SpeakerTurns` | R16 loaded-row bound integrated; visual polish pending | Long segment paging and correction review |
| Record editor, revision conflicts, saved export | `RecordEditor` | R16 case/record draft isolation integrated; editor loaded on demand | Review invalidation and export |
| Findings and notebook object kinds | `EvidenceNotebook` | R17 structured comparison/work-product forms integrated with redesigned toolbar, object display and empty/paged states | Native save, all kinds, dependencies, citations |
| Discrepancy, changed, replay, coverage, legal review | `InvestigationWorkbench`, `QuestionDossier` | Pending | Human decisions and uncertainty |
| Redaction and restricted derivative export | `RedactionPanel` | Pending | Derivative-only native export |
| Jobs, failures, retries, cancel, storage | `JobsCenter` | In progress: completed runs visible, status filters, pending-action deduplication | Full action routing, complete history and native recovery |
| Provider/model settings and credentials | `SettingsDialog` | In progress: separated navigation and on-demand loading | Credential Manager and native save |
| Case permissions and review/execution choices | `SettingsDialog` | In progress: separate sections, same save contract | Negative permission tests |
| Dark/light/System, compact density, About without case | `ThemeProvider`, preferences dialogs | Implemented, frontend tests pass | Visual contrast, OS switch, packaged first paint |
| Menus, tooltips, dialogs, notifications, empty/error/loading | `ui`, global CSS | In progress: token treatment, duplicate-toast suppression, keyboard tooltip and context-menu focus return | Dialog focus, accessibility, all states |

## Vstorm frontend disposition

Source audited at [`3428d9a6214619d3514312886d59a36400747b7d`](https://github.com/vstorm-co/full-stack-ai-agent-template/tree/3428d9a6214619d3514312886d59a36400747b7d), MIT licensed. These are design and interaction references; no Vstorm source or assets have been copied into VisLex.

| Component category | Disposition | VisLex mapping |
|---|---|---|
| Chat container, message list/item, input, controls, conversation sidebar | Adapt | Existing `AgentPanel` and case sidebar; preserve native stream/cancel semantics |
| Pending messages, tool-call cards/results, research replay, subagent feed/panel | Adapt | Existing task/action receipts, team activity, and review gates |
| File preview cards/panel, sources panel, knowledge-base viewer | Adapt | Evidence library, citation chips, source inspector |
| Markdown, copy button, empty state | Adapt | Existing citation parser, Markdown renderer, and copy interaction |
| Chat charts/maps, rating, sharing, slash commands | Reference only | Use relevant presentation patterns; no unsupported chart/map, public share, or rating flow |
| Dashboard header, tabs, quick actions, recent activity, status cards | Adapt | Case overview, Jobs, workspace headers |
| Layout header, sidebar, breadcrumb, command palette, mobile tab bar | Adapt | Desktop shell, history/navigation, responsive one-pane flow |
| Settings nav/section, appearance, theme controls | Adapt | Case settings and device appearance |
| UI buttons/fields/menus/dialogs/tabs/tooltip/progress/skeleton/table | Adapt selectively | VisLex wrappers, accessibility tests, consistent tokens |
| Error/loading states and onboarding shell | Adapt | Case opening, unavailable capabilities, recoverable failures |
| RAG sync wizard and drag/drop overlay | Reference only | Local import/processing UI; no cloud sync |
| Admin, auth, billing, organization/team, marketing, legal-site, blog, SEO, public demo, social share | Not applicable | Hosted SaaS surfaces do not belong in local case handling |

## Baseline and current evidence

At base `298ab42`: 63 frontend tests passed; production bundle 446.74 kB JS (131.61 kB gzip) and 56.54 kB CSS (11.18 kB gzip). With R13–R17 and the selected R03/R07 changes integrated, 93 frontend tests pass; current initial JavaScript is 415.82 kB (123.54 kB gzip), and CSS is 66.19 kB (12.94 kB gzip). Settings, findings, review, and record editing load on demand. This is a payload comparison, not a measured startup or interaction-speed gain. Edge/Playwright synthetic tests cover navigation, OS System theme changes, reduced motion, lifecycle-dialog focus and validation, and four desktop viewport sizes; axe-core WCAG A/AA scans pass for both themes on startup, five workspaces, create/restore dialogs, expanded structured-findings forms, and all settings sections under reduced motion. A >64 KiB streamed draft test preserves its prefix and final segment. These checks do not constitute a packaged Windows or screen-reader verification. The browser preview still lacks a `case_summary` fixture, reported to the bridge owner.

The non-ignored Rust/core suite passed with `VISLEX_WORKER_PATH` pointing to the existing local development worker, including after R13–R17 and the selected R07 changes. The first run without that resource failed six processor-dependent tests because the isolated checkout had no ignored worker assets; a later run with an incorrect worker path failed the same six tests and passed after correction to `evidence-worker.exe`. Desktop-feature `cargo check --locked` and a debug desktop executable build pass after linking the ignored worktree resource directory to the same local worker. The newly integrated synthetic native integrity script failed with an opaque `Uncaught (in promise)` rejection in this debug WebView; its owner is adding action-labeled diagnostics and testing a package. These checks do not verify the packaged redesign.

Bundled asset: Inter Variable from [rsms/inter](https://github.com/rsms/inter), SIL Open Font License 1.1; local license at `src/assets/fonts/Inter-LICENSE.txt`, SHA-256 `693B77D4F32EE9B8BFC995589B5FAD5E99ADF2832738661F5402F9978429A8E3`. No runtime font request is made.
