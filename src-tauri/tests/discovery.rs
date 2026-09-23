use evidence_desk::{case::Case,discovery,agent};
use serde_json::{json,Value};
fn setup()->(tempfile::TempDir,Case,String) {
    let dir=tempfile::tempdir().unwrap();let mut c=Case::create(&dir.path().join("case"),"Discovery").unwrap();
    let file=dir.path().join("recording.mp4");std::fs::write(&file,b"synthetic test source").unwrap();c.import_files(&[file.to_string_lossy().into_owned()],"fixture").unwrap();let s=c.sources().unwrap()[0].id.clone();c.db.execute("UPDATE sources SET kind='video',mime='video/mp4' WHERE id=?",[&s]).unwrap();(dir,c,s)
}
fn chunk(c:&mut Case,s:&str,run:&str,start:f64,text:&str,eof:bool)->Value {
    let a=evidence_desk::case::id();
    c.db.execute("INSERT INTO artifacts VALUES(?,?,?,'image/jpeg',?,?,?)",rusqlite::params![a,s,"synthetic",format!("artifacts/{a}.jpg"),"{}","now"]).unwrap();
    let value=json!({"published":[{"artifact_id":a,"metadata":{"source_relative_seconds":start,"playback_seconds":start+3.,"pts":(start*1000.)as i64,"time_base":"1/1000","ocr":{"text":text}}}],"metadata":{"eof":eof,"failures":[],"missing_pts_frames":0}});
    discovery::store_chunk(c,run,s,"video_ocr",start,&value).unwrap();value
}
#[test]
fn independent_search_pagination_recovery_and_revisions() {
    let (dir,mut c,s)=setup();let queued=discovery::enqueue(&mut c,&s,5.,false).unwrap();let run=queued["jobs"][0].as_str().unwrap().to_string();
    let v=chunk(&mut c,&s,&run,0.,"CAM 14:22 exit",false);
    discovery::store_chunk(&mut c,&run,&s,"video_ocr",0.,&v).unwrap();
    assert_eq!(discovery::search(&c,&[s.clone()],&["EXIT".into()]).unwrap().len(),1);
    assert!(discovery::search(&c,&[],&["exit".into()]).unwrap().is_empty());
    let extracts:i64=c.db.query_row("SELECT count(*) FROM extracts WHERE source_id=?",[&s],|r|r.get(0)).unwrap();assert_eq!(extracts,0);
    assert_eq!(discovery::browse(&c,&s,"video_ocr",0.,60.,0,"CAM").unwrap()["samples"].as_array().unwrap().len(),1);
    assert!(discovery::browse(&c,&s,"video_ocr",0.,60.,0,"unseen").unwrap()["samples"].as_array().unwrap().is_empty());
    discovery::cancel(&c,&s).unwrap();discovery::enqueue_missing(&mut c).unwrap();
    assert_eq!(discovery::status(&c,&s).unwrap()["jobs"][0]["status"],"cancelled");
    discovery::enqueue(&mut c,&s,5.,true).unwrap();
    let checkpoint:String=c.db.query_row("SELECT result FROM processing_jobs WHERE id=?",[&run],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&checkpoint).unwrap()["next_start"],60.);
    drop(c);let mut c=Case::open(&dir.path().join("case")).unwrap();
    assert_eq!(discovery::search(&c,&[s.clone()],&["exit".into()]).unwrap().len(),1);
    let fresh=discovery::enqueue(&mut c,&s,2.,false).unwrap();assert_ne!(fresh["jobs"][0],run);
    assert!(discovery::search(&c,&[s.clone()],&["exit".into()]).unwrap().is_empty());
    let retained:i64=c.db.query_row("SELECT count(*) FROM discovery_samples WHERE run_id=?",[run],|r|r.get(0)).unwrap();assert_eq!(retained,1);
    c.db.execute("UPDATE sources SET restricted=1 WHERE id=?",[&s]).unwrap();
    assert!(discovery::browse(&c,&s,"video_ocr",0.,60.,0,"").is_err());
    assert!(discovery::search(&c,&[s.clone()],&["exit".into()]).unwrap().is_empty());
}
#[test]
fn automatic_review_waits_for_discovery_and_restarts_when_inputs_change() {
    let (_dir,mut c,s)=setup();discovery::enqueue(&mut c,&s,5.,false).unwrap();
    c.db.execute("INSERT INTO extracts(source_id,text,method) VALUES(?,'prepared','fixture')",[&s]).unwrap();
    let mut settings=c.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.model="synthetic".into();c.save_settings(settings).unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
    c.db.execute("UPDATE processing_jobs SET status='complete' WHERE kind IN ('video_ocr_index','video_overview_index')",[]).unwrap();
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    c.db.execute("UPDATE tasks SET status='complete' WHERE id=?",[&task]).unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
    c.db.execute("INSERT INTO processing_jobs VALUES('new-discovery',?,'video_overview_index','complete','{}','','now')",[&s]).unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_some());
    let tools=agent::tools("ask");assert!(tools.iter().any(|t|t["name"]=="browse_video_overview"));
}
#[test]
fn overview_navigation_advances_while_full_audio_uses_the_heavy_worker() {
    let (_dir,mut c,s)=setup();
    let queued=discovery::enqueue(&mut c,&s,5.,false).unwrap();
    c.db.execute("INSERT INTO processing_jobs VALUES('long-audio',?,'full_audio','running','{}','',?)",rusqlite::params![s,evidence_desk::case::now()]).unwrap();
    let job=discovery::next(&mut c).unwrap().unwrap();
    assert_eq!(job.run_id,queued["jobs"][1].as_str().unwrap());
    assert_eq!(job.processor.kind,"video_overview");
}
#[test]
fn overview_and_ocr_chunks_alternate_across_a_large_case() {
    let (dir,mut c,first)=setup();
    let other=dir.path().join("second.mp4");std::fs::write(&other,b"different synthetic recording").unwrap();
    c.import_files(&[other.to_string_lossy().into_owned()],"fixture").unwrap();
    let second=c.sources().unwrap().into_iter().find(|source|source.id!=first).unwrap().id;
    c.db.execute("UPDATE sources SET kind='video',mime='video/mp4' WHERE id=?",[&second]).unwrap();
    discovery::enqueue(&mut c,&first,5.,false).unwrap();
    discovery::enqueue(&mut c,&second,5.,false).unwrap();
    for expected in ["video_overview","video_ocr","video_overview","video_ocr"] {
        let job=discovery::next(&mut c).unwrap().unwrap();
        assert_eq!(job.processor.kind,expected);
        c.db.execute("UPDATE processing_jobs SET status='complete' WHERE id IN (?,?)",rusqlite::params![job.run_id,job.processor.job_id]).unwrap();
    }
}
#[test]
fn discovery_claims_one_ocr_and_one_overview_lane_without_double_claiming() {
    let (_dir,mut c,s)=setup();
    discovery::enqueue(&mut c,&s,5.,false).unwrap();
    let first=discovery::next(&mut c).unwrap().unwrap();
    let second=discovery::next(&mut c).unwrap().unwrap();
    assert_eq!(first.processor.kind,"video_overview");
    assert_eq!(second.processor.kind,"video_ocr");
    assert_ne!(first.run_id,second.run_id);
    assert!(discovery::next(&mut c).unwrap().is_none());
}
#[test]
fn cancelling_discovery_releases_child_and_does_not_start_automatic_review() {
    let (_dir,mut c,s)=setup();
    discovery::enqueue(&mut c,&s,5.,false).unwrap();
    let job=discovery::next(&mut c).unwrap().unwrap();
    discovery::cancel(&c,&s).unwrap();
    discovery::publish(&mut c,&job,Err(anyhow::anyhow!("Synthetic cancelled worker"))).unwrap();
    let child:String=c.db.query_row("SELECT status FROM processing_jobs WHERE id=?",[&job.processor.job_id],|r|r.get(0)).unwrap();
    assert_eq!(child,"cancelled");
    assert_eq!(c.db.query_row("SELECT count(*) FROM processing_jobs WHERE status='running'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    c.db.execute("INSERT INTO extracts(source_id,text,method) VALUES(?,'prepared','fixture')",[&s]).unwrap();
    let mut settings=c.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.model="synthetic".into();c.save_settings(settings).unwrap();
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None);
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_none(),"A deliberate cancellation should release chat");
}
#[test]
fn automatic_video_batch_selects_each_twenty_second_bin_and_scene_change_once() {
    let (_dir,mut c,s)=setup();
    let queued=discovery::enqueue(&mut c,&s,5.,false).unwrap();
    let run=queued["jobs"][1].as_str().unwrap();
    c.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",rusqlite::params![json!({"last_chunk":{"eof":true,"last_decoded_seconds":45.0},"has_gaps":false}).to_string(),run]).unwrap();
    for (seconds,scene) in [(0.,false),(5.,false),(20.,false),(30.,true),(40.,false)] {
        let artifact=format!("frame-{seconds:.0}");
        let relative=format!("artifacts/{artifact}.jpg");
        let path=c.root.join(&relative);std::fs::write(&path,b"synthetic jpeg fixture bytes").unwrap();
        c.db.execute("INSERT INTO artifacts VALUES(?,?,?,'image/jpeg',?,?,?)",rusqlite::params![artifact,s,evidence_desk::case::file_hash(&path).unwrap(),relative,json!({"source_relative_seconds":seconds}).to_string(),"now"]).unwrap();
        c.db.execute("INSERT INTO discovery_samples VALUES(?,?,?,?,?,?,?)",rusqlite::params![run,s,"video_overview",seconds,artifact,json!({"scene_boundary":scene}).to_string(),""]).unwrap();
    }
    let mut settings=c.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.allow_images=true;settings.model="synthetic".into();c.save_settings(settings).unwrap();
    let task=agent::start(&mut c,"Automatic visual review","investigate",vec![s.clone()],vec![],0.).unwrap();
    c.set_meta(&format!("automatic_task:{task}"),"true").unwrap();
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert_eq!(request.body["tool_choice"]["name"],"inspect_automatic_video_batch");
    assert_eq!(request.body["tools"].as_array().unwrap().len(),1);
    assert_eq!(agent::execute_tool(&mut c,&task,"inspect_automatic_video_batch",&json!({})).unwrap()["frames"].as_array().unwrap().len(),4);
    let first=evidence_desk::automatic::next_visual_batch(&c,&task).unwrap();
    let ids=first.iter().map(|frame|frame["artifact_id"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(ids,vec!["frame-0","frame-20","frame-40","frame-30"]);
    c.db.execute("INSERT INTO actions VALUES('observation',?,'record_visual_observations','{}',?,'complete','now')",rusqlite::params![task,json!({"observations":[{"artifact_id":"frame-0"},{"artifact_id":"frame-30"}]}).to_string()]).unwrap();
    let remaining=evidence_desk::automatic::next_visual_batch(&c,&task).unwrap();
    assert_eq!(remaining.iter().map(|frame|frame["artifact_id"].as_str().unwrap()).collect::<Vec<_>>(),vec!["frame-20","frame-40"]);
    let partial=evidence_desk::automatic::visual_coverage(&c,&task).unwrap();
    assert_eq!(partial["version"],1);assert_eq!(partial["complete"],false);
    assert_eq!(partial["sources"][0]["missing_bins_first_100"],json!([2]));
    c.db.execute("INSERT INTO actions VALUES('observation-2',?,'record_visual_observations','{}',?,'complete','now')",rusqlite::params![task,json!({"observations":[{"artifact_id":"frame-20"},{"artifact_id":"frame-40"}]}).to_string()]).unwrap();
    assert_eq!(evidence_desk::automatic::visual_coverage(&c,&task).unwrap()["complete"],true);
}
#[test]
fn failed_discovery_run_retries_from_published_cursor_without_replaying_chunks() {
    let (_dir,mut c,s)=setup();let queued=discovery::enqueue(&mut c,&s,5.,false).unwrap();
    let run=queued["jobs"][0].as_str().unwrap();
    chunk(&mut c,&s,run,0.,"first chunk",false);
    c.db.execute("UPDATE processing_jobs SET status='failed',error='Synthetic resource failure' WHERE id=?",[run]).unwrap();
    let result=discovery::retry_run(&mut c,run).unwrap();
    assert_eq!(result["next_start"],60.);
    let status:String=c.db.query_row("SELECT status FROM processing_jobs WHERE id=?",[run],|r|r.get(0)).unwrap();
    assert_eq!(status,"queued");
    chunk(&mut c,&s,run,60.,"second chunk",true);
    assert_eq!(discovery::search(&c,&[s.clone()],&["first".into()]).unwrap().len(),1);
    assert_eq!(discovery::search(&c,&[s.clone()],&["second".into()]).unwrap().len(),1);
    assert!(discovery::retry_run(&mut c,run).is_err());
}
#[test]
fn transient_resource_failure_retries_twice_then_stays_visible() {
    let (_dir,mut c,s)=setup();let queued=discovery::enqueue(&mut c,&s,5.,false).unwrap();
    let run=queued["jobs"][0].as_str().unwrap();
    c.db.execute("UPDATE processing_jobs SET status='complete' WHERE kind='video_overview_index'",[]).unwrap();
    for attempt in 1..=3 {
        let job=discovery::next(&mut c).unwrap().unwrap();
        assert_eq!(job.run_id,run);
        discovery::publish(&mut c,&job,Err(anyhow::anyhow!("Synthetic resource exhaustion (os error 1450)"))).unwrap();
        let (status,raw):(String,String)=c.db.query_row("SELECT status,result FROM processing_jobs WHERE id=?",[run],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let state:Value=serde_json::from_str(&raw).unwrap();
        assert_eq!(state["next_start"],0.);
        assert!(state["resource_diagnostics"].is_object());
        if attempt<3 {
            assert_eq!(status,"queued");assert_eq!(state["resource_retries"],attempt);
            let mut ready=state;ready["retry_after_epoch"]=json!(0);
            c.db.execute("UPDATE processing_jobs SET result=? WHERE id=?",rusqlite::params![ready.to_string(),run]).unwrap();
        } else {assert_eq!(status,"failed");}
    }
}
#[test]
fn agent_search_includes_video_text_and_keeps_scoping() {
    let (_dir,mut c,s)=setup();let jobs=discovery::enqueue(&mut c,&s,5.,false).unwrap();chunk(&mut c,&s,jobs["jobs"][0].as_str().unwrap(),0.,"EXIT",true);
    let mut settings=c.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.model="synthetic".into();c.save_settings(settings).unwrap();
    let task=agent::start(&mut c,"Find visible exit sign","ask",vec![s],vec![],0.).unwrap();
    let result=agent::execute_tool(&mut c,&task,"search_passages",&json!({"terms":["exit"],"offset":0})).unwrap();
    assert_eq!(result["matches"][0]["type"],"video_text");assert!(result["matches"][0]["locator"].as_str().unwrap().contains("#artifact:"));
}

#[test]
#[ignore = "Requires packaged discovery worker and fixtures/generated/variable-timing.mp4"]
fn packaged_video_indexes_publish_frames_without_overwriting_transcript() {
    let dir=tempfile::tempdir().unwrap();let mut c=Case::create(&dir.path().join("case"),"Native discovery").unwrap();
    let file=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
    c.import_files(&[file.to_string_lossy().into_owned()],"fixture").unwrap();let s=c.sources().unwrap()[0].id.clone();
    c.db.execute("INSERT INTO extracts(source_id,text,method) VALUES(?,'original transcript','fixture')",[&s]).unwrap();
    discovery::enqueue(&mut c,&s,1.,false).unwrap();
    for _ in 0..20 {
        let Some(job)=discovery::next(&mut c).unwrap() else{break};
        let result=evidence_desk::processing::run_prepared(&job.processor);
        discovery::publish(&mut c,&job,result).unwrap();
    }
    let status=discovery::status(&c,&s).unwrap();assert!(status["jobs"].as_array().unwrap().iter().all(|j|j["status"]=="complete"),"{status}");
    for kind in ["video_ocr","video_overview"] {
        let page=discovery::browse(&c,&s,kind,0.,1000.,0,"").unwrap();
        let sample=&page["samples"][0];assert!(sample["artifact_id"].is_string(),"{page}");
        assert!(sample["metadata"]["pts"].is_number());assert_eq!(sample["metadata"]["discovery_only"],true);
        let (_,mime,_,_)=evidence_desk::processing::artifact(&c,sample["artifact_id"].as_str().unwrap()).unwrap();assert_eq!(mime,"image/jpeg");
    }
    let text:String=c.db.query_row("SELECT text FROM extracts WHERE source_id=?",[&s],|r|r.get(0)).unwrap();assert_eq!(text,"original transcript");
}

#[test]
fn speaker_corrections_are_versioned_and_do_not_change_machine_artifact() {
    let (dir,mut c,s)=setup();let artifact=evidence_desk::case::id();let content=json!({"metadata":{"turns":[{"start":0.,"end":2.,"speaker":"voice_1"},{"start":1.,"end":3.,"speaker":"voice_2"}]}}).to_string();
    let hash=evidence_desk::case::digest(content.as_bytes());let path=format!("artifacts/{hash}.json");std::fs::write(c.root.join(&path),&content).unwrap();
    c.db.execute("INSERT INTO artifacts VALUES(?,?,?,'application/json',?,?,?)",rusqlite::params![artifact,s,hash,path,"{\"kind\":\"diarization\"}","now"]).unwrap();
    let labels=json!({"voice_1":"Interviewer"});let turns=json!({"0":["voice_1","voice_2"],"1":[]});
    let saved=evidence_desk::speaker_annotations::save(&mut c,&s,&artifact,0,&labels,&turns).unwrap();assert_eq!(saved["identity_verified"],false);
    assert!(evidence_desk::speaker_annotations::save(&mut c,&s,&artifact,0,&labels,&turns).is_err());
    assert!(evidence_desk::speaker_annotations::save(&mut c,&s,&artifact,1,&labels,&json!({"0":["nonexistent"]})).is_err());
    drop(c);let c=Case::open(&dir.path().join("case")).unwrap();let saved=evidence_desk::speaker_annotations::read(&c,&s,&artifact).unwrap();assert_eq!(saved["revision"],1);assert_eq!(saved["turns"]["0"].as_array().unwrap().len(),2);
    assert_eq!(std::fs::read_to_string(c.root.join(path)).unwrap(),content);
}
