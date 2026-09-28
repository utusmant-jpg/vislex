# Claude kickoff prompt: redesign VisLex without breaking it

You are the lead designer and implementation engineer for my existing VisLex Windows evidence application. I have Claude Max and want YOU to perform the research, parallel-agent design planning, implementation, and verification. Do not merely advise me or return a generic plan. Build your own concrete plan from the current application, then carry it through in small reviewable slices.

## What I want

Comprehensively redesign the app so it feels like an exceptional premium desktop product: beautiful, coherent, easy to learn, easier to use, responsive, thoughtfully animated, and polished throughout. Be ambitious about the visual experience while preserving every working capability and protecting evidence. Translate my aspiration for a "billion-dollar app" into concrete usability, visual craft, accessibility, reliability, and measured performance. Reduce bugs; never promise that software has zero bugs.

Redesign the complete experience, not just chat: onboarding/case opening, application shell and navigation, evidence browser and source inspector, document/media viewing, search, AI conversation and tool activity, findings and investigation workflows, review/export, job progress/recovery, and settings. Inspect what actually exists before naming screens or replacing components. Make primary journeys obvious, reduce clutter, provide clear hierarchy, and make advanced power available without overwhelming beginners. Use realistic synthetic evidence in previews.

## Start with the actual repository

1. Read CLAUDE.md, AGENTS.md, docs/GLM-IMPLEMENTATION-PROMPT.md and docs/implementation/NEXT-PLAN.md once. Inspect git branch, HEAD and status. Run `python scripts/vislex_plan.py check` and `python scripts/vislex_plan.py next`, then request only the relevant task packets. Do not restart VL-001 or reread every historical plan.
2. Inspect current frontend, direct callers, Rust bridge contracts, tests and existing design tokens. Characterize the working journeys and known defects from current code rather than assuming the audit base still describes HEAD. Run the available baseline checks and record failures/environment blockers honestly.
3. This is my explicit authorization to redesign the visual system, navigation presentation, and interaction patterns even where earlier plans favored preserving the current theme/rail. Preserve functional and safety contracts. Finish necessary correctness prerequisites before replacing the dependent production surface; independent design research and isolated UI work can proceed meanwhile.

## Parallel agents and current web research

Use actual parallel Claude agents with explicit scopes: product/workflow and information architecture; visual design/motion/accessibility; component-library and tooling research; architecture and regression review. Start with read-only research and review. Use the supported agent mechanism in this installed Claude Code version. If teams are unavailable, use available parallel subagents and say exactly what ran; never simulate a team or invent findings. Synthesize their reasoning rather than treating agreement as evidence of correctness.

Search the web and inspect official documentation and repositories. Begin with https://github.com/assistant-ui/assistant-ui and its documentation. The repository currently has @assistant-ui/react and `src/chat/vislex-runtime.tsx`, with integration in `src/components/AgentPanel.tsx`; revalidate these paths and reuse the Rust-owned conversation runtime. Do not run a fresh-app initializer over this repository or replace it with a hosted chat service.

Explore enough credible free/open-source options to make a strong choice, including assistant-ui, shadcn/ui, Radix, React Aria, Motion, Lucide, cmdk, resizable panels, virtualization, and selected components from places such as Magic UI, Aceternity UI, and React Bits. These are research leads, not instructions to install everything. Check current licenses, commercial-use terms, maintenance, accessibility, dependency weight, React 19/Vite/Tauri compatibility, offline behavior, and whether examples require paid services. Identify a small coherent stack; reuse existing dependencies when appropriate. Choose useful interaction components rather than turning an evidence workspace into a decorative marketing page.

Research optional development MCP servers/tools for official documentation, browser interaction testing, and design work. Give exact sources, purpose, permissions, local/network access, pricing, and whether they require credentials. Use built-in tools first when sufficient. Do not install a broad collection or give any tool real case evidence. Runtime MCP in VisLex remains deferred. Evaluate provider configuration UX using current official capability documentation, preserving existing adapters, chosen model quality, grants, usage visibility and cancellation. Do not add providers solely for quantity or silently substitute API billing for my Max subscription.

## Design and implementation standard

Create your own source-grounded redesign plan, screen inventory, component choices, rationale, and dependency sequence. Then implement; do not stop at a mood board or written proposal. Choose a distinctive, restrained premium visual direction with consistent typography, spacing, icons, color semantics, light/dark themes, comfortable/compact density, keyboard navigation, visible focus, readable evidence and useful resizable/collapsible panes.

Use animation to explain state and navigation: subtle pane transitions, clear progress, tasteful feedback and responsive controls. Support reduced motion. Avoid animation that obscures source content, changes original media colors, delays work, produces misleading progress, or makes long lists/streams expensive. Cover empty, loading, streaming, partial, failed, cancelled, offline, locked, ready and recovery states, with actionable copy and truthful uncertainty. Retain user drafts, selection and scroll where appropriate across case/tab changes and incoming updates.

Make settings coherent across appearance, keyboard/accessibility, accounts/models, case-specific permissions, privacy/offline controls, review mode and processing. Clearly separate model availability from case authorization. Keep credentials outside renderer/case persistence; changing a theme/model must never broaden case grants. Show usage and cancellation; do not add an arbitrary API-cost ceiling or downgrade models.

Preserve Tauri/Rust/React/SQLite/Python, original evidence bytes and IDs, immutable revisions, exact historical citations, source provenance, restricted derivatives, explicit case grants, human review and Windows AppContainer. Preserve existing import/search/view/finding/review/export/backup/restore journeys. No rewrite, second database/truth store, invented approvals, hidden uploads, deleted capabilities, weakened tests, destructive resets/stashes, or force-pushes.

Work on a dedicated branch based on the current work once its state is understood; preserve uncommitted changes. Coordinate with Codex/other sessions before concurrent writes. One lead owns integration, shared Rust files, DTOs, migrations, central styles and lockfiles. Parallel writers require real isolated worktrees and disjoint ownership; at most three simultaneous implementation writers. Use small coherent commits after review. Do not push/merge/publish without explicit authorization.

## Verification and completion

Use meaningful production-path interaction tests covering navigation, compose/send/stream/cancel, source opening and historical citations, settings persistence and grants, case switching and late responses, drafts, review/export and failure recovery. Keep existing assertions. Run the applicable frontend tests/build, Playwright interaction/a11y tests, and affected Rust/Python/native tests after reading their prerequisites. Use screenshots and actual visual inspection alongside interaction checks; state when desktop checks cannot run.

Check 1366x768 and 1920x1080, Windows scaling at 125/150/200 percent, light/dark, reduced motion, keyboard-only navigation, long filenames/transcripts, and large synthetic lists. Measure performance on named hardware before claiming improvements. Browser mocks do not establish packaged Tauri correctness; document and execute native gates when supported.

Maintain a durable redesign handoff with branch/HEAD, actual changes, design decisions and research links, actual agent contributions, exact commands/results, unrun checks, remaining bugs and the next action. Update NEXT-STATUS according to its existing schema with actual implementation evidence; do not mark unrelated or dependent tasks verified. When session limits prevent completion, leave a precise resumption instruction without claiming you will work after the session ends.

Start now: inspect the current app and baseline, dispatch the scoped research agents, research current sources, make your concrete redesign decisions, and continue into implementation. Ask only for information or consequential external access you truly need. Make routine design choices yourself and keep me informed with concise progress updates.
