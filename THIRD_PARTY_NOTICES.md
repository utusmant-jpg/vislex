# Third-party components

Apache-2.0 applies to original Local Evidence Desk code, not to bundled third-party code, model weights, codecs or platform runtimes. Lockfiles identify the exact dependency versions used by this checkout.

- JavaScript: `package-lock.json` (React, Tauri bindings, Lucide and development tooling).
- Rust: `src-tauri/Cargo.lock` (Tauri, SQLite bindings, age, reqwest and their dependencies).
- Python: `workers/requirements.lock.txt` (Python processing adapters, PyInstaller, PyAV/FFmpeg libraries, Pillow, PDFium bindings, document libraries, faster-whisper and CTranslate2).
- Transcription weights: `workers/model-manifest.json` records the selected Systran/faster-whisper-tiny repository revision and content hashes. Its upstream model card is bundled with the weights.
- The Python runtime and WebView2 have their own licensing/distribution conditions. WebView2 is a system prerequisite for the development folder build.

Installed Python package metadata and license files are retained in the development package notices directory. FFmpeg/PDFium codec/build licensing and complete transitive attribution must be reviewed before public binary redistribution. This local unsigned build is not represented as a completed redistribution compliance audit.

- Local OCR: RapidOCR 1.4.4 with bundled PP-OCRv4 detection/recognition and text-angle weights. `workers/ocr-model-manifest.json` records hashes; package metadata and licenses are included with the development package. OpenCV, ONNX Runtime, Shapely and pyclipper have separate upstream licenses.

- Optional higher-quality speech profile: pinned Systran/faster-whisper-small, recorded in `workers/small-model-manifest.json`; upstream model card is bundled.
- Semantic retrieval: sentence-transformers/all-MiniLM-L6-v2, Apache-2.0 model card, pinned ONNX quantized weights and tokenizer recorded in `workers/embedding-model-manifest.json`. The upstream README is bundled with the model.
- PDF generation: ReportLab 5.0.1 (BSD license) and bundled Bitstream Vera fonts (font-specific license). Package license metadata and the ReportLab font license are included in the development package notices.

- Speaker-turn proposals: sherpa-onnx 1.13.8 and its CPU core (Apache-2.0); public ONNX conversion of pyannote segmentation-3.0 (MIT license included with model) and NVIDIA TitaNet-S embedding model. Model archives and extracted bytes are pinned in `workers/diarization-model-manifest.json`. Public upstream sources: https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html and https://catalog.ngc.nvidia.com/orgs/nvidia/nemo/models/titanet_small . The small model card refers to the NeMo Toolkit license. These weights propose anonymous clusters, not authenticated identities. Public redistribution still requires the full model/codec attribution review described above.

- Video scene discovery: PySceneDetect 0.7.1 (BSD-3-Clause) and platformdirs 4.11.11 (MIT), pinned in the worker lockfile. Installed package metadata/licenses accompany the development package. The detector is used as a navigation aid; no upstream processing pipeline is transplanted.

- Research browser page observation: `src-tauri/resources/research/injected-script.js` is the Playwright injected script (Apache-2.0, Copyright Microsoft Corporation) extracted unchanged from the locked `playwright-core` package by `scripts/build-research-injected.mjs`, which also checks it is reproducible. Its license and notice are bundled beside it as `PLAYWRIGHT-LICENSE`, `PLAYWRIGHT-NOTICE` and `PLAYWRIGHT-THIRD-PARTY-NOTICES.txt`. It runs only inside the optional research browser's isolated DevTools world.

- Research citation guard: `src-tauri/resources/research/reporters-db.json` holds the reporter abbreviations (editions with their cite types, and variations mapped to their edition) from Free Law Project's reporters-db 3.2.66 (BSD-2-Clause, Copyright (c) 2014, Free Law Project), the reporter database eyecite uses. `scripts/build-reporters-db.py` generates it from the pinned PyPI wheel (hash checked), checks the declared license and can verify the committed file is reproducible (`--check`). The upstream license is bundled beside it as `REPORTERS-DB-LICENSE`. It is compiled into the application and used only to recognise case reporter citations; it does not check that a cited case exists or supports anything.
