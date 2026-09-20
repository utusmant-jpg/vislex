# Third-party components

Apache-2.0 applies to original Local Evidence Desk code, not to bundled third-party code, model weights, codecs or platform runtimes. Lockfiles identify the exact dependency versions used by this checkout.

- JavaScript: `package-lock.json` (React, Tauri bindings, Lucide and development tooling).
- Rust: `src-tauri/Cargo.lock` (Tauri, SQLite bindings, age, reqwest and their dependencies).
- Python: `workers/requirements.lock.txt` (Python processing adapters, PyInstaller, PyAV/FFmpeg libraries, Pillow, PDFium bindings, document libraries, faster-whisper and CTranslate2).
- Transcription weights: `workers/model-manifest.json` records the selected Systran/faster-whisper-tiny repository revision and content hashes. Its upstream model card is bundled with the weights.
- The Python runtime and WebView2 have their own licensing/distribution conditions. WebView2 is a system prerequisite for the development folder build.

Installed Python package metadata and license files are retained in the development package notices directory. FFmpeg/PDFium codec/build licensing and complete transitive attribution must be reviewed before public binary redistribution. This local unsigned build is not represented as a completed redistribution compliance audit.
