use anyhow::Context;
use crate::{

    agent, backup,

    case::{Case, Settings},

};

use serde_json::{json, Value};

use std::{

    io::{Read, Seek, SeekFrom},

    path::{Path, PathBuf},

    sync::Mutex,

};

use tauri::{Emitter, Manager};



pub struct AppState {

    case: Mutex<Option<Case>>,
    active_case_id: Mutex<Option<String>>,
    session_epoch: std::sync::atomic::AtomicU64,
    event_seq: std::sync::atomic::AtomicU64,
    importing: std::sync::atomic::AtomicBool,
    pending_app_ai: std::sync::atomic::AtomicBool,
    semantic_indexing: Mutex<std::collections::HashMap<String,bool>>,

}

fn text<'a>(v: &'a Value, k: &str) -> anyhow::Result<&'a str> {

    v[k].as_str().ok_or_else(|| anyhow::anyhow!("Missing {k}"))

}
fn stamp_session(mut value: Value, state: &AppState) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("session_epoch".to_string(), json!(state.session_epoch.load(std::sync::atomic::Ordering::SeqCst)));
        object.insert("event_seq".to_string(), json!(state.event_seq.load(std::sync::atomic::Ordering::SeqCst)));
    }
    value
}
fn emit_case_changed(app: &tauri::AppHandle) {
    let state=app.state::<AppState>();
    let active=state.active_case_id.lock().unwrap_or_else(|e|e.into_inner());
    let case_id=active.clone();
    let session_epoch=state.session_epoch.load(std::sync::atomic::Ordering::SeqCst);
    drop(active);
    let event_seq=state.event_seq.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1;
    let _=app.emit("case-event",json!({"case_id":case_id,"session_epoch":session_epoch,"event_seq":event_seq}));
    let _=app.emit("case-changed",());
}
fn ensure_session_epoch(state: &AppState, args: &Value) -> anyhow::Result<()> {
    if let Some(epoch) = args.get("session_epoch") {
        let epoch = epoch.as_u64().context("Invalid session_epoch")?;
        anyhow::ensure!(
            epoch == state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),
            "Case session changed; refresh before continuing"
        );
    }
    Ok(())
}
fn export_revision(v:&Value)->anyhow::Result<Option<i64>> {
    if v.get("expected_revision").is_none() {return Ok(None);}
    Ok(Some(v["expected_revision"].as_i64().context("Invalid expected_revision")?))
}

/// Keys live in Windows Credential Manager and are app-wide. With a case open,
/// the request must name that case (its session epoch is checked separately);
/// with no case open, only an app-level request without a case ID is accepted.
fn provider_key_case_fence(open_case: Option<&str>, args: &Value) -> anyhow::Result<()> {
    let requested = args.get("case_id").filter(|value| !value.is_null());
    match (open_case, requested) {
        (Some(open), Some(requested)) if requested.as_str() == Some(open) => Ok(()),
        (None, None) => Ok(()),
        _ => anyhow::bail!("Case changed before provider key update"),
    }
}

fn provider_key_entry(provider: crate::providers::Provider) -> anyhow::Result<keyring::Entry> {

    Ok(keyring::Entry::new(

        "org.localevidencedesk.app",

        provider.credential(),

    )?)

}
fn require_session_epoch(state: &AppState, args: &Value) -> anyhow::Result<()> {
    let epoch = args["session_epoch"].as_u64().context("Missing session_epoch")?;
    anyhow::ensure!(epoch == state.session_epoch.load(std::sync::atomic::Ordering::SeqCst), "Case session changed; refresh before continuing");
    Ok(())
}

/// A native test journey must never open, migrate or write a real case (the UI reopens the
/// last case at startup). Debug test mode creates, opens and restores cases only inside
/// `VISLEX_TEST_CASE_ROOT`, and refuses all of them when it is unset.
fn ensure_test_case_path(path: &Path) -> anyhow::Result<()> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
        // Fails closed: without a non-empty root, test mode opens no case at all.
        let root = std::env::var_os("VISLEX_TEST_CASE_ROOT").filter(|root| !root.is_empty()).context("Test mode needs VISLEX_TEST_CASE_ROOT")?;
        let root = crate::research::path_components(Path::new(&root));
        anyhow::ensure!(!root.is_empty() && crate::research::path_components(path).starts_with(&root), "Test mode opens cases only under VISLEX_TEST_CASE_ROOT");
    }
    let _ = path;
    Ok(())
}

fn provider_key_for_case(provider: crate::providers::Provider) -> anyhow::Result<String> {
    if crate::providers::synthetic_provider_url()?.is_some() {
        return Ok("synthetic-local-transport".into());
    }
    stored_provider_key(provider)
}

/// The key a request would send. Test mode shares Windows Credential Manager
/// with the user's real app, so without a loopback synthetic endpoint it acts
/// as if no key were saved: a native test journey can never reach a real
/// provider with the user's key (automatic review included).
fn stored_provider_key(provider: crate::providers::Provider) -> anyhow::Result<String> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {
        anyhow::bail!("Test mode does not use stored provider keys; set VISLEX_TEST_PROVIDER_URL to a loopback endpoint");
    }
    Ok(provider_key_entry(provider)?.get_password()?)
}




#[tauri::command]

async fn command(app: tauri::AppHandle, webview: tauri::Webview, action: String, args: Value) -> Result<Value, String> {
    // The app has no command ACL manifest, so Tauri checks app commands only by origin. A
    // local-origin frame inside another webview (the research pane) must not reach them.
    if webview.label() != "main" {
        return Err("Commands are limited to the application webview".into());
    }
    // R34 spike: debug test builds only, against a loopback fixture; never in a release build.
    #[cfg(all(feature = "research", windows, debug_assertions))]
    if action=="research_spike" && std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {
        let start=text(&args,"url").map_err(|e|e.to_string())?.to_string();
        let profile=PathBuf::from(text(&args,"profile").map_err(|e|e.to_string())?);
        return crate::research::spike::run(app, start, profile).await.map_err(|e|format!("{e:#}"));
    }
    #[cfg(feature = "research")]
    if let Some(result) = research_pane_command(&app, &action, &args).await {
        return result.map_err(|e| format!("{e:#}"));
    }
    if action=="fetch_public_authority" {
        let prepared=(||->anyhow::Result<_>{let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before authority retrieval");require_session_epoch(&state,&args)?;anyhow::ensure!(!case.settings()?.offline,"Offline mode enabled");let url=text(&args,"url")?.to_string();crate::authority::validate_url(&url)?;Ok((case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),url))})();
        let (case_id,epoch,url)=prepared.map_err(|e|e.to_string())?;
        let download=crate::authority::retrieve(&url).await.map_err(|e|e.to_string())?;
        let value=with_case_expected(&app,&case_id,Some(epoch),|case|crate::authority::publish(case,download,text(&args,"title")?,text(&args,"jurisdiction")?,text(&args,"relevant_date")?)).map_err(|e|e.to_string())?;
        kick_automatic(app.clone(),case_id);emit_case_changed(&app);return Ok(value);
    }
    // Second opinion: the network send runs here, outside the case mutex, after
    // prepare_send re-checked the grant, restriction, offline mode and clip hash.
    if action=="send_second_opinion" {
        let result=send_second_opinion(&app,&args).await;
        emit_case_changed(&app);
        return result.map_err(|e|e.to_string());
    }
    // Explicit account metadata lookup: no case material and no case mutex during network I/O.
    if action == "provider_models" {
        let provider:crate::providers::Provider=serde_json::from_value(args["provider"].clone()).map_err(|e|e.to_string())?;
        let key=stored_provider_key(provider).map_err(|_|format!("Save a {} API key first",provider.name()))?;
        let models=tokio::time::timeout(std::time::Duration::from_secs(45),crate::providers::list_models(provider,&key)).await.map_err(|_|"Model catalogue request timed out; retry when connected".to_string())?.map_err(|e|e.to_string())?;
        return serde_json::to_value(models).map_err(|e|e.to_string());
    }


    #[cfg(feature = "research")]
    let enforce_app = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || dispatch(&app, &action, args)).await;
    // Any command may switch or close the case, go offline or turn research off; check even
    // if the command failed or panicked.
    #[cfg(feature = "research")]
    enforce_research_pane(&enforce_app);
    joined.map_err(|e| e.to_string())?.map_err(|e| e.to_string())

}

/// Research pane commands. They run here, not in `dispatch`, because creating the child
/// webview blocks on the UI thread and must never happen under the case mutex.
#[cfg(feature = "research")]
async fn research_pane_command(app: &tauri::AppHandle, action: &str, args: &Value) -> Option<anyhow::Result<Value>> {
    use crate::research::pane;
    let result = match action {
        "open_research_pane" => async {
            let rect: pane::Rect = serde_json::from_value(args["rect"].clone()).context("Missing research pane position")?;
            let (owner, root, sso_hosts) = {
                let state = app.state::<AppState>();
                let guard = state.case.lock().unwrap_or_else(|e| e.into_inner());
                let case = guard.as_ref().context("Open a case first")?;
                require_session_epoch(&state, args)?;
                let id = case.meta("id")?.unwrap_or_default();
                anyhow::ensure!(id == text(args, "case_id")?, "Case changed before opening the research browser");
                anyhow::ensure!(!case.settings()?.offline, "Offline mode enabled");
                let grant = crate::research::grant(case)?.filter(|grant| grant.enabled).context("Turn on the research browser for this case in Settings")?;
                let owner = pane::Owner { case_id: id, session_epoch: state.session_epoch.load(std::sync::atomic::Ordering::SeqCst), grant_revision: grant.revision };
                (owner, case.root.clone(), grant.sso_hosts)
            };
            let state = app.state::<pane::PaneState>();
            if let Some(current) = state.owner() {
                anyhow::ensure!(current == owner, "The research browser is open for another case session");
            }
            let generation = state.generation();
            let (handle, profile, start) = (app.clone(), pane::profile_dir(app)?, pane::start_url()?);
            tauri::async_runtime::spawn_blocking(move || pane::open(&handle, &start, profile, Some(&root), sso_hosts, rect).map(|_| ()))
                .await
                .context("Research pane task failed")??;
            // Opening takes a while: if the pane was closed meanwhile, or the case session no
            // longer allows it (switched, offline, switched off, hosts changed), discard it.
            if generation != state.generation() || !research_allowed_for(app, &owner) {
                let _ = pane::close(app);
                anyhow::bail!("The case changed while the research browser was opening");
            }
            if state.owner().is_none() {
                state.set_owner(Some(owner.clone()));
                with_case_expected(app, &owner.case_id, Some(owner.session_epoch), |case| case.audit("research_pane_opened", json!({"grant_revision": owner.grant_revision})))?;
            }
            Ok(json!({"open": true}))
        }
        .await,
        "research_pane_layout" => (|| {
            let rect: pane::Rect = serde_json::from_value(args["rect"].clone()).context("Missing research pane position")?;
            pane::layout(app, rect, args["visible"].as_bool().unwrap_or(false))?;
            Ok(Value::Null)
        })(),
        "research_pane_state" => (|| {
            let pane = pane::webview(app);
            let url = pane.as_ref().and_then(|pane| pane.url().ok());
            Ok(json!({
                "open": pane.is_some(),
                "case_id": app.state::<pane::PaneState>().owner().map(|owner| owner.case_id),
                "host": url.as_ref().and_then(|url| url.host_str().map(str::to_string)),
                "secure": url.as_ref().map(|url| url.scheme() == "https"),
            }))
        })(),
        "close_research_pane" => close_research_pane(app, "user"),
        "clear_research_session" => async {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || pane::clear_session(&handle)).await.context("Research session task failed")??;
            let state = app.state::<AppState>();
            let mut guard = state.case.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(case) = guard.as_mut() {
                case.audit("research_session_cleared", json!({}))?;
            }
            Ok(Value::Null)
        }
        .await,
        _ => return None,
    };
    Some(result)
}

/// Whether the open case session still allows the pane `owner` opened.
#[cfg(feature = "research")]
fn research_allowed_for(app: &tauri::AppHandle, owner: &crate::research::pane::Owner) -> bool {
    let state = app.state::<AppState>();
    let guard = state.case.lock().unwrap_or_else(|e| e.into_inner());
    state.session_epoch.load(std::sync::atomic::Ordering::SeqCst) == owner.session_epoch
        && guard.as_ref().is_some_and(|case| {
            case.meta("id").ok().flatten().as_deref() == Some(owner.case_id.as_str())
                && case.settings().is_ok_and(|settings| !settings.offline)
                && crate::research::grant(case).ok().flatten().is_some_and(|grant| grant.enabled && grant.revision == owner.grant_revision)
        })
}

#[cfg(feature = "research")]
fn close_research_pane(app: &tauri::AppHandle, reason: &str) -> anyhow::Result<Value> {
    use crate::research::pane;
    let owner = app.state::<pane::PaneState>().owner();
    let was_open = pane::webview(app).is_some();
    pane::close(app)?;
    if let (Some(owner), true) = (owner, was_open) {
        let _ = with_case_expected(app, &owner.case_id, None, |case| case.audit("research_pane_closed", json!({"reason": reason})));
    }
    Ok(Value::Null)
}

/// Before the open case is switched, closed or deleted: close its research pane and record
/// that in the outgoing case's audit log (afterwards that case is no longer reachable).
#[cfg(feature = "research")]
fn close_research_for_case_change(app: &tauri::AppHandle, case: &mut Case, reason: &str) {
    use crate::research::pane;
    let owned = app.state::<pane::PaneState>().owner().is_some_and(|owner| case.meta("id").ok().flatten().as_deref() == Some(owner.case_id.as_str()));
    if owned || pane::webview(app).is_some() {
        let _ = pane::close(app);
        if owned {
            let _ = case.audit("research_pane_closed", json!({"reason": reason}));
        }
    }
}

