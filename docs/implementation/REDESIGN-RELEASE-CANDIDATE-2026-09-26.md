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

## Fixed functionality cutoff and reader polish

The redesign pass stopped functionality handoffs at application source `4b5dc96`, incorporating the redaction-worker changes and Claude/Gemini streaming work. `npm run desktop:build:x64` exited 0 for that exact source. Release executable SHA-256: `9C0F83FD4F13C33711C02F8CB84F33562A730409440D8B7C46044EFC39820B86`; NSIS installer SHA-256: `BF2307FCF9DCA64D18B912A873B1F985942660D7F1E2EED1B2B66ADF628C93B8`.

| Check | Result |
|---|---|
| Release `native-integrity-acceptance.ps1 -Port 9390` | Exit 0, run `1790463189636`: 256 MiB strongly verified in 1.46 s; 12 summaries completed during hashing; 28 stale-case and 10 stale-session actions denied; four ordered case events; stale and wrong-target deletion denied. |
| Release `native-acceptance.ps1 -Port 9391` | Exit 0, run `1790463214182`: six synthetic originals; rendered chat and DOCX preview; four OCR and four overview samples; three lexical and 30 semantic results; DOCX/PDF exports; cross-case denials; unreviewed-redaction denial; zero provider calls. |
| Release `native-large-session.ps1 -Port 9392` | Exit 0, run `1790463407521`: 1 GiB import 11.71 s, verify 3.56 s, 20 summaries during verify, late previous-session verify denied; process-tree peak private memory 228,564,992 bytes. The system disk delta includes more than the case. These timings do not establish a redesign speedup. |
| `VISLEX_WORKER_PATH=<packaged evidence-worker.exe> cargo test --locked --manifest-path src-tauri/Cargo.toml` | Exit 0 for all non-ignored Rust suites, including AppContainer worker video e2e. |
| Ignored `flattened_redaction_requires_page_review_and_exports_only_derivative` in `sandbox.rs` | Exit 0 with the packaged worker; this is a backend gate, not a full visual redaction walkthrough. |

Commit `6cac65b` adds source identity, restriction/provenance display, dark/light extracted-text reading surfaces, and commit-on-Enter/blur PDF page entry. It landed **after** the `4b5dc96` installer above. On that reader commit, `npm test` passed 111 tests in 21 files, the frontend production build passed (initial JS 125.49 kB gzip; CSS 13.48 kB gzip), and 11 synthetic Edge/Playwright workspace and accessibility checks passed, including dark/light reader screenshots and a computed theme-surface assertion. R21 remains in progress; the full action/state matrix, Windows scaling and Narrator, complete protected journeys, measured startup/navigation and 10,000-row responsiveness, and independent review remain open.

The synthetic Edge captures are retained at [dark evidence workspace](screenshots/redesign-dark-evidence.png) and [light evidence workspace](screenshots/redesign-light-evidence.png). They show the sample case only; no client data is included.
The native six-source run also captured the [Windows working-file editor and library](screenshots/redesign-native-working-files.png) in a generated case.

## Packaged reader candidate

The fixed functionality cutoff `4b5dc96` plus reader commit `6cac65b` built successfully with `npm run desktop:build:x64`. The final release executable SHA-256 is `3A590BA63BD48D3CBED02E4FF9190A26D0FF73A92CF06CFDC52D878B8724F14C`; the final NSIS installer SHA-256 is `F3A946D4F81B15044AD3E6316C55F7E8D371341A612B81B3B7B385B33CB5016A`. Bundling changed the executable hash after its first native checks, so both checks were rerun against these final bytes.

| Final executable check | Result |
|---|---|
| `native-integrity-acceptance.ps1 -Port 9395` | Exit 0, run `1790464357638`: 256 MiB verification, 12 summaries during hash, 28 stale-case and 10 stale-session denials, four ordered case events, deletion gates. |
| `native-acceptance.ps1 -Port 9396` | Exit 0, run `1790464371363`: six originals, chat/DOCX preview, OCR/overview, lexical/semantic, DOCX/PDF export, cross-case denials, unreviewed-redaction denial, zero provider calls. |

The final executable hash remained unchanged after both runs. The prior `4b5dc96` package covers the 1 GiB and reviewed-redaction backend checks; no backend source changed in `6cac65b`. The native Windows screenshot linked above was captured from the new UI executable before installer compression and depicts synthetic data. This is a tested redesign milestone, not complete R21 verification or a certified release.
