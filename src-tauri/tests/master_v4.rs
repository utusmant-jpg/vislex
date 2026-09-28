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
fn tool_schemas_satisfy_openai_strict_mode() {
    // Every tool ships with strict:true, and the Responses API rejects the whole
    // chat request when any object schema omits additionalProperties:false or
    // lists a property outside required. This guard keeps one malformed tool
    // schema from disabling chat on every model.
    fn check(schema: &Value, path: &str) {
        let types = match &schema["type"] {
            Value::String(kind) => vec![kind.clone()],
            Value::Array(items) => items
                .iter()
                .filter_map(|value| value.as_str().map(String::from))
                .collect(),
            _ => vec![],
        };
        let object_like = types.iter().any(|kind| kind == "object")
            || schema.get("properties").is_some()
            || schema.get("additionalProperties").is_some();
        if object_like {
            assert_eq!(
                schema["additionalProperties"],
                json!(false),
                "object schema at {path} must set additionalProperties:false"
            );
            let required: Vec<String> = schema["required"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(props) = schema["properties"].as_object() {
                for name in props.keys() {
                    assert!(
                        required.contains(name),
                        "property {path}.{name} must be listed in required"
                    );
                }
            }
        }
        if let Some(items) = schema.get("items") {
            check(items, &format!("{path}.items"));
        }
        if let Some(props) = schema.get("properties").and_then(|props| props.as_object()) {
            for (name, sub) in props {
                check(sub, &format!("{path}.{name}"));
            }
        }
    }
    for tool in agent::tools("investigate") {
        assert_eq!(
            tool["strict"],
            json!(true),
            "tool {} must keep strict argument validation",
            tool["name"]
        );
        check(&tool["parameters"], &format!("tool {}", tool["name"]));
    }
    check(&agent::visual_review_tool()["parameters"], "visual review tool");
}

#[test]
fn review_candidate_candidate_blocks_match_finish_task_block_shape() {
    // The candidate echoed back by finish_task is fed to review_candidate; its
    // blocks schema must accept the same structured blocks.
    let candidate = agent::tools("investigate")
        .into_iter()
        .find(|tool| tool["name"] == "review_candidate")
        .unwrap();
    let finish = agent::tools("investigate")
        .into_iter()
        .find(|tool| tool["name"] == "finish_task")
        .unwrap();
    assert_eq!(
        candidate["parameters"]["properties"]["candidate"]["properties"]["blocks"]["items"],
        finish["parameters"]["properties"]["blocks"]["items"]
    );
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
fn claude_stream_waits_for_complete_signed_multi_tool_message() {
    let wire = providers::encode(Provider::Anthropic, &body(json!([{"role":"user","content":"Synthetic question"}]))).unwrap();
    assert_eq!(wire.body["stream"], true);
    let events = vec![
        json!({"type":"message_start","message":{"role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Check "}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the source."}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":"","signature":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"synthetic thought"}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"signed"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call-a","name":"read_text","input":{}}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":""}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"start\":"}}),
        json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"1}"}}),
        json!({"type":"content_block_stop","index":2}),
        json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"call-b","name":"read_text","input":{}}}),
        json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\"start\":2}"}}),
        json!({"type":"content_block_stop","index":3}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}),
        json!({"type":"message_stop"}),
    ];
    let bytes = events.iter().map(|event| format!("data: {}\n\n", event)).collect::<String>().into_bytes();
    let mut sse = agent::ResponseStream::default();
    let mut claude = providers::ClaudeStream::default();
    let mut completed = None;
    for chunk in bytes.chunks(13) {
        for event in sse.push(chunk).unwrap() {
            let result = claude.push(&event).unwrap();
            if result.is_some() { completed = result; }
        }
    }
    let result = completed.unwrap();
    assert_eq!(result["status"], "completed");
    assert_eq!(result["usage"]["input_tokens"], 12);
    assert_eq!(result["usage"]["output_tokens"], 9);
    assert_eq!(result["output"][0]["content"][0]["text"], "Check the source.");
    assert_eq!(result["output"][1]["part"]["signature"], "signed");
    assert_eq!(result["output"][2]["call_id"], "call-a");
    assert_eq!(result["output"][2]["arguments"], "{\"start\":1}");
    assert_eq!(result["output"][3]["call_id"], "call-b");
}

