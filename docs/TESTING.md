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

## Windows

Follow `README.md` → Verification for the full Windows sequence. Tier 1 is `cargo test --locked`, clippy and `cargo check --features desktop`. Tier 2 adds the packaged worker (`scripts/build-worker.ps1`), the ignored sandbox tests and the native CDP journeys.

## Baseline recorded 2026-09-28 (Linux cloud container)

Tested commit: `b2bcd85` on `claude/redesign-v14qbo`, plus the `worker_video_e2e.rs` Windows gate.

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| Vitest | 28 files, 257 tests passed |
| `vite build` | ok (chunk-size warning only) |
| Playwright (Chromium 1194) | 39 passed, 5 failed; the failures reproduce serially (see `docs/implementation/SEAMS.md`) |
| Rust, host target, `--tests` | 206 passed, 0 failed, 5 ignored across library and integration suites |
| Python workers / scripts / benchmarks | 28 / 13 / 10 passed |
| `vislex_plan.py check` | valid, 26 tasks |

Environment: Node 22.22.2, npm 10.9.7, stable Rust (x86_64-unknown-linux-gnu), Python 3.11.15.
