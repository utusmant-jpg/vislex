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
    assert_eq!(first.routes, ["api_keys", "chatgpt_subscription"], "grants written since R37/R49 cover both access routes");
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
fn research_calls_are_checked_and_audited_before_any_browser_action() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();

    // A private-network address: refused, reason stored for the tool result, no job.
    let private = call("research_navigate", json!({"url": "http://192.168.0.10/"}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &private).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("private-network"));

    // Unprintable text is refused before typing.
    let bell = call("research_act", json!({"action": "type", "ref": "e1", "snapshot_version": 1, "text": "a\u{7}b", "key": null}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &bell).unwrap().is_none());

    // A query is audited with its text before it is sent.
    let query = call("research_act", json!({"action": "type", "ref": "e1", "snapshot_version": 1, "text": "duty of care /s negligence", "key": null}));
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &query).unwrap().expect("job");
    assert_eq!(job.name, "research_act");
    let audited: String = case.db.query_row("SELECT data FROM audit WHERE event='research_query_requested' ORDER BY seq DESC LIMIT 1", [], |row| row.get(0)).unwrap();
    assert!(audited.contains("duty of care /s negligence"));


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
fn the_agent_works_on_sign_in_pages_but_not_on_private_addresses() {
    use research::{snapshot::Session, tools::run_job};
    // Sign-in pages are ordinary pages for the agent (it may click "Access with single sign-on").
    let mut session = Session::new(page_at("https://signon.thomsonreuters.com/?returnto=x", "https://signon.thomsonreuters.com/"));
    let snapshot = block_on(run_job(&mut session, &research_job("research_snapshot", json!({"scope": "full", "find": null, "delta": false, "max_chars": null})))).unwrap();
    assert!(snapshot["snapshot"]["text"].as_str().unwrap().contains("ref=e2"));
    let status = block_on(run_job(&mut session, &research_job("research_status", json!({})))).unwrap();
    assert_eq!((status["usable"].as_bool(), status["host"].as_str()), (Some(true), Some("signon.thomsonreuters.com")));
    // A page on the local network is not read or acted on.
    let mut session = Session::new(page_at("http://192.168.1.1/admin", "http://192.168.1.1/admin"));
    for name in ["research_snapshot", "research_read_page"] {
        let args = if name == "research_snapshot" { json!({"scope": "full", "find": null, "delta": false, "max_chars": null}) } else { json!({"offset": 0, "count": 10}) };
        assert!(block_on(run_job(&mut session, &research_job(name, args))).unwrap_err().to_string().contains("private-network"), "{name}");
    }
    assert!(!session.driver().methods().iter().any(|method| method == "Runtime.callFunctionOn"), "nothing read from the local page");
}

#[test]
fn a_click_that_lands_on_a_private_address_stops() {
    use research::{snapshot::{Scope, Session}, tools::run_job};
    // Landing on a sign-in page is fine.
    let mut session = Session::new(page_at("https://1.next.westlaw.com/Search/Results.html", "https://signon.thomsonreuters.com/?expired=1"));
    let version = block_on(session.snapshot(Scope::Full, None, false, None)).unwrap().version;
    let click = research_job("research_act", json!({"action": "click", "ref": "e2", "snapshot_version": version, "text": null, "key": null}));
    let result = block_on(run_job(&mut session, &click)).unwrap();
    assert_eq!((result["navigated"].as_bool(), result["url"].as_str()), (Some(true), Some("https://signon.thomsonreuters.com/?expired=1")));
    // Landing inside the local network stops the page.
    let mut session = Session::new(page_at("https://www.example.com/", "http://127.0.0.1:8080/admin"));
    let version = block_on(session.snapshot(Scope::Full, None, false, None)).unwrap().version;
    let click = research_job("research_act", json!({"action": "click", "ref": "e2", "snapshot_version": version, "text": null, "key": null}));
    assert!(block_on(run_job(&mut session, &click)).unwrap_err().to_string().contains("private-network"));
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
fn any_web_address_opens_and_nothing_is_capped() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    for url in ["https://1.next.westlaw.com/Search/Results.html?query=duty+of+care", "https://www.google.com/search?q=negligent+hiring", "https://www.courtlistener.com/opinion/1/x/#facts"] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_navigate", json!({"url": url}))).unwrap().is_some(), "{url}");
    }
    let audited: String = case.db.query_row("SELECT data FROM audit WHERE event='research_navigation_requested' ORDER BY seq DESC LIMIT 1", [], |row| row.get(0)).unwrap();
    assert!(audited.contains("courtlistener"), "{audited}");
    // Old per-task limits in a stored grant no longer bind.
    let mut grant: serde_json::Value = serde_json::from_str(&case.meta("research_browser_grant").unwrap().unwrap()).unwrap();
    grant["caps"]["actions"] = json!(2);
    grant["caps"]["documents"] = json!(1);
    grant["caps"]["navigations_per_minute"] = json!(1);
    case.set_meta("research_browser_grant", &grant.to_string()).unwrap();
    let click = call("research_act", json!({"action": "click", "ref": "e2", "snapshot_version": 1, "text": null, "key": null}));
    for _ in 0..200 {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &click).unwrap().is_some());
    }
    let navigate = call("research_navigate", json!({"url": "https://1.next.westlaw.com/Home"}));
    for _ in 0..100 {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &navigate).unwrap().is_some());
    }
    // Local and private-network addresses are refused with a reason.
    for url in ["http://localhost:1420/", "http://10.0.0.1/", "file:///C:/Windows/win.ini"] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_navigate", json!({"url": url}))).unwrap().is_none(), "{url}");
        assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("private-network"), "{url}");
    }
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

// ---- R46/R47: research_capture, citable evidence and task-created sources ----

/// A document page on the research host. Outside debug test mode the agent acts only on research
/// hosts, so these tests give that host a synthetic playbook entry; the shipped loopback fixture
/// entry is exercised by the native journey against scripts/research-fixture-server.mjs.
const DOCUMENT_URL: &str = "https://1.next.westlaw.com/Document/Ifixture/View/FullText.html";
const RESULTS_URL: &str = "https://1.next.westlaw.com/Search/Results.html";
const HEADNOTE: &str = "HEADNOTE EDITORIAL: negligence key number 272k1 synopsis";
const SCRIPT_MARKER: &str = "SCRIPT MARKER 7731";
/// What the page's capture function returns for the fixture: the opinion region with the
/// headnote block, script and hidden input removed.
const SANITIZED: &str = "<main id=\"opinion\"><h1>Smith v. Synthetic Holdings</h1><p class=\"cite\">123 F.3d 456 (9th Cir. 2001)</p><section><p>OPINION</p><p>A person owes a duty of reasonable care to foreseeable plaintiffs.</p><p>The duty extends to conduct that creates a foreseeable risk of harm.</p></section></main>";
const LINES: &[&str] = &[
    "Smith v. Synthetic Holdings",
    "123 F.3d 456 (9th Cir. 2001)",
    "OPINION",
    "A person owes a duty of reasonable care to foreseeable plaintiffs.",
    "The duty extends to conduct that creates a foreseeable risk of harm.",
];

fn full_page() -> String {
    format!("<html><head><title>Smith</title></head><body><nav>Signed in as Synthetic User</nav><main id=\"opinion\"><h1>Smith v. Synthetic Holdings</h1><div class=\"headnote\">{HEADNOTE}</div><p>OPINION</p><script>window.x='{SCRIPT_MARKER}'</script></main></body></html>")
}

fn document_playbook() -> research::playbook::Playbook {
    research::playbook::Playbook::with_entries(vec![research::playbook::Entry {
        id: "synthetic-document".into(),
        hosts: vec!["1.next.westlaw.com".into()],
        content_root: "main#opinion".into(),
        editorial: vec![".headnote".into(), ".synopsis".into()],
        test_only: true,
        status: "test".into(),
    }])
}

/// A scripted research page at `url`. The capture and read functions answer from the selectors
/// they receive as data: editorial text is left out only when `.headnote` was passed.
fn fixture_respond(url: &str, method: &str, params: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let function = params["functionDeclaration"].as_str().unwrap_or_default();
    let document = url.contains("/Document/");
    let hides = |index: usize| params["arguments"][index]["value"].as_array().is_some_and(|selectors| selectors.contains(&json!(".headnote")));
    Ok(match method {
        "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1"}}}),
        "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
        "Runtime.evaluate" if params["expression"].as_str().unwrap_or_default().starts_with("({url: location.href") => json!({"result": {"value": {"url": url, "title": "Smith", "ready": "complete"}}}),
        "Runtime.evaluate" => json!({"result": {"value": true}}),
        "Runtime.callFunctionOn" if function.contains("Boolean(globalThis.__vislex)") => json!({"result": {"value": true}}),
        "Runtime.callFunctionOn" if function.contains("ariaSnapshot") => {
            json!({"result": {"value": {"text": if hides(1) { "- heading \"Smith\" [ref=e1]".to_string() } else { format!("- text: {HEADNOTE}") }, "url": url, "title": "Smith"}}})
        }
        // The KeyCite signals a document page shows.
        "Runtime.callFunctionOn" if function == research::playbook::westlaw::KEYCITE_FN => json!({"result": {"value": {
            "url": url,
            "flags": if document { vec!["Yellow Flag - Negative Treatment"] } else { vec![] },
            "tabs": if document { json!([{"label": "Negative Treatment", "count": 1, "url": format!("{url}#negative")}, {"label": "History", "count": 2, "url": ""}, {"label": "Citing References", "count": 9, "url": ""}]) } else { json!([]) },
        }}}),
        "Runtime.callFunctionOn" if function.contains("content_root") => {
            let entries = params["arguments"][0]["value"].as_array().cloned().unwrap_or_default();
            let host = url.parse::<reqwest::Url>().unwrap().host_str().unwrap().to_string();
            let entry = entries.iter().find(|entry| entry["hosts"].as_array().unwrap().iter().any(|allowed| allowed == &json!(host)));
            match entry {
                Some(entry) if document => {
                    let mut lines: Vec<String> = LINES.iter().map(|line| line.to_string()).collect();
                    if !hides(1) {
                        lines.insert(1, HEADNOTE.into());
                    }
                    json!({"result": {"value": {"url": url, "title": "Smith", "entry": entry["id"], "document_text": true, "lines": lines, "html": SANITIZED, "page_html": full_page()}}})
                }
                        None if document => {
                    // No surveyed entry: the main region as shown, editorial content included.
                    let mut lines: Vec<String> = LINES.iter().map(|line| line.to_string()).collect();
                    lines.insert(1, HEADNOTE.into());
                    json!({"result": {"value": {"url": url, "title": "Smith", "entry": "generic", "document_text": true, "lines": lines, "html": SANITIZED, "page_html": full_page()}}})
                }
                _ => json!({"result": {"value": {"url": url, "title": "Smith", "entry": entry.map(|entry| entry["id"].clone()).unwrap_or(json!("generic")), "document_text": false}}}),
            }
        }
        "Runtime.callFunctionOn" if function.contains("innerText") => {
            let mut lines: Vec<String> = LINES.iter().map(|line| line.to_string()).collect();
            if !hides(0) {
                lines.insert(1, HEADNOTE.into());
            }
            json!({"result": {"value": {"url": url, "title": "Smith", "lines": lines}}})
        }
        other => anyhow::bail!("unexpected {other}"),
    })
}