#[test]
fn claude_stream_rejects_partial_and_malformed_tool_calls() {
    let start = json!({"type":"message_start","message":{"role":"assistant","content":[],"stop_reason":null,"usage":{}}});
    let tool = json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-a","name":"read_text","input":{}}});
    let mut partial = providers::ClaudeStream::default();
    partial.push(&start).unwrap();
    partial.push(&tool).unwrap();
    assert!(partial.push(&json!({"type":"message_stop"})).is_err());
    let mut malformed = providers::ClaudeStream::default();
    malformed.push(&start).unwrap();
    malformed.push(&tool).unwrap();
    malformed.push(&json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{bad"}})).unwrap();
    assert!(malformed.push(&json!({"type":"content_block_stop","index":0})).is_err());
    let mut truncated = providers::ClaudeStream::default();
    truncated.push(&start).unwrap();
    truncated.push(&json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}})).unwrap();
    assert!(truncated.push(&json!({"type":"message_stop"})).unwrap_err().to_string().contains("output token limit"));
    let mut rejected = providers::ClaudeStream::default();
    assert!(rejected.push(&json!({"type":"error","error":{"message":"Synthetic provider error"}})).is_err());
}

#[test]
fn gemini_stream_preserves_final_empty_signature_and_complete_tool_parts() {
    let wire = providers::encode(Provider::Gemini, &body(json!([{"role":"user","content":"Synthetic question"}]))).unwrap();
    assert!(wire.url.ends_with(":streamGenerateContent?alt=sse"));
    let mut stream = providers::GeminiStream::default();
    let (first, done) = stream.push(&json!({"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]})).unwrap();
    assert_eq!(first, vec!["Hello "]);
    assert!(done.is_none());
    let (second, done) = stream.push(&json!({"candidates":[{"content":{"parts":[{"text":"world"},{"thought":true,"text":"private","thoughtSignature":"thought-sig"},{"functionCall":{"id":"call-a","name":"read_text","args":{"start":1}},"thoughtSignature":"call-sig"},{"functionCall":{"id":"call-b","name":"read_text","args":{"start":2}}}]}}]})).unwrap();
    assert_eq!(second, vec!["world"]);
    assert!(done.is_none());
    let (last, done) = stream.push(&json!({"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"final-sig"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":8}})).unwrap();
    assert!(last.is_empty());
    let output = done.unwrap();
    assert_eq!(output["usage"]["input_tokens"], 15);
    assert_eq!(output["output"][0]["content"][0]["text"], "Hello world");
    assert_eq!(output["output"][1]["part"]["thoughtSignature"], "thought-sig");
    assert_eq!(output["output"][2]["native_part"]["thoughtSignature"], "call-sig");
    assert_eq!(output["output"][3]["call_id"], "call-b");
    assert_eq!(output["output"][4]["native_part"]["thoughtSignature"], "final-sig");
    let sent = providers::encode(Provider::Gemini, &body(json!(output["output"]))).unwrap();
    let parts = sent.body["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts[2]["thoughtSignature"], "call-sig");
    assert_eq!(parts.last().unwrap()["thoughtSignature"], "final-sig");
    let mut malformed = providers::GeminiStream::default();
    assert!(malformed.push(&json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_text"}}]},"finishReason":"STOP"}]})).is_err());
    let mut truncated = providers::GeminiStream::default();
    assert!(truncated.push(&json!({"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS"}]})).unwrap_err().to_string().contains("output token limit"));
}
#[test]
fn provider_stop_reasons_distinguish_truncation_and_refusal() {
    for (reason,expected) in [("max_tokens","incomplete"),("model_context_window_exceeded","incomplete"),("refusal","refused"),("pause_turn","paused")] {
        let error=providers::decode(Provider::Anthropic,json!({"stop_reason":reason,"content":[]})).unwrap_err().to_string();
        assert!(error.contains(expected),"{reason}: {error}");
    }
    for (reason,expected) in [("MAX_TOKENS","incomplete"),("SAFETY","blocked"),("RECITATION","blocked"),("MALFORMED_FUNCTION_CALL","malformed")] {
        let error=providers::decode(Provider::Gemini,json!({"candidates":[{"finishReason":reason}]})).unwrap_err().to_string();
        assert!(error.contains(expected),"{reason}: {error}");
    }
    let prompt=providers::decode(Provider::Gemini,json!({"promptFeedback":{"blockReason":"SAFETY"},"candidates":[]})).unwrap_err().to_string();
    assert!(prompt.contains("prompt blocked"));
    let unknown=providers::decode(Provider::Gemini,json!({"candidates":[{"finishReason":"untrusted arbitrary text"}]})).unwrap_err().to_string();
    assert!(!unknown.contains("untrusted arbitrary text"));
}
#[test]
fn gemini_preserves_signed_text_and_thought_parts_before_tool_calls() {
    let response=json!({"candidates":[{"finishReason":"STOP","content":{"parts":[
        {"text":"private thinking","thought":true,"thoughtSignature":"thought-sig"},
        {"text":"I will inspect the source.","thoughtSignature":"text-sig"},
        {"functionCall":{"id":"call-1","name":"read_text","args":{}},"thoughtSignature":"call-sig"}
    ]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":6}});
    let normalized=providers::decode(Provider::Gemini,response).unwrap();
    let mut input=vec![json!({"role":"user","content":"Inspect"})];
    input.extend(normalized["output"].as_array().unwrap().clone());
    input.push(json!({"type":"function_call_output","call_id":"call-1","output":"source text"}));
    let request=providers::encode(Provider::Gemini,&body(json!(input))).unwrap();
    let parts=request.body["contents"][1]["parts"].as_array().unwrap();
    assert_eq!(parts.len(),3);
    assert_eq!(parts[0]["thoughtSignature"],"thought-sig");
    assert_eq!(parts[1]["thoughtSignature"],"text-sig");
    assert_eq!(parts[2]["thoughtSignature"],"call-sig");
    assert_eq!(request.body["contents"][2]["parts"][0]["functionResponse"]["id"],"call-1");
}
#[test]
fn provider_incomplete_reason_is_bounded_and_actionable() {
    let event=json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}});
    assert_eq!(providers::stream_failure_detail(&event),"Incomplete response: max_output_tokens");
    let unknown=json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"arbitrary private text"}}});
    assert_eq!(providers::stream_failure_detail(&unknown),"no provider detail supplied");
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
        evidence_desk::case::CASE_SCHEMA
    );
    // Schema 6 backfills the active extraction as an immutable revision row.
    let backfilled: i64 = c
        .db
        .query_row("SELECT COUNT(*) FROM extract_revisions WHERE source_id=?", [&sid], |r| r.get(0))
        .unwrap();
    assert_eq!(backfilled, 1);
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
        evidence_desk::case::CASE_SCHEMA
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
    assert!(teams::status(&c, &parent).unwrap().as_array().unwrap().iter().all(|member| member.get("spent").is_none()));
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
    // VL-002: the durable case-level image grant gates pool profiles too, so an
    // image-capable profile is rejected while this case has not granted images.
    assert!(providers::select_profile(&c,Provider::Gemini,"gemini-test").is_err());
    let mut granted=c.settings().unwrap();granted.allow_images=true;c.save_settings(granted).unwrap();
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
    // VL-007: after yielding to chat, the paused automatic review resumes the
    // same task (keeping its investigation context) instead of restarting.
    let resumed=evidence_desk::automatic::start_review(&mut c).unwrap().unwrap();assert_eq!(resumed,task);
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
fn app_preferences_apply_exactly_the_chosen_policy_without_forcing() {
    let (_dir,mut c,_)=setup();
    // R04: the exact chosen policy is saved. A stricter review mode, custom
    // execution and narrow grants survive application; saving a
    // different model later cannot downgrade review or broaden grants.
    let mut settings=c.settings().unwrap();
    settings.offline=false;settings.allow_text=true;settings.allow_images=false;
    settings.model="app-model".into();
    let preferences=json!({"config":{"provider":"openai","execution":"single","review":"challenge","pool":[{"provider":"gemini","model":"vision-model","allow_text":true,"allow_images":false}]},"settings":settings});
    providers::apply_app_settings(&mut c,&preferences).unwrap();
    assert_eq!(c.settings().unwrap().model,"app-model");
    assert_eq!(providers::load(&c).unwrap().execution,Execution::Single,"chosen execution must be preserved");
    assert_eq!(providers::load(&c).unwrap().review,Review::Challenge,"chosen review mode must be preserved");
    assert!(!c.settings().unwrap().allow_images,"image grant must not be forced on");
    assert_eq!(providers::load(&c).unwrap().pool[0].allow_images,false,"per-profile grants must not be forced on");
    // A model-only change preserves the rest of the policy exactly.
    let mut model_only=preferences.clone();
    model_only["settings"]["model"]=json!("replacement-model");
    providers::apply_app_settings(&mut c,&model_only).unwrap();
    assert_eq!(providers::load(&c).unwrap().review,Review::Challenge,"model change cannot downgrade review");
    assert!(!c.settings().unwrap().allow_images,"model change cannot enable images");
    // VL-002: applying app preferences never silently enables direct media;
    // it remains a separate explicit opt-in.
    assert_ne!(c.meta("gemini_direct_media").unwrap().as_deref(),Some("true"));
    let other_dir=tempfile::tempdir().unwrap();let mut other=Case::create(&other_dir.path().join("second"),"Second case").unwrap();
    providers::apply_app_settings(&mut other,&preferences).unwrap();
    assert_eq!(other.settings().unwrap().model,"app-model");
    assert_eq!(providers::load(&other).unwrap().review,Review::Challenge,"second case receives the same chosen policy");
    let mut invalid=preferences;invalid["settings"]["model"]=json!("invalid model!");
    assert!(providers::apply_app_settings(&mut c,&invalid).is_err());
    assert_eq!(c.settings().unwrap().model,"replacement-model");
}
