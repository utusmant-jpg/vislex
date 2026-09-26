use evidence_desk::{
    agent, backup,
    case::{Case, Settings},
};
use serde_json::json;
use std::fs;

fn setup() -> (tempfile::TempDir, Case, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("test.ledcase"), "Synthetic case").unwrap();
    let source = dir.path().join("witness.txt");
    fs::write(
        &source,
        "A witness reported a blue bag.\nThe clock is uncertain.\n",
    )
    .unwrap();
    case.import_files(&[source.to_string_lossy().into()], "Production A")
        .unwrap();
    let sid = case.sources().unwrap()[0].id.clone();
    (dir, case, sid)
}
fn enable(case: &mut Case) {
    case.save_settings(Settings {
        offline: false,
        allow_text: true,
        allow_images: false,
        model: "test-model".into(),
    })
    .unwrap();
}

#[test]
fn import_deduplicates_bytes_but_preserves_occurrences() {
    let (dir, mut c, s) = setup();
    let p = dir.path().join("copy.txt");
    fs::write(
        &p,
        "A witness reported a blue bag.\nThe clock is uncertain.\n",
    )
    .unwrap();
    c.import_files(&[p.to_string_lossy().into()], "Production B")
        .unwrap();
    assert_eq!(c.sources().unwrap().len(), 1);
    assert_eq!(c.source(&s).unwrap().occurrences, 2);
    assert_eq!(c.generation().unwrap(), 1);
    c.verify_source(&s).unwrap();
    assert_eq!(
        c.search("blue", 0).unwrap()["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn failed_import_is_accounted_for() {
    let (dir, mut c, _) = setup();
    let receipt = c
        .import_files(
            &[dir.path().join("missing.txt").to_string_lossy().into()],
            "A",
        )
        .unwrap();
    assert_eq!(receipt["items"][0]["status"], "failed");
    assert_eq!(
        c.db.query_row(
            "SELECT count(*) FROM imports WHERE status='failed'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn case_lock_prevents_concurrent_editor() {
    let (_dir, c, _) = setup();
    assert!(Case::open(&c.root).is_err());
}
#[test]
fn citations_validate_exact_bounds() {
    let (_dir, c, s) = setup();
    c.validate_citation(&format!("evidence:{s}#L1-L2")).unwrap();
    assert!(c.validate_citation(&format!("evidence:{s}#L1-L3")).is_err());
    assert!(c.validate_citation(&format!("evidence:{s}#image")).is_err());
    assert!(c.validate_citation("file:///etc/passwd").is_err());
}
#[test]
fn edits_are_versioned_conflict_checked_and_review_does_not_transfer() {
    let (_dir, mut c, s) = setup();
    let r = c
        .write_record(
            None,
            0,
            "Notes",
            "note",
            "first",
            "human",
            "initial",
            None,
            vec![s],
        )
        .unwrap();
    c.review_record(&r.id, 1, None).unwrap();
    let r2 = c
        .write_record(
            Some(&r.id),
            1,
            "Notes",
            "note",
            "second",
            "agent",
            "recheck",
            None,
            vec![],
        )
        .unwrap();
    assert_eq!(r2.review, "unreviewed");
    assert!(c
        .write_record(
            Some(&r.id),
            1,
            "Notes",
            "note",
            "lost update",
            "human",
            "old",
            None,
            vec![]
        )
        .is_err());
    let history = c.revisions(&r.id).unwrap();
    assert_eq!(history[1]["review"], "human-reviewed");
    let restored = c.rollback(&r.id, 1, 2).unwrap();
    assert_eq!(restored.content, "first");
    assert_eq!(restored.revision, 3);
}
#[test]
fn protected_records_reject_agent_edits() {
    let (_dir, mut c, _) = setup();
    let r = c
        .write_record(
            None,
            0,
            "Notes",
            "note",
            "private",
            "human",
            "initial",
            None,
            vec![],
        )
        .unwrap();
    c.review_record(&r.id, 1, Some(true)).unwrap();
    assert!(c
        .write_record(
            Some(&r.id),
            1,
            "Notes",
            "note",
            "changed",
            "agent",
            "edit",
            None,
            vec![]
        )
        .is_err());
}
#[test]
fn new_import_marks_outputs_stale() {
    let (dir, mut c, _) = setup();
    let r = c
        .write_record(
            None,
            0,
            "Chronology",
            "report",
            "all evidence",
            "human",
            "initial",
            None,
            vec![],
        )
        .unwrap();
    let p = dir.path().join("new.txt");
    fs::write(&p, "contrary material").unwrap();
    c.import_files(&[p.to_string_lossy().into()], "New production")
        .unwrap();
    assert!(c.record(&r.id).unwrap().stale);
}
#[test]
fn agent_is_scoped_and_ask_is_read_only() {
    let (_dir, mut c, s) = setup();
    enable(&mut c);
    let task = agent::start(
        &mut c,
        "What is reported?",
        "ask",
        vec![s.clone()],
        vec![],
        1.,
    )
    .unwrap();
    assert!(agent::execute_tool(
        &mut c,
        &task,
        "read_text",
        &json!({"source_id":"outside","start":1,"count":1})
    )
    .is_err());
    assert!(agent::execute_tool(&mut c, &task, "write_record", &json!({})).is_err());
    assert!(agent::execute_tool(&mut c, &task, "shell", &json!({"command":"anything"})).is_err());
    assert!(agent::execute_tool(
        &mut c,
        &task,
        "read_text",
        &json!({"source_id":s,"start":1,"count":1})
    )
    .is_ok());
}
#[test]
fn offline_blocks_network_preparation_and_revoked_permissions() {
    let (_dir, mut c, s) = setup();
    assert!(agent::start(&mut c, "question", "ask", vec![s.clone()], vec![], 1.).is_err());
    enable(&mut c);
    let task = agent::start(&mut c, "question", "ask", vec![s.clone()], vec![], 1.).unwrap();
    c.set_restricted(&s, true).unwrap();
    assert!(agent::prepare_request(&mut c, &task).is_err());
}
#[test]
fn legacy_caps_and_step_count_do_not_block_enabled_agent() {
    let (_dir, mut c, s) = setup();
    enable(&mut c);
    let task = agent::start(&mut c, "question", "ask", vec![s], vec![], 0.).unwrap();
    c.db.execute("UPDATE tasks SET step=25,reserved=999999 WHERE id=?", [&task]).unwrap();
    let request = agent::prepare_request(&mut c, &task).unwrap();
    assert_eq!(request.body["store"], false);
    assert_eq!(c.db.query_row("SELECT reserved FROM transmissions WHERE id=?",[&request.transmission],|r|r.get::<_,f64>(0)).unwrap(),0.0);
    let view=c.snapshot().unwrap();
    assert!(view["settings"].get("case_budget").is_none());
    assert!(view.get("budget_committed").is_none());
    assert!(view["tasks"][0].get("reserved").is_none());
    assert_eq!(c.db.query_row("SELECT count(*) FROM transmissions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    let metrics:String=c.db.query_row("SELECT data FROM audit WHERE event='agent_request_size'",[],|r|r.get(0)).unwrap();
    let metrics:serde_json::Value=serde_json::from_str(&metrics).unwrap();
    assert!(metrics["input_json_bytes"].as_u64().unwrap()>0);
    assert!(metrics["tool_schema_bytes"].as_u64().unwrap()>0);
    assert!(metrics["wire_json_bytes"].as_u64().unwrap()>=metrics["input_json_bytes"].as_u64().unwrap());
    assert!(!metrics.to_string().contains("question"),"Request-size audit must not contain client text");
}

#[test]
fn historical_price_settings_are_ignored_when_a_case_is_reopened() {
    let (_dir,mut c,_)=setup();
    c.set_meta("settings",&json!({"offline":false,"allow_text":true,"allow_images":false,"model":"test-model","case_budget":500.0,"input_per_million":40.0,"output_per_million":80.0}).to_string()).unwrap();
    let settings=c.settings().unwrap();
    assert_eq!(settings.model,"test-model");
    assert!(serde_json::to_value(&settings).unwrap().get("case_budget").is_none());
    c.save_settings(settings).unwrap();
    assert!(!c.meta("settings").unwrap().unwrap().contains("per_million"));
}
#[test]
fn actual_agent_tool_response_writes_once_and_checkpoints() {
    let (_dir, mut c, s) = setup();
    enable(&mut c);
    let task = agent::start(
        &mut c,
        "Write notes",
        "investigate",
        vec![s.clone()],
        vec![],
        1.,
    )
    .unwrap();
    let request = agent::prepare_request(&mut c, &task).unwrap();
    let response = json!({"status":"completed","usage":{"input_tokens":100,"output_tokens":100},"output":[{"type":"function_call","call_id":"call_1","name":"write_record","arguments":json!({"record_id":null,"base_revision":0,"title":"Findings","kind":"note","content":"An attributed report, not verification.","reason":"Record finding","source_ids":[s]}).to_string()}]});
    assert!(agent::receive(&mut c, &task, &request.transmission, response.clone()).unwrap());
    assert!(agent::receive(&mut c, &task, &request.transmission, response).is_err());
    assert_eq!(c.records().unwrap().len(), 1);
    assert_eq!(c.records().unwrap()[0].actor, "agent");
    assert_eq!(c.actions(&task).unwrap()[0]["status"], "complete");
}
#[test]
fn encrypted_backup_roundtrips_and_wrong_password_fails() {
    let (dir, mut c, s) = setup();
    let r = c
        .write_record(
            None,
            0,
            "Memo",
            "note",
            "Review needed",
            "human",
            "initial",
            None,
            vec![s.clone()],
        )
        .unwrap();
    let destination = dir.path().join("backup.age");
    backup::backup(&mut c, &destination, "test-only-passphrase-long").unwrap();
    let bytes = fs::read(&destination).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("Review needed"));
    assert!(backup::restore(
        &destination,
        &dir.path().join("wrong"),
        "incorrect-passphrase"
    )
    .is_err());
    let restored = backup::restore(
        &destination,
        &dir.path().join("restored"),
        "test-only-passphrase-long",
    )
    .unwrap();
    assert_eq!(restored.record(&r.id).unwrap().content, "Review needed");
    restored.verify_source(&s).unwrap();
    restored.verify_audit().unwrap();
}
#[test]
fn audit_tampering_is_detected() {
    let (_dir, mut c, _) = setup();
    c.audit("test", json!({"value":1})).unwrap();
    c.db.execute("UPDATE audit SET data='tampered' WHERE seq=1", [])
        .unwrap();
    assert!(c.verify_audit().is_err());
}
#[test]
fn restricted_dependencies_block_draft_export() {
    let (dir, mut c, s) = setup();
    let r = c
        .write_record(
            None,
            0,
            "Memo",
            "note",
            "restricted info",
            "human",
            "initial",
            None,
            vec![s.clone()],
        )
        .unwrap();
    c.set_restricted(&s, true).unwrap();
    assert!(c.export_record(&r.id, &dir.path().join("memo.md")).is_err());
}

#[test]
fn record_export_refuses_a_revision_changed_while_choosing_destination() {
    let (dir, mut c, _) = setup();
    let first=c.write_record(None,0,"Memo","note","first","human","initial",None,vec![]).unwrap();
    let next=c.write_record(Some(&first.id),first.revision,"Memo","note","second","human","edit",None,vec![]).unwrap();
    let stale=dir.path().join("stale.md");
    assert!(c.export_record_at_revision(&first.id,first.revision,&stale).is_err());
    assert!(!stale.exists());
    let current=dir.path().join("current.md");
    c.export_record_at_revision(&first.id,next.revision,&current).unwrap();
    assert!(std::fs::read_to_string(current).unwrap().contains("second"));
}

#[test]
fn case_wide_agent_reads_and_edits_existing_records_without_attachments() {
    let (dir, mut case, source) = setup();
    let record = case
        .write_record(
            None,
            0,
            "Available notes",
            "note",
            "Existing working content",
            "human",
            "initial",
            None,
            vec![source.clone()],
        )
        .unwrap();
    let private = dir.path().join("restricted.txt");
    fs::write(&private, "restricted source").unwrap();
    case.import_files(&[private.to_string_lossy().into()], "test")
        .unwrap();
    let restricted = case
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.id != source)
        .unwrap()
        .id;
    let private_record = case
        .write_record(
            None,
            0,
            "Restricted notes",
            "note",
            "private",
            "human",
            "initial",
            None,
            vec![restricted.clone()],
        )
        .unwrap();
    case.set_restricted(&restricted, true).unwrap();
    let (sources, records) = agent::case_scope(&case).unwrap();
    assert!(sources.contains(&source));
    assert!(!sources.contains(&restricted));
    assert!(records.contains(&record.id));
    assert!(!records.contains(&private_record.id));
    enable(&mut case);
    let task = agent::start(
        &mut case,
        "Read and update my working notes",
        "investigate",
        sources,
        records,
        1.0,
    )
    .unwrap();
    let read = agent::execute_tool(
        &mut case,
        &task,
        "read_record",
        &json!({"record_id":record.id,"start":1,"count":10}),
    )
    .unwrap();
    assert_eq!(read["content"], "Existing working content");
    let write=agent::execute_tool(&mut case,&task,"write_record",&json!({"record_id":record.id,"base_revision":record.revision,"title":record.title,"kind":"note","content":"Updated through case-wide tools","reason":"User requested edit","source_ids":[source]})).unwrap();
    assert_eq!(write["revision"], 2);
    assert_eq!(case.record(&record.id).unwrap().actor, "agent");
}

#[test]
fn agent_can_read_new_processor_transcripts_only_for_scoped_sources() {
    let (_dir, mut c, sid) = setup();
    enable(&mut c);
    let task = agent::start(&mut c, "Transcribe and inspect", "investigate", vec![sid.clone()], vec![], 0.).unwrap();
    let r = c.write_record(None,0,"New transcript","transcript","Locally processed speech","processor","processing",None,vec![sid.clone()]).unwrap();
    assert!(agent::execute_tool(&mut c,&task,"read_record",&json!({"record_id":r.id,"start":1,"count":10})).is_ok());
    c.set_restricted(&sid,true).unwrap();
    assert!(agent::execute_tool(&mut c,&task,"read_record",&json!({"record_id":r.id,"start":1,"count":10})).is_err());
}

#[test]
fn passage_search_uses_alternatives_and_searches_saved_records() {
    let (_dir, mut c, sid) = setup(); enable(&mut c);
    let record=c.write_record(None,0,"Camera mapping","note","Candidate Officer Sample at 00:50; needs review.","human","test",None,vec![sid.clone()]).unwrap();
    let task=agent::start(&mut c,"find", "investigate",vec![sid.clone()],vec![record.id],0.).unwrap();
    let result=agent::execute_tool(&mut c,&task,"search_passages",&json!({"terms":["nonexistent","blue","Sample"],"offset":0})).unwrap();
    assert_eq!(result["total"],2);
    assert!(result["matches"].as_array().unwrap().iter().any(|m|m["type"]=="working_record"));
    let source_hit=result["matches"].as_array().unwrap().iter().find(|m|m["type"]=="source_extraction").unwrap();
    let locator=source_hit["locator"].as_str().unwrap();
    assert!(locator.starts_with(&format!("evidence:{sid}#R1L")));
    assert_eq!(c.validate_citation(locator).unwrap()["revision_binding"],"pinned");
    c.set_restricted(&sid,true).unwrap();
    assert_eq!(agent::execute_tool(&mut c,&task,"search_passages",&json!({"terms":["blue","Sample"],"offset":0})).unwrap()["total"],0);
}

#[test]
fn cited_answers_require_review_and_are_saved_for_followups() {
    let (_dir, mut c, sid) = setup(); enable(&mut c);
    let task=agent::start(&mut c,"Review witness", "investigate",vec![sid.clone()],vec![],0.).unwrap();
    let args=json!({"answer":"The witness reports a blue bag.","citations":[format!("evidence:{sid}#L1-L1")],"gaps":["Not independently corroborated."]});
    for (index, expected) in [(0,true),(1,false)] {
        let request=agent::prepare_request(&mut c,&task).unwrap();
        let response=json!({"status":"completed","usage":{"input_tokens":100,"output_tokens":20},"output":[{"type":"function_call","call_id":format!("finish_{index}"),"name":"finish_task","arguments":args.to_string()}]});
        assert_eq!(agent::receive(&mut c,&task,&request.transmission,response).unwrap(),expected);
        if index==0 { assert!(c.records().unwrap().is_empty()); }
    }
    let records=c.records().unwrap();assert_eq!(records.len(),1);assert_eq!(records[0].review,"unreviewed");assert_eq!(records[0].actor,"agent");
    assert!(records[0].content.contains("Not independently corroborated"));
    let snapshot=c.snapshot().unwrap();assert_eq!(snapshot["tasks"][0]["input_tokens"],200);
    let reply=snapshot["tasks"][0]["answer"].as_str().unwrap();
    assert!(reply.contains("The witness reports a blue bag."));
    assert!(!reply.contains("Gaps and limitations")&&!reply.contains("AI-generated")&&!reply.contains("Not independently corroborated"),"Routine review details belong in the saved record, not every chat reply");
}

#[test]
fn snapshot_groups_failed_tools_and_links_discovery_child_to_parent() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Synthetic review","investigate",vec![sid.clone()],vec![],0.).unwrap();
    for index in 0..3 {
        let id=format!("issue-{index}");
        c.db.execute("INSERT INTO actions VALUES(?,?,'save_dossier','{}','{\"error\":\"Invalid check tool\"}','failed',?)",rusqlite::params![id,task,evidence_desk::case::now()]).unwrap();
    }
    c.db.execute("INSERT INTO processing_jobs VALUES('parent',?,'video_ocr_index','failed',?,'resource error',?)",rusqlite::params![sid,json!({"active_job":"child"}).to_string(),evidence_desk::case::now()]).unwrap();
    c.db.execute("INSERT INTO processing_jobs VALUES('child',?,'video_ocr','failed','{}','resource error',?)",rusqlite::params![sid,evidence_desk::case::now()]).unwrap();
    let snapshot=c.snapshot().unwrap();
    assert_eq!(snapshot["issues"].as_array().unwrap().len(),1);
    assert_eq!(snapshot["issues"][0]["count"],3);
    let latest=snapshot["issues"][0]["latest_receipt"].as_str().unwrap();
    assert_eq!(c.issue_history(latest,0).unwrap()["receipts"].as_array().unwrap().len(),3);
    let child=snapshot["jobs"].as_array().unwrap().iter().find(|job|job["id"]=="child").unwrap();
    assert_eq!(child["parent_run_id"],"parent");
    c.db.execute("INSERT INTO processing_jobs VALUES('replacement',?,'video_ocr_index','queued','{}','',?)",rusqlite::params![sid,evidence_desk::case::now()]).unwrap();
    let jobs=c.snapshot().unwrap()["jobs"].as_array().unwrap().clone();
    assert_eq!(jobs.iter().find(|job|job["id"]=="parent").unwrap()["superseded"],true);
    assert_eq!(jobs.iter().find(|job|job["id"]=="child").unwrap()["superseded"],true,"A child of the old index is historical too");
    assert_eq!(jobs.iter().find(|job|job["id"]=="replacement").unwrap()["superseded"],false);
}
#[test]
fn large_snapshot_excludes_full_working_record_bodies() {
    let (_dir,mut c,sid)=setup();
    let tx=c.db.transaction().unwrap();
    for index in 0..500 {
        tx.execute("INSERT INTO records(id,title,kind,content,revision,actor,review,updated_at,dependencies) VALUES(?,?,'note',?,1,'human','unreviewed',?,?)",rusqlite::params![format!("synthetic-record-{index}"),format!("Synthetic record {index}"),"x".repeat(2048),format!("2026-09-22T00:{:02}:{:02}Z",index/60,index%60),json!([sid]).to_string()]).unwrap();
    }
    tx.commit().unwrap();
    let snapshot=c.snapshot().unwrap();
    let bytes=serde_json::to_vec(&snapshot).unwrap().len();
    println!("500 synthetic 2-KiB records snapshot bytes: {bytes}");
    assert!(bytes<256*1024,"Summary should stay under 256 KiB for this synthetic tier");
    assert!(snapshot["records"][0].get("content").is_none(),"Full record text requires explicit detail fetch");
}

#[test]
fn older_visual_inputs_remain_revisitable_without_resending_all_images() {
    let (dir, mut c, _) = setup(); enable(&mut c);
    let image=dir.path().join("image.png");
    fs::write(&image,b"synthetic-image-input").unwrap();
    c.import_files(&[image.to_string_lossy().into()],"synthetic").unwrap();
    let sid=c.sources().unwrap().into_iter().find(|s|s.name=="image.png").unwrap().id;
    let mut settings=c.settings().unwrap();settings.allow_images=true;c.save_settings(settings).unwrap();
    let task=agent::start(&mut c,"inspect","investigate",vec![sid.clone()],vec![],0.).unwrap();
    let mut history:Vec<_>=vec![json!({"role":"user","content":"ANCHOR_TO_EXCLUDE: this must show a door"})];
    history.extend((0..50).map(|_|json!({"type":"local_image","source_id":sid})));
    c.db.execute("UPDATE tasks SET history=? WHERE id=?",rusqlite::params![serde_json::to_string(&history).unwrap(),task]).unwrap();
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert!(!request.body.to_string().contains("ANCHOR_TO_EXCLUDE"));
    assert_eq!(request.body["tool_choice"]["name"],"record_visual_observations");
    let input=request.body["input"].as_array().unwrap();
    assert_eq!(input.iter().filter(|m|m["content"].is_array()).count(),48);
    assert!(input[0]["content"].as_str().unwrap().contains("omitted from this request"));
    let persisted:String=c.db.query_row("SELECT history FROM tasks WHERE id=?",[&task],|r|r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Vec<serde_json::Value>>(&persisted).unwrap().len(),51);
    let response=json!({"status":"completed","usage":{"input_tokens":100,"output_tokens":50},"output":[{"type":"function_call","call_id":"vision_pass","name":"record_visual_observations","arguments":json!({"observations":[{"source_id":sid,"artifact_id":null,"description":"Synthetic observation","visible_text":"","uncertainty":"Test fixture only"}]}).to_string()}]});
    assert!(agent::receive(&mut c,&task,&request.transmission,response).unwrap());
    let next=agent::prepare_request(&mut c,&task).unwrap();
    assert!(next.body["tool_choice"].is_null());
    assert!(!next.body["input"].to_string().contains("data:image"), "Already-described images must not be resent on every text reasoning step");
    assert!(next.body["tools"].as_array().unwrap().iter().any(|t|t["name"]=="search_passages"));

}

#[test]
fn long_investigations_archive_receipts_without_losing_retrieval() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let mut settings=c.settings().unwrap();settings.model="gpt-5.6-luna".into();c.save_settings(settings).unwrap();
    let task=agent::start(&mut c,"long task","investigate",vec![sid],vec![],0.).unwrap();
    let full="evidence detail ".repeat(20000);
    let mut history=vec![json!({"type":"function_call_output","call_id":"old_result","output":full})];
    for i in 0..4 {history.push(json!({"type":"function_call_output","call_id":format!("later_{i}"),"output":"small result"}));}
    c.db.execute("UPDATE tasks SET history=? WHERE id=?",rusqlite::params![serde_json::to_string(&history).unwrap(),task]).unwrap();
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert_eq!(request.body["reasoning"]["effort"],"high");assert_eq!(request.body["max_output_tokens"],16384);
    assert!(request.body["input"][0]["output"].as_str().unwrap().contains("ARCHIVED RESULT, NOT COMPLETE"));
    let recovered=agent::execute_tool(&mut c,&task,"read_tool_result",&json!({"call_id":"old_result","offset":200000,"count":12000})).unwrap();
    assert_eq!(recovered["total_characters"],full.len());assert_eq!(recovered["text"].as_str().unwrap(),&full[200000..212000]);assert_eq!(recovered["next_offset"],212000);
}
#[test]
fn conversation_followups_preserve_prior_turns_and_receipts() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let first=agent::start(&mut c,"Remember our disputed time","investigate",vec![sid.clone()],vec![],0.).unwrap();
    assert_eq!(agent::continue_conversation(&mut c,&first,None).unwrap(),first);
    c.db.execute("UPDATE tasks SET status='complete',answer='First answer' WHERE id=?",[&first]).unwrap();
    let second=agent::start(&mut c,"Why did you say that?","investigate",vec![sid],vec![],0.).unwrap();
    assert_eq!(agent::continue_conversation(&mut c,&second,Some(&first)).unwrap(),first);
    let prepared=agent::prepare_request(&mut c,&second).unwrap();
    let context=prepared.body["input"].to_string();
    assert!(context.contains("Remember our disputed time"));assert!(context.contains("Why did you say that?"));
    let snapshot=c.snapshot().unwrap();
    assert!(snapshot["tasks"].as_array().unwrap().iter().all(|t|t["conversation_id"]==first));
}
#[test]
fn independent_chats_can_run_together_and_followups_use_bounded_continuity() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let first=agent::start(&mut c,"First independent question","investigate",vec![sid.clone()],vec![],0.).unwrap();
    agent::continue_conversation(&mut c,&first,None).unwrap();
    let second=agent::start(&mut c,"Second independent question","investigate",vec![sid.clone()],vec![],0.).unwrap();
    agent::continue_conversation(&mut c,&second,None).unwrap();
    assert_ne!(first,second);
    assert_eq!(c.snapshot().unwrap()["tasks"].as_array().unwrap().iter().filter(|task|task["status"]=="running").count(),2);
    c.db.execute("UPDATE tasks SET status='complete',answer='First cited answer' WHERE id=?",[&first]).unwrap();
    let old_result="repeated extracted text ".repeat(10000);
    c.db.execute("UPDATE tasks SET history=? WHERE id=?",rusqlite::params![json!([{"type":"function_call_output","call_id":"old_call","output":old_result}]).to_string(),first]).unwrap();
    let followup=agent::start(&mut c,"Challenge the first answer","investigate",vec![sid],vec![],0.).unwrap();
    agent::continue_conversation(&mut c,&followup,Some(&first)).unwrap();
    let request=agent::prepare_request(&mut c,&followup).unwrap();
    let wire=request.body["input"].to_string();
    assert!(wire.contains("First cited answer"));
    assert!(!wire.contains("repeated extracted text"));
    assert!(wire.len()<30000);
    let recovered=agent::execute_tool(&mut c,&followup,"read_tool_result",&json!({"call_id":"old_call","offset":0,"count":100})).unwrap();
    assert!(recovered["text"].as_str().unwrap().starts_with("repeated extracted text"));
}
#[test]
fn paused_uncertain_task_continues_without_replaying_old_transmission() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let old=agent::start(&mut c,"Inspect the claim","investigate",vec![sid],vec![],0.).unwrap();
    let conversation=agent::continue_conversation(&mut c,&old,None).unwrap();
    assert!(deliver_tool(&mut c,&old,"checkpoint_review",json!({"summary":"Saved partial finding","citations":[],"gaps":["Check the original"],"next_steps":[]})));
    c.db.execute("UPDATE transmissions SET status='uncertain' WHERE task_id=?",[&old]).unwrap();
    agent::pause(&mut c,&old,"Provider response incomplete").unwrap();
    assert!(agent::resume(&mut c,&old).is_err());
    let (new,continued)=agent::continue_paused(&mut c,&old).unwrap();
    assert_eq!(continued,conversation);assert_ne!(new,old);
    assert_eq!(c.db.query_row("SELECT count(*) FROM transmissions WHERE task_id=?",[&new],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(c.db.query_row("SELECT status FROM transmissions WHERE task_id=?",[&old],|r|r.get::<_,String>(0)).unwrap(),"uncertain");
    let prepared=agent::prepare_request(&mut c,&new).unwrap();
    assert!(prepared.body["input"].to_string().contains("Saved partial finding"));
}

#[test]
fn continuing_a_deleted_automatic_chat_creates_a_visible_conversation() {
    let (_dir,mut c,_sid)=setup();enable(&mut c);
    let old=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    let conversation=agent::continue_conversation(&mut c,&old,None).unwrap();
    agent::pause(&mut c,&old,"Provider response incomplete").unwrap();
    c.delete_conversation(&conversation,true).unwrap();
    assert!(c.snapshot().unwrap()["tasks"].as_array().unwrap().is_empty());
    let (new,visible)=agent::continue_paused(&mut c,&old).unwrap();
    assert_eq!(visible,new);
    assert_eq!(c.snapshot().unwrap()["tasks"][0]["id"],new);
    assert_eq!(c.meta("auto_review_task").unwrap().as_deref(),Some(new.as_str()));
}
#[test]
fn automatic_continuation_tracks_current_sources_and_keeps_old_delivery_uncertain() {
    let (dir,mut c,_sid)=setup();enable(&mut c);
    let old=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    c.db.execute("INSERT INTO transmissions VALUES('auto-uncertain',?,'hash','test-model','[]',0,0,'uncertain',NULL,'2026-09-21T00:00:00Z')",rusqlite::params![old]).unwrap();
    agent::pause(&mut c,&old,"Provider response incomplete").unwrap();
    let extra=dir.path().join("added.txt");fs::write(&extra,"Synthetic added source").unwrap();
    c.import_files(&[extra.to_string_lossy().into_owned()],"fixture").unwrap();
    let (new,_)=agent::continue_paused(&mut c,&old).unwrap();
    assert_eq!(c.meta("auto_review_task").unwrap().as_deref(),Some(new.as_str()));
    assert_eq!(c.meta(&format!("automatic_task:{new}")).unwrap().as_deref(),Some("true"));
    assert!(c.meta(&format!("auto_review_inventory:{new}")).unwrap().is_some());
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"running");
    let new_scope:String=c.db.query_row("SELECT scope FROM tasks WHERE id=?",[&new],|r|r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&new_scope).unwrap().len(),2);
    assert_eq!(c.db.query_row("SELECT status FROM transmissions WHERE id='auto-uncertain'",[],|r|r.get::<_,String>(0)).unwrap(),"uncertain");
    assert_eq!(c.db.query_row("SELECT count(*) FROM transmissions WHERE task_id=?",[&new],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn chats_wait_for_file_preparation_but_failures_release_the_gate() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    c.db.execute("INSERT INTO processing_jobs VALUES('preparing',?,'auto_prepare','queued','{}','',?)",rusqlite::params![sid,evidence_desk::case::now()]).unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_some());
    c.db.execute("UPDATE processing_jobs SET status='failed',error='Synthetic processor failure' WHERE id='preparing'",[]).unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_none());
    c.db.execute("INSERT INTO processing_jobs VALUES('recovered',?,'auto_prepare','queued','{}','',?)",rusqlite::params![sid,evidence_desk::case::now()]).unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_some(),"Historical failure must not release the gate while its replacement runs");
    c.db.execute("UPDATE processing_jobs SET status='complete' WHERE id='recovered'",[]).unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_none());
    let review=agent::start(&mut c,"Synthetic automatic review","investigate",vec![sid.clone()],vec![],0.).unwrap();
    c.set_meta("auto_review_task",&review).unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_none(),"completed extraction unlocks chat during automatic review");
    agent::pause(&mut c,&review,"Synthetic review error").unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_none());
    c.db.execute("INSERT INTO processing_jobs VALUES('fresh',?,'full_audio','queued','{}','',?)",rusqlite::params![sid,evidence_desk::case::now()]).unwrap();
    assert!(evidence_desk::automatic::chat_pause_reason(&c).unwrap().is_some());
}

