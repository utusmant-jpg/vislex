# Testing VisLex

This page says which checks run where, and how to run them. Passing tests do not certify legal accuracy or packaged Windows behaviour.

## Where each suite runs

| Suite | Linux (cloud agents, CI Tier 0) | Windows (Tier 1/2) |
|---|---|---|
| TypeScript typecheck, Vite build, Vitest | Yes | Yes |
| Playwright harness and axe specs (`e2e/`) | Yes, with a bundled Chromium | Yes (Edge by default) |
| Rust library and integration tests (no `desktop` feature) | Yes, with the host target | Yes |
| `src-tauri/tests/sandbox.rs`, `worker_video_e2e.rs` | No (Windows-only, `#[ignore]`) | Yes, with `-- --ignored` after `scripts/build-worker.ps1` |
| `cargo check --features desktop`, clippy, packaging, NSIS | No | Yes |
| Python worker, benchmark and script unit tests | Yes, with the pinned packages below | Yes |
| Native CDP journeys (`scripts/native-*.ps1`) | No | Yes, against a built app |

## Linux commands

Run from the repository root.

```sh
npm ci
npx tsc -p tsconfig.json --noEmit
npx vitest run
npx vite build
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium CI=1 npx playwright test
```

`PW_CHROMIUM_PATH` points at a preinstalled Chromium. Elsewhere, run `npx playwright install --with-deps chromium` and point `PW_CHROMIUM_PATH` at the installed binary.

### Rust on Linux

`.cargo/config.toml` and `rust-toolchain.toml` pin the Windows MSVC target, so override both. A few unit tests hash the worker executable for cache keys without running it. In debug builds, `VISLEX_WORKER_PATH` can point them at any stand-in file.

```sh
printf 'linux-test-placeholder-worker\n' > /tmp/placeholder-worker
VISLEX_WORKER_PATH=/tmp/placeholder-worker RUSTUP_TOOLCHAIN=stable \
  cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu --tests
```

Use `--tests`. The `codex_boundary_probe` example is Windows-only and does not compile on Linux.

### Python on Linux

The worker tests import a subset of the locked worker packages. Install those pinned versions into a virtual environment:

```sh
python3 -m venv .venv-tests
grep -iE '^(av|lxml|numpy|openpyxl|pillow|pypdf|pypdfium2|python-docx|reportlab|scenedetect|opencv-python|click|platformdirs|tqdm)==' \
  workers/requirements.lock.txt | sed 's/ .*//;s/\\//' > /tmp/worker-test-reqs.txt
.venv-tests/bin/pip install -r /tmp/worker-test-reqs.txt
.venv-tests/bin/python -m unittest discover -s workers -p 'test_*.py'
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 -m unittest discover -s benchmarks -p 'test_*.py'
python3 scripts/vislex_plan.py check
```

## Optional ChatGPT-subscription route

The Codex-sidecar subscription route is a Cargo feature that stays off for headless `cargo test` and the Linux checks, so they do not compile Tauri. The desktop npm scripts (`npm run desktop`, `desktop:build`, `desktop:build:x64`) pass `--features subscription` (it implies `desktop`), so app builds and dev runs on Windows include the route, for example before running `scripts/native-codex-account-test.ps1`. Without the feature, saved subscription preferences stay readable, and every path that would use the route stops with an explicit reason. It never falls back to API keys.

## Windows

Follow `README.md` → Verification for the full Windows sequence. Tier 1 is `cargo test --locked`, clippy and `cargo check --features desktop`. Tier 2 adds the packaged worker (`scripts/build-worker.ps1`), the ignored sandbox tests and the native CDP journeys.

## Final Windows build (2026-09-28, evening)

Tested tree: `integrate/redesign-final` after merging `main` 4818598 (flagship chat redesign) plus the Codex sidecar re-pin and the native-acceptance selector fix; recorded in `windows_final_build_2026_09_28` in `docs/implementation/NEXT-STATUS.json`.

