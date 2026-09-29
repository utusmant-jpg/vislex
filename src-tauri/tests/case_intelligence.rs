use evidence_desk::{agent, case::Case};
use serde_json::json;
fn setup() -> (tempfile::TempDir, Case, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "Synthetic intelligence").unwrap();
    let file = dir.path().join("report.txt");
    std::fs::write(
        &file,
        "The witness reports three objects.\nA second account reports four.",
    )
    .unwrap();
    case.import_files(&[file.to_string_lossy().into_owned()], "synthetic")
        .unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    let mut settings = case.settings().unwrap();
    settings.offline = false;
    settings.allow_text = true;
    settings.allow_images = true;
    settings.model = "synthetic".into();
    case.save_settings(settings).unwrap();
    let task = agent::start(
        &mut case,
        "Compare the accounts",
        "investigate",
        vec![source.clone()],
        vec![],
        0.,
    )
    .unwrap();
    (dir, case, source, task)
}
#[test]
fn ordinary_chat_never_advertises_automatic_only_batch_on_either_route() {
    let (_dir, mut case, _, task) = setup();
    assert!(!agent::available_tools(&case, &task)
        .unwrap()
        .iter()
        .any(|t| t["name"] == "inspect_automatic_video_batch"));
    case.set_meta(&format!("task_access_route:{task}"), "chatgpt_subscription")
        .unwrap();
    let (_, tools, _) = agent::subscription_context(&mut case, &task).unwrap();
    assert!(!tools
        .iter()
        .any(|t| t["name"] == "inspect_automatic_video_batch"));
    let error = agent::execute_tool(
        &mut case,
        &task,
        "inspect_automatic_video_batch",
        &json!({}),
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("wrong_task_purpose:"), "{error}");
}
#[test]
fn visual_tool_catalogue_tracks_live_case_grants() {
    let (_dir, mut case, _, task) = setup();
    case.set_meta(&format!("automatic_task:{task}"), "true")
        .unwrap();
    assert!(agent::available_tools(&case, &task)
        .unwrap()
        .iter()
        .any(|t| t["name"] == "inspect_automatic_video_batch"));
    let mut settings = case.settings().unwrap();
    settings.allow_images = false;
    case.save_settings(settings).unwrap();
    let tools = agent::available_tools(&case, &task).unwrap();
    for name in [
        "inspect_automatic_video_batch",
        "inspect_artifact_image",
        "inspect_video_interval",
        "inspect_document_pages",
    ] {
        assert!(!tools.iter().any(|t| t["name"] == name), "{name}");
    }
}