/// Closes the research pane when its case session is no longer current, the case went
/// offline, or the research browser was switched off or reconfigured for it.
#[cfg(feature = "research")]
fn enforce_research_pane(app: &tauri::AppHandle) {
    use crate::research::pane;
    let state = app.state::<pane::PaneState>();
    match state.owner() {
        Some(owner) if !research_allowed_for(app, &owner) => {
            let _ = close_research_pane(app, "case changed, offline, or research switched off or reconfigured");
        }
        // A pane with no owner (for example after a failed open) never stays open.
        None if pane::webview(app).is_some() && !state.busy() => {
            let _ = pane::close(app);
        }
        _ => {}
    }
}

fn dispatch(app: &tauri::AppHandle, action: &str, args: Value) -> anyhow::Result<Value> {
    if action == "app_ai_settings" {
        let saved = read_ai_defaults(app)?;
        let (config, settings) = saved.clone().unwrap_or_else(|| {
            let mut config = crate::providers::Config::default();
            config.execution = crate::providers::Execution::Auto;
            (config, Settings::default())
        });
        return Ok(json!({"configured":saved.is_some(),"config":config,"settings":settings}));
    }
    if action == "save_app_ai_settings" {
        let config: crate::providers::Config = serde_json::from_value(args["config"].clone())?;
        let mut settings: Settings = serde_json::from_value(args["settings"].clone())?;
        // App grants were consented for the previous default vendor; a vendor
        // change keeps them only with explicit consent naming the new provider.
        if let Ok(Some((previous, _))) = read_ai_defaults(app) {
            if previous.provider != config.provider && args["grants_for_provider"] != serde_json::to_value(config.provider)? {
                settings.allow_text = false;
                settings.allow_images = false;
            }
        }
        write_ai_defaults(app, &config, &settings)?;
        let state = app.state::<AppState>();
        let mut guard = state.case.lock().unwrap_or_else(|e|e.into_inner());
        let mut current_case_updated = true;
        if let Some(case) = guard.as_mut() {
            if case.meta("ai_scope")?.as_deref() == Some("app") {
                if case_has_running_ai(case)? {
                    current_case_updated = false;
                } else if crate::providers::apply_app_settings(case, &app_policy(&config, &settings)?).is_err() {
                    current_case_updated = false;
                }
            }
        }
        state.pending_app_ai.store(!current_case_updated,std::sync::atomic::Ordering::SeqCst);
        drop(guard);
        emit_case_changed(app);
        return Ok(json!({"saved":true,"current_case_updated":current_case_updated}));
    }

    if ["ai_access_route","set_ai_access_route","save_codex_selection","codex_account_status","codex_account_login","codex_account_cancel_login","codex_account_logout","codex_account_models","codex_account_limits"].contains(&action) {
        let directory = ai_access_dir(app)?;
        let home=std::env::current_exe()?.parent().context("Executable directory missing")?.join("resources/codex");
        if !crate::ai_access::SUBSCRIPTION_ROUTE_ENABLED {
            // The saved route stays readable; everything that would use the
            // sidecar is refused with the same stated reason.
            if action == "ai_access_route" {
                let settings=crate::ai_access::read_settings(&directory)?;
                return Ok(json!({"route":settings.route,"subscription":settings.subscription,"subscription_ready":false,"account_ready":false,"route_available":false,
                    "blocker":crate::ai_access::SUBSCRIPTION_DISABLED_REASON}));
            }
            if action == "set_ai_access_route" {
                let route:crate::ai_access::AccessRoute=serde_json::from_value(args["route"].clone())?;
                if route == crate::ai_access::AccessRoute::ChatgptSubscription { crate::ai_access::ensure_subscription_enabled()?; }
                crate::ai_access::write(&directory,route)?;
                return Ok(json!({"route":route}));
            }
            crate::ai_access::ensure_subscription_enabled()?;
        }
        if action == "ai_access_route" {
            let settings=crate::ai_access::read_settings(&directory)?;
            let available=crate::codex_account::available(&home);
            return Ok(json!({"route":settings.route,"subscription":settings.subscription,"subscription_ready":available,"account_ready":available,
                "blocker":if available {""} else {"The pinned Codex runtime is missing or does not match this verified build"}}));
        }
        if action == "set_ai_access_route" {
            let route:crate::ai_access::AccessRoute=serde_json::from_value(args["route"].clone())?;
            if route == crate::ai_access::AccessRoute::ChatgptSubscription {
                anyhow::ensure!(crate::codex_account::available(&home),"Verified Codex sidecar is unavailable");
                anyhow::ensure!(crate::codex_account::status(&home)?["connected"]==true,"Sign in with ChatGPT first");
                anyhow::ensure!(crate::ai_access::read_settings(&directory)?.subscription.is_some(),"Select a subscription model first");
            }
            crate::ai_access::write(&directory,route)?;
            return Ok(json!({"route":route}));
        }
        if action == "save_codex_selection" {
            let model=text(&args,"model")?;
            let effort=text(&args,"effort")?;
            let catalogue=crate::codex_account::models(&home)?;
            anyhow::ensure!(catalogue.as_array().is_some_and(|entries|entries.iter().any(|entry|
                entry["id"]==model && entry["efforts"].as_array().is_some_and(|options|options.iter().any(|option|option==effort)))),
                "Choose a reasoning effort returned for this ChatGPT model");
            let mut settings=crate::ai_access::read_settings(&directory)?;
            settings.subscription=Some(crate::ai_access::SubscriptionSelection{model:model.into(),effort:effort.into()});
            crate::ai_access::write_settings(&directory,settings)?;
            return Ok(Value::Null);
        }
        return match action {
            "codex_account_status"=>crate::codex_account::status(&home),
            "codex_account_login"=>crate::codex_account::begin_login(&home),
            "codex_account_cancel_login"=>{crate::codex_account::cancel_login(&home,text(&args,"login_id")?)?;Ok(Value::Null)},
            "codex_account_logout"=>{
                let state=app.state::<AppState>();
                let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
                if let Some(case)=guard.as_mut() {
                    let mut statement=case.db.prepare("SELECT id FROM tasks WHERE status='running'")?;
                    let tasks=statement.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    drop(statement);
                    for task in tasks {
                        if case.meta(&format!("task_access_route:{task}"))?.as_deref()==Some("chatgpt_subscription") {
                            agent::pause(case,&task,"ChatGPT account signed out")?;
                        }
                    }
                }
                drop(guard);
                crate::codex_account::logout(&home)?;
                emit_case_changed(app);
                Ok(Value::Null)
            },
            "codex_account_models"=>crate::codex_account::models(&home),
            "codex_account_limits"=>crate::codex_account::limits(&home),
            _=>unreachable!(),
        };
    }

    // Catalogue lookup can contact the account service. Validate before the
    // case mutex is held; the case/session is checked again at the write.
    if action=="save_case_codex_selection" && args["use_app"]!=true {
        crate::ai_access::ensure_subscription_enabled()?;
        let model=text(&args,"model")?;
        let effort=text(&args,"effort")?;
        let runtime=std::env::current_exe()?.parent().context("Executable directory missing")?.join("resources/codex");
        let catalogue=crate::codex_account::models(&runtime)?;
        anyhow::ensure!(catalogue.as_array().is_some_and(|entries|entries.iter().any(|entry|
            entry["id"]==model && entry["efforts"].as_array().is_some_and(|options|options.iter().any(|option|option==effort)))),
            "Choose a reasoning effort returned for this ChatGPT model");
    }

    if action=="hybrid_search" {
        let (case_id,epoch,job)={let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before search");require_session_epoch(&state,&args)?;let scope=case.sources()?.into_iter().filter(|s|!s.restricted).map(|s|s.id).collect();(case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::semantic::prepare_query(case,text(&args,"query")?,scope)?)};
        let result=crate::semantic::run(&job)?;
        return with_case_expected(app,&case_id,Some(epoch),|case|crate::semantic::publish(case,&job,result));
    }
    if action=="export_word" {
        let (case_id,epoch,job)={let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before export");require_session_epoch(&state,&args)?;let record_id=text(&args,"record_id")?;let expected=export_revision(&args)?;(case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::exports::prepare_document_deferred_at_revision(case,record_id,expected,Path::new(text(&args,"path")?))?)};
        crate::exports::run_document(&job)?;
        let staged=crate::exports::stage_document(&job)?;
        return with_case_expected(app,&case_id,Some(epoch),|case|crate::exports::publish_staged_document(case,&job,staged));
    }
    if action=="resume_transcription" {
        let (case_id,epoch,job)={let state=app.state::<AppState>();let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_mut().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription resume");require_session_epoch(&state,&args)?;(case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::transcription::resume(case,text(&args,"job_id")?)?)};
        let staged=crate::transcription::run(&job).and_then(|value|crate::transcription::stage_transcript(&job,value));
        let value=with_case_expected(app,&case_id,Some(epoch),|case|match staged {Ok(v)=>crate::transcription::publish_staged_transcript(case,&job,v),Err(e)=>{crate::transcription::fail(case,&job,&e.to_string())?;Err(e)}});
        if value.is_ok(){kick_semantic(app.clone(),case_id.clone());}
        emit_case_changed(&app);return value;
    }
    if action=="resume_processing" {
        let (case_id,epoch,job)={let state=app.state::<AppState>();let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_mut().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before processing resume");require_session_epoch(&state,&args)?;(case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::processing::resume(case,text(&args,"job_id")?)?)};
        let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));
        let result=with_case_expected(app,&case_id,Some(epoch),|case|crate::processing::publish_staged(case,&job,staged));
        if result.is_ok() {let _=crate::processing::cleanup_published_input(&job);kick_semantic(app.clone(),case_id.clone());}
        emit_case_changed(&app);return result;
    }
    if ["save_provider_key","provider_key_status","delete_provider_key"].contains(&action) {
        let provider:crate::providers::Provider=serde_json::from_value(args["provider"].clone())?;
        if action == "provider_key_status" {return Ok(json!({"configured":provider_key_entry(provider)?.get_password().is_ok()}));}
        let state=app.state::<AppState>();
        let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
        // Keys are app-wide. While a case is open, a key change must come from
        // that case's current session; with no case open, only an app-level
        // request (no case_id) may change a key.
        let open_case=match guard.as_ref() {Some(case)=>Some(case.meta("id")?.unwrap_or_default()),None=>None};
        provider_key_case_fence(open_case.as_deref(),&args)?;
        if open_case.is_some() {require_session_epoch(&state,&args)?;}
        let entry=provider_key_entry(provider)?;
        return match action {
            "save_provider_key"=>{let key=text(&args,"key")?;anyhow::ensure!(!key.trim().is_empty(),"Enter a key");entry.set_password(key.trim())?;Ok(json!({"saved":true}))},
            "delete_provider_key"=>{entry.delete_credential()?;Ok(json!({"deleted":true}))},
            _=>anyhow::bail!("Unknown provider key action")
        };
    }
    if ["import_files","import_folder"].contains(&action) {return import_background(app,action,args);}
    if action=="prepare_second_opinion" {
        let (case_id,epoch,row,job)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let case=guard.as_mut().context("Open a case first")?;
            ensure_session_epoch(&state,&args)?;
            anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before preparing a second opinion");
            require_session_epoch(&state,&args)?;
            let source=text(&args,"source_id")?;
            let clip:crate::escalation::ClipRequest=serde_json::from_value(args["clip"].clone())?;
            let (row,options)=crate::escalation::begin_clip(case,source,text(&args,"run_id")?,&clip)?;
            let job=match crate::processing::prepare_request(case,source,options) {Ok(job)=>job,Err(error)=>return crate::escalation::attach_clip(case,&row,Err(error))};
            (case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),row,job)
        };
        emit_case_changed(&app);
        let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));
        let result=with_case_expected(app,&case_id,Some(epoch),|case|{let published=crate::processing::publish_staged(case,&job,staged);crate::escalation::attach_clip(case,&row,published)});
        if result.is_ok() {let _=crate::processing::cleanup_published_input(&job);}
        emit_case_changed(&app);
        return result;
    }
    if ["process_source","probe_pdf","render_page","transcribe_source","scan_sound_events","prepare_redaction","diarize_source","step_video_frame"].contains(&action) {
        let (case_id,epoch,job)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let case=guard.as_mut().context("Open a case first")?;
            ensure_session_epoch(&state,&args)?;
            let source=text(&args,"source_id")?;
            anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before source processing");
            require_session_epoch(&state,&args)?;
            if ["scan_sound_events","step_video_frame"].contains(&action) {anyhow::ensure!(!case.source(source)?.restricted,"Restricted source");}
            let options=match action {
                "render_page"=>json!({"operation":"render_page","page":args["page"]}),
                "probe_pdf"=>json!({"operation":"probe_pdf"}),
                "diarize_source"=>json!({"operation":"diarize","start":args["start"],"end":args["end"],"track":args["track"]}),
                "prepare_redaction"=>json!({"operation":"redact","boxes":args["boxes"]}),
                "transcribe_source"=>json!({"operation":"transcribe","start":args["start"].as_f64().unwrap_or(0.),"end":args["end"].as_f64().unwrap_or(30.),"track":args["track"]}),
                "scan_sound_events"=>json!({"operation":"sound_events","start":args["start"],"end":args["end"],"track":args["track"],"channel":args["channel"]}),
                "step_video_frame"=>json!({"operation":"frame_at","target":args["target"],"direction":args["direction"]}),
                _=>json!({"crop":null}),
            };
            (case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::processing::prepare_request(case,source,options)?)
        };
        emit_case_changed(&app);
        let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));
        let result=with_case_expected(app,&case_id,Some(epoch),|case|crate::processing::publish_staged(case,&job,staged));
        if result.is_ok() {let _=crate::processing::cleanup_published_input(&job);kick_semantic(app.clone(),case_id.clone());}
        emit_case_changed(&app);
        return result;
    }
    // The OpenAI-only save_api_key/key_status/delete_api_key commands were
    // removed; save_provider_key/provider_key_status/delete_provider_key with
    // provider "openai" use the same Credential Manager entry.

    if action=="playback_proxy" {

        use rusqlite::OptionalExtension;

        let state=app.state::<AppState>();

        let (job,epoch)={

            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());

            let c=guard.as_mut().ok_or_else(||anyhow::anyhow!("Open a case first"))?;
            ensure_session_epoch(&state,&args)?;
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before playback processing");
            require_session_epoch(&state,&args)?;

            let source=text(&args,"source_id")?;

            let cached:Option<String>=c.db.query_row("SELECT id FROM artifacts WHERE source_id=? AND mime='video/mp4' AND json_extract(metadata,'$.player_origin_seconds')=0 ORDER BY created_at DESC LIMIT 1",[source],|r|r.get(0)).optional()?;

            if let Some(id)=cached {crate::processing::artifact(c,&id)?;return Ok(json!({"artifact_id":id}));}

            let running:i64=c.db.query_row("SELECT count(*) FROM processing_jobs WHERE source_id=? AND kind='playback' AND status='running'",[source],|r|r.get(0))?;

            anyhow::ensure!(running==0,"Playback is already being prepared. Reopen this source after conversion finishes.");

            (crate::processing::prepare_playback(c,source)?,state.session_epoch.load(std::sync::atomic::Ordering::SeqCst))

        };

        let staged=crate::processing::stage_playback(&job,crate::processing::run_playback(&job));

        let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());

        let c=guard.as_mut().ok_or_else(||anyhow::anyhow!("Case closed during playback processing"))?;

        anyhow::ensure!(c.meta("id")?.unwrap_or_default()==job.case_id,"Case changed during playback processing");
        anyhow::ensure!(state.session_epoch.load(std::sync::atomic::Ordering::SeqCst)==epoch,"Case session changed before playback publication");

        let result=crate::processing::publish_staged_playback(c,&job,staged);

        emit_case_changed(&app);

        return result;

    }
    if action=="verify_source" {
        let source_id=text(&args,"source_id")?.to_owned();
        let (case_id,epoch,path,expected)={
            let state=app.state::<AppState>();
            let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let c=guard.as_ref().context("Open a case first")?;ensure_session_epoch(&state,&args)?;
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before verification");
            require_session_epoch(&state,&args)?;
            let source=c.source(&source_id)?;
            (c.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),c.source_path(&source_id)?,source.sha256)
        };
        // Hash the opened original outside the case mutex. On Windows this
        // read handle denies writes and replacement until the hash completes.
        anyhow::ensure!(crate::case::file_hash_strong(&path)?==expected,"Original bytes changed: strong integrity check failed");
        return with_case_expected(app,&case_id,Some(epoch),|c|{
            anyhow::ensure!(c.source(&source_id)?.sha256==expected && c.source_path(&source_id)?==path,"Source changed during verification");
            Ok(json!({"verified":true,"method":"full-sha256-reread","verified_at":crate::case::now()}))
        });
    }
    if action=="backup" {
        let destination=PathBuf::from(text(&args,"path")?);
        let (case_id,session_epoch,plan)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let c=guard.as_mut().context("Open a case first")?;ensure_session_epoch(&state,&args)?;
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before backup");
            require_session_epoch(&state,&args)?;
            (c.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),backup::prepare_backup_deferred(c,&destination,text(&args,"password")?)?)
        };
        // Archive hashing, tarring and encryption run without the case lock so chat,
        // viewing and cancellation stay responsive during a large backup.
        let mut plan=plan;
        backup::verify_backup_plan(&mut plan)?;
        backup::write_archive(&plan,&destination,text(&args,"password")?)?;
        let value=with_case_expected(app,&case_id,Some(session_epoch),|c|backup::finish_backup(c,&plan));
        emit_case_changed(&app);
        return value;
    }
    if action=="export_dossier_bundle" {
        let destination=PathBuf::from(text(&args,"path")?);
        let (case_id,session_epoch,plan)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let c=guard.as_mut().context("Open a case first")?;ensure_session_epoch(&state,&args)?;
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before reviewed package export");
            require_session_epoch(&state,&args)?;
            (c.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::exports::prepare_dossier_bundle(c,text(&args,"task_id")?,&destination)?)
        };
        // Copying cited originals into the package runs without the case lock.
        let staged=crate::exports::write_dossier_bundle(&plan,&destination);
        let value=with_case_expected(app,&case_id,Some(session_epoch),|c|crate::exports::publish_dossier_bundle(c,&plan,staged,&destination));
        emit_case_changed(&app);
        return value;
    }
    if action=="export_redaction" {
        let (case_id,session_epoch,plan)={let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before redaction export");require_session_epoch(&state,&args)?;(case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),crate::exports::prepare_redaction_export(case,text(&args,"artifact_id")?,Path::new(text(&args,"path")?))?)};
        let staged=crate::exports::stage_redaction_export(&plan)?;
        let result=with_case_expected(app,&case_id,Some(session_epoch),|case|crate::exports::publish_staged_redaction_export(case,&plan,staged));
        emit_case_changed(&app);return result;
    }

    let state = app.state::<AppState>();

    let mut guard = state.case.lock().unwrap_or_else(|e|e.into_inner());

    if action == "delete_case" {
        let target = PathBuf::from(text(&args, "path")?);
        let c = guard.as_ref().context("Open the case before deleting it")?;
        anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before deletion");
        anyhow::ensure!(args["session_epoch"].as_u64().context("Missing session_epoch")? == state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),"Case session changed before deletion");
        anyhow::ensure!(target.canonicalize()? == c.root,"Delete target is not the open case");
        anyhow::ensure!(!state.importing.load(std::sync::atomic::Ordering::SeqCst),"Wait for the current import before deleting this case");
        let running: i64 = c.db.query_row(

                    "SELECT (SELECT count(*) FROM tasks WHERE status='running')+(SELECT count(*) FROM processing_jobs WHERE status='running')",

                    [],

                    |r| r.get(0),

                )?;
        anyhow::ensure!(running == 0,"Stop active tasks and processing jobs before deleting this case");
        let old_root=c.root.clone();
        #[cfg(feature = "research")]
        if let Some(c) = guard.as_mut() { close_research_for_case_change(app, c, "case deleted"); }
        *guard = None;
        let mut active=state.active_case_id.lock().unwrap_or_else(|e|e.into_inner());
        state.session_epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        *active=None;
        drop(active);
        crate::processing::invalidate_case_leases(&old_root);
        let receipt = crate::case::delete_case(&target, text(&args, "confirm")?)?;
        emit_case_changed(&app);
        return Ok(receipt);
    }

    if ["create_case", "open_case", "restore_case", "close_case"].contains(&action) {
        anyhow::ensure!(!state.importing.load(std::sync::atomic::Ordering::SeqCst),"Wait for the current import before switching cases");

        if let Some(c) = guard.as_ref() {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before switching");
            require_session_epoch(&state,&args)?;

            let running: i64 = c.db.query_row(

                "SELECT (SELECT count(*) FROM tasks WHERE status='running')+(SELECT count(*) FROM processing_jobs WHERE status='running')",

                [],

                |r| r.get(0),

            )?;

            anyhow::ensure!(

                running == 0,

                "Stop active tasks and processing jobs before switching cases"

            );

        }
        #[cfg(feature = "research")]
        if let Some(c) = guard.as_mut() { close_research_for_case_change(app, c, if action == "close_case" { "case closed" } else { "case switched" }); }

        if action == "close_case" {
            let old_root=guard.as_ref().map(|case|case.root.clone());
            *guard = None;
            let mut active=state.active_case_id.lock().unwrap_or_else(|e|e.into_inner());
            state.session_epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            *active=None;
            drop(active);
            drop(guard);
            if let Some(root)=old_root {crate::processing::invalidate_case_leases(&root);}
            emit_case_changed(&app);

            return Ok(Value::Null);

        }

        let path = PathBuf::from(text(&args, "path")?);
        ensure_test_case_path(&path)?;

        let mut c = match action {

            "create_case" => {
                let created = Case::create(&path, text(&args, "name")?)?;
                created.set_meta("ai_scope", "app")?;
                created
            }

            "restore_case" => backup::restore(

                Path::new(text(&args, "archive")?),

                &path,

                text(&args, "password")?,

            )?,

            _ => Case::open(&path)?,

        };

        sync_inherited_ai(app, &mut c)?;
        state.pending_app_ai.store(false,std::sync::atomic::Ordering::SeqCst);

        crate::automatic::enqueue(&mut c)?;
        let case_id=c.meta("id")?.unwrap_or_default();
        let snapshot = c.snapshot()?;

        let old_root=guard.as_ref().map(|case|case.root.clone());
        *guard = Some(c);
        let mut active=state.active_case_id.lock().unwrap_or_else(|e|e.into_inner());
        state.session_epoch.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        *active=Some(case_id.clone());
        drop(active);
        drop(guard);
        if let Some(root)=old_root {crate::processing::invalidate_case_leases(&root);}
        emit_case_changed(&app);
        kick_automatic(app.clone(),case_id.clone());
        kick_transcriptions(app.clone(),case_id);
        return Ok(stamp_session(snapshot,&state));

    }

    if action == "snapshot" && guard.is_none() {

        return Ok(Value::Null);

    }

    let c = guard

        .as_mut()

        .ok_or_else(|| anyhow::anyhow!("Open a case first"))?;
    ensure_session_epoch(&state, &args)?;

    let result = match action {

        "snapshot" => {
            if state.pending_app_ai.load(std::sync::atomic::Ordering::SeqCst) && !case_has_running_ai(c)? {
                sync_inherited_ai(app,c)?;
                state.pending_app_ai.store(false,std::sync::atomic::Ordering::SeqCst);
            }
            stamp_session(c.snapshot()?,&state)
        },
        "case_summary" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before summary");
            stamp_session(c.case_summary()?,&state)
        },
        "task_page" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before task page");
            let before=if args["before"].is_null(){None}else{Some((text(&args["before"],"created_at")?,text(&args["before"],"id")?))};
            c.task_page(before)?
        },
        "source_page" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before source page");
            anyhow::ensure!(args["generation"].as_i64()==Some(c.generation()?),"Case changed before source page");
            anyhow::ensure!(args["audit_seq"].as_i64()==c.case_summary()?["audit_seq"].as_i64(),"Case changed before source page");
            let before=if args["before"].is_null(){None}else{Some((text(&args["before"],"created_at")?,text(&args["before"],"id")?))};
            c.source_page(before)?
        },
        "record_page" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working file page");
            anyhow::ensure!(args["generation"].as_i64()==Some(c.generation()?),"Case changed before working file page");
            anyhow::ensure!(args["audit_seq"].as_i64()==c.case_summary()?["audit_seq"].as_i64(),"Case changed before working file page");
            let before=if args["before"].is_null(){None}else{Some((text(&args["before"],"updated_at")?,text(&args["before"],"id")?))};
            c.record_page(before)?
        },
        "job_page" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before job page");
            c.job_page(args["before"].as_i64())?
        },
        "job_progress" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before job progress");
            c.job_progress(text(&args,"job_id")?)?
        },
        "attention_job_page" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before current problems page");
            c.attention_job_page(args["before"].as_i64())?
        },
        "source_detail" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before source detail");
            serde_json::to_value(c.source(text(&args,"source_id")?)?)?
        },
        "record_summary" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working file summary");
            c.record_summary(text(&args,"record_id")?)?
        },
        "conversation_detail" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before conversation detail");
            let before=if args["before"].is_null(){None}else{Some((text(&args["before"],"created_at")?,text(&args["before"],"id")?))};
            c.conversation_detail(text(&args,"conversation_id")?,before)?
        },
        "record_detail" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before record detail");
            let record=c.record(text(&args,"record_id")?)?;
            anyhow::ensure!(record.revision==args["revision"].as_i64().context("Missing record revision")?,"Record revision changed; refresh before editing");
            serde_json::to_value(record)?
        },
        "speaker_annotations" => crate::speaker_annotations::read(c,text(&args,"source_id")?,text(&args,"artifact_id")?)?,
        "save_speaker_annotations" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before speaker annotations");require_session_epoch(&state,&args)?;crate::speaker_annotations::save(c,text(&args,"source_id")?,text(&args,"artifact_id")?,args["revision"].as_u64().context("Missing annotation revision")?,&args["labels"],&args["turns"])?},
        "video_discovery_status" => crate::discovery::status(c,text(&args,"source_id")?)?,
        "browse_video_discovery" => crate::discovery::browse(c,text(&args,"source_id")?,args["kind"].as_str().unwrap_or("video_overview"),args["start"].as_f64().unwrap_or(0.),args["end"].as_f64().unwrap_or(1e12),args["offset"].as_u64().unwrap_or(0),args["query"].as_str().unwrap_or(""))?,
        "queue_video_discovery" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before video discovery queue");require_session_epoch(&state,&args)?;let value=crate::discovery::enqueue(c,text(&args,"source_id")?,args["interval"].as_f64().unwrap_or(5.),true)?;kick_discovery(app.clone(),c.meta("id")?.unwrap_or_default());value},
        "retry_video_discovery" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before video discovery retry");require_session_epoch(&state,&args)?;let value=crate::discovery::retry_run(c,text(&args,"run_id")?)?;kick_discovery(app.clone(),c.meta("id")?.unwrap_or_default());value},
        "cancel_video_discovery" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before video discovery cancel");require_session_epoch(&state,&args)?;crate::discovery::cancel(c,text(&args,"source_id")?)?},
        "cancel_processing" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before processing cancellation");require_session_epoch(&state,&args)?;crate::processing::cancel(c,text(&args,"job_id")?)?;Value::Null},
        "storage_usage" => c.storage_usage()?,
        "reclaim_staging" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before staging cleanup");require_session_epoch(&state,&args)?;anyhow::ensure!(!state.importing.load(std::sync::atomic::Ordering::SeqCst),"Wait for the import before reclaiming staging");c.reclaim_staging()?},

        "rename" => { anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before rename"); require_session_epoch(&state,&args)?; c.rename(text(&args,"kind")?, args["id"].as_str().unwrap_or(""), text(&args,"name")?)?; Value::Null },

        "search" => c.search(

            text(&args, "query")?,

            args["offset"].as_u64().unwrap_or(0) as usize,

        )?,

        "read_text" => c.read_text(

            text(&args, "source_id")?,

            args["start"].as_u64().unwrap_or(1) as usize,

            args["count"].as_u64().unwrap_or(200) as usize,

        )?,

        "extract_history" => c.extract_history(text(&args,"source_id")?)?,

        "read_extract_revision" => c.read_text_revision(text(&args,"source_id")?,args["revision"].as_i64().context("Missing revision")?,args["start"].as_u64().unwrap_or(1) as usize,args["count"].as_u64().unwrap_or(200) as usize)?,

        "set_asr_profile" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before speech profile update");require_session_epoch(&state,&args)?;let model=text(&args,"model")?;anyhow::ensure!(["tiny","small"].contains(&model),"Unsupported local speech model");let worker=crate::processing::worker_path()?;anyhow::ensure!(worker.parent().context("Missing worker folder")?.join("_internal/models").join(model).join("model.bin").is_file(),"This speech model is not installed in the packaged worker");c.set_meta("asr_profile",model)?;c.audit("asr_profile_selected",json!({"model":model}))?;Value::Null},
        "transcribe_full" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription");
            require_session_epoch(&state,&args)?;
            let job = crate::transcription::begin(c, text(&args, "source_id")?)?;

            let job_id = job.id.clone();

            let case_id = c.meta("id")?.unwrap_or_default();
            let session_epoch = state.session_epoch.load(std::sync::atomic::Ordering::SeqCst);

            let handle = app.clone();

            tauri::async_runtime::spawn_blocking(move || {

                let result = crate::transcription::run(&job).and_then(|value| crate::transcription::stage_transcript(&job,value)).and_then(|staged| {

                    with_case_expected(&handle, &case_id, Some(session_epoch), |case| {

                        crate::transcription::publish_staged_transcript(case, &job, staged)

                    })

                });

                if let Err(error) = result {

                    let _ = with_case_expected(&handle, &case_id, Some(session_epoch), |case| {

                        crate::transcription::fail(case, &job, &error.to_string())

                    });

                } else {
                    kick_semantic(handle.clone(),case_id.clone());
                }

                // Only the copied input in this exact private job directory is discarded.

                let input = job.staging.join("input");

                if let Ok(metadata) = std::fs::metadata(&input) {

                    let mut permissions = metadata.permissions();

                    permissions.set_readonly(false);

                    let _ = std::fs::set_permissions(&input, permissions);

                    let _ = std::fs::remove_file(input);

                }

                emit_case_changed(&handle);

                kick_transcriptions(handle, case_id);

            });

            json!({"job_id":job_id})

        }

        "transcribe_all" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription queue");
            require_session_epoch(&state,&args)?;

            let ids: Vec<String> = c

                .sources()?

                .into_iter()

                .filter(|s| ["audio", "video"].contains(&s.kind.as_str()))

                .map(|s| s.id)

                .collect();

            let result = crate::transcription::enqueue(c, &ids)?;

            kick_transcriptions(app.clone(), c.meta("id")?.unwrap_or_default());

            result

        }

        "full_transcription_status" => crate::transcription::status(c, text(&args, "source_id")?)?,
        "transcript_segment_page" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcript page");
            crate::transcription::segment_page(c,text(&args,"source_id")?,text(&args,"run_id")?,args["cursor"].as_i64())?
        },
        "second_opinion_grant" => {
            json!({"grant":crate::escalation::grant(c)?,"vendors":["openrouter","openai"],
                "note":"Allows sending short audio clips that you confirm, one batch at a time, to the named model. It never sends case text and is separate from the case text and image permissions."})
        },
        "set_second_opinion_grant" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before updating the second-opinion permission");
            require_session_epoch(&state,&args)?;
            let choice=if args["revoke"]==true {None} else {Some((serde_json::from_value::<crate::escalation::Vendor>(args["vendor"].clone())?,text(&args,"model")?))};
            json!({"grant":crate::escalation::set_grant(c,choice)?})
        },
        "list_second_opinions" => crate::escalation::list(c,text(&args,"source_id")?)?,
        "second_opinion_preview" => crate::escalation::preview(c,text(&args,"id")?)?,
        "cancel_second_opinion" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before cancelling");
            require_session_epoch(&state,&args)?;
            let row=text(&args,"id")?;
            crate::escalation::entry(c,row)?;
            c.set_meta(&format!("second_opinion_cancel:{row}"),"1")?;
            json!({"cancel_requested":true})
        },
        "decide_second_opinion" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before recording the decision");
            require_session_epoch(&state,&args)?;
            let edits=args["edits"].as_array().map(|items|items.iter().filter_map(|e|Some((e["ordinal"].as_i64()?,e["text"].as_str()?.to_string()))).collect::<Vec<_>>()).unwrap_or_default();
            crate::escalation::decide(c,text(&args,"id")?,text(&args,"decision")?,&edits)?
        },
        "second_opinion_candidates" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before uncertainty triage");
            crate::escalation::candidates(c,text(&args,"source_id")?,text(&args,"run_id")?)?
        },
        "transcript_segment_detail" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcript detail");
            crate::transcription::segment_detail(c,text(&args,"source_id")?,text(&args,"run_id")?,args["ordinal"].as_i64().context("Missing segment ordinal")?)?
        },
        "propose_transcript_correction" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcript correction");
            require_session_epoch(&state,&args)?;
            crate::transcription::save_correction(c,text(&args,"source_id")?,text(&args,"run_id")?,args["ordinal"].as_i64().context("Missing segment ordinal")?,text(&args,"text")?,text(&args,"reason")?)?
        },
        "review_transcript_correction" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcript review");
            require_session_epoch(&state,&args)?;
            crate::transcription::review_correction(c,text(&args,"correction_id")?,args["accept"].as_bool().context("Missing review decision")?)?
        },

        "cancel_transcription" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription cancellation");
            require_session_epoch(&state,&args)?;
            crate::transcription::cancel(c, text(&args, "source_id")?)?;

            Value::Null

        }

        "artifact_info" => {

            let (source, mime, path, metadata) =

                crate::processing::artifact(c, text(&args, "artifact_id")?)?;

            let content = if mime == "application/json" {

                anyhow::ensure!(

                    path.metadata()?.len() <= 16 * 1024 * 1024,

                    "Artifact too large"

                );

                Some(serde_json::from_slice::<Value>(&std::fs::read(path)?)?)

            } else {

                None

            };

            json!({"source_id":source,"mime":mime,"metadata":metadata,"content":content})

        }

        "processing_status" => {

            let mut stmt=c.db.prepare("SELECT kind,status,result,error,created_at FROM processing_jobs WHERE source_id=? ORDER BY created_at DESC")?;

            let rows=stmt.query_map([text(&args,"source_id")?],|r|Ok(json!({"kind":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"result":r.get::<_,String>(2)?,"error":r.get::<_,String>(3)?,"created_at":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;

            json!(rows)

        }

        "set_restricted" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before restriction update");
            require_session_epoch(&state,&args)?;
            c.set_restricted(

                text(&args, "source_id")?,

                args["restricted"].as_bool().unwrap_or(true),

            )?;

            Value::Null

        }

        "write_record" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working record update");require_session_epoch(&state,&args)?;serde_json::to_value(c.write_record(

            args["record_id"].as_str(),

            args["base_revision"].as_i64().unwrap_or(0),

            text(&args, "title")?,

            text(&args, "kind")?,

            text(&args, "content")?,

            "human",

            args["reason"].as_str().unwrap_or("Manual edit"),

            None,

            serde_json::from_value(args["source_ids"].clone()).unwrap_or_default(),

        )?)?},

        "review_record" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working record review");
            require_session_epoch(&state,&args)?;
            c.review_record(

                text(&args, "record_id")?,

                args["revision"].as_i64().unwrap_or(0),

                args["protected"].as_bool(),

            )?;

            Value::Null

        }

        "revisions" => c.revisions(text(&args, "record_id")?)?,

        "rollback" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working record rollback");require_session_epoch(&state,&args)?;serde_json::to_value(c.rollback(

            text(&args, "record_id")?,

            args["target"].as_i64().unwrap_or(0),

            args["base_revision"].as_i64().unwrap_or(0),

        )?)?},

        "evidence_list" => crate::evidence::list(c,args["source_id"].as_str(),args["kind"].as_str(),args["offset"].as_u64().unwrap_or(0) as usize)?,
        "evidence_read" => crate::evidence::read(c,text(&args,"id")?,args["revision"].as_i64())?,
        "evidence_write" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before finding update");require_session_epoch(&state,&args)?;crate::evidence::write(c,serde_json::from_value(args["object"].clone())?,"human")?},
        "evidence_review" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before finding review");require_session_epoch(&state,&args)?;crate::evidence::review(c,text(&args,"id")?,args["revision"].as_i64().context("Missing revision")?,text(&args,"review")?)?;Value::Null},
        "evidence_search" => crate::evidence::search(c,text(&args,"query")?,args["offset"].as_u64().unwrap_or(0) as usize)?,
        "fit_clock" => crate::evidence::fit_clock(&serde_json::from_value::<Vec<crate::evidence::Anchor>>(args["anchors"].clone())?)?,
        "team_status" => crate::teams::status(c,text(&args,"task_id")?)?,
        "investigation_workbench" => crate::workbench::view(c,args["offset"].as_u64().unwrap_or(0))?,
        "incident_replay" => crate::workbench::replay(c,&serde_json::from_value::<Vec<String>>(args["clock_ids"].clone())?)?,
        "coverage_map" => crate::workbench::coverage_map(c,args["offset"].as_u64().unwrap_or(0))?,
        "processing_recovery" => crate::processing::recovery_inventory(c)?,
        "read_coverage" => crate::coverage::view(c,text(&args,"task_id")?)?,
        "read_dossier" => crate::dossier::view(c,text(&args,"task_id")?)?,
        "review_dossier_claim" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before claim review");require_session_epoch(&state,&args)?;crate::dossier::human_review(c,text(&args,"task_id")?,args["revision"].as_u64().context("Missing dossier revision")?,usize::try_from(args["claim_index"].as_u64().context("Missing claim index")?)?,text(&args,"decision")?,text(&args,"note")?)?},
        "save_ai_settings" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before settings update");
            require_session_epoch(&state,&args)?;
            crate::automatic::preempt_for_chat(c)?;
            c.db.execute_batch("SAVEPOINT ai_settings")?;
            let result=(||->anyhow::Result<()> {
                crate::providers::apply_app_settings(c,&args)?;
                c.set_meta("ai_scope", "case")?;
                Ok(())
            })();
            if let Err(e)=result {c.db.execute_batch("ROLLBACK TO ai_settings; RELEASE ai_settings")?;return Err(e)}
            c.db.execute_batch("RELEASE ai_settings")?;
            Value::Null
        },
        "direct_media_permission" => json!({"enabled":crate::providers::direct_media_enabled(c)}),
        "case_ai_scope" => json!({"scope":if c.meta("ai_scope")?.as_deref()==Some("app") {"app"} else {"case"}}),
        "case_ai_access_route" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before AI access read");
            require_session_epoch(&state,&args)?;
            json!({"override":c.meta("ai_access_override")?.unwrap_or_else(||"app".into()),"effective":case_access_route(c,app)?,
                "selection_override":c.meta("codex_selection")?.is_some_and(|value|!value.is_empty()),"selection":case_subscription_selection(c,app)?})
        },
        "set_case_ai_access_route" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before AI access update");
            require_session_epoch(&state,&args)?;
            let route=text(&args,"route")?;
            anyhow::ensure!(matches!(route,"app"|"api_keys"|"chatgpt_subscription"),"Invalid case AI access route");
            if route=="chatgpt_subscription" {
                crate::ai_access::ensure_subscription_enabled()?;
                let runtime=std::env::current_exe()?.parent().context("Executable directory missing")?.join("resources/codex");
                anyhow::ensure!(crate::codex_account::available(&runtime),"Verified Codex sidecar is unavailable");
            }
            c.set_meta("ai_access_override",route)?;
            c.audit("ai_access_override_changed",json!({"route":route}))?;
            json!({"override":route,"effective":case_access_route(c,app)?,"selection_override":c.meta("codex_selection")?.is_some_and(|value|!value.is_empty()),"selection":case_subscription_selection(c,app)?})
        },
        "save_case_codex_selection" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before subscription model update");
            require_session_epoch(&state,&args)?;
            if args["use_app"].as_bool()==Some(true) {
                c.set_meta("codex_selection","")?;
            } else {
                let model=text(&args,"model")?;
                let effort=text(&args,"effort")?;
                c.set_meta("codex_selection",&serde_json::to_string(&crate::ai_access::SubscriptionSelection{model:model.into(),effort:effort.into()})?)?;
            }
            c.audit("codex_selection_changed",json!({"use_app":args["use_app"]==true}))?;
            json!({"selection_override":c.meta("codex_selection")?.is_some_and(|value|!value.is_empty()),"selection":case_subscription_selection(c,app)?})
        },
        "set_case_ai_scope" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before AI scope update");
            require_session_epoch(&state,&args)?;
            let scope=text(&args,"scope")?;
            anyhow::ensure!(scope=="app"||scope=="case","Invalid AI scope");
            if scope=="app" {
                anyhow::ensure!(!case_has_running_ai(c)?,"Stop the current AI task before applying app settings");
                let (config,settings)=read_ai_defaults(app)?.context("Set up app AI first")?;
                crate::providers::apply_app_settings(c,&app_policy(&config,&settings)?)?;
            }
            c.set_meta("ai_scope",scope)?;
            c.audit("ai_scope_changed",json!({"scope":scope}))?;
            json!({"scope":scope})
        },
        #[cfg(feature = "research")]
        "research_grant" => serde_json::to_value(crate::research::grant(c)?)?,
        #[cfg(feature = "research")]
        "set_research_grant" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before research browser update");
            require_session_epoch(&state,&args)?;
            let enabled=args["enabled"].as_bool().context("Missing research browser setting")?;
            // A toggle-only call keeps the case's existing sign-in hosts.
            let sso_hosts:Vec<String>=match args.get("sso_hosts") {
                Some(hosts) if !hosts.is_null() => serde_json::from_value(hosts.clone()).context("Invalid sign-in hosts")?,
                _ => crate::research::grant(c).ok().flatten().map(|grant| grant.sso_hosts).unwrap_or_default(),
            };
            serde_json::to_value(crate::research::set_grant(c,enabled,&sso_hosts)?)?
        },
        "set_direct_media_permission" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before media permission update");require_session_epoch(&state,&args)?;let enabled=args["enabled"].as_bool().context("Missing permission")?;crate::providers::set_direct_media(c,enabled)?;Value::Null},
        "ai_config" => serde_json::to_value(crate::providers::load(c)?)?,
        "save_ai_config" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before AI configuration update");require_session_epoch(&state,&args)?;crate::providers::save(c,serde_json::from_value(args["config"].clone())?)?;c.set_meta("ai_scope","case")?;Value::Null},
        "save_settings" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before settings update");
            require_session_epoch(&state,&args)?;
            c.save_settings(serde_json::from_value::<Settings>(

                args["settings"].clone(),

            )?)?;
            c.set_meta("ai_scope","case")?;

            Value::Null

        }

        "review_redaction" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before redaction review");require_session_epoch(&state,&args)?;crate::exports::review_redaction(c,text(&args,"artifact_id")?,&serde_json::from_value::<Vec<u64>>(args["pages"].clone())?,text(&args,"note")?)?},
        "export_record" => {

            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before export");
            require_session_epoch(&state,&args)?;
            let record_id=text(&args, "record_id")?;
            if let Some(expected)=export_revision(&args)? {c.export_record_at_revision(record_id,expected,Path::new(text(&args,"path")?))?;}
            else {c.export_record(record_id,Path::new(text(&args,"path")?))?;}

            json!({"saved":true})

        }

        "validate_citation" => c.validate_citation(text(&args, "citation")?)?,

        "actions" => c.actions(text(&args, "task_id")?)?,
        "issue_history" => c.issue_history(text(&args,"receipt_id")?,args["offset"].as_u64().unwrap_or(0))?,

        "delete_conversation" => {

            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before conversation update");
            require_session_epoch(&state,&args)?;
            c.delete_conversation(text(&args,"conversation_id")?,args["deleted"].as_bool().unwrap_or(true))?;

            Value::Null

        }

        "start_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat started");
            require_session_epoch(&state,&args)?;
            let access_route=case_access_route(c,app)?;
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}

            let selected = if access_route == crate::ai_access::AccessRoute::ApiKeys {
                let selected = if let (Some(provider), Some(model)) = (args.get("provider"), args["model"].as_str()) {
                    crate::providers::select_profile(c, serde_json::from_value(provider.clone())?, model)?
                } else { crate::providers::task_profile(c, "")? };
                crate::providers::check_permission(c, &selected)?;
                if !agent::is_file_count_question(text(&args,"prompt")?) {
                    provider_key_for_case(selected.provider)
                        .map_err(|_| anyhow::anyhow!("Save an API key in Settings first"))?;
                }
                Some(selected)
            } else {
                // Never fall back to API keys: that would send case text to a
                // different vendor than the one this case chose.
                crate::ai_access::ensure_subscription_enabled()?;
                let settings=c.settings()?;
                anyhow::ensure!(!settings.offline && settings.allow_text,"Enable AI text access for this case in Settings");
                let selection=case_subscription_selection(c,app)?.context("Choose a ChatGPT subscription model in Settings")?;
                anyhow::ensure!(!selection.model.is_empty() && !selection.effort.is_empty(),"Choose a ChatGPT subscription model in Settings");
                let runtime=std::env::current_exe()?.parent().context("Executable directory missing")?.join("resources/codex");
                anyhow::ensure!(crate::codex_account::available(&runtime),"Verified Codex sidecar is unavailable");
                None
            };
            let (source_ids, record_ids) = agent::case_scope(c)?;

            let task = if access_route == crate::ai_access::AccessRoute::ChatgptSubscription {
                agent::start_subscription(c,text(&args,"prompt")?,"investigate",source_ids,record_ids)?
            } else {
                agent::start(c,text(&args,"prompt")?,"investigate",source_ids,record_ids,0.0)?
            };

            c.set_meta(&format!("task_access_route:{task}"), if access_route == crate::ai_access::AccessRoute::ChatgptSubscription {"chatgpt_subscription"} else {"api_keys"})?;
            if let Some(selected)=selected { c.set_meta(&format!("task_profile:{task}"), &serde_json::to_string(&selected)?)?; }
            let conversation = match agent::continue_conversation(c, &task, args["parent_task_id"].as_str()) {

                Ok(id)=>id,

                Err(e)=>{agent::pause(c,&task,"Conversation could not continue")?;return Err(e)}

            };

            if let Err(e)=agent::attach_viewer_context(c,&task,&args["viewer_context"]) {agent::pause(c,&task,"Open-file context could not be included")?;return Err(e);}

            if agent::is_file_count_question(text(&args,"prompt")?) {
                agent::finish_inventory(c,&task,false)?;
                emit_case_changed(&app);
                return Ok(json!({"task_id":task,"conversation_id":conversation}));
            }
            let case_id = c.meta("id")?.unwrap_or_default();
            let session_epoch = state.session_epoch.load(std::sync::atomic::Ordering::SeqCst);

            let handle = app.clone();

            let tid = task.clone();

            tauri::async_runtime::spawn(async move {

                run_agent(handle, case_id, session_epoch, tid).await;

            });

            json!({"task_id":task,"conversation_id":conversation})

        }

        "stop_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat stopped");
            require_session_epoch(&state,&args)?;

            agent::pause(c, text(&args, "task_id")?, "Stopped by user")?;

            Value::Null

        }

        "resume_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat resumed");
            require_session_epoch(&state,&args)?;
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}

            let task = text(&args, "task_id")?.to_string();

            agent::resume(c, &task)?;

            let case_id = c.meta("id")?.unwrap_or_default();
            let session_epoch = state.session_epoch.load(std::sync::atomic::Ordering::SeqCst);

            let handle = app.clone();

            let tid = task.clone();

            tauri::async_runtime::spawn(async move {

                run_agent(handle, case_id, session_epoch, tid).await;

            });

            json!({"task_id":task})

        }

        "continue_paused_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat continued");
            require_session_epoch(&state,&args)?;
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}
            let old=text(&args,"task_id")?;
            let subscription=c.meta(&format!("task_access_route:{old}"))?.as_deref()==Some("chatgpt_subscription");
            if subscription { crate::ai_access::ensure_subscription_enabled()?; }
            if !subscription {
                let profile=crate::providers::task_profile(c,old)?;
                provider_key_for_case(profile.provider).map_err(|_|anyhow::anyhow!("Save an API key in Settings first"))?;
            }
            let (task,conversation)=agent::continue_paused(c,old)?;
            c.set_meta(&format!("task_access_route:{task}"),if subscription {"chatgpt_subscription"} else {"api_keys"})?;
            let case_id=c.meta("id")?.unwrap_or_default();
            let session_epoch=state.session_epoch.load(std::sync::atomic::Ordering::SeqCst);
            let handle=app.clone();let tid=task.clone();
            tauri::async_runtime::spawn(async move {run_agent(handle,case_id,session_epoch,tid).await;});
            json!({"task_id":task,"conversation_id":conversation})
        }

        _ => anyhow::bail!("Unknown application command"),

    };

    if ["import_files","import_folder","save_ai_settings"].contains(&action) {
        crate::automatic::enqueue(c)?;
        let case_id=c.meta("id")?.unwrap_or_default();
        kick_automatic(app.clone(),case_id.clone());kick_transcriptions(app.clone(),case_id);
    }
    if ![

        "snapshot",
        "ai_config", "direct_media_permission", "research_grant", "investigation_workbench", "coverage_map", "incident_replay", "processing_recovery", "team_status", "read_dossier", "read_coverage", "evidence_list", "evidence_read", "evidence_search", "fit_clock",

        "full_transcription_status",
        "transcript_segment_page",
        "transcript_segment_detail",
        "second_opinion_candidates",
        "second_opinion_grant",
        "list_second_opinions",
        "second_opinion_preview",

        "artifact_info",

        "read_text", "extract_history", "read_extract_revision",

        "search",

        "actions", "issue_history", "record_detail", "record_summary", "source_detail", "task_page", "source_page", "record_page", "job_page", "job_progress", "attention_job_page", "conversation_detail", "case_summary",

        "revisions",

        "processing_status", "speaker_annotations", "video_discovery_status", "browse_video_discovery",
        "storage_usage",

    ]

    .contains(&action)

    {

        emit_case_changed(&app);

    }

    Ok(result)

}



