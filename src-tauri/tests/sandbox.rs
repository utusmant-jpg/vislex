#![cfg(windows)]
use evidence_desk::{case::Case, processing, sandbox};
use serde_json::{json, Value};
use std::{fs, net::TcpListener, time::Duration};

#[test]
#[ignore = "Requires packaged worker; run after scripts/build-worker.ps1"]
fn appcontainer_denies_outside_files_and_network() {
    let dir = tempfile::tempdir().unwrap();
    let job = dir.path().join("job");
    fs::create_dir(&job).unwrap();
    let secret = dir.path().join("outside.txt");
    fs::write(&secret, "sentinel-must-not-be-readable-or-written").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(
        job.join("request.json"),
        json!({"kind":"probe","outside_path":secret,"port":port}).to_string(),
    )
    .unwrap();
    sandbox::run_worker(
        &processing::worker_path().unwrap(),
        &job,
        Duration::from_secs(30),
    )
    .unwrap();
    let result: Value =
        serde_json::from_slice(&fs::read(job.join("result.json")).unwrap()).unwrap();
    assert_eq!(result["status"], "complete", "{result}");
    for key in [
        "appcontainer",
        "read_denied",
        "write_denied",
        "network_denied",
    ] {
        assert_eq!(result["metadata"][key], true, "{key}: {result}");
    }
    assert_eq!(
        fs::read_to_string(secret).unwrap(),
        "sentinel-must-not-be-readable-or-written"
    );
}

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn sandboxed_pdf_and_image_processing() {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "processor fixture").unwrap();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures/generated");
    for filename in [
        "statement.pdf",
        "photograph.png",
        "table.xlsx",
        "notes.docx",
    ] {
        let path = fixtures.join(filename);
        case.import_files(&[path.to_string_lossy().into()], "synthetic")
            .unwrap();
        let source = case
            .sources()
            .unwrap()
            .into_iter()
            .find(|s| s.name == filename)
            .unwrap();
        let result = processing::process(&mut case, &source.id, None).unwrap();
        assert_eq!(result["status"], "complete");
        if filename == "photograph.png" {
            assert!(result["artifact_id"].is_string());
        } else {
            assert!(case.read_text(&source.id, 1, 100).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("SYNTHETIC"));
        }
        case.verify_source(&source.id).unwrap();
        if filename == "statement.pdf" {
            let rendered = processing::process_request(
                &mut case,
                &source.id,
                json!({"operation":"render_page","page":1}),
            )
            .unwrap();
            assert_eq!(rendered["published"][0]["metadata"]["page"], 1);
            case.validate_citation(rendered["published"][0]["locator"].as_str().unwrap())
                .unwrap();
            assert!(processing::process_request(
                &mut case,
                &source.id,
                json!({"operation":"render_page","page":999})
            )
            .is_err());
        }
    }
}

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn video_samples_retain_actual_decoder_timestamps_and_survive_backup() {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "video fixture").unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures/generated/variable-timing.mp4");
    case.import_files(&[path.to_string_lossy().into()], "synthetic")
        .unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    let result = processing::process_request(
        &mut case,
        &source,
        json!({"start":0.5,"end":2.6,"interval":1.0}),
    )
    .unwrap();
    let frames = result["published"].as_array().unwrap();
    assert_eq!(frames.len(), 2);
    assert!(
        (frames[0]["metadata"]["source_relative_seconds"]
            .as_f64()
            .unwrap()
            - 0.6)
            .abs()
            < 0.001
    );
    assert!(
        (frames[1]["metadata"]["source_relative_seconds"]
            .as_f64()
            .unwrap()
            - 2.5)
            .abs()
            < 0.001
    );
    let locator = frames[0]["locator"].as_str().unwrap();
    case.validate_citation(locator).unwrap();
    let backup_path = dir.path().join("video.age");
    evidence_desk::backup::backup(&mut case, &backup_path, "fixture-password-long").unwrap();
    let restored = evidence_desk::backup::restore(
        &backup_path,
        &dir.path().join("restored"),
        "fixture-password-long",
    )
    .unwrap();
    restored.validate_citation(locator).unwrap();
}

