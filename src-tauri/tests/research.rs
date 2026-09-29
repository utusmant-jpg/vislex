use evidence_desk::{
    backup,
    case::{Case, Settings},
    research,
};
use serde_json::json;

fn setup() -> (tempfile::TempDir, Case) {
    let dir = tempfile::tempdir().unwrap();
    let case = Case::create(&dir.path().join("test.ledcase"), "Synthetic case").unwrap();
    (dir, case)
}

fn go_online(case: &mut Case) {
    case.save_settings(Settings { offline: false, allow_text: true, allow_images: false, model: "test-model".into() }).unwrap();
}

#[test]
fn research_browser_is_off_by_default_and_refused_while_offline() {
    let (_dir, mut case) = setup();
    assert!(!research::enabled(&case));
    assert!(research::grant(&case).unwrap().is_none());
    let error = research::set_grant(&mut case, true, &[]).unwrap_err().to_string();
    assert!(error.contains("offline"), "{error}");
    assert!(!research::enabled(&case));
    // Switching off is always allowed.
    research::set_grant(&mut case, false, &[]).unwrap();
    assert!(!research::enabled(&case));
}

#[test]
fn research_toggle_is_revisioned_audited_and_validates_sign_in_hosts() {
    let (_dir, mut case) = setup();
    go_online(&mut case);
    let first = research::set_grant(&mut case, true, &["Login.Firm.Example.".into(), "login.firm.example".into()]).unwrap();
    assert!(first.enabled && research::enabled(&case));
    assert_eq!(first.revision, 1);
    assert_eq!(first.sso_hosts, ["login.firm.example"]);
    assert_eq!(first.routes, ["api_keys"]);
    assert_eq!(first.approval_mode, "autonomous");
    let second = research::set_grant(&mut case, false, &[]).unwrap();
    assert_eq!(second.revision, 2);
    assert!(!research::enabled(&case));
    let idn = research::set_grant(&mut case, true, &["login.fïrm.example".into()]).unwrap();
    let stored = &idn.sso_hosts[0];
    assert!(stored.is_ascii() && stored.starts_with("login.xn--") && stored.ends_with(".example"), "internationalized names are stored in ASCII form: {stored}");
    for bad in ["https://login.firm.example", "login.firm.example/path", "localhost", "1.next.westlaw.com", "bad host", "user@firm.example", "*.firm.example", "login_.firm.example", "-login.firm.example", "login.firm.example:443", "10.0.0.1"] {
        assert!(research::set_grant(&mut case, true, &[bad.into()]).is_err(), "{bad}");
    }
    assert!(research::set_grant(&mut case, true, &vec!["a.example".to_string(); 11]).is_err());
    assert_eq!(research::grant(&case).unwrap().unwrap().revision, 3, "refused changes leave the grant unchanged");
    case.verify_audit().unwrap();
}

#[test]
fn applying_app_defaults_never_enables_the_research_browser() {
    let (_dir, mut case) = setup();
    go_online(&mut case);
    let defaults = json!({"config":{"provider":"openai","execution":"auto","review":"standard","pool":[]},"settings":{"offline":false,"allow_text":true,"allow_images":true,"model":"m","case_budget":0.,"input_per_million":0.,"output_per_million":0.}});
    evidence_desk::providers::apply_app_settings(&mut case, &defaults).unwrap();
    assert!(!research::enabled(&case));
    research::set_grant(&mut case, true, &[]).unwrap();
    evidence_desk::providers::apply_app_settings(&mut case, &defaults).unwrap();
    assert!(research::enabled(&case), "app defaults do not clear an explicit case choice either");
}

#[test]
fn research_toggle_survives_backup_and_restore() {
    let (dir, mut case) = setup();
    go_online(&mut case);
    let granted = research::set_grant(&mut case, true, &["login.firm.example".into()]).unwrap();
    let archive = dir.path().join("backup.age");
    backup::backup(&mut case, &archive, "test-only-passphrase-long").unwrap();
    let restored = backup::restore(&archive, &dir.path().join("restored"), "test-only-passphrase-long").unwrap();
    assert_eq!(research::grant(&restored).unwrap(), Some(granted));
    restored.verify_audit().unwrap();
}