fn with_case<T>(

    app: &tauri::AppHandle,

    case_id: &str,

    f: impl FnOnce(&mut Case) -> anyhow::Result<T>,

) -> anyhow::Result<T> {
    with_case_expected(app, case_id, None, f)
}

fn with_case_expected<T>(
    app: &tauri::AppHandle,
    case_id: &str,
    expected_epoch: Option<u64>,
    f: impl FnOnce(&mut Case) -> anyhow::Result<T>,
) -> anyhow::Result<T> {

    let state = app.state::<AppState>();

    let mut lock = state.case.lock().unwrap_or_else(|e|e.into_inner());

    let c = lock

        .as_mut()

        .ok_or_else(|| anyhow::anyhow!("Case closed"))?;

    anyhow::ensure!(c.meta("id")?.as_deref() == Some(case_id), "Case changed");
    if let Some(expected_epoch) = expected_epoch {
        anyhow::ensure!(state.session_epoch.load(std::sync::atomic::Ordering::SeqCst) == expected_epoch, "Case session changed before publishing");
    }

    f(c)

}

async fn send_second_opinion(app:&tauri::AppHandle,args:&Value)->anyhow::Result<Value> {
    let (case_id,epoch,vendor)={
        let state=app.state::<AppState>();
        let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
        let case=guard.as_ref().context("Open a case first")?;
        ensure_session_epoch(&state,args)?;
        anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(args,"case_id")?),"Case changed before sending");
        require_session_epoch(&state,args)?;
        let grant=crate::escalation::grant(case)?.context("Allow a second opinion for this case in Settings first")?;
        (case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),grant.vendor)
    };
    let key=provider_key_for_case(vendor.provider()).map_err(|_|anyhow::anyhow!("Save a {} API key in Settings first",vendor.provider().name()))?;
    let row=text(args,"id")?.to_string();
    let outbound=with_case_expected(app,&case_id,Some(epoch),|c|{c.set_meta(&format!("second_opinion_cancel:{row}"),"")?;crate::escalation::prepare_send(c,&row)})?;
    emit_case_changed(app);
    let url=crate::providers::synthetic_provider_url()?.unwrap_or_else(||vendor.endpoint().to_string());
    let body=outbound.body.clone();
    let send=async {
        let client=crate::providers::inference_client()?;
        let request=client.post(&url).bearer_auth(&key).json(&body);
        let request=if vendor==crate::escalation::Vendor::Openrouter {request.header("X-Title","VisLex")} else {request};
        let mut response=request.send().await?;
        if !response.status().is_success() {
            let detail=crate::providers::provider_rejection(&mut response).await;
            anyhow::bail!("{} returned HTTP {}. {}",vendor.provider().name(),response.status().as_u16(),detail);
        }
        let bytes=response.bytes().await?;
        anyhow::ensure!(bytes.len()<=1024*1024,"Second opinion reply is too large");
        Ok::<Value,anyhow::Error>(serde_json::from_slice(&bytes)?)
    };
    let outcome=tokio::select! {
        result=send=>result,
        _=second_opinion_cancelled(app,&case_id,epoch,&row)=>Err(anyhow::anyhow!("Request cancelled; transmission may have occurred")),
    };
    with_case_expected(app,&case_id,Some(epoch),|c|crate::escalation::finish_send(c,&outbound,outcome))
}
/// Resolves when the reviewer cancels, the case goes offline, or the grant is revoked.
async fn second_opinion_cancelled(app:&tauri::AppHandle,case_id:&str,epoch:u64,row:&str) {
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let active=with_case_expected(app,case_id,Some(epoch),|c|Ok(c.meta(&format!("second_opinion_cancel:{row}"))?.as_deref()!=Some("1")&&!c.settings()?.offline&&crate::escalation::grant(c)?.is_some())).unwrap_or(false);
        if !active {return;}
    }
}
async fn cancelled(app: &tauri::AppHandle, case_id: &str, epoch:u64, task: &str) {

    loop {

        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let active = with_case_expected(app, case_id, Some(epoch), |c| {

            let status: String =

                c.db.query_row("SELECT status FROM tasks WHERE id=?", [task], |r| r.get(0))?;

            let s = c.settings()?;

            Ok(status == "running" && crate::teams::active(c,task)? && !s.offline && s.allow_text)

        })

        .unwrap_or(false);

        if !active {

            return;

        }

    }

}

