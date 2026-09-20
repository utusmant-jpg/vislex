# VisLex 0.2.1 interface update

The palette follows `Downloads/DESIGN-linear.app.md`: #010102 canvas, #0f1011 sidebar/window chrome, #141516 elevated surfaces, #23252a dividers and #5e6ad2 accent. Native evidence images and document pages retain their source appearance.

The Windows window uses custom draggable chrome with minimize, maximize/restore and close controls. Case sections collapse; only five short chats show initially. Chat deletion is reversible through Undo and removes the entire conversation from visible history and automatic prior-chat summaries. Original records and action history remain available internally rather than being cascaded away with a chat.

Case files use a compact searchable browser and individually closable tabs. The ordinary evidence view omits processing controls, hashes, source accounting, database labels and preservation slogans. Transcripts remain saved and accessible through a collapsed Transcript control. Archive operations are under the case options menu.

The typed `open_source` agent tool can open an authorized source in the workspace, including a media time or PDF page. It does not mark evidence as inspected, grant new permissions, or mutate original files. The coordinator publishes the viewer request and the UI opens it in a file tab.

Viewer context is now included at submission: source/record identity, displayed PDF page, or current media playback time. It is visible as a compact file chip and validated against the task scope. A dedicated regression rejects out-of-case context. Basic bold formatting is rendered safely in chat without interpreting HTML.

Validation completed in the packaged Windows app:
- The live sidebar deleted a test conversation, removed it from the list, and restored it through Undo.
- File browser opened document/video tabs; technical source/status strings were absent from the main view.
- Custom maximize and restore changed the client size between 1500x960 and 2560x1392 without permission errors; the custom close control closed the separate validation window.
- A real API request through the chat opened synthetic variable-timing.mp4 at exactly 1.0 seconds, with the media element reporting readyState 4.
- A follow-up asking what was open on the right returned the correct filename and 1.0-second playback position from submitted viewer context.
- 26 existing/new core checks passed together, the additional selected-view context regression passed, and all three frontend checks passed.

The separate validation used synthetic fixtures in an artifacts folder. Existing case data and saved transcripts were retained. The final executable was copied into artifacts/VisLex 0.2.1 and the user's case reopened there.