#[test]
fn active_review_checkpoint_can_seed_a_followup_until_evidence_changes() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    c.publish_extract(&sid,"A witness reported a blue car.","test",true).unwrap();
    let review=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    let scope=evidence_desk::agent::case_scope(&c).unwrap().0;
    assert!(evidence_desk::automatic::completed_review_context(&c,&scope).unwrap().is_none(),"empty work cannot seed a quick answer");
    let locator=format!("evidence:{sid}#R1L1-L1");
    evidence_desk::review_progress::save(&c,&review,&evidence_desk::review_progress::Progress{
        summary:"The witness report mentions a blue car.".into(),
        citations:vec![locator.clone()],
        gaps:vec!["Video review is pending".into()],
        ..Default::default()
    }).unwrap();
    let context=evidence_desk::automatic::completed_review_context(&c,&scope).unwrap().unwrap();
    assert_eq!(context["state"],"running");
    assert_eq!(context["citations"][0],locator);
    let followup=agent::start(&mut c,"What did the witness report?","investigate",scope.clone(),vec![],0.).unwrap();
    let request=agent::prepare_request(&mut c,&followup).unwrap();
    assert!(request.body["input"].to_string().contains("blue car"));
    assert!(request.body["instructions"].as_str().unwrap().contains("request_more_research"));
    assert_eq!(request.body["tools"].as_array().unwrap().len(),1,"saved progress should use the bounded answer or research path first");
    assert_eq!(request.body["tools"][0]["name"],"request_more_research");
    c.publish_extract(&sid,"A later extraction changed the report.","test",true).unwrap();
    assert!(evidence_desk::automatic::completed_review_context(&c,&scope).unwrap().is_none(),"stale checkpoint cannot seed a quick answer");
}