fn kick_transcriptions(app: tauri::AppHandle, case_id: String) {
    let epoch=app.state::<AppState>().session_epoch.load(std::sync::atomic::Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || loop {

        let job = match with_case_expected(&app, &case_id, Some(epoch), crate::transcription::next) {

            Ok(Some(job)) => job,

            _ => {if app.state::<AppState>().session_epoch.load(std::sync::atomic::Ordering::SeqCst)==epoch {kick_automatic(app.clone(),case_id.clone());}break},

        };

        let result = crate::transcription::run(&job).and_then(|value| crate::transcription::stage_transcript(&job,value)).and_then(|staged| {

            with_case_expected(&app, &case_id, Some(epoch), |case| {

                crate::transcription::publish_staged_transcript(case, &job, staged)

            })

        });

        if let Err(error) = result {

            let _ = with_case_expected(&app, &case_id, Some(epoch), |case| {

                crate::transcription::fail(case, &job, &error.to_string())

            });

        } else {
            kick_semantic(app.clone(),case_id.clone());
        }

        let input = job.staging.join("input");

        if let Ok(metadata) = std::fs::metadata(&input) {

            let mut permissions = metadata.permissions();

            permissions.set_readonly(false);

            let _ = std::fs::set_permissions(&input, permissions);

            let _ = std::fs::remove_file(input);

        }

        emit_case_changed(&app);

    });

}

