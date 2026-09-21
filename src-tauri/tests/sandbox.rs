#![cfg(windows)]
use evidence_desk::{case::Case, processing, sandbox};
use serde_json::{json, Value};
use std::{fs, net::TcpListener, time::Duration};

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn prepared_processing_cancels_without_publishing_or_changing_originals() {
    let dir=tempfile::tempdir().unwrap();
    let mut case=Case::create(&dir.path().join("case"),"Cancellation fixture").unwrap();
    let source=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/photograph.png");
    case.import_files(&[source.to_string_lossy().into_owned()],"fixture").unwrap();
    let source=case.sources().unwrap()[0].id.clone();
    let job=processing::prepare_request(&mut case,&source,json!({"crop":null})).unwrap();
    assert_eq!(case.snapshot().unwrap()["jobs"][0]["status"],"running");
    processing::cancel(&case,&job.job_id).unwrap();
    let result=processing::run_prepared(&job);assert!(result.is_err());
    assert!(processing::publish_prepared(&mut case,&job,result).is_err());
    assert_eq!(case.snapshot().unwrap()["jobs"][0]["status"],"cancelled");
    assert_eq!(case.db.query_row("SELECT count(*) FROM artifacts",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    case.verify_source(&source).unwrap();
}

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

#[test]
#[ignore = "Requires packaged OCR worker"]
fn automatic_ocr_and_media_inventory_publish_with_originals_preserved() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Automatic analysis fixture").unwrap();
    let fixtures=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("fixtures/generated");
    for filename in ["statement.pdf","photograph.png"] {
        case.import_files(&[fixtures.join(filename).to_string_lossy().into()],"synthetic").unwrap();
    }
    evidence_desk::automatic::enqueue(&mut case).unwrap();
    while let Some(job)=evidence_desk::automatic::next(&mut case).unwrap() {
        // Preparing a worker does not retain a case borrow during computation.
        assert_eq!(case.snapshot().unwrap()["automatic_analysis"]["files"],2);
        let value=processing::run_prepared(&job.processor).unwrap();
        assert!(value["pages"].as_array().unwrap().iter().any(|p|p["method"].as_str().unwrap_or("").contains("RapidOCR")),"{value}");
        if job.processor.source.kind=="pdf" {assert!(value["pages"].as_array().unwrap().iter().filter(|p|p["method"].as_str().unwrap_or("").contains("RapidOCR")).any(|p|p["text"].as_str().unwrap_or("").to_uppercase().contains("SYNTHETIC")),"{value}");}
        evidence_desk::automatic::publish(&mut case,&job,Ok(value)).unwrap();
        case.verify_source(&job.processor.source.id).unwrap();
    }
    assert_eq!(evidence_desk::automatic::status(&case).unwrap()["prepared"],2);
    case.import_files(&[fixtures.join("variable-timing.mp4").to_string_lossy().into()],"synthetic").unwrap();
    let source=case.sources().unwrap().into_iter().find(|s|s.kind=="video").unwrap();
    let inventory=processing::process_request(&mut case,&source.id,json!({"operation":"automatic"})).unwrap();
    assert!(inventory["metadata"]["streams"].as_array().unwrap().iter().any(|s|s["type"]=="video"));
    assert_eq!(inventory["metadata"]["coverage"]["model_inspected"],false);

}

#[test]
#[ignore = "Requires packaged worker"]
fn completed_worker_output_survives_restart_before_publication() {
    let dir=tempfile::tempdir().unwrap();let root=dir.path().join("case");let mut case=Case::create(&root,"Recovery fixture").unwrap();
    let file=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/photograph.png");case.import_files(&[file.to_string_lossy().into_owned()],"Synthetic").unwrap();let source=case.sources().unwrap()[0].id.clone();
    let job=processing::prepare_request(&mut case,&source,json!({"crop":null})).unwrap();let job_id=job.job_id.clone();processing::run_prepared(&job).unwrap();let staged=job.staging.path().to_path_buf();drop(job);drop(case);
    assert!(staged.join("result.json").exists());let mut case=Case::open(&root).unwrap();let resumed=processing::resume(&mut case,&job_id).unwrap();let output=processing::run_prepared(&resumed).unwrap();processing::publish_prepared(&mut case,&resumed,Ok(output)).unwrap();
    case.verify_source(&source).unwrap();assert!(processing::resume(&mut case,&job_id).is_err());case.verify_audit().unwrap();
}
#[test]
#[ignore = "Requires packaged worker"]
fn word_export_preserves_saved_text_and_rechecks_revision_before_publication() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Word export").unwrap();
    let record=case.write_record(None,0,"Synthetic draft","note","Unicode evidence: café. No identity established.","human","fixture",None,vec![]).unwrap();
    let target=dir.path().join("draft.docx");let job=evidence_desk::exports::prepare_document(&case,&record.id,&target).unwrap();evidence_desk::exports::run_document(&job).unwrap();evidence_desk::exports::publish_document(&mut case,&job).unwrap();
    assert!(target.metadata().unwrap().len()>1000);
    assert!(evidence_desk::exports::publish_document(&mut case,&job).is_err());
    case.import_files(&[target.to_string_lossy().into_owned()],"Synthetic export").unwrap();let source=case.sources().unwrap()[0].id.clone();let extracted=processing::process(&mut case,&source,None).unwrap();assert!(extracted.to_string().contains("No identity established"));case.verify_audit().unwrap();
}

