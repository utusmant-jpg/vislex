use evidence_desk::{
    agent,
    case::Case,
    evidence::{self, Anchor, Dependency, ObjectInput},
    providers::{self, Config, Execution, Provider, Review},
    teams,
};
use serde_json::{json, Value};

fn setup() -> (tempfile::TempDir, Case, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Case::create(&dir.path().join("matter"), "Synthetic V4 case").unwrap();
    let source = dir.path().join("report.txt");
    std::fs::write(
        &source,
        "The report states three knocks.\nTiming is approximate.\n",
    )
    .unwrap();
    c.import_files(&[source.to_string_lossy().into_owned()], "Fixture")
        .unwrap();
    let sid = c.sources().unwrap()[0].id.clone();
    let mut s = c.settings().unwrap();
    s.offline = false;
    s.allow_text = true;
    s.model = "synthetic-model".into();
    c.save_settings(s).unwrap();
    (dir, c, sid)
}
fn object(source: &str, kind: &str) -> ObjectInput {
    ObjectInput {
        id: None,
        base_revision: 0,
        kind: kind.into(),
        title: "Knock assertion".into(),
        content: "The report says three knocks; audio has not been checked.".into(),
        source_ids: vec![source.into()],
        locators: vec![format!("evidence:{source}#L1-L1")],
        dependencies: vec![],
        start_seconds: None,
        end_seconds: None,
    }
}
fn body(input: Value) -> Value {
    json!({"model":"synthetic-model","input":input,"instructions":"Inspect evidence","tools":[{"type":"function","name":"read_text","description":"Read","parameters":{"type":"object","properties":{},"required":[],"additionalProperties":false}}],"max_output_tokens":4096,"stream":true,"store":false,"parallel_tool_calls":false})
}

