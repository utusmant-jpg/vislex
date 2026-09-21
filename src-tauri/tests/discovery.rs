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
fn pending_discovery_does_not_block_review_or_restart_completed_review() {
    let (_dir,mut c,s)=setup();discovery::enqueue(&mut c,&s,5.,false).unwrap();
    c.db.execute("INSERT INTO extracts(source_id,text,method) VALUES(?,'prepared','fixture')",[&s]).unwrap();
    let mut settings=c.settings().unwrap();settings.offline=false;settings.allow_text=true;settings.model="synthetic".into();c.save_settings(settings).unwrap();
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    c.db.execute("UPDATE tasks SET status='complete' WHERE id=?",[&task]).unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
    let tools=agent::tools("ask");assert!(tools.iter().any(|t|t["name"]=="browse_video_overview"));
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