fn fixture_page(url: &'static str) -> research::driver::FakeDriver {
    research::driver::FakeDriver::new(move |method, params| fixture_respond(url, method, params))
}

fn capture_args(start: u64, end: u64) -> serde_json::Value {
    json!({"title": "Smith v. Synthetic Holdings", "jurisdiction": "9th Cir.", "relevant_date": "2001-05-01", "citation_text": "123 F.3d 456", "proposition": "A duty of reasonable care is owed to foreseeable plaintiffs.", "quote_start_line": start, "quote_end_line": end})
}

/// Runs one research call the way the desktop does: checks under the lock, the job against the
/// page, the stash, then the agent loop's tool arm. Returns the receipt.
fn run_research(case: &mut Case, task: &str, page: research::driver::FakeDriver, playbook: &research::playbook::Playbook, name: &str, args: serde_json::Value) -> serde_json::Value {
    let request = evidence_desk::agent::prepare_request(case, task).unwrap();
    let response = call(name, args);
    case.set_meta(&format!("research_result:{task}"), "").unwrap();
    if let Some(job) = research::tools::prepare_research(case, task, &request.transmission, &response).unwrap() {
        let mut session = research::snapshot::Session::new(page);
        let outcome = block_on(research::tools::run_job_with(&mut session, &job, playbook));
        // No model-controlled string ever becomes page code.
        for (_, params) in session.driver().calls() {
            let code = format!("{}{}", params["functionDeclaration"].as_str().unwrap_or_default(), params["expression"].as_str().unwrap_or_default());
            assert!(!code.contains("Synthetic Holdings") && !code.contains("foreseeable plaintiffs"));
        }
        research::tools::stash(case, &job, outcome).unwrap();
    }
    evidence_desk::agent::receive(case, task, &request.transmission, response).unwrap();
    last_action(case, task)
}

fn staged_files(case: &Case) -> usize {
    std::fs::read_dir(case.root.join("staging")).unwrap().count()
}

fn task_scope(case: &Case, task: &str) -> Vec<String> {
    serde_json::from_str(&case.db.query_row::<String, _, _>("SELECT scope FROM tasks WHERE id=?", [task], |row| row.get(0)).unwrap()).unwrap()
}

#[test]
fn research_capture_publishes_citable_evidence_without_editorial_content() {
    let (_dir, mut case, task) = case_with_task(true);
    let original = case.sources().unwrap()[0].id.clone();
    // A task started before the capture keeps its own scope.
    let other = evidence_desk::agent::start(&mut case, "Another question", "investigate", vec![original.clone()], vec![], 0.).unwrap();
    let staged_before = staged_files(&case);

    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(3, 4));
    assert_eq!(receipt["status"], "complete", "{receipt}");
    let output: serde_json::Value = serde_json::from_str(receipt["output"].as_str().unwrap()).unwrap();
    let source = output["source_id"].as_str().unwrap().to_string();
    let locator = output["locator"].as_str().unwrap().to_string();
    assert_eq!(locator, format!("evidence:{source}#R1L4-L5"));
    assert_eq!(output["citation_mismatch"], false);
    assert!(output["next"].as_str().unwrap().contains("stale"));
    assert!(!receipt["output"].as_str().unwrap().contains(HEADNOTE) && !receipt["output"].as_str().unwrap().contains("<main"), "the document itself never returns to the model");

    // The original is exactly the sanitised document, content-addressed and immutable.
    let stored = std::fs::read(case.source_path(&source).unwrap()).unwrap();
    assert_eq!(stored, SANITIZED.as_bytes());
    assert_eq!(case.source(&source).unwrap().sha256, evidence_desk::case::digest(SANITIZED.as_bytes()));
    let stored = String::from_utf8(stored).unwrap();
    assert!(!stored.contains(HEADNOTE) && !stored.contains(SCRIPT_MARKER) && !stored.contains("Signed in as"));
    assert_eq!(staged_files(&case), staged_before, "no staged copy remains");

    // Searchable extract with the quoted lines, without editorial text; the locator validates
    // against its immutable revision.
    let found = case.search("foreseeable", 0).unwrap();
    assert!(found["results"].as_array().unwrap().iter().any(|hit| hit["source_id"] == source), "{found}");
    let text = case.read_text(&source, 1, 20).unwrap();
    assert!(text["text"].as_str().unwrap().contains("reasonable care") && !text["text"].as_str().unwrap().contains(HEADNOTE));
    assert_eq!(case.validate_citation(&locator).unwrap()["revision_binding"], "pinned");

    // Authority provenance, unreviewed.
    let authority = evidence_desk::evidence::read(&case, output["authority_id"].as_str().unwrap(), None).unwrap();
    assert_eq!(authority["kind"], "authority");
    assert_eq!(authority["actor"], "research_browser_adapter");
    assert_eq!(authority["review"], "unreviewed");
    assert_eq!(authority["source_ids"], json!([source]));
    assert_eq!(authority["locators"], json!([locator]));
    let content: serde_json::Value = serde_json::from_str(authority["content"].as_str().unwrap()).unwrap();
    assert_eq!(content["url"], DOCUMENT_URL);
    assert_eq!(content["citation"], json!({"raw": "123 F.3d 456", "claimed": "123 F.3d 456", "mismatch": false, "claimed_in_text": false, "parallel": ["123 F.3d 456"]}));
    // The KeyCite signals the page showed at capture time are stored with the authority.
    let keycite = &content["keycite"];
    assert_eq!((keycite["flag"].as_str(), keycite["flag_text"].as_str()), (Some("yellow"), Some("Yellow Flag - Negative Treatment")));
    assert_eq!((keycite["negative_treatment"].as_u64(), keycite["history"].as_u64(), keycite["citing_references"].as_u64()), (Some(1), Some(2), Some(9)));
    assert!(keycite["observed_at"].is_string());
    assert_eq!(output["keycite"]["flag"], "yellow");
    assert_eq!(content["jurisdiction"], "9th Cir.");
    assert_eq!(content["relevant_date"], "2001-05-01");
    assert_eq!(content["retrieved_by"]["task"], task);
    assert_eq!(content["retrieved_by"]["tool"], "research_capture");
    assert_eq!(content["retrieved_by"]["grant_revision"], 1);
    assert_eq!(content["tr_editorial"], "excluded");
    assert_eq!(content["quote"]["exact"], format!("{}\n{}", LINES[3], LINES[4]));
    assert_eq!(content["quote"]["locator"], locator);
    assert_eq!(content["full_page_sha256"], evidence_desk::case::digest(full_page().as_bytes()));
    assert_eq!(content["treatment_status"], "not_checked");
    assert_eq!(content["proposition_support"], "not_assessed");
    assert!(!content["limitations"].as_array().unwrap().is_empty() && content["retrieved_at"].is_string());
    assert!(!authority["content"].as_str().unwrap().contains(HEADNOTE) && !authority["content"].as_str().unwrap().contains("Signed in as"));

    // D2: the capturing task, and only it, may read the source it created.
    assert_eq!(task_scope(&case, &task), [original.clone(), source.clone()]);
    assert_eq!(task_scope(&case, &other), [original.clone()]);
    let read = json!({"source_id": source, "start": 1, "count": 5});
    assert!(evidence_desk::agent::execute_tool(&mut case, &task, "read_text", &read).is_ok());
    assert!(evidence_desk::agent::execute_tool(&mut case, &other, "read_text", &read).unwrap_err().to_string().contains("outside task scope"));
    assert_eq!(case.meta(&format!("task_created_sources:{task}")).unwrap().unwrap(), json!([source]).to_string());
    for event in ["research_capture_requested", "task_scope_expanded", "research_capture_published"] {
        let count: i64 = case.db.query_row("SELECT count(*) FROM audit WHERE event=?", [event], |row| row.get(0)).unwrap();
        assert_eq!(count, 1, "{event}");
    }
    let published: String = case.db.query_row("SELECT data FROM audit WHERE event='research_capture_published'", [], |row| row.get(0)).unwrap();
    assert!(published.contains(&source) && published.contains(&locator) && !published.contains(HEADNOTE));
    case.verify_audit().unwrap();

    // Capturing the same document again reuses the source and its extract revision.
    let again = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(0, 1));
    let again: serde_json::Value = serde_json::from_str(again["output"].as_str().unwrap()).unwrap();
    assert_eq!(again["source_id"], json!(source));
    assert_eq!(again["locator"], json!(format!("evidence:{source}#R1L1-L2")));
    assert_eq!(again["scope_expanded"], false);
    assert_eq!(task_scope(&case, &task).len(), 2);
}

