# Seams between the design session and the functional session

**Status: PROPOSED by the functional session on 2026-09-28. It is not in force until the design lead acknowledges or edits it.** The plan it serves is `docs/implementation/FUNCTIONAL-PLAN.md`.

Once acknowledged, the design lead owns this file. The functional session adds requests only in the "Open requests" section.

## Why this exists

Two Claude sessions now change the same repository. The design session (branch `claude/redesign-v14qbo`, workflow `vislex-surface-redesign`) owns the visual and interaction redesign. The functional session (branch `claude/stoic-ride-1c8hns`) owns speed, stability, memory, preview back ends, AI providers and the optional second-opinion add-on. `CLAUDE.md` and `AGENTS.md` require one writer at a time for shared files. This table makes that explicit.

## Proposed owner table

| File or area | Proposed owner | Notes |
|---|---|---|
| `src-tauri/src/*.rs`, `src-tauri/tests/*.rs`, migrations | Functional | The design lead requests Rust changes here. The lead's recent Rust commit `a48f88c` stays as is. |
| `workers/*.py`, model manifests, `workers/requirements*.txt` | Functional | |
| `src/types.ts` | Functional, additive optional fields only | Breaking changes need both sessions. |
| `src/api/*`, `src/features/*`, `src/preview/*`, `src/state/*`, `src/features.ts` | Functional (new files) | Panels are self-contained and mounted by the owning lane. |
| `src/bridge.ts`, `src/caseEvents.ts` | Design lead | The functional session batches requests into one lead-approved change. |
| `src/App.tsx`, `src/ui.tsx`, `src/components/ui/*`, `tokens.css`, `theme.css`, `styles*`, `index.html` | Design lead | |
| EvidenceViewer family, SettingsDialog, AgentPanel, `src/chat/*`, findings components | Design lanes | Functional features mount at agreed seams. |
| `e2e/*`, `src/testing/harness/*`, `fixtures/generated/*` | Design (harness) | The functional session supplies `src/api/actions.json` entries for new actions. |
| `package.json`, `package-lock.json` | Design lead | Every dependency change goes through the lead. |
| `.github/workflows/ci.yml` | Functional (R25) | This covers the Tier 0 Linux job and the triggers. |
| `docs/implementation/NEXT-TASKS.json`, `NEXT-STATUS.json` | Design lead merges | The functional session writes only its own top-level `functional` key and new R26–R32 task entries. |
| `CLAUDE.md`, `AGENTS.md`, doc archive | Design lead | This work waits until the redesign workflow finishes. |

**Channel.** Cross-session messages are not reachable between these cloud sessions right now, so the user relays requests. Durable requests live in this file.

## Decisions to deliver now

1. **The ChatGPT-subscription (Codex) route is flagged off by default** (user decision, 2026-09-28). The flag is a Rust const, not a renderer-savable setting. When a case or task references the route, Rust returns this payload instead of silently switching to API keys:
   ```json
   {"route":"unavailable","reason":"The ChatGPT subscription route is disabled in this build. Choose an API provider in Settings → Accounts & models."}
   ```
   Please render it in Settings and the assistant as a blocker, with no API fallback.
2. **Second-opinion sends always need human confirmation per batch.** The first vendors are OpenRouter and direct OpenAI. All of its UI arrives as `src/features/escalation/*` panels for the settings and viewer lanes to mount.

## Open requests to the design lead

### Integration defects found after the 03:23 UTC lane merges (b2bcd85)

These reproduce every time with `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 npx playwright test --workers=1`. They are in design-owned files, so the functional session has not edited them.

1. **Stale settings section names.** `src/chat/turn-state.ts` defines its own `SettingsSection` type with the old names `'Providers & models'` and `'AI permissions'`. The settings lane renamed the sections (`src/components/SettingsDialog.tsx:17`, now `'Accounts & models'`, `'Case permissions'`, and so on). Because the two types are separate, `tsc` passes. At runtime:
   - `AgentPanel.tsx:452` (the grant chip) opens a section that no longer exists;
   - `AgentPanel.tsx:542` and `:546` (manage models) open a section that no longer exists.
   **Suggested fix:** import `SettingsSection` from `SettingsDialog.tsx` in `turn-state.ts`, or re-export one shared type, so the compiler catches drift. Then map the old names onto the new ones.
   Failing specs:
   - `harness-assistant.spec.ts:119` waits for the `AI permissions` button;
   - `harness-settings.spec.ts:7`, `:45` and `:89` wait for `Providers & models`.
2. **The viewer's discovery disclosure changed.** `harness-navigation.spec.ts:66` clicks the text `Video overview and visible text`. That string is now only the `aria-label` of the section in `VideoDiscovery.tsx:18`, so there is nothing to click. Either update the spec to the new disclosure control, or restore a visible toggle label.

### Seams the functional plan needs (Wave D; not urgent)

- `<PreviewHost>` mount point in place of the EvidenceViewer kind branches, plus an optional `overlay` render-prop on the PDF page.
- The `FullTranscript` import of `src/api/transcript.ts` types, and a `--confidence-low` token (underline plus icon).
- Mount points in Settings for `src/features/openrouter/*` and `src/features/escalation/*`, in the "Accounts & models" and "Privacy & offline" sections.
- An optional Task `cost` field rendered by the assistant, shown as "not reported" when null.
- `caseEvents.ts` accepting an optional `changed` mask. `App.tsx` adopting a `listing_version` pagination key and showing a "queued for memory" job reason.
- Typography token proposal: `--font-reading` (Source Serif 4), `--numeric: tabular-nums slashed-zero`, the Inter `cv05 cv08 zero` features, a CJK/Arabic/Thai fallback stack, and bundled Cascadia Mono.

## Log

- 2026-09-28: proposed by the functional session. Linux baseline recorded in `docs/TESTING.md`. Awaiting lead acknowledgement. No functional Rust or worker commit lands until this table is acknowledged, except the test-only Windows gate on `src-tauri/tests/worker_video_e2e.rs`, which unblocks Linux `cargo test`.
