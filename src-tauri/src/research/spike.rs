//! R34 spike (debug builds, test mode, loopback fixture only): measures whether each DevTools
//! method the research browser depends on works through WebView2's in-process bridge on this
//! machine, and checks the pane's isolation. Results are evidence for the spike report; this
//! module is not part of any release build.

use std::time::{Duration, Instant};

use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use super::{cdp::CdpBridge, cdp::CALL_TIMEOUT, pane};

const SAMPLES: usize = 50;

fn percentile(samples: &mut [f64], fraction: f64) -> f64 {
    samples.sort_by(|a, b| a.total_cmp(b));
    samples[((samples.len() - 1) as f64 * fraction).round() as usize]
}

async fn timed<R: Runtime>(bridge: &CdpBridge<R>, method: &str, params: Value) -> (Result<Value>, f64) {
    let started = Instant::now();
    let result = bridge.call(method, params, CALL_TIMEOUT).await;
    (result, started.elapsed().as_secs_f64() * 1000.0)
}

/// Runs one method `SAMPLES` times; records works / error and latency percentiles.
async fn measure<R: Runtime>(bridge: &CdpBridge<R>, method: &str, params: Value) -> Value {
    let mut latencies = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let (result, elapsed) = timed(bridge, method, params.clone()).await;
        if let Err(error) = result {
            return json!({"method": method, "works": false, "error": error.to_string()});
        }
        latencies.push(elapsed);
    }
    json!({"method": method, "works": true, "p50_ms": percentile(&mut latencies, 0.5), "p95_ms": percentile(&mut latencies, 0.95)})
}

async fn once<R: Runtime>(bridge: &CdpBridge<R>, method: &str, params: Value) -> Value {
    let (result, elapsed) = timed(bridge, method, params).await;
    match result {
        Ok(value) => json!({"method": method, "works": true, "ms": elapsed, "bytes": value.to_string().len()}),
        Err(error) => json!({"method": method, "works": false, "error": error.to_string()}),
    }
}

async fn evaluate<R: Runtime>(bridge: &CdpBridge<R>, expression: &str) -> Result<Value> {
    let result = bridge
        .call("Runtime.evaluate", json!({"expression": expression, "returnByValue": true, "awaitPromise": true}), CALL_TIMEOUT)
        .await?;
    Ok(result["result"]["value"].clone())
}

