use evidence_desk::{agent, case::Case, dossier};
use serde_json::{json, Value};
fn setup() -> (tempfile::TempDir, Case, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "Dossier fixtures").unwrap();
    let file = dir.path().join("report.txt");
    std::fs::write(
        &file,
        "The witness reports three knocks.\nThe timing is uncertain.",
    )
    .unwrap();
    case.import_files(&[file.to_string_lossy().into_owned()], "fixture")
        .unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    let mut settings = case.settings().unwrap();
    settings.offline = false;
    settings.allow_text = true;
    settings.model = "synthetic".into();
    case.save_settings(settings).unwrap();
    let task = agent::start(
        &mut case,
        "Compare this account with the evidence",
        "investigate",
        vec![source.clone()],
        vec![],
        0.,
    )
    .unwrap();
    (dir, case, source, task)
}
fn candidate(source: &str) -> Value {
    json!({"answer":"The witness reports three knocks.","citations":[format!("evidence:{source}#L1-L1")],"gaps":[]})
}
fn plan(source: &str) -> Value {
    json!({"revision":0,"scope":"Inspect the witness account; independent recordings are unavailable.","checks":[{"id":"read-report","description":"Read the original account","source_id":source,"tool":"read_text","state":"open","receipts":[],"reason":""}],"claims":[{"proposition":"The witness reports three knocks.","assessment":"supported_within_scope","supporting":[format!("evidence:{source}#L1-L1")],"contrary":[],"uncertainty":"This is an attributed account, not independent proof.","next_check":"Find a recording."}]})
}
#[test]
fn changed_draft_and_evidence_require_new_review() {
    let (_dir, mut c, s, t) = setup();
    let mut a = candidate(&s);
    assert_eq!(
        agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
        "review_required"
    );
    a["answer"] = json!("The witness reports three knocks; the timing is uncertain.");
    assert_eq!(
        agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
        "review_required"
    );
    c.db.execute(
        "UPDATE extracts SET revision=revision+1 WHERE source_id=?",
        [&s],
    )
    .unwrap();
    assert_eq!(
        agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
        "review_required"
    );
    assert_eq!(
        agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
        "complete"
    );
    assert_eq!(
        dossier::view(&c, &t).unwrap()["completion"]["outcome"],
        "unreviewed"
    );
    assert_eq!(dossier::view(&c, &t).unwrap()["completion_stale"], false);
}
#[test]
fn citation_free_completion_is_explicitly_unreviewed() {
    let (_dir, mut c, _s, t) = setup();
    let result = agent::execute_tool(
        &mut c,
        &t,
        "finish_task",
        &json!({"answer":"A definitive claim without evidence","citations":[],"gaps":[]}),
    )
    .unwrap();
    assert_eq!(result["outcome"], "unreviewed");
    let answer: String =
        c.db.query_row("SELECT answer FROM tasks WHERE id=?", [&t], |r| r.get(0))
            .unwrap();
    assert!(answer.contains("does not establish an evidentiary finding"));
    assert!(c.records().unwrap().is_empty());
}
#[test]
fn obligations_require_real_matching_receipts_and_cannot_disappear() {
    let (_dir, mut c, s, t) = setup();
    let mut p = plan(&s);
    dossier::save(&mut c, &t, &p).unwrap();
    p["revision"] = json!(1);
    p["checks"][0]["state"] = json!("done");
    p["checks"][0]["receipts"] = json!(["invented"]);
    assert!(dossier::save(&mut c, &t, &p).is_err());
    p["checks"] = json!([]);
    assert!(dossier::save(&mut c, &t, &p).is_err());
    let view = dossier::view(&c, &t).unwrap();
    assert_eq!(view["dossier"]["revision"], 1);
    assert_eq!(
        dossier::completion(&c, &t, &candidate(&s)).unwrap()["outcome"],
        "partial"
    );
}
#[test]
fn inspected_checks_persist_and_reopen_after_changed_evidence() {
    let (dir, mut c, s, t) = setup();
    let mut p = plan(&s);
    let input = json!({"source_id":s,"start":1,"count":2});
    let output = agent::execute_tool(&mut c, &t, "read_text", &input).unwrap();
    c.db.execute("INSERT INTO actions(id,task_id,name,input,output,status,created_at) VALUES('receipt',?,'read_text',?,?,'complete','now')",rusqlite::params![t,input.to_string(),output.to_string()]).unwrap();
    p["checks"][0]["state"] = json!("done");
    p["checks"][0]["receipts"] = json!(["receipt"]);
    dossier::save(&mut c, &t, &p).unwrap();
    let a = candidate(&s);
    assert_eq!(
        agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
        "review_required"
    );
    dossier::review_candidate(&mut c,&t,&json!({"revision":1,"candidate":a,"assessments":[{"claim_index":0,"state":"supported","reason":"The cited first line attributes the statement to the witness."}]})).unwrap();
    assert_eq!(
        dossier::completion(&c, &t, &candidate(&s)).unwrap()["outcome"],
        "declared_checks_complete"
    );
    drop(c);
    let mut c = Case::open(&dir.path().join("case")).unwrap();
    assert_eq!(
        dossier::load(&c, &t).unwrap().unwrap().checks[0].receipts,
        vec!["receipt"]
    );
    let extra = dir.path().join("new.txt");
    std::fs::write(&extra, "A different account").unwrap();
    c.import_files(&[extra.to_string_lossy().into_owned()], "new")
        .unwrap();
    assert_eq!(dossier::view(&c, &t).unwrap()["stale"], true);
    assert_eq!(
        dossier::completion(&c, &t, &candidate(&s)).unwrap()["outcome"],
        "partial"
    );
}
#[test]
fn restricted_sources_cannot_leak_through_dossiers() {
    let (_dir, mut c, s, t) = setup();
    dossier::save(&mut c, &t, &plan(&s)).unwrap();
    c.db.execute("UPDATE sources SET restricted=1 WHERE id=?", [&s])
        .unwrap();
    assert!(dossier::view(&c, &t).is_err());
    let mut p = plan(&s);
    p["revision"] = json!(1);
    assert!(dossier::save(&mut c, &t, &p).is_err());
}
#[test]
fn point_lookup_preserves_inventory_semantics() {
    let (_dir, c, s, _t) = setup();
    assert_eq!(
        serde_json::to_value(c.source(&s).unwrap()).unwrap(),
        serde_json::to_value(&c.sources().unwrap()[0]).unwrap()
    );
    assert!(c.source("absent").is_err());
}
#[test]
fn human_review_is_revision_bound_and_audited() {
    let (_dir, mut c, s, t) = setup();
    let mut p = plan(&s);
    dossier::save(&mut c, &t, &p).unwrap();
    let view =
        dossier::human_review(&mut c, &t, 1, 0, "accepted", "Reviewed the cited account").unwrap();
    assert_eq!(view["human_reviews"][0]["decision"], "accepted");
    assert!(dossier::human_review(&mut c, &t, 0, 0, "accepted", "").is_err());
    p["revision"] = json!(1);
    p["claims"][0]["uncertainty"] = json!("Changed assessment");
    dossier::save(&mut c, &t, &p).unwrap();
    assert!(dossier::view(&c, &t).unwrap()["human_reviews"][0].is_null());
    assert!(c
        .meta(&format!("dossier_review:{t}:1:0"))
        .unwrap()
        .is_some());
    c.verify_audit().unwrap();
}
#[test]
fn completed_checks_cannot_reuse_old_receipts_after_evidence_changes() {
    let (_dir, mut c, s, t) = setup();
    let mut p = plan(&s);
    let input = json!({"source_id":s,"start":1,"count":1});
    c.db.execute("INSERT INTO actions(id,task_id,name,input,output,status,created_at) VALUES('old',?,'read_text',?,'{}','complete','now')",rusqlite::params![t,input.to_string()]).unwrap();
    p["checks"][0]["state"] = json!("done");
    p["checks"][0]["receipts"] = json!(["old"]);
    dossier::save(&mut c, &t, &p).unwrap();
    c.db.execute(
        "UPDATE extracts SET revision=revision+1 WHERE source_id=?",
        [&s],
    )
    .unwrap();
    p["revision"] = json!(1);
    assert!(dossier::save(&mut c, &t, &p).is_err());
    assert!(dossier::human_review(&mut c, &t, 1, 0, "accepted", "").is_err());
}
#[test]
fn dossier_finish_requires_claim_assessments_not_repeated_finish_calls() {
    let (_dir, mut c, s, t) = setup();
    dossier::save(&mut c, &t, &plan(&s)).unwrap();
    let a = candidate(&s);
    for _ in 0..2 {
        assert_eq!(
            agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
            "review_required"
        );
    }
    let review = json!({"revision":1,"candidate":a,"assessments":[{"claim_index":0,"state":"unresolved","reason":"Only the witness account has been inspected."}]});
    dossier::review_candidate(&mut c, &t, &review).unwrap();
    let result = agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap();
    assert_eq!(result["status"], "complete");
    assert_eq!(result["outcome"], "partial");
    assert!(dossier::view(&c, &t).unwrap()["completion"]["gaps"]
        .to_string()
        .contains("unresolved"));
}
#[test]
fn final_publication_failure_rolls_back_report_and_task() {
    let (_dir, mut c, s, t) = setup();
    let a = candidate(&s);
    agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap();
    c.db.execute_batch("CREATE TEMP TRIGGER fail_completion BEFORE UPDATE OF status ON tasks WHEN new.status='complete' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(agent::execute_tool(&mut c, &t, "finish_task", &a).is_err());
    assert!(c.records().unwrap().is_empty());
    assert!(c.meta(&format!("completion:{t}")).unwrap().is_none());
    assert!(c.meta(&format!("completion_record:{t}")).unwrap().is_none());
    let status: String =
        c.db.query_row("SELECT status FROM tasks WHERE id=?", [&t], |r| r.get(0))
            .unwrap();
    assert_eq!(status, "running");
    c.db.execute_batch("DROP TRIGGER fail_completion").unwrap();
    assert_eq!(
        agent::execute_tool(&mut c, &t, "finish_task", &a).unwrap()["status"],
        "complete"
    );
    assert_eq!(c.records().unwrap().len(), 1);
    c.verify_audit().unwrap();
}

#[test]
fn coverage_contract_counts_actual_ranges_and_reopens_after_extraction_changes() {
    let (_dir,mut c,s,t)=setup();
    let args=json!({"revision":0,"mode":"exhaustive","purpose":"Retrieve every extracted report line","requirements":[{"source_id":s,"stage":"text_retrieved","start":1,"end":2}]});
    evidence_desk::coverage::save(&mut c,&t,&args).unwrap();
    assert_eq!(evidence_desk::coverage::gaps(&c,&t).unwrap().len(),1);
    let read=json!({"source_id":s,"start":1,"count":1});
    let result=agent::execute_tool(&mut c,&t,"read_text",&read).unwrap();
    evidence_desk::coverage::observe(&mut c,&t,"r1","read_text",&read,&result).unwrap();
    assert_eq!(evidence_desk::coverage::view(&c,&t).unwrap()["units"][0]["missing"],json!([[2,2]]));
    let read=json!({"source_id":s,"start":2,"count":1});
    let result=agent::execute_tool(&mut c,&t,"read_text",&read).unwrap();
    evidence_desk::coverage::observe(&mut c,&t,"r2","read_text",&read,&result).unwrap();
    assert!(evidence_desk::coverage::gaps(&c,&t).unwrap().is_empty());
    c.db.execute("UPDATE extracts SET revision=revision+1 WHERE source_id=?",[&s]).unwrap();
    assert_eq!(evidence_desk::coverage::gaps(&c,&t).unwrap().len(),1);
    let mut shrink=args.clone();shrink["revision"]=json!(1);shrink["requirements"][0]["end"]=json!(1);
    assert!(evidence_desk::coverage::save(&mut c,&t,&shrink).is_err());
}
#[test]
fn interval_union_preserves_holes_and_does_not_count_duplicates() {
    assert_eq!(evidence_desk::coverage::missing(1,10,vec![(4,6),(1,2),(4,5),(10,12)]),vec![(3,3),(7,9)]);
    assert_eq!(evidence_desk::coverage::missing(1,10,vec![(1,10),(1,10)]),vec![]);
}

#[test]
fn reviewed_offline_package_requires_current_human_acceptance_and_escapes_html() {
    let (dir,mut c,s,t)=setup();let mut p=plan(&s);p["claims"][0]["proposition"]=json!("<script>alert('test')</script> is quoted text");
    dossier::save(&mut c,&t,&p).unwrap();let path=dir.path().join("package");
    assert!(evidence_desk::exports::dossier_bundle(&mut c,&t,&path).is_err());
    assert!(!path.exists());
    dossier::human_review(&mut c,&t,1,0,"accepted","Synthetic review").unwrap();
    evidence_desk::exports::dossier_bundle(&mut c,&t,&path).unwrap();
    let html=std::fs::read_to_string(path.join("index.html")).unwrap();assert!(!html.contains("<script>"));assert!(html.contains("&lt;script&gt;"));
    let manifest:Value=serde_json::from_slice(&std::fs::read(path.join("manifest.json")).unwrap()).unwrap();
    for (name,file) in manifest["files"].as_object().unwrap(){assert_eq!(evidence_desk::case::file_hash(&path.join(name)).unwrap(),file["sha256"].as_str().unwrap());}
    c.set_restricted(&s,true).unwrap();assert!(evidence_desk::exports::dossier_bundle(&mut c,&t,&dir.path().join("blocked")).is_err());
    c.verify_audit().unwrap();
}
#[test]
fn hypotheses_require_evidence_predictions_and_current_dossier_revision() {
    let (_dir,mut c,s,t)=setup();dossier::save(&mut c,&t,&plan(&s)).unwrap();
    let mut args=json!({"dossier_revision":1,"alternatives":[{"explanation":"The account describes a different event","unresolved_premise":"Event attribution","prediction":"An independent recording places it earlier","discriminating_check":"Compare clock anchors","citations":[format!("evidence:{s}#L1-L1")]}]});
    evidence_desk::workbench::hypotheses(&mut c,&t,&args).unwrap();
    assert_eq!(evidence_desk::workbench::view(&c,0).unwrap()["investigations"][0]["hypotheses"]["alternatives"].as_array().unwrap().len(),1);
    args["dossier_revision"]=json!(0);assert!(evidence_desk::workbench::hypotheses(&mut c,&t,&args).is_err());
}
#[test]
fn legal_work_products_require_dates_and_verified_source_scope() {
    let (_dir,mut c,s,t)=setup();
    let mut args=json!({"id":"","base_revision":0,"kind":"issue_matrix","title":"Synthetic issue","jurisdiction":"Ohio","relevant_date":"2026-09-20","items_json":json!([{"question":"What happened?","factual_position":"Unresolved","missing_evidence":"Recording","citations":[format!("evidence:{s}#L1-L1")],"authority_ids":[]}]).to_string()});
    let product=evidence_desk::work_products::save(&mut c,&t,&args).unwrap();assert_eq!(product["kind"],"issue_matrix");
    assert_eq!(product["review"],"unreviewed");
    args["relevant_date"]=json!("unknown");assert!(evidence_desk::work_products::save(&mut c,&t,&args).is_err());
    args["relevant_date"]=json!("2026-09-20");c.set_restricted(&s,true).unwrap();assert!(evidence_desk::work_products::save(&mut c,&t,&args).is_err());
}
#[test]
fn public_authority_adapter_rejects_private_destinations_and_strips_active_html() {
    for url in ["http://www.govinfo.gov/test","https://localhost/test","https://www.govinfo.gov.evil.example/test","https://user:pass@www.govinfo.gov/test","https://127.0.0.1/test"] {assert!(evidence_desk::authority::validate_url(url).is_err());}
    assert!(evidence_desk::authority::validate_url("https://www.govinfo.gov/content/pkg/test/html/test.htm").is_ok());
    let text=evidence_desk::authority::html_text("<h1>Public source</h1><script>malicious()</script><p>Text &amp; detail</p>").unwrap();assert!(!text.contains("malicious"));assert!(text.contains("Text & detail"));
}

#[test]
fn direct_media_is_provider_and_permission_gated() {
    use evidence_desk::providers::{self,Provider};
    let body=json!({"model":"synthetic","instructions":"fixture","input":[{"role":"user","content":[{"type":"input_media","mime_type":"video/mp4","data":"AA=="}]}],"tools":[]});
    assert!(providers::encode(Provider::Openai,&body).is_err());assert!(providers::encode(Provider::Anthropic,&body).is_err());
    let wire=providers::encode(Provider::Gemini,&body).unwrap();assert!(wire.body.to_string().contains("inlineData"));
    let (_dir,mut c,s,t)=setup();assert!(agent::execute_tool(&mut c,&t,"inspect_direct_media",&json!({"source_id":s})).is_err());
}
#[test]
fn truncated_line_receipts_do_not_establish_complete_coverage() {
    let (_dir,mut c,s,t)=setup();let args=json!({"revision":0,"mode":"targeted","purpose":"Inspect long line","requirements":[{"source_id":s,"stage":"text_retrieved","start":1,"end":1}]});
    evidence_desk::coverage::save(&mut c,&t,&args).unwrap();
    evidence_desk::coverage::observe(&mut c,&t,"partial","read_text",&json!({"source_id":s}),&json!({"start":1,"end":1,"truncated_long_lines":true})).unwrap();assert!(!evidence_desk::coverage::gaps(&c,&t).unwrap().is_empty());
}
#[test]
fn accepted_replay_rejects_changed_clock_review_and_extrapolation() {
    use evidence_desk::{evidence::{self,ObjectInput},workbench};
    let (_dir,mut c,s,_t)=setup();
    c.db.execute("UPDATE sources SET kind='video' WHERE id=?",[&s]).unwrap();
    let file=c.root.parent().unwrap().join("second.txt");std::fs::write(&file,"Different synthetic source").unwrap();c.import_files(&[file.to_string_lossy().into_owned()],"fixture").unwrap();let second=c.sources().unwrap().into_iter().find(|v|v.id!=s).unwrap().id;
    c.db.execute("UPDATE sources SET kind='video' WHERE id=?",[&second]).unwrap();
    let mut clocks=vec![];
    for source in [&s,&second] {
        let anchors=json!([{"source_seconds":0.,"incident_seconds":100.,"uncertainty_seconds":0.01,"held_out":false},{"source_seconds":30.,"incident_seconds":130.,"uncertainty_seconds":0.01,"held_out":false},{"source_seconds":15.,"incident_seconds":115.,"uncertainty_seconds":0.01,"held_out":true}]);
        let object=evidence::write(&mut c,ObjectInput{id:None,base_revision:0,kind:"clock".into(),title:"Synthetic clock".into(),content:json!({"clock_domain":"container_relative","anchors":anchors}).to_string(),source_ids:vec![source.clone()],locators:vec![],dependencies:vec![],start_seconds:None,end_seconds:None},"human").unwrap();
        let id=object["id"].as_str().unwrap().to_string();evidence::review(&mut c,&id,1,"accepted").unwrap();clocks.push(id);
    }
    assert_eq!(workbench::replay(&c,&clocks).unwrap()["incident_range"],json!([100.,130.]));
    evidence::review(&mut c,&clocks[0],1,"rejected").unwrap();assert!(workbench::replay(&c,&clocks).is_err());
    assert!(workbench::replay(&c,&[clocks[1].clone(),clocks[1].clone()]).is_err());
}

#[test]
fn inventory_completion_needs_no_content_citation_or_review() {
    let (_dir,mut c,s,t)=setup();
    c.write_record(None,0,"Background transcript","transcript","new text","processor","fixture",None,vec![s]).unwrap();
    let result=agent::execute_tool(&mut c,&t,"finish_inventory",&json!({"include_records":false})).unwrap();
    assert_eq!(result["status"],"complete");
    assert_eq!(result["inventory"]["original_files"],1);
    let answer:String=c.db.query_row("SELECT answer FROM tasks WHERE id=?",[&t],|r|r.get(0)).unwrap();
    assert_eq!(answer,"You have 1 original file in this case.");
    assert!(agent::is_file_count_question("How many files we have?"));
    assert!(!agent::is_file_count_question("How many files prove the suspect entered?"));
}

#[test]
fn authority_publish_ingests_bytes_with_provenance_and_indexing() {
    let dir=tempfile::tempdir().unwrap();
    let mut case=evidence_desk::case::Case::create(&dir.path().join("auth.ledcase"),"Authority case").unwrap();
    case.save_settings(evidence_desk::case::Settings{offline:false,allow_text:false,allow_images:false,model:String::new(),case_budget:0.,input_per_million:0.,output_per_million:0.}).unwrap();
    let html=b"<html><head><style>body{}</style></head><body><p>The record refers to a holding about nominal damages.</p><script>steal()</script></body></html>";
    let download=evidence_desk::authority::Download{url:"https://www.govinfo.gov/content/pkg/test/html/test.htm".into(),bytes:html.to_vec(),mime:"text/html".into(),retrieved_at:"2026-09-21T00:00:00Z".into()};
    let value=evidence_desk::authority::publish(&mut case,download,"Test authority holding","United States","2026-09-01").unwrap();
    let source=value["source_id"].as_str().unwrap().to_string();
    // Bytes preserved and hash-identical to the downloaded original.
    let path=case.source_path(&source).unwrap();
    assert_eq!(sha256_hex_impl(&path),case.source(&source).unwrap().sha256);
    // Fresh HTML authority is indexed and searchable through structural extraction.
    let found=case.search("nominal",0).unwrap();
    assert_eq!(found["results"].as_array().unwrap().len(),1);
    assert!(!case.read_text(&source,1,5).unwrap()["text"].as_str().unwrap().contains("steal()"));
    // Provenance: URL, retrieval time and original hash retained on the authority object.
    let object=evidence_desk::evidence::read(&case,value["authority"]["id"].as_str().unwrap(),None).unwrap();
    let content:serde_json::Value=serde_json::from_str(object["content"].as_str().unwrap()).unwrap();
    assert_eq!(content["url"],"https://www.govinfo.gov/content/pkg/test/html/test.htm");
    assert_eq!(content["retrieved_at"],"2026-09-21T00:00:00Z");
    assert_eq!(content["original_source_id"],source);
    assert_eq!(object["source_ids"][0],source);
    // Importing the case database as user evidence still fails (recorded as a failed item).
    let blocked=case.import_files(&[case.root.join("case.sqlite3").to_string_lossy().into()],"Bad").unwrap();
    assert_eq!(blocked["items"][0]["status"],"failed");
    assert!(blocked["items"][0]["detail"].to_string().contains("case internals"));
}
fn sha256_hex_impl(path:&std::path::Path)->String {
    use sha2::{Digest,Sha256};
    let mut file=std::fs::File::open(path).unwrap();let mut hash=Sha256::new();let mut buffer=[0u8;65536];
    loop{let n=std::io::Read::read(&mut file,&mut buffer).unwrap();if n==0{break;}hash.update(&buffer[..n]);}
    format!("{:x}",hash.finalize())
}

#[test]
fn export_prepared_against_changed_evidence_state_fails_at_publish() {
    let (dir,mut c,s,t)=setup();
    dossier::save(&mut c,&t,&plan(&s)).unwrap();
    dossier::human_review(&mut c,&t,1,0,"accepted","Synthetic review").unwrap();
    let path=dir.path().join("late-evidence");
    let prepared=evidence_desk::exports::prepare_dossier_bundle(&mut c,&t,&path).unwrap();
    // New evidence arrives between prepare and publish: the export must fail,
    // not silently publish a package prepared against the older state.
    let extra=dir.path().join("late.txt");
    std::fs::write(&extra,"contrary late evidence").unwrap();
    c.import_files(&[extra.to_string_lossy().into()],"Late production").unwrap();
    let staged=evidence_desk::exports::write_dossier_bundle(&prepared,&path);
    let error=match evidence_desk::exports::publish_dossier_bundle(&mut c,&prepared,staged,&path){Err(e)=>e.to_string(),Ok(_)=>panic!("stale export unexpectedly published")};
    assert!(error.contains("Evidence changed during export"),"{error}");
    assert!(!path.exists());
    c.verify_audit().unwrap();
}

#[test]
fn export_prepared_against_changed_finding_review_fails_at_publish() {
    let (dir,mut c,s,t)=setup();
    dossier::save(&mut c,&t,&plan(&s)).unwrap();
    dossier::human_review(&mut c,&t,1,0,"accepted","Synthetic review").unwrap();
    let path=dir.path().join("late-review");
    let prepared=evidence_desk::exports::prepare_dossier_bundle(&mut c,&t,&path).unwrap();
    // The human withdraws acceptance while the package is being written.
    dossier::human_review(&mut c,&t,1,0,"needs_review","Reconsidering").unwrap();
    let staged=evidence_desk::exports::write_dossier_bundle(&prepared,&path);
    let error=match evidence_desk::exports::publish_dossier_bundle(&mut c,&prepared,staged,&path){Err(e)=>e.to_string(),Ok(_)=>panic!("withdrawn review unexpectedly published")};
    assert!(error.contains("current human acceptance"),"{error}");
    assert!(!path.exists());
}

#[test]
fn export_prepared_against_older_dossier_revision_fails_at_publish() {
    let (dir,mut c,s,t)=setup();
    dossier::save(&mut c,&t,&plan(&s)).unwrap();
    dossier::human_review(&mut c,&t,1,0,"accepted","Synthetic review").unwrap();
    let path=dir.path().join("late-revision");
    let prepared=evidence_desk::exports::prepare_dossier_bundle(&mut c,&t,&path).unwrap();
    // The dossier itself is revised (new claim) after preparation.
    let mut revised=plan(&s);revised["revision"]=json!(1);
    revised["claims"].as_array_mut().unwrap().push(json!({"proposition":"A second observation.","assessment":"insufficient_evidence","supporting":[],"contrary":[],"uncertainty":"None yet.","next_check":"Inspect more."}));
    dossier::save(&mut c,&t,&revised).unwrap();
    let staged=evidence_desk::exports::write_dossier_bundle(&prepared,&path);
    let error=match evidence_desk::exports::publish_dossier_bundle(&mut c,&prepared,staged,&path){Err(e)=>e.to_string(),Ok(_)=>panic!("older revision unexpectedly published")};
    assert!(error.contains("Dossier changed during export"),"{error}");
    assert!(!path.exists());
}

#[test]
fn document_export_pins_dependency_hashes_until_publication() {
    let (dir,mut c,s,_t)=setup();
    let record=c.write_record(None,0,"Draft memo","report","Draft body","human","initial",None,vec![s.clone()]).unwrap();
    let target=dir.path().join("memo.docx");
    let job=evidence_desk::exports::prepare_document(&c,&record.id,&target).unwrap();
    // A revision lands between preparation and publication.
    c.write_record(Some(&record.id),1,"Draft memo","report","Revised body","human","update",None,vec![s]).unwrap();
    assert!(evidence_desk::exports::publish_document(&mut c,&job).is_err());
    assert!(!target.exists());
    c.verify_audit().unwrap();
}