#[test]
fn large_conversation_keeps_saved_history_and_valid_tool_pairs() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Current request","investigate",vec![sid],vec![],0.).unwrap();
    let mut history=vec![json!({"role":"user","content":"Original question"})];
    for i in 0..90 {history.push(json!({"type":"function_call","call_id":format!("call_{i}"),"name":"read_text","arguments":"{}"}));history.push(json!({"type":"function_call_output","call_id":format!("call_{i}"),"output":"detail ".repeat(600)}));}
    history.push(json!({"role":"user","content":"Continue this same chat"}));
    let raw=serde_json::to_string(&history).unwrap();
    c.db.execute("UPDATE tasks SET history=? WHERE id=?",rusqlite::params![raw,task]).unwrap();
    let request=agent::prepare_request(&mut c,&task).unwrap();
    let input=request.body["input"].as_array().unwrap();assert!(input.len()<history.len());assert!(input.last().unwrap()["content"]=="Continue this same chat");
    for item in input.iter().filter(|v|v["type"]=="function_call_output") {assert!(input.iter().any(|v|v["type"]=="function_call"&&v["call_id"]==item["call_id"]));}
    let persisted:String=c.db.query_row("SELECT history FROM tasks WHERE id=?",[&task],|r|r.get(0)).unwrap();assert_eq!(persisted,raw);
}
#[test]
fn ordinary_conversation_reply_does_not_pause_for_missing_tool_call() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Remember amber notebook","investigate",vec![sid],vec![],0.).unwrap();
    let request=agent::prepare_request(&mut c,&task).unwrap();
    let response=json!({"status":"completed","usage":{"input_tokens":10,"output_tokens":5},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Remembered: amber notebook."}]}]});
    assert!(!agent::receive(&mut c,&task,&request.transmission,response).unwrap());
    let snapshot=c.snapshot().unwrap();assert_eq!(snapshot["tasks"][0]["status"],"complete");assert!(snapshot["tasks"][0]["answer"].as_str().unwrap().contains("amber notebook"));
}
#[test]
#[cfg(windows)]
fn recent_case_accepts_canonical_local_path_but_rejects_unc() {
    let (dir,c,_)=setup();let path=c.root.clone();drop(c);
    assert!(evidence_desk::case::validate_local_root(&path).is_ok());
    let reopened=Case::open(&path).unwrap();drop(reopened);drop(dir);
    assert!(evidence_desk::case::validate_local_root(std::path::Path::new(r"\\server\share\case")).is_err());
    assert!(evidence_desk::case::validate_local_root(std::path::Path::new(r"\\?\UNC\server\share\case")).is_err());
}
#[test]
fn deleting_chat_is_reversible_and_keeps_its_case_records() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Temporary chat","investigate",vec![sid],vec![],0.).unwrap();
    agent::continue_conversation(&mut c,&task,None).unwrap();
    assert!(c.delete_conversation(&task,true).is_err());
    agent::pause(&mut c,&task,"Stopped").unwrap();
    c.delete_conversation(&task,true).unwrap();
    assert!(c.snapshot().unwrap()["tasks"].as_array().unwrap().is_empty());
    let count:i64=c.db.query_row("SELECT count(*) FROM tasks",[],|r|r.get(0)).unwrap();assert_eq!(count,1);
    assert_eq!(c.sources().unwrap().len(),1);
    c.delete_conversation(&task,false).unwrap();assert_eq!(c.snapshot().unwrap()["tasks"][0]["id"],task);
}