async fn wait_for<R: Runtime>(bridge: &CdpBridge<R>, expression: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last = String::new();
    while Instant::now() < deadline {
        match evaluate(bridge, expression).await {
            Ok(Value::Bool(true)) => return Ok(()),
            Ok(value) => last = format!("value {value}"),
            Err(error) => last = format!("error {error:#}"),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let location = evaluate(bridge, "location.href").await.map(|value| value.to_string()).unwrap_or_else(|error| format!("error {error:#}"));
    let source = bridge.webview().url().map(|url| url.to_string()).unwrap_or_default();
    anyhow::bail!("Timed out waiting for {expression}; last {last}; location {location}; webview url {source}")
}

pub async fn run<R: Runtime>(app: AppHandle<R>, start: String, profile: std::path::PathBuf) -> Result<Value> {
    ensure!(std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1"), "Spike runs only in test mode");
    ensure!(super::NavigationPolicy::resolve(Vec::new())?.is_mock(), "Spike requires VISLEX_RESEARCH_MOCK_URL");
    ensure!(profile.is_absolute(), "Spike profile must be an absolute path");
    let rect = pane::Rect { x: 700.0, y: 60.0, width: 760.0, height: 820.0 };
    let (open_app, open_start, open_profile) = (app.clone(), start.clone(), profile.clone());
    let opened_at = Instant::now();
    let webview = tauri::async_runtime::spawn_blocking(move || pane::open(&open_app, &open_start, open_profile, None, Vec::new(), rect))
        .await
        .context("Pane creation task failed")??;
    let open_ms = opened_at.elapsed().as_secs_f64() * 1000.0;
    let bridge = CdpBridge::new(webview);
    let mut report = json!({"open_ms": open_ms});
    wait_for(&bridge, "document.readyState === 'complete' && Boolean(document.getElementById('search'))").await?;

    let profile_is_own = {
        let (pane, profile) = (bridge.webview().clone(), profile.clone());
        tauri::async_runtime::spawn_blocking(move || super::cdp::user_data_folder(&pane).map(|folder| super::same_path(&folder, &profile)))
            .await
            .ok()
            .and_then(Result::ok)
    };
    report["environment"] = json!({
        "user_agent": evaluate(&bridge, "navigator.userAgent").await.ok(),
        "profile_has_ebwebview": profile.join("EBWebView").exists(),
        "profile_entries": std::fs::read_dir(&profile).map(|entries| entries.filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default(),
        "webview2_user_data_folder_env": std::env::var("WEBVIEW2_USER_DATA_FOLDER").is_ok(),
        "effective_user_data_folder_is_profile": profile_is_own,
    });
    // Can the browser's effective switches be read back (to detect a debugging switch)?
    report["browser_command_line"] = match bridge.call("Browser.getBrowserCommandLine", json!({}), CALL_TIMEOUT).await {
        Ok(value) => json!({"works": true, "has_remote_debugging": value.to_string().contains("remote-debugging")}),
        Err(error) => json!({"works": false, "error": error.to_string()}),
    };

    // Latency and availability of the methods the tools rely on.
    let mut methods = Vec::new();
    methods.push(measure(&bridge, "Runtime.evaluate", json!({"expression": "1+1", "returnByValue": true})).await);
    methods.push(measure(&bridge, "DOM.getDocument", json!({"depth": 1})).await);
    let document = bridge.call("DOM.getDocument", json!({"depth": 1}), CALL_TIMEOUT).await?;
    let root = document["root"]["nodeId"].clone();
    let search = bridge.call("DOM.querySelector", json!({"nodeId": root, "selector": "#search"}), CALL_TIMEOUT).await?;
    let button = bridge.call("DOM.querySelector", json!({"nodeId": root, "selector": "#go"}), CALL_TIMEOUT).await?;
    methods.push(measure(&bridge, "DOM.describeNode", json!({"nodeId": search["nodeId"]})).await);
    methods.push(measure(&bridge, "DOM.getBoxModel", json!({"nodeId": button["nodeId"]})).await);
    methods.push(measure(&bridge, "DOM.getOuterHTML", json!({"nodeId": root})).await);
    methods.push(once(&bridge, "Page.enable", json!({})).await);
    methods.push(once(&bridge, "Page.getFrameTree", json!({})).await);
    methods.push(once(&bridge, "Page.captureSnapshot", json!({"format": "mhtml"})).await);
    methods.push(once(&bridge, "Accessibility.getFullAXTree", json!({})).await);
    methods.push(once(&bridge, "DOMSnapshot.captureSnapshot", json!({"computedStyles": []})).await);
    methods.push(once(&bridge, "Target.setAutoAttach", json!({"autoAttach": false, "waitForDebuggerOnStart": false, "flatten": true})).await);
    report["methods"] = Value::Array(methods);

    // Isolated world: sees the DOM, invisible to page script.
    let frames = bridge.call("Page.getFrameTree", json!({}), CALL_TIMEOUT).await?;
    let frame_id = frames["frameTree"]["frame"]["id"].clone();
    report["isolated_world"] = match bridge
        .call("Page.createIsolatedWorld", json!({"frameId": frame_id, "worldName": "vislex", "grantUniveralAccess": false}), CALL_TIMEOUT)
        .await
    {
        Ok(world) => {
            let context = world["executionContextId"].clone();
            let inside = bridge
                .call(
                    "Runtime.callFunctionOn",
                    json!({"executionContextId": context, "functionDeclaration": "function (marker) { window.__vislexProbe = marker; return document.title; }", "arguments": [{"value": "set"}], "returnByValue": true}),
                    CALL_TIMEOUT,
                )
                .await;
            let page_sees = evaluate(&bridge, "typeof window.__vislexProbe").await.ok();
            json!({"created": true, "call_function_on": inside.as_ref().map(|value| value["result"]["value"].clone()).map_err(|error| error.to_string()).unwrap_or_else(Value::String), "page_sees_world_global": page_sees})
        }
        Err(error) => json!({"created": false, "error": error.to_string()}),
    };

    // Trusted input: click at the button's box-model centre, type into the focused search box.
    let box_model = bridge.call("DOM.getBoxModel", json!({"nodeId": button["nodeId"]}), CALL_TIMEOUT).await?;
    let quad = box_model["model"]["content"].as_array().cloned().unwrap_or_default();
    let centre = |axis: usize| quad.iter().skip(axis).step_by(2).filter_map(Value::as_f64).sum::<f64>() / 4.0;
    let (x, y) = (centre(0), centre(1));
    bridge.call("DOM.focus", json!({"nodeId": search["nodeId"]}), CALL_TIMEOUT).await?;
    let typed = bridge.call("Input.insertText", json!({"text": "negligence /s duty"}), CALL_TIMEOUT).await;
    let hit = evaluate(&bridge, &format!("document.elementFromPoint({x}, {y})?.id ?? null")).await.ok();
    let mut mouse = Vec::new();
    for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
        let result = bridge
            .call("Input.dispatchMouseEvent", json!({"type": kind, "x": x, "y": y, "button": if kind == "mouseMoved" { "none" } else { "left" }, "clickCount": 1}), CALL_TIMEOUT)
            .await;
        mouse.push(json!({"type": kind, "ok": result.is_ok(), "error": result.err().map(|error| error.to_string())}));
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let trusted_click = evaluate(&bridge, "window.__clicked === true").await.ok();
    // Fallback: an element click from the isolated world (untrusted event).
    let world = bridge.call("Page.createIsolatedWorld", json!({"frameId": frame_id, "worldName": "vislex-click", "grantUniveralAccess": false}), CALL_TIMEOUT).await?;
    let resolved = bridge.call("DOM.resolveNode", json!({"nodeId": button["nodeId"], "executionContextId": world["executionContextId"]}), CALL_TIMEOUT).await?;
    let element_click = bridge
        .call("Runtime.callFunctionOn", json!({"objectId": resolved["object"]["objectId"], "functionDeclaration": "function () { this.click(); return true; }", "returnByValue": true}), CALL_TIMEOUT)
        .await
        .is_ok();
    report["input"] = json!({
        "point": [x, y],
        "element_at_point": hit,
        "mouse_events": mouse,
        "trusted_click_registered": trusted_click,
        "element_click_ok": element_click,
        "insert_text": typed.is_ok(),
        "value_after_typing": evaluate(&bridge, "document.getElementById('search').value").await.ok(),
        "click_registered": evaluate(&bridge, "window.__clicked === true").await.ok(),
        "click_trusted": evaluate(&bridge, "window.__clickTrusted === true").await.ok(),
    });

    // Isolation of the child: no Tauri IPC, no evidence protocol.
    report["isolation"] = json!({
        "tauri_internals": evaluate(&bridge, "typeof window.__TAURI_INTERNALS__").await.ok(),
        "invoke": evaluate(&bridge, "(async () => { try { await window.__TAURI_INTERNALS__.invoke('command', {action: 'case_summary', args: {}}); return 'allowed'; } catch (error) { return 'refused: ' + String(error).slice(0, 160); } })()").await.ok(),
        "evidence_fetch": evaluate(&bridge, "fetch('http://evidence.localhost/probe').then(response => 'status ' + response.status).catch(error => 'error: ' + String(error).slice(0, 120))").await.ok(),
    });

    // Navigation policy and events.
    let mut navigated = bridge.subscribe("Page.frameNavigated").await?;
    let second = format!("{}/second.html", start.trim_end_matches('/').rsplit_once('/').map(|(base, _)| base).unwrap_or(&start));
    let nav_started = Instant::now();
    let nav = bridge.call("Page.navigate", json!({"url": second}), Duration::from_secs(60)).await;
    let event = tokio::time::timeout(Duration::from_secs(10), navigated.recv()).await.ok().flatten();
    wait_for(&bridge, "document.readyState === 'complete' && document.title === 'second'").await.ok();
    let blocked = bridge.call("Page.navigate", json!({"url": "https://example.com/"}), Duration::from_secs(60)).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let popup_before = evaluate(&bridge, "location.href").await.ok();
    evaluate(&bridge, "window.open('https://example.com/', '_blank') === null").await.ok();
    tokio::time::sleep(Duration::from_millis(800)).await;
    let webview_count = {
        use tauri::Manager;
        app.webviews().len()
    };
    report["navigation"] = json!({
        "navigate_ok": nav.is_ok(),
        "navigate_ms": nav_started.elapsed().as_secs_f64() * 1000.0,
        "frame_navigated_event": event.map(|value| value["frame"]["url"].clone()),
        "blocked_navigate_result": blocked.map(|value| value.to_string()).unwrap_or_else(|error| format!("error: {error}")),
        "url_after_blocked": evaluate(&bridge, "location.href").await.ok(),
        "url_before_popup": popup_before,
        "stop_loading": bridge.call("Page.stopLoading", json!({}), CALL_TIMEOUT).await.is_ok(),
        "webview_count": webview_count,
    });

    // Attack probe: frame the VisLex UI (local origin) inside the research pane and try its
    // command from that frame. Expected: frame-ancestors blocks it; if not, the command's
    // webview-label check refuses.
    let mut contexts = bridge.subscribe("Runtime.executionContextCreated").await?;
    bridge.call("Runtime.enable", json!({}), CALL_TIMEOUT).await?;
    let frame_page = format!("{}/frame.html", second.rsplit_once('/').map(|(base, _)| base).unwrap_or(&second));
    let frame_navigation = bridge.call("Page.navigate", json!({"url": frame_page}), Duration::from_secs(60)).await.map(|value| value.to_string()).unwrap_or_else(|error| format!("error: {error}"));
    let frame_loaded = wait_for(&bridge, "document.readyState === 'complete' && document.title === 'frame'").await.map_err(|error| error.to_string());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let tree = bridge.call("Page.getFrameTree", json!({}), CALL_TIMEOUT).await?;
    let children: Vec<Value> = tree["frameTree"]["childFrames"].as_array().cloned().unwrap_or_default().into_iter().map(|child| child["frame"].clone()).collect();
    let child = children.iter().find(|frame| frame["url"].as_str().is_some_and(|url| url.contains("tauri.localhost"))).cloned().unwrap_or(Value::Null);
    let mut child_context = None;
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(300), contexts.recv()).await {
        let context = &event["context"];
        if context["auxData"]["frameId"] == child["id"] && context["auxData"]["isDefault"] == Value::Bool(true) {
            child_context = context["id"].as_i64();
        }
    }
    let framed_invoke = match child_context {
        Some(context) => bridge
            .call("Runtime.evaluate", json!({"contextId": context, "awaitPromise": true, "returnByValue": true, "expression": "(async () => { if (!window.__TAURI_INTERNALS__) return 'no tauri internals'; try { await window.__TAURI_INTERNALS__.invoke('command', {action: 'case_summary', args: {}}); return 'allowed'; } catch (error) { return 'refused: ' + String(error).slice(0, 160); } })()"}), CALL_TIMEOUT)
            .await
            .map(|value| value["result"]["value"].clone())
            .unwrap_or_else(|error| Value::String(format!("error: {error}"))),
        None => Value::String("no default context for the framed page".into()),
    };
    report["framed_app_attack"] = json!({
        "navigate": frame_navigation,
        "loaded": frame_loaded.err(),
        "iframe_in_dom": evaluate(&bridge, "Boolean(document.getElementById('app'))").await.ok(),
        "child_frame_urls": children.iter().map(|frame| frame["url"].clone()).collect::<Vec<_>>(),
        "child_frame_url": child["url"],
        "child_frame_title": child_context.map(|_| "context found"),
        "invoke_from_frame": framed_invoke,
    });
    drop(contexts);

    // UI responsiveness under sequential calls, and layout operations.
    let mut latencies = Vec::new();
    for _ in 0..100 {
        latencies.push(timed(&bridge, "Runtime.evaluate", json!({"expression": "0", "returnByValue": true})).await.1);
    }
    let layout = [
        pane::layout(&app, pane::Rect { x: 720.0, y: 80.0, width: 600.0, height: 500.0 }, true),
        pane::layout(&app, pane::Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 }, false),
    ];
    let hidden_still_runs = evaluate(&bridge, "document.title").await.is_ok();
    report["responsiveness"] = json!({
        "sequential_100_median_ms": percentile(&mut latencies.clone(), 0.5),
        "sequential_100_p95_ms": percentile(&mut latencies, 0.95),
        "layout_ok": layout.iter().all(Result::is_ok),
        "hidden_webview_still_evaluates": hidden_still_runs,
    });
    pane::close(&app)?;
    // The spike fails unless the isolation invariants held, not merely because it ran.
    let refused = |value: &Value| value.as_str().is_some_and(|text| text.starts_with("refused") || text.starts_with("error") || text.starts_with("no "));
    let mut violations = Vec::new();
    if !refused(&report["isolation"]["invoke"]) { violations.push("research page could invoke commands"); }
    if !refused(&report["isolation"]["evidence_fetch"]) { violations.push("research page could fetch evidence"); }
    if !refused(&report["framed_app_attack"]["invoke_from_frame"]) { violations.push("framed VisLex UI could invoke commands"); }
    if report["navigation"]["url_after_blocked"].as_str().is_some_and(|url| url.contains("example.com")) { violations.push("blocked navigation proceeded"); }
    if report["navigation"]["webview_count"].as_u64() != Some(2) { violations.push("a pop-up created another webview"); }
    if !report["environment"]["webview2_user_data_folder_env"].as_bool().unwrap_or(true) && report["environment"]["effective_user_data_folder_is_profile"] != Value::Bool(true) {
        violations.push("research pane did not use its own profile");
    }
    ensure!(violations.is_empty(), "Isolation violated: {}; report {}", violations.join(", "), report);
    Ok(report)
}
