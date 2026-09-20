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

}

fn text<'a>(v: &'a Value, k: &str) -> anyhow::Result<&'a str> {

    v[k].as_str().ok_or_else(|| anyhow::anyhow!("Missing {k}"))

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

    if ["save_provider_key","provider_key_status","delete_provider_key"].contains(&action) {
        let provider:crate::providers::Provider=serde_json::from_value(args["provider"].clone())?;
        let entry=provider_key_entry(provider)?;
        return match action {
            "save_provider_key"=>{let key=text(&args,"key")?;anyhow::ensure!(!key.trim().is_empty(),"Enter a key");entry.set_password(key.trim())?;Ok(json!({"saved":true}))},
            "delete_provider_key"=>{entry.delete_credential()?;Ok(json!({"deleted":true}))},
            _=>Ok(json!({"configured":entry.get_password().is_ok()}))
        };
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

            let mut guard=state.case.lock().map_err(|_|anyhow::anyhow!("Case lock failed"))?;

            let c=guard.as_mut().ok_or_else(||anyhow::anyhow!("Open a case first"))?;

            let source=text(&args,"source_id")?;

            let cached:Option<String>=c.db.query_row("SELECT id FROM artifacts WHERE source_id=? AND mime='video/mp4' ORDER BY created_at DESC LIMIT 1",[source],|r|r.get(0)).optional()?;

            if let Some(id)=cached {crate::processing::artifact(c,&id)?;return Ok(json!({"artifact_id":id}));}

            let running:i64=c.db.query_row("SELECT count(*) FROM processing_jobs WHERE source_id=? AND kind='playback' AND status='running'",[source],|r|r.get(0))?;

            anyhow::ensure!(running==0,"Playback is already being prepared. Reopen this source after conversion finishes.");

            crate::processing::prepare_playback(c,source)?

        };

        let result=crate::processing::run_playback(&job);

        let mut guard=state.case.lock().map_err(|_|anyhow::anyhow!("Case lock failed"))?;

        let c=guard.as_mut().ok_or_else(||anyhow::anyhow!("Case closed during playback processing"))?;

        anyhow::ensure!(c.meta("id")?.unwrap_or_default()==job.case_id,"Case changed during playback processing");

        let result=crate::processing::publish_playback(c,&job,result);

        let _=app.emit("case-changed",());

        return result;

    }

    let state = app.state::<AppState>();

    let mut guard = state

        .case

        .lock()

        .map_err(|_| anyhow::anyhow!("Case lock failed"))?;

    if ["create_case", "open_case", "restore_case", "close_case"].contains(&action) {

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

            *guard = None;

            return Ok(Value::Null);

        }

        let path = PathBuf::from(text(&args, "path")?);

        let c = match action {

            "create_case" => Case::create(&path, text(&args, "name")?)?,

            "restore_case" => backup::restore(

                Path::new(text(&args, "archive")?),

                &path,

                text(&args, "password")?,

            )?,

            _ => Case::open(&path)?,

        };

        let snapshot = c.snapshot()?;

        *guard = Some(c);

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
        "storage_usage" => c.storage_usage()?,
        "reclaim_staging" => c.reclaim_staging()?,

        "import_files" => c.import_files(

            &serde_json::from_value::<Vec<String>>(args["paths"].clone())?,

            args["production"].as_str().unwrap_or("Unassigned"),

        )?,

        "import_folder" => c.import_folder(Path::new(text(&args, "path")?), args["production"].as_str().unwrap_or("Folder import"))?,

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

        "process_source" => crate::processing::process(c, text(&args, "source_id")?, None)?,

        "transcribe_full" => {

            let job = crate::transcription::begin(c, text(&args, "source_id")?)?;

            let job_id = job.id.clone();

            let case_id = c.meta("id")?.unwrap_or_default();

            let handle = app.clone();

            tauri::async_runtime::spawn_blocking(move || {

                let result = crate::transcription::run(&job).and_then(|value| {

                    with_case(&handle, &case_id, |case| {

                        crate::transcription::publish(case, &job, value)

                    })

                });

                if let Err(error) = result {

                    let _ = with_case(&handle, &case_id, |case| {

                        crate::transcription::fail(case, &job, &error.to_string())

                    });

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

        "cancel_transcription" => {

            crate::transcription::cancel(c, text(&args, "source_id")?)?;

            Value::Null

        }

        "render_page" => crate::processing::process_request(

            c,

            text(&args, "source_id")?,

            json!({"operation":"render_page","page":args["page"]}),

        )?,

        "transcribe_source" => crate::processing::process_request(

            c,

            text(&args, "source_id")?,

            json!({"operation":"transcribe","start":args["start"].as_f64().unwrap_or(0.0),"end":args["end"].as_f64().unwrap_or(30.0),"track":args["track"]}),

        )?,

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

        "verify_source" => {

            c.verify_source(text(&args, "source_id")?)?;

            json!({"verified":true})

        }

        "write_record" => serde_json::to_value(c.write_record(

            args["record_id"].as_str(),

            args["base_revision"].as_i64().unwrap_or(0),

            text(&args, "title")?,

            text(&args, "kind")?,

            text(&args, "content")?,

            "human",

            args["reason"].as_str().unwrap_or("Manual edit"),

            None,

            serde_json::from_value(args["source_ids"].clone()).unwrap_or_default(),

        )?)?,

        "review_record" => {

            c.review_record(

                text(&args, "record_id")?,

                args["revision"].as_i64().unwrap_or(0),

                args["protected"].as_bool(),

            )?;

            Value::Null

        }

        "revisions" => c.revisions(text(&args, "record_id")?)?,

        "rollback" => serde_json::to_value(c.rollback(

            text(&args, "record_id")?,

            args["target"].as_i64().unwrap_or(0),

            args["base_revision"].as_i64().unwrap_or(0),

        )?)?,

        "evidence_list" => crate::evidence::list(c,args["source_id"].as_str(),args["kind"].as_str(),args["offset"].as_u64().unwrap_or(0) as usize)?,
        "evidence_read" => crate::evidence::read(c,text(&args,"id")?,args["revision"].as_i64())?,
        "evidence_write" => crate::evidence::write(c,serde_json::from_value(args["object"].clone())?,"human")?,
        "evidence_review" => {crate::evidence::review(c,text(&args,"id")?,args["revision"].as_i64().context("Missing revision")?,text(&args,"review")?)?;Value::Null},
        "evidence_search" => crate::evidence::search(c,text(&args,"query")?,args["offset"].as_u64().unwrap_or(0) as usize)?,
        "scan_sound_events" => {
            let sid=text(&args,"source_id")?;
            anyhow::ensure!(!c.source(sid)?.restricted,"Restricted source");
            crate::processing::process_request(c,sid,json!({"operation":"sound_events","start":args["start"],"end":args["end"],"track":args["track"],"channel":args["channel"]}))?
        },
        "fit_clock" => crate::evidence::fit_clock(&serde_json::from_value::<Vec<crate::evidence::Anchor>>(args["anchors"].clone())?)?,
        "team_status" => crate::teams::status(c,text(&args,"task_id")?)?,
        "save_ai_settings" => {
            let config:crate::providers::Config=serde_json::from_value(args["config"].clone())?;
            let settings:Settings=serde_json::from_value(args["settings"].clone())?;
            if !settings.model.is_empty() || (!settings.offline && settings.allow_text) {crate::providers::validate_model(&settings.model)?;}
            c.db.execute_batch("SAVEPOINT ai_settings")?;
            let result=(||->anyhow::Result<()> {if serde_json::to_value(&config)?!=serde_json::to_value(crate::providers::load(c)?)? {crate::providers::save(c,config)?;}c.save_settings(settings)?;Ok(())})();
            if let Err(e)=result {c.db.execute_batch("ROLLBACK TO ai_settings; RELEASE ai_settings")?;return Err(e)}
            c.db.execute_batch("RELEASE ai_settings")?;Value::Null
        },
        "ai_config" => serde_json::to_value(crate::providers::load(c)?)?,
        "save_ai_config" => {crate::providers::save(c,serde_json::from_value(args["config"].clone())?)?;Value::Null},
        "save_settings" => {

            c.save_settings(serde_json::from_value::<Settings>(

                args["settings"].clone(),

            )?)?;

            Value::Null

        }

        "backup" => {

            backup::backup(c, Path::new(text(&args, "path")?), text(&args, "password")?)?;

            json!({"saved":true})

        }

        "export_record" => {

            c.export_record(text(&args, "record_id")?, Path::new(text(&args, "path")?))?;

            json!({"saved":true})

        }

        "validate_citation" => c.validate_citation(text(&args, "citation")?)?,

        "actions" => c.actions(text(&args, "task_id")?)?,

        "delete_conversation" => {

            c.delete_conversation(text(&args,"conversation_id")?,args["deleted"].as_bool().unwrap_or(true))?;

            Value::Null

        }

        "start_task" => {

            let selected = if let (Some(provider), Some(model)) = (args.get("provider"), args["model"].as_str()) {
                crate::providers::select_profile(c, serde_json::from_value(provider.clone())?, model)?
            } else { crate::providers::task_profile(c, "")? };
            crate::providers::check_permission(c, &selected)?;
            provider_key_entry(selected.provider)?

                .get_password()

                .map_err(|_| anyhow::anyhow!("Save an API key in Settings first"))?;

            let (source_ids, record_ids) = agent::case_scope(c)?;

            let task = agent::start(

                c,

                text(&args, "prompt")?,

                "investigate",

                source_ids,

                record_ids,

                args["budget"].as_f64().unwrap_or(1.0),

            )?;

            c.set_meta(&format!("task_profile:{task}"), &serde_json::to_string(&selected)?)?;
            let conversation = match agent::continue_conversation(c, &task, args["parent_task_id"].as_str()) {

                Ok(id)=>id,

                Err(e)=>{agent::pause(c,&task,"Conversation could not continue")?;return Err(e)}

            };

            if let Err(e)=agent::attach_viewer_context(c,&task,&args["viewer_context"]) {agent::pause(c,&task,"Open-file context could not be included")?;return Err(e);}

            let case_id = c.meta("id")?.unwrap_or_default();

            let handle = app.clone();

            let tid = task.clone();

            tauri::async_runtime::spawn(async move {

                run_agent(handle, case_id, tid).await;

            });

            json!({"task_id":task,"conversation_id":conversation})

        }

        "stop_task" => {

            agent::pause(c, text(&args, "task_id")?, "Stopped by user")?;

            Value::Null

        }

        "resume_task" => {

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

        _ => anyhow::bail!("Unknown application command"),

    };

    if ![

        "snapshot",
        "ai_config", "team_status", "evidence_list", "evidence_read", "evidence_search", "fit_clock", "read_conversation",

        "full_transcription_status",

        "artifact_info",

        "read_text",

        "search",

        "actions",

        "revisions",

        "processing_status",
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

    let mut lock = state

        .case

        .lock()

        .map_err(|_| anyhow::anyhow!("Case lock failed"))?;

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

            _ => break,

        };

        let result = crate::transcription::run(&job).and_then(|value| {

            with_case(&app, &case_id, |case| {

                crate::transcription::publish(case, &job, value)

            })

        });

        if let Err(error) = result {

            let _ = with_case(&app, &case_id, |case| {

                crate::transcription::fail(case, &job, &error.to_string())

            });

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
    run_session(app,case_id,task,true).await;
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

                _=cancelled(&app,&case_id,&task)=>Err(anyhow::anyhow!("Request cancelled; transmission may have occurred and its budget reservation is retained")),

            };

            match response {

                Ok(value)=>{let more=with_case(&app,&case_id,|c|agent::receive(c,&task,&prepared.transmission,value))?;kick_transcriptions(app.clone(),case_id.clone());let _=app.emit("case-changed",());if !more{break;}},

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

        })

        .invoke_handler(tauri::generate_handler![command])

        .register_uri_scheme_protocol("evidence", |ctx, request| {

            let build = || -> anyhow::Result<tauri::http::Response<Vec<u8>>> {

                let decoded =

                    percent_encoding::percent_decode_str(request.uri().path()).decode_utf8()?;

                let source_id = decoded.trim_start_matches('/');

                let state = ctx.app_handle().state::<AppState>();

                let guard = state

                    .case

                    .lock()

                    .map_err(|_| anyhow::anyhow!("Case unavailable"))?;

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