#[test]
#[ignore = "Requires packaged worker"]
fn flattened_redaction_requires_page_review_and_exports_only_derivative() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Redaction fixture").unwrap();let file=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/statement.pdf");case.import_files(&[file.to_string_lossy().into_owned()],"Synthetic").unwrap();let source=case.sources().unwrap()[0].id.clone();
    let result=processing::process_request(&mut case,&source,json!({"operation":"redact","boxes":[{"page":1,"x":40,"y":40,"width":550,"height":100}]})).unwrap();let pdf=result["published"].as_array().unwrap().iter().find(|p|p["metadata"]["mime"]=="application/pdf").unwrap()["artifact_id"].as_str().unwrap();
    let target=dir.path().join("redacted.pdf");assert!(evidence_desk::exports::export_redaction(&mut case,pdf,&target).is_err());
    assert!(evidence_desk::exports::review_redaction(&mut case,pdf,&[],"").is_err());evidence_desk::exports::review_redaction(&mut case,pdf,&[1],"Synthetic page review").unwrap();evidence_desk::exports::export_redaction(&mut case,pdf,&target).unwrap();case.verify_source(&source).unwrap();
    case.import_files(&[target.to_string_lossy().into_owned()],"Synthetic redacted output").unwrap();let derivative=case.sources().unwrap().into_iter().find(|s|s.id!=source).unwrap();let extracted=processing::process_request(&mut case,&derivative.id,json!({})).unwrap();assert!(extracted["pages"].as_array().unwrap().iter().all(|p|p["text"].as_str().unwrap_or("").trim().is_empty()));
}
#[test]
#[ignore = "Requires packaged worker"]
fn pdf_draft_export_preserves_unicode_text() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"PDF draft").unwrap();let record=case.write_record(None,0,"Synthetic report","note","café — unresolved evidence.","human","fixture",None,vec![]).unwrap();let target=dir.path().join("draft.pdf");let job=evidence_desk::exports::prepare_document(&case,&record.id,&target).unwrap();evidence_desk::exports::run_document(&job).unwrap();evidence_desk::exports::publish_document(&mut case,&job).unwrap();case.import_files(&[target.to_string_lossy().into_owned()],"Synthetic").unwrap();let source=case.sources().unwrap()[0].id.clone();let result=processing::process_request(&mut case,&source,json!({})).unwrap();assert!(result.to_string().contains("café"));
}

