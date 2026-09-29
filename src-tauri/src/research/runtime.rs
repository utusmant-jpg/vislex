//! Runs research tool jobs against the open research pane, outside the case mutex. One browsing
//! session (isolated world, snapshot version) lives as long as the pane; reopening the pane
//! starts a fresh one. Jobs from different chats take turns on the page.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};

use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};

use super::{cdp::CdpBridge, pane, snapshot::Session, tools::{run_job, Job}};

type Slot = tokio::sync::Mutex<Option<(u64, Session<CdpBridge<Wry>>)>>;

fn slot() -> &'static Slot {
    static SLOT: OnceLock<Slot> = OnceLock::new();
    SLOT.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// The job currently holding the page (task and argument hash).
fn active() -> &'static Mutex<Option<(String, String)>> {
    static ACTIVE: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// The task whose research job holds the page right now, if any.
pub fn active_task() -> Option<String> {
    active().lock().unwrap_or_else(|error| error.into_inner()).as_ref().map(|(task, _)| task.clone())
}

/// Set when a job was cancelled; the next job first releases any mouse button left pressed.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// The job that was cancelled while holding the page, so Stop can stop its page load.
fn interrupted_job() -> &'static Mutex<Option<(String, String)>> {
    static JOB: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
    JOB.get_or_init(|| Mutex::new(None))
}

struct Holding;
impl Holding {
    fn start(job: &Job) -> Self {
        *active().lock().unwrap_or_else(|error| error.into_inner()) = Some((job.task.clone(), job.args_hash.clone()));
        Holding
    }
}
impl Drop for Holding {
    fn drop(&mut self) {
        // Dropped without finishing: the job was cancelled mid-way.
        let unfinished = active().lock().unwrap_or_else(|error| error.into_inner()).take();
        if unfinished.is_some() {
            INTERRUPTED.store(true, Ordering::SeqCst);
            *interrupted_job().lock().unwrap_or_else(|error| error.into_inner()) = unfinished;
        }
    }
}

/// Runs `job` for the case session `(case_id, session_epoch)`. The pane must be open and
/// belong to that case session, at the grant revision the job was checked against.
pub async fn execute(app: &AppHandle<Wry>, case_id: &str, session_epoch: u64, job: &Job) -> Result<Value> {
    let mut guard = slot().lock().await;
    // Read the pane only after taking the page: another chat's job may have closed or reopened it.
    let state = app.state::<pane::PaneState>();
    let Some(webview) = pane::webview(app) else {
        bail!("The research browser is closed. Ask the user to open the Browser view and sign in, then try again.");
    };
    ensure!(
        state.owner().is_some_and(|owner| owner.case_id == case_id && owner.session_epoch == session_epoch && owner.grant_revision == job.grant_revision),
        "The research browser is open for another case or with other settings; ask the user to reopen it"
    );
    let generation = state.generation();
    if !matches!(&*guard, Some((current, _)) if *current == generation) {
        *guard = Some((generation, Session::new(CdpBridge::new(webview))));
    }
    let (_, session) = guard.as_mut().expect("session was just set");
    if INTERRUPTED.swap(false, Ordering::SeqCst) {
        session.driver().call("Input.dispatchMouseEvent", json!({"type": "mouseReleased", "x": 0, "y": 0, "button": "left", "clickCount": 1}), super::cdp::CALL_TIMEOUT).await.ok();
    }
    let holding = Holding::start(job);
    let result = run_job(session, job).await;
    *active().lock().unwrap_or_else(|error| error.into_inner()) = None;
    drop(holding);
    result
}

/// Stops page loading for Stop, but only if `job` is the one holding the page (a job still
/// waiting for its turn must not interrupt another chat's navigation).
pub async fn stop_if_active(app: &AppHandle<Wry>, job: &Job) {
    let key = Some((job.task.clone(), job.args_hash.clone()));
    let held = *active().lock().unwrap_or_else(|error| error.into_inner()) == key;
    let interrupted = {
        let mut last = interrupted_job().lock().unwrap_or_else(|error| error.into_inner());
        if *last == key { last.take().is_some() } else { false }
    };
    if !held && !interrupted {
        return;
    }
    if let Some(webview) = pane::webview(app) {
        let _ = CdpBridge::new(webview).call("Page.stopLoading", json!({}), std::time::Duration::from_secs(5)).await;
    }
}
