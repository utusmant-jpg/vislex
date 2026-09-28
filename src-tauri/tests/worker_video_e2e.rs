//! One-off end-to-end proof (kept as a permanent guard): the frozen worker must
//! support video_ocr inside the real AppContainer. A stale bundle built before
//! the video-discovery worker code answered "Unsupported processor kind" for
//! every discovery job while transcription kept working.
//!
//! It needs the packaged worker (built by scripts/build-worker.ps1, gitignored)
//! and a Windows AppContainer, so it is Windows-only and opt-in like sandbox.rs.
//! Run it with: cargo test --test worker_video_e2e -- --ignored
#![cfg(windows)]
use evidence_desk::{processing, sandbox};
use serde_json::json;
use std::{fs, time::Duration};

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn worker_runs_video_ocr_in_appcontainer() {
    let dir = tempfile::tempdir().unwrap();
    let job = dir.path().join("job");
    fs::create_dir_all(&job).unwrap();
    let video = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated/variable-timing.mp4");
    fs::copy(&video, job.join("input")).unwrap();
    fs::write(
        job.join("request.json"),
        json!({"kind":"video_ocr","start":0.0,"end":3.0,"interval":1.0}).to_string(),
    )
    .unwrap();
    sandbox::run_worker(
        &processing::worker_path().unwrap(),
        &job,
        Duration::from_secs(600),
    )
    .unwrap();
    let result: serde_json::Value =
        serde_json::from_slice(&fs::read(job.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["status"], "complete", "{result}");
    let previews = result["previews"].as_array().unwrap();
    assert!(!previews.is_empty(), "no frames sampled: {result}");
    for preview in previews {
        assert!(
            preview["ocr"].is_object() || preview["ocr_error"].is_string(),
            "every sampled frame needs OCR or a recorded failure: {preview}"
        );
    }
}
