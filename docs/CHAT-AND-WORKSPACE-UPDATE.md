# Chat and workspace update

Implemented in the shared development tree, September 20, 2026.

## Direct answers and smaller context

Standalone file-count questions have a deterministic completion route. The `finish_inventory` tool also lets the model request the same database-computed answer for other phrasings. It cannot publish arbitrary model-written facts. Counts use permitted original sources; derived working records are separate. No fabricated line citation, dossier inspection, model API call (for recognized standalone wording), or support-review loop is necessary. Snapshot details remain recorded internally.

Chat shows the answer and an optional Activity disclosure. The automatic saved-progress panel, question dossier panel, generic generation-change banner, live tool draft and automatic preparation banner no longer dominate the conversation. Actual terminal errors and Stop/Resume remain available. Dossier and evidence checks remain in the backend for substantive investigations.

Source listings are compact by default. The optional `details` argument retains hashes, MIME types and other original metadata. This is a reduction in repeated context, not a measured claim about all model costs.

## Reusable processing

Processor results are cached persistently by source identity/hash, worker binary hash and normalized request options. Cache reads verify every referenced artifact and verify the original before reuse. Changed processing options produce a new job. Reopening the case preserves the cache. Reuse does not imply visual review or change an artifact's provenance. Redaction jobs are excluded from this cache.

Older artifacts remain available through the artifact inventory and existing transcript records. They are not silently reclassified as newly inspected evidence. The first request with the new cache may process an older uncached extraction once.

## Documents

DOCX and XLSX opening explicitly requests extraction and reads the resulting text independently of the source's previous status label. DOCX paragraph/table order is preserved. PPTX and ODT now have bounded XML text adapters. These are text previews, not full page-layout rendering; limitations identify omitted structures. Legacy binary DOC and arbitrary unsupported formats remain preserved with an honest unsupported-preview message.

## App preferences and projects

AI provider/model preferences apply app-wide, including to previously configured cases when opened. Credentials stay in Windows Credential Manager. Settings choose enabled models; routing is automatic and the execution/review mode dropdowns are removed. Agents may delegate using available models. Restricted-source checks remain enforced.

The sidebar groups conversations under case/project folders, with cached conversation titles for other saved projects. Case tools are available in a compact disclosure. Every case remains its existing self-contained local folder. Switching an actively running case still obeys the existing lock/running-job protections.

## Validation

Targeted regressions cover inventory completion during background record creation, app preferences replacing an existing case model and applying to a new case, verified artifact reuse across reopening, changed-option cache misses, DOCX table order, PPTX numeric slide ordering, and ODT headings/paragraphs/table text. The native acceptance script checks DOCX/XLSX extraction and reuse and a zero-provider-call six-file count through the real Tauri bridge. Final package results are recorded separately in the package verification files.
