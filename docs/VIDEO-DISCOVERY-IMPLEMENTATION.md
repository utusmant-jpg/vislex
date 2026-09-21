# Video discovery implementation

Implemented against the shared working tree alongside the chat/workspace changes, September 20, 2026. Original sources, transcript lines and the investigation engine are preserved.

## Delivered

- Automatic video OCR and scene/periodic overview indexes, default five-second samples. Separate parent jobs publish validated 60-second chunks through the existing AppContainer worker. One discovery runner per open case; foreground media work takes priority between chunks.
- RapidOCR retains visible text, raw scores, polygons, image dimensions and exact frame PTS. Camera-clock text remains unverified text. Empty OCR samples and failures are distinct.
- PySceneDetect 0.7.1 ContentDetector processes consecutive decoded frames (640x360 maximum); thumbnails also sample uninterrupted footage. Cut threshold 27, local half-second cooldown; native decoder timestamp objects are supplied. Thumbnails retain source and container-relative playback clocks.
- Search passages includes scoped video-text artifact references. Agent overview/status tools expose navigation candidates; actual image inspection still uses inspect_artifact_image and follow-up inspect_video_interval.
- Viewer offers paginated Overview and Text in video, literal text filtering over a selected time range, exact-frame display, surrounding playback, indexing status, cancellation and explicit retry. Default initial range is the first hour; change the range for later footage.
- Index revisions are keyed by source hash, sampling settings and worker hash. Published chunks survive cancellation/restart, and source restrictions apply to queueing, browsing and searching. Failed/cancelled parents are not silently restarted; interrupted parents resume on case opening. A changed worker requires a new revision.
- New derivatives never replace transcripts, populate source extraction lines, or satisfy perception coverage. A separate discovery generation invalidates search pagination without invalidating existing evidence findings.
- Automatic case review waits for the existing auto_prepare/full_audio jobs that change transcript/document revisions, but does not wait for discovery indexes. This intentionally preserves the other task's fix for repeated dossier invalidation. New index completion does not restart the entire review.
- Existing local anonymous speaker-turn analysis remains available. Added versioned human display labels and turn assignments, including multiple voices or unknown, with stale-revision rejection, persistent history, speaker filtering and agent-readable corrections. Machine artifacts/transcripts are unchanged; labels never verify identity.

## Speaker pipeline evaluation boundary

The workspace already contains and packages sherpa-onnx 1.13.8 with pyannote segmentation-3.0 and TitaNet-S embeddings. This is **not** the full pyannote Community-1 pipeline. It currently analyzes an explicitly selected audio track and interval up to 600 seconds; speaker IDs are scoped to that run. The packaged native test verifies execution and timing, not diarization accuracy.

The separate Community-1 proposal is not enabled: neither torch nor pyannote is installed in the worker environment, and Community-1 weights have not been acquired or sandbox-validated. Its upstream model card describes gated acquisition and offline local loading: https://huggingface.co/pyannote/speaker-diarization-community-1 . No silent download or substitute identity claim is made.

Remaining gates for full-recording Community-1: explicit model acquisition/terms, pinned artifacts and dependency licenses, Windows AppContainer packaging, recording-wide clustering, bounded recovery, word-level transcript alignment, overlap-preserving model outputs, and representative CPU/memory/accuracy measurement. Current manual overlap corrections preserve ambiguity but do not establish automatic overlap-detection accuracy.

## Verification

- Four synthetic Python discovery tests: actual PTS and shifted origins, cuts between periodic samples, independent chunk boundaries/cancellation, empty versus failed OCR, invalid finite bounds.
- Five Rust discovery tests, including actual packaged Windows AppContainer OCR/overview publication, scoped agent search, separate transcript storage, immutable revisions/reopening, cancellation, nonblocking review, and persisted conflict-checked speaker corrections.
- Combined frontend, core, sandbox and native package results are recorded by the companion workspace task's verification receipt.

## Practical limits

- Sampling misses brief text/actions between frames. Samples and processing failures are reported; no negative-search or continuous-review guarantee is made.
- Scene detector cooldown can intentionally suppress very rapid cuts; OCR and scene thresholds have not been calibrated on a held-out investigation dataset.
- Result pages contain at most 30 samples. Frame manifests cap a chunk at 180 images and report omissions. Individual frames are capped at 1920x1080; high-resolution text may require original targeted inspection.
- Repeated overlay occurrences remain individually navigable; grouped overlay presentation is not implemented. Semantic OCR retrieval is deferred.
- The current broker copies/hashes the original for each uncached chunk. This preserves isolation but adds I/O on large recordings; shared private staging optimization and large-corpus throughput benchmarks remain future work.
- Discovery pauses only between chunks for foreground work. There is no hard real-time preemption of a running inference call.
- No held-out recall, diarization-error, large-corpus storage or reduced-model-call claim has been established. These changes are a tested development preview, not a guarantee that every recording or deployment works perfectly.
