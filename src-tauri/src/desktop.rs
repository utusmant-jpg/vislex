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

fn provider_key_for_case(provider: crate::providers::Provider) -> anyhow::Result<String> {
    if crate::providers::synthetic_provider_url()?.is_some() {
        return Ok("synthetic-local-transport".into());
    }
    Ok(provider_key_entry(provider)?.get_password()?)
}



fn key_entry() -> anyhow::Result<keyring::Entry> { provider_key_entry(crate::providers::Provider::Openai) }

#[tauri::command]

async fn command(app: tauri::AppHandle, action: String, args: Value) -> Result<Value, String> {
    if action=="fetch_public_authority" {
        let prepared=(||->anyhow::Result<_>{let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;ensure_session_epoch(&state,&args)?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before authority retrieval");require_session_epoch(&state,&args)?;anyhow::ensure!(!case.settings()?.offline,"Offline mode enabled");let url=text(&args,"url")?.to_string();crate::authority::validate_url(&url)?;Ok((case.meta("id")?.unwrap_or_default(),state.session_epoch.load(std::sync::atomic::Ordering::SeqCst),url))})();
        let (case_id,epoch,url)=prepared.map_err(|e|e.to_string())?;
        let download=crate::authority::retrieve(&url).await.map_err(|e|e.to_string())?;
        let value=with_case_expected(&app,&case_id,Some(epoch),|case|crate::authority::publish(case,download,text(&args,"title")?,text(&args,"jurisdiction")?,text(&args,"relevant_date")?)).map_err(|e|e.to_string())?;
        kick_automatic(app.clone(),case_id);emit_case_changed(&app);return Ok(value);
    }
    // Explicit account metadata lookup: no case material and no case mutex during network I/O.
    if action == "provider_models" {
        let provider:crate::providers::Provider=serde_json::from_value(args["provider"].clone()).map_err(|e|e.to_string())?;
        let key=provider_key_entry(provider).and_then(|entry|entry.get_password().map_err(Into::into)).map_err(|_|format!("Save a {} API key first",provider.name()))?;
        let models=tokio::time::timeout(std::time::Duration::from_secs(45),crate::providers::list_models(provider,&key)).await.map_err(|_|"Model catalogue request timed out; retry when connected".to_string())?.map_err(|e|e.to_string())?;
        return serde_json::to_value(models).map_err(|e|e.to_string());
    }


    let result = tauri::async_runtime::spawn_blocking(move || dispatch(&app, &action, args))

        .await

        .map_err(|e| e.to_string())?;

    result.map_err(|e| e.to_string())

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
        let settings: Settings = serde_json::from_value(args["settings"].clone())?;
        write_ai_defaults(app, &config, &settings)?;
        let state = app.state::<AppState>();
        let mut guard = state.case.lock().unwrap_or_else(|e|e.into_inner());
        let mut current_case_updated = true;
        if let Some(case) = guard.as_mut() {
            if case.meta("ai_scope")?.as_deref() == Some("app") {
                if case_has_running_ai(case)? {
                    current_case_updated = false;
                } else if crate::providers::apply_app_settings(case, &json!({"config":config,"settings":settings})).is_err() {
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
        let directory = app.path().app_config_dir()?;
        if action == "ai_access_route" {
            let settings=crate::ai_access::read_settings(&directory)?;
            return Ok(json!({"route":settings.route,"subscription":settings.subscription,"subscription_ready":false,
                "blocker":"Codex dynamic tools and its Windows process boundary have not passed packaged security verification"}));
        }
        if action == "set_ai_access_route" {
            let route:crate::ai_access::AccessRoute=serde_json::from_value(args["route"].clone())?;
            anyhow::ensure!(route == crate::ai_access::AccessRoute::ApiKeys,
                "ChatGPT subscription tasks are unavailable until the Codex tool bridge and Windows process boundary are verified");
            crate::ai_access::write(&directory,route)?;
            return Ok(json!({"route":route}));
        }
        let home=app.path().resource_dir()?.join("codex");
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
            "codex_account_logout"=>{crate::codex_account::logout(&home)?;Ok(Value::Null)},
            "codex_account_models"=>crate::codex_account::models(&home),
            "codex_account_limits"=>crate::codex_account::limits(&home),
            _=>unreachable!(),
        };
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
        let case=guard.as_ref().context("Open a case first")?;
        anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before provider key update");
        require_session_epoch(&state,&args)?;
        let entry=provider_key_entry(provider)?;
        return match action {
            "save_provider_key"=>{let key=text(&args,"key")?;anyhow::ensure!(!key.trim().is_empty(),"Enter a key");entry.set_password(key.trim())?;Ok(json!({"saved":true}))},
            "delete_provider_key"=>{entry.delete_credential()?;Ok(json!({"deleted":true}))},
            _=>anyhow::bail!("Unknown provider key action")
        };
    }
    if ["import_files","import_folder"].contains(&action) {return import_background(app,action,args);}
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
    if action == "save_api_key" {
        let state=app.state::<AppState>();
        let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
        let case=guard.as_ref().context("Open a case first")?;
        anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before API key update");
        require_session_epoch(&state,&args)?;

        let key = text(&args, "key")?;

        anyhow::ensure!(!key.trim().is_empty(), "Enter an API key");

        key_entry()?.set_password(key.trim())?;

        return Ok(json!({"saved":true}));

    }

    if action == "key_status" {

        return Ok(json!({"configured":key_entry()?.get_password().is_ok()}));

    }

    if action == "delete_api_key" {
        let state=app.state::<AppState>();
        let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
        let case=guard.as_ref().context("Open a case first")?;
        anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before API key update");
        require_session_epoch(&state,&args)?;

        key_entry()?.delete_credential()?;

        return Ok(json!({"deleted":true}));

    }

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
        "set_case_ai_scope" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before AI scope update");
            require_session_epoch(&state,&args)?;
            let scope=text(&args,"scope")?;
            anyhow::ensure!(scope=="app"||scope=="case","Invalid AI scope");
            if scope=="app" {
                anyhow::ensure!(!case_has_running_ai(c)?,"Stop the current AI task before applying app settings");
                let (config,settings)=read_ai_defaults(app)?.context("Set up app AI first")?;
                crate::providers::apply_app_settings(c,&json!({"config":config,"settings":settings}))?;
            }
            c.set_meta("ai_scope",scope)?;
            c.audit("ai_scope_changed",json!({"scope":scope}))?;
            json!({"scope":scope})
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
        "export_redaction" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before redaction export");crate::exports::export_redaction(c,text(&args,"artifact_id")?,Path::new(text(&args,"path")?))?},
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
            anyhow::ensure!(crate::ai_access::read(&app.path().app_config_dir()?)? == crate::ai_access::AccessRoute::ApiKeys,
                "ChatGPT subscription execution is unavailable; no API key was used. Select API keys in Settings to run this task.");
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}

            let selected = if let (Some(provider), Some(model)) = (args.get("provider"), args["model"].as_str()) {
                crate::providers::select_profile(c, serde_json::from_value(provider.clone())?, model)?
            } else { crate::providers::task_profile(c, "")? };
            crate::providers::check_permission(c, &selected)?;
            if !agent::is_file_count_question(text(&args,"prompt")?) {
            provider_key_for_case(selected.provider)
                .map_err(|_| anyhow::anyhow!("Save an API key in Settings first"))?;

            }
            let (source_ids, record_ids) = agent::case_scope(c)?;

            let task = agent::start(

                c,

                text(&args, "prompt")?,

                "investigate",

                source_ids,

                record_ids,

                0.0,

            )?;

            c.set_meta(&format!("task_profile:{task}"), &serde_json::to_string(&selected)?)?;
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
            anyhow::ensure!(crate::ai_access::read(&app.path().app_config_dir()?)? == crate::ai_access::AccessRoute::ApiKeys,
                "ChatGPT subscription execution is unavailable; no API key was used. Select API keys in Settings to resume this task.");
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
            let profile=crate::providers::task_profile(c,old)?;
            provider_key_for_case(profile.provider).map_err(|_|anyhow::anyhow!("Save an API key in Settings first"))?;
            let (task,conversation)=agent::continue_paused(c,old)?;
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
        "ai_config", "direct_media_permission", "investigation_workbench", "coverage_map", "incident_replay", "processing_recovery", "team_status", "read_dossier", "read_coverage", "evidence_list", "evidence_read", "evidence_search", "fit_clock",

        "full_transcription_status",
        "transcript_segment_page",
        "transcript_segment_detail",

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

        anyhow::ensure!(crate::ai_access::read(&app.path().app_config_dir()?)? == crate::ai_access::AccessRoute::ApiKeys,
            "ChatGPT subscription execution is unavailable; no API key was used");




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

                result=crate::providers::send(prepared.provider,&key,prepared.body,|delta|{let _=app.emit("agent-progress",json!({"case_id":case_id,"session_epoch":epoch,"task_id":task,"transmission_id":prepared.transmission,"delta":delta}));})=>result,

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


pub fn run() {

    tauri::Builder::default()

        .plugin(tauri_plugin_dialog::init())

        .manage(AppState {

            case: Mutex::new(None),
            active_case_id: Mutex::new(None),
            session_epoch: std::sync::atomic::AtomicU64::new(0),
            event_seq: std::sync::atomic::AtomicU64::new(0),
            importing: std::sync::atomic::AtomicBool::new(false),
            pending_app_ai: std::sync::atomic::AtomicBool::new(false),
            semantic_indexing: Mutex::new(std::collections::HashMap::new()),

        })

        .invoke_handler(tauri::generate_handler![command])

        .register_uri_scheme_protocol("evidence", |ctx, request| {

            let build = || -> anyhow::Result<tauri::http::Response<Vec<u8>>> {

                let decoded =

                    percent_encoding::percent_decode_str(request.uri().path()).decode_utf8()?;

                let source_id = decoded.trim_start_matches('/');

                let state = ctx.app_handle().state::<AppState>();

                let guard = state.case.lock().unwrap_or_else(|e|e.into_inner());

                let c = guard

                    .as_ref()

                    .ok_or_else(|| anyhow::anyhow!("Case closed"))?;

                let (mime, path) = if let Some(artifact_id) = source_id.strip_prefix("artifact/") {

                    let (_, mime, path, _) = crate::processing::artifact(c, artifact_id)?;

                    anyhow::ensure!(["image/jpeg","video/mp4"].contains(&mime.as_str()), "Not a display artifact");

                    (mime, path)

                } else {

                    let s = c.source(source_id)?;

                    anyhow::ensure!(

                        ["image", "video", "audio", "pdf"].contains(&s.kind.as_str()),

                        "Unsupported viewer format"

                    );

                    (s.mime, c.source_path(source_id)?)

                };

                drop(guard); // File streaming must not block settings and agent control.
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

                    .header("Cache-Control", "no-store")

                    .header("Access-Control-Allow-Origin", "*");

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

        .run(tauri::generate_context!())

        .expect("Could not start Local Evidence Desk");

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
    anyhow::ensure!(settings.offline || !settings.allow_text || !settings.model.is_empty(),"Select a model before enabling AI");
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
                crate::providers::apply_app_settings(case,&json!({"config":config,"settings":settings}))?;
            }
        }
    }
    Ok(())
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
        let task=with_case_expected(&app,&case_id,Some(epoch),|c| {
            if crate::ai_access::read(&app.path().app_config_dir()?)? != crate::ai_access::AccessRoute::ApiKeys {return Ok(None);}
            let provider=crate::providers::load(c)?.provider;
            if provider_key_for_case(provider).is_err(){return Ok(None);}
            crate::automatic::start_review(c)
        });
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
                let task=with_case_expected(&app,&case_id,Some(epoch),|c| {if crate::ai_access::read(&app.path().app_config_dir()?)? != crate::ai_access::AccessRoute::ApiKeys {return Ok(None);}let provider=crate::providers::load(c)?.provider;if provider_key_for_case(provider).is_err(){return Ok(None);}crate::automatic::start_review(c)});
                if let Ok(Some(task))=task {let app=app.clone();let case_id=case_id.clone();tauri::async_runtime::spawn(async move {run_agent(app,case_id,epoch,task).await;});}
            }
            let task=with_case_expected(&app,&case_id,Some(epoch),|c| {
                if crate::ai_access::read(&app.path().app_config_dir()?)? != crate::ai_access::AccessRoute::ApiKeys {return Ok(None);}
                let provider=crate::providers::load(c)?.provider;
                if provider_key_for_case(provider).is_err(){return Ok(None);}
                crate::automatic::start_review(c)
            });
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