#[test]
#[ignore = "Requires packaged MiniLM worker"]
fn semantic_search_finds_synonyms_and_rejects_changed_permissions() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Semantic fixture").unwrap();
    let file=dir.path().join("report.txt");fs::write(&file,"The automobile collided with the pedestrian.\nThe kitchen contains a refrigerator.\nThe gardener planted tulips.").unwrap();
    case.import_files(&[file.to_string_lossy().into_owned()],"fixture").unwrap();let id=case.sources().unwrap()[0].id.clone();
    let job=evidence_desk::semantic::prepare(&case,"A car hit a person walking",vec![id.clone()]).unwrap();
    let output=evidence_desk::semantic::run(&job).unwrap();
    let result=evidence_desk::semantic::publish(&mut case,&job,output.clone()).unwrap();
    assert!(result["results"][0]["excerpt"].as_str().unwrap().contains("automobile"));assert_eq!(result["remaining_passages"],0);
    case.db.execute("UPDATE sources SET restricted=1 WHERE id=?",[&id]).unwrap();
    assert!(evidence_desk::semantic::publish(&mut case,&job,output).is_err());
    assert!(evidence_desk::semantic::prepare(&case,"car",vec![id.clone()]).is_err());
    case.db.execute("UPDATE sources SET restricted=0 WHERE id=?",[&id]).unwrap();
    case.db.execute("UPDATE extracts SET revision=revision+1 WHERE source_id=?",[&id]).unwrap();
    let new_job=evidence_desk::semantic::prepare(&case,"car",vec![id]).unwrap();
    let output=evidence_desk::semantic::run(&new_job).unwrap();
    let result=evidence_desk::semantic::publish(&mut case,&new_job,output).unwrap();assert_eq!(result["indexed_passages"],3);
}
#[test]
#[ignore = "Requires packaged transcription checkpoint worker"]
fn interrupted_transcription_reuses_durable_chunks_and_keeps_cancellation_gate() {
    let dir=tempfile::tempdir().unwrap();let root=dir.path().join("case");let mut case=Case::create(&root,"Resume transcription").unwrap();
    let file=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/synthetic-speech.wav");case.import_files(&[file.to_string_lossy().into_owned()],"fixture").unwrap();let id=case.sources().unwrap()[0].id.clone();
    let job=evidence_desk::transcription::begin(&mut case,&id).unwrap();let original=evidence_desk::transcription::run(&job).unwrap();
    let checkpoints=fs::read_dir(&job.staging).unwrap().map(|e|e.unwrap().path()).filter(|p|p.file_name().unwrap().to_string_lossy().starts_with("chunk-")).map(|p|{let m=p.metadata().unwrap().modified().unwrap();(p,m)}).collect::<Vec<_>>();assert!(!checkpoints.is_empty());
    let jobid=job.id.clone();drop(case);let mut case=Case::open(&root).unwrap();
    let resumed=evidence_desk::transcription::resume(&mut case,&jobid).unwrap();let output=evidence_desk::transcription::run(&resumed).unwrap();assert_eq!(original,output);
    for (path,time) in checkpoints {assert_eq!(path.metadata().unwrap().modified().unwrap(),time,"Inference checkpoint was rewritten");}
    fs::write(resumed.staging.join("cancel.request"),b"cancel").unwrap();assert!(evidence_desk::transcription::publish(&mut case,&resumed,output).is_err());
}
#[test]
#[ignore = "Requires packaged worker"]
fn agent_prepared_media_publishes_once_and_records_actual_page_receipt() {
    use evidence_desk::agent;
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Prepared agent fixture").unwrap();
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/statement.pdf");case.import_files(&[path.to_string_lossy().into_owned()],"fixture").unwrap();let source=case.sources().unwrap()[0].id.clone();
    let mut settings=case.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.allow_images=true;settings.model="synthetic".into();case.save_settings(settings).unwrap();
    let task=agent::start(&mut case,"Inspect page","investigate",vec![source.clone()],vec![],0.).unwrap();let request=agent::prepare_request(&mut case,&task).unwrap();
    let response=json!({"status":"completed","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":"prepared-page","name":"inspect_document_page","arguments":json!({"source_id":source,"page":1}).to_string()}]});
    let jobs=agent::prepare_media(&mut case,&task,&request.transmission,&response).unwrap();assert_eq!(jobs.len(),1);
    let mut media=agent::PreparedMedia{jobs:jobs.into_iter().map(|j|{let output=processing::run_prepared(&j);(j,output)}).collect(),external:true,error:None};
    agent::receive_prepared(&mut case,&task,&request.transmission,response.clone(),&mut media).unwrap();assert!(media.jobs.is_empty());
    assert_eq!(case.actions(&task).unwrap()[0]["status"],"complete");
    assert_eq!(case.db.query_row("SELECT count(*) FROM processing_jobs WHERE kind='pdf_page'",[],|r|r.get::<_,u64>(0)).unwrap(),1);
    assert_eq!(case.db.query_row("SELECT count(*) FROM coverage_receipts WHERE stage='page_rendered'",[],|r|r.get::<_,u64>(0)).unwrap(),1);
    assert!(agent::receive_prepared(&mut case,&task,&request.transmission,response,&mut media).is_err());
}
#[test]
#[ignore = "Requires packaged diarization models"]
fn local_speaker_turns_are_anonymous_scoped_and_timestamped() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Speaker fixture").unwrap();
    let source=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/synthetic-speech.wav");case.import_files(&[source.to_string_lossy().into_owned()],"fixture").unwrap();let id=case.sources().unwrap()[0].id.clone();
    let result=processing::process_request(&mut case,&id,json!({"operation":"diarize","start":0,"end":10,"track":0})).unwrap();
    let turns=result["metadata"]["turns"].as_array().unwrap();assert!(!turns.is_empty());assert_eq!(result["metadata"]["speaker_ids_local_to_this_run"],true);
    for turn in turns {assert!(turn["start"].as_f64().unwrap()>=0.);assert!(turn["end"].as_f64().unwrap()<=10.);assert!(turn["speaker"].as_str().unwrap().starts_with("voice_"));}
    case.validate_citation(result["extraction_locator"].as_str().unwrap()).unwrap();case.verify_source(&id).unwrap();
    assert!(processing::process_request(&mut case,&id,json!({"operation":"diarize","start":0,"end":10,"track":999})).is_err());
}
#[test]
#[ignore = "Requires packaged small speech model"]
fn selected_small_speech_profile_has_actual_model_provenance() {
    let dir=tempfile::tempdir().unwrap();let mut case=Case::create(&dir.path().join("case"),"Small speech fixture").unwrap();
    let file=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/synthetic-speech.wav");case.import_files(&[file.to_string_lossy().into_owned()],"fixture").unwrap();let id=case.sources().unwrap()[0].id.clone();case.set_meta("asr_profile","small").unwrap();
    let job=evidence_desk::transcription::begin(&mut case,&id).unwrap();let result=evidence_desk::transcription::run(&job).unwrap();assert_eq!(result["metadata"]["model"],"faster-whisper-small");assert!(!result["pages"].as_array().unwrap().is_empty());
    let result=evidence_desk::transcription::publish(&mut case,&job,result).unwrap();let record=case.record(result["record_id"].as_str().unwrap()).unwrap();assert!(record.content.contains("local small model"));
}