#[test]
fn research_profile_must_stay_outside_the_case_folder() {
    let (dir, case) = setup();
    assert!(research::ensure_profile_boundary(&case.root, &case.root.join("research-profile")).is_err());
    assert!(research::ensure_profile_boundary(&case.root, &dir.path().join("elsewhere")).is_ok());
    assert!(research::ensure_profile_boundary(&case.root, dir.path()).is_err(), "a profile containing the case is refused");
}

#[test]
fn a_corrupt_research_grant_can_still_be_switched_off() {
    let (_dir, mut case) = setup();
    go_online(&mut case);
    case.set_meta("research_browser_grant", "{not json").unwrap();
    assert!(research::set_grant(&mut case, true, &[]).is_err());
    let off = research::set_grant(&mut case, false, &[]).unwrap();
    assert!(!off.enabled && !research::enabled(&case));
}

// ---- R43: the agent's research tools ----

fn case_with_task(research_on: bool) -> (tempfile::TempDir, Case, String) {
    research::tools::mark_runtime_available();
    let (dir, mut case) = setup();
    let source = dir.path().join("note.txt");
    std::fs::write(&source, "A synthetic note.\n").unwrap();
    case.import_files(&[source.to_string_lossy().into()], "Synthetic").unwrap();
    let sid = case.sources().unwrap()[0].id.clone();
    go_online(&mut case);
    if research_on {
        research::set_grant(&mut case, true, &[]).unwrap();
    }
    let task = evidence_desk::agent::start(&mut case, "Research the duty of care", "investigate", vec![sid], vec![], 0.).unwrap();
    (dir, case, task)
}

fn call(name: &str, args: serde_json::Value) -> serde_json::Value {
    json!({"status": "completed", "usage": {"input_tokens": 10, "output_tokens": 5}, "output": [{"type": "function_call", "call_id": evidence_desk::case::id(), "name": name, "arguments": args.to_string()}]})
}

fn last_action(case: &Case, task: &str) -> serde_json::Value {
    case.actions(task).unwrap().as_array().unwrap().last().cloned().unwrap()
}

#[test]
fn research_tools_are_offered_only_when_the_case_switch_is_on() {
    let names = |case: &mut Case, task: &str| -> Vec<String> {
        let request = evidence_desk::agent::prepare_request(case, task).unwrap();
        request.body["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str().map(str::to_string)).collect()
    };
    let (_dir, mut case, task) = case_with_task(false);
    assert!(!names(&mut case, &task).iter().any(|name| name.starts_with("research_")));
    let (_dir, mut case, task) = case_with_task(true);
    let offered = names(&mut case, &task);
    for tool in research::tools::TOOL_NAMES {
        assert!(offered.iter().any(|name| name == tool), "{tool} not offered");
    }
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    assert!(request.body["instructions"].as_str().unwrap().contains("RESEARCH BROWSER"));
}

#[test]
fn research_calls_are_checked_audited_and_limited_before_any_browser_action() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();

    // Off-site address: refused, reason stored for the tool result, no job.
    let off_site = call("research_navigate", json!({"url": "https://evil.example/"}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &off_site).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("only the research site"));

    // Credential-looking or locator text is refused before typing.
    let leak = call("research_act", json!({"action": "type", "ref": "e1", "snapshot_version": 1, "text": "evidence:abc#L1-L2", "key": null}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &leak).unwrap().is_none());

    // A query is audited with its text before it is sent.
    let query = call("research_act", json!({"action": "type", "ref": "e1", "snapshot_version": 1, "text": "duty of care /s negligence", "key": null}));
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &query).unwrap().expect("job");
    assert_eq!(job.name, "research_act");
    let audited: String = case.db.query_row("SELECT data FROM audit WHERE event='research_query_requested' ORDER BY seq DESC LIMIT 1", [], |row| row.get(0)).unwrap();
    assert!(audited.contains("duty of care /s negligence"));

    // Page limit and per-minute rate from the grant's caps.
    let mut stored: serde_json::Value = serde_json::from_str(&case.meta("research_browser_grant").unwrap().unwrap()).unwrap();
    stored["caps"]["documents"] = json!(3);
    stored["caps"]["navigations_per_minute"] = json!(100);
    case.set_meta("research_browser_grant", &stored.to_string()).unwrap();
    let navigate = call("research_navigate", json!({"url": "https://1.next.westlaw.com/Search/Home.html"}));
    for _ in 0..3 {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &navigate).unwrap().is_some());
    }
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &navigate).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("research pages"));
    stored["caps"]["documents"] = json!(100);
    stored["caps"]["navigations_per_minute"] = json!(3);
    case.set_meta("research_browser_grant", &stored.to_string()).unwrap();
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &navigate).unwrap().is_none(), "the fourth page change within a minute is refused");
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("a minute"));

    // A settings change during the task stops further research in it.
    research::set_grant(&mut case, true, &["login.firm.example".into()]).unwrap();
    let status = call("research_status", json!({}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &status).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("settings changed"));
    case.verify_audit().unwrap();
}

