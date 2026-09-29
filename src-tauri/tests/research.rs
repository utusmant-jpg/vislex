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
                _ => json!({"result": {"value": {"url": url, "title": "Smith", "entry": entry.map(|entry| entry["id"].clone()), "document_text": false}}}),
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
    assert_eq!(content["citation"], json!({"raw": "123 F.3d 456", "claimed": "123 F.3d 456", "mismatch": false}));
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
fn capture_is_refused_without_a_playbook_entry_off_the_document_or_outside_its_text() {
    // The shipped Westlaw entry has no verified selectors yet (R36), so capture refuses there.
    for playbook in [research::playbook::Playbook::with_test_entries(), research::playbook::Playbook::production()] {
        let (_dir, mut case, task) = case_with_task(true);
        let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &playbook, "research_capture", capture_args(0, 0));
        assert_eq!(receipt["status"], "failed");
        assert!(receipt["output"].as_str().unwrap().contains(research::playbook::CAPTURE_UNAVAILABLE), "{receipt}");
        assert_eq!(case.sources().unwrap().len(), 1);
    }
    let (_dir, mut case, task) = case_with_task(true);
    // Outside debug test mode a loopback page is off the research site, whatever the playbook.
    let receipt = run_research(&mut case, &task, fixture_page("http://127.0.0.1:9471/opinion.html"), &research::playbook::Playbook::with_test_entries(), "research_capture", capture_args(0, 0));
    assert!(receipt["output"].as_str().unwrap().contains("sign-in or outside page"), "{receipt}");
    // A results page is not a document, and lines outside the document text are refused.
    let receipt = run_research(&mut case, &task, fixture_page(RESULTS_URL), &document_playbook(), "research_capture", capture_args(0, 0));
    assert!(receipt["output"].as_str().unwrap().contains("no document text"), "{receipt}");
    let receipt = run_research(&mut case, &task, fixture_page(DOCUMENT_URL), &document_playbook(), "research_capture", capture_args(4, 5));
    assert!(receipt["output"].as_str().unwrap().contains("outside this document"), "{receipt}");
    assert_eq!(case.sources().unwrap().len(), 1);
}

#[test]
fn capture_arguments_and_limits_are_checked_before_the_page_is_touched() {
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
    for _ in 1..research::Caps::default().captures {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_capture", capture_args(3, 4))).unwrap().is_some());
    }
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_capture", capture_args(3, 4))).unwrap().is_none());
    assert!(case.meta(&format!("research_result:{task}")).unwrap().unwrap().contains("limit of 25 research captures"));
    let requested: i64 = case.db.query_row("SELECT count(*) FROM audit WHERE event='research_capture_requested'", [], |row| row.get(0)).unwrap();
    assert_eq!(requested, 25);
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
fn navigation_addresses_carrying_search_text_are_refused() {
    let (_dir, mut case, task) = case_with_task(true);
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    let long = format!("https://1.next.westlaw.com/Document/{}", "a".repeat(300));
    for url in ["https://1.next.westlaw.com/Search/negligent%20hiring%20smith", "https://1.next.westlaw.com/x/evidence%3Asrc1", "https://1.next.westlaw.com/a%0Ab", long.as_str()] {
        assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &call("research_navigate", json!({"url": url}))).unwrap().is_none(), "{url}");
    }
    let document = call("research_navigate", json!({"url": "https://1.next.westlaw.com/Document/I0a1b2c3d4/View/FullText.html"}));
    assert!(research::tools::prepare_research(&mut case, &task, &request.transmission, &document).unwrap().is_some());
    // Page changes also count against a case-wide pace shared by every chat.
    assert!(case.meta("research_recent_page_changes").unwrap().is_some_and(|raw| raw.starts_with('[') && raw.len() > 2));
}

#[test]
fn the_agent_never_navigates_away_from_a_sign_in_page() {
    use research::{snapshot::Session, tools::run_job};
    let mut session = Session::new(page_at("https://signon.thomsonreuters.com/?returnto=x", "https://signon.thomsonreuters.com/"));
    let navigate = research_job("research_navigate", json!({"url": "https://1.next.westlaw.com/Home"}));
    assert!(block_on(run_job(&mut session, &navigate)).unwrap_err().to_string().contains("sign-in"));
    assert!(!session.driver().methods().iter().any(|method| method == "Page.navigate"));
}

#[test]
fn page_content_is_dropped_when_the_page_moved_off_site_meanwhile() {
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
            "Runtime.callFunctionOn" if function.contains("ariaSnapshot") => json!({"result": {"value": {"text": "- textbox \"Username\" [ref=e1]: someone@example.com", "url": "https://signon.thomsonreuters.com/", "title": "Sign in"}}}),
            "Runtime.callFunctionOn" if function.contains("innerText") => json!({"result": {"value": {"lines": ["someone@example.com"], "url": "https://signon.thomsonreuters.com/", "title": "Sign in"}}}),
            other => anyhow::bail!("unexpected {other}"),
        })
    });
    let mut session = Session::new(driver);
    let snapshot = research_job("research_snapshot", json!({"scope": "interactive", "find": null, "delta": false, "max_chars": null}));
    let error = block_on(run_job(&mut session, &snapshot)).unwrap_err().to_string();
    assert!(error.contains("sign-in") && !error.contains("someone@"), "{error}");
    let read = research_job("research_read_page", json!({"offset": 0, "count": 5}));
    let error = block_on(run_job(&mut session, &read)).unwrap_err().to_string();
    assert!(error.contains("sign-in") && !error.contains("someone@"), "{error}");
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
    let call = evidence_desk::agent::prepare_subscription_call(&mut case, &task, "codex-call-off-site", "research_navigate", json!({"url": "https://evil.example/"})).unwrap();
    assert!(research::tools::prepare_research(&mut case, &task, &call.transmission, &call.response).unwrap().is_none());
    let result = evidence_desk::agent::finish_subscription_call(&mut case, &task, call, &mut Default::default()).unwrap();
    assert!(result["error"].as_str().unwrap().contains("only the research site"));
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
    assert_eq!(activity_detail("research_read_page", &json!({"offset": 40, "count": 60})).as_deref(), Some("lines 40\u{2013}100"));
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
    let request = evidence_desk::agent::prepare_request(&mut case, &task).unwrap();
    evidence_desk::agent::receive(&mut case, &task, &request.transmission, record("After research")).unwrap();
    let output = last_action(&case, &task)["output"].to_string();
    assert!(output.contains("research_capture") && output.contains("123 F.3d 456"), "{output}");
}
