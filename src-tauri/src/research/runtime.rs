//! Runs research tool jobs against the open research pane, outside the case mutex. One browsing
//! session (isolated world, snapshot version) lives as long as the pane; reopening the pane
//! starts a fresh one.

use std::sync::OnceLock;

use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};

use super::{cdp::CdpBridge, pane, snapshot::Session, tools::{run_job, Job}};

type Slot = tokio::sync::Mutex<Option<(u64, Session<CdpBridge<Wry>>)>>;

fn slot() -> &'static Slot {
    static SLOT: OnceLock<Slot> = OnceLock::new();
    SLOT.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Runs `job` for `case_id`. The pane must be open and belong to that case.
pub async fn execute(app: &AppHandle<Wry>, case_id: &str, job: &Job) -> Result<Value> {
    let state = app.state::<pane::PaneState>();
    let Some(webview) = pane::webview(app) else {
        bail!("The research browser is closed. Ask the user to open the Browser view and sign in, then try again.");
    };
    ensure!(state.owner().is_some_and(|owner| owner.case_id == case_id), "The research browser is open for another case");
    let generation = state.generation();
    let mut guard = slot().lock().await;
    if !matches!(&*guard, Some((current, _)) if *current == generation) {
        *guard = Some((generation, Session::new(CdpBridge::new(webview))));
    }
    let (_, session) = guard.as_mut().expect("session was just set");
    run_job(session, job).await
}

/// Stops any page load in progress (used when the user presses Stop).
pub async fn stop_loading(app: &AppHandle<Wry>) {
    if let Some(webview) = pane::webview(app) {
        let _ = CdpBridge::new(webview).call("Page.stopLoading", json!({}), std::time::Duration::from_secs(5)).await;
    }
}