#[test]
fn review_tasks_created_after_a_capture_can_read_it() {
    research::tools::mark_runtime_available();
    let (dir, mut case) = setup();
    let note = dir.path().join("note.txt");
    std::fs::write(&note, "A synthetic note.\n").unwrap();
    case.import_files(&[note.to_string_lossy().into()], "Synthetic").unwrap();
    let original = case.sources().unwrap()[0].id.clone();
    go_online(&mut case);
    research::set_grant(&mut case, true, &[]).unwrap();
    evidence_desk::providers::save(&mut case, evidence_desk::providers::Config { review: evidence_desk::providers::Review::Challenge, ..Default::default() }).unwrap();
    let task = evidence_desk::agent::start(&mut case, "Research the duty of care", "investigate", vec![original], vec![], 0.).unwrap();
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(3, 3));
    assert_eq!(receipt["status"], "complete", "{receipt}");
    let source = serde_json::from_str::<serde_json::Value>(receipt["output"].as_str().unwrap()).unwrap()["source_id"].as_str().unwrap().to_string();
    assert!(evidence_desk::teams::request_review(&case, &task, "Draft relying on the capture").unwrap());
    let children = evidence_desk::teams::prepare(&mut case, &task, "review").unwrap();
    assert!(!children.is_empty());
    for child in children {
        assert!(task_scope(&case, &child).contains(&source));
        let read = evidence_desk::agent::execute_tool(&mut case, &child, "read_text", &json!({"source_id": source, "start": 1, "count": 2})).unwrap();
        assert!(read["text"].as_str().unwrap().contains("Smith v. Synthetic Holdings"));
    }
}

#[test]
fn a_failed_capture_rolls_back_and_leaves_no_files() {
    let (_dir, mut case, task) = case_with_task(true);
    let sources_before = case.sources().unwrap().len();
    let staged_before = staged_files(&case);
    let original = case.root.join("originals").join(evidence_desk::case::digest(SANITIZED.as_bytes()));
    // Run the job, then stop the task before the tool arm publishes.
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let args = capture_args(3, 4);
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_capture", args.clone())).unwrap().expect("job");
    let mut session = research::snapshot::Session::new(fixture_page(DOCUMENT_URL));
    let bundle = block_on(research::tools::run_job_with(&mut session, &job, &document_playbook())).unwrap();
    evidence_desk::agent::pause(&mut case, &task, "Stopped").unwrap();
    let error = research::publish(&mut case, &task, &bundle, &args).unwrap_err().to_string();
    assert!(error.contains("no longer running"), "{error}");
    assert_eq!(case.sources().unwrap().len(), sources_before);
    assert_eq!(staged_files(&case), staged_before);
    assert!(!original.exists(), "the original moved into place is removed with its rows");
    let objects: i64 = case.db.query_row("SELECT count(*) FROM evidence_objects", [], |row| row.get(0)).unwrap();
    assert_eq!(objects, 0);
    let published: i64 = case.db.query_row("SELECT count(*) FROM audit WHERE event IN ('research_capture_published','task_scope_expanded')", [], |row| row.get(0)).unwrap();
    assert_eq!(published, 0);
    assert!(case.meta(&format!("task_created_sources:{task}")).unwrap().is_none());
    case.verify_audit().unwrap();

    // An identical restricted source is refused and nothing is added.
    let (dir, mut case, task) = case_with_task(true);
    let restricted = dir.path().join("opinion.html");
    std::fs::write(&restricted, SANITIZED).unwrap();
    case.import_files(&[restricted.to_string_lossy().into()], "Synthetic").unwrap();
    let hidden = case.sources().unwrap().into_iter().find(|source| source.sha256 == evidence_desk::case::digest(SANITIZED.as_bytes())).unwrap().id;
    case.set_restricted(&hidden, true).unwrap();
    let count = case.sources().unwrap().len();
    let staged = staged_files(&case);
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(3, 4));
    assert_eq!(receipt["status"], "failed");
    assert!(receipt["output"].as_str().unwrap().contains("restricted"), "{receipt}");
    assert_eq!(case.sources().unwrap().len(), count);
    assert_eq!(staged_files(&case), staged);
    assert!(!task_scope(&case, &task).contains(&hidden));
}

#[test]
fn capture_works_on_any_page_labelling_unfiltered_captures() {
    // Westlaw has no surveyed selectors yet (R36): the page is captured as shown and labelled.
    let (_dir, mut case, task) = case_with_task(true);
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &research::playbook::Playbook::production(), "research_capture", capture_args(0, 0));
    assert_eq!(receipt["status"], "complete", "{receipt}");
    let output: serde_json::Value = serde_json::from_str(receipt["output"].as_str().unwrap()).unwrap();
    let object = evidence_desk::evidence::read(&case, output["authority_id"].as_str().unwrap(), None).unwrap();
    let content: serde_json::Value = serde_json::from_str(object["content"].as_str().unwrap()).unwrap();
    assert_eq!((content["playbook"].as_str(), content["tr_editorial"].as_str()), (Some("generic"), Some("not_filtered")));
    let (_dir, mut case, task) = case_with_task(true);
    // Outside debug test mode a loopback page is a private address, whatever the playbook.
    let receipt = run_research(&mut case, &task, fixture_page("http://127.0.0.1:9471/opinion.html"), &research::playbook::Playbook::with_test_entries(), "research_capture", capture_args(0, 0));
    assert!(receipt["output"].as_str().unwrap().contains("private-network"), "{receipt}");
    // A results page is not a document, and lines outside the document text are refused.
    let receipt = run_research(&mut case, &task, fixture_page(RESULTS_URL), &document_playbook(), "research_capture", capture_args(0, 0));
    assert!(receipt["output"].as_str().unwrap().contains("no document text"), "{receipt}");
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(4, 5));
    assert!(receipt["output"].as_str().unwrap().contains("outside this document"), "{receipt}");
    assert_eq!(case.sources().unwrap().len(), 1);
}

#[test]
fn capture_arguments_are_checked_before_the_page_is_touched() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let with = |key: &str, value: serde_json::Value| {
        let mut args = capture_args(3, 4);
        args[key] = value;
        args
    };
    let mut refused = |args: serde_json::Value, reason: &str| {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_capture", args)).unwrap().is_none());
        let stored = case.meta(&format!("research_result:{task}")).unwrap().unwrap();
        assert!(stored.contains(reason), "{stored}");
    };
    refused(with("relevant_date", json!("May 1, 2001")), "YYYY-MM-DD");
    refused(with("title", json!("x".repeat(251))), "title");
    refused(with("title", json!("  ")), "title");
    refused(with("proposition", json!("p".repeat(1001))), "proposition");
    refused(with("quote_end_line", json!(203)), "consecutive lines");
    refused(with("quote_end_line", json!(2)), "consecutive lines");
    refused(with("quote_start_line", json!(-1)), "quote_start_line");
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_capture", with("relevant_date", json!(null)))).unwrap().is_some());
    // No capture limit: every request is audited.
    for _ in 1..40 {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_capture", capture_args(3, 4))).unwrap().is_some());
    }
    let requested: i64 = case.db.query_row("SELECT count(*) FROM audit WHERE event='research_capture_requested'", [], |row| row.get(0)).unwrap();
    assert_eq!(requested, 40);
}

#[test]
fn snapshots_reads_and_captures_share_the_playbook_editorial_selectors() {
    use research::{snapshot::Session, tools::run_job_with};
    let mut session = Session::new(fixture_page(DOCUMENT_URL));
    let playbook = document_playbook();
    let snapshot = block_on(run_job_with(&mut session, &research_job("research_snapshot", json!({"scope": "full", "find": null, "delta": false, "max_chars": null})), &playbook)).unwrap();
    assert!(!snapshot.to_string().contains(HEADNOTE));
    let read = block_on(run_job_with(&mut session, &research_job("research_read_page", json!({"offset": 0, "count": 10})), &playbook)).unwrap();
    assert!(!read.to_string().contains(HEADNOTE));
    let capture = block_on(run_job_with(&mut session, &research_job("research_capture", capture_args(3, 4)), &playbook)).unwrap();
    // The capture's lines are the lines research_read_page showed, so quoted line numbers agree.
    let read_lines: Vec<&str> = read["lines"].as_array().unwrap().iter().map(|line| line["text"].as_str().unwrap()).collect();
    assert_eq!(capture["lines"], json!(read_lines));
    assert_eq!(capture["citation_raw"], "123 F.3d 456");
    // Without the selectors (a playbook with no editorial list) the fixture would show it.
    let bare = research::playbook::Playbook::production();
    let exposed = block_on(run_job_with(&mut Session::new(fixture_page(DOCUMENT_URL)), &research_job("research_read_page", json!({"offset": 0, "count": 10})), &bare)).unwrap();
    assert!(exposed.to_string().contains(HEADNOTE), "the fixture honours only the selectors it is given");
}