| Check | Result |
|---|---|
| `npm ci`, `tsc --noEmit` | exit 0 |
| Vitest | 32 files, 314 passed |
| Playwright (Chromium) | 59 passed in one run on an idle machine; a run during the release build had 5–6 first-page-load timeouts that passed on rerun |
| `cargo test --locked` | 246 passed, 0 failed, 31 ignored |
| `cargo clippy --all-targets --features subscription` | exit 0 |
| Codex sidecar (`scripts/build-codex-sidecar.ps1`, pinned commit + patch) | built; SHA-256 `DFD16FFD…5577`, now the pinned hash |
| `scripts/test-codex-boundary.ps1`, default and `-PersistentProfile` | boundary held: out-of-scope read/write denied |
| `npm run desktop:build` (now `--features subscription`) | exit 0; installer `VisLex_0.3.0_arm64-setup.exe` |
| `native-codex-account-test.ps1` on the release exe | `subscription_ready`, `account_protocol`, `connected` all true |
| `native-protocol-origin-test.ps1` on the release exe | foreign read blocked |
| Debug-build journeys: acceptance, integrity, large session, provider race, concurrent chats | exit 0; acceptance with 0 provider calls |

No chat turn was sent through the subscription route: that would send a live request to OpenAI. Still unrun: `native-consent-acceptance.ps1`, `native-app-ai-acceptance.ps1`, scaling screenshots, Edge, screen readers.

## Earlier Windows run (2026-09-28)

Tested commit: `8b2fbee` on `integrate/redesign-final` (the cloud branch's Linux-verified `3b8bb88` plus its docs commit, merged with the local Codex/GLM worker setup). Windows 11 on an ARM64 machine running the x86_64-pc-windows-msvc toolchain; details and the unrun list are in `windows_verification_2026_09_28` in `docs/implementation/NEXT-STATUS.json`.

| Check | Result |
|---|---|
| `tsc --noEmit`, `npx vite build`, `vislex_plan.py check` | exit 0 |
| Vitest | 30 files, 294 passed |
| Playwright (Chromium) | 58 passed |
| `cargo test --locked` | 245 passed, 0 failed, 31 ignored |
| `cargo check` with `desktop` and with `subscription` | exit 0 |
| `cargo clippy --all-targets --features desktop` | exit 0, with warnings |
| `cargo fmt --check` | fails repo-wide (pre-existing, also on `main`) |
| Rebuilt packaged worker | new modules `email_extract`, `docx_extract`, `pptx_extract`, `xlsx_hidden`, `media_clip` present |
| `sandbox.rs -- --ignored` | 26 passed |
| `worker_video_e2e -- --ignored` | 1 passed |
| Packaged worker on synthetic .eml, DOCX, PPTX, XLSX and audio clips, in the AppContainer | 19/19 checks passed |
| `npm run desktop:build` | exit 0 (release exe and NSIS installer) |
| Native journeys on the debug build: acceptance, integrity, large session, provider race, concurrent chats | exit 0 |
| Native protocol-origin test on the release exe | exit 0, foreign read blocked |

Not run at that commit: `native-consent-acceptance.ps1`, `native-app-ai-acceptance.ps1` and `native-codex-account-test.ps1`, manual video scrubbing and PDF paging through `evidence://`, any live provider request, 125/150/200 % scaling screenshots, Edge and screen readers. At that commit the release build still compiled the subscription route out; the final build above includes it.

## Latest Linux run (cloud container, 2026-09-28)

Tested commit: `3b8bb88` on `integrate/redesign-final-cora77`. Nothing below has run on Windows; see `docs/implementation/LOCAL-FINALIZE.md` for the Windows checks still owed.

| Check | Result |
|---|---|
| `npm ci` | exit 0 |
| `tsc --noEmit` | exit 0 |
| Vitest | 30 files, 294 tests passed |
| `npm run build` | ok |
| Playwright (Chromium) | 58 passed |
| Rust, host target, `--tests` | 238 passed, 0 failed, 4 ignored |
| Python workers / scripts / benchmarks | 41 / 13 / 10 passed |
| `vislex_plan.py check` | valid, 33 tasks |
| `cargo fmt --check` | fails repo-wide (about 40 files, also on `main`); not enforced |

Environment: Node 22.22.2, npm 10.9.7, stable Rust (x86_64-unknown-linux-gnu), Python 3.11.15.
