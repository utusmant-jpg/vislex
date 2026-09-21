# Evidence desk implementation ledger

Updated September 20, 2026. The working implementation now includes the investigation workbench, retrieval and benchmark infrastructure described below. This is a development build, not a completed professional-release or competitive-quality certification. Original planning scope remains in [the evidence desk plan](VISLEX-EVIDENCE-DESK-PLAN.md) and its two predecessor documents.

## Implemented and exercised locally

| Area | Current behavior | Verification |
|---|---|---|
| Question dossiers | Revisioned scope, checks backed by actual tool receipts, support/conflict citations, claim reviews, uncertainties and next checks | Rust persistence, stale-receipt, restriction and completion regression tests |
| Completion | Exact draft/evidence/claim-set review binding; unreviewed, partial or declared-checks-complete outcomes; atomic report publication | Citation-free and changed-draft regressions; publication rollback |
| Human review | Accept/reject/needs-review bound to exact claim/dossier/evidence revision | Regression tests; earlier dossier component interaction smoke |
| Coverage | Versioned targeted/exhaustive text-line and physical-page contracts; actual retrieved/rendered unit receipts; incomplete ranges reopen | Range union, extraction revision and truncated-line tests |
| Coverage map | Paginated source preparation status, extraction counts, rendered pages, timestamped frame samples, failures and suggested next checks | Native Coverage tab listed all five synthetic sources with separate operation counts |
| Workbench | Report comparison launcher; support/conflict table; alternative explanations with predicted observations and discriminating checks; changed-finding view and recheck task launcher | Backend scope/revision tests; real native workbench controls inspected |
| Incident replay | Two to four accepted clock mappings, independent held-out anchors, overlapping supported ranges, explicit container/player/incident conversion, synchronized proxies, loop/seek controls | Clock rejection tests; two native synthetic players decoded and played together; browser overshoot defect corrected with per-animation-frame range checks |
| Timestamp mapping | Full transcript track origins retained; playback maps track origin to container-relative seconds; unknown legacy origins do not produce guessed seeks | Frontend timing tests and worker metadata checks |
| Temporal observations | Agent can save ordered frame association hypotheses; timestamps and PTS come from immutable artifacts; gaps and identity remain explicitly unproven | Typed validation; not an evaluated object detector or identity tracker |
| Retrieval | Pinned local MiniLM English embeddings, lexical/semantic rank fusion, current-extraction filtering, restricted-source checks, incremental batches of 256 passages | Actual sandboxed synonym search and stale/permission tests; real native search |
| Local speech | Tiny and small CPU profiles, actual model provenance, all-track decoding, cancellable copying, durable content-keyed speech chunk checkpoints, explicit resume | Real ASR fixture; restart/checkpoint reuse and cancellation-before-publication tests |
| Speaker turns | Local pinned pyannote segmentation/TitaNet embeddings via sherpa-onnx; explicit audio track and bounded interval; anonymous run-local labels; playback links | Actual sandboxed fixture and invalid-track rejection passed; not a diarization accuracy benchmark |
| Direct media | Separate Gemini opt-in; supported originals up to 12 MiB; permission/hash checks; inline media with explicit whole-source limitations | Provider encoding and permission tests; no live Gemini inference test |
| Responsive jobs | Desktop native and agent media processors prepare/run/publish outside the case mutex; production agent dispatcher cannot silently fall back to decoding under the mutex | Worker publication tests; native status calls during processing measured 6–66 ms in one synthetic run, not a scale benchmark |
| Recovery | Durable registered job manifests, worker/source hashes, resumable staged output, orphan inventory, atomic hashed file publication, transactional registration | Restart before publication, corruption rejection, cancellation and backup/restore tests |
| Authorities | Explicit HTTPS retrieval from allowlisted public U.S. authority hosts; immutable source copy; jurisdiction/date/provenance; treatment remains unchecked | URL/HTML safety tests; live retrieval not exercised |
| Legal work products | Typed issue, discovery, contract proposal/obligation, deposition, draft and exhibit rows with citations and authority revision dependencies | Scope, required dates and restriction tests; model-assisted workflow launchers |
| Documents | Fresh DOCX and PDF drafts from saved records; review/version labels; recheck current record and restrictions at publication; no overwrite | Actual worker exports; native DOCX/PDF exports; Unicode PDF test |
| Redaction | PDF/image rectangle masking into fresh flattened derivatives; no original hidden text/attachments; per-page human review binds to output hash; derivative-only export | Actual worker flattening and export gate tests; native page review and exported PDF |
| Offline evidence packages | Current human-reviewed dossier, HTML with escaped content/CSP, supporting files and hash manifest; atomic new-directory publication | Actual export test with HTML escaping, restrictions and content hashes |
| Evaluation | Incident-level independently adjudicated scorer, paired cluster bootstrap, failed/missing-run handling, attribution-aware recall, review time/runtime/cost; read-only real-task capture | Nine Python tests and synthetic scorer example. No measured Harvey result |