#[test]
fn work_products_copy_only_the_whitelisted_authority_fields() {
    let (_dir, mut case, task) = case_with_task(true);
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(3, 4));
    let output: serde_json::Value = serde_json::from_str(receipt["output"].as_str().unwrap()).unwrap();
    let (source, authority, locator) = (output["source_id"].as_str().unwrap().to_string(), output["authority_id"].as_str().unwrap().to_string(), output["locator"].as_str().unwrap().to_string());
    // A later revision carrying editorial text in fields outside the whitelist (as an older or
    // faulty adapter might record) must not reach a work product either.
    let current = evidence_desk::evidence::read(&case, &authority, None).unwrap();
    let mut content: serde_json::Value = serde_json::from_str(current["content"].as_str().unwrap()).unwrap();
    content["headnotes"] = json!([HEADNOTE]);
    content["synopsis"] = json!(format!("Synopsis: {HEADNOTE}"));
    content["citation"]["keycite_text"] = json!(HEADNOTE);
    content["quote"]["context"] = json!(HEADNOTE);
    content["jurisdiction"] = json!({"text": HEADNOTE});
    evidence_desk::evidence::write(&mut case, evidence_desk::evidence::ObjectInput { id: Some(authority.clone()), base_revision: 1, kind: "authority".into(), title: "Smith v. Synthetic Holdings".into(), content: content.to_string(), source_ids: vec![source.clone()], locators: vec![locator.clone()], dependencies: vec![], start_seconds: None, end_seconds: None }, "research_browser_adapter").unwrap();
    let rows = json!([{"paragraph": "1", "text": "A duty of reasonable care is owed to foreseeable plaintiffs.", "citations": [locator], "authority_ids": [authority]}]);
    let saved = evidence_desk::work_products::save(&mut case, &task, &json!({"id": null, "base_revision": 0, "kind": "draft", "title": "Duty of care paragraph", "jurisdiction": "9th Cir.", "relevant_date": "2001-05-01", "items_json": rows.to_string()})).unwrap();
    let product = saved["content"].as_str().unwrap();
    assert!(!product.contains(HEADNOTE) && !product.contains("Synopsis") && !product.contains("full_page_sha256") && !product.contains("retrieved_by"), "{product}");
    let product: serde_json::Value = serde_json::from_str(product).unwrap();
    let copied = &product["authority_limits"][0]["authority"];
    assert_eq!(copied["url"], DOCUMENT_URL);
    assert_eq!(copied["citation"]["raw"], "123 F.3d 456");
    assert_eq!(copied["quote"]["locator"], json!(locator));
    assert_eq!(copied["quote"]["exact"], format!("{}\n{}", LINES[3], LINES[4]));
    assert_eq!(copied["treatment_status"], "not_checked");
    assert_eq!(copied["jurisdiction"], serde_json::Value::Null, "only plain strings are copied");
    let keys: Vec<&String> = copied.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 10, "{keys:?}");
}

#[test]
fn backups_hold_captures_but_never_the_research_profile() {
    let (dir, mut case, task) = case_with_task(true);
    // A synthetic profile beside the app data: outside every case folder by construction.
    let profile = dir.path().join("AppData").join("Local").join("org.localevidencedesk.app.research");
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(profile.join("Cookies-synthetic-marker"), "session").unwrap();
    research::ensure_profile_boundary(&case.root, &profile).unwrap();
    assert!(research::ensure_profile_boundary(&case.root, &case.root.join("EBWebView")).is_err());
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(3, 4));
    let source = serde_json::from_str::<serde_json::Value>(receipt["output"].as_str().unwrap()).unwrap()["source_id"].as_str().unwrap().to_string();
    evidence_desk::agent::pause(&mut case, &task, "Finished").unwrap();
    let archive = dir.path().join("backup.age");
    backup::backup(&mut case, &archive, "test-only-passphrase-long").unwrap();
    let restored_root = dir.path().join("restored");
    let restored = backup::restore(&archive, &restored_root, "test-only-passphrase-long").unwrap();
    restored.verify_audit().unwrap();
    assert_eq!(std::fs::read(restored.source_path(&source).unwrap()).unwrap(), SANITIZED.as_bytes());
    drop(restored);
    let profile_text = profile.to_string_lossy().to_string();
    let mut stack = vec![restored_root];
    while let Some(path) = stack.pop() {
        for entry in std::fs::read_dir(&path).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(!name.contains("Cookies-synthetic-marker") && name != "EBWebView", "{name}");
            if entry.file_type().unwrap().is_dir() {
                stack.push(entry.path());
            } else {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert!(!String::from_utf8_lossy(&bytes).contains(&profile_text), "{name} mentions the profile path");
            }
        }
    }
}

// ---- 171e176 re-review fixes ----





#[test]
fn page_content_is_dropped_when_the_page_moved_to_a_private_address_meanwhile() {
    use research::{snapshot::Session, tools::run_job};
    // The address check sees the research site; by the time of the snapshot the page is a sign-in page.
    let driver = research::driver::FakeDriver::new(|method, params| {
        let function = params["functionDeclaration"].as_str().unwrap_or_default();
        Ok(match method {
            "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1"}}}),
            "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
            "Runtime.evaluate" if params["expression"].as_str().unwrap_or_default().starts_with("({url: location.href") => json!({"result": {"value": {"url": "https://1.next.westlaw.com/Search/Results.html", "title": "t", "ready": "complete"}}}),
            "Runtime.evaluate" => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("Boolean(globalThis.__vislex)") => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("ariaSnapshot") => json!({"result": {"value": {"text": "- textbox \"Username\" [ref=e1]: someone@example.com", "url": "http://192.168.1.1/login", "title": "Router"}}}),
            "Runtime.callFunctionOn" if function.contains("innerText") => json!({"result": {"value": {"lines": ["someone@example.com"], "url": "http://192.168.1.1/login", "title": "Router"}}}),
            other => anyhow::bail!("unexpected {other}"),
        })
    });
    let mut session = Session::new(driver);
    let snapshot = research_job("research_snapshot", json!({"scope": "interactive", "find": null, "delta": false, "max_chars": null}));
    let error = block_on(run_job(&mut session, &snapshot)).unwrap_err().to_string();
    assert!(error.contains("private-network") && !error.contains("someone@"), "{error}");
    let read = research_job("research_read_page", json!({"offset": 0, "count": 5}));
    let error = block_on(run_job(&mut session, &read)).unwrap_err().to_string();
    assert!(error.contains("private-network") && !error.contains("someone@"), "{error}");
}

#[test]
fn pages_a_job_opened_are_audited_whatever_its_outcome() {
    let (_dir, mut case, _task) = case_with_task(true);
    let job = research_job("research_act", json!({"action": "click"}));
    let count = |case: &Case| case.db.query_row("SELECT COUNT(*) FROM audit WHERE event='research_page_opened'", [], |row| row.get::<_, i64>(0)).unwrap();
    research::tools::audit_page_change(&mut case, &job, Some("https://1.next.westlaw.com/Search/Results.html"), Some("https://1.next.westlaw.com/Document/I1/View/FullText.html"), false).unwrap();
    assert_eq!(count(&case), 1);
    let audited: String = case.db.query_row("SELECT data FROM audit WHERE event='research_page_opened' ORDER BY seq DESC LIMIT 1", [], |row| row.get(0)).unwrap();
    assert!(audited.contains("\"succeeded\":false") && audited.contains("/Document/I1/View/FullText.html"), "{audited}");
    // A fragment change, no change, or no page at all is not a new page.
    research::tools::audit_page_change(&mut case, &job, Some("https://1.next.westlaw.com/Document/I1"), Some("https://1.next.westlaw.com/Document/I1#co_pp_sp"), true).unwrap();
    research::tools::audit_page_change(&mut case, &job, Some("https://1.next.westlaw.com/Home"), Some("https://1.next.westlaw.com/Home"), true).unwrap();
    research::tools::audit_page_change(&mut case, &job, Some("https://1.next.westlaw.com/Home"), None, true).unwrap();
    assert_eq!(count(&case), 1);
    case.verify_audit().unwrap();
}

// ---- R37/R49: the ChatGPT-subscription route ----

fn on_subscription_route(case: &Case, task: &str) {
    case.set_meta(&format!("task_access_route:{task}"), "chatgpt_subscription").unwrap();
}

fn subscription_tool_names(case: &mut Case, task: &str) -> (Vec<String>, String) {
    let (instructions, definitions, _) = evidence_desk::agent::subscription_context(case, task).unwrap();
    (definitions.iter().filter_map(|tool| tool["name"].as_str().map(str::to_string)).collect(), instructions)
}

#[test]
fn the_subscription_route_offers_research_tools_only_when_the_grant_covers_it() {
    let (_dir, mut case, task) = case_with_task(false);
    on_subscription_route(&case, &task);
    let (names, instructions) = subscription_tool_names(&mut case, &task);
    assert!(!names.iter().any(|name| name.starts_with("research_")) && !instructions.contains("RESEARCH BROWSER"));

    let (_dir, mut case, task) = case_with_task(true);
    on_subscription_route(&case, &task);
    assert!(research::grant(&case).unwrap().unwrap().routes.iter().any(|route| route == "chatgpt_subscription"));
    let (names, instructions) = subscription_tool_names(&mut case, &task);
    for tool in research::tools::TOOL_NAMES {
        assert!(names.iter().any(|name| name == tool), "{tool} not offered on the subscription route");
    }
    assert!(instructions.contains("RESEARCH BROWSER"));
    // The advertised schemas are the strict API-route schemas, unchanged.
    let (_, definitions, _) = evidence_desk::agent::subscription_context(&mut case, &task).unwrap();
    for definition in research::tools::tool_definitions() {
        assert!(definitions.contains(&definition), "{} schema changed", definition["name"]);
    }

    // A grant written before R37/R49 covers only the API-key route: the subscription route
    // never sees the tools, while an API-key task still does.
    let mut stored: serde_json::Value = serde_json::from_str(&case.meta("research_browser_grant").unwrap().unwrap()).unwrap();
    stored["routes"] = json!(["api_keys"]);
    case.set_meta("research_browser_grant", &stored.to_string()).unwrap();
    assert!(!research::tools::exposed(&case, &task).unwrap());
    let (names, instructions) = subscription_tool_names(&mut case, &task);
    assert!(!names.iter().any(|name| name.starts_with("research_")) && !instructions.contains("RESEARCH BROWSER"));
    let refused = evidence_desk::agent::prepare_subscription_call(&mut case, &task, "call-old-grant", "research_status", json!({}));
    assert!(refused.is_err(), "a tool the route does not offer is refused");
    case.set_meta(&format!("task_access_route:{task}"), "api_keys").unwrap();
    assert!(research::tools::exposed(&case, &task).unwrap());
}