#[test]
fn agent_can_open_viewer_but_cannot_expand_source_scope() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Show this file","investigate",vec![sid.clone()],vec![],0.).unwrap();
    let result=agent::execute_tool(&mut c,&task,"open_source",&json!({"source_id":sid,"time_seconds":null,"page":null})).unwrap();
    assert_eq!(result["status"],"opened_in_workspace");assert_eq!(result["inspection_performed"],false);
    assert_eq!(c.snapshot().unwrap()["viewer_request"]["source_id"],sid);
    assert!(agent::execute_tool(&mut c,&task,"open_source",&json!({"source_id":"outside-case","time_seconds":null,"page":null})).is_err());
    assert!(agent::execute_tool(&mut c,&task,"open_source",&json!({"source_id":sid,"time_seconds":5,"page":null})).is_err());
}
#[test]
fn current_view_is_visible_to_agent_without_expanding_scope() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"What is on my right?","investigate",vec![sid.clone()],vec![],0.).unwrap();
    agent::attach_viewer_context(&mut c,&task,&json!({"type":"source","id":sid,"locator":"L1-L2","time_seconds":null})).unwrap();
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert!(request.body["input"].to_string().contains("Workspace view at submission"));
    assert!(request.body["input"].to_string().contains("L1-L2"));
    assert!(agent::attach_viewer_context(&mut c,&task,&json!({"type":"source","id":"different-case"})).is_err());
}

#[test]
fn suppressed_viewer_context_attaches_nothing_to_the_message() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"What is on my right?","investigate",vec![sid.clone()],vec![],0.).unwrap();
    // The frontend "do not attach this file" state sends a null viewer_context.
    agent::attach_viewer_context(&mut c,&task,&serde_json::Value::Null).unwrap();
    let history:String=c.db.query_row("SELECT history FROM tasks WHERE id=?",[&task],|r|r.get(0)).unwrap();
    assert!(!history.contains("Workspace view at submission"));
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert!(!request.body["input"].to_string().contains("Workspace view at submission"));
    // The source remains inside the case's authorized investigation scope.
    let (sources,records)=agent::case_scope(&c).unwrap();
    assert!(sources.contains(&sid)&&records.is_empty());
}


