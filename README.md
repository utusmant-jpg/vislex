# VisLex

A Windows desktop evidence workspace with immutable source copies, local viewers, versioned working records, and case-scoped AI tool execution with optional agent teams.

**Status: VisLex investigation preview — the current development build; earlier 0.2.1 and V4 packages remain available. Professional-release acceptance gates remain outstanding.** The application runs and processes real files; the browser preview uses synthetic data only. The full requested plan remains the release target. See [evidence-desk implementation status](docs/EVIDENCE-DESK-IMPLEMENTATION.md) for delivered capabilities, limits, and remaining work.

## Investigation workbench preview

The current upgrade preview is packaged at `artifacts/VisLex Investigation Preview/VisLex.exe`. Open **Investigation workbench** for discrepancies, competing explanations, changed findings, accepted-clock replay, coverage and legal work-product launchers. Case search includes local English semantic retrieval; the transcript panel offers tiny/small speech profiles and local anonymous speaker-turn proposals. Jobs can recover staged processing and interrupted speech checkpoints. PDF/image viewers include reviewed flattened redaction, and saved records export fresh DOCX/PDF drafts.

Direct Gemini media needs its separate Settings opt-in and supports originals up to 12 MiB. Offline dossier packages include cited whole originals and are not sanitized disclosure packages. Public-authority retrieval does not imply treatment validation. See the precise implementation boundaries in [the implementation ledger](docs/EVIDENCE-DESK-IMPLEMENTATION.md).

The [benchmark harness](benchmarks/README.md) captures actual task outputs for independent adjudication and computes paired incident-level scores. Included synthetic scores test the scorer only. No Harvey comparison has been measured. Native synthetic acceptance is repeatable with `powershell -ExecutionPolicy Bypass -File scripts/native-acceptance.ps1` after building the desktop app and worker.

See [VisLex 0.2.1 interface update](docs/VISLEX-0.2.1.md) for the Linear palette, compact case/chat navigation, source tabs and agent-controlled viewer.

See [VisLex 0.2 changes and validation](docs/VISLEX-0.2.md) for the conversation-first redesign, case projects, playback derivatives, and automatic document previews.

## V4 development build

The V4 foundation adds native OpenAI/Claude/Gemini/Grok adapters, optional same-model or approved mixed-model teams, versioned findings, manual clock proposals, and local transient/waveform discovery. See [V4 implementation ledger](docs/V4-IMPLEMENTATION.md) for the full requirement matrix and outstanding work. This is not the completed V4 product.

The separate unsigned development package is `artifacts/VisLex V4 development/VisLex.exe`; keep its resources folder beside it. Existing `VisLex 0.2.1` packages are not replaced by this build. Cases migrate additively to schema 4 with a database snapshot before migration. In the app, use **Settings → AI & protection** and **Findings & clock proposals**. No live-provider or held-out accuracy certification is implied by the synthetic tests.

Reproduce validation with `scripts/verify-v4.ps1 -IncludePackagedWorker`. Build using the command below, then package with `scripts/package-development.ps1 -OutputName 'VisLex V4 development'`.

## Run the application

The original 0.2.1 packaged app is in `artifacts/VisLex 0.2.1/`; the current investigation preview is packaged at `artifacts/VisLex Investigation Preview/`. Run `VisLex.exe` from a package folder and keep its `resources` folder beside it. The app requires Windows 11 and the Microsoft Edge WebView2 runtime. It is unsigned. This build was exercised on Windows with x64 binaries; a clean Windows 11 x64 installation and independent security review remain release gates.

Create a case in a local, non-synchronized folder. Import files with **Import evidence**. Original bytes are copied, hashed, and kept read-only; duplicate supplies retain separate occurrence records. Use **Process source** to extract supported documents, create image previews, or sample video. PDF **Render page locally** produces a source-linked visual derivative. Audio/video **Transcribe interval** uses the bundled tiny model without an API call.

**Import folder** accepts a folder path directly in the app and can create a new case. It imports files recursively and skips links and existing case directories. For a complete recording, use **Transcribe full recording** below its media viewer. This background job supports files up to 16 GiB, decodes every audio track to EOF in bounded-memory chunks, reports progress, and supports cancellation. It saves an editable transcript record plus timestamped TXT/JSON and one SRT per nonempty audio track under `working/transcripts/`. Recordings without an audio track receive an explicit no-audio report. These saved processor files are immutable historical outputs; make corrections in the working record editor.

Create a working file, edit it, and **Save revision**. **History** restores an old version as a new revision. Human approval is revision-specific. New imports mark existing records stale. **Backup** writes an encrypted `.age` case archive; **Restore** requires a new folder and its passphrase. Keep the passphrase separately: there is no recovery mechanism. **Case menu → Delete case…** erases the entire case folder — originals, working files, chats, review history and archives stored inside it — after you type the case name to confirm; a case that is open elsewhere cannot be deleted, and archives saved outside the case folder are not touched.