The work preserves existing originals, record revisions, provider profiles, source locators, chat behavior, import/backup/restore paths and single-provider use. Changes are additive; the preexisting working tree has not been reset.

## Test and build record

- Full Rust run: 98 passing tests (2 unit, 38 core, 19 dossier, 22 V4, 17 sandboxed-worker), including explicitly enabled worker tests. A further prepared-agent-media integration test passed, bringing the total to 99. Packaged diarization and actual small-profile ASR tests also passed (101 tests in aggregate).
- Frontend: 10 passing tests and production build success.
- Benchmark: 9 passing tests. Included example scores are invented scorer fixtures, not product performance measurements.
- Desktop debug build succeeds. Tauri reports the preexisting `.app` identifier warning; Rust reports the existing proc-macro-error2 future-compatibility warning.
- Native acceptance uses an isolated WebView profile, synthetic case and `VISLEX_TEST_MODE=1`; no provider calls, user case mutation or hidden database edits. `scripts/native-acceptance.ps1` exercises the actual Tauri bridge. Interactive workbench, redaction and replay checks have screenshots in `artifacts/native-*.png`. Automated receipts are stored separately. One initial scripted run failed with an opaque IPC exception after PDF processing; a later packaged run identified the exact-revision export gate rejecting a draft while automatic local transcription changed case state. The script now waits for local transcription to settle before testing draft export. The original opaque exception remains unclassified; this is not presented as proof of its cause.
- Bugs found and fixed during this pass: audio interval model initialization order, Windows read-only attribute propagation during offline export, redaction page publication bound, native replay range overshoot, and SQLite capture connections left open on Windows.

## Deliberate limits and remaining work

These are not silently marked complete:

- **Quality and scale:** no held-out perception/support evaluation, 200-hour/10,000-document load test, clean-machine installer/restore acceptance, independent security review, or actual Harvey comparison. The user has no authorized Harvey account or adjudicated dataset; the harness is ready for those later inputs.
- **Perception:** no held-out diarization evaluation, automatic speaker identification, general-purpose visual object tracking, or sound-event classification model. Ordered frame tracks are explicit association hypotheses. Anonymous diarization proposals are implemented with run-local labels and explicit gap counts. The small ASR profile is available but no quality superiority is claimed from model size alone.
- **Large direct media:** bounded Gemini inline originals only; no large-file upload lifecycle, remote GPU worker deployment or direct-media quality comparison.
- **Coverage:** text/page operation coverage and sampled-media inventory are implemented. Continuous visual/audio understanding and exhaustive semantic coverage are not inferred from decoding or sampling. The model can still omit an undeclared proposition; application checks are not a semantic truth proof.
- **Dependencies:** evidence-object revisions invalidate dependants; dossier currentness remains conservative across scoped records/objects and case generation. Reinvestigation is user-launched; fully automatic precise claim/paragraph delta propagation is not implemented.
- **Legal research/drafting:** public URL retrieval and structured work products are implemented; comprehensive public-source search, treatment/citation validation, full Word tracked-change round trips and specialist workflow evaluation remain open.
- **Redaction/export:** PDF and single-frame images are supported. Audio/video redaction and automatic sensitive-content detection are not implemented. Offline dossier bundles deliberately include cited whole originals and must not be described as sanitized disclosure bundles.
- **Reliability:** chunk checkpoints avoid repeated ASR inference but still decode the source again. Orphan files are retained and inventoried, not automatically adjudicated. Full process-kill/disk-full fault injection at every publication boundary, long-copy export responsiveness and full lease/resource scheduling remain release work.

The delivered preview and benchmark harness must not be advertised as universal or measured superiority to Harvey, or as completion of every requirement in the original platform plan.


### Diarization implementation sources

The speaker pipeline follows the [sherpa-onnx offline diarization API](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py) and its [public model documentation](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html). Models are downloaded only at build time, hash-pinned and bundled; the worker uses CPU inference without network. User output describes model proposals and retains noise/overlap and cross-run label limitations. Actual diarization accuracy remains a held-out evaluation task.


### Packaged preview

`artifacts/VisLex Investigation Preview/VisLex.exe` is the separate unsigned development package. It includes pinned tiny/small ASR, MiniLM retrieval, speaker segmentation/embedding weights and worker libraries, plus the benchmark harness and documentation. Existing earlier packages were not overwritten. The build used an empty temporary Tauri resource-copy override because a running test app had worker DLLs open; the packaging script then copied the newly built worker directly from `src-tauri/resources/worker/evidence-worker`. This avoids disturbing the running app and does not omit worker resources from the package. `verification.json` in the preview records executable/worker hashes and test status.

Final package acceptance passed with a dedicated browser session and explicit daemon shutdown. Five native snapshot calls during document processing took approximately 8–118 ms in that run. All 396 packaged worker files matched build-source SHA-256 values. Final tests: 101 Rust/worker (100 in the final broad run plus the separately passed actual small-model test), 10 frontend and 9 benchmark tests. The package's verification receipt records the remaining scope and unexecuted release gates.