#[test]
fn a_subscription_research_call_returns_its_stashed_result_with_a_receipt() {
    let (_dir, mut case, task) = case_with_task(true);
    on_subscription_route(&case, &task);
    let args = json!({"scope": "interactive", "find": null, "delta": false, "max_chars": null});
    let call = evidence_desk::agent::prepare_subscription_call(&mut case, &task, "codex-call-1", "research_snapshot", args.clone()).unwrap();
    case.set_meta(&format!("research_result:{task}"), "").unwrap();
    let job = research::tools::prepare_research(&mut case, &task, &call.transmission, &call.response).unwrap().expect("job");
    assert_eq!((job.name.as_str(), &job.args), ("research_snapshot", &args));
    research::tools::stash(&case, &job, Ok(json!({"snapshot": {"text": "- searchbox \"Search\" [ref=e2]"}}))).unwrap();
    let result = evidence_desk::agent::finish_subscription_call(&mut case, &task, call, &mut Default::default()).unwrap();
    assert!(result["snapshot"]["text"].as_str().unwrap().contains("searchbox"));
    let receipt = last_action(&case, &task);
    assert_eq!((receipt["name"].as_str(), receipt["status"].as_str()), (Some("research_snapshot"), Some("complete")));
    assert!(receipt["output"].as_str().unwrap().contains("searchbox"));
    // The arm consumed the page text.
    assert_eq!(case.meta(&format!("research_result:{task}")).unwrap().as_deref(), Some(""));
    let items = evidence_desk::agent::subscription_tool_items(&mut case, &task, "codex-call-1", result).unwrap();
    assert_eq!(items["success"], true);
    assert!(items["contentItems"][0]["text"].as_str().unwrap().contains("searchbox"));
    // A replayed Codex call id is refused.
    assert!(evidence_desk::agent::prepare_subscription_call(&mut case, &task, "codex-call-1", "research_snapshot", args).is_err());
}

#[test]
fn a_closed_research_pane_reaches_codex_as_tool_output_text() {
    let (_dir, mut case, task) = case_with_task(true);
    on_subscription_route(&case, &task);
    let call = evidence_desk::agent::prepare_subscription_call(&mut case, &task, "codex-call-closed", "research_status", json!({})).unwrap();
    let job = research::tools::prepare_research(&mut case, &task, &call.transmission, &call.response).unwrap().expect("job");
    // What research::runtime::execute reports when the pane is closed.
    let closed = "The research browser is closed. Ask the user to open the Browser view and sign in, then try again.";
    research::tools::stash(&case, &job, Err(anyhow::anyhow!(closed))).unwrap();
    let result = evidence_desk::agent::finish_subscription_call(&mut case, &task, call, &mut Default::default()).expect("not a turn failure");
    assert_eq!(result["error"], closed);
    let items = evidence_desk::agent::subscription_tool_items(&mut case, &task, "codex-call-closed", result).unwrap();
    assert_eq!(items["success"], false);
    assert!(items["contentItems"][0]["text"].as_str().unwrap().contains("open the Browser view"));
    let receipt = last_action(&case, &task);
    assert_eq!((receipt["name"].as_str(), receipt["status"].as_str()), (Some("research_status"), Some("failed")));
    // The task keeps running: Codex may answer or try again.
    let status: String = case.db.query_row("SELECT status FROM tasks WHERE id=?", [&task], |row| row.get(0)).unwrap();
    assert_eq!(status, "running");

    // A call refused before any browser action also returns its reason as output.
    let call = evidence_desk::agent::prepare_subscription_call(&mut case, &task, "codex-call-private", "research_navigate", json!({"url": "http://192.168.1.1/"})).unwrap();
    assert!(research::tools::prepare_research(&mut case, &task, &call.transmission, &call.response).unwrap().is_none());
    let result = evidence_desk::agent::finish_subscription_call(&mut case, &task, call, &mut Default::default()).unwrap();
    assert!(result["error"].as_str().unwrap().contains("private-network"));
}

#[test]
fn research_steps_carry_a_short_detail_for_the_chat() {
    use research::tools::activity_detail;
    let act = |action: &str, text: serde_json::Value, key: serde_json::Value| json!({"action": action, "ref": "e1", "snapshot_version": 1, "text": text, "key": key});
    assert_eq!(activity_detail("research_act", &act("type", json!("duty of care /s negligence"), json!(null))).as_deref(), Some("duty of care /s negligence"));
    assert_eq!(activity_detail("research_act", &act("click", json!(null), json!(null))).as_deref(), Some("click"));
    assert_eq!(activity_detail("research_act", &act("press", json!(null), json!("Enter"))).as_deref(), Some("press Enter"));
    assert_eq!(activity_detail("research_act", &act("scroll_down", json!(null), json!(null))).as_deref(), Some("scroll_down"));
    assert_eq!(activity_detail("research_navigate", &json!({"url": "https://1.next.westlaw.com/Document/I1/View/FullText.html"})).as_deref(), Some("1.next.westlaw.com/Document/I1/View/FullText.html"));
    assert_eq!(activity_detail("research_read_page", &json!({"offset": 40, "count": 60})).as_deref(), Some("lines 40\u{2013}99"), "inclusive, as the saved receipt shows");
    assert_eq!(activity_detail("research_capture", &capture_args(1, 2)).as_deref(), Some("123 F.3d 456"));
    assert_eq!(activity_detail("research_snapshot", &json!({"scope": "main", "find": null, "delta": false, "max_chars": null})).as_deref(), Some("main"));
    assert_eq!(activity_detail("research_status", &json!({})), None);
    let long = activity_detail("research_act", &act("type", json!("x".repeat(500)), json!(null))).unwrap();
    assert_eq!(long.chars().count(), research::tools::MAX_DETAIL_CHARS);
}

#[test]
fn records_citing_uncaptured_reporter_citations_are_refused_after_research() {
    let (_dir, mut case, task) = case_with_task(true);
    let record = |title: &str| call("write_record", json!({"record_id": null, "base_revision": 0, "title": title, "kind": "note", "content": "Duty is owed to foreseeable plaintiffs. See Smith v. Jones, 123 F.3d 456 (9th Cir. 2001).", "reason": "research note", "source_ids": []}));
    // Without research in this task, the guard never applies.
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, record("Before research")).unwrap();
    assert!(!last_action(&case, &task)["output"].to_string().contains("research_capture"));
    // Once the task has used the research browser, an uncaptured reporter citation is refused.
    case.set_meta(&format!("research_grant_revision:{task}"), "1").unwrap();
    // Only asking for the browser's status does not switch the guard on.
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, record("Status only")).unwrap();
    assert!(!last_action(&case, &task)["output"].to_string().contains("research_capture"));
    // Once the task has browsed, an uncaptured reporter citation is refused.
    case.set_meta(&format!("research_usage:{task}"), r#"{"navigations":1}"#).unwrap();
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, record("After research")).unwrap();
    let output = last_action(&case, &task)["output"].to_string();
    assert!(output.contains("research_capture") && output.contains("123 F.3d 456"), "{output}");
}

#[test]
fn captured_web_pages_are_not_sent_to_the_sandboxed_worker() {
    let (_dir, mut case, task) = case_with_task(true);
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(3, 4));
    assert_eq!(receipt["status"], "complete", "{receipt}");
    let output: serde_json::Value = serde_json::from_str(receipt["output"].as_str().unwrap()).unwrap();
    let source = output["source_id"].as_str().unwrap().to_string();
    // A job that failed earlier (as older builds did) is settled; a new one completes at once.
    evidence_desk::automatic::enqueue(&mut case).unwrap();
    case.db.execute("UPDATE processing_jobs SET status='failed',error='Sandboxed extraction currently supports PDF' WHERE kind='auto_prepare' AND source_id=?", [&source]).unwrap();
    evidence_desk::automatic::enqueue(&mut case).unwrap();
    let status = |case: &Case| case.db.query_row::<(String, String), _, _>("SELECT status,error FROM processing_jobs WHERE kind='auto_prepare' AND source_id=?", [&source], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(status(&case), ("complete".to_string(), String::new()));
    case.db.execute("UPDATE processing_jobs SET status='queued' WHERE kind='auto_prepare' AND source_id=?", [&source]).unwrap();
    while let Some(job) = evidence_desk::automatic::next(&mut case).unwrap() {
        assert_ne!(job.processor.source.id, source, "a captured page never reaches the worker");
    }
    assert_eq!(status(&case).0, "complete");
}

// ---- Westlaw task-log fixes: keys, read counts, dossier messages ----

