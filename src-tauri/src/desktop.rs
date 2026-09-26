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
    importing: std::sync::atomic::AtomicBool,
    semantic_indexing: Mutex<std::collections::HashMap<String,bool>>,

}

fn text<'a>(v: &'a Value, k: &str) -> anyhow::Result<&'a str> {

    v[k].as_str().ok_or_else(|| anyhow::anyhow!("Missing {k}"))

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



fn key_entry() -> anyhow::Result<keyring::Entry> { provider_key_entry(crate::providers::Provider::Openai) }

#[tauri::command]

async fn command(app: tauri::AppHandle, action: String, args: Value) -> Result<Value, String> {
    if action=="fetch_public_authority" {
        let prepared=(||->anyhow::Result<_>{let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before authority retrieval");anyhow::ensure!(!case.settings()?.offline,"Offline mode enabled");let url=text(&args,"url")?.to_string();crate::authority::validate_url(&url)?;Ok((case.meta("id")?.unwrap_or_default(),url))})();
        let (case_id,url)=prepared.map_err(|e|e.to_string())?;
        let download=crate::authority::retrieve(&url).await.map_err(|e|e.to_string())?;
        let value=with_case(&app,&case_id,|case|crate::authority::publish(case,download,text(&args,"title")?,text(&args,"jurisdiction")?,text(&args,"relevant_date")?)).map_err(|e|e.to_string())?;
        kick_automatic(app.clone(),case_id);let _=app.emit("case-changed",());return Ok(value);
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

    if action=="hybrid_search" {
        let (case_id,job)={let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;let scope=case.sources()?.into_iter().filter(|s|!s.restricted).map(|s|s.id).collect();(case.meta("id")?.unwrap_or_default(),crate::semantic::prepare_query(case,text(&args,"query")?,scope)?)};
        let result=crate::semantic::run(&job)?;
        return with_case(app,&case_id,|case|crate::semantic::publish(case,&job,result));
    }
    if action=="export_word" {
        let (case_id,job)={let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before export");let record_id=text(&args,"record_id")?;let expected=export_revision(&args)?;(case.meta("id")?.unwrap_or_default(),crate::exports::prepare_document_deferred_at_revision(case,record_id,expected,Path::new(text(&args,"path")?))?)};
        crate::exports::run_document(&job)?;
        let staged=crate::exports::stage_document(&job)?;
        return with_case(app,&case_id,|case|crate::exports::publish_staged_document(case,&job,staged));
    }
    if action=="resume_transcription" {
        let (case_id,job)={let state=app.state::<AppState>();let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_mut().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription resume");(case.meta("id")?.unwrap_or_default(),crate::transcription::resume(case,text(&args,"job_id")?)?)};
        let staged=crate::transcription::run(&job).and_then(|value|crate::transcription::stage_transcript(&job,value));
        let value=with_case(app,&case_id,|case|match staged {Ok(v)=>crate::transcription::publish_staged_transcript(case,&job,v),Err(e)=>{crate::transcription::fail(case,&job,&e.to_string())?;Err(e)}});
        if value.is_ok(){kick_semantic(app.clone(),case_id.clone());}
        let _=app.emit("case-changed",());return value;
    }
    if action=="resume_processing" {
        let (case_id,job)={let state=app.state::<AppState>();let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_mut().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before processing resume");(case.meta("id")?.unwrap_or_default(),crate::processing::resume(case,text(&args,"job_id")?)?)};
        let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));
        let result=with_case(app,&case_id,|case|crate::processing::publish_staged(case,&job,staged));
        if result.is_ok() {let _=crate::processing::cleanup_published_input(&job);kick_semantic(app.clone(),case_id.clone());}
        let _=app.emit("case-changed",());return result;
    }
    if ["save_provider_key","provider_key_status","delete_provider_key"].contains(&action) {
        let provider:crate::providers::Provider=serde_json::from_value(args["provider"].clone())?;

        let entry=provider_key_entry(provider)?;
        return match action {
            "save_provider_key"=>{let key=text(&args,"key")?;anyhow::ensure!(!key.trim().is_empty(),"Enter a key");entry.set_password(key.trim())?;Ok(json!({"saved":true}))},
            "delete_provider_key"=>{entry.delete_credential()?;Ok(json!({"deleted":true}))},
            _=>Ok(json!({"configured":entry.get_password().is_ok()}))
        };
    }
    if ["import_files","import_folder"].contains(&action) {return import_background(app,action,args);}
    if ["process_source","probe_pdf","render_page","transcribe_source","scan_sound_events","prepare_redaction","diarize_source","step_video_frame"].contains(&action) {
        let (case_id,job)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let case=guard.as_mut().context("Open a case first")?;
            let source=text(&args,"source_id")?;
            anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before source processing");
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
            (case.meta("id")?.unwrap_or_default(),crate::processing::prepare_request(case,source,options)?)
        };
        let _=app.emit("case-changed",());
        let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));
        let result=with_case(app,&case_id,|case|crate::processing::publish_staged(case,&job,staged));
        if result.is_ok() {let _=crate::processing::cleanup_published_input(&job);kick_semantic(app.clone(),case_id.clone());}
        let _=app.emit("case-changed",());
        return result;
    }
    if action == "save_api_key" {

        let key = text(&args, "key")?;

        anyhow::ensure!(!key.trim().is_empty(), "Enter an API key");

        key_entry()?.set_password(key.trim())?;

        return Ok(json!({"saved":true}));

    }

    if action == "key_status" {

        return Ok(json!({"configured":key_entry()?.get_password().is_ok()}));

    }

    if action == "delete_api_key" {

        key_entry()?.delete_credential()?;

        return Ok(json!({"deleted":true}));

    }

    if action=="playback_proxy" {

        use rusqlite::OptionalExtension;

        let state=app.state::<AppState>();

        let job={

            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());

            let c=guard.as_mut().ok_or_else(||anyhow::anyhow!("Open a case first"))?;

            let source=text(&args,"source_id")?;

            let cached:Option<String>=c.db.query_row("SELECT id FROM artifacts WHERE source_id=? AND mime='video/mp4' AND json_extract(metadata,'$.player_origin_seconds')=0 ORDER BY created_at DESC LIMIT 1",[source],|r|r.get(0)).optional()?;

            if let Some(id)=cached {crate::processing::artifact(c,&id)?;return Ok(json!({"artifact_id":id}));}

            let running:i64=c.db.query_row("SELECT count(*) FROM processing_jobs WHERE source_id=? AND kind='playback' AND status='running'",[source],|r|r.get(0))?;

            anyhow::ensure!(running==0,"Playback is already being prepared. Reopen this source after conversion finishes.");

            crate::processing::prepare_playback(c,source)?

        };

        let staged=crate::processing::stage_playback(&job,crate::processing::run_playback(&job));

        let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());

        let c=guard.as_mut().ok_or_else(||anyhow::anyhow!("Case closed during playback processing"))?;

        anyhow::ensure!(c.meta("id")?.unwrap_or_default()==job.case_id,"Case changed during playback processing");

        let result=crate::processing::publish_staged_playback(c,&job,staged);

        let _=app.emit("case-changed",());

        return result;

    }
    if action=="verify_source" {
        let source_id=text(&args,"source_id")?.to_owned();
        let (case_id,path,expected)={
            let state=app.state::<AppState>();
            let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let c=guard.as_ref().context("Open a case first")?;
            let source=c.source(&source_id)?;
            (c.meta("id")?.unwrap_or_default(),c.source_path(&source_id)?,source.sha256)
        };
        // Hash the opened original outside the case mutex. On Windows this
        // read handle denies writes and replacement until the hash completes.
        anyhow::ensure!(crate::case::file_hash_strong(&path)?==expected,"Original bytes changed: strong integrity check failed");
        return with_case(app,&case_id,|c|{
            anyhow::ensure!(c.source(&source_id)?.sha256==expected && c.source_path(&source_id)?==path,"Source changed during verification");
            Ok(json!({"verified":true,"method":"full-sha256-reread","verified_at":crate::case::now()}))
        });
    }
    if action=="backup" {
        let destination=PathBuf::from(text(&args,"path")?);
        let (case_id,plan)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let c=guard.as_mut().context("Open a case first")?;
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before backup");
            (c.meta("id")?.unwrap_or_default(),backup::prepare_backup_deferred(c,&destination,text(&args,"password")?)?)
        };
        // Archive hashing, tarring and encryption run without the case lock so chat,
        // viewing and cancellation stay responsive during a large backup.
        let mut plan=plan;
        backup::verify_backup_plan(&mut plan)?;
        backup::write_archive(&plan,&destination,text(&args,"password")?)?;
        let value=with_case(app,&case_id,|c|backup::finish_backup(c,&plan));
        let _=app.emit("case-changed",());
        return value;
    }
    if action=="export_dossier_bundle" {
        let destination=PathBuf::from(text(&args,"path")?);
        let (case_id,plan)={
            let state=app.state::<AppState>();
            let mut guard=state.case.lock().unwrap_or_else(|e|e.into_inner());
            let c=guard.as_mut().context("Open a case first")?;
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before reviewed package export");
            (c.meta("id")?.unwrap_or_default(),crate::exports::prepare_dossier_bundle(c,text(&args,"task_id")?,&destination)?)
        };
        // Copying cited originals into the package runs without the case lock.
        let staged=crate::exports::write_dossier_bundle(&plan,&destination);
        let value=with_case(app,&case_id,|c|crate::exports::publish_dossier_bundle(c,&plan,staged,&destination));
        let _=app.emit("case-changed",());
        return value;
    }
    if action=="export_redaction" {
        let (case_id,plan)={let state=app.state::<AppState>();let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before redaction export");(case.meta("id")?.unwrap_or_default(),crate::exports::prepare_redaction_export(case,text(&args,"artifact_id")?,Path::new(text(&args,"path")?))?)};
        let staged=crate::exports::stage_redaction_export(&plan)?;
        let result=with_case(app,&case_id,|case|crate::exports::publish_staged_redaction_export(case,&plan,staged));
        let _=app.emit("case-changed",());return result;
    }

    let state = app.state::<AppState>();

    let mut guard = state.case.lock().unwrap_or_else(|e|e.into_inner());

    if action == "delete_case" {
        let target = PathBuf::from(text(&args, "path")?);
        // Only the open case itself needs a quiet case and an early close, which
        // releases the exclusive lock before removal; any other case is untouched.
        let resolved = target.canonicalize().ok();
        if let Some(c) = guard.as_ref() {
            if resolved.as_deref() == Some(c.root.as_path()) {
                anyhow::ensure!(!state.importing.load(std::sync::atomic::Ordering::SeqCst),"Wait for the current import before deleting this case");
                let running: i64 = c.db.query_row(

                    "SELECT (SELECT count(*) FROM tasks WHERE status='running')+(SELECT count(*) FROM processing_jobs WHERE status='running')",

                    [],

                    |r| r.get(0),

                )?;
                anyhow::ensure!(running == 0,"Stop active tasks and processing jobs before deleting this case");
                let old_root=c.root.clone();
                *guard = None;
                crate::processing::invalidate_case_leases(&old_root);
            }
        }
        let receipt = crate::case::delete_case(&target, text(&args, "confirm")?)?;
        let _ = app.emit("case-changed", ());
        return Ok(receipt);
    }

    if ["create_case", "open_case", "restore_case", "close_case"].contains(&action) {
        anyhow::ensure!(!state.importing.load(std::sync::atomic::Ordering::SeqCst),"Wait for the current import before switching cases");

        if let Some(c) = guard.as_ref() {

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
            drop(guard);
            if let Some(root)=old_root {crate::processing::invalidate_case_leases(&root);}

            return Ok(Value::Null);

        }

        let path = PathBuf::from(text(&args, "path")?);

        let mut c = match action {

            // App defaults initialize new cases only. Opening or restoring an
            // existing case never changes its durable AI/cloud permissions.
            "create_case" => {
                let mut created = Case::create(&path, text(&args, "name")?)?;
                apply_ai_defaults(app, &mut created)?;
                created
            }

            "restore_case" => backup::restore(

                Path::new(text(&args, "archive")?),

                &path,

                text(&args, "password")?,

            )?,

            _ => Case::open(&path)?,

        };

        crate::automatic::enqueue(&mut c)?;
        let case_id=c.meta("id")?.unwrap_or_default();
        let snapshot = c.snapshot()?;

        let old_root=guard.as_ref().map(|case|case.root.clone());
        *guard = Some(c);
        drop(guard);
        if let Some(root)=old_root {crate::processing::invalidate_case_leases(&root);}
        kick_automatic(app.clone(),case_id.clone());
        kick_transcriptions(app.clone(),case_id);
        return Ok(snapshot);

    }

    if action == "snapshot" && guard.is_none() {

        return Ok(Value::Null);

    }

    let c = guard

        .as_mut()

        .ok_or_else(|| anyhow::anyhow!("Open a case first"))?;

    let result = match action {

        "snapshot" => c.snapshot()?,
        "case_summary" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before summary");
            c.case_summary()?
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
        "save_speaker_annotations" => crate::speaker_annotations::save(c,text(&args,"source_id")?,text(&args,"artifact_id")?,args["revision"].as_u64().context("Missing annotation revision")?,&args["labels"],&args["turns"])?,
        "video_discovery_status" => crate::discovery::status(c,text(&args,"source_id")?)?,
        "browse_video_discovery" => crate::discovery::browse(c,text(&args,"source_id")?,args["kind"].as_str().unwrap_or("video_overview"),args["start"].as_f64().unwrap_or(0.),args["end"].as_f64().unwrap_or(1e12),args["offset"].as_u64().unwrap_or(0),args["query"].as_str().unwrap_or(""))?,
        "queue_video_discovery" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before video discovery queue");let value=crate::discovery::enqueue(c,text(&args,"source_id")?,args["interval"].as_f64().unwrap_or(5.),true)?;kick_discovery(app.clone(),c.meta("id")?.unwrap_or_default());value},
        "retry_video_discovery" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before video discovery retry");let value=crate::discovery::retry_run(c,text(&args,"run_id")?)?;kick_discovery(app.clone(),c.meta("id")?.unwrap_or_default());value},
        "cancel_video_discovery" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before video discovery cancel");crate::discovery::cancel(c,text(&args,"source_id")?)?},
        "cancel_processing" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before processing cancellation");crate::processing::cancel(c,text(&args,"job_id")?)?;Value::Null},
        "storage_usage" => c.storage_usage()?,
        "reclaim_staging" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before staging cleanup");anyhow::ensure!(!state.importing.load(std::sync::atomic::Ordering::SeqCst),"Wait for the import before reclaiming staging");c.reclaim_staging()?},

        "rename" => { c.rename(text(&args,"kind")?, args["id"].as_str().unwrap_or(""), text(&args,"name")?)?; Value::Null },

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

        "set_asr_profile" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before speech profile update");let model=text(&args,"model")?;anyhow::ensure!(["tiny","small"].contains(&model),"Unsupported local speech model");let worker=crate::processing::worker_path()?;anyhow::ensure!(worker.parent().context("Missing worker folder")?.join("_internal/models").join(model).join("model.bin").is_file(),"This speech model is not installed in the packaged worker");c.set_meta("asr_profile",model)?;c.audit("asr_profile_selected",json!({"model":model}))?;Value::Null},
        "transcribe_full" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription");
            let job = crate::transcription::begin(c, text(&args, "source_id")?)?;

            let job_id = job.id.clone();

            let case_id = c.meta("id")?.unwrap_or_default();

            let handle = app.clone();

            tauri::async_runtime::spawn_blocking(move || {

                let result = crate::transcription::run(&job).and_then(|value| crate::transcription::stage_transcript(&job,value)).and_then(|staged| {

                    with_case(&handle, &case_id, |case| {

                        crate::transcription::publish_staged_transcript(case, &job, staged)

                    })

                });

                if let Err(error) = result {

                    let _ = with_case(&handle, &case_id, |case| {

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

                let _ = handle.emit("case-changed", ());

                kick_transcriptions(handle, case_id);

            });

            json!({"job_id":job_id})

        }

        "transcribe_all" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription queue");

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
            crate::transcription::save_correction(c,text(&args,"source_id")?,text(&args,"run_id")?,args["ordinal"].as_i64().context("Missing segment ordinal")?,text(&args,"text")?,text(&args,"reason")?)?
        },
        "review_transcript_correction" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcript review");
            crate::transcription::review_correction(c,text(&args,"correction_id")?,args["accept"].as_bool().context("Missing review decision")?)?
        },

        "cancel_transcription" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before transcription cancellation");
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

            c.set_restricted(

                text(&args, "source_id")?,

                args["restricted"].as_bool().unwrap_or(true),

            )?;

            Value::Null

        }

        "write_record" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working record update");serde_json::to_value(c.write_record(

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
            c.review_record(

                text(&args, "record_id")?,

                args["revision"].as_i64().unwrap_or(0),

                args["protected"].as_bool(),

            )?;

            Value::Null

        }

        "revisions" => c.revisions(text(&args, "record_id")?)?,

        "rollback" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before working record rollback");serde_json::to_value(c.rollback(

            text(&args, "record_id")?,

            args["target"].as_i64().unwrap_or(0),

            args["base_revision"].as_i64().unwrap_or(0),

        )?)?},

        "evidence_list" => crate::evidence::list(c,args["source_id"].as_str(),args["kind"].as_str(),args["offset"].as_u64().unwrap_or(0) as usize)?,
        "evidence_read" => crate::evidence::read(c,text(&args,"id")?,args["revision"].as_i64())?,
        "evidence_write" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before finding update");crate::evidence::write(c,serde_json::from_value(args["object"].clone())?,"human")?},
        "evidence_review" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before finding review");crate::evidence::review(c,text(&args,"id")?,args["revision"].as_i64().context("Missing revision")?,text(&args,"review")?)?;Value::Null},
        "evidence_search" => crate::evidence::search(c,text(&args,"query")?,args["offset"].as_u64().unwrap_or(0) as usize)?,
        "fit_clock" => crate::evidence::fit_clock(&serde_json::from_value::<Vec<crate::evidence::Anchor>>(args["anchors"].clone())?)?,
        "team_status" => crate::teams::status(c,text(&args,"task_id")?)?,
        "investigation_workbench" => crate::workbench::view(c,args["offset"].as_u64().unwrap_or(0))?,
        "incident_replay" => crate::workbench::replay(c,&serde_json::from_value::<Vec<String>>(args["clock_ids"].clone())?)?,
        "coverage_map" => crate::workbench::coverage_map(c,args["offset"].as_u64().unwrap_or(0))?,
        "processing_recovery" => crate::processing::recovery_inventory(c)?,
        "read_coverage" => crate::coverage::view(c,text(&args,"task_id")?)?,
        "read_dossier" => crate::dossier::view(c,text(&args,"task_id")?)?,
        "review_dossier_claim" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before claim review");crate::dossier::human_review(c,text(&args,"task_id")?,args["revision"].as_u64().context("Missing dossier revision")?,usize::try_from(args["claim_index"].as_u64().context("Missing claim index")?)?,text(&args,"decision")?,text(&args,"note")?)?},
        "save_ai_settings" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before settings update");
            crate::automatic::preempt_for_chat(c)?;
            c.db.execute_batch("SAVEPOINT ai_settings")?;
            let result=(||->anyhow::Result<()> {
                crate::providers::apply_app_settings(c,&args)?;
                let directory=app.path().app_config_dir()?;std::fs::create_dir_all(&directory)?;
                let defaults=json!({"config":crate::providers::load(c)?,"settings":c.settings()?,"consent_version":crate::providers::AI_DEFAULTS_CONSENT_VERSION});
                let mut staged=tempfile::NamedTempFile::new_in(&directory)?;
                std::io::Write::write_all(&mut staged,&serde_json::to_vec(&defaults)?)?;
                staged.as_file().sync_all()?;
                staged.persist(directory.join("ai-defaults.json"))?;
                Ok(())
            })();
            if let Err(e)=result {c.db.execute_batch("ROLLBACK TO ai_settings; RELEASE ai_settings")?;return Err(e)}
            c.db.execute_batch("RELEASE ai_settings")?;
            Value::Null
        },
        "direct_media_permission" => json!({"enabled":crate::providers::direct_media_enabled(c)}),
        "set_direct_media_permission" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before media permission update");let enabled=args["enabled"].as_bool().context("Missing permission")?;crate::providers::set_direct_media(c,enabled)?;Value::Null},
        "ai_config" => serde_json::to_value(crate::providers::load(c)?)?,
        "save_ai_config" => {crate::providers::save(c,serde_json::from_value(args["config"].clone())?)?;Value::Null},
        "save_settings" => {

            c.save_settings(serde_json::from_value::<Settings>(

                args["settings"].clone(),

            )?)?;

            Value::Null

        }

        "review_redaction" => {anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before redaction review");crate::exports::review_redaction(c,text(&args,"artifact_id")?,&serde_json::from_value::<Vec<u64>>(args["pages"].clone())?,text(&args,"note")?)?},
        "export_redaction" => crate::exports::export_redaction(c,text(&args,"artifact_id")?,Path::new(text(&args,"path")?))?,
        "export_record" => {

            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before export");
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
            c.delete_conversation(text(&args,"conversation_id")?,args["deleted"].as_bool().unwrap_or(true))?;

            Value::Null

        }

        "start_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat started");
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}

            let selected = if let (Some(provider), Some(model)) = (args.get("provider"), args["model"].as_str()) {
                crate::providers::select_profile(c, serde_json::from_value(provider.clone())?, model)?
            } else { crate::providers::task_profile(c, "")? };
            crate::providers::check_permission(c, &selected)?;
            if !agent::is_file_count_question(text(&args,"prompt")?) {
            provider_key_entry(selected.provider)?

                .get_password()

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
                let _=app.emit("case-changed",());
                return Ok(json!({"task_id":task,"conversation_id":conversation}));
            }
            let case_id = c.meta("id")?.unwrap_or_default();

            let handle = app.clone();

            let tid = task.clone();

            tauri::async_runtime::spawn(async move {

                run_agent(handle, case_id, tid).await;

            });

            json!({"task_id":task,"conversation_id":conversation})

        }

        "stop_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat stopped");

            agent::pause(c, text(&args, "task_id")?, "Stopped by user")?;

            Value::Null

        }

        "resume_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat resumed");
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}

            let task = text(&args, "task_id")?.to_string();

            agent::resume(c, &task)?;

            let case_id = c.meta("id")?.unwrap_or_default();

            let handle = app.clone();

            let tid = task.clone();

            tauri::async_runtime::spawn(async move {

                run_agent(handle, case_id, tid).await;

            });

            json!({"task_id":task})

        }

        "continue_paused_task" => {
            anyhow::ensure!(c.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before chat continued");
            if let Some(reason)=crate::automatic::chat_pause_reason(c)? {anyhow::bail!("{reason}");}
            let old=text(&args,"task_id")?;
            let profile=crate::providers::task_profile(c,old)?;
            provider_key_entry(profile.provider)?.get_password().map_err(|_|anyhow::anyhow!("Save an API key in Settings first"))?;
            let (task,conversation)=agent::continue_paused(c,old)?;
            let case_id=c.meta("id")?.unwrap_or_default();
            let handle=app.clone();let tid=task.clone();
            tauri::async_runtime::spawn(async move {run_agent(handle,case_id,tid).await;});
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

        let _ = app.emit("case-changed", ());

    }

    Ok(result)

}