async fn run_agent(app: tauri::AppHandle, case_id: String, epoch:u64, task: String) {
    run_session(app.clone(),case_id.clone(),epoch,task,true).await;
    let state=app.state::<AppState>();
    if state.session_epoch.load(std::sync::atomic::Ordering::SeqCst)==epoch {kick_automatic(app,case_id);}
}
async fn run_team_phase(app:&tauri::AppHandle,case_id:&str,epoch:u64,parent:&str,phase:&str)->anyhow::Result<()> {
    let children=with_case_expected(app,case_id,Some(epoch),|c|crate::teams::prepare(c,parent,phase))?;
    let mut runs=tokio::task::JoinSet::new();
    for child in children {
        let handle=app.clone();let cid=case_id.to_string();
        runs.spawn(async move {run_session(handle,cid,epoch,child,false).await;});
    }
    while let Some(result)=runs.join_next().await {result?;}
    with_case_expected(app,case_id,Some(epoch),|c|crate::teams::merge(c,parent,phase))?;
    Ok(())
}
fn run_session(app:tauri::AppHandle,case_id:String,epoch:u64,task:String,coordinator:bool)->std::pin::Pin<Box<dyn std::future::Future<Output=()>+Send>> {
    Box::pin(async move {

    let result=async {
        let subscription=with_case_expected(&app,&case_id,Some(epoch),|c|Ok(c.meta(&format!("task_access_route:{task}"))?.as_deref()==Some("chatgpt_subscription")))?;
        if subscription { return run_subscription_session(&app,&case_id,epoch,&task).await; }




        if coordinator {run_team_phase(&app,&case_id,epoch,&task,"investigate").await?;}
        loop {
            if coordinator {
                let pending=with_case_expected(&app,&case_id,Some(epoch),|c|c.meta(&format!("team_pending:{task}")))?;
                if let Some(phase)=pending {run_team_phase(&app,&case_id,epoch,&task,&phase).await?;}
                run_team_phase(&app,&case_id,epoch,&task,"review").await?;
            }
            let provider=with_case_expected(&app,&case_id,Some(epoch),|c|Ok(crate::providers::task_profile(c,&task)?.provider))?;
            let key=provider_key_for_case(provider)?;
            let prepared=with_case_expected(&app,&case_id,Some(epoch),|c|agent::prepare_request(c,&task))?;
            anyhow::ensure!(prepared.provider==provider,"Provider changed before dispatch");

            emit_case_changed(&app);

            let response=tokio::select! {

                result=crate::providers::send(prepared.provider,&key,prepared.body,|delta|{
                    // Persist the provider's generation id while the row is pending,
                    // so a cancelled or failed request can still be reconciled.
                    if let Some(id)=delta["generation_id"].as_str() {
                        let _=with_case_expected(&app,&case_id,Some(epoch),|c|{c.db.execute("UPDATE transmissions SET usage=json_object('generation_id',?) WHERE id=? AND status='pending'",rusqlite::params![id,prepared.transmission])?;Ok(())});
                        return;
                    }
                    let _=app.emit("agent-progress",json!({"case_id":case_id,"session_epoch":epoch,"task_id":task,"transmission_id":prepared.transmission,"delta":delta}));
                })=>result,

                _=cancelled(&app,&case_id,epoch,&task)=>Err(anyhow::anyhow!("Request cancelled; transmission may have occurred")),

            };

            match response {

                Ok(value)=>{
                    // Authorization and registration hold the lock briefly; worker decoding does not.
                    let registered=with_case_expected(&app,&case_id,Some(epoch),|c|agent::prepare_media(c,&task,&prepared.transmission,&value));
                    let (jobs,preparation_error)=match registered {Ok(j)=>(j,None),Err(e)=>(vec![],Some(e.to_string()))};
                    let job_ids=jobs.iter().map(|j|j.job_id.clone()).collect::<Vec<_>>();
                    let mut media=tauri::async_runtime::spawn_blocking(move || agent::PreparedMedia{jobs:jobs.into_iter().map(|job|{let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));(job,staged)}).collect(),cleanup:vec![],external:true,error:preparation_error}).await?;
                    let semantic=with_case_expected(&app,&case_id,Some(epoch),|c|{c.set_meta(&format!("semantic_result:{task}"),"")?;agent::prepare_semantic(c,&task,&prepared.transmission,&value)});
                    if let Ok(Some(job))=semantic {
                        let (job,output)=tauri::async_runtime::spawn_blocking(move || {let output=crate::semantic::run(&job);(job,output)}).await?;
                        with_case_expected(&app,&case_id,Some(epoch),|c|{
                            let query:Value=serde_json::from_str(value["output"].as_array().unwrap().iter().find(|v|v["name"]=="search_semantic").unwrap()["arguments"].as_str().unwrap())?;
                            let result=output.and_then(|v|crate::semantic::publish(c,&job,v));
                            let stored=match result {Ok(v)=>json!({"query":query["query"],"result":v}),Err(e)=>json!({"query":query["query"],"error":e.to_string()})};
                            c.set_meta(&format!("semantic_result:{task}"),&stored.to_string())?;Ok(())
                        })?;
                    }
                    let handled=with_case_expected(&app,&case_id,Some(epoch),|c|agent::receive_prepared(c,&task,&prepared.transmission,value,&mut media));
                    for job in &media.cleanup {let _=crate::processing::cleanup_published_input(job);}
                    with_case_expected(&app,&case_id,Some(epoch),|c|{for job in &job_ids {c.db.execute("UPDATE processing_jobs SET status='failed',error='Tool did not publish; inspect the task receipt or retry' WHERE id=? AND status='running'",[job])?;}Ok(())})?;
                    let more=handled?;kick_transcriptions(app.clone(),case_id.clone());emit_case_changed(&app);if !more{break;}
                },

                Err(error)=>{with_case_expected(&app,&case_id,Some(epoch),|c|{c.db.execute("UPDATE transmissions SET status='uncertain' WHERE id=?",[&prepared.transmission])?;Ok(())})?;return Err(error);}

            }

        } Ok::<(),anyhow::Error>(())

    }.await;

    if let Err(e) = result {

        let _ = with_case_expected(&app, &case_id, Some(epoch), |c| agent::pause(c, &task, &e.to_string()));

    }

    emit_case_changed(&app);

    })
}