#[test]
#[ignore = "Requires packaged worker, tiny model, and generated speech fixture"]
fn local_audio_transcription_is_track_specific_and_cited() {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "speech fixture").unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures/generated/synthetic-speech.wav");
    case.import_files(&[path.to_string_lossy().into()], "synthetic")
        .unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    let result = processing::process_request(
        &mut case,
        &source,
        json!({"operation":"transcribe","start":0,"end":12,"track":0}),
    )
    .unwrap();
    assert_eq!(result["metadata"]["track_index"], 0);
    assert_eq!(result["metadata"]["vad"], false);
    let text = result["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    assert!(
        text.contains("blue"),
        "Unexpected machine transcript: {text}"
    );
    case.validate_citation(result["extraction_locator"].as_str().unwrap())
        .unwrap();
}

#[test]
#[ignore = "Requires packaged worker and generated synthetic speech"]
fn full_transcript_publishes_files_and_restores_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "full speech").unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("fixtures/generated/synthetic-speech.wav");
    case.import_files(&[path.to_string_lossy().into()], "synthetic")
        .unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    let job = evidence_desk::transcription::begin(&mut case, &source).unwrap();
    let value = evidence_desk::transcription::run(&job).unwrap();
    assert_eq!(value["metadata"]["tracks"][0]["decoded_to_eof"], true);
    assert!(value["pages"].as_array().unwrap().iter().any(|p| p["text"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .contains("blue")));
    let result = evidence_desk::transcription::publish(&mut case, &job, value).unwrap();
    case.validate_citation(result["locator"].as_str().unwrap())
        .unwrap();
    let files = result["saved_files"].as_array().unwrap();
    assert_eq!(files.len(), 3);
    for path in files {
        assert!(case.root.join(path.as_str().unwrap()).is_file());
    }
    let archive = dir.path().join("backup.age");
    evidence_desk::backup::backup(&mut case, &archive, "synthetic-test-passphrase").unwrap();
    let restored = evidence_desk::backup::restore(
        &archive,
        &dir.path().join("restored"),
        "synthetic-test-passphrase",
    )
    .unwrap();
    for path in files {
        assert_eq!(
            std::fs::read(case.root.join(path.as_str().unwrap())).unwrap(),
            std::fs::read(restored.root.join(path.as_str().unwrap())).unwrap()
        );
    }
}

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn queued_recordings_run_once_and_include_silent_video_disposition() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"queue fixture").unwrap();
    let fixtures=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures/generated");
    case.import_files(&[fixtures.join("synthetic-speech.wav").to_string_lossy().into(),fixtures.join("variable-timing.mp4").to_string_lossy().into()],"synthetic").unwrap();
    let sources:Vec<String>=case.sources().unwrap().into_iter().map(|s|s.id).collect();
    evidence_desk::transcription::enqueue(&mut case,&sources).unwrap();evidence_desk::transcription::enqueue(&mut case,&sources).unwrap();
    let queued:i64=case.db.query_row("SELECT count(*) FROM processing_jobs WHERE status='queued'",[],|r|r.get(0)).unwrap();assert_eq!(queued,2);
    let mut no_audio=0;
    while let Some(job)=evidence_desk::transcription::next(&mut case).unwrap(){
        assert!(evidence_desk::transcription::next(&mut case).unwrap().is_none());
        let value=evidence_desk::transcription::run(&job).unwrap();if value["metadata"]["no_audio_tracks"]==true{no_audio+=1;}
        evidence_desk::transcription::publish(&mut case,&job,value).unwrap();
    }
    assert_eq!(no_audio,1);assert_eq!(case.records().unwrap().len(),2);
    evidence_desk::transcription::enqueue(&mut case,&sources).unwrap();assert!(evidence_desk::transcription::next(&mut case).unwrap().is_none());
}

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn dense_agent_video_requests_page_without_rejection() {
    let dir=tempfile::tempdir().unwrap();
    let mut case=Case::create(&dir.path().join("case"),"paged video").unwrap();
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures/generated/variable-timing.mp4");
    case.import_files(&[path.to_string_lossy().into()],"synthetic").unwrap();
    let sid=case.sources().unwrap()[0].id.clone();
    let mut settings=case.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.allow_images=true;settings.model="test-model".into();case.save_settings(settings).unwrap();
    let task=evidence_desk::agent::start(&mut case,"Inspect dense sequence","investigate",vec![sid.clone()],vec![],0.).unwrap();
    let first=evidence_desk::agent::execute_tool(&mut case,&task,"inspect_video_interval",&json!({"source_id":sid,"start":0.,"end":2.7,"interval":0.1})).unwrap();
    let next=first["next_start"].as_f64().unwrap();assert!((next-2.4).abs()<0.001);
    assert!(!first["frames"].as_array().unwrap().is_empty());
    let artifact=first["frames"][0]["artifact_id"].as_str().unwrap();
    let reopened=evidence_desk::agent::execute_tool(&mut case,&task,"inspect_artifact_image",&json!({"source_id":sid,"artifact_id":artifact})).unwrap();
    assert_eq!(reopened["artifact_id"],artifact);
    assert!(evidence_desk::agent::execute_tool(&mut case,&task,"inspect_artifact_image",&json!({"source_id":"outside-case","artifact_id":artifact})).is_err());

    let second=evidence_desk::agent::execute_tool(&mut case,&task,"inspect_video_interval",&json!({"source_id":sid,"start":next,"end":2.7,"interval":0.1})).unwrap();
    assert!(second["next_start"].is_null());
    assert!(second["frames"].as_array().unwrap().iter().any(|frame|(frame["metadata"]["source_relative_seconds"].as_f64().unwrap()-2.5).abs()<0.001));
}
#[test]
#[ignore = "Requires packaged worker"]
fn playback_derivative_preserves_original_and_restores() {
    let dir=tempfile::tempdir().unwrap();
    let mut case=Case::create(&dir.path().join("case"),"playback fixture").unwrap();
    let input=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures/generated/variable-timing.mp4");
    case.import_files(&[input.to_string_lossy().into()],"synthetic").unwrap();
    let source=case.sources().unwrap().remove(0);
    let job=processing::prepare_playback(&mut case,&source.id).unwrap();
    let result=processing::run_playback(&job);
    let result=processing::publish_playback(&mut case,&job,result).unwrap();
    let artifact=result["artifact_id"].as_str().unwrap();
    let (_,mime,path,_)=processing::artifact(&case,artifact).unwrap();
    assert_eq!(mime,"video/mp4");assert!(path.metadata().unwrap().len()>100);
    case.verify_source(&source.id).unwrap();
    let archive=dir.path().join("playback.age");
    evidence_desk::backup::backup(&mut case,&archive,"synthetic-test-password").unwrap();
    let restored=evidence_desk::backup::restore(&archive,&dir.path().join("restored"),"synthetic-test-password").unwrap();
    assert_eq!(processing::artifact(&restored,artifact).unwrap().1,"video/mp4");
}