#[test]
fn research_results_reach_the_model_only_for_the_exact_call() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let args = json!({"scope": "interactive", "find": null, "delta": false, "max_chars": null});
    let response = call("research_snapshot", args.clone());
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &response).unwrap().expect("job");
    research::tools::stash(&case, &job, Ok(json!({"snapshot": {"text": "- searchbox \"Search\" [ref=e2]"}}))).unwrap();
    assert!(evidence_desk::agent::receive(&mut case, &task, &request.transmission, response).unwrap());
    let receipt = last_action(&case, &task);
    assert_eq!(receipt["name"], "research_snapshot");
    assert!(receipt["output"].as_str().unwrap().contains("searchbox"));

    // Without a stored result (not run through the desktop) the call fails clearly.
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, call("research_snapshot", args.clone())).unwrap();
    assert!(last_action(&case, &task)["output"].as_str().unwrap().contains("not run"));

    // A result stored for different arguments is not handed to another call.
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let other = json!({"scope": "full", "find": null, "delta": false, "max_chars": null});
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_snapshot", other)).unwrap().unwrap();
    research::tools::stash(&case, &job, Ok(json!({"secret": "for the other call"}))).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, call("research_snapshot", args)).unwrap();
    let output = last_action(&case, &task)["output"].as_str().unwrap().to_string();
    assert!(output.contains("does not match") && !output.contains("for the other call"));
}

#[test]
fn research_jobs_run_against_the_page_through_the_driver() {
    use research::{driver::FakeDriver, snapshot::Session, tools::{run_job, Job}};
    let page = FakeDriver::new(|method, params| {
        let function = params["functionDeclaration"].as_str().unwrap_or_default();
        Ok(match method {
            "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1"}}}),
            "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
            "Runtime.evaluate" if params["expression"].as_str().unwrap_or_default().starts_with("({url: location.href") => json!({"result": {"value": {"url": "https://1.next.westlaw.com/Document/x", "title": "Opinion", "ready": "complete"}}}),
            "Runtime.evaluate" => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("Boolean(globalThis.__vislex)") => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("ariaSnapshot") => json!({"result": {"value": {"text": "- heading \"Opinion\" [level=1] [ref=e2]", "url": "https://1.next.westlaw.com/Document/x", "title": "Opinion"}}}),
            "Runtime.callFunctionOn" if function.contains("innerText") => json!({"result": {"value": {"url": "https://1.next.westlaw.com/Document/x", "title": "Opinion", "lines": ["Line zero", "Line one", "Line two"]}}}),
            other => anyhow::bail!("unexpected {other}"),
        })
    });
    let mut session = Session::new(page);
    let job = |name: &str, args: serde_json::Value| Job { task: "t".into(), name: name.into(), args, args_hash: String::new(), sso_hosts: vec![], pacing: std::time::Duration::ZERO, grant_revision: 1 };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let snapshot = runtime.block_on(run_job(&mut session, &job("research_snapshot", json!({"scope": "full", "find": null, "delta": false, "max_chars": null})))).unwrap();
    assert!(snapshot["snapshot"]["text"].as_str().unwrap().contains("Opinion"));
    assert!(snapshot["note"].as_str().unwrap().contains("untrusted"));
    let read = runtime.block_on(run_job(&mut session, &job("research_read_page", json!({"offset": 1, "count": 1})))).unwrap();
    assert_eq!(read["lines"], json!([{"n": 1, "text": "Line one"}]));
    assert_eq!(read["next_offset"], 2);
    let stale = runtime.block_on(run_job(&mut session, &job("research_act", json!({"action": "click", "ref": "e2", "snapshot_version": 0, "text": null, "key": null}))));
    assert!(stale.unwrap_err().to_string().contains("new snapshot"));
}