#[test]
fn providers_preserve_native_tool_pairs_and_signatures() {
    let input = json!([{"role":"user","content":"Inspect the report"},{"type":"function_call","call_id":"c1","name":"read_text","arguments":"{}"},{"type":"function_call_output","call_id":"c1","output":"source text"}]);
    let claude = providers::encode(Provider::Anthropic, &body(input.clone())).unwrap();
    assert_eq!(claude.body["messages"][1]["content"][0]["type"], "tool_use");
    assert_eq!(
        claude.body["messages"][2]["content"][0]["tool_use_id"],
        "c1"
    );
    assert!(claude.body.get("store").is_none());
    let native = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"functionCall":{"id":"native-call","name":"read_text","args":{}},"thoughtSignature":"opaque-signature"}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":4}});
    let normalized = providers::decode(Provider::Gemini, native).unwrap();
    let mut input = vec![json!({"role":"user","content":"Inspect"})];
    input.extend(normalized["output"].as_array().unwrap().clone());
    input.push(json!({"type":"function_call_output","call_id":"native-call","output":"result"}));
    let gemini = providers::encode(Provider::Gemini, &body(json!(input))).unwrap();
    assert_eq!(
        gemini.body["contents"][1]["parts"][0]["thoughtSignature"],
        "opaque-signature"
    );
    assert_eq!(
        gemini.body["contents"][2]["parts"][0]["functionResponse"]["name"],
        "read_text"
    );
    assert_eq!(normalized["usage"]["input_tokens"], 12);
    for provider in [Provider::Openai, Provider::Xai] {
        assert!(providers::encode(
            provider,
            &body(json!([{"role":"user","content":"Inspect"}]))
        )
        .unwrap()
        .url
        .starts_with("https://api."));
    }
}
#[test]
fn provider_rejects_orphans_truncation_and_url_models() {
    let orphan = body(json!([{"type":"function_call_output","call_id":"missing","output":"text"}]));
    for p in [Provider::Anthropic, Provider::Gemini] {
        assert!(providers::encode(p, &orphan).is_err());
    }
    assert!(providers::decode(
        Provider::Anthropic,
        json!({"stop_reason":"max_tokens","content":[]})
    )
    .is_err());
    assert!(providers::decode(
        Provider::Gemini,
        json!({"candidates":[{"finishReason":"MAX_TOKENS"}]})
    )
    .is_err());
    let mut request = body(json!([]));
    request["model"] = json!("model?key=secret");
    assert!(providers::encode(Provider::Gemini, &request).is_err());
}
#[test]
fn each_provider_can_complete_a_synthetic_single_provider_task() {
    for provider in [
        Provider::Openai,
        Provider::Anthropic,
        Provider::Gemini,
        Provider::Xai,
    ] {
        let (_dir, mut c, sid) = setup();
        providers::save(
            &mut c,
            Config {
                provider,
                ..Default::default()
            },
        )
        .unwrap();
        let mut permission = c.settings().unwrap();
        permission.allow_text = true;
        c.save_settings(permission).unwrap();
        let task = agent::start(
            &mut c,
            "Summarize the request",
            "ask",
            vec![sid],
            vec![],
            0.,
        )
        .unwrap();
        let prepared = agent::prepare_request(&mut c, &task).unwrap();
        assert_eq!(prepared.provider, provider);
        let response = match provider {
            Provider::Anthropic => {
                json!({"stop_reason":"end_turn","content":[{"type":"text","text":"No evidentiary conclusion requested."}],"usage":{"input_tokens":1,"output_tokens":1}})
            }
            Provider::Gemini => {
                json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"No evidentiary conclusion requested."}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}})
            }
            _ => {
                json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"No evidentiary conclusion requested."}]}],"usage":{"input_tokens":1,"output_tokens":1}})
            }
        };
        let response = providers::decode(provider, response).unwrap();
        assert!(!agent::receive(&mut c, &task, &prepared.transmission, response).unwrap());
    }
}
#[test]
fn revision_changes_invalidate_only_dependants_and_preserve_review_history() {
    let (_dir, mut c, sid) = setup();
    let a = evidence::write(&mut c, object(&sid, "statement"), "human").unwrap();
    let aid = a["id"].as_str().unwrap();
    evidence::review(&mut c, aid, 1, "accepted").unwrap();
    let mut b = object(&sid, "claim");
    b.dependencies.push(Dependency {
        id: aid.into(),
        revision: 1,
    });
    let b = evidence::write(&mut c, b, "agent").unwrap();
    let unrelated = evidence::write(&mut c, object(&sid, "observation"), "human").unwrap();
    let mut update = object(&sid, "statement");
    update.id = Some(aid.into());
    update.base_revision = 1;
    update.content = "Corrected attribution".into();
    evidence::write(&mut c, update, "human").unwrap();
    assert_eq!(
        evidence::read(&c, aid, Some(1)).unwrap()["review"],
        "accepted"
    );
    assert_eq!(
        evidence::read(&c, aid, None).unwrap()["review"],
        "unreviewed"
    );
    assert_eq!(
        evidence::read(&c, b["id"].as_str().unwrap(), None).unwrap()["stale"],
        true
    );
    assert_eq!(
        evidence::read(&c, unrelated["id"].as_str().unwrap(), None).unwrap()["stale"],
        false
    );
    assert!(evidence::review(&mut c, b["id"].as_str().unwrap(), 1, "accepted").is_err());
    c.verify_source(&sid).unwrap();
    c.verify_audit().unwrap();
}
#[test]
fn revisions_reject_conflicting_edits_cycles_and_restriction_laundering() {
    let (_dir, mut c, sid) = setup();
    let a = evidence::write(&mut c, object(&sid, "statement"), "human").unwrap();
    let aid = a["id"].as_str().unwrap();
    let mut b = object(&sid, "claim");
    b.dependencies.push(Dependency {
        id: aid.into(),
        revision: 1,
    });
    let b = evidence::write(&mut c, b, "agent").unwrap();
    let mut update = object(&sid, "statement");
    update.id = Some(aid.into());
    assert!(evidence::write(&mut c, update, "human").is_err());
    let mut cycle = object(&sid, "statement");
    cycle.id = Some(aid.into());
    cycle.base_revision = 1;
    cycle.dependencies.push(Dependency {
        id: b["id"].as_str().unwrap().into(),
        revision: 1,
    });
    assert!(evidence::write(&mut c, cycle, "agent").is_err());
    let mut missing = object(&sid, "claim");
    missing.source_ids.clear();
    missing.locators.clear();
    missing.dependencies.push(Dependency {
        id: aid.into(),
        revision: 1,
    });
    assert!(evidence::write(&mut c, missing, "agent").is_err());
}
#[test]
fn lexical_index_applies_restrictions_before_returning_snippets() {
    let (_dir, mut c, sid) = setup();
    let o = evidence::write(&mut c, object(&sid, "statement"), "human").unwrap();
    let found = evidence::search(&c, "knocks", 0).unwrap();
    assert!(found["results"].as_array().unwrap().len() >= 2);
    c.set_restricted(&sid, true).unwrap();
    assert!(evidence::search(&c, "knocks", 0).unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(evidence::read(&c, o["id"].as_str().unwrap(), None).is_err());
    assert!(evidence::list(&c, None, None, 0).unwrap()["objects"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn migration_backs_up_and_reopening_does_not_duplicate_search() {
    let (_dir, c, sid) = setup();
    let original = c.source(&sid).unwrap().sha256;
    let root = c.root.clone();
    c.db.pragma_update(None, "user_version", 3).unwrap();
    drop(c);
    let c = Case::open(&root).unwrap();
    assert!(root.join("pre-migration-v3.sqlite3").exists());
    assert_eq!(c.source(&sid).unwrap().sha256, original);
    assert_eq!(
        c.db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        5
    );
    assert_eq!(
        evidence::search(&c, "knocks", 0).unwrap()["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn schema_v5_upgrade_snaps_v4_and_adds_lookup_indexes() {
    let (_dir, c, _sid) = setup();
    let root = c.root.clone();
    c.db.pragma_update(None, "user_version", 4).unwrap();
    drop(c);
    let c = Case::open(&root).unwrap();
    assert!(root.join("pre-migration-v4.sqlite3").exists());
    assert_eq!(
        c.db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        5
    );
    for index in ["actions_task","transmissions_task","occurrences_source","processing_jobs_source","artifacts_source"] {
        let present: bool = c
            .db
            .query_row("SELECT COUNT(*)>0 FROM sqlite_master WHERE type='index' AND name=?", [index], |r| r.get(0))
            .unwrap();
        assert!(present, "missing index {index}");
    }
}
#[test]
fn clock_fit_requires_validation_and_does_not_accept_false_alignment() {
    let a = |s: f64, i: f64, h: bool| Anchor {
        source_seconds: s,
        incident_seconds: i,
        uncertainty_seconds: 0.01,
        held_out: h,
    };
    let mut anchors = vec![
        a(0., 100., false),
        a(30., 130.003, false),
        a(60., 160.006, false),
    ];
    let fit = evidence::fit_clock(&anchors).unwrap();
    assert_eq!(fit["drift_estimated"], true);
    assert_eq!(fit["held_out_checks_passed"], false);
    anchors.push(a(45., 145.0045, true));
    assert_eq!(
        evidence::fit_clock(&anchors).unwrap()["held_out_checks_passed"],
        true
    );
    anchors[3].incident_seconds += 2.;
    assert_eq!(
        evidence::fit_clock(&anchors).unwrap()["held_out_checks_passed"],
        false
    );
    assert_eq!(
        evidence::fit_clock(&[a(0., 100., false), a(30., 130., false)]).unwrap()["drift_estimated"],
        false
    );
}
#[test]
fn same_model_teams_are_blind_idempotent_and_cannot_publish_shared_edits() {
    let (_dir, mut c, sid) = setup();
    providers::save(
        &mut c,
        Config {
            execution: Execution::Parallel,
            ..Default::default()
        },
    )
    .unwrap();
    let parent = agent::start(
        &mut c,
        "Count reported knocks",
        "investigate",
        vec![sid],
        vec![],
        0.,
    )
    .unwrap();
    let ids = teams::prepare(&mut c, &parent, "investigate").unwrap();
    assert_eq!(ids.len(), 3);
    assert_eq!(ids, teams::prepare(&mut c, &parent, "investigate").unwrap());
    for child in &ids {
        assert_eq!(
            providers::task_profile(&c, child).unwrap().model,
            "synthetic-model"
        );
        assert!(agent::execute_tool(&mut c, child, "write_record", &json!({})).is_err());
        let history: String =
            c.db.query_row("SELECT history FROM tasks WHERE id=?", [child], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!history.contains("Previous conversation summaries"));
    }
    assert!(teams::merge(&mut c, &parent, "investigate").is_err());
    agent::pause(&mut c, &parent, "Stopped by user").unwrap();
    for child in ids {
        assert!(!teams::active(&c, &child).unwrap());
        assert!(agent::prepare_request(&mut c, &child).is_err());
    }
    assert!(teams::merge(&mut c, &parent, "investigate").is_err());
}
#[test]
fn challenge_has_blind_first_assessment_and_separate_draft_critic() {
    let (_dir, mut c, sid) = setup();
    providers::save(
        &mut c,
        Config {
            review: Review::Challenge,
            ..Default::default()
        },
    )
    .unwrap();
    let parent = agent::start(&mut c, "What occurred?", "ask", vec![sid], vec![], 0.).unwrap();
    assert!(teams::request_review(&c, &parent, "DRAFT_MARKER_123").unwrap());
    let children = teams::prepare(&mut c, &parent, "review").unwrap();
    assert_eq!(children.len(), 2);
    for child in children {
        let (role,history):(String,String)=c.db.query_row("SELECT a.role,t.history FROM agent_assignments a JOIN tasks t ON t.id=a.task_id WHERE t.id=?",[&child],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(
            history.contains("DRAFT_MARKER_123"),
            role == "challenge reviewer"
        );
        agent::pause(&mut c, &child, "Synthetic unavailable provider").unwrap();
    }
    teams::merge(&mut c, &parent, "review").unwrap();
    teams::merge(&mut c, &parent, "review").unwrap();
    assert!(!teams::request_review(&c, &parent, "DRAFT_MARKER_123").unwrap());
    assert!(teams::request_review(&c, &parent, "Another draft").unwrap());
    assert_eq!(teams::prepare(&mut c, &parent, "review").unwrap().len(),2);
    let history: String =
        c.db.query_row("SELECT history FROM tasks WHERE id=?", [&parent], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(history.matches("Team review-").count(), 1);
    assert!(history.contains("coverage gap"));
}
#[test]
fn unapproved_fallback_is_rejected_and_legacy_configuration_is_preserved() {
    let (_dir, mut c, sid) = setup();
    let parent = agent::start(&mut c, "Inspect", "ask", vec![sid], vec![], 0.).unwrap();
    let mut p = providers::task_profile(&c, &parent).unwrap();
    assert_eq!(p.provider, Provider::Openai);
    p.provider = Provider::Gemini;
    assert!(providers::check_permission(&c, &p).is_err());
    assert!(providers::save(
        &mut c,
        Config {
            provider: Provider::Gemini,
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(Provider::Openai.credential(), "openai-api-key");
}

#[test]
fn multiple_read_results_keep_native_tool_pairs_and_reject_replay() {
    let (_dir, mut c, sid) = setup();
    providers::save(
        &mut c,
        Config {
            provider: Provider::Gemini,
            ..Default::default()
        },
    )
    .unwrap();
    let mut permission = c.settings().unwrap();
    permission.allow_text = true;
    c.save_settings(permission).unwrap();
    let task = agent::start(&mut c, "Inspect", "ask", vec![sid.clone()], vec![], 0.).unwrap();
    let request = agent::prepare_request(&mut c, &task).unwrap();
    let response = json!({"status":"completed","usage":{"input_tokens":1,"output_tokens":1},"output":[
        {"type":"function_call","call_id":"read-a","name":"read_text","arguments":json!({"source_id":sid,"start":1,"count":1}).to_string()},
        {"type":"function_call","call_id":"read-b","name":"list_sources","arguments":"{\"offset\":0}"}
    ]});
    assert!(agent::receive(&mut c, &task, &request.transmission, response.clone()).unwrap());
    assert!(agent::receive(&mut c, &task, &request.transmission, response).is_err());
    let next = agent::prepare_request(&mut c, &task).unwrap();
    let wire = providers::encode(Provider::Gemini, &next.body).unwrap();
    let text = wire.body.to_string();
    assert!(text.contains("functionResponse"));
    assert!(text.contains("read-a") && text.contains("read-b"));
}

#[test]
fn mixed_completion_batch_cannot_publish_or_finish() {
    let (_dir, mut c, sid) = setup();
    let task = agent::start(&mut c, "Inspect", "investigate", vec![sid], vec![], 0.).unwrap();
    let request = agent::prepare_request(&mut c, &task).unwrap();
    let response = json!({"status":"completed","usage":{},"output":[
        {"type":"function_call","call_id":"first","name":"finish_task","arguments":"{\"answer\":\"Unverified answer\",\"citations\":[],\"gaps\":[]}"},
        {"type":"function_call","call_id":"second","name":"list_sources","arguments":"{\"offset\":0}"}
    ]});
    assert!(agent::receive(&mut c, &task, &request.transmission, response).unwrap());
    assert!(c.records().unwrap().is_empty());
    let status: String =
        c.db.query_row("SELECT status FROM tasks WHERE id=?", [task], |r| r.get(0))
            .unwrap();
    assert_eq!(status, "running");
}

#[test]
fn mixed_provider_pool_is_explicit_and_revocation_stops_dispatch() {
    let (_dir, mut c, sid) = setup();
    let pool = vec![Provider::Gemini, Provider::Anthropic]
        .into_iter()
        .map(|provider| providers::Profile {
            provider,
            model: "synthetic-model".into(),
            allow_text: true,
            allow_images: false,
        })
        .collect();
    providers::save(
        &mut c,
        Config {
            execution: Execution::Parallel,
            pool,
            ..Default::default()
        },
    )
    .unwrap();
    let parent = agent::start(&mut c, "Inspect", "ask", vec![sid], vec![], 0.).unwrap();
    let children = teams::prepare(&mut c, &parent, "investigate").unwrap();
    let selected: Vec<_> = children
        .iter()
        .map(|id| providers::task_profile(&c, id).unwrap().provider)
        .collect();
    assert!(selected.contains(&Provider::Gemini) && selected.contains(&Provider::Anthropic));
    c.set_meta(
        "ai_config",
        &serde_json::to_string(&Config::default()).unwrap(),
    )
    .unwrap();
    for child in children {
        assert!(agent::prepare_request(&mut c, &child).is_err());
    }
}

#[test]
fn changing_provider_revokes_legacy_modality_consent_at_the_backend() {
    let (_dir, mut c, _sid) = setup();
    providers::save(
        &mut c,
        Config {
            provider: Provider::Gemini,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!c.settings().unwrap().allow_text);
    assert!(!c.settings().unwrap().allow_images);
    c.verify_audit().unwrap();
}

#[test]
fn account_model_catalogues_normalize_and_exclude_unrelated_modalities() {
    let openai=providers::model_options(Provider::Openai,&json!({"data":[{"id":"gpt-test"},{"id":"text-embedding-test"},{"id":"gpt-test-realtime"},{"id":"gpt-test"}]})).unwrap();
    assert_eq!(openai.len(),1);assert_eq!(openai[0].id,"gpt-test");
    let gemini=providers::model_options(Provider::Gemini,&json!({"models":[{"name":"models/gemini-test","displayName":"Test model","supportedGenerationMethods":["generateContent"]},{"name":"models/embedding-test","supportedGenerationMethods":["embedContent"]}]})).unwrap();
    assert_eq!(gemini.len(),1);assert_eq!(gemini[0].id,"gemini-test");assert_eq!(gemini[0].name,"Test model");
    let claude=providers::model_options(Provider::Anthropic,&json!({"data":[{"id":"claude-test","display_name":"Claude test"}]})).unwrap();assert_eq!(claude[0].name,"Claude test");
    let grok=providers::model_options(Provider::Xai,&json!({"data":[{"id":"grok-test"},{"id":"grok-imagine-image"}]})).unwrap();assert_eq!(grok.len(),1);
    assert!(providers::model_options(Provider::Openai,&json!({"error":"unauthorized"})).is_err());
}
#[test]
fn chat_model_selection_keeps_other_providers_and_enforces_permissions() {
    let (_dir,mut c,_sid)=setup();
    let profile=providers::Profile{provider:Provider::Gemini,model:"gemini-test".into(),allow_text:true,allow_images:true};
    providers::save(&mut c,Config{pool:vec![profile],..Default::default()}).unwrap();
    let selected=providers::select_profile(&c,Provider::Gemini,"gemini-test").unwrap();assert!(selected.allow_images);
    assert!(providers::select_profile(&c,Provider::Openai,"synthetic-model").is_ok());
    assert_eq!(providers::load(&c).unwrap().provider,Provider::Openai);
    assert!(providers::select_profile(&c,Provider::Anthropic,"unapproved").is_err());
    let mut settings=c.settings().unwrap();settings.offline=true;c.save_settings(settings).unwrap();
    assert!(providers::select_profile(&c,Provider::Gemini,"gemini-test").is_err());
}
#[test]
fn agent_directed_assignments_are_atomic_scoped_and_cancel_with_parent() {
    let (_dir,mut c,sid)=setup();
    providers::save(&mut c,Config{execution:Execution::Auto,pool:vec![providers::Profile{provider:Provider::Gemini,model:"gemini-test".into(),allow_text:true,allow_images:false}],..Default::default()}).unwrap();
    let parent=agent::start(&mut c,"Investigate","investigate",vec![sid.clone()],vec![],0.).unwrap();
    assert!(teams::prepare(&mut c,&parent,"investigate").unwrap().is_empty());
    assert_eq!(teams::models(&c,&parent).unwrap()["can_delegate"],true);
    let invalid=json!({"assignments":[{"instruction":"First task","model_index":0},{"instruction":"Unapproved task","model_index":88}]});
    assert!(teams::delegate(&mut c,&parent,&invalid).is_err());assert_eq!(teams::status(&c,&parent).unwrap(),json!([]));
    let batch=json!({"assignments":[{"instruction":"Check report assertions","model_index":0},{"instruction":"Check contrary evidence","model_index":1}]});
    let result=agent::execute_tool(&mut c,&parent,"delegate_tasks",&batch).unwrap();
    let phase=result["phase"].as_str().unwrap();
    let children=teams::prepare(&mut c,&parent,phase).unwrap();assert_eq!(children.len(),2);
    assert_eq!(children,teams::prepare(&mut c,&parent,phase).unwrap());
    assert!(teams::delegate(&mut c,&parent,&batch).is_err());
    for child in &children {
        let scope:String=c.db.query_row("SELECT scope FROM tasks WHERE id=?",[child],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Vec<String>>(&scope).unwrap(),vec![sid.clone()]);
        assert!(teams::delegate(&mut c,child,&batch).is_err());
        assert!(agent::execute_tool(&mut c,child,"write_record",&json!({})).is_err());
    }
    agent::pause(&mut c,&parent,"User stopped").unwrap();
    for child in children {assert!(!teams::active(&c,&child).unwrap());}
    assert!(teams::merge(&mut c,&parent,phase).is_err());
}
#[test]
fn single_agent_cannot_delegate_and_completed_batches_allow_new_work() {
    let (_dir,mut c,sid)=setup();
    let parent=agent::start(&mut c,"Inspect","ask",vec![sid.clone()],vec![],0.).unwrap();
    let batch=json!({"assignments":[{"instruction":"Independent check","model_index":0}]});
    assert!(teams::delegate(&mut c,&parent,&batch).is_err());agent::pause(&mut c,&parent,"Change mode").unwrap();
    providers::save(&mut c,Config{execution:Execution::Auto,..Default::default()}).unwrap();
    let parent=agent::start(&mut c,"Inspect","ask",vec![sid],vec![],0.).unwrap();
    let result=teams::delegate(&mut c,&parent,&batch).unwrap();
    let child=result["task_ids"][0].as_str().unwrap();
    c.db.execute("UPDATE tasks SET status='complete',answer='Synthetic proposal' WHERE id=?",[child]).unwrap();
    let phase=result["phase"].as_str().unwrap();teams::merge(&mut c,&parent,phase).unwrap();teams::merge(&mut c,&parent,phase).unwrap();
    let history:String=c.db.query_row("SELECT history FROM tasks WHERE id=?",[&parent],|r|r.get(0)).unwrap();assert_eq!(history.matches("Synthetic proposal").count(),1);
    assert!(teams::delegate(&mut c,&parent,&batch).is_ok());
}

#[test]
fn automatic_queue_deduplicates_imports_resumes_and_yields_to_chat() {
    let (_dir,mut c,sid)=setup();
    evidence_desk::automatic::enqueue(&mut c).unwrap();
    evidence_desk::automatic::enqueue(&mut c).unwrap();
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["files"],1);
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
    assert!(evidence_desk::automatic::next(&mut c).unwrap().is_none());
    assert_eq!(evidence_desk::automatic::status(&c).unwrap()["prepared"],1);
    let task=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
    evidence_desk::automatic::preempt_for_chat(&mut c).unwrap();assert!(!teams::active(&c,&task).unwrap());
    let chat=agent::start(&mut c,"My question","ask",vec![sid],vec![],0.).unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
    agent::pause(&mut c,&chat,"Finished test").unwrap();
    let resumed=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();assert_ne!(resumed,task);
    agent::pause(&mut c,&resumed,"Stopped by user").unwrap();
    assert!(evidence_desk::automatic::start_review(&mut c).unwrap().is_none());
}

#[test]
fn import_preparation_is_separate_from_publication_and_preserves_provenance() {
    let (dir,mut c,_sid)=setup();
    let path=dir.path().join("another.txt");std::fs::write(&path,"Synthetic second report").unwrap();
    let prepared=evidence_desk::case::prepare_import(&c.root,&path).unwrap();
    assert_eq!(c.sources().unwrap().len(),1);
    let receipt=c.publish_import(prepared,"Synthetic batch","batch-123").unwrap();
    assert_eq!(c.sources().unwrap().len(),2);
    let sid=receipt["source_id"].as_str().unwrap();c.verify_source(sid).unwrap();
    let occurrence:(String,String)=c.db.query_row("SELECT production,batch_id FROM occurrences WHERE source_id=?",[sid],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(occurrence,("Synthetic batch".into(),"batch-123".into()));
}

#[test]
fn job_history_only_resolves_after_same_processor_succeeds() {
    let (_dir,c,sid)=setup();
    for (id,kind,status) in [("old","media_inventory","failed"),("other","full_audio","complete")] {
        c.db.execute("INSERT INTO processing_jobs VALUES(?,?,?,?,'{}','','2026-09-20')",rusqlite::params![id,sid,kind,status]).unwrap();
    }
    let resolved=|snapshot:serde_json::Value| snapshot["jobs"].as_array().unwrap().iter().find(|j|j["id"]=="old").unwrap()["superseded"].as_bool().unwrap();
    assert!(!resolved(c.snapshot().unwrap()));
    c.db.execute("INSERT INTO processing_jobs VALUES('new',?,'media_inventory','complete','{}','','2026-09-20')",[&sid]).unwrap();
    assert!(resolved(c.snapshot().unwrap()));
    let status:String=c.db.query_row("SELECT status FROM processing_jobs WHERE id='old'",[],|r|r.get(0)).unwrap();
    assert_eq!(status,"failed");
}

#[test]
fn app_preferences_replace_existing_case_model_without_credentials() {
    let (_dir,mut c,_)=setup();
    let mut settings=c.settings().unwrap();settings.model="app-model".into();
    let preferences=json!({"config":{"provider":"openai","execution":"single","review":"challenge","pool":[]},"settings":settings});
    providers::apply_app_settings(&mut c,&preferences).unwrap();
    assert_eq!(c.settings().unwrap().model,"app-model");
    assert_eq!(providers::load(&c).unwrap().execution,Execution::Auto);
    assert_eq!(providers::load(&c).unwrap().review,Review::Standard);
    assert_eq!(c.meta("gemini_direct_media").unwrap().as_deref(),Some("true"));
    let other_dir=tempfile::tempdir().unwrap();let mut other=Case::create(&other_dir.path().join("second"),"Second case").unwrap();
    providers::apply_app_settings(&mut other,&preferences).unwrap();
    assert_eq!(other.settings().unwrap().model,c.settings().unwrap().model);
    let mut invalid=preferences;invalid["settings"]["model"]=json!("invalid model!");
    assert!(providers::apply_app_settings(&mut c,&invalid).is_err());
    assert_eq!(c.settings().unwrap().model,"app-model");
}