fn case_access_route(case:&Case,app:&tauri::AppHandle)->anyhow::Result<crate::ai_access::AccessRoute> {
    match case.meta("ai_access_override")?.as_deref() {
        Some("api_keys")=>Ok(crate::ai_access::AccessRoute::ApiKeys),
        Some("chatgpt_subscription")=>Ok(crate::ai_access::AccessRoute::ChatgptSubscription),
        _=>crate::ai_access::read(&ai_access_dir(app)?),
    }
}
fn case_subscription_selection(case:&Case,app:&tauri::AppHandle)->anyhow::Result<Option<crate::ai_access::SubscriptionSelection>> {
    if let Some(saved)=case.meta("codex_selection")? {
        if !saved.is_empty() {return Ok(Some(serde_json::from_str(&saved)?));}
    }
    Ok(crate::ai_access::read_settings(&ai_access_dir(app)?)?.subscription)
}

fn start_automatic_review(case:&mut Case,app:&tauri::AppHandle)->anyhow::Result<Option<String>> {
    let route=case_access_route(case,app)?;
    let subscription=route==crate::ai_access::AccessRoute::ChatgptSubscription;
    let previous_task=case.meta("auto_review_task")?;
    if let Some(previous)=&previous_task {
        let paused=case.db.query_row::<String,_,_>("SELECT status FROM tasks WHERE id=?",[previous],|r|r.get(0)).ok().as_deref()==Some("paused");
        let prior_subscription=case.meta(&format!("task_access_route:{previous}"))?.as_deref()==Some("chatgpt_subscription");
        if paused && prior_subscription!=subscription {return Ok(None);}
    }
    if subscription {
        // Disabled route: automatic review waits rather than switching vendor.
        if !crate::ai_access::SUBSCRIPTION_ROUTE_ENABLED {return Ok(None);}
        if case_subscription_selection(case,app)?.is_none() {return Ok(None);}
    } else {
        let provider=crate::providers::load(case)?.provider;
        if provider_key_for_case(provider).is_err() {return Ok(None);}
    }
    let task=crate::automatic::start_review_with_access(case,subscription)?;
    if let Some(task)=&task {
        if case.meta(&format!("task_access_route:{task}"))?.is_none() {
            let new_task=previous_task.as_deref()!=Some(task);
            case.set_meta(&format!("task_access_route:{task}"),if subscription && new_task {"chatgpt_subscription"} else {"api_keys"})?;
        }
    }
    Ok(task)
}

async fn run_subscription_session(app:&tauri::AppHandle,case_id:&str,epoch:u64,task:&str)->anyhow::Result<()> {
    if !crate::ai_access::SUBSCRIPTION_ROUTE_ENABLED {
        // A task saved on the subscription route pauses with the stated reason;
        // it is never re-sent through an API key.
        with_case_expected(app,case_id,Some(epoch),|c|agent::pause(c,task,crate::ai_access::SUBSCRIPTION_DISABLED_REASON))?;
        emit_case_changed(app);
        return Ok(());
    }
    let selection=with_case_expected(app,case_id,Some(epoch),|c|case_subscription_selection(c,app))?.context("Select a ChatGPT subscription model")?;
    let runtime=std::env::current_exe()?.parent().context("Executable directory missing")?.join("resources/codex");
    anyhow::ensure!(crate::codex_account::available(&runtime),"Verified Codex sidecar is unavailable");
    let status=crate::codex_account::status(&runtime)?;
    anyhow::ensure!(status["connected"]==true,"Sign in with ChatGPT in Settings first");
    let private_home=crate::codex_account::isolated_home(&runtime)?.canonicalize()?;
    let runtime_root=runtime.canonicalize()?;
    with_case_expected(app,case_id,Some(epoch),|case|{
        ensure_subscription_path_boundary(&case.root.canonicalize()?,&runtime_root,&private_home)
    })?;
    let (instructions,definitions,context)=with_case_expected(app,case_id,Some(epoch),|c|agent::subscription_context(c,task))?;
    let transmission=with_case_expected(app,case_id,Some(epoch),|c|{
        let source_ids:String=c.db.query_row("SELECT scope FROM tasks WHERE id=?",[task],|r|r.get(0))?;
        let transmission=crate::case::id();
        c.db.execute("INSERT INTO transmissions(id,task_id,payload_hash,model,source_ids,reserved,status,created_at) VALUES(?,?,?,?,?,0,'pending',?)",
            rusqlite::params![transmission,task,crate::case::digest(context.as_bytes()),format!("chatgpt_subscription:{}",selection.model),source_ids,crate::case::now()])?;
        c.db.execute("UPDATE tasks SET step=step+1,updated_at=? WHERE id=?",rusqlite::params![crate::case::now(),task])?;
        Ok(transmission)
    })?;
    let handle=app.clone();let cid=case_id.to_owned();let tid=task.to_owned();
    let last_activity=std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    let worker_activity=last_activity.clone();
    let active_jobs=std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let worker_jobs=active_jobs.clone();
    let watchdog_cancelled=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_cancelled=watchdog_cancelled.clone();
    let mut worker=tauri::async_runtime::spawn_blocking(move || {
        crate::codex_case::run(&runtime,&selection.model,&selection.effort,&instructions,&definitions,&context,
            |call_id,name,args| {
                *worker_activity.lock().unwrap_or_else(|e|e.into_inner())=std::time::Instant::now();
                let result=run_subscription_tool(&handle,&cid,epoch,&tid,call_id,name,args,&worker_jobs);
                *worker_activity.lock().unwrap_or_else(|e|e.into_inner())=std::time::Instant::now();
                result
            },
            |delta| {
                *worker_activity.lock().unwrap_or_else(|e|e.into_inner())=std::time::Instant::now();
                let _=handle.emit("agent-progress",json!({"case_id":cid,"session_epoch":epoch,"task_id":tid,"transmission_id":format!("subscription:{tid}"),"delta":{"text":delta}}));
            },
            || worker_cancelled.load(std::sync::atomic::Ordering::SeqCst) || with_case_expected(&handle,&cid,Some(epoch),|c|Ok(c.db.query_row::<String,_,_>("SELECT status FROM tasks WHERE id=?",[&tid],|r|r.get(0))?))
                .map(|status| status=="paused" || status=="cancelled").unwrap_or(true),
        )
    });
    let mut check=tokio::time::interval(std::time::Duration::from_secs(10));
    let completed=loop {
        tokio::select! {
            result=&mut worker => break result,
            _=check.tick() => {
                if last_activity.lock().unwrap_or_else(|e|e.into_inner()).elapsed()>std::time::Duration::from_secs(12*60) {
                    watchdog_cancelled.store(true,std::sync::atomic::Ordering::SeqCst);
                    let reason="ChatGPT subscription had no case action or answer progress for twelve minutes. The unfinished turn was paused; saved receipts remain available to a new task.";
                    let jobs=active_jobs.lock().unwrap_or_else(|e|e.into_inner()).clone();
                    with_case_expected(app,case_id,Some(epoch),|c|{
                        agent::pause(c,task,reason)?;
                        for job in jobs {
                            let cancelled=crate::processing::cancel(c,&job).is_ok();
                            c.db.execute("UPDATE processing_jobs SET status=?,error=? WHERE id=? AND status='running'",rusqlite::params![if cancelled {"cancelled"} else {"failed"},reason,job])?;
                        }
                        c.db.execute("UPDATE transmissions SET status='uncertain' WHERE task_id=? AND status='pending'",[task])?;
                        Ok(())
                    })?;
                    return Err(anyhow::anyhow!(reason));
                }
            }
        }
    };
    let (result,usage)=match completed {
        Ok(Ok(value))=>value,
        Ok(Err(error))=>{
            let _=with_case_expected(app,case_id,Some(epoch),|c|{c.db.execute("UPDATE transmissions SET status='uncertain' WHERE id=? AND status='pending'",[&transmission])?;Ok(())});
            return Err(error);
        },
        Err(error)=>{
            let _=with_case_expected(app,case_id,Some(epoch),|c|{c.db.execute("UPDATE transmissions SET status='uncertain' WHERE id=? AND status='pending'",[&transmission])?;Ok(())});
            return Err(error.into());
        },
    };
    with_case_expected(app,case_id,Some(epoch),|c|{
        c.db.execute("UPDATE transmissions SET status='received',usage=? WHERE id=? AND status='pending'",rusqlite::params![usage.as_ref().map(Value::to_string),transmission])?;
        Ok(())
    })?;
    let still_running=with_case_expected(app,case_id,Some(epoch),|c|Ok(c.db.query_row::<String,_,_>("SELECT status FROM tasks WHERE id=?",[task],|r|r.get(0))?=="running"))?;
    if still_running {
        // A final model message is not a brokered finish_task action. In
        // particular, it must not turn an uninspected case into a completed
        // task just because the model says its tools were unavailable.
        let _ = result;
        anyhow::bail!("ChatGPT subscription ended without calling VisLex finish_task. Case inspection and support review were not completed; retry after the case tools are available.");
    }
    emit_case_changed(app);
    Ok(())
}

