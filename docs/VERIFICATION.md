> **Superseded — September 21, 2026.** See docs/EVIDENCE-DESK-IMPLEMENTATION.md and docs/V4-IMPLEMENTATION.md for current capabilities. Retained as a historical record of the 0.1.x/0.2.x acceptance sessions.

# Verification record

Development validation, September 20, 2026. These are implementation checks, not professional-release acceptance or model-quality certification.

## Automated checks

- Frontend TypeScript production build passed; 3 Vitest tests cover citation parsing, browser-preview boundaries, and stale editor writes.
- Rust: 20 core integration tests and 1 sandbox argument-quoting unit test passed. Coverage includes duplicate occurrences, failed import accounting, source hashes, case locking, citation bounds, revision CAS, approval non-inheritance, protection, staleness, source-scoped tools, offline gates and removal of legacy spending/step caps, replay rejection, encrypted restoration and audit changes.
- Seven explicitly invoked Windows sandbox tests passed individually: private-file/network denial; PDF/image/DOCX/XLSX and PDF page rendering; VFR sample PTS plus backup restoration; track-specific local speech transcription; full-recording transcription with TXT/JSON/SRT publication and backup restoration; queued full-recording processing and silent-track disposition; dense frame pagination and source-scoped artifact reinspection. These tests require the packaged worker; ordinary `cargo test` intentionally marks them ignored.
- npm production dependency audit reported zero known vulnerabilities at validation time. This is not a comprehensive dependency/security review. Rust reports a future-compatibility warning in `proc-macro-error2`; it does not prevent current compilation.

## Desktop checks

The embedded-frontend x64 executable was launched and connected through an explicit developer-only WebView2 CDP port. Native case creation, import of six synthetic evidence formats, PDF extraction, immutable locator resolution and working-record creation succeeded. The original image loaded at its expected dimensions. This caught an encoded-slash bug in derivative URLs; the coordinator now percent-decodes before resolving an allowlisted source/artifact ID.

A separate user-authorized real-data validation uses the application UI to import an evidence folder and start full transcription. Real evidence, case databases, transcripts and screenshots are excluded from the source repository. No real evidence is used as a committed regression fixture. Transcription runs locally. With the user-configured key and transmission permissions enabled, live API tests read source text and working transcripts, queued full transcription, and requested video frame inspection through the desktop UI.

## Not established

No model-quality evaluation, full media comparison investigation, clean-machine installation, second-machine restoration, signed installer, strict-offline packet capture, complete redaction leakage matrix, target-scale benchmark or independent security assessment has passed in this session. Do not infer these from the tests above.

The development CDP port is an explicit test-launch environment setting, not part of normal application startup. Do not enable it for ordinary confidential case work.

Version 0.1.3 removes application dollar caps and the fixed 20-step ceiling at the user's request. Provider limits, bounded tool outputs, provider context capacity, cancellation, repeated-unproductive-call detection, protected records and sandbox limits remain. Pricing fields are optional estimates; reported input/output token usage is displayed. Legacy budget database fields remain for compatibility but are not enforced.

Real-folder desktop processing completed all eight recordings: eight transcript records, eight TXT and JSON reports, and seven SRT files. One AVI had no audio tracks and received an explicit no-audio report. The tiny-model transcripts are unreviewed machine output, not accuracy-certified legal transcripts. Processing was queued from the application agent/UI.

The v0.1.3 desktop live test read a transcript, created Agent access check, reread it, published revision 2, validated citations, and completed in ten API steps. Both revisions remain attributable to the agent and unreviewed. Version 0.1.4 adds literal-OR passage retrieval over source text and working records, batch scanned-PDF page inspection, an evidence-support review stage, and automatic persistence of cited findings. Tests verify scoped passage retrieval and review-stage persistence.

Version 0.1.4 live desktop regression: a disputed officer-identification question opened six scanned report pages, revisited two videos, reran an audio interval, created a cited finding, and completed after the evidence-support review. The supplied test prompt did not name an officer. The agent returned an identity with report citations and retained uncertainty about the precise visible knock. This single result is not a model-quality threshold or independent validation of all its timing claims.
Version 0.1.5 pages oversized video sample requests with explicit next_start instead of rejecting them. A real AppContainer regression verified continuation preserves the expected variable-frame-rate decoder timestamp. Seven sandbox tests have now passed individually.

Version 0.1.6 adds direct reinspection of saved image artifacts and keeps only the latest 48 images attached per API request. Earlier images and receipts remain immutable locally and are explicitly identified as omitted/reopenable; this is not an investigation or total-frame limit. A regression checks that dispatch does not mutate the persisted visual history. All ten real managed source hashes were verified unchanged after processing.

A longer real investigation exposed the previous 200,000-byte application context stop. Version 0.1.6 removes that stop, abbreviates older large tool results explicitly in dispatch, and retains the complete saved receipt through read_tool_result with pagination. A regression recovers content beyond the old limit exactly. GPT-5 reasoning model requests use high effort with 16,384 output-token headroom; other models retain their existing request configuration. Cancellation remains responsive while provider requests have a longer timeout.

Important visual-quality failure: direct desktop playback and inspection of the saved 519.018-second artifact showed an officer beside a handcuffed person inside the office, contradicting an earlier agent description of a door approach. Decoder timestamps and original hashes matched; the model interpretation was wrong. The cited identity result alone must not be counted as a passed temporal/event-identification test. Version 0.1.7 adds a fresh visual-description API pass containing only the current images and their decoder/page metadata, without prior task assertions. A regression verifies prior narrative is absent from that request while complete task history remains stored. This reduces narrative anchoring but is not a guarantee against visual hallucination.

Final v0.1.7 real desktop correction completed in 22 API steps without approval prompts. The fresh pass correctly described the disputed 519.018-second office scene. The agent then inspected the first-minute entrance sequence, identified visible hand-to-door contact at 53.0069 seconds, reopened the scanned reporting-officer evidence, and revised both earlier saved findings to revision 2 while retaining their history and AI/unreviewed status. Direct inspection of the saved 53.0069-second frame confirmed the visible hand position. The exact knock interpretation remains qualified; this is a successful targeted regression, not general model-quality certification. The final citation opened a 1280-pixel image in the app with the full transcript alongside it; the mode/access selectors were absent.