#[test]
fn key_combinations_and_large_read_counts_are_accepted_before_the_page_is_touched() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let press = |key: &str| call("research_act", json!({"action": "press", "ref": null, "snapshot_version": null, "text": null, "key": key}));
    for key in ["Control+A", "Shift+Tab", "Alt+ArrowLeft", "Meta+A", "Enter", "j"] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &press(key)).unwrap().is_some(), "{key}");
    }
    for key in ["Control+W", "Control+Q", "Alt+F4", "Control+Shift+I", "F12", "Control+V"] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &press(key)).unwrap().is_none(), "{key}");
        let stored = case.meta(&format!("research_result:{task}")).unwrap().unwrap();
        assert!(stored.contains("not allowed"), "{key}: {stored}");
    }
    // A read of more than 200 lines reads 200 instead of failing (the log asked for more).
    let read = call("research_read_page", json!({"offset": 0, "count": 400}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &read).unwrap().is_some());
    assert_eq!(research::tools::read_count(&json!({"count": 400})), Some(200));
    assert_eq!(research::tools::read_count(&json!({"count": 0})), Some(1));
    assert_eq!(research::tools::read_count(&json!({"count": "all"})), None);
    assert_eq!(research::tools::activity_detail("research_read_page", &json!({"offset": 0, "count": 400})).as_deref(), Some("lines 0\u{2013}199"));
    // The job reads at most 200 lines.
    use research::{driver::FakeDriver, snapshot::Session};
    let page = FakeDriver::new(|method, params| {
        let function = params["functionDeclaration"].as_str().unwrap_or_default();
        Ok(match method {
            "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1"}}}),
            "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
            "Runtime.evaluate" if params["expression"].as_str().unwrap_or_default().starts_with("({url: location.href") => json!({"result": {"value": {"url": DOCUMENT_URL, "title": "Opinion", "ready": "complete"}}}),
            "Runtime.evaluate" => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("Boolean(globalThis.__vislex)") => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("innerText") => json!({"result": {"value": {"url": DOCUMENT_URL, "title": "Opinion", "lines": (0..500).map(|n| format!("Line {n}")).collect::<Vec<_>>()}}}),
            other => anyhow::bail!("unexpected {other}"),
        })
    });
    let mut session = Session::new(page);
    let read = block_on(research::tools::run_job(&mut session, &research_job("research_read_page", json!({"offset": 0, "count": 400})))).unwrap();
    assert_eq!(read["lines"].as_array().unwrap().len(), 200);
    assert_eq!(read["next_offset"], 200);
}

/// Runs a read_text call through the agent loop and returns its receipt.
fn read_text(case: &mut Case, task: &str, source: &str) -> serde_json::Value {
    let request = evidence_desk::agent::prepare_request(case, task).unwrap();
    evidence_desk::agent::receive(case, task, &request.transmission, call("read_text", json!({"source_id": source, "start": 1, "count": 1}))).unwrap();
    last_action(case, task)
}

#[test]
fn dossier_receipts_may_be_the_locator_a_read_returned_and_errors_say_what_to_give() {
    let (_dir, mut case, task) = case_with_task(false);
    let source = case.sources().unwrap()[0].id.clone();
    let receipt = read_text(&mut case, &task, &source);
    assert_eq!(receipt["status"], "complete", "{receipt}");
    let receipt_id = receipt["id"].as_str().unwrap().to_string();
    let locator = serde_json::from_str::<serde_json::Value>(receipt["output"].as_str().unwrap()).unwrap()["locator"].as_str().unwrap().to_string();
    assert!(locator.starts_with("evidence:"), "{locator}");
    let dossier = |receipts: serde_json::Value, contrary: serde_json::Value| {
        json!({"revision": 0, "scope": "Read the note.", "checks": [{"id": "read-note", "description": "Read the note", "source_id": source, "tool": "read_text", "state": "done", "receipts": receipts, "reason": ""}],
            "claims": [{"id": "claim-note", "proposition": "The note is synthetic.", "assessment": "supported_within_scope", "supporting": [locator], "contrary": contrary, "uncertainty": "", "next_check": ""}]})
    };
    // Prose in contrary: say what belongs there.
    let error = evidence_desk::dossier::save(&mut case, &task, &dossier(json!([receipt_id]), json!(["The note does not say who wrote it."]))).unwrap_err().to_string();
    assert!(error.contains("supporting and contrary entries must be evidence locators (evidence:") && error.contains("put explanations in uncertainty"), "{error}");
    // A locator no read of this task returned (the log's case): explain what receipts are.
    let error = evidence_desk::dossier::save(&mut case, &task, &dossier(json!([format!("evidence:{source}#R1L350-L389")]), json!([]))).unwrap_err().to_string();
    assert!(error.contains("Receipts are the Receipt IDs of this task's completed read_text actions") && error.contains("40809e8f-"), "{error}");
    let error = evidence_desk::dossier::save(&mut case, &task, &dossier(json!(["not-a-receipt"]), json!([]))).unwrap_err().to_string();
    assert!(error.contains("Receipts are the Receipt IDs"), "{error}");
    // The exact locator the read returned names that read: accepted, stored as its Receipt ID.
    evidence_desk::dossier::save(&mut case, &task, &dossier(json!([locator]), json!([]))).unwrap();
    let stored = evidence_desk::dossier::load(&case, &task).unwrap().unwrap();
    assert_eq!(stored.checks[0].receipts, [receipt_id]);
    // Only the task's own completed reads count: a task that has not read the lines is refused.
    let unread = evidence_desk::agent::start(&mut case, "Another question", "investigate", vec![source.clone()], vec![], 0.).unwrap();
    let error = evidence_desk::dossier::save(&mut case, &unread, &dossier(json!([locator]), json!([]))).unwrap_err().to_string();
    assert!(error.contains("no completed read_text action of this task returned"), "{error}");
}

// ---- research_westlaw_search / research_westlaw_document ----

const WESTLAW_RESULTS: &str = "https://1.next.westlaw.com/Search/Results.html";
const STOW_URL: &str = "https://1.next.westlaw.com/Document/I4a1b2c3d/View/FullText.html?originationContext=Search";
const STOW_CITE_LINE: &str = "Court of Appeals of Ohio, Ninth District, Summit County. June 20, 2012 Not Reported in N.E.2d 2012 -Ohio- 2746 2012 WL 2336914";

/// A scripted Westlaw page: the global search box (holding earlier text), Enter opening a
/// results page, a "Cases" category link, and results as the results page function reads them.
struct Westlaw {
    url: String,
    loader: u32,
    value: String,
    selected: bool,
    /// The site updates its results in place (no new address or document) when searching.
    in_place: bool,
    searched: bool,
}

fn westlaw_site(start: &str, before: &str, home_lands_on: &'static str) -> research::driver::FakeDriver {
    westlaw_site_with(start, before, home_lands_on, false)
}

fn westlaw_site_with(start: &str, before: &str, home_lands_on: &'static str, in_place: bool) -> research::driver::FakeDriver {
    use research::playbook::westlaw;
    let state = std::sync::Arc::new(std::sync::Mutex::new(Westlaw { url: start.into(), loader: 1, value: before.into(), selected: false, in_place, searched: false }));
    research::driver::FakeDriver::new(move |method, params| {
        let mut site = state.lock().unwrap();
        let function = params["functionDeclaration"].as_str().unwrap_or_default();
        let expression = params["expression"].as_str().unwrap_or_default();
        let on_westlaw = site.url.contains("westlaw.com");
        Ok(match method {
            "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1", "loaderId": format!("L{}", site.loader)}}}),
            "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
            "Page.navigate" => {
                site.url = if params["url"] == research::WESTLAW_HOME { home_lands_on.to_string() } else { params["url"].as_str().unwrap().to_string() };
                site.loader += 1;
                json!({"frameId": "F1"})
            }
            "Page.stopLoading" | "DOM.scrollIntoViewIfNeeded" => json!({}),
            "Runtime.evaluate" if expression.starts_with("({url: location.href") => json!({"result": {"value": {"url": site.url, "title": "Westlaw", "ready": "complete"}}}),
            "Runtime.evaluate" if expression.starts_with("document.readyState") => json!({"result": {"value": site.url}}),
            "Runtime.evaluate" => json!({"result": {"value": true}}),
            "Input.insertText" => {
                let text = params["text"].as_str().unwrap().to_string();
                if site.selected { site.value = text } else { site.value.push_str(&text) }
                site.selected = false;
                json!({})
            }
            "Input.dispatchKeyEvent" => {
                if params["key"] == "Enter" && params["type"] == "keyDown" {
                    if site.in_place {
                        site.searched = true;
                    } else {
                        site.url = format!("{WESTLAW_RESULTS}?query={}", site.value.len());
                        site.loader += 1;
                    }
                }
                json!({})
            }
            "Input.dispatchMouseEvent" => {
                if params["type"] == "mouseReleased" {
                    site.url = format!("{WESTLAW_RESULTS}?type=cases");
                    site.loader += 1;
                }
                json!({})
            }
            "DOM.getBoxModel" => json!({"model": {"content": [0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0]}}),
            "Runtime.callFunctionOn" => {
                let null = json!({"result": {"type": "object", "subtype": "null", "value": null}});
                if function.contains("Boolean(globalThis.__vislex)") {
                    json!({"result": {"value": true}})
                } else if function == westlaw::SEARCH_BOX_FN {
                    if on_westlaw { json!({"result": {"type": "object", "subtype": "node", "objectId": "box"}}) } else { null }
                } else if function == westlaw::SEARCH_BUTTON_FN {
                    null
                } else if function == westlaw::CATEGORY_LINK_FN {
                    assert_eq!(params["arguments"][0]["value"], json!(["Cases"]));
                    json!({"result": {"type": "object", "subtype": "node", "objectId": "cases-link"}})
                } else if function.contains("password_on_page") {
                    let search = params["objectId"] == "box";
                    json!({"result": {"value": {"tag": if search { "input" } else { "a" }, "input_type": if search { "text" } else { "" }, "autocomplete": "off", "name": "", "id": "searchInputId", "aria_label": if search { "Search suggestions available after typing 3 characters. Use down arrow to access." } else { "" }, "placeholder": "", "role": if search { "combobox" } else { "" }, "href": "", "text": "", "title": "", "content_editable": false, "form_action": "", "password_on_page": false, "otp_on_page": false}}})
                } else if function.contains("this.focus()") || function.contains("elementFromPoint") {
                    json!({"result": {"value": true}})
                } else if function.contains("selectNodeContents") {
                    site.selected = true;
                    json!({"result": {"value": "select"}})
                } else if function.contains("'value' in this") {
                    json!({"result": {"value": {"active": true, "value": site.value}}})
                } else if function == westlaw::RESULTS_FN {
                    let cases = site.url.contains("type=cases");
                    let results = site.url.starts_with(WESTLAW_RESULTS);
                    if site.in_place && !site.searched {
                        // The results of an earlier search, still showing.
                        return Ok(json!({"result": {"value": {"url": site.url, "title": "Search Results", "no_results": false, "counts": [], "rows": [{"rank": 1, "title": "Earlier Result v. Old", "url": "https://1.next.westlaw.com/Document/I0/View/FullText.html", "citation_line": "", "summary": "", "snippets": [], "flags": []}]}}}));
                    }
                    json!({"result": {"value": {
                        "url": site.url,
                        "title": "Search Results",
                        "no_results": false,
                        "rows": if results { json!([
                            {"rank": 1, "title": "Stow v. Paster", "url": STOW_URL, "citation_line": STOW_CITE_LINE, "summary": "Summary of the appeal.", "snippets": ["... theft ...", "... lawful owner ...", "... third ...", "... fourth ..."], "flags": ["Yellow Flag - Negative Treatment"]},
                            {"rank": 2, "title": "State v. Example", "url": "https://1.next.westlaw.com/Document/I2/View/FullText.html", "citation_line": "Supreme Court of Ohio. 81 Ohio St.3d 337", "summary": "", "snippets": [], "flags": []}
                        ]) } else { json!([]) },
                        "counts": if cases { json!([{"label": "Cases", "count": 66, "heading": true}]) } else { json!([{"label": "Overview", "count": 120, "heading": true}, {"label": "Cases", "count": 66, "heading": false}]) },
                    }}})
                } else {
                    anyhow::bail!("unexpected function {function}")
                }
            }
            other => anyhow::bail!("unexpected {other}"),
        })
    })
}