#[test]
fn refs_reject_prose_short_ids_wrong_owner_and_restricted_sources() {
    let (_dir, case, source, _task) = setup();
    assert!(
        evidence_desk::intelligence::register_ref(&case, "A report describes four items").is_err()
    );
    assert!(evidence_desk::intelligence::register_ref(
        &case,
        &format!("evidence:{source}#artifact:8cc20a07")
    )
    .is_err());
    let reference =
        evidence_desk::intelligence::register_ref(&case, &format!("evidence:{source}#R1L1-L2"))
            .unwrap();
    assert!(evidence_desk::intelligence::resolve_ref(&case, &reference, &[]).is_err());
    assert_eq!(
        evidence_desk::intelligence::resolve_ref(&case, &reference, &[source.clone()]).unwrap()
            ["source_id"],
        source
    );
    case.db
        .execute("UPDATE sources SET restricted=1 WHERE id=?", [&source])
        .unwrap();
    assert!(evidence_desk::intelligence::resolve_ref(&case, &reference, &[source]).is_err());
}
#[test]
fn candidate_ids_preserve_exact_input_and_cannot_cross_tasks() {
    let (_dir, case, _source, task) = setup();
    let candidate = json!({"answer":"Exact factual wording","citations":[],"gaps":[],"blocks":[]});
    let id =
        evidence_desk::intelligence::save_candidate(&case, &task, "synthetic-stamp", &candidate)
            .unwrap();
    assert_eq!(
        evidence_desk::intelligence::candidate(&case, &task, &id).unwrap(),
        candidate
    );
    assert!(evidence_desk::intelligence::candidate(&case, "another-task", &id).is_err());
    assert_eq!(
        evidence_desk::intelligence::save_candidate(&case, &task, "synthetic-stamp", &candidate)
            .unwrap(),
        id
    );
}
#[test]
fn manifests_are_idempotent_and_own_the_complete_inventory() {
    let (_dir, mut case, source, _task) = setup();
    let run = evidence_desk::intelligence::ensure_run(&mut case, "synthetic-model/high")
        .unwrap()
        .unwrap();
    assert_eq!(
        evidence_desk::intelligence::ensure_run(&mut case, "synthetic-model/high").unwrap(),
        Some(run.clone())
    );
    let count:i64=case.db.query_row("SELECT count(*) FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id=?",rusqlite::params![run,source],|r|r.get(0)).unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["total"],
        3
    );
    case.write_record(
        None,
        0,
        "Own analysis note",
        "note",
        "A saved derived note",
        "agent",
        "synthetic",
        None,
        vec![source],
    )
    .unwrap();
    assert_eq!(
        evidence_desk::intelligence::ensure_run(&mut case, "synthetic-model/high").unwrap(),
        Some(run)
    );
}
fn call(case: &mut Case, task: &str, name: &str, args: serde_json::Value) -> serde_json::Value {
    let request = agent::prepare_request(case, task).unwrap();
    let response = json!({"status":"completed","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"function_call","call_id":evidence_desk::case::id(),"name":name,"arguments":args.to_string()}]});
    agent::receive(case, task, &request.transmission, response).unwrap();
    let actions = case.actions(task).unwrap();
    serde_json::from_str(
        actions.as_array().unwrap().last().unwrap()["output"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}
#[test]
fn unit_requires_real_range_receipt_then_persists_searchable_proof() {
    let (_dir, mut case, source, interactive) = setup();
    agent::pause(&mut case, &interactive, "Stopped by user").unwrap();
    let task = evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
        .unwrap()
        .unwrap();
    let result = call(
        &mut case,
        &task,
        "publish_analysis_unit",
        json!({"receipts":["invented"],"findings":[]}),
    );
    assert!(result["error"].as_str().unwrap().contains("receipt"));
    let inspected = call(
        &mut case,
        &task,
        "read_extract_revision",
        json!({"source_id":source,"revision":1,"start":1,"count":2}),
    );
    let receipt = case
        .actions(&task)
        .unwrap()
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = call(
        &mut case,
        &task,
        "publish_analysis_unit",
        json!({"receipts":[receipt],"findings":[{"kind":"statement","title":"Reported objects","text":"The witness reports three objects.","supporting":[inspected["ref_id"]],"contrary":[],"assessment":"attributed","data":{"object_count":3}}]}),
    );
    assert_eq!(result["status"], "analysis_published", "{result}");
    let published = result["objects"][0].clone();
    let result = call(
        &mut case,
        &task,
        "finish_analysis_unit",
        json!({"reviews":[{"object_id":published["id"],"revision":published["revision"],"state":"supported","reason":"Exact attributed statement is in the immutable source excerpt; the second account is retained."}]}),
    );
    assert_eq!(result["status"], "analysis_unit_complete", "{result}");
    let knowledge =
        evidence_desk::intelligence::query_knowledge(&case, &[source], "objects", 0).unwrap();
    assert_eq!(
        knowledge["items"].as_array().unwrap().len(),
        1,
        "{knowledge}"
    );
    assert_eq!(knowledge["items"][0]["payload"]["data"]["object_count"], 3);
    assert_eq!(knowledge["items"][0]["human_review"], "unreviewed");
}

#[test]
fn legacy_line_ref_is_pinned_and_retains_original_proof_after_new_extraction() {
    let (_dir, mut case, source, _) = setup();
    let reference =
        evidence_desk::intelligence::register_ref(&case, &format!("evidence:{source}#L1-L1"))
            .unwrap();
    case.publish_extract(
        &source,
        "A replacement account reports nine.",
        "Synthetic revision",
        true,
    )
    .unwrap();
    let resolved =
        evidence_desk::intelligence::resolve_ref(&case, &reference, &[source.clone()]).unwrap();
    assert_eq!(resolved["locator"], format!("evidence:{source}#R1L1-L1"));
    assert_eq!(
        resolved["proof"]["text"],
        "The witness reports three objects."
    );
    assert_eq!(resolved["proof"]["historical"], true);
}
fn unit_setup() -> (tempfile::TempDir, Case, String, String) {
    let (dir, mut case, source, interactive) = setup();
    agent::pause(&mut case, &interactive, "Stopped by user").unwrap();
    let task = evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
        .unwrap()
        .unwrap();
    (dir, case, source, task)
}
fn publish_statement(case: &mut Case, task: &str) -> serde_json::Value {
    let read = call(case, task, "read_analysis_unit", json!({}));
    let published = call(
        case,
        task,
        "publish_analysis_unit",
        json!({"receipts":[read["receipt_id"]],"findings":[{"kind":"statement","title":"Reported objects","text":"The witness reports three objects.","supporting":[read["input"]["ref_id"]],"contrary":[],"assessment":"attributed","data_json":"{\"quantity\":3,\"unit\":\"objects\"}"}]}),
    );
    assert_eq!(published["status"], "analysis_published", "{published}");
    published
}
fn review_objects(objects: &serde_json::Value, state: &str) -> serde_json::Value {
    json!({"reviews":objects.as_array().unwrap().iter().map(|object|json!({"object_id":object["id"],"revision":object["revision"],"state":state,"reason":"The immutable first account reports three; the second account reports four."})).collect::<Vec<_>>()})
}
#[test]
fn api_internal_task_cannot_execute_a_hidden_mutation() {
    let (_dir, mut case, source, task) = unit_setup();
    let result = call(
        &mut case,
        &task,
        "write_record",
        json!({"record_id":null,"base_revision":0,"title":"Forbidden","kind":"note","content":"Should not be saved","reason":"Synthetic","source_ids":[source]}),
    );
    assert!(result["error"].as_str().unwrap().contains("not available"));
    assert!(case.records().unwrap().is_empty());
    assert!(!agent::available_tools(&case, &task)
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "finish_task"));
    assert!(case.task_page(None).unwrap()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["id"] != task));
}
#[test]
fn finishing_a_published_unit_rechecks_exact_source_revision() {
    let (_dir, mut case, source, task) = unit_setup();
    let published = publish_statement(&mut case, &task);
    case.publish_extract(
        &source,
        "A replacement reports nine.",
        "Synthetic revision",
        true,
    )
    .unwrap();
    let result = call(
        &mut case,
        &task,
        "finish_analysis_unit",
        review_objects(&published["objects"], "supported"),
    );
    assert!(
        result["error"].as_str().unwrap().contains("input changed"),
        "{result}"
    );
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["state"],
        "stale"
    );
    assert!(
        evidence_desk::intelligence::query_knowledge(&case, &[source], "", 0).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn unresolved_findings_retain_their_exact_support_state() {
    let (_dir, mut case, source, task) = unit_setup();
    let published = publish_statement(&mut case, &task);
    let finished = call(
        &mut case,
        &task,
        "finish_analysis_unit",
        review_objects(&published["objects"], "unresolved"),
    );
    assert_eq!(finished["status"], "analysis_unit_complete");
    let knowledge =
        evidence_desk::intelligence::query_knowledge(&case, &[source], "objects", 0).unwrap();
    assert_eq!(
        knowledge["items"][0]["support_review"]["state"],
        "unresolved"
    );
    assert_eq!(
        knowledge["items"][0]["evidence"][0]["proof"]["text"],
        "The witness reports three objects.\nA second account reports four."
    );
}
#[test]
fn preempted_units_yield_to_chat_and_user_cancellation_stays_stopped() {
    let (_dir, mut case, source, task) = unit_setup();
    agent::pause(&mut case, &task, evidence_desk::automatic::CHAT_PREEMPTION).unwrap();
    let chat = agent::start(
        &mut case,
        "Ask a detail",
        "investigate",
        vec![source],
        vec![],
        0.,
    )
    .unwrap();
    assert!(
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
            .unwrap()
            .is_none()
    );
    let state: String = case
        .db
        .query_row("SELECT status FROM tasks WHERE id=?", [&task], |r| r.get(0))
        .unwrap();
    assert_eq!(state, "paused");
    agent::pause(&mut case, &chat, "Stopped by user").unwrap();
    assert_eq!(
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high").unwrap(),
        Some(task)
    );
    evidence_desk::intelligence::control(&mut case, "cancel").unwrap();
    assert!(
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["state"],
        "cancelled"
    );
}
#[test]
fn candidate_id_review_and_publication_never_reconstructs_the_answer() {
    let (_dir, mut case, source, task) = setup();
    let reference =
        evidence_desk::intelligence::register_ref(&case, &format!("evidence:{source}#R1L1-L1"))
            .unwrap();
    let plan = json!({"revision":0,"scope":"The attributed count","checks":[],"claims":[{"id":"claim-count","proposition":"The witness reports three objects.","assessment":"supported_within_scope","supporting":[reference],"contrary":[],"uncertainty":"An attributed account.","next_check":""}]});
    agent::execute_tool(&mut case, &task, "save_dossier", &plan).unwrap();
    let proposed = json!({"answer":"This free prose must not diverge from the blocks","citations":[reference],"gaps":[],"blocks":[{"id":"answer-count","kind":"attributed_statement","text":"The witness reports three objects.","claims":["claim-count"]}]});
    let submitted = agent::execute_tool(&mut case, &task, "finish_task", &proposed).unwrap();
    assert_eq!(
        submitted["candidate"]["answer"],
        "The witness reports three objects."
    );
    let reviewed=agent::execute_tool(&mut case,&task,"review_saved_candidate",&json!({"revision":1,"candidate_id":submitted["candidate_id"],"assessments":[{"claim_index":0,"state":"supported","reason":"The first immutable source line reports three objects."}],"block_reviews":[{"block_id":"answer-count","state":"supported","reason":"Exact wording restates the attributed count."}]})).unwrap();
    assert!(reviewed["error"].is_null(), "{reviewed}");
    let published = agent::execute_tool(
        &mut case,
        &task,
        "publish_saved_candidate",
        &json!({"candidate_id":submitted["candidate_id"]}),
    )
    .unwrap();
    assert_eq!(published["status"], "complete", "{published}");
    let answer: String = case
        .db
        .query_row("SELECT answer FROM tasks WHERE id=?", [&task], |r| r.get(0))
        .unwrap();
    assert!(answer.starts_with("The witness reports three objects."));
    assert!(!answer.contains("[Attributed statement]"));
}
#[test]
fn backup_and_reopen_preserve_analysis_knowledge_refs_and_hidden_tasks() {
    let (dir, mut case, source, task) = unit_setup();
    let published = publish_statement(&mut case, &task);
    call(
        &mut case,
        &task,
        "finish_analysis_unit",
        review_objects(&published["objects"], "supported"),
    );
    let archive = dir.path().join("analysis.ledbackup");
    evidence_desk::backup::backup(&mut case, &archive, "synthetic-passphrase-19").unwrap();
    let restored = evidence_desk::backup::restore(
        &archive,
        &dir.path().join("restored"),
        "synthetic-passphrase-19",
    )
    .unwrap();
    assert_eq!(
        evidence_desk::intelligence::query_knowledge(&restored, &[source], "objects", 0).unwrap()
            ["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(restored.task_page(None).unwrap()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["id"] != task));
}

#[test]
fn complete_pipeline_requires_every_knowledge_page_and_invalidates_synthesis_dependencies() {
    let (_dir, mut case, source, task) = unit_setup();
    let read = call(&mut case, &task, "read_analysis_unit", json!({}));
    let findings=(0..60).map(|i|json!({"kind":"statement","title":format!("Synthetic indexed account {i}"),"text":"The witness reports three objects.","supporting":[read["input"]["ref_id"]],"contrary":[],"assessment":"attributed","data_json":"{\"quantity\":3}"})).collect::<Vec<_>>();
    let published = call(
        &mut case,
        &task,
        "publish_analysis_unit",
        json!({"receipts":[read["receipt_id"]],"findings":findings}),
    );
    assert_eq!(published["objects"].as_array().unwrap().len(), 60);
    call(
        &mut case,
        &task,
        "finish_analysis_unit",
        review_objects(&published["objects"], "supported"),
    );
    let summary = evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
        .unwrap()
        .unwrap();
    assert_eq!(
        evidence_desk::intelligence::task_unit(&case, &summary)
            .unwrap()
            .unwrap()["kind"],
        "source_synthesis"
    );
    let page = call(
        &mut case,
        &summary,
        "query_case_knowledge",
        json!({"query":"","offset":0}),
    );
    assert_eq!(page["next_offset"], 50);
    let reference = page["items"][0]["evidence"][0]["ref_id"].clone();
    let summary_finding = json!({"kind":"claim","title":"Synthetic account reconciliation","text":"The first account reports three objects; the second account reports four.","supporting":[reference],"contrary":[],"assessment":"disputed","data_json":"{\"accounts\":[3,4]}"});
    let incomplete = call(
        &mut case,
        &summary,
        "publish_analysis_unit",
        json!({"receipts":[page["receipt_id"]],"findings":[summary_finding]}),
    );
    assert!(incomplete["error"]
        .as_str()
        .unwrap()
        .contains("inspection receipt"));
    let last = call(
        &mut case,
        &summary,
        "query_case_knowledge",
        json!({"query":"","offset":50}),
    );
    assert!(last["next_offset"].is_null());
    assert_eq!(last["items"].as_array().unwrap().len(), 10);
    let summary_result = call(
        &mut case,
        &summary,
        "publish_analysis_unit",
        json!({"receipts":[page["receipt_id"],last["receipt_id"]],"findings":[summary_finding]}),
    );
    assert_eq!(
        summary_result["status"], "analysis_published",
        "{summary_result}"
    );
    call(
        &mut case,
        &summary,
        "finish_analysis_unit",
        review_objects(&summary_result["objects"], "unresolved"),
    );
    let synthesis =
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
            .unwrap()
            .unwrap();
    let page = call(
        &mut case,
        &synthesis,
        "query_case_knowledge",
        json!({"query":"","offset":0}),
    );
    assert_eq!(page["retrieval_level"], "synthesis_inputs");
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let synthesis_result = call(
        &mut case,
        &synthesis,
        "publish_analysis_unit",
        json!({"receipts":[page["receipt_id"]],"findings":[summary_finding]}),
    );
    call(
        &mut case,
        &synthesis,
        "finish_analysis_unit",
        review_objects(&synthesis_result["objects"], "unresolved"),
    );
    assert!(
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["state"],
        "ready"
    );
    let original = &published["objects"][0];
    evidence_desk::evidence::write(
        &mut case,
        evidence_desk::evidence::ObjectInput {
            id: original["id"].as_str().map(str::to_owned),
            base_revision: 1,
            kind: "statement".into(),
            title: "Human revision of the account".into(),
            content: "The first account reports three objects; the second reports four.".into(),
            source_ids: vec![source.clone()],
            locators: vec![format!("evidence:{source}#R1L1-L2")],
            dependencies: vec![],
            start_seconds: None,
            end_seconds: None,
        },
        "human",
    )
    .unwrap();
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["state"],
        "stale"
    );
    let current = evidence_desk::intelligence::query_knowledge(&case, &[source], "", 0).unwrap();
    assert!(current["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["kind"] != "claim"));
    evidence_desk::intelligence::ensure_run(&mut case, "synthetic-model/high").unwrap();
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["complete"],
        0
    );
}

#[test]
fn long_unicode_lines_are_analyzed_in_exact_complete_fragments() {
    let (_dir, mut case, source, interactive) = setup();
    agent::pause(&mut case, &interactive, "Stopped by user").unwrap();
    let long = format!("{}tail proof", "漢".repeat(4500));
    case.publish_extract(&source, &long, "Synthetic long line", true)
        .unwrap();
    let mut collected = String::new();
    for expected_offset in [0, 2000, 4000] {
        let task = evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
            .unwrap()
            .unwrap();
        let read = call(&mut case, &task, "read_analysis_unit", json!({}));
        assert_eq!(read["kind"], "text_fragment");
        assert_eq!(read["input"]["char_offset"], expected_offset);
        let reference = read["input"]["ref_id"].as_str().unwrap();
        let proof =
            evidence_desk::intelligence::resolve_ref(&case, reference, &[source.clone()]).unwrap();
        collected.push_str(proof["proof"]["text"].as_str().unwrap());
        let published = call(
            &mut case,
            &task,
            "publish_analysis_unit",
            json!({"receipts":[read["receipt_id"]],"findings":[]}),
        );
        assert_eq!(published["status"], "analysis_published", "{published}");
        call(
            &mut case,
            &task,
            "finish_analysis_unit",
            json!({"reviews":[]}),
        );
    }
    assert_eq!(collected, long);
}

#[test]
fn reopen_resumes_bounded_units_but_uncertain_delivery_is_never_replayed() {
    let (_dir, case, _source, task) = unit_setup();
    let root = case.root.clone();
    drop(case);
    let mut reopened = Case::open(&root).unwrap();
    assert_eq!(
        evidence_desk::intelligence::next_task(&mut reopened, false, "synthetic-model/high")
            .unwrap(),
        Some(task.clone())
    );
    let request = agent::prepare_request(&mut reopened, &task).unwrap();
    reopened
        .db
        .execute(
            "UPDATE transmissions SET status='uncertain' WHERE id=?",
            [&request.transmission],
        )
        .unwrap();
    drop(reopened);
    let mut reopened = Case::open(&root).unwrap();
    // Reconciliation can proceed to other safe units; it must not replay this task.
    assert_ne!(
        evidence_desk::intelligence::next_task(&mut reopened, false, "synthetic-model/high")
            .unwrap(),
        Some(task.clone())
    );
    assert_eq!(
        reopened
            .db
            .query_row(
                "SELECT status FROM transmissions WHERE id=?",
                [request.transmission],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "uncertain"
    );
    assert_eq!(
        reopened
            .db
            .query_row(
                "SELECT state FROM case_analysis_units WHERE task_id=?",
                [task],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "blocked"
    );
}

#[test]
fn retry_does_not_orphan_an_active_unit_or_relaunch_permanent_extraction_gaps() {
    let (dir, mut case, _source, task) = unit_setup();
    evidence_desk::intelligence::control(&mut case, "retry_failed").unwrap();
    assert_eq!(
        evidence_desk::intelligence::task_unit(&case, &task)
            .unwrap()
            .unwrap()["state"],
        "running"
    );
    assert!(
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high")
            .unwrap()
            .is_none()
    );
    evidence_desk::intelligence::control(&mut case, "cancel").unwrap();
    let path = dir.path().join("unsupported.bin");
    std::fs::write(&path, [0_u8, 1, 2, 3]).unwrap();
    case.import_files(&[path.to_string_lossy().into_owned()], "synthetic")
        .unwrap();
    evidence_desk::intelligence::control(&mut case, "resume").unwrap();
    evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high").unwrap();
    evidence_desk::intelligence::control(&mut case, "retry_failed").unwrap();
    let state:String=case.db.query_row("SELECT state FROM case_analysis_units WHERE kind='unsupported' ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0)).unwrap();
    assert_eq!(state, "blocked");
}

#[test]
fn synthesis_tree_publishes_over_one_thousand_findings_without_dropping_dependencies() {
    let (_dir, mut case, source, interactive) = setup();
    agent::pause(&mut case, &interactive, "Stopped by user").unwrap();
    case.publish_extract(
        &source,
        &"The synthetic account reports three objects.\n".repeat(1320),
        "Synthetic bounded synthesis",
        true,
    )
    .unwrap();
    let mut leaf_findings = 0;
    let mut groups = 0;
    while let Some(task) =
        evidence_desk::intelligence::next_task(&mut case, false, "synthetic-model/high").unwrap()
    {
        let unit = call(&mut case, &task, "read_analysis_unit", json!({}));
        let (receipts, reference, findings) = if unit["kind"] == "text" {
            leaf_findings += 100;
            let findings=(0..100).map(|i|json!({"kind":"statement","title":format!("Synthetic quantity {i}"),"text":"The synthetic account reports three objects.","supporting":[unit["input"]["ref_id"]],"contrary":[],"assessment":"attributed","data_json":"{\"quantity\":3}"})).collect::<Vec<_>>();
            (
                vec![unit["receipt_id"].clone()],
                unit["input"]["ref_id"].clone(),
                findings,
            )
        } else {
            groups += 1;
            let mut receipts = Vec::new();
            let mut offset = 0;
            let mut total = 0;
            let mut reference = serde_json::Value::Null;
            loop {
                let page = call(
                    &mut case,
                    &task,
                    "query_case_knowledge",
                    json!({"query":"","offset":offset}),
                );
                total += page["items"].as_array().unwrap().len();
                receipts.push(page["receipt_id"].clone());
                if reference.is_null() {
                    reference = page["items"][0]["evidence"][0]["ref_id"].clone();
                }
                if let Some(next) = page["next_offset"].as_u64() {
                    offset = next;
                } else {
                    break;
                }
            }
            assert!(
                total <= 500,
                "Host must bound each synthesis input set, got {total}"
            );
            (receipts, reference, Vec::new())
        };
        let findings = if findings.is_empty() {
            vec![
                json!({"kind":"claim","title":"Synthetic reconciled quantity","text":"The synthetic account reports three objects.","supporting":[reference],"contrary":[],"assessment":"attributed","data_json":"{\"quantity\":3}"}),
            ]
        } else {
            findings
        };
        let published = call(
            &mut case,
            &task,
            "publish_analysis_unit",
            json!({"receipts":receipts,"findings":findings}),
        );
        assert_eq!(published["status"], "analysis_published", "{published}");
        let complete = call(
            &mut case,
            &task,
            "finish_analysis_unit",
            review_objects(&published["objects"], "supported"),
        );
        assert_eq!(complete["status"], "analysis_unit_complete", "{complete}");
    }
    assert_eq!(leaf_findings, 1100);
    assert!(groups >= 5);
    assert_eq!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["state"],
        "ready"
    );
    let max_dependencies:i64=case.db.query_row("SELECT max(n) FROM (SELECT count(*) n FROM evidence_dependencies GROUP BY object_id,revision)",[],|r|r.get(0)).unwrap();
    assert_eq!(max_dependencies, 500);
    let total: i64 = case
        .db
        .query_row("SELECT count(*) FROM evidence_dependencies", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(total >= 1100);
}

#[test]
fn live_authorization_stops_dispatched_turns_on_grant_or_scope_revocation() {
    let (_dir, mut case, source, task) = setup();
    case.set_meta(&format!("task_access_route:{task}"), "chatgpt_subscription")
        .unwrap();
    assert!(agent::task_authorized(&case, &task).unwrap());
    let mut settings = case.settings().unwrap();
    settings.allow_text = false;
    settings.allow_images = false;
    case.save_settings(settings).unwrap();
    assert!(!agent::task_authorized(&case, &task).unwrap());
    let mut settings = case.settings().unwrap();
    settings.allow_text = true;
    settings.offline = true;
    case.save_settings(settings).unwrap();
    assert!(!agent::task_authorized(&case, &task).unwrap());
    let mut settings = case.settings().unwrap();
    settings.offline = false;
    case.save_settings(settings).unwrap();
    case.set_restricted(&source, true).unwrap();
    assert!(!agent::task_authorized(&case, &task).unwrap());
}
#[test]
fn deriving_image_tools_are_hidden_from_ask_and_internal_batch_is_denied() {
    let (_dir, mut case, source, task) = unit_setup();
    let result = call(&mut case, &task, "inspect_automatic_video_batch", json!({}));
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("wrong_task_purpose"));
    let ask = agent::start(
        &mut case,
        "Read existing facts",
        "ask",
        vec![source],
        vec![],
        0.,
    )
    .unwrap();
    for name in ["inspect_image_frame", "inspect_office_image"] {
        assert!(!agent::available_tools(&case, &ask)
            .unwrap()
            .iter()
            .any(|t| t["name"] == name));
    }
}

#[test]
fn current_host_manifest_hides_legacy_coverage_and_scoped_brief_hides_other_sources() {
    let (dir, mut case, source, task) = setup();
    let path = dir.path().join("another-private-source.bin");
    std::fs::write(&path, [0_u8, 1, 2, 3]).unwrap();
    case.import_files(&[path.to_string_lossy().into_owned()], "synthetic")
        .unwrap();
    let other = case
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.id != source)
        .unwrap()
        .id;
    evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high").unwrap();
    let tools = agent::available_tools(&case, &task).unwrap();
    assert!(!tools.iter().any(|t| t["name"] == "save_coverage_contract"));
    let brief = evidence_desk::intelligence::answer_context(&case, &[source], "objects").unwrap();
    assert_eq!(brief["analysis_status"]["scope"], "selected_sources");
    assert!(!brief.to_string().contains(&other));
    assert!(!brief.to_string().contains("another-private-source"));
    agent::pause(&mut case, &task, "Stopped by user").unwrap();
    let internal = evidence_desk::intelligence::next_task(&mut case, false, "synthetic/high")
        .unwrap()
        .unwrap();
    let read = call(&mut case, &internal, "read_analysis_unit", json!({}));
    let owner = read["source_id"].as_str().unwrap();
    for source in case
        .sources()
        .unwrap()
        .into_iter()
        .filter(|s| s.id != owner)
    {
        assert!(
            !read.to_string().contains(&source.id),
            "Scoped internal input leaked another source ID"
        );
    }
}

#[test]
fn failed_preparation_is_a_persisted_gap_in_the_analysis_inventory() {
    let (dir, mut case, _source, task) = setup();
    agent::pause(&mut case, &task, "Stopped by user").unwrap();
    let path = dir.path().join("unextractable.bin");
    std::fs::write(&path, [0_u8, 1, 2, 3]).unwrap();
    case.import_files(&[path.to_string_lossy().into_owned()], "synthetic")
        .unwrap();
    evidence_desk::automatic::enqueue(&mut case).unwrap();
    assert!(evidence_desk::automatic::next(&mut case).unwrap().is_none());
    evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high").unwrap();
    let status = evidence_desk::intelligence::status(&case).unwrap().unwrap();
    assert!(status["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["kind"] == "preparation_gap"));
    evidence_desk::intelligence::control(&mut case, "retry_failed").unwrap();
    assert!(
        evidence_desk::intelligence::status(&case).unwrap().unwrap()["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["kind"] == "preparation_gap")
    );
}

#[test]
fn source_restriction_hides_old_run_status_before_manifest_reconciliation() {
    let (dir, mut case, source, task) = setup();
    let path = dir.path().join("restricted-after-dispatch.bin");
    std::fs::write(&path, [0_u8, 1, 2, 3]).unwrap();
    case.import_files(&[path.to_string_lossy().into_owned()], "synthetic")
        .unwrap();
    let other = case
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.id != source)
        .unwrap()
        .id;
    // Dispatch the permitted text source first, leaving B's historical blocker
    // in the same run when its grant is later revoked.
    case.db
        .execute(
            "UPDATE sources SET created_at='2000-01-01T00:00:00Z' WHERE id=?",
            [&other],
        )
        .unwrap();
    agent::pause(&mut case, &task, "Stopped by user").unwrap();
    let internal = evidence_desk::intelligence::next_task(&mut case, false, "synthetic/high")
        .unwrap()
        .unwrap();
    let run = case.meta("case_analysis_run").unwrap();
    case.set_restricted(&other, true).unwrap();
    assert_eq!(case.meta("case_analysis_run").unwrap(), run);
    assert!(evidence_desk::intelligence::status(&case)
        .unwrap()
        .unwrap()
        .to_string()
        .contains(&other));
    for scope in [vec![source.clone()], vec![source.clone(), other.clone()]] {
        let brief = evidence_desk::intelligence::answer_context(&case, &scope, "objects").unwrap();
        assert_eq!(brief["analysis_status"]["scope"], "selected_sources");
        assert_eq!(brief["analysis_status"]["blocked"], 0);
        assert!(!brief.to_string().contains(&other));
    }
    let read = call(&mut case, &internal, "read_analysis_unit", json!({}));
    assert_eq!(read["analysis_status"]["scope"], "selected_sources");
    assert!(!read.to_string().contains(&other));
}

// Persisted metadata fixtures reproduce older completed worker receipts. They
// exercise the production manifest builder, not a fabricated completion result.
fn media_inventory_fixture(case: &mut Case, channels: serde_json::Value) -> (String, String) {
    evidence_desk::discovery::initialize(case).unwrap();
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/generated/dense-timing.mp4");
    case.import_files(&[file.to_string_lossy().into_owned()], "synthetic")
        .unwrap();
    let source = case
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.kind == "video")
        .unwrap()
        .id;
    let transcript = evidence_desk::case::id();
    let mut track =
        json!({"index":0,"decoded_to_eof":true,"gap_seconds":0.,"actual_end_seconds":10.});
    if !channels.is_null() {
        track["channels"] = channels;
    }
    case.db
        .execute(
            "INSERT INTO processing_jobs VALUES(?,?,'full_audio','complete',?,'',?)",
            rusqlite::params![
                transcript,
                source,
                json!({"metadata":{"tracks":[track]}}).to_string(),
                evidence_desk::case::now()
            ],
        )
        .unwrap();
    case.db
        .execute(
            "INSERT INTO processing_jobs VALUES(?,?,'video_overview_index','complete',?,'',?)",
            rusqlite::params![
                evidence_desk::case::id(),
                source,
                json!({"last_chunk":{"eof":true,"last_decoded_seconds":10.},"has_gaps":false})
                    .to_string(),
                evidence_desk::case::now()
            ],
        )
        .unwrap();
    for ordinal in 0..50 {
        case.db
            .execute(
                "INSERT INTO transcript_segments VALUES(?,?,?,0,?,?,?,'[]','{}')",
                rusqlite::params![
                    transcript,
                    ordinal,
                    source,
                    ordinal as f64 * 0.2,
                    (ordinal + 1) as f64 * 0.2,
                    format!("Synthetic transcript segment {ordinal}")
                ],
            )
            .unwrap();
    }
    (source, transcript)
}

#[test]
fn transcript_correction_reuses_unchanged_visual_signal_and_other_transcript_units() {
    let (_dir, mut case, _source, _task) = setup();
    let (source, transcript) = media_inventory_fixture(&mut case, json!(2));
    fn units(case: &Case, run: &str, source: &str) -> std::collections::BTreeMap<String, String> {
        let mut query = case.db.prepare("SELECT u.id,u.kind,u.spec FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id=?").unwrap();
        query
            .query_map(rusqlite::params![run, source], |r| {
                Ok((
                    format!("{}:{}", r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                    r.get::<_, String>(0)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
    let first = evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high")
        .unwrap()
        .unwrap();
    let before = units(&case, &first, &source);
    assert!(before.keys().any(|k| k.starts_with("video:")));
    assert!(before.keys().any(|k| k.starts_with("audio_signal:")));
    assert_eq!(
        before
            .keys()
            .filter(|k| k.starts_with("transcript:"))
            .count(),
        2
    );
    let correction = evidence_desk::transcription::save_correction(
        &mut case,
        &source,
        &transcript,
        1,
        "Corrected synthetic term",
        "Synthetic source comparison",
    )
    .unwrap();
    evidence_desk::transcription::review_correction(
        &mut case,
        correction["id"].as_str().unwrap(),
        true,
    )
    .unwrap();
    let second = evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high")
        .unwrap()
        .unwrap();
    assert_ne!(first, second);
    let after = units(&case, &second, &source);
    for (key, old) in &before {
        if key.starts_with("video:")
            || key.starts_with("audio_signal:")
            || (key.starts_with("transcript:") && key.contains("\"offset\":25"))
        {
            assert_eq!(
                after.get(key),
                Some(old),
                "Unchanged input was redispatched: {key}"
            );
        }
        if key.starts_with("transcript:") && key.contains("\"offset\":0") {
            assert_ne!(
                after.get(key),
                Some(old),
                "Corrected transcript page was reused"
            );
        }
    }
    let old_root = before
        .iter()
        .find(|(k, _)| k.starts_with("source_synthesis:"))
        .unwrap()
        .1;
    assert!(!after.values().any(|id| id == old_root));
}

#[test]
fn legacy_or_excess_channel_inventory_blocks_complete_audio_coverage() {
    for channels in [serde_json::Value::Null, json!(33)] {
        let (_dir, mut case, _source, _task) = setup();
        let (source, _transcript) = media_inventory_fixture(&mut case, channels);
        let run = evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high")
            .unwrap()
            .unwrap();
        let count:i64 = case.db.query_row("SELECT count(*) FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id=? AND u.kind='audio_channel_inventory' AND u.state='blocked'",rusqlite::params![run,source],|r|r.get(0)).unwrap();
        assert_eq!(count, 1);
        let scans:i64 = case.db.query_row("SELECT count(*) FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id=? AND u.kind='audio_signal'",rusqlite::params![run,source],|r|r.get(0)).unwrap();
        assert_eq!(scans, 0, "Unknown channels must not silently become mono");
        evidence_desk::intelligence::control(&mut case, "retry_failed").unwrap();
        assert!(
            evidence_desk::intelligence::status(&case).unwrap().unwrap()["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["kind"] == "audio_channel_inventory")
        );
    }
}

#[test]
fn research_browser_captures_are_not_planned_as_factual_case_evidence() {
    let (dir, mut case, _source, _task) = setup();
    let run = evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high").unwrap().unwrap();
    let bytes = b"Opinion text captured from a research site.\nHeld: the clause is enforceable.";
    let capture = evidence_desk::case::PreparedImport::from_verified_bytes(&case.root, bytes, "opinion.txt", "web-research:https://example.test/opinion").unwrap();
    let captured = case.publish_import(capture, "Research browser capture", "synthetic-capture").unwrap()["source_id"].as_str().unwrap().to_string();
    let units = |case: &Case, run: &str| -> i64 {
        case.db.query_row("SELECT count(*) FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id=?", rusqlite::params![run, captured], |r| r.get(0)).unwrap()
    };
    // A capture alone is legal authority for chats, not case evidence: the run is unchanged.
    assert_eq!(evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high").unwrap(), Some(run.clone()));
    assert_eq!(units(&case, &run), 0);
    // The same bytes produced as evidence are analyzed like any other source.
    let file = dir.path().join("produced-opinion.txt");
    std::fs::write(&file, bytes).unwrap();
    case.import_files(&[file.to_string_lossy().into_owned()], "synthetic").unwrap();
    let next = evidence_desk::intelligence::ensure_run(&mut case, "synthetic/high").unwrap().unwrap();
    assert_ne!(next, run);
    assert!(units(&case, &next) > 0);
}
