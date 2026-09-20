# VisLex 0.2

## Delivered

- VisLex product/window branding; compact project sidebar, central conversation, optional evidence pane, warm neutral surfaces, rounded composer, keyboard send, draft preservation, scroll following, and expandable action receipts. No development badge, mode/access selector, API step counter, or application spending cap in the conversation.
- Recent case projects persist locally. The active conversation is remembered per case. Explicit New conversation creates a new conversation; ordinary follow-ups stay together.
- Case schema 3 links resumable execution turns to conversations. Existing conversations and revisions are retained; upgrading saves a pre-migration database snapshot. Full saved model/tool context carries into follow-up turns after a fresh permission check. Older history is archived out of oversized requests and remains accessible through paginated tools. The current request remains explicitly available after archival.
- Ordinary assistant messages pass through the same completion/citation checks instead of stopping solely because the model omitted a finish tool call. Empty/incomplete provider replies and genuine provider failures still surface.
- AVI and other browser-incompatible video receive cached H.264/AAC playback derivatives. Original bytes remain unchanged. Conversion runs in AppContainer outside the coordinator lock, and publishes a hashed artifact. Exact-frame evidence inspection continues to decode the original. The browser may expose only one audio track even when the derivative contains several.
- PDFs automatically render physical pages locally, with page navigation. DOCX/XLSX open their indexed text derivatives automatically or process on first opening. These are structured extraction views, not native Office layout reproductions. Unsupported image codecs request a labeled JPEG preview. Existing image zoom/rotation, records, revisions, full transcripts and exports remain available.
- Playback artifacts are included in encrypted backups and restoration allowlists. API credentials retain their existing Windows Credential Manager identity.

## Verification

- Frontend TypeScript/Vite build and three existing frontend checks passed.
- Core regression suite covers conversation linking/history, bounded request context with retrievable complete history, ordinary non-tool replies, existing source permissions/revisions/backups, and canonical local project paths.
- Sandboxed VFR playback conversion and encrypted backup/restore passed using synthetic material. A timestamp encoder bug found by this test was fixed before final packaging.
- Real case UI: AVI conversion completed, video metadata reported 297.0968 seconds and 1920-pixel width, readyState 4, playback advanced with paused=false and no decoder error.
- Real case UI: scanned PDF automatically rendered; page navigation reached physical page 7 of 17, with a loaded 1224-pixel page image.
- Real API UI: first turn asked VisLex to remember a neutral label; after completing it, a follow-up asked for the label without repeating it. Both answers matched and both turns remained in the same conversation.
- Existing saved transcripts and working scripts were preserved. No new full-recording transcription was needed.

## Remaining limits

This change does not certify the full public-release plan. Held-out model-quality evaluation, a clean-machine installer/security review, all import formats, OCR, professional redaction, full native Office fidelity and comprehensive performance gates remain outstanding. Context archival preserves local history but is not unlimited model memory. Provider token/rate limits, cancellation, case restrictions, immutable originals and protected working records remain enforced. Live cases still have one active editor.

The redesign uses original application UI code. The supplied DESIGN-cursor.md informed the neutral palette and spacing. Goose's public desktop architecture was reviewed as a reference; no Goose code was copied and the existing Tauri/Rust/worker architecture was retained.

Final verification: 24 core regressions passed, three frontend checks passed, and the sandboxed playback/backup restoration test passed. After restarting the packaged app, the recent project reopened successfully, both conversation turns remained visible, Incident Notes.docx displayed 54 indexed text lines automatically, and the cached AVI loaded at readyState 4 without errors. The final screen contains neither a development badge nor an API-step counter.