fn westlaw_search_args(query: &str, jurisdiction: serde_json::Value, content_type: serde_json::Value) -> serde_json::Value {
    json!({"query": query, "jurisdiction": jurisdiction, "content_type": content_type})
}

#[test]
fn westlaw_search_replaces_the_query_submits_and_returns_compact_rows() {
    use research::{snapshot::Session, tools::run_job};
    let query = "adv: theft /s \"lawful owner\"";
    // The box already holds an older query, as in the log ("CO(Ohioadv: theft ...").
    let mut session = Session::new(westlaw_site(&format!("{WESTLAW_RESULTS}?query=old"), "CO(Ohio", "https://1.next.westlaw.com/Home"));
    let result = block_on(run_job(&mut session, &research_job("research_westlaw_search", westlaw_search_args(query, json!("Ohio"), json!("cases"))))).unwrap();
    assert_eq!(result["query"], query);
    let inserted: Vec<String> = session.driver().calls().into_iter().filter(|(method, _)| method == "Input.insertText").map(|(_, params)| params["text"].as_str().unwrap().to_string()).collect();
    assert_eq!(inserted, [query], "the old query was replaced, not added to");
    assert!(result["url"].as_str().unwrap().contains("type=cases"), "{result}");
    assert_eq!((result["total"].as_u64(), result["total_label"].as_str()), (Some(66), Some("Cases (66)")));
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["rank"], 1);
    assert_eq!(rows[0]["title"], "Stow v. Paster");
    assert_eq!(rows[0]["url"], STOW_URL);
    assert_eq!(rows[0]["citation_line"], STOW_CITE_LINE);
    assert_eq!(rows[0]["keycite_flag"], "yellow");
    assert_eq!(rows[0]["snippets"].as_array().unwrap().len(), 3);
    // The content type was applied by opening the Cases category; the jurisdiction was not.
    assert_eq!(result["filters"]["content_type"], json!({"requested": "cases", "applied": true}));
    assert_eq!(result["filters"]["jurisdiction"], json!({"requested": "Ohio", "applied": false}));
    assert_eq!(result["filters_applied"], false);
    assert!(result["guidance"][0].as_str().unwrap().contains("jurisdiction (Ohio) was not set"));
    assert!(result["note"].as_str().unwrap().contains("untrusted"));
    // Model text only ever travels as data.
    for (method, params) in session.driver().calls() {
        if method == "Runtime.callFunctionOn" {
            assert!(!params["functionDeclaration"].as_str().unwrap().contains("lawful owner"));
        }
    }
    // Enter was a trusted key press carrying the carriage return.
    assert!(session.driver().calls().iter().any(|(method, params)| method == "Input.dispatchKeyEvent" && params["key"] == "Enter" && params["text"] == "\r"));

    // Without filters: nothing opened, nothing claimed.
    let mut session = Session::new(westlaw_site(&format!("{WESTLAW_RESULTS}?query=old"), "", "https://1.next.westlaw.com/Home"));
    let result = block_on(run_job(&mut session, &research_job("research_westlaw_search", westlaw_search_args("theft", json!(null), json!(null))))).unwrap();
    assert_eq!((result["total"].as_u64(), result["filters_applied"].as_bool()), (Some(120), Some(false)));
    assert!(result["guidance"].as_array().unwrap().is_empty());
    assert!(!session.driver().methods().contains(&"Input.dispatchMouseEvent".to_string()), "no category was opened");

    // A site that updates its results in place: the rows already showing are never returned as
    // the new results; the new rows are.
    let mut session = Session::new(westlaw_site_with(&format!("{WESTLAW_RESULTS}?query=old"), "old query", "https://1.next.westlaw.com/Home", true));
    let result = block_on(run_job(&mut session, &research_job("research_westlaw_search", westlaw_search_args("theft", json!(null), json!(null))))).unwrap();
    assert_eq!(result["rows"][0]["title"], "Stow v. Paster", "{result}");
}

#[test]
fn westlaw_search_opens_westlaw_first_and_stops_on_a_sign_in_page() {
    use research::{snapshot::Session, tools::run_job};
    // From another site, the search opens Westlaw's home page first.
    let mut session = Session::new(westlaw_site("https://www.google.com/search?q=theft", "", "https://1.next.westlaw.com/Home"));
    let result = block_on(run_job(&mut session, &research_job("research_westlaw_search", westlaw_search_args("theft /s owner", json!(null), json!("all"))))).unwrap();
    assert_eq!(result["rows"].as_array().unwrap().len(), 2);
    let navigated: Vec<String> = session.driver().calls().into_iter().filter(|(method, _)| method == "Page.navigate").map(|(_, params)| params["url"].as_str().unwrap().to_string()).collect();
    assert_eq!(navigated, [research::WESTLAW_HOME]);
    // An expired session lands on the sign-in page: the agent is told what to do.
    let mut session = Session::new(westlaw_site("https://www.google.com/", "", "https://signon.thomsonreuters.com/?productid=CBT"));
    let error = block_on(run_job(&mut session, &research_job("research_westlaw_search", westlaw_search_args("theft", json!(null), json!(null))))).unwrap_err().to_string();
    assert!(error.contains("Westlaw is not showing") && error.contains("signon.thomsonreuters.com"), "{error}");
    assert!(!session.driver().methods().contains(&"Input.insertText".to_string()), "nothing typed off Westlaw");
}

#[test]
fn westlaw_macro_calls_are_checked_and_audited() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let search = call("research_westlaw_search", westlaw_search_args("theft /s \"lawful owner\"", json!("Ohio"), json!("cases")));
    let job = research::tools::prepare_research(&mut case, &task, &request.transmission, &search).unwrap().expect("job");
    assert_eq!(job.name, "research_westlaw_search");
    let audited: String = case.db.query_row("SELECT data FROM audit WHERE event='research_query_requested' ORDER BY seq DESC LIMIT 1", [], |row| row.get(0)).unwrap();
    assert!(audited.contains("lawful owner") && audited.contains("research_westlaw_search") && audited.contains("Ohio"), "{audited}");
    for (args, reason) in [
        (westlaw_search_args("", json!(null), json!(null)), "Nothing to type"),
        (westlaw_search_args("a\u{7}b", json!(null), json!(null)), "printable"),
        (westlaw_search_args("theft", json!(null), json!("dockets")), "content_type"),
    ] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_westlaw_search", args)).unwrap().is_none());
        assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains(reason), "{reason}");
    }
    let document = |url: serde_json::Value| call("research_westlaw_document", json!({"url": url}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &document(json!(STOW_URL))).unwrap().is_some());
    let opened: String = case.db.query_row("SELECT data FROM audit WHERE event='research_navigation_requested' ORDER BY seq DESC LIMIT 1", [], |row| row.get(0)).unwrap();
    assert!(opened.contains("/Document/I4a1b2c3d/View/FullText.html") && opened.contains("research_westlaw_document"), "{opened}");
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &document(json!(null))).unwrap().is_some());
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &document(json!("https://www.courtlistener.com/opinion/1/x/"))).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("only on Westlaw"));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &document(json!("http://192.168.1.1/Document/x"))).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("private-network"));
    // The steps shown in the chat.
    use research::tools::activity_detail;
    assert_eq!(activity_detail("research_westlaw_search", &westlaw_search_args("theft /s owner", json!(null), json!(null))).as_deref(), Some("theft /s owner"));
    assert_eq!(activity_detail("research_westlaw_document", &json!({"url": STOW_URL})).as_deref(), Some("1.next.westlaw.com/Document/I4a1b2c3d/View/FullText.html"));
    assert_eq!(activity_detail("research_westlaw_document", &json!({"url": null})).as_deref(), Some("current page"));
    // Strict schemas: every property required, nothing else accepted.
    for definition in research::tools::tool_definitions() {
        let properties = definition["parameters"]["properties"].as_object().unwrap();
        let required = definition["parameters"]["required"].as_array().unwrap();
        assert_eq!(properties.len(), required.len(), "{}", definition["name"]);
        assert_eq!(definition["parameters"]["additionalProperties"], false);
        assert_eq!(definition["strict"], true);
    }
    case.verify_audit().unwrap();
}