#[test]
fn recursive_import_preserves_nested_occurrences_and_skips_case_internals() {
    let (dir, mut c, _) = setup();
    let folder = dir.path().join("discovery");
    fs::create_dir_all(folder.join("nested/deeper")).unwrap();
    fs::create_dir_all(folder.join("archive.ledcase")).unwrap();
    fs::write(folder.join("nested/deeper/new.txt"), "Nested discovery evidence").unwrap();
    fs::write(folder.join("archive.ledcase/secret.txt"), "Must not import").unwrap();
    let receipt = c.import_folder(&folder, "Recursive production").unwrap();
    assert_eq!(receipt["items"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["skipped"].as_array().unwrap().len(), 1);
    assert_eq!(c.sources().unwrap().len(), 2);
    assert!(c.import_folder(&c.root.clone(), "Bad import").is_err());
}

#[test]
fn renaming_preserves_originals_citations_and_audit() {
    let (_dir, mut c, source) = setup();
    let before = c.source(&source).unwrap();
    c.rename("case", "", "Renamed matter").unwrap();
    c.rename("source", &source, "Witness alias").unwrap();
    let after = c.source(&source).unwrap();
    assert_eq!(before.sha256, after.sha256);
    assert_eq!(before.id, after.id);
    assert_eq!(after.name, "Witness alias.txt");
    c.verify_source(&source).unwrap();
    c.validate_citation(&format!("evidence:{source}#L1-L2")).unwrap();
    c.verify_audit().unwrap();
    assert!(c.rename("case", "", "\n").is_err());
    assert!(c.rename("source", "missing", "Name").is_err());
    enable(&mut c);
    let task=agent::start(&mut c,"Original question","ask",vec![source],vec![],1.).unwrap();
    c.rename("chat", &task, "Useful chat title").unwrap();
    let snapshot=c.snapshot().unwrap();
    assert_eq!(snapshot["tasks"][0]["title"], "Useful chat title");
    assert_eq!(snapshot["tasks"][0]["prompt"], "Original question");
}

#[test]
fn completed_transcript_overrides_stale_video_status_but_missing_record_does_not() {
    let (_dir, mut c, source) = setup();
    let record = c.write_record(None,0,"Machine transcript","transcript","Unreviewed machine text","human","Test transcript",None,vec![source.clone()]).unwrap();
    c.db.execute("UPDATE sources SET kind='video',status='frames decoded · audio unprocessed' WHERE id=?", [&source]).unwrap();
    c.db.execute("INSERT INTO processing_jobs VALUES('test-job',?,'full_audio','complete',?,'','2026-09-20T00:00:00Z')", rusqlite::params![source,json!({"record_id":record.id}).to_string()]).unwrap();
    assert!(c.source(&source).unwrap().status.starts_with("text transcribed"));
    c.db.execute("UPDATE processing_jobs SET result='{}' WHERE id='test-job'", []).unwrap();
    assert!(c.source(&source).unwrap().status.contains("missing"));
}

#[test]
fn streaming_decoder_handles_split_unicode_multiple_events_and_invalid_payloads() {
    let mut stream = agent::ResponseStream::default();
    let event = "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"cité\"}\r\n\r\n";
    let split=event.find('é').unwrap()+1;
    assert!(stream.push(&event.as_bytes()[..split]).unwrap().is_empty());
    let parsed=stream.push(&event.as_bytes()[split..]).unwrap();
    assert_eq!(parsed[0]["delta"], "cité");
    let done=stream.push(b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\ndata: [DONE]\n\n").unwrap();
    assert_eq!(done.len(),1);
    assert_eq!(done[0]["response"]["status"],"completed");
    assert!(stream.push(b"data: {bad}\n").is_err());
}

#[test]
fn staging_cleanup_only_removes_verified_duplicate_import_copies() {
    let (_dir, mut c, source) = setup();
    let duplicate=c.root.join("staging").join(evidence_desk::case::id());
    let unknown=c.root.join("staging").join(evidence_desk::case::id());
    let note=c.root.join("staging/keep.txt");
    fs::copy(c.source_path(&source).unwrap(),&duplicate).unwrap();
    fs::write(&unknown,"Unknown material, retain").unwrap();
    fs::write(&note,"Keep this staging note").unwrap();
    let before=c.storage_usage().unwrap()["staging"].as_u64().unwrap();
    let receipt=c.reclaim_staging().unwrap();
    assert_eq!(receipt["files"].as_array().unwrap().len(),1);
    assert!(!duplicate.exists());
    assert!(unknown.exists()&&note.exists());
    c.verify_source(&source).unwrap();
    c.verify_audit().unwrap();
    assert!(c.storage_usage().unwrap()["staging"].as_u64().unwrap()<before);
    enable(&mut c);
    agent::start(&mut c,"Inspect","ask",vec![source],vec![],1.).unwrap();
    assert!(c.reclaim_staging().is_err());
}


fn deliver_tool(c:&mut Case, task:&str, name:&str, args:serde_json::Value) -> bool {
    let request=agent::prepare_request(c,task).unwrap();
    let response=json!({"status":"completed","usage":{"input_tokens":10,"output_tokens":5},"output":[{"type":"function_call","call_id":evidence_desk::case::id(),"name":name,"arguments":args.to_string()}]});
    agent::receive(c,task,&request.transmission,response).unwrap()
}
#[test]
fn repeated_successful_reads_checkpoint_then_synthesize_instead_of_crashing() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Summarize the witness","investigate",vec![sid.clone()],vec![],0.).unwrap();
    for _ in 0..3 {assert!(deliver_tool(&mut c,&task,"read_text",json!({"source_id":sid,"start":1,"count":200})));}
    assert_eq!(c.snapshot().unwrap()["tasks"][0]["status"],"running");
    assert_eq!(evidence_desk::review_progress::load(&c,&task).unwrap().duplicate_reads,2);
    let checkpoint=json!({"summary":format!("The witness reports a blue bag, not independently corroborated. evidence:{sid}#L1-L1"),"citations":[format!("evidence:{sid}#L1-L1")],"gaps":["No independent corroboration"],"next_steps":["Synthesize supported findings"]});
    assert!(deliver_tool(&mut c,&task,"checkpoint_review",checkpoint.clone()));
    for _ in 0..2 {assert!(deliver_tool(&mut c,&task,"read_text",json!({"source_id":sid,"start":1,"count":100})));}
    assert!(deliver_tool(&mut c,&task,"checkpoint_review",checkpoint));
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert_eq!(request.body["tool_choice"]["name"],"finish_task");
    assert_eq!(request.body["tools"].as_array().unwrap().len(),1);
    let full_schema_bytes=serde_json::to_vec(&agent::tools("investigate")).unwrap().len();
    let forced_schema_bytes=serde_json::to_vec(&request.body["tools"]).unwrap().len();
    assert!(forced_schema_bytes<full_schema_bytes/4);
    println!("full tool schema bytes: {full_schema_bytes}; forced tool schema bytes: {forced_schema_bytes}");
    assert!(request.body["input"].to_string().contains("blue bag"));
    assert!(request.body["input"].to_string().contains("Durable review ledger"));
    let args=json!({"answer":"The witness reports a blue bag.","citations":[format!("evidence:{sid}#L1-L1")],"gaps":["No independent corroboration"]});
    let response=json!({"status":"completed","usage":{},"output":[{"type":"function_call","call_id":"finish-recovered","name":"finish_task","arguments":args.to_string()}]});
    assert!(agent::receive(&mut c,&task,&request.transmission,response).unwrap()); // support review
    assert!(!deliver_tool(&mut c,&task,"finish_task",args));
    assert_eq!(c.snapshot().unwrap()["tasks"][0]["status"],"complete");
}
#[test]
fn two_identical_failed_tools_force_a_qualified_finish() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Summarize available evidence","investigate",vec![sid],vec![],0.).unwrap();
    let invalid=json!({"source_id":"missing-source","start":1,"count":10});
    assert!(deliver_tool(&mut c,&task,"read_text",invalid.clone()));
    assert!(deliver_tool(&mut c,&task,"read_text",invalid));
    let request=agent::prepare_request(&mut c,&task).unwrap();
    assert_eq!(request.body["tool_choice"]["name"],"finish_task");
}
#[test]
fn repeated_final_validation_failure_keeps_saved_partial_visible() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Review the source","investigate",vec![sid],vec![],0.).unwrap();
    assert!(deliver_tool(&mut c,&task,"checkpoint_review",json!({"summary":"A saved partial observation","citations":[],"gaps":["A source remains unverified"],"next_steps":[]})));
    let invalid=json!({"answer":"Unsupported final claim","citations":["evidence:missing#L1-L1"],"gaps":[]});
    for attempt in 0..2 {
        let prepared=agent::prepare_request(&mut c,&task).unwrap();
        let response=json!({"status":"completed","usage":{},"output":[{"type":"function_call","call_id":format!("invalid-final-{attempt}"),"name":"finish_task","arguments":invalid.to_string()}]});
        let received=agent::receive(&mut c,&task,&prepared.transmission,response);
        if attempt==0 {assert!(received.unwrap());} else {assert!(received.is_err());}
    }
    let answer:String=c.db.query_row("SELECT answer FROM tasks WHERE id=?",[&task],|r|r.get(0)).unwrap();
    assert!(answer.contains("A saved partial observation"));
    assert!(answer.contains("A source remains unverified"));
    assert!(!answer.contains("Unsupported final claim"));
}
#[test]
fn durable_ledger_bounds_old_reads_but_keeps_counts_and_recent_receipts() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Review the source","investigate",vec![sid.clone()],vec![],0.).unwrap();
    for index in 1..=30 {
        c.db.execute("INSERT INTO actions VALUES(?,?,?,?,?,'complete',?)",rusqlite::params![
            format!("read-{index}"),task,"read_text",json!({"source_id":sid,"start":index,"count":1}).to_string(),
            json!({"start_line":index,"end_line":index}).to_string(),format!("2026-09-22T00:00:{index:02}Z")
        ]).unwrap();
    }
    let ledger=evidence_desk::review_progress::ledger(&c,&task,&[sid]).unwrap();
    assert_eq!(ledger["sources"][0]["read_count"],30);
    assert_eq!(ledger["sources"][0]["reads"].as_array().unwrap().len(),24);
    assert_eq!(ledger["sources"][0]["reads"][0]["receipt"],"read-7");
    assert_eq!(ledger["sources"][0]["reads"][23]["receipt"],"read-30");
}
#[test]
fn checkpoints_preserve_attribution_and_progress_across_pause_and_reopen() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"review","investigate",vec![sid.clone()],vec![],0.).unwrap();
    deliver_tool(&mut c,&task,"read_text",json!({"source_id":sid,"start":1,"count":2}));
    deliver_tool(&mut c,&task,"checkpoint_review",json!({"summary":format!("Attributed witness claim evidence:{sid}#L1-L1"),"citations":[format!("evidence:{sid}#L1-L1")],"gaps":["Clock not reconciled"],"next_steps":["Check original recording"]}));
    agent::pause(&mut c,&task,"test interruption").unwrap();let root=c.root.clone();drop(c);
    let mut c=Case::open(&root).unwrap();
    assert!(c.snapshot().unwrap()["tasks"][0]["progress"]["summary"].as_str().unwrap().contains("Attributed witness claim"));
    agent::resume(&mut c,&task).unwrap();
    let next=agent::prepare_request(&mut c,&task).unwrap();
    let context=next.body["input"].to_string();assert!(context.contains("Clock not reconciled"));assert!(context.contains("read_text"));
    assert!(context.contains("witness.txt"));
    let invalid=json!({"summary":"Forged citation","citations":["evidence:outside#L1-L1"],"gaps":[],"next_steps":[]});
    assert!(agent::execute_tool(&mut c,&task,"checkpoint_review",&invalid).is_err());
}
#[test]
fn unrelated_changes_do_not_mark_immutable_machine_transcripts_stale() {
    let (dir,mut c,sid)=setup();
    let transcript=c.write_record(None,0,"Transcript","transcript","machine text","processor","test",None,vec![sid.clone()]).unwrap();
    let path=dir.path().join("extra.txt");fs::write(&path,"new source").unwrap();c.import_files(&[path.to_string_lossy().into()],"extra").unwrap();
    assert!(!c.record(&transcript.id).unwrap().stale);
    c.db.execute("UPDATE records SET stale=1 WHERE id=?",[&transcript.id]).unwrap();
    assert!(!c.record(&transcript.id).unwrap().stale); // legacy false-stale rows
    c.write_record(Some(&transcript.id),1,"Edited transcript","transcript","human correction","human","correction",None,vec![sid]).unwrap();
    c.db.execute("UPDATE records SET stale=1 WHERE id=?",[&transcript.id]).unwrap();
    assert!(c.record(&transcript.id).unwrap().stale);
}
#[test]
fn visual_requests_are_steered_to_frames_after_text_retrieval_and_disclose_gaps() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let mut settings=c.settings().unwrap();settings.allow_images=true;c.save_settings(settings).unwrap();
    c.db.execute("UPDATE sources SET kind='video' WHERE id=?",[&sid]).unwrap();
    let task=agent::start(&mut c,"What can you see visually in keyframes?","investigate",vec![sid.clone()],vec![],0.).unwrap();
    for _ in 0..6 {deliver_tool(&mut c,&task,"read_text",json!({"source_id":sid,"start":1,"count":2}));}
    deliver_tool(&mut c,&task,"checkpoint_review",json!({"summary":"Text read; visual question remains unanswered.","citations":[],"gaps":["No frames inspected"],"next_steps":["Inspect relevant frames"]}));
    let next=agent::prepare_request(&mut c,&task).unwrap();assert_eq!(next.body["tool_choice"]["name"],"inspect_video_interval");
    let final_result=agent::execute_tool(&mut c,&task,"finish_task",&json!({"answer":"Only text was available in this diagnostic.","citations":[],"gaps":[]})).unwrap();assert_eq!(final_result["status"],"complete");
    let reply=c.snapshot().unwrap()["tasks"][0]["answer"].as_str().unwrap().to_string();
    assert!(!reply.contains("Gaps and limitations")&&!reply.contains("No frames visually inspected"));
    let completion:serde_json::Value=serde_json::from_str(&c.meta(&format!("completion:{task}")).unwrap().unwrap()).unwrap();
    assert!(completion["gaps"].as_array().unwrap().iter().any(|gap|gap.as_str().unwrap_or("").contains("No frames visually inspected")),"The detailed issue remains available on request");
}