fn run_subscription_tool(app:&tauri::AppHandle,case_id:&str,epoch:u64,task:&str,call_id:&str,name:&str,args:Value,active_jobs:&std::sync::Mutex<Vec<String>>)->anyhow::Result<Value> {
    let call=with_case_expected(app,case_id,Some(epoch),|c|agent::prepare_subscription_call(c,task,call_id,name,args.clone()))?;
    let registered=with_case_expected(app,case_id,Some(epoch),|c|agent::prepare_media(c,task,&call.transmission,&call.response));
    let (jobs,preparation_error)=match registered {Ok(j)=>(j,None),Err(e)=>(vec![],Some(e.to_string()))};
    let job_ids=jobs.iter().map(|j|j.job_id.clone()).collect::<Vec<_>>();
    *active_jobs.lock().unwrap_or_else(|e|e.into_inner())=job_ids.clone();
    let mut media=agent::PreparedMedia{jobs:jobs.into_iter().map(|job|{
        let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));
        (job,staged)
    }).collect(),cleanup:vec![],external:true,error:preparation_error};
    let semantic=with_case_expected(app,case_id,Some(epoch),|c|{
        c.set_meta(&format!("semantic_result:{task}"),"")?;
        agent::prepare_semantic(c,task,&call.transmission,&call.response)
    })?;
    if let Some(job)=semantic {
        let output=crate::semantic::run(&job);
        with_case_expected(app,case_id,Some(epoch),|c|{
            let result=output.and_then(|value|crate::semantic::publish(c,&job,value));
            let stored=match result {Ok(value)=>json!({"query":args["query"],"result":value}),Err(error)=>json!({"query":args["query"],"error":error.to_string()})};
            c.set_meta(&format!("semantic_result:{task}"),&stored.to_string())?;
            Ok(())
        })?;
    }
    let result=with_case_expected(app,case_id,Some(epoch),|c|{
        let result=agent::finish_subscription_call(c,task,call,&mut media)?;
        agent::subscription_tool_items(c,task,call_id,result)
    });
    for job in &media.cleanup {let _=crate::processing::cleanup_published_input(job);}
    with_case_expected(app,case_id,Some(epoch),|c|{
        for job in &job_ids {c.db.execute("UPDATE processing_jobs SET status='failed',error='Tool did not publish; inspect the task receipt or retry' WHERE id=? AND status='running'",[job])?;}
        Ok(())
    })?;
    active_jobs.lock().unwrap_or_else(|e|e.into_inner()).clear();
    result
}

fn ensure_subscription_path_boundary(case_root:&Path,runtime_root:&Path,private_home:&Path)->anyhow::Result<()> {
    anyhow::ensure!(!case_root.starts_with(private_home) && !private_home.starts_with(case_root)
        && !case_root.starts_with(runtime_root) && !runtime_root.starts_with(case_root),
        "This case overlaps the isolated Codex runtime or credential profile; move the case before using ChatGPT subscription");
    Ok(())
}

#[cfg(test)]
mod subscription_path_tests {
    use super::ensure_subscription_path_boundary;
    use std::path::Path;
    #[test]
    fn refuses_case_inside_runtime_or_credential_profile() {
        let runtime=Path::new(r"C:\Program Files\VisLex\resources\codex");
        let home=Path::new(r"C:\Users\Synthetic\AppData\Local\Packages\VisLex.Codex.Subscription");
        assert!(ensure_subscription_path_boundary(Path::new(r"D:\Cases\Matter.ledcase"),runtime,home).is_ok());
        assert!(ensure_subscription_path_boundary(&runtime.join("Matter.ledcase"),runtime,home).is_err());
        assert!(ensure_subscription_path_boundary(&home.join("Matter.ledcase"),runtime,home).is_err());
    }
}

#[cfg(test)]
mod provider_key_fence_tests {
    use super::provider_key_case_fence;
    use serde_json::json;
    #[test]
    fn app_level_key_changes_only_when_no_case_is_open() {
        // No case open: app-level requests are allowed; a stale case request is not.
        assert!(provider_key_case_fence(None, &json!({"provider":"openai"})).is_ok());
        assert!(provider_key_case_fence(None, &json!({"provider":"openai","case_id":null})).is_ok());
        assert!(provider_key_case_fence(None, &json!({"provider":"openai","case_id":"old-case"})).is_err());
        // A case is open: the request must name exactly that case.
        assert!(provider_key_case_fence(Some("case-a"), &json!({"provider":"openai","case_id":"case-a"})).is_ok());
        assert!(provider_key_case_fence(Some("case-a"), &json!({"provider":"openai","case_id":"case-b"})).is_err());
        assert!(provider_key_case_fence(Some("case-a"), &json!({"provider":"openai"})).is_err());
    }
}


/// The generated Tauri context. In debug test mode with `VISLEX_TEST_WEBVIEW_DIR`, windows are
/// not created from the configuration; `debug_test_setup` creates them with their own WebView
/// profile, so a native test never reads or writes the user's real application profile (recent
/// cases, last case). Unlike `WEBVIEW2_USER_DATA_FOLDER`, this does not override the research
/// pane's separate profile. (A configured `data_directory` must be relative, so it cannot point
/// into the test artifacts folder.)
fn app_context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if test_webview_dir().is_some() {
        for window in context.config_mut().app.windows.iter_mut() {
            window.create = false;
        }
    }
    context
}

#[cfg(debug_assertions)]
fn test_webview_dir() -> Option<PathBuf> {
    (std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1"))
        .then(|| std::env::var_os("VISLEX_TEST_WEBVIEW_DIR").filter(|folder| !folder.is_empty()).map(PathBuf::from))
        .flatten()
}

#[cfg(debug_assertions)]
fn debug_test_setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(folder) = test_webview_dir() {
        for window in app.config().app.windows.clone() {
            tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?.data_directory(folder.join(&window.label)).build()?;
        }
    }
    // R34 spike without a debugging port or profile override.
    #[cfg(all(feature = "research", windows))]
    if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
        if let (Some(output), Ok(mock)) = (std::env::var_os("VISLEX_RESEARCH_SPIKE_OUTPUT"), std::env::var("VISLEX_RESEARCH_MOCK_URL")) {
            let handle = app.handle().clone();
            let profile = PathBuf::from(&output).with_extension("profile");
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let start = format!("{}/index.html", mock.trim_end_matches('/'));
                let (code, report) = match crate::research::spike::run(handle.clone(), start, profile).await {
                    Ok(report) => (0, json!({"ok": true, "mode": "startup", "report": report})),
                    Err(error) => (1, json!({"ok": false, "mode": "startup", "error": format!("{error:#}")})),
                };
                let _ = std::fs::write(&output, report.to_string());
                handle.exit(code);
            });
        }
    }
    Ok(())
}

pub fn run() {

    let builder = tauri::Builder::default()

        .plugin(tauri_plugin_dialog::init())

        .manage(AppState {

            case: Mutex::new(None),
            active_case_id: Mutex::new(None),
            session_epoch: std::sync::atomic::AtomicU64::new(0),
            event_seq: std::sync::atomic::AtomicU64::new(0),
            importing: std::sync::atomic::AtomicBool::new(false),
            pending_app_ai: std::sync::atomic::AtomicBool::new(false),
            semantic_indexing: Mutex::new(std::collections::HashMap::new()),

        });
    #[cfg(feature = "research")]
    let builder = builder.manage(crate::research::pane::PaneState::default());
    // Debug test builds only: isolated test windows and the startup research spike.
    #[cfg(debug_assertions)]
    let builder = builder.setup(|app| debug_test_setup(app));
    builder

        .invoke_handler(tauri::generate_handler![command])

        .register_uri_scheme_protocol("evidence", |ctx, request| {

            let build = || -> anyhow::Result<tauri::http::Response<Vec<u8>>> {

                // Evidence bytes are served only to the application UI webview, never to
                // other webviews in the same window (such as the research browser).
                anyhow::ensure!(ctx.webview_label() == "main", "Evidence protocol is limited to the application webview");

                let decoded =

                    percent_encoding::percent_decode_str(request.uri().path()).decode_utf8()?;

                let source_id = decoded.trim_start_matches('/');

                let state = ctx.app_handle().state::<AppState>();

                let guard = state.case.lock().unwrap_or_else(|e|e.into_inner());

                let c = guard

                    .as_ref()

                    .ok_or_else(|| anyhow::anyhow!("Case closed"))?;

                // Display only: resolve the artifact under the lock and verify it
                // after releasing it, with the interactive (len, mtime) hash
                // cache. Exports, redaction, agent reads and citations keep the
                // strong hash in processing::artifact.
                let (mime, path, expected) = if let Some(artifact_id) = source_id.strip_prefix("artifact/") {

                    let (_, mime, path, hash, _) = crate::processing::artifact_descriptor(c, artifact_id)?;

                    anyhow::ensure!(["image/jpeg","video/mp4"].contains(&mime.as_str()), "Not a display artifact");

                    (mime, path, Some(hash))

                } else {

                    let s = c.source(source_id)?;

                    anyhow::ensure!(

                        ["image", "video", "audio", "pdf"].contains(&s.kind.as_str()),

                        "Unsupported viewer format"

                    );

                    (s.mime, c.source_path(source_id)?, None)

                };

                drop(guard); // File streaming must not block settings and agent control.
                if let Some(expected) = expected {
                    anyhow::ensure!(crate::case::file_hash_cached(&path)? == expected, "Artifact integrity check failed");
                }
                let mut file = std::fs::File::open(path)?;

                let size = file.metadata()?.len();

                let mut start = 0;

                let mut end = size.saturating_sub(1);

                let partial = request.headers().contains_key("range");

                if let Some(range) = request.headers().get("range").and_then(|h| h.to_str().ok()) {

                    let range = range

                        .strip_prefix("bytes=")

                        .ok_or_else(|| anyhow::anyhow!("Bad range"))?;

                    let (a, b) = range

                        .split_once('-')

                        .ok_or_else(|| anyhow::anyhow!("Bad range"))?;

                    if a.is_empty() {

                        let suffix: u64 = b.parse()?;

                        start = size.saturating_sub(suffix);

                    } else {

                        start = a.parse()?;

                        if !b.is_empty() {

                            end = b.parse::<u64>()?.min(end);

                        }

                    }

                }

                anyhow::ensure!(

                    size > 0 && start < size && end >= start,

                    "Range not satisfiable"

                );

                // Media is streamed in bounded ranges; non-media previews are limited to 64 MiB.

                if partial {

                    end = end.min(start + 4 * 1024 * 1024 - 1);

                } else {

                    anyhow::ensure!(

                        size <= 64 * 1024 * 1024,

                        "Preview requires range requests for files over 64 MiB"

                    );

                }

                let mut bytes = vec![0; (end - start + 1) as usize];

                file.seek(SeekFrom::Start(start))?;

                file.read_exact(&mut bytes)?;

                let mut response = tauri::http::Response::builder()

                    .status(if partial { 206 } else { 200 })

                    .header("Content-Type", mime)

                    .header("Accept-Ranges", "bytes")

                    .header("Content-Length", bytes.len())

                    .header("X-Content-Type-Options", "nosniff")

                    .header("Cache-Control", "no-store");

                if partial {

                    response =

                        response.header("Content-Range", format!("bytes {start}-{end}/{size}"));

                }

                Ok(response.body(bytes)?)

            };

            build().unwrap_or_else(|_| {

                tauri::http::Response::builder()

                    .status(416)

                    .header("Content-Type", "text/plain")

                    .body(

                        b"Preview unavailable. Check source integrity, size, and format.".to_vec(),

                    )

                    .unwrap()

            })

        })

        .run(app_context())

        .expect("Could not start Local Evidence Desk");

}