fn with_case<T>(

    app: &tauri::AppHandle,

    case_id: &str,

    f: impl FnOnce(&mut Case) -> anyhow::Result<T>,

) -> anyhow::Result<T> {

    let state = app.state::<AppState>();

    let mut lock = state.case.lock().unwrap_or_else(|e|e.into_inner());

    let c = lock

        .as_mut()

        .ok_or_else(|| anyhow::anyhow!("Case closed"))?;

    anyhow::ensure!(c.meta("id")?.as_deref() == Some(case_id), "Case changed");

    f(c)

}

async fn cancelled(app: &tauri::AppHandle, case_id: &str, task: &str) {

    loop {

        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let active = with_case(app, case_id, |c| {

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

    tauri::async_runtime::spawn_blocking(move || loop {

        let job = match with_case(&app, &case_id, crate::transcription::next) {

            Ok(Some(job)) => job,

            _ => {kick_automatic(app.clone(),case_id.clone());break},

        };

        let result = crate::transcription::run(&job).and_then(|value| crate::transcription::stage_transcript(&job,value)).and_then(|staged| {

            with_case(&app, &case_id, |case| {

                crate::transcription::publish_staged_transcript(case, &job, staged)

            })

        });

        if let Err(error) = result {

            let _ = with_case(&app, &case_id, |case| {

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

        let _ = app.emit("case-changed", ());

    });

}

async fn run_agent(app: tauri::AppHandle, case_id: String, task: String) {
    run_session(app.clone(),case_id.clone(),task,true).await;
    kick_automatic(app,case_id);
}
async fn run_team_phase(app:&tauri::AppHandle,case_id:&str,parent:&str,phase:&str)->anyhow::Result<()> {
    let children=with_case(app,case_id,|c|crate::teams::prepare(c,parent,phase))?;
    let mut runs=tokio::task::JoinSet::new();
    for child in children {
        let handle=app.clone();let cid=case_id.to_string();
        runs.spawn(async move {run_session(handle,cid,child,false).await;});
    }
    while let Some(result)=runs.join_next().await {result?;}
    with_case(app,case_id,|c|crate::teams::merge(c,parent,phase))?;
    Ok(())
}
fn run_session(app:tauri::AppHandle,case_id:String,task:String,coordinator:bool)->std::pin::Pin<Box<dyn std::future::Future<Output=()>+Send>> {
    Box::pin(async move {

    let result=async {




        if coordinator {run_team_phase(&app,&case_id,&task,"investigate").await?;}
        loop {
            if coordinator {
                let pending=with_case(&app,&case_id,|c|c.meta(&format!("team_pending:{task}")))?;
                if let Some(phase)=pending {run_team_phase(&app,&case_id,&task,&phase).await?;}
                run_team_phase(&app,&case_id,&task,"review").await?;
            }
            let provider=with_case(&app,&case_id,|c|Ok(crate::providers::task_profile(c,&task)?.provider))?;
            let key=provider_key_entry(provider)?.get_password()?;
            let prepared=with_case(&app,&case_id,|c|agent::prepare_request(c,&task))?;
            anyhow::ensure!(prepared.provider==provider,"Provider changed before dispatch");

            let _=app.emit("case-changed",());

            let response=tokio::select! {

                result=crate::providers::send(prepared.provider,&key,prepared.body,|delta|{let _=app.emit("agent-progress",json!({"case_id":case_id,"task_id":task,"transmission_id":prepared.transmission,"delta":delta}));})=>result,

                _=cancelled(&app,&case_id,&task)=>Err(anyhow::anyhow!("Request cancelled; transmission may have occurred")),

            };

            match response {

                Ok(value)=>{
                    // Authorization and registration hold the lock briefly; worker decoding does not.
                    let registered=with_case(&app,&case_id,|c|agent::prepare_media(c,&task,&prepared.transmission,&value));
                    let (jobs,preparation_error)=match registered {Ok(j)=>(j,None),Err(e)=>(vec![],Some(e.to_string()))};
                    let job_ids=jobs.iter().map(|j|j.job_id.clone()).collect::<Vec<_>>();
                    let mut media=tauri::async_runtime::spawn_blocking(move || agent::PreparedMedia{jobs:jobs.into_iter().map(|job|{let staged=crate::processing::stage_prepared(&job,crate::processing::run_prepared(&job));(job,staged)}).collect(),cleanup:vec![],external:true,error:preparation_error}).await?;
                    let semantic=with_case(&app,&case_id,|c|{c.set_meta(&format!("semantic_result:{task}"),"")?;agent::prepare_semantic(c,&task,&prepared.transmission,&value)});
                    if let Ok(Some(job))=semantic {
                        let (job,output)=tauri::async_runtime::spawn_blocking(move || {let output=crate::semantic::run(&job);(job,output)}).await?;
                        with_case(&app,&case_id,|c|{
                            let query:Value=serde_json::from_str(value["output"].as_array().unwrap().iter().find(|v|v["name"]=="search_semantic").unwrap()["arguments"].as_str().unwrap())?;
                            let result=output.and_then(|v|crate::semantic::publish(c,&job,v));
                            let stored=match result {Ok(v)=>json!({"query":query["query"],"result":v}),Err(e)=>json!({"query":query["query"],"error":e.to_string()})};
                            c.set_meta(&format!("semantic_result:{task}"),&stored.to_string())?;Ok(())
                        })?;
                    }
                    let handled=with_case(&app,&case_id,|c|agent::receive_prepared(c,&task,&prepared.transmission,value,&mut media));
                    for job in &media.cleanup {let _=crate::processing::cleanup_published_input(job);}
                    with_case(&app,&case_id,|c|{for job in &job_ids {c.db.execute("UPDATE processing_jobs SET status='failed',error='Tool did not publish; inspect the task receipt or retry' WHERE id=? AND status='running'",[job])?;}Ok(())})?;
                    let more=handled?;kick_transcriptions(app.clone(),case_id.clone());let _=app.emit("case-changed",());if !more{break;}
                },

                Err(error)=>{with_case(&app,&case_id,|c|{c.db.execute("UPDATE transmissions SET status='uncertain' WHERE id=?",[&prepared.transmission])?;Ok(())})?;return Err(error);}

            }

        } Ok::<(),anyhow::Error>(())

    }.await;

    if let Err(e) = result {

        let _ = with_case(&app, &case_id, |c| agent::pause(c, &task, &e.to_string()));

    }

    let _ = app.emit("case-changed", ());

    })
}


pub fn run() {

    tauri::Builder::default()

        .plugin(tauri_plugin_dialog::init())

        .manage(AppState {

            case: Mutex::new(None),
            importing: std::sync::atomic::AtomicBool::new(false),
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


fn apply_ai_defaults(app:&tauri::AppHandle,case:&mut Case)->anyhow::Result<()> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {return Ok(());}
    let path=app.path().app_config_dir()?.join("ai-defaults.json");
    if path.is_file() {
        // Only defaults saved by the consent-aware flow initialize a new case.
        // Older forced files are ignored: the case starts local (offline, no
        // grants) until the user re-consents in Settings. A corrupt or invalid
        // defaults file is likewise ignored — it can never block case creation
        // or smuggle in a broader policy through an error path.
        if let Ok(value)=serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap_or_default()) {
            match crate::providers::parse_ai_defaults(&value) {
                Ok(Some((config,settings)))=>{crate::providers::apply_app_settings(case,&json!({"config":config,"settings":settings}))?;}
                Ok(None)=>{}
                Err(error)=>eprintln!("Ignoring unusable ai-defaults.json: {error}"),
            }
        }
    }
    Ok(())
}
fn kick_discovery(app:tauri::AppHandle,case_id:String) {
    static ACTIVE:std::sync::OnceLock<Mutex<std::collections::HashSet<String>>>=std::sync::OnceLock::new();
    let active=ACTIVE.get_or_init(||Mutex::new(std::collections::HashSet::new()));
    if !active.lock().unwrap_or_else(|e|e.into_inner()).insert(case_id.clone()) {return;}
    struct Lease {active:&'static Mutex<std::collections::HashSet<String>>,id:String}
    impl Drop for Lease {fn drop(&mut self){self.active.lock().unwrap_or_else(|e|e.into_inner()).remove(&self.id);}}
    let lease=Lease{active,id:case_id.clone()};
    tauri::async_runtime::spawn_blocking(move || {
        let _lease=lease;
        // One lane can run OCR while the other runs overview. discovery::next
        // claims distinct kinds under the case lock, and the worker's memory
        // gate still serializes OCR and refuses unsafe overlap.
        std::thread::scope(|scope| {
            for _ in 0..2 {
                let app=app.clone();let case_id=case_id.clone();
                scope.spawn(move || run_discovery_lane(&app,&case_id));
            }
        });
        let task=with_case(&app,&case_id,|c| {
            let provider=crate::providers::load(c)?.provider;
            if provider_key_entry(provider)?.get_password().is_err(){return Ok(None);}
            crate::automatic::start_review(c)
        });
        if let Ok(Some(task))=task {
            let _=app.emit("case-changed",());
            tauri::async_runtime::spawn(async move {run_agent(app,case_id,task).await;});
        }
    });
}
fn run_discovery_lane(app:&tauri::AppHandle,case_id:&str) {
    loop {
        let job=match with_case(app,case_id,crate::discovery::next) {
            Ok(Some(job))=>job,
            Ok(None)=>{let pending=with_case(app,case_id,|c|Ok(c.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs j JOIN sources s ON s.id=j.source_id WHERE s.restricted=0 AND j.status='queued' AND j.kind IN ('video_ocr_index','video_overview_index'))",[],|r|r.get::<_,bool>(0))?)).unwrap_or(false);if pending {std::thread::sleep(std::time::Duration::from_millis(500));continue;}break;},
            Err(_)=>break
        };
        let staged=crate::processing::stage_prepared(&job.processor,crate::processing::run_prepared(&job.processor));
        let published=with_case(app,case_id,|c|{crate::discovery::publish_staged(c,&job,staged)?;Ok(c.db.query_row("SELECT status='complete' FROM processing_jobs WHERE id=?",[&job.processor.job_id],|r|r.get::<_,bool>(0))?) });
        if matches!(published,Ok(true)){let _=crate::processing::cleanup_published_input(&job.processor);}
        let _=app.emit("case-changed",());
    }
}
fn kick_automatic(app:tauri::AppHandle,case_id:String) {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {return;}
    kick_semantic(app.clone(),case_id.clone());
    kick_discovery(app.clone(),case_id.clone());
    for _ in 0..2 {
        let app=app.clone();let case_id=case_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            loop {
                let job=match with_case(&app,&case_id,crate::automatic::next) {Ok(Some(job))=>job,_=>break};
                let staged=crate::processing::stage_prepared(&job.processor,crate::processing::run_prepared(&job.processor));
                let published=with_case(&app,&case_id,|c|{crate::automatic::publish_staged(c,&job,staged)?;Ok(c.db.query_row("SELECT status='complete' FROM processing_jobs WHERE id=?",[&job.processor.job_id],|r|r.get::<_,bool>(0))?) });
                if matches!(published,Ok(true)){let _=crate::processing::cleanup_published_input(&job.processor);kick_semantic(app.clone(),case_id.clone());}
                let _=app.emit("case-changed",());
                let task=with_case(&app,&case_id,|c| {let provider=crate::providers::load(c)?.provider;if provider_key_entry(provider)?.get_password().is_err(){return Ok(None);}crate::automatic::start_review(c)});
                if let Ok(Some(task))=task {let app=app.clone();let case_id=case_id.clone();tauri::async_runtime::spawn(async move {run_agent(app,case_id,task).await;});}
            }
            let task=with_case(&app,&case_id,|c| {
                let provider=crate::providers::load(c)?.provider;
                if provider_key_entry(provider)?.get_password().is_err(){return Ok(None);}
                crate::automatic::start_review(c)
            });
            if let Ok(Some(task))=task {
                let _=app.emit("case-changed",());
                tauri::async_runtime::spawn(async move {run_agent(app,case_id,task).await;});
            }
        });
    }
}
fn kick_semantic(app:tauri::AppHandle,case_id:String) {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {return;}
    let state=app.state::<AppState>();
    {
        let mut active=state.semantic_indexing.lock().unwrap_or_else(|e|e.into_inner());
        if let Some(dirty)=active.get_mut(&case_id){*dirty=true;return;}
        active.insert(case_id.clone(),false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        struct Registration {app:tauri::AppHandle,case_id:String}
        impl Drop for Registration {fn drop(&mut self){let state=self.app.state::<AppState>();state.semantic_indexing.lock().unwrap_or_else(|e|e.into_inner()).remove(&self.case_id);}}
        let _registration=Registration{app:app.clone(),case_id:case_id.clone()};
        loop {
            let prepared=with_case(&app,&case_id,|case|{
                let scope=case.sources()?.into_iter().filter(|source|!source.restricted).map(|source|source.id).collect();
                crate::semantic::prepare_background(case,scope)
            });
            let job=match prepared {
                Ok(Some(job))=>job,
                Ok(None)=>{
                    let state=app.state::<AppState>();let mut active=state.semantic_indexing.lock().unwrap_or_else(|e|e.into_inner());
                    if let Some(dirty)=active.get_mut(&case_id) {if *dirty {*dirty=false;continue;}}
                    active.remove(&case_id);break;
                },
                Err(_)=>break
            };
            let output=crate::semantic::run(&job);
            let published=with_case(&app,&case_id,|case|crate::semantic::publish_index(case,&job,&output?));
            if let Err(error)=published {
                let _=with_case(&app,&case_id,|case|{case.audit("semantic_index_paused",json!({"reason":error.to_string().chars().take(300).collect::<String>()}))?;Ok(())});
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
    let (root,case_id)={let guard=state.case.lock().unwrap_or_else(|e|e.into_inner());let case=guard.as_ref().context("Open a case first")?;anyhow::ensure!(case.meta("id")?.as_deref()==Some(text(&args,"case_id")?),"Case changed before import");(case.root.clone(),case.meta("id")?.unwrap_or_default())};
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
        items.push(item);let _=app.emit("case-changed",());
    }
    with_case(app,&case_id,|c|{c.audit("import_batch",json!({"batch":batch,"items":items}))?;crate::automatic::enqueue(c)})?;
    kick_automatic(app.clone(),case_id.clone());kick_transcriptions(app.clone(),case_id);
    let _=app.emit("case-changed",());
    Ok(json!({"batch":batch,"items":items,"skipped":skipped}))
}