#[test]
fn changing_passage_search_terms_restarts_pagination_instead_of_skipping_matches() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=agent::start(&mut c,"Search","investigate",vec![sid],vec![],0.).unwrap();
    deliver_tool(&mut c,&task,"search_passages",json!({"terms":["blue"],"offset":0}));
    let result=agent::execute_tool(&mut c,&task,"search_passages",&json!({"terms":["clock"],"offset":30})).unwrap();
    assert_eq!(result["effective_offset"],0);
    assert!(!result["matches"].as_array().unwrap().is_empty());
    assert!(result["pagination_notice"].as_str().unwrap().contains("avoid skipping"));
}

#[test]
fn transcript_search_returns_source_citations_and_corrects_record_id_confusion() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let record=c.write_record(None,0,"Full transcript","transcript","[00:02.440] merchandise is unclear","processor","test",None,vec![sid.clone()]).unwrap();
    let locator=format!("evidence:{sid}#L1-L1");
    c.db.execute("INSERT INTO processing_jobs VALUES('citation-job',?,'full_audio','complete',?,'','2026-09-20T00:00:00Z')",rusqlite::params![sid,json!({"record_id":record.id,"locator":locator}).to_string()]).unwrap();
    let task=agent::start(&mut c,"Find merchandise statements","investigate",vec![sid.clone()],vec![],0.).unwrap();
    let results=agent::execute_tool(&mut c,&task,"search_passages",&json!({"terms":["merchandise"]})).unwrap();
    let hit=results["matches"].as_array().unwrap().iter().find(|h|h["record_id"]==record.id).unwrap();
    assert_eq!(hit["locator"],locator);
    assert_eq!(hit["source_names"][0]["filename"],"witness.txt");
    let page=agent::execute_tool(&mut c,&task,"read_record",&json!({"record_id":record.id,"start":1,"count":10})).unwrap();
    assert_eq!(page["source_citations"][0],locator);
    let invalid=agent::execute_tool(&mut c,&task,"checkpoint_review",&json!({"summary":"Uncertain machine statement","citations":[format!("evidence:{}#L1-L1",record.id)],"gaps":[],"next_steps":[]})).unwrap_err().to_string();
    assert!(invalid.contains("WORKING RECORD"));assert!(invalid.contains(&locator));
    agent::execute_tool(&mut c,&task,"checkpoint_review",&json!({"summary":"Uncertain machine statement","citations":[locator],"gaps":["Machine text requires listening verification"],"next_steps":[]})).unwrap();
}

#[test]
fn old_office_inventory_status_no_longer_reports_unsupported() {
    let (_dir,c,s)=setup();
    c.db.execute("UPDATE sources SET name='Notes.docx',kind='other',status='unsupported · preserved' WHERE id=?",[&s]).unwrap();
    assert_eq!(c.source(&s).unwrap().status,"document preview available · extraction pending");
    assert_eq!(c.sources().unwrap()[0].status,c.source(&s).unwrap().status);
}

#[test]
fn case_level_image_grant_gates_pool_profiles_and_blocks_dispatch_after_revoke() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let mut settings=c.settings().unwrap();settings.allow_images=true;c.save_settings(settings).unwrap();
    c.set_meta("ai_config",&serde_json::to_string(&json!({"provider":"openai","execution":"auto","review":"standard","pool":[{"provider":"openai","model":"other-model","allow_text":true,"allow_images":true}]})).unwrap()).unwrap();
    let task=agent::start(&mut c,"visual question","investigate",vec![sid.clone()],vec![],0.).unwrap();
    c.set_meta(&format!("task_profile:{task}"),&serde_json::to_string(&json!({"provider":"openai","model":"other-model","allow_text":true,"allow_images":true})).unwrap()).unwrap();
    assert!(agent::prepare_request(&mut c,&task).is_ok());
    // Revoke the durable case-level image grant while the task exists: the pool
    // profile's own grant must not keep image dispatch alive.
    let mut revoked=c.settings().unwrap();revoked.allow_images=false;c.save_settings(revoked).unwrap();
    let error=match agent::prepare_request(&mut c,&task){Err(e)=>e.to_string(),Ok(_)=>panic!("dispatch unexpectedly allowed")};
    assert!(error.contains("Image transmission is disabled for this case"),"{error}");
}

#[test]
fn revoked_direct_media_permission_blocks_existing_task_dispatch() {
    let (dir,mut c,_text)=setup();enable(&mut c);
    // Direct media dispatch validates the audio MIME type, so use a real WAV source.
    let mut wav:Vec<u8>=Vec::new();
    wav.extend_from_slice(b"RIFF");wav.extend_from_slice(&36u32.to_le_bytes());wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");wav.extend_from_slice(&16u32.to_le_bytes());wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());wav.extend_from_slice(&16000u32.to_le_bytes());wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");wav.extend_from_slice(&0u32.to_le_bytes());
    let wav_path=dir.path().join("recording.wav");
    std::fs::write(&wav_path,&wav).unwrap();
    c.import_files(&[wav_path.to_string_lossy().into()],"media").unwrap();
    let sid=c.sources().unwrap().into_iter().find(|s|s.name=="recording.wav").unwrap().id.clone();
    let mut settings=c.settings().unwrap();settings.model="gemini-2.5-pro".into();c.save_settings(settings).unwrap();
    c.set_meta("ai_config",&serde_json::to_string(&json!({"provider":"gemini","execution":"auto","review":"standard","pool":[]})).unwrap()).unwrap();
    let task=agent::start(&mut c,"listen closely","investigate",vec![sid.clone()],vec![],0.).unwrap();
    let history=json!([{"role":"user","content":"Task"},{"type":"local_media","source_id":sid}]);
    c.db.execute("UPDATE tasks SET history=? WHERE id=?",rusqlite::params![history.to_string(),task]).unwrap();
    c.set_meta("gemini_direct_media","true").unwrap();
    assert!(agent::prepare_request(&mut c,&task).is_ok());
    c.set_meta("gemini_direct_media","false").unwrap();
    let error=match agent::prepare_request(&mut c,&task){Err(e)=>e.to_string(),Ok(_)=>panic!("dispatch unexpectedly allowed")};
    assert!(error.contains("Direct media permission is disabled"),"{error}");
}

#[test]
fn applying_app_defaults_never_silently_enables_direct_media() {
    let (_dir,mut c,_)=setup();enable(&mut c);
    let defaults=json!({"config":{"provider":"openai","execution":"auto","review":"standard","pool":[]},"settings":{"offline":false,"allow_text":true,"allow_images":true,"model":"m","case_budget":0.,"input_per_million":0.,"output_per_million":0.}});
    evidence_desk::providers::apply_app_settings(&mut c,&defaults).unwrap();
    assert_ne!(c.meta("gemini_direct_media").unwrap().as_deref(),Some("true"));
    // The separate explicit opt-in still works.
    c.set_meta("gemini_direct_media","true").unwrap();
    assert_eq!(c.meta("gemini_direct_media").unwrap().as_deref(),Some("true"));
}

#[test]
fn automatic_review_completion_fingerprint_written_only_on_observed_success() {
    let (_dir,mut c,_sid)=setup();enable(&mut c);
    // Dispatching the automatic task must NOT mark the inventory analyzed.
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    assert!(c.meta("auto_review_fingerprint").unwrap().is_none(),"fingerprint written at start");
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"running");
    // Yielded for the user's chat: stays paused, never treated as complete, and
    // nothing is resent while a transmission's delivery is uncertain.
    evidence_desk::automatic::preempt_for_chat(&mut c).unwrap();
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"paused");
    // A user stop (or any other pause reason) must not silently restart either.
    c.db.execute("UPDATE tasks SET error='Stopped by user' WHERE id=?",[&task]).unwrap();
    c.db.execute("INSERT INTO transmissions VALUES('tx-uncertain',?,'hash','test-model','[]',0,0,'uncertain',NULL,'2026-09-21T00:00:00Z')",rusqlite::params![task]).unwrap();
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None,"uncertain transmission blocks silent resume");
    assert_eq!(c.db.query_row("SELECT count(*) FROM tasks",[],|r|r.get::<_,i64>(0)).unwrap(),1,"no duplicate review started");
    // Once the uncertain transmission is resolved, the chat-preempted task
    // resumes; a foreign pause reason still stays down.
    c.db.execute("UPDATE transmissions SET status='confirmed' WHERE id='tx-uncertain'",[]).unwrap();
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None,"non-preemption pause must not auto-resume");
    c.db.execute("UPDATE tasks SET error=? WHERE id=?",[evidence_desk::automatic::CHAT_PREEMPTION,&task]).unwrap();
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),Some(task.clone()));
    // Observed successful completion is what finally writes the fingerprint.
    c.db.execute("UPDATE tasks SET status='complete' WHERE id=?",[&task]).unwrap();
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None);
    assert!(c.meta("auto_review_fingerprint").unwrap().is_some());
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None);
    assert_eq!(c.db.query_row("SELECT count(*) FROM audit WHERE event='automatic_case_review_completed'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"complete");
    let reviewed_ids=evidence_desk::agent::case_scope(&c).unwrap().0;
    assert!(evidence_desk::automatic::completed_review_context(&c,&reviewed_ids).unwrap().is_some());
    c.write_record(None,0,"Own report","note","Saved analysis","agent","automatic output",None,vec![reviewed_ids[0].clone()]).unwrap();
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"complete","The review's own report must not invalidate it");
    c.write_record(None,0,"Late machine transcript","transcript","New synthetic words","processor","late processing",None,vec![reviewed_ids[0].clone()]).unwrap();
    assert!(evidence_desk::automatic::completed_review_context(&c,&reviewed_ids).unwrap().is_none(),"New transcript on the same source must invalidate reusable AI context");
    c.publish_extract(&reviewed_ids[0],"Revised synthetic extraction", "test",true).unwrap();
    assert!(evidence_desk::automatic::completed_review_context(&c,&reviewed_ids).unwrap().is_none(),"Changed extraction must invalidate reusable AI context");
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"planned");
    // New evidence changes the inventory: a fresh review is planned.
    let extra=std::path::PathBuf::from(c.root.parent().unwrap().join("extra.txt"));
    std::fs::write(&extra,"new material").unwrap();
    c.import_files(&[extra.to_string_lossy().into()],"Late").unwrap();
    let changed_ids=evidence_desk::agent::case_scope(&c).unwrap().0;
    assert!(evidence_desk::automatic::completed_review_context(&c,&changed_ids).unwrap().is_none());
    let next=evidence_desk::automatic::start_review(&mut c).unwrap();
    assert!(next.is_some()&&next!=Some(task));
    c.verify_audit().unwrap();
}