/// Where the app-wide AI access route (API keys or ChatGPT subscription) is
/// saved. Test mode keeps it beside the isolated app AI defaults, or in a
/// fresh per-process folder, so a native journey never reads or changes the
/// user's route (a missing file means API keys).
fn ai_access_dir(app:&tauri::AppHandle)->anyhow::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {
        return Ok(match std::env::var_os("VISLEX_TEST_AI_DEFAULTS_PATH").map(PathBuf::from) {
            Some(defaults)=>defaults.parent().context("Test AI defaults path has no parent")?.to_path_buf(),
            None=>std::env::temp_dir().join(format!("vislex-test-access-{}",std::process::id())),
        });
    }
    Ok(app.path().app_config_dir()?)
}
fn ai_defaults_path(app:&tauri::AppHandle)->anyhow::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {
        return std::env::var_os("VISLEX_TEST_AI_DEFAULTS_PATH")
            .map(PathBuf::from)
            .context("App AI settings are disabled in test mode without an isolated defaults path");
    }
    Ok(app.path().app_config_dir()?.join("ai-defaults.json"))
}
fn read_ai_defaults(app:&tauri::AppHandle)->anyhow::Result<Option<(crate::providers::Config,Settings)>> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") && std::env::var_os("VISLEX_TEST_AI_DEFAULTS_PATH").is_none() {
        return Ok(None);
    }
    let path=ai_defaults_path(app)?;
    if !path.is_file() {return Ok(None);}
    let value:Value=serde_json::from_slice(&std::fs::read(path)?)?;
    crate::providers::parse_ai_defaults(&value)
}
fn write_ai_defaults(app:&tauri::AppHandle,config:&crate::providers::Config,settings:&Settings)->anyhow::Result<()> {
    let defaults=json!({"config":config,"settings":settings,"consent_version":crate::providers::AI_DEFAULTS_CONSENT_VERSION});
    anyhow::ensure!(crate::providers::parse_ai_defaults(&defaults)?.is_some(),"Invalid app AI settings");
    anyhow::ensure!(!settings.allow_images||settings.allow_text,"Image analysis requires text permission");
    let subscription=crate::ai_access::read(&ai_access_dir(app)?)?==crate::ai_access::AccessRoute::ChatgptSubscription;
    anyhow::ensure!(settings.offline || !settings.allow_text || !settings.model.is_empty() || subscription,"Select a model before enabling AI");
    let path=ai_defaults_path(app)?;
    let directory=path.parent().context("App AI settings path has no parent")?;
    std::fs::create_dir_all(directory)?;
    let mut staged=tempfile::NamedTempFile::new_in(&directory)?;
    std::io::Write::write_all(&mut staged,&serde_json::to_vec(&defaults)?)?;
    staged.as_file().sync_all()?;
    staged.persist(path)?;
    Ok(())
}
fn case_has_running_ai(case:&Case)->anyhow::Result<bool> {
    Ok(case.db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE status='running')",[],|row|row.get::<_,i64>(0))?!=0)
}
fn sync_inherited_ai(app:&tauri::AppHandle,case:&mut Case)->anyhow::Result<()> {
    if case.meta("ai_scope")?.as_deref()==Some("app") && !case_has_running_ai(case)? {
        // Invalid or pre-consent defaults cannot widen a case's grants.
        if let Ok(Some((config,settings)))=read_ai_defaults(app) {
            if serde_json::to_value(crate::providers::load(case)?)?!=serde_json::to_value(&config)?
                || serde_json::to_value(case.settings()?)?!=serde_json::to_value(&settings)? {
                crate::providers::apply_app_settings(case,&app_policy(&config,&settings)?)?;
            }
        }
    }
    Ok(())
}
/// App defaults are a policy whose grants were consented for its own default
/// provider, so cases that follow app settings adopt them for that provider.
fn app_policy(config:&crate::providers::Config,settings:&Settings)->anyhow::Result<Value> {
    Ok(json!({"config":config,"settings":settings,"grants_for_provider":config.provider}))
}
fn kick_discovery(app:tauri::AppHandle,case_id:String) {
    let epoch=app.state::<AppState>().session_epoch.load(std::sync::atomic::Ordering::SeqCst);
    let session_key=format!("{case_id}:{epoch}");
    static ACTIVE:std::sync::OnceLock<Mutex<std::collections::HashSet<String>>>=std::sync::OnceLock::new();
    let active=ACTIVE.get_or_init(||Mutex::new(std::collections::HashSet::new()));
    if !active.lock().unwrap_or_else(|e|e.into_inner()).insert(session_key.clone()) {return;}
    struct Lease {active:&'static Mutex<std::collections::HashSet<String>>,id:String}
    impl Drop for Lease {fn drop(&mut self){self.active.lock().unwrap_or_else(|e|e.into_inner()).remove(&self.id);}}
    let lease=Lease{active,id:session_key};
    tauri::async_runtime::spawn_blocking(move || {
        let _lease=lease;
        // One lane can run OCR while the other runs overview. discovery::next
        // claims distinct kinds under the case lock, and the worker's memory
        // gate still serializes OCR and refuses unsafe overlap.
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let app=app.clone();let case_id=case_id.clone();
                scope.spawn(move || run_discovery_lane(&app,&case_id,epoch));
            }
        });
        let task=with_case_expected(&app,&case_id,Some(epoch),|c|start_automatic_review(c,&app));
        if let Ok(Some(task))=task {
            emit_case_changed(&app);
            tauri::async_runtime::spawn(async move {run_agent(app,case_id,epoch,task).await;});
        }
    });
}
fn run_discovery_lane(app:&tauri::AppHandle,case_id:&str,epoch:u64) {
    loop {
        let job=match with_case_expected(app,case_id,Some(epoch),crate::discovery::next) {
            Ok(Some(job))=>job,
            Ok(None)=>{let pending=with_case_expected(app,case_id,Some(epoch),|c|Ok(c.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs j JOIN sources s ON s.id=j.source_id WHERE s.restricted=0 AND j.status='queued' AND j.kind IN ('video_ocr_index','video_overview_index'))",[],|r|r.get::<_,bool>(0))?)).unwrap_or(false);if pending {std::thread::sleep(std::time::Duration::from_millis(500));continue;}break;},
            Err(_)=>break
        };
        let staged=crate::processing::stage_prepared(&job.processor,crate::processing::run_prepared(&job.processor));
        let published=with_case_expected(app,case_id,Some(epoch),|c|{crate::discovery::publish_staged(c,&job,staged)?;Ok(c.db.query_row("SELECT status='complete' FROM processing_jobs WHERE id=?",[&job.processor.job_id],|r|r.get::<_,bool>(0))?) });
        if matches!(published,Ok(true)){let _=crate::processing::cleanup_published_input(&job.processor);}
        emit_case_changed(&app);
    }
}
fn kick_automatic(app:tauri::AppHandle,case_id:String) {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {return;}
    let epoch=app.state::<AppState>().session_epoch.load(std::sync::atomic::Ordering::SeqCst);
    kick_semantic(app.clone(),case_id.clone());
    kick_discovery(app.clone(),case_id.clone());
    for _ in 0..2 {
        let app=app.clone();let case_id=case_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            loop {
                let job=match with_case_expected(&app,&case_id,Some(epoch),crate::automatic::next) {Ok(Some(job))=>job,_=>break};
                let staged=crate::processing::stage_prepared(&job.processor,crate::processing::run_prepared(&job.processor));
                let published=with_case_expected(&app,&case_id,Some(epoch),|c|{crate::automatic::publish_staged(c,&job,staged)?;Ok(c.db.query_row("SELECT status='complete' FROM processing_jobs WHERE id=?",[&job.processor.job_id],|r|r.get::<_,bool>(0))?) });
                if matches!(published,Ok(true)){let _=crate::processing::cleanup_published_input(&job.processor);kick_semantic(app.clone(),case_id.clone());}
                emit_case_changed(&app);
                let task=with_case_expected(&app,&case_id,Some(epoch),|c|start_automatic_review(c,&app));
                if let Ok(Some(task))=task {let app=app.clone();let case_id=case_id.clone();tauri::async_runtime::spawn(async move {run_agent(app,case_id,epoch,task).await;});}
            }
            let task=with_case_expected(&app,&case_id,Some(epoch),|c|start_automatic_review(c,&app));
            if let Ok(Some(task))=task {
                emit_case_changed(&app);
                tauri::async_runtime::spawn(async move {run_agent(app,case_id,epoch,task).await;});
            }
        });
    }
}
fn kick_semantic(app:tauri::AppHandle,case_id:String) {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {return;}
    let state=app.state::<AppState>();
    let epoch=state.session_epoch.load(std::sync::atomic::Ordering::SeqCst);
    let session_key=format!("{case_id}:{epoch}");
    {
        let mut active=state.semantic_indexing.lock().unwrap_or_else(|e|e.into_inner());
        if let Some(dirty)=active.get_mut(&session_key){*dirty=true;return;}
        active.insert(session_key.clone(),false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        struct Registration {app:tauri::AppHandle,session_key:String}
        impl Drop for Registration {fn drop(&mut self){let state=self.app.state::<AppState>();state.semantic_indexing.lock().unwrap_or_else(|e|e.into_inner()).remove(&self.session_key);}}
        let _registration=Registration{app:app.clone(),session_key:session_key.clone()};
        loop {
            let prepared=with_case_expected(&app,&case_id,Some(epoch),|case|{
                let scope=case.sources()?.into_iter().filter(|source|!source.restricted).map(|source|source.id).collect();
                crate::semantic::prepare_background(case,scope)
            });
            let job=match prepared {
                Ok(Some(job))=>job,
                Ok(None)=>{
                    let state=app.state::<AppState>();let mut active=state.semantic_indexing.lock().unwrap_or_else(|e|e.into_inner());
                    if let Some(dirty)=active.get_mut(&session_key) {if *dirty {*dirty=false;continue;}}
                    active.remove(&session_key);break;
                },
                Err(_)=>break
            };
            let output=crate::semantic::run(&job);
            let published=with_case_expected(&app,&case_id,Some(epoch),|case|crate::semantic::publish_index(case,&job,&output?));
            if let Err(error)=published {
                let _=with_case_expected(&app,&case_id,Some(epoch),|case|{case.audit("semantic_index_paused",json!({"reason":error.to_string().chars().take(300).collect::<String>()}))?;Ok(())});
                break;
            }
        }
    });
}

fn import_background(app:&tauri::AppHandle,action:&str,args:Value)->anyhow::Result<Value> {
    use std::sync::atomic::{AtomicBool,Ordering};
    let state=app.state::<AppState>();
    anyhow::ensure!(state.importing.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_ok(),"An import is already active");
    struct Lease<'a>(&'a AtomicBool);impl Drop for Lease<'_>{fn drop(&mut self){self.0.store(false,Ordering::SeqCst);}}
    let _lease=Lease(&state.importing);
    let (root,case_id)={let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before import");require_session_epoch(&state,&args)?;(case.root.clone(),case.meta("id")?.unwrap_or_default())};
    let (paths,skipped)=if action=="import_folder" {crate::case::folder_paths(&root,Path::new(text(&args,"path")?))?}else{(serde_json::from_value::<Vec<String>>(args["paths"].clone())?,vec![])};
    anyhow::ensure!(paths.len()<=10000,"Import at most 10,000 files per batch");
    let production=args["production"].as_str().unwrap_or("Imported evidence");
    let batch=crate::case::id();let mut items=Vec::new();
    for path in paths {
        // Large file copies and original/staging hashes never hold the case mutex.
        let prepared=crate::case::prepare_import(&root,Path::new(&path));
        let item=with_case(app,&case_id,|c| {
            let result=prepared.and_then(|p|c.publish_import(p,production,&batch));
            let status=if result.is_ok(){"imported"}else{"failed"};
            let detail=result.unwrap_or_else(|e|json!({"error":e.to_string()}));
            c.db.execute("INSERT INTO imports VALUES(?,?,?,?,?,?)",rusqlite::params![crate::case::id(),path,batch,status,detail.to_string(),crate::case::now()])?;
            Ok(json!({"path":path,"status":status,"detail":detail}))
        })?;
        items.push(item);emit_case_changed(&app);
    }
    with_case(app,&case_id,|c|{c.audit("import_batch",json!({"batch":batch,"items":items}))?;crate::automatic::enqueue(c)})?;
    kick_automatic(app.clone(),case_id.clone());kick_transcriptions(app.clone(),case_id);
    emit_case_changed(&app);
    Ok(json!({"batch":batch,"items":items,"skipped":skipped}))
}
