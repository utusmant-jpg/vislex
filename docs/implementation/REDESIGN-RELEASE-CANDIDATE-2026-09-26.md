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

## Later redaction UI package snapshot

The combined application source `ec78cdc` (redaction UI through `eae77ba`, R05 provider race, Gemini history, finding caller test) also built as an x64 NSIS package. Its release executable SHA-256 is `41D45D94A8EA6D1112127725A3AA54954D5A56169FBCC39B802B5DCFA7133507`; installer SHA-256 is `EEB67AB0691D197698B4A0FC43660E770A91F6F9DBF256963A33BC10ABEC2268`. `native-acceptance.ps1 -Port 9378 -BinaryPath <release exe>` exited 0: six synthetic sources, chat/DOCX preview, video OCR/overview, three lexical and 30 semantic results, DOCX/PDF export, cross-case denials, unreviewed-redaction denial, and zero provider calls. Its test did not walk the full new redaction review UI. Backend R08/R19 commits after `ec78cdc` are not included in this executable, so this is an intermediate snapshot rather than the current combined candidate.

## Sequenced-event combined candidate

Application source `c11c54896cbb42fef7e9b9318f584aabf58d0b02` includes the Dev34 sequenced-event backend, R08 redaction/speaker epoch gate, R19 provider pooling, and the renderer listener correction. `npm run desktop:build:x64` exited 0. Release executable SHA-256: `5F1A0A9732AD4CB21557D4C7535BD9F0DE8A50A2860C1AB5D3035DE7B2A035D4`. NSIS installer SHA-256: `57DE8C03FDEF121827CDB70574C3969CCB5E62FDE54292052317E8E27DADDF06`.

| Native check | Result |
|---|---|
| Release `native-acceptance.ps1 -Port 9385` | Exit 0, run `1790461170334`: six synthetic sources; rendered inventory chat and DOCX preview; four OCR and four overview samples; three lexical and 30 semantic results; PDF/DOCX exports; cross-case chat/source/export denials; unreviewed-redaction denial for the human-review reason; zero provider calls. This ran after the release executable was built while NSIS compressed the same executable. |
| Release `native-integrity-acceptance.ps1 -Port 9386` | Exit 0, run `1790461717306`: 256 MiB strong verify in 898 ms; 12/12 summaries completed during hashing; 28 stale-case and 10 stale-session actions denied; stale/wrong-target delete denied; valid empty-case delete succeeded; four ordered case-event envelopes captured. |
| Release `native-large-session.ps1 -Port 9387` | Exit 0, run `1790461728505`: 1 GiB import 12.16 s, verify 3.67 s, 20 summaries during verify, late previous-session verify denied; process-tree peak private memory 230,674,432 bytes. The 1,084,104,704-byte system disk delta after fixture is not solely attributable to the case. |
| Debug `native-provider-race.ps1 -Port 9388 -MockPort 9389` | Exit 0, run `1790461804606` with current frontend and debug backend from the same application source: old task remained paused after a late synthetic provider response; continuation completed with the second response. The loopback provider override is debug only. |
| `VISLEX_WORKER_PATH=<local evidence-worker.exe> cargo test --locked --manifest-path src-tauri/Cargo.toml` | Exit 0 on this combined source: all non-ignored Rust unit/integration suites including AppContainer worker video e2e. The full ignored packaged-worker suite was not rerun in this worktree after this cutoff; the functionality checkout reports a full Dev34 run. |

The first release candidate at `e630c33` failed the six-source UI step because a bridge-opened case emitted `case-event` before React held a snapshot, and the listener suppressed its paired legacy notification. Commit `c11c548` refreshes on a newer session and advances the UI case epoch on an externally observed case switch. A debug native six-source run passed before rebuilding; the release journey above confirms the fix in the packaged source. The failed run is retained as integration evidence, not counted as a pass.

Frontend at `c11c548`: 110 tests in 21 files, nine synthetic Edge browser tests, and dark/light axe scans passed. Initial bundle: 125.23 kB gzip JavaScript and 13.30 kB gzip CSS. These are payload figures, not a measured startup gain. Windows scaling, Narrator, the complete surface/action matrix, all ten protected journeys, 10,000-row responsiveness, startup/memory before-after comparisons, full redaction review UI, and independent review remain open. This package is a tested milestone, not R21 completion.