#[test]
fn a_new_failed_processing_attempt_invalidates_old_automatic_completion() {
    let (_dir,mut c,sid)=setup();enable(&mut c);
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    c.db.execute("UPDATE tasks SET status='complete' WHERE id=?",[&task]).unwrap();
    evidence_desk::automatic::start_review(&mut c).unwrap();
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"complete");
    c.db.execute("INSERT INTO processing_jobs VALUES(?1,?2,'auto_prepare','failed','{}','Synthetic failure',?3)",rusqlite::params![evidence_desk::case::id(),sid,evidence_desk::case::now()]).unwrap();
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"planned");
    assert!(evidence_desk::automatic::completed_review_context(&c,&[sid]).unwrap().is_none());
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_some());
}

#[test]
fn finished_automatic_task_with_unresolved_checks_stays_partial_and_audits_once() {
    let (_dir,mut c,_sid)=setup();enable(&mut c);
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    c.set_meta(&format!("completion:{task}"),&json!({"outcome":"partial","gaps":["A source remains uninspected"],"review":"AI-generated / not human reviewed"}).to_string()).unwrap();
    c.db.execute("UPDATE tasks SET status='complete' WHERE id=?",[&task]).unwrap();
    for _ in 0..3 {assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None);}
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"partial");
    assert_eq!(c.db.query_row("SELECT count(*) FROM audit WHERE event='automatic_case_review_partial'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(c.db.query_row("SELECT count(*) FROM audit WHERE event='automatic_case_review_completed'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    c.verify_audit().unwrap();
}

#[test]
fn failed_automatic_review_is_not_treated_as_completed_analysis() {
    let (_dir,mut c,_sid)=setup();enable(&mut c);
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    // Simulate the legacy failure shape: task exists but never completed, and an
    // old start-time fingerprint must not suppress a retry.
    c.set_meta("auto_review_fingerprint","stale-legacy-value").unwrap();
    c.db.execute("UPDATE tasks SET status='paused',error='Provider failed' WHERE id=?",[&task]).unwrap();
    c.db.execute("INSERT INTO transmissions VALUES('tx2',?,'h','m','[]',0,0,'uncertain',NULL,'2026-09-21T00:00:00Z')",rusqlite::params![task]).unwrap();
    assert_eq!(evidence_desk::automatic::start_review(&mut c).unwrap(),None);
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["review_state"],"failed");
}

#[test]
fn current_saved_analysis_uses_small_first_reply_and_expands_only_on_request() {
    let (_dir,mut c,_sid)=setup();enable(&mut c);
    let mut settings=c.settings().unwrap();settings.model="gpt-5.6-luna".into();c.save_settings(settings).unwrap();
    let automatic=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    c.db.execute("UPDATE tasks SET status='complete',answer='A witness reported a blue bag.' WHERE id=?",[&automatic]).unwrap();
    evidence_desk::automatic::start_review(&mut c).unwrap();
    let (sources,records)=agent::case_scope(&c).unwrap();
    let task=agent::start(&mut c,"What did the witness report?","investigate",sources.clone(),records.clone(),0.).unwrap();
    let first=agent::prepare_request(&mut c,&task).unwrap();
    assert_eq!(first.body["tools"].as_array().unwrap().len(),1);
    assert_eq!(first.body["tools"][0]["name"],"request_more_research");
    assert_eq!(first.body["model"],"gpt-5.6-luna");
    assert_eq!(first.body["reasoning"]["effort"],"low");
    assert!(!first.body["instructions"].as_str().unwrap().contains("QUESTION DOSSIER"));
    assert!(agent::execute_tool(&mut c,&task,"search_evidence",&json!({"query":"bag","offset":0})).is_err(),"Quick phase must not permit an unadvertised research tool");
    let response=json!({"status":"completed","usage":{"input_tokens":20,"output_tokens":10},"output":[{"type":"function_call","call_id":"research","name":"request_more_research","arguments":"{\"reason\":\"Need the exact source wording\"}"}]});
    assert!(agent::receive(&mut c,&task,&first.transmission,response).unwrap());
    let expanded=agent::prepare_request(&mut c,&task).unwrap();
    assert!(expanded.body["tools"].as_array().unwrap().len()>20);
    assert_eq!(expanded.body["model"],"gpt-5.6-luna");
    assert_eq!(expanded.body["reasoning"]["effort"],"high");
    assert!(expanded.body["instructions"].as_str().unwrap().contains("QUESTION DOSSIER"));
    let quick_bytes=first.body.to_string().len();
    let expanded_bytes=expanded.body.to_string().len();
    eprintln!("saved-analysis first request: {quick_bytes} bytes; expanded research request: {expanded_bytes} bytes");
    assert!(quick_bytes<expanded_bytes,"Saved analysis should not pay the full research request cost");
    let direct=agent::start(&mut c,"Summarize the saved finding","investigate",sources,records,0.).unwrap();
    let quick=agent::prepare_request(&mut c,&direct).unwrap();
    let answer=json!({"status":"completed","usage":{"input_tokens":30,"output_tokens":12},"output":[{"type":"message","content":[{"type":"output_text","text":"The saved analysis says a witness reported a blue bag."}]}]});
    assert!(!agent::receive(&mut c,&direct,&quick.transmission,answer).unwrap());
    assert_eq!(c.db.query_row("SELECT status FROM tasks WHERE id=?",[&direct],|r|r.get::<_,String>(0)).unwrap(),"complete");
    let (sources,records)=agent::case_scope(&c).unwrap();
    let stale=agent::start(&mut c,"Check the wording again","investigate",sources.clone(),records,0.).unwrap();
    c.publish_extract(&sources[0],"Revised synthetic wording", "test",true).unwrap();
    let refreshed=agent::prepare_request(&mut c,&stale).unwrap();
    assert!(refreshed.body["tools"].as_array().unwrap().len()>20,"A new extraction must disable the saved-answer shortcut");
}

/// R04 — only consent-marked app defaults may initialize a new case's AI
/// policy; files written by the pre-consent flow (forced values) are ignored,
/// so no upgrade silently grants online/text/images to new cases.
#[test]
fn unmarked_ai_defaults_are_ignored_and_marked_defaults_apply_exactly() {
    let (_dir, mut c, _s) = setup();
    // Pre-R04 shape: no consent marker (values were forced, never chosen).
    let legacy = serde_json::json!({
        "config": {"provider":"openai","execution":"auto","review":"standard","pool":[]},
        "settings": {"offline":false,"allow_text":true,"allow_images":true,"model":"m","case_budget":0.,"input_per_million":0.,"output_per_million":0.}
    });
    assert!(evidence_desk::providers::parse_ai_defaults(&legacy).unwrap().is_none(),
        "unmarked defaults must not initialize a case");
    // Consent-marked defaults apply exactly as chosen, including refusal to
    // broaden: a deliberately local policy stays local.
    let mut chosen = legacy;
    chosen["consent_version"] = serde_json::json!(2);
    chosen["settings"] = serde_json::json!({"offline":true,"allow_text":false,"allow_images":false,"model":"","case_budget":0.,"input_per_million":0.,"output_per_million":0.});
    let (config, settings) = evidence_desk::providers::parse_ai_defaults(&chosen).unwrap().unwrap();
    assert!(settings.offline && !settings.allow_text && !settings.allow_images);
    assert_eq!(config.review, evidence_desk::providers::Review::Standard);
    evidence_desk::providers::apply_app_settings(&mut c, &serde_json::json!({"config":config,"settings":settings})).unwrap();
    let applied = c.settings().unwrap();
    assert!(applied.offline && !applied.allow_text && !applied.allow_images,
        "the explicitly local policy must be saved, not forced online");
    // A marked file carrying a wrong consent version is refused too.
    let mut wrong = chosen;
    wrong["consent_version"] = serde_json::json!(1);
    assert!(evidence_desk::providers::parse_ai_defaults(&wrong).unwrap().is_none());
}

/// R04 — direct-media consent is a deliberate, audited, revocable per-case
/// decision; revocation blocks future dispatch.
#[test]
fn direct_media_consent_round_trips_revokes_and_audits() {
    let (_dir, mut c, _s) = setup();
    assert!(!evidence_desk::providers::direct_media_enabled(&c));
    evidence_desk::providers::set_direct_media(&mut c, true).unwrap();
    assert!(evidence_desk::providers::direct_media_enabled(&c));
    evidence_desk::providers::set_direct_media(&mut c, false).unwrap();
    assert!(!evidence_desk::providers::direct_media_enabled(&c));
    let audits: i64 = c.db.query_row(
        "SELECT count(*) FROM audit WHERE event='gemini_direct_media_permission'",
        [], |r| r.get(0),
    ).unwrap();
    assert_eq!(audits, 2, "every consent change is audited");
    c.verify_audit().unwrap();
}

