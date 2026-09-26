# Combined redesign candidate: Windows synthetic verification

This is evidence for the current integrated candidate, not R21 completion or legal/product certification. The other functionality task remains active. The release application source is `1d322033927499caa169a4472374d6706bc20396` on `codex/vislex-redesign`; the following commit `17ba754` added only the 1 GiB harness and evidence, so it did not change the packaged application source.

Environment: Windows x64, local Edge/WebView2, isolated worktree, synthetic cases only. `npm run desktop:build:x64` exited 0. Release `local-evidence-desk.exe` SHA-256: `012263A121202CFC71657F705DC298869C025724E5D8AD8D4FD8A4866B6697FC`. NSIS installer SHA-256: `8C9C93B6105CEA63048CF06C304C286EAEAA47F8CD088CF36EE02AD9E8F7DFCC`.

| Check against that executable/source | Result |
|---|---|
| `scripts/native-integrity-acceptance.ps1 -Port 9375 -BinaryPath <release exe>` | Exit 0. 256 MiB full reread in 883 ms; 12/12 case-summary calls completed during verification; 28 stale-case actions and 8 stale-session actions denied; wrong-target and stale deletion denied; valid empty-case deletion succeeded. |
| `scripts/native-acceptance.ps1 -Port 9376 -BinaryPath <release exe>` | Exit 0. Six synthetic original sources; chat and DOCX preview rendered; three lexical and 30 semantic results; DOCX/PDF export; cross-case chat/source/export and unreviewed-redaction denial; zero provider calls. |
| `scripts/native-large-session.ps1 -Port 9377 -BinaryPath <release exe>` | Exit 0. 1 GiB synthetic source imported in 23.69 s and strongly verified in 3.47 s; 20 summary calls completed during verification; late verification from the previous same-case session denied after close/reopen (epochs 1 and 3); process-tree peak private memory 225,787,904 bytes. Disk delta after fixture was 1,090,703,360 bytes, but it includes system and WebView data and is not attributed entirely to the case. |
| `VISLEX_WORKER_PATH=<local evidence-worker.exe> cargo test --locked --manifest-path src-tauri/Cargo.toml` | Exit 0, non-ignored Rust unit/integration suites including AppContainer worker e2e. The ignored packaged-worker suite was not rerun in this worktree. |
| `npm test` | Exit 0, 104 tests in 19 files. |
| `npm run test:e2e` | Exit 0, nine Edge/Playwright synthetic-preview tests. |
| `npm run test:a11y` | Exit 0, one test with dark/light axe WCAG A/AA scans of the specified preview surfaces. |
| `python scripts/vislex_plan.py check` | Exit 0, queue structure only. |

The build emitted initial JS at 124.33 kB gzip and CSS at 13.12 kB gzip, compared with the pre-redesign 131.61 kB and 11.18 kB. This is a payload comparison, not a startup or interaction-speed measurement. The 1 GiB timings describe storage/verification on this machine and do not establish a redesign speedup.

R21 remains **in progress**. The full control/state matrix, Windows scaling at 100/125/150/200%, Narrator, complete ten protected journeys, measured startup/navigation and 10,000-row responsiveness, and independent review are not verified. Several deep evidence/media, findings, redaction, case-lifecycle, and recovery surfaces still need complete visual and keyboard treatment. Any later functionality handoff that changes application source requires a new combined build and applicable reruns before calling it the tested candidate.