#[test]
#[ignore = "Requires packaged worker and generated fixtures"]
fn identical_extraction_reuses_verified_artifacts_across_reopen() {
    let dir=tempfile::tempdir().unwrap();
    let root=dir.path().join("case");
    let mut case=Case::create(&root,"Cache fixture").unwrap();
    let source=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/photograph.png");
    case.import_files(&[source.to_string_lossy().into_owned()],"fixture").unwrap();
    let sid=case.sources().unwrap()[0].id.clone();
    let first=processing::process_request(&mut case,&sid,json!({"crop":null})).unwrap();
    let count:i64=case.db.query_row("SELECT count(*) FROM artifacts",[],|r|r.get(0)).unwrap();
    drop(case);
    let mut case=Case::open(&root).unwrap();
    let job=processing::prepare_request(&mut case,&sid,json!({"crop":null})).unwrap();
    assert!(job.cached.is_some());
    let output=processing::run_prepared(&job);
    let second=processing::publish_prepared(&mut case,&job,output).unwrap();
    assert_eq!(second["reused"],true);
    assert_eq!(first["extraction_locator"],second["extraction_locator"]);
    assert_eq!(count,case.db.query_row("SELECT count(*) FROM artifacts",[],|r|r.get::<_,i64>(0)).unwrap());
    let changed=processing::prepare_request(&mut case,&sid,json!({"crop":[0,0,10,10]})).unwrap();
    assert!(changed.cached.is_none());
}