## Enable the agent

AI is configured app-wide, not per case. Open **Settings → AI providers**, paste a provider API key (OpenAI, Anthropic, Gemini or xAI), click **Save key & load models**, then choose the models to make available. Selecting a model grants nothing by itself: the **Case permissions** panel controls whether case text or images may be sent, whether dispatch is allowed at all (offline stops new requests), the review mode, and spending visibility. Preferences you explicitly confirm initialize newly created cases; opening or restoring an existing case never changes its permissions, and saving applies exactly the choices shown to the current case. Keys live in Windows Credential Manager and are not stored in cases, backups, the renderer or worker environment. No hosted file storage or remote tools are used. Direct original-media transmission keeps its separate, audited per-case opt-in and is never enabled implicitly.

Every desktop task uses autonomous investigation with all unrestricted case sources and eligible working records. Supply a question or task and start; no mode or access selector is required. Investigate can extract documents, render PDF pages, crop photographs, sample/revisit video, transcribe selected audio intervals, and create or update cited working records. The coordinator retains internal read-only/edit-scoped contracts for tests and future integrations; the desktop always starts an investigation. Action receipts and revisions are visible.

The model receives only permitted content through coordinator tools. Transcription is machine text, not direct audio listening. The application validates locator existence, not whether a claim is true or supported. Earlier 0.2.1 validation notes document OpenAI desktop exercises. The V4 provider and team changes were tested with synthetic responses; live-provider acceptance for the new configurations is still required.

There is no application dollar cap or fixed step ceiling. Usage remains recorded locally; provider account limits still apply. The ledger retains conservative estimates and uncertain request receipts, not a verified provider invoice. Provider context capacity, bounded processing, cancellation, restricted sources, protected records and progress-aware loop recovery remain enforced.

## Build from source

Prerequisites: Windows 11, Node.js/npm, Python 3.11 x64, Rust stable x64 MSVC, Visual Studio C++ Build Tools with Windows SDK, and WebView2. The toolchain files select x64 even on an ARM development host. Build steps require network access; runtime model downloads are disabled.

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/build-worker.ps1
npm run desktop
```

The worker build installs locked dependencies and downloads the pinned tiny transcription model. To build a self-contained frontend and NSIS installer:

```powershell
npm run desktop:build
```

For a faster development executable, run `npm exec tauri build -- --debug --features desktop --no-bundle`, then `powershell -ExecutionPolicy Bypass -File scripts/package-development.ps1`. `npm run dev` alone is only a browser UI preview.

## Verification

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
.venv-worker\Scripts\python.exe scripts/generate-fixtures.py
powershell -ExecutionPolicy Bypass -File scripts/generate-audio.ps1
cargo test --manifest-path src-tauri/Cargo.toml --test sandbox -- --ignored --nocapture --test-threads=1
```

The explicit sandbox suite launches real packaged workers; the normal Rust suite does not silently claim to have run it. Test evidence is synthetic. See [verification notes](docs/VERIFICATION.md) and [security boundaries](docs/SECURITY.md).

Original application code is Apache-2.0. Third-party dependencies and model weights retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Cited investigations receive an evidence-support review prompt before completion and are saved as unreviewed report records for future retrieval. This is persistent case memory, not model training or a guarantee of factual correctness. Saved claims remain subject to source verification and staleness.

Long investigations keep full tool receipts locally and expose explicit retrieval for abbreviated older results and images. GPT-5 reasoning models use high effort and additional output-token headroom, following the [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning). Model capability and transcript accuracy still constrain conclusions.

Image and frame tools trigger a fresh visual-description pass containing the current images with source, page and decoder metadata, excluding earlier case conclusions. Its observations return to the investigation as unreviewed evidence interpretations. This is designed to expose narrative anchoring; it does not certify scene descriptions or OCR accuracy.


### Automatic analysis build

The earlier automatic-analysis build is at `artifacts/VisLex automatic analysis/VisLex.exe`. In Settings, paste a company API key, click **Save key & load models**, choose its model, and save. Other configured providers remain available in the chat model dropdown. Choose **Agent decides when to delegate** to allow scoped parallel assignments.

Opening a case or importing files/folders queues local document extraction, PDF/image OCR, media inventory and full-audio transcription automatically. AI review follows when a model/key is configured. Preparation counts are separate from AI review, and failures remain visible. AI is enabled once configured; there are no dollar-limit settings. This is an unsigned development build, and complete/accurate recognition of all video frames or document structures is not established.
