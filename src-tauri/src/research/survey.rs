//! R36 survey (debug builds only): while the developer browses the research site in the pane
//! with their own sign-in, record each page's structure so the site playbook's selectors can be
//! written from evidence rather than guesses. Enabled by `VISLEX_RESEARCH_SURVEY_OUTPUT` (a
//! JSON-lines file); never in test mode, never in release builds.
//!
//! Recorded: path (no query string), title, frames, landmarks, form fields, buttons, and
//! elements whose id/class/role suggests results, documents, flags or editorial content — with
//! tag/id/class/role, child counts, text length, and at most 80 characters of text for result,
//! flag and heading candidates. Nothing is sent anywhere.

use std::{io::Write, path::PathBuf, time::Duration};

use serde_json::{json, Value};
use tauri::{AppHandle, Wry};

use super::{cdp::CdpBridge, pane, snapshot::Session, RESEARCH_HOSTS};

const SURVEY_FN: &str = r#"function () {
  const describe = (element, withText) => {
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      tag: element.tagName.toLowerCase(), id: element.id || null, class: (element.getAttribute('class') || '').slice(0, 160) || null,
      role: element.getAttribute('role'), aria: element.getAttribute('aria-label'), children: element.children.length, text_length: text.length,
      text: withText ? text.slice(0, 80) : undefined,
      path: (() => { const parts = []; let node = element; while (node && node.nodeType === 1 && parts.length < 6) { parts.unshift(node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.classList && node.classList.length ? '.' + [...node.classList].slice(0, 2).join('.') : '')); node = node.parentElement; } return parts.join(' > '); })(),
    };
  };
  const all = [...document.querySelectorAll('*')];
  const interesting = /result|document|opinion|content|headnote|keynote|synopsis|summary|keycite|flag|citing|treatment|notes|history|citation|search|filter|jurisdiction|facet|pagination|next/i;
  const candidates = all.filter(element => interesting.test((element.id || '') + ' ' + (element.getAttribute('class') || '') + ' ' + (element.getAttribute('role') || ''))).slice(0, 300);
  return {
    path: location.pathname, host: location.host, title: document.title,
    frames: [...document.querySelectorAll('iframe, frame')].map(frame => ({ id: frame.id || null, name: frame.name || null, class: frame.className || null, src_host: (() => { try { return new URL(frame.src, location.href).host; } catch (error) { return null; } })() })),
    shadow_roots: all.filter(element => element.shadowRoot).length,
    landmarks: [...document.querySelectorAll('main, [role=main], nav, header, aside, [role=navigation], [role=search], form')].slice(0, 40).map(element => describe(element, false)),
    fields: [...document.querySelectorAll('input, textarea, select, [contenteditable=true]')].slice(0, 60).map(element => ({ ...describe(element, false), type: element.getAttribute('type'), name: element.getAttribute('name'), autocomplete: element.getAttribute('autocomplete'), placeholder: element.getAttribute('placeholder') })),
    buttons: [...document.querySelectorAll('button, [role=button]')].slice(0, 80).map(element => describe(element, true)),
    headings: [...document.querySelectorAll('h1, h2, h3')].slice(0, 30).map(element => describe(element, true)),
    candidates: candidates.map(element => describe(element, /result|flag|keycite|citation|treatment/i.test((element.id || '') + ' ' + (element.getAttribute('class') || '')))),
    element_count: all.length,
  };
}"#;

fn append(output: &PathBuf, record: &Value) {
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(output) {
        let _ = writeln!(file, "{record}");
    }
}

/// Starts the survey watcher if `VISLEX_RESEARCH_SURVEY_OUTPUT` is set outside test mode.
pub fn start(app: &AppHandle<Wry>) {
    if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
        return;
    }
    let Some(output) = std::env::var_os("VISLEX_RESEARCH_SURVEY_OUTPUT").filter(|path| !path.is_empty()).map(PathBuf::from) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        let mut session: Option<(u64, Session<CdpBridge<Wry>>)> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let Some(webview) = pane::webview(&app) else { session = None; continue };
            let Ok(url) = webview.url() else { continue };
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            let key = format!("{host}{}", url.path());
            if key == last || !RESEARCH_HOSTS.contains(&host.as_str()) {
                continue;
            }
            // Let the page settle (results and citator panels load after navigation).
            tokio::time::sleep(Duration::from_secs(3)).await;
            let generation = { use tauri::Manager; app.state::<pane::PaneState>().generation() };
            if !matches!(&session, Some((current, _)) if *current == generation) {
                session = Some((generation, Session::new(CdpBridge::new(webview.clone()))));
            }
            let (_, active) = session.as_mut().expect("session set");
            let frames = active.driver().call("Page.getFrameTree", json!({}), super::cdp::CALL_TIMEOUT).await.ok();
            let structure = active.call_in_world(SURVEY_FN, &[], true).await;
            let snapshot = active.snapshot(super::snapshot::Scope::Interactive, None, false, Some(4_000)).await.ok();
            append(&output, &json!({
                "recorded_at": chrono::Utc::now().to_rfc3339(),
                "frame_tree": frames.map(|tree| tree["frameTree"].clone()),
                "structure": structure.map(|value| value.get("value").cloned().unwrap_or(value)).unwrap_or_else(|error| json!({"error": error.to_string()})),
                "interactive_snapshot_chars": snapshot.as_ref().map(|snapshot| snapshot.text.len()),
                "interactive_snapshot_refs": snapshot.as_ref().map(|snapshot| snapshot.ref_count),
            }));
            last = key;
        }
    });
}