/// R04 — the exact case policy (grants, offline state, review mode, direct-media
/// consent) survives encrypted backup and restore byte-for-byte.
#[test]
fn case_grants_and_consents_survive_backup_and_restore_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("policy.ledcase");
    let mut c = Case::create(&root, "Policy case").unwrap();
    let mut granted = c.settings().unwrap();
    granted.offline = false;
    granted.allow_text = true;
    granted.allow_images = false;
    c.save_settings(granted).unwrap();
    evidence_desk::providers::set_direct_media(&mut c, true).unwrap();
    let config = evidence_desk::providers::Config {
        provider: evidence_desk::providers::Provider::Gemini,
        execution: evidence_desk::providers::Execution::Single,
        review: evidence_desk::providers::Review::Challenge,
        pool: vec![],
    };
    let chosen = c.settings().unwrap();
    evidence_desk::providers::apply_app_settings(&mut c, &serde_json::json!({"config":config,"settings":chosen})).unwrap();

    let archive = dir.path().join("policy.age");
    evidence_desk::backup::backup(&mut c, &archive, "policy-pass-123").unwrap();
    drop(c);
    let restored = evidence_desk::backup::restore(&archive, &dir.path().join("restored.ledcase"), "policy-pass-123").unwrap();
    let settings = restored.settings().unwrap();
    assert!(!settings.offline && settings.allow_text && !settings.allow_images, "text-only grant must survive restore exactly");
    assert_eq!(evidence_desk::providers::load(&restored).unwrap().review, evidence_desk::providers::Review::Challenge);
    assert!(evidence_desk::providers::direct_media_enabled(&restored), "explicit direct-media consent must survive restore");
    restored.verify_audit().unwrap();
}

/// R04 — the images-requires-text consent invariant is enforced server-side,
/// not only in the settings dialog.
#[test]
fn image_grant_without_text_grant_is_refused_by_apply_app_settings() {
    let (_dir, mut c, _s) = setup();
    let mut settings = c.settings().unwrap();
    settings.offline = false;
    settings.allow_text = false;
    settings.allow_images = true;
    let error = evidence_desk::providers::apply_app_settings(&mut c, &serde_json::json!({
        "config": {"provider":"openai","execution":"auto","review":"standard","pool":[]},
        "settings": settings
    })).unwrap_err();
    assert!(error.to_string().contains("grant text before images"), "{error}");
    assert!(!c.settings().unwrap().allow_images, "refused policy must not be partially applied");
}

/// R07 — an in-place edit that preserves length AND mtime evades the
/// interactive cache by design (browsing speed), but strong verification
/// catches it; after a strong check the cache holds the truthful bytes.
#[test]
fn strong_verification_rejects_same_size_same_mtime_tampering() {
    let (dir, mut c, s) = setup();
    let evidence = dir.path().join("cache.txt");
    std::fs::write(&evidence, "verified payload bytes").unwrap();
    c.import_files(&[evidence.to_string_lossy().into()], "A").unwrap();
    let original = c.source_path(&s).unwrap();
    // Warm the interactive cache.
    c.verify_source(&s).unwrap();
    // Tamper in place: same length, mtime restored exactly.
    let preserved = filetime::FileTime::from_last_modification_time(&std::fs::metadata(&original).unwrap());
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&original, permissions).unwrap();
    let bytes = std::fs::read(&original).unwrap();
    let mut flipped = bytes.clone();
    flipped[0] ^= 0xFF;
    // pad/trim to identical length, then restore mtime
    flipped.truncate(bytes.len());
    if flipped.len() < bytes.len() { flipped.resize(bytes.len(), b'x'); }
    std::fs::write(&original, &flipped).unwrap();
    filetime::set_file_mtime(&original, preserved).unwrap();
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&original, permissions).unwrap();

    // Interactive browsing stays fast and — documented — does NOT catch this
    // when its cached entry survives (parallel tests may clear the shared
    // cache; the strong check below is the load-bearing assertion).
    let _ = c.verify_source(&s);
    // Strong verification must reject the same-length, same-mtime replacement.
    let error = c.verify_source_strong(&s).unwrap_err();
    assert!(error.to_string().contains("strong integrity check"), "{error}");
    // The strong check refreshed the cache with the truthful bytes, so even the
    // cached path now refuses the tampered original.
    assert!(c.verify_source(&s).is_err());
}

/// R07 — encrypted backup is an exact-snapshot promise: a metadata-preserving
/// tamper must abort the backup even though interactive reads still serve.
#[test]
fn backup_refuses_metadata_preserving_tampering_with_strong_check() {
    let (dir, mut c, s) = setup();
    let archive = dir.path().join("tamper.age");
    let _ = c.verify_source(&s); // warm the interactive cache where it survives
    let original = c.source_path(&s).unwrap();
    let preserved = filetime::FileTime::from_last_modification_time(&std::fs::metadata(&original).unwrap());
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&original, permissions).unwrap();
    let mut bytes = std::fs::read(&original).unwrap();
    bytes[0] ^= 0xFF;
    std::fs::write(&original, &bytes).unwrap();
    filetime::set_file_mtime(&original, preserved).unwrap();
    let error = evidence_desk::backup::backup(&mut c, &archive, "tamper-pass-123").unwrap_err();
    assert!(error.to_string().contains("strong integrity check"), "{error}");
    assert!(!archive.exists(), "no archive may be written for tampered originals");
}

/// R07 — opening a case clears the interactive cache, so stale session hashes
/// never outlive the case they were computed in.
#[test]
fn opening_a_case_clears_stale_interactive_hashes() {
    let (dir, mut c, s) = setup();
    let root = c.root.clone();
    let _ = c.verify_source(&s);
    let original = c.source_path(&s).unwrap();
    let preserved = filetime::FileTime::from_last_modification_time(&std::fs::metadata(&original).unwrap());
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&original, permissions).unwrap();
    let mut bytes = std::fs::read(&original).unwrap();
    bytes[0] ^= 0xFF;
    std::fs::write(&original, &bytes).unwrap();
    filetime::set_file_mtime(&original, preserved).unwrap();
    // Cache still trusts the stale entry when nothing else cleared it (other
    // tests open cases in parallel, which clears the shared cache — the final
    // assertion below holds either way).
    let _ = c.verify_source(&s);
    drop(c);
    // ...a fresh session starts clean and catches the change.
    let reopened = Case::open(&root).unwrap();
    assert!(reopened.verify_source(&s).is_err(), "reopened session must not inherit stale interactive hashes");
}

/// R07 — document export preparation is a publication promise and uses strong
/// verification; metadata-preserving tampering blocks it.
#[test]
fn export_preparation_refuses_metadata_preserving_tampering() {
    let (dir, mut c, s) = setup();
    let record = c.write_record(None, 0, "Memo", "note", "depends on source", "human", "initial", None, vec![s.clone()]).unwrap();
    let _ = c.verify_source(&s);
    let original = c.source_path(&s).unwrap();
    let preserved = filetime::FileTime::from_last_modification_time(&std::fs::metadata(&original).unwrap());
    let mut permissions = std::fs::metadata(&original).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&original, permissions).unwrap();
    let mut bytes = std::fs::read(&original).unwrap();
    bytes[0] ^= 0xFF;
    std::fs::write(&original, &bytes).unwrap();
    filetime::set_file_mtime(&original, preserved).unwrap();
    let target = dir.path().join("memo.docx");
    assert!(evidence_desk::exports::prepare_document(&c, &record.id, &target).is_err(),
        "export preparation must strongly verify source bytes");
}

/// R07 — artifact reads are the authority gate for derivatives that leave the
/// case (exports, provider transmission): a metadata-preserving tamper of a
/// registered artifact must be caught by a fresh full-hash check.
#[test]
fn artifact_reads_reject_metadata_preserving_tampering() {
    let (dir, mut c, s) = setup();
    let bytes = b"synthetic-artifact-payload";
    let hash = evidence_desk::case::digest(bytes);
    let relative = format!("artifacts/{hash}.json");
    let target = c.root.join(&relative);
    std::fs::write(&target, bytes).unwrap();
    c.db.execute(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![evidence_desk::case::id(), s, hash, "application/json", relative, "{}", evidence_desk::case::now()],
    ).unwrap();
    // Warm the interactive cache with a legitimate read.
    evidence_desk::processing::artifact(&c, &evidence_desk::case::id()).ok();
    let artifact_id: String = c.db.query_row("SELECT id FROM artifacts WHERE sha256=?", [&hash], |r| r.get(0)).unwrap();
    let _ = evidence_desk::processing::artifact(&c, &artifact_id).unwrap();
    // Tamper in place with preserved length and mtime.
    let preserved = filetime::FileTime::from_last_modification_time(&std::fs::metadata(&target).unwrap());
    let mut flipped = bytes.to_vec();
    flipped[0] ^= 0xFF;
    std::fs::write(&target, &flipped).unwrap();
    filetime::set_file_mtime(&target, preserved).unwrap();
    let error = evidence_desk::processing::artifact(&c, &artifact_id).unwrap_err();
    assert!(error.to_string().contains("Artifact integrity check failed"), "{error}");
}

/// Case deletion is the one operation that destroys originals, so it must fail
/// closed on every gate: live case lock, exact typed confirmation, non-case
/// folders. Read-only preserved originals must not block the final removal.
#[test]
fn delete_case_requires_free_lock_exact_confirmation_and_removes_everything() {
    let (dir, c, _sid) = setup();
    let root = dir.path().join("test.ledcase");
    assert!(fs::read_dir(root.join("originals")).unwrap().next().is_some());
    let name = c.meta("name").unwrap().unwrap();
    // Open in this instance: the exclusive lock is held, so even a correct
    // confirmation is refused and nothing is removed.
    let error = evidence_desk::case::delete_case(&root, &name).unwrap_err().to_string();
    assert!(error.contains("another window"), "unexpected error: {error}");
    assert!(root.join("case.sqlite3").is_file());
    // Closed case, wrong confirmation: refused, still nothing removed.
    drop(c);
    let error = evidence_desk::case::delete_case(&root, "Synthetic Cas").unwrap_err().to_string();
    assert!(error.contains("case name"), "unexpected error: {error}");
    assert!(root.join("case.sqlite3").is_file());
    let receipt = evidence_desk::case::delete_case(&root, &name).unwrap();
    assert_eq!(receipt["deleted"], json!(true));
    assert_eq!(receipt["name"], json!("Synthetic case"));
    assert_eq!(receipt["sources"], json!(1));
    assert_eq!(receipt["records"], json!(0));
    assert!(receipt["bytes"].as_u64().unwrap() > 0);
    assert!(!root.exists());
}

#[test]
fn delete_case_refuses_folders_that_are_not_cases() {
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join("not-a-case");
    fs::create_dir_all(&plain).unwrap();
    assert!(evidence_desk::case::delete_case(&plain, "anything").is_err());
    assert!(plain.exists());
    assert!(evidence_desk::case::delete_case(&dir.path().join("missing"), "anything").is_err());
}