#[test]
fn the_model_cannot_mint_authority_objects_without_retrieval() {
    let (_dir, mut case, task) = case_with_task(false);
    let tools = evidence_desk::agent::tools("investigate");
    let schema = tools.iter().find(|tool| tool["name"] == "write_evidence_object").unwrap();
    assert!(!schema["parameters"]["properties"]["kind"]["enum"].as_array().unwrap().contains(&json!("authority")));
    let error = evidence_desk::agent::execute_tool(&mut case, &task, "write_evidence_object", &json!({"id": null, "base_revision": 0, "kind": "authority", "title": "Invented v. Case", "content": "{}", "locators": [], "dependencies": [], "start_seconds": null, "end_seconds": null})).unwrap_err();
    assert!(error.to_string().contains("retrieved"));
}

#[test]
fn background_review_tasks_never_get_research_tools() {
    let (_dir, case, task) = case_with_task(true);
    assert!(research::tools::exposed(&case, &task).unwrap());
    case.set_meta(&format!("automatic_task:{task}"), "true").unwrap();
    assert!(!research::tools::exposed(&case, &task).unwrap());
}


// ---- R43/R44 review fixes ----

fn research_job(name: &str, args: serde_json::Value) -> research::tools::Job {
    research::tools::Job { task: "t".into(), name: name.into(), args, args_hash: String::new(), sso_hosts: vec![], pacing: std::time::Duration::ZERO, grant_revision: 1 }
}

/// A page whose address is `location` and whose clicks move it to `after_click`.
fn page_at(location: &'static str, after_click: &'static str) -> research::driver::FakeDriver {
    let clicked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    research::driver::FakeDriver::new(move |method, params| {
        let function = params["functionDeclaration"].as_str().unwrap_or_default();
        let here = if clicked.load(std::sync::atomic::Ordering::SeqCst) { after_click } else { location };
        Ok(match method {
            "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1"}}}),
            "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
            "Runtime.evaluate" if params["expression"].as_str().unwrap_or_default().starts_with("({url: location.href") => json!({"result": {"value": {"url": here, "title": "t", "ready": "complete"}}}),
            "Runtime.evaluate" => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("Boolean(globalThis.__vislex)") => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("ariaSnapshot") => json!({"result": {"value": {"text": "- link \"Result\" [ref=e2]", "url": here, "title": "t"}}}),
            "Runtime.callFunctionOn" if function.contains("stale ref") => json!({"result": {"objectId": "obj-2"}}),
            "Runtime.callFunctionOn" if function.contains("password_on_page") => json!({"result": {"value": {"tag": "a", "input_type": "", "autocomplete": "", "name": "", "id": "", "aria_label": "", "placeholder": "", "role": "", "href": "", "text": "Result", "title": "", "content_editable": false, "form_action": "", "password_on_page": false, "otp_on_page": false}}}),
            "Runtime.callFunctionOn" if function.contains("elementFromPoint") => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("innerText") => json!({"result": {"value": {"missing": true, "url": here, "title": "t"}}}),
            "DOM.getBoxModel" => json!({"model": {"content": [0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0]}}),
            "Input.dispatchMouseEvent" => {
                if params["type"] == "mouseReleased" {
                    clicked.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                json!({})
            }
            "DOM.scrollIntoViewIfNeeded" | "Page.stopLoading" => json!({}),
            other => anyhow::bail!("unexpected {other}"),
        })
    })
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

#[test]
fn the_agent_never_acts_on_sign_in_or_outside_pages() {
    use research::{snapshot::Session, tools::run_job};
    let mut session = Session::new(page_at("https://signon.thomsonreuters.com/?returnto=x", "https://signon.thomsonreuters.com/"));
    for name in ["research_snapshot", "research_read_page"] {
        let args = if name == "research_snapshot" { json!({"scope": "full", "find": null, "delta": false, "max_chars": null}) } else { json!({"offset": 0, "count": 10}) };
        assert!(block_on(run_job(&mut session, &research_job(name, args))).unwrap_err().to_string().contains("sign-in"), "{name}");
    }
    let status = block_on(run_job(&mut session, &research_job("research_status", json!({})))).unwrap();
    assert_eq!(status["on_research_site"], false);
    assert!(status.get("title").is_none(), "no page content from a sign-in page");
    assert!(!session.driver().methods().iter().any(|method| method == "Runtime.callFunctionOn"), "nothing read from the sign-in page");
}

