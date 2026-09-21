# VisLex implementation ledger

Execution record for the VisLex ultra plan (docs/VISLEX-ULTRA-IMPLEMENTATION-PLAN.md).
This file records what was actually done, verified and not verified. It is not a roadmap.

Statuses: PASS / FAIL / BLOCKED / NOT RUN.

## Baseline

- Date: 2026-09-21. Branch `glm/vislex-ultra` cut from `origin/main` at `5fcff7d` (plan upload).
- Frontend: `npm test` — PASS (13/13).
- Frontend build: covered by later `npm run build` runs per change.
- Rust core: `cargo test --manifest-path src-tauri/Cargo.toml` — PASS (all non-ignored suites; exit 0).
- Sandbox suite (`--ignored`): NOT RUN at baseline (requires packaged worker); 21 tests.
- Worker python tests: NOT RUN at baseline.

## Tickets

| Ticket | Status | Commit | Notes |
| --- | --- | --- | --- |
| VL-001 protected journey | done | see git log | `src-tauri/tests/journey.rs`; full loop w/o worker |
| VL-003 viewer-context toggle | done | see git log | frontend + backend regression |
| VL-004 authority ingest | done | see git log | trusted-ingest path + tests |
| VL-005 backup artifact symmetry | done | see git log | versioned artifact registry |
| VL-002 durable case policy | done | see git log | defaults initialize new cases only |
| VL-006 export pinning | done | see git log | dossier export revalidates state at publish |
| VL-007 automatic analysis states | done | see git log | persisted state machine + completion fingerprint |

Per-ticket details live in `docs/implementation/VL-0XX.md`.

## Standing verification commands

```
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --test journey
```

Sandbox/worker suites remain NOT RUN unless explicitly executed with the packaged worker.