#[test]
#[ignore = "Requires packaged worker"]
fn sound_discovery_preserves_original_and_returns_citable_candidates() {
    let dir=tempfile::tempdir().unwrap();
    let mut case=Case::create(&dir.path().join("case"),"Synthetic transients").unwrap();
    let samples=32000_u32;let mut wav=Vec::new();
    wav.extend(b"RIFF");wav.extend((36+samples*2).to_le_bytes());wav.extend(b"WAVEfmt ");wav.extend(16_u32.to_le_bytes());
    wav.extend(1_u16.to_le_bytes());wav.extend(1_u16.to_le_bytes());wav.extend(16000_u32.to_le_bytes());wav.extend(32000_u32.to_le_bytes());
    wav.extend(2_u16.to_le_bytes());wav.extend(16_u16.to_le_bytes());wav.extend(b"data");wav.extend((samples*2).to_le_bytes());
    for i in 0..samples {let value:i16=if [8000,12800,17600].iter().any(|start|i>=*start&&i<*start+48){14000}else{0};wav.extend(value.to_le_bytes());}
    let file=dir.path().join("transients.wav");fs::write(&file,&wav).unwrap();
    case.import_files(&[file.to_string_lossy().into()],"Synthetic").unwrap();let sid=case.sources().unwrap()[0].id.clone();
    let result=processing::process_request(&mut case,&sid,json!({"operation":"sound_events","start":0,"end":2,"track":null,"channel":0})).unwrap();
    assert_eq!(result["metadata"]["candidates"].as_array().unwrap().len(),3);
    assert_eq!(result["metadata"]["count_is_knock_count"],false);
    assert_eq!(result["metadata"]["gap_seconds"],0.0);
    case.validate_citation(result["extraction_locator"].as_str().unwrap()).unwrap();
    case.verify_source(&sid).unwrap();
    assert!(case.read_text(&sid,1,100).is_err(),"Sound candidates must not overwrite a source transcript");
    case.verify_audit().unwrap();
}