/// The Westlaw document of the user's log, as research_read_page reads it: the header's text
/// nodes ran together, and the document ends with its All Citations line.
fn stow_lines() -> Vec<String> {
    let mut lines: Vec<String> = [
        "Stow v. Paster",
        "Court of Appeals of Ohio, Ninth District, Summit County.June 20, 2012Not Reported in N.E.2d2012 WL 23369142012 -Ohio- 2746 (Approx. 6 pages)",
        "CHECK OHIO SUPREME COURT RULES FOR REPORTING OF OPINIONS AND WEIGHT OF LEGAL AUTHORITY.",
        "Opinion",
        "The owner's consent to the retention of the property was not shown.",
    ]
    .iter()
    .map(|line| line.to_string())
    .collect();
    lines.extend((0..250).map(|n| format!("Opinion paragraph {n}.")));
    lines.extend(["All Citations".to_string(), "Not Reported in N.E.2d, 2012 WL 2336914, 2012 -Ohio- 2746".to_string()]);
    lines
}

fn westlaw_document_page(url: &'static str) -> research::driver::FakeDriver {
    use research::playbook::westlaw;
    let here = std::sync::Arc::new(std::sync::Mutex::new(url.to_string()));
    research::driver::FakeDriver::new(move |method, params| {
        let function = params["functionDeclaration"].as_str().unwrap_or_default();
        let expression = params["expression"].as_str().unwrap_or_default();
        let url = here.lock().unwrap().clone();
        Ok(match method {
            "Page.getFrameTree" => json!({"frameTree": {"frame": {"id": "F1", "loaderId": "L1"}}}),
            "Page.createIsolatedWorld" => json!({"executionContextId": 3}),
            "Page.navigate" => {
                *here.lock().unwrap() = params["url"].as_str().unwrap().to_string();
                json!({"frameId": "F1"})
            }
            "Runtime.evaluate" if expression.starts_with("({url: location.href") => json!({"result": {"value": {"url": url, "title": "Stow v. Paster | Westlaw Advantage", "ready": "complete"}}}),
            "Runtime.evaluate" if expression.starts_with("document.readyState") => json!({"result": {"value": url}}),
            "Runtime.evaluate" => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.contains("Boolean(globalThis.__vislex)") => json!({"result": {"value": true}}),
            "Runtime.callFunctionOn" if function.starts_with("function (excluded)") => json!({"result": {"value": {"url": url, "title": "Stow v. Paster | Westlaw Advantage", "lines": stow_lines()}}}),
            "Runtime.callFunctionOn" if function.starts_with("function (entries, excluded)") => {
                json!({"result": {"value": {"url": url, "title": "Stow v. Paster", "entry": "generic", "document_text": true, "lines": stow_lines(), "html": "<main><p>Stow v. Paster</p></main>", "page_html": "<html><main><p>Stow v. Paster</p></main></html>"}}})
            }
            "Runtime.callFunctionOn" if function == westlaw::KEYCITE_FN => json!({"result": {"value": {
                "url": url,
                "flags": ["Red Flag - Severe Negative Treatment"],
                "tabs": [
                    {"label": "Negative Treatment", "count": 0, "url": "https://1.next.westlaw.com/RelatedInformation/I4a1b2c3d/kcNegativeTreatment.html"},
                    {"label": "History", "count": 2, "url": "https://1.next.westlaw.com/RelatedInformation/I4a1b2c3d/kcHistory.html"},
                    {"label": "Citing References", "count": 9, "url": "https://1.next.westlaw.com/RelatedInformation/I4a1b2c3d/kcCitingReferences.html"}
                ],
            }}}),
            other => anyhow::bail!("unexpected {other}"),
        })
    })
}

#[test]
fn westlaw_document_returns_header_facts_keycite_and_numbered_lines() {
    use research::{snapshot::Session, tools::run_job};
    let mut session = Session::new(westlaw_document_page(WESTLAW_RESULTS));
    let result = block_on(run_job(&mut session, &research_job("research_westlaw_document", json!({"url": STOW_URL})))).unwrap();
    assert_eq!(result["url"], STOW_URL);
    assert_eq!(result["title"], "Stow v. Paster");
    assert_eq!(result["court"], "Court of Appeals of Ohio, Ninth District, Summit County.");
    assert_eq!(result["decided"], json!({"text": "June 20, 2012", "date": "2012-06-20"}));
    assert_eq!(result["citations"], json!(["2012 WL 2336914", "2012 Ohio 2746"]));
    assert_eq!(result["all_citations"], "Not Reported in N.E.2d, 2012 WL 2336914, 2012 -Ohio- 2746");
    let notes = result["reporting_notes"].to_string();
    assert!(notes.contains("Not Reported in N.E.2d") && notes.contains("CHECK OHIO SUPREME COURT RULES FOR REPORTING"), "{notes}");
    let keycite = &result["keycite"];
    assert_eq!((keycite["flag"].as_str(), keycite["flag_text"].as_str()), (Some("red"), Some("Red Flag - Severe Negative Treatment")));
    assert_eq!((keycite["negative_treatment"].as_u64(), keycite["history"].as_u64(), keycite["citing_references"].as_u64()), (Some(0), Some(2), Some(9)));
    assert!(keycite["tabs"][1]["url"].as_str().unwrap().ends_with("kcHistory.html"));
    // Lines are numbered as research_read_page numbers them: the first 200, then next_offset.
    let lines = result["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 200);
    assert_eq!(lines[3], json!({"n": 3, "text": "Opinion"}));
    assert_eq!((result["total_lines"].as_u64(), result["next_offset"].as_u64()), (Some(257), Some(200)));
    let read = block_on(run_job(&mut session, &research_job("research_read_page", json!({"offset": 0, "count": 5})))).unwrap();
    assert_eq!(read["lines"].as_array().unwrap()[..], lines[..5]);
    // The page showing may be read without a url; other sites are refused with directions.
    let current = block_on(run_job(&mut session, &research_job("research_westlaw_document", json!({"url": null})))).unwrap();
    assert_eq!(current["citations"], result["citations"]);
    let mut elsewhere = Session::new(westlaw_document_page("https://www.courtlistener.com/opinion/1/x/"));
    let error = block_on(run_job(&mut elsewhere, &research_job("research_westlaw_document", json!({"url": null})))).unwrap_err().to_string();
    assert!(error.contains("only on Westlaw") && error.contains("research_read_page"), "{error}");
}

/// The log's false refusal: the answer cited 2012-Ohio-2746 while the capture had stored only
/// 2012 WL 2336914. A capture now records the document's parallel citations and the guard
/// accepts any of them; the KeyCite signals shown are stored with the authority.
#[test]
fn a_capture_records_parallel_citations_so_the_guard_accepts_the_neutral_cite() {
    let (_dir, mut case, task) = case_with_task(true);
    case.set_meta(&format!("research_usage:{task}"), r#"{"navigations":1}"#).unwrap();
    let args = json!({"title": "Stow v. Paster", "jurisdiction": "Ohio Ct. App., 9th Dist.", "relevant_date": "2012-06-20", "citation_text": "2012 WL 2336914", "proposition": "Retention without the owner's consent.", "quote_start_line": 4, "quote_end_line": 4});
    let receipt = run_research(&mut case, &task, westlaw_document_page(STOW_URL), &research::playbook::Playbook::production(), "research_capture", args);
    assert_eq!(receipt["status"], "complete", "{receipt}");
    let output: serde_json::Value = serde_json::from_str(receipt["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["citation_raw"], "2012 WL 2336914");
    assert_eq!(output["citation_parallel"], json!(["2012 WL 2336914", "2012 Ohio 2746"]));
    assert_eq!(output["citation_mismatch"], false);
    assert_eq!(output["keycite"]["flag"], "red");
    let authority = evidence_desk::evidence::read(&case, output["authority_id"].as_str().unwrap(), None).unwrap();
    let content: serde_json::Value = serde_json::from_str(authority["content"].as_str().unwrap()).unwrap();
    assert_eq!(content["citation"]["parallel"], json!(["2012 WL 2336914", "2012 Ohio 2746"]));
    assert_eq!((content["keycite"]["history"].as_u64(), content["keycite"]["citing_references"].as_u64()), (Some(2), Some(9)));
    let answer = "Stow v. Paster, 9th Dist. Summit No. 26050, 2012-Ohio-2746, holds that retention without consent suffices.";
    research::citations::guard(&case, &task, &[answer], &[]).unwrap();
    research::citations::guard(&case, &task, &["Stow v. Paster, 2012 -Ohio- 2746, 2012 WL 2336914."], &[]).unwrap();
    let error = research::citations::guard(&case, &task, &["Compare 2012-Ohio-2747."], &[]).unwrap_err().to_string();
    assert!(error.contains("2012 Ohio 2747"), "{error}");
    // Claiming the neutral cite itself is confirmed by the printed parallel citations too.
    let args = json!({"title": "Stow v. Paster", "jurisdiction": "Ohio", "relevant_date": null, "citation_text": "2012-Ohio-2746", "proposition": "Retention without consent.", "quote_start_line": 4, "quote_end_line": 4});
    let receipt = run_research(&mut case, &task, westlaw_document_page(STOW_URL), &research::playbook::Playbook::production(), "research_capture", args);
    let output: serde_json::Value = serde_json::from_str(receipt["output"].as_str().unwrap()).unwrap();
    assert_eq!(output["citation_mismatch"], false, "{output}");
}