#[test]
fn a_click_that_lands_on_a_sign_in_page_stops_and_hands_back() {
    use research::{snapshot::{Scope, Session}, tools::run_job};
    let mut session = Session::new(page_at("https://1.next.westlaw.com/Search/Results.html", "https://signon.thomsonreuters.com/?expired=1"));
    let version = block_on(session.snapshot(Scope::Full, None, false, None)).unwrap().version;
    let click = research_job("research_act", json!({"action": "click", "ref": "e2", "snapshot_version": version, "text": null, "key": null}));
    assert!(block_on(run_job(&mut session, &click)).unwrap_err().to_string().contains("sign-in"));
    assert!(session.driver().methods().contains(&"Page.stopLoading".to_string()));
}

#[test]
fn reading_needs_a_main_region_and_never_falls_back_to_the_whole_page() {
    use research::{snapshot::Session, tools::run_job};
    let mut session = Session::new(page_at("https://1.next.westlaw.com/Home", "https://1.next.westlaw.com/Home"));
    let error = block_on(run_job(&mut session, &research_job("research_read_page", json!({"offset": 0, "count": 5})))).unwrap_err();
    assert!(error.to_string().contains("main content"));
}

#[test]
fn stop_abandons_a_running_research_job_promptly() {
    use research::{driver::Driver, snapshot::Session, tools::run_job};
    struct Slow;
    impl Driver for Slow {
        fn call(&self, _method: &str, _params: serde_json::Value) -> impl std::future::Future<Output = anyhow::Result<serde_json::Value>> + Send {
            async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok(json!({}))
            }
        }
    }
    let mut session = Session::new(Slow);
    let started = std::time::Instant::now();
    let job = research_job("research_status", json!({}));
    let outcome = block_on(async {
        tokio::select! {
            result = run_job(&mut session, &job) => Some(result),
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => None,
        }
    });
    assert!(outcome.is_none() && started.elapsed() < std::time::Duration::from_millis(250));
}

#[test]
fn addresses_with_queries_are_refused_and_clicks_are_limited() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    for url in ["https://1.next.westlaw.com/Search/Results.html?query=client+name", "https://1.next.westlaw.com/Document#facts", &format!("https://1.next.westlaw.com/{}", "a".repeat(2_100))] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_navigate", json!({"url": url}))).unwrap().is_none(), "{url}");
    }
    // A small action limit in the stored grant binds clicks and key presses.
    let mut grant: serde_json::Value = serde_json::from_str(&case.meta("research_browser_grant").unwrap().unwrap()).unwrap();
    grant["caps"]["actions"] = json!(2);
    case.set_meta("research_browser_grant", &grant.to_string()).unwrap();
    let click = call("research_act", json!({"action": "click", "ref": "e2", "snapshot_version": 1, "text": null, "key": null}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &click).unwrap().is_some());
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &click).unwrap().is_some());
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &click).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("research actions"));
}

#[test]
fn an_unreadable_research_setting_never_blocks_other_ai_work() {
    let (_dir, mut case, task) = case_with_task(true);
    case.set_meta("research_browser_grant", "{not json").unwrap();
    assert!(!research::tools::exposed(&case, &task).unwrap());
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    assert!(!request.body["tools"].as_array().unwrap().iter().any(|tool| tool["name"].as_str().unwrap_or_default().starts_with("research_")));
}

#[test]
fn switching_research_off_mid_job_discards_its_result() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let args = json!({"scope": "interactive", "find": null, "delta": false, "max_chars": null});
    let response = call("research_snapshot", args);
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &response).unwrap().expect("job");
    research::tools::stash(&case, &job, Ok(json!({"snapshot": {"text": "page text that must not reach the model"}}))).unwrap();
    research::set_grant(&mut case, false, &[]).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, response).unwrap();
    let output = last_action(&case, &task)["output"].as_str().unwrap().to_string();
    assert!(output.contains("switched off") && !output.contains("must not reach"));
    // Switching back on (a new revision) does not revive research in this task.
    research::set_grant(&mut case, true, &[]).unwrap();
    assert!(!research::tools::exposed(&case, &task).unwrap());
}
