use crate::case::{digest, file_hash, id, now, Case};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub fn worker_path() -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let installed = executable
        .parent()
        .context("Executable directory missing")?
        .join("resources/worker/evidence-worker/evidence-worker.exe");
    if installed.is_file() {
        return Ok(installed);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/worker/evidence-worker/evidence-worker.exe");
        if development.is_file() {
            return Ok(development);
        }
    }
    anyhow::bail!("Packaged processor is unavailable. Run scripts/build-worker.ps1 before building the desktop app.")
}
pub fn process(case: &mut Case, source_id: &str, crop: Option<[u32; 4]>) -> Result<Value> {
    process_request(case, source_id, json!({"crop":crop}))
}
pub fn process_request(case: &mut Case, source_id: &str, options: Value) -> Result<Value> {
    let job=prepare_request(case,source_id,options)?;
    let result=run_prepared(&job);
    publish_prepared(case,&job,result)
}
pub struct PreparedJob {
    pub job_id:String,
    pub source:crate::case::Source,
    pub source_path:PathBuf,
    pub kind:String,
    pub worker:PathBuf,
    pub staging:tempfile::TempDir,
    pub request:Value,
}
pub fn prepare_request(case:&mut Case,source_id:&str,options:Value)->Result<PreparedJob> {
    let source = case.source(source_id)?;
    ensure!(
        source.size
            <= if ["audio", "video"].contains(&source.kind.as_str()) {
                16 * 1024 * 1024 * 1024
            } else {
                250 * 1024 * 1024
            },
        "Media processing supports up to 16 GiB; document/image processing supports up to 250 MiB"
    );
    let ext = Path::new(&source.name)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let kind = if ["video","audio"].contains(&source.kind.as_str()) && options["operation"]=="automatic" { "media_inventory" } else if ["video","audio"].contains(&source.kind.as_str()) && options["operation"]=="sound_events" { "sound_events" } else if source.kind == "video" && options["operation"] == "playback" { "playback" } else if source.kind == "audio"
        || (source.kind == "video" && options["operation"] == "transcribe")
    {
        "audio"
    } else if source.kind == "pdf" && options["operation"] == "render_page" {
        "pdf_page"
    } else if source.kind == "pdf" {
        "pdf"
    } else if source.kind == "image" {
        "image"
    } else if source.kind == "video" {
        "video"
    } else if ext == "docx" {
        "docx"
    } else if ext == "xlsx" {
        "xlsx"
    } else {
        anyhow::bail!(
            "Sandboxed extraction currently supports PDF, images, video frames, DOCX, and XLSX"
        )
    };
    ensure!(
        options["crop"].is_null() || kind == "image",
        "Crops require an image source"
    );
    let worker = worker_path()?;
    let source_path = case.source_path(source_id)?;
    let job_id = id();
    let staging = tempfile::tempdir_in(case.root.join("staging"))?;
    let mut request = options;
    request["version"] = json!(1);
    request["kind"] = json!(kind);
    fs::write(staging.path().join("request.json"), request.to_string())?;
    case.db.execute(
        "INSERT INTO processing_jobs VALUES(?,?,?,'running','{}','',?)",
        params![job_id, source_id, kind, now()],
    )?;
    Ok(PreparedJob {job_id,source,source_path,kind:kind.into(),worker,staging,request})
}
pub fn run_prepared(job:&PreparedJob)->Result<Value> {
    fs::copy(&job.source_path,job.staging.path().join("input"))?;
    ensure!(file_hash(&job.staging.path().join("input"))?==job.source.sha256,"Source changed while preparing processing");
    #[cfg(windows)]
    crate::sandbox::run_worker(&job.worker,job.staging.path(),Duration::from_secs(if job.kind=="playback" || job.request["operation"]=="automatic" {3600}else{120}))?;
    #[cfg(not(windows))]
    anyhow::bail!("Windows AppContainer is required");
    let path=job.staging.path().join("result.json");
    ensure!(path.metadata()?.len()<=16*1024*1024,"Worker output too large");
    let value:Value=serde_json::from_slice(&fs::read(path)?)?;
    ensure!(value["version"]==1 && value["status"]=="complete","{}",value["error"].as_str().unwrap_or("Invalid processor output"));
    Ok(value)
}
pub fn publish_prepared(case:&mut Case,job:&PreparedJob,output:Result<Value>)->Result<Value> {
    let source=&job.source;let source_id=source.id.as_str();let kind=job.kind.as_str();
    let worker=&job.worker;let staging=&job.staging;let request=&job.request;let job_id=&job.job_id;
    case.db.execute_batch("SAVEPOINT publish_processor")?;
    let execute=(||->Result<Value> {
        let value=output?;
        let pages = value["pages"].as_array().context("Missing source units")?;
        ensure!(pages.len() <= 100000, "Too many source units");
        let mut combined = String::new();
        for page in pages {
            let locator = page["locator"].as_str().context("Missing unit locator")?;
            ensure!(locator.len() <= 512, "Locator too long");
            let text = page["text"].as_str().context("Missing unit text")?;
            combined.push_str(&format!("[{locator}]\n{text}\n\n"));
            ensure!(
                combined.len() <= 10 * 1024 * 1024,
                "Extract exceeds indexing limit"
            );
        }
        let raw = serde_json::to_vec(&value)?;
        let raw_hash = digest(&raw);
        let raw_path = format!("artifacts/{raw_hash}.json");
        if !case.root.join(&raw_path).exists() {
            fs::write(case.root.join(&raw_path), &raw)?;
        }
        let mut result = value.clone();
        let previews = value["previews"]
            .as_array()
            .context("Missing preview manifest")?;
        ensure!(previews.len() <= 24, "Too many image artifacts");
        let mut published = Vec::new();
        for entry in previews {
            let relative_path = entry["path"].as_str().context("Preview missing path")?;
            ensure!(
                crate::case::safe_relative(Path::new(relative_path)),
                "Invalid preview path"
            );
            let preview = staging.path().join(relative_path);
            ensure!(
                preview
                    .canonicalize()?
                    .starts_with(staging.path().canonicalize()?),
                "Preview escaped job directory"
            );
            ensure!(
                preview.is_file() && preview.metadata()?.len() <= if kind == "playback" {16 * 1024 * 1024 * 1024} else {30 * 1024 * 1024},
                "Invalid preview artifact"
            );
            ensure!(
                !fs::symlink_metadata(&preview)?.file_type().is_symlink(),
                "Worker returned a link"
            );
            let hash = file_hash(&preview)?;
            let mime=if kind=="playback" {"video/mp4"}else{"image/jpeg"};
            let ext=if kind=="playback" {"mp4"}else{"jpg"};
            let relative = format!("artifacts/{hash}.{ext}");
            if !case.root.join(&relative).exists() {
                fs::copy(&preview, case.root.join(&relative))?;
            }
            let artifact = id();
            case.db.execute(
                "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
                params![
                    artifact,
                    source_id,
                    hash,
                    mime,
                    relative,
                    entry.to_string(),
                    now()
                ],
            )?;
            published.push(json!({"artifact_id":artifact,"locator":format!("evidence:{source_id}#artifact:{artifact}"),"metadata":entry}));
        }
        if let Some(first) = published.first() {
            result["artifact_id"] = first["artifact_id"].clone();
            result["locator"] = first["locator"].clone();
        }
        result["published"] = json!(published);
        let extraction_artifact = id();
        case.db.execute(
            "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
            params![
                extraction_artifact,
                source_id,
                raw_hash,
                "application/json",
                raw_path,
                json!({"kind":kind,"worker_sha256":file_hash(&worker)?,"request":request})
                    .to_string(),
                now()
            ],
        )?;
        result["extraction_locator"] = json!(format!(
            "evidence:{source_id}#artifact:{extraction_artifact}"
        ));
        let indexed: bool = case.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM extracts WHERE source_id=?)",
            [source_id],
            |r| r.get(0),
        )?;
        if !combined.is_empty() && !indexed && kind != "sound_events" {
            let tx = case.db.savepoint()?;
            tx.execute(
                "INSERT INTO extracts(source_id,text,method) VALUES(?,?,?)",
                params![
                    source_id,
                    combined,
                    format!("Sandboxed {kind}; see processing limitations")
                ],
            )?;
            tx.execute("DELETE FROM source_fts WHERE source_id=?", [source_id])?;
            tx.execute(
                "INSERT INTO source_fts(source_id,name,text) VALUES(?,?,?)",
                params![source_id, source.name, combined],
            )?;
            tx.execute("UPDATE records SET stale=1 WHERE actor<>'processor' OR kind<>'transcript'", [])?;
            tx.execute(
                "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'",
                [],
            )?;
            tx.commit()?;
        }
        case.db.execute(
            "UPDATE sources SET status=? WHERE id=?",
            params![
                if kind == "sound_events" {
                    "selected sound interval scanned · unclassified candidates"
                } else if kind == "image" {
                    if request["operation"]=="automatic" {"image OCR extracted · unreviewed"}else{"image metadata extracted · no OCR"}
                } else if kind == "media_inventory" {
                    "media inventoried · analysis queued"
                } else if kind == "video" {
                    "selected frames decoded · audio unprocessed"
                } else {
                    "text extracted · fidelity limitations"
                },
                source_id
            ],
        )?;
        Ok(result)
    })();
    match execute {
        Ok(value)=>{
            case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![value.to_string(),job_id])?;
            case.audit("source_processed",json!({"source":source_id,"job":job_id,"kind":kind,"request":request}))?;
            case.db.execute_batch("RELEASE publish_processor")?;
            Ok(value)
        },
        Err(e)=>{
            case.db.execute_batch("ROLLBACK TO publish_processor; RELEASE publish_processor")?;
            case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![e.to_string(),job_id])?;
            Err(e)
        }
    }
}

pub fn artifact(case: &Case, artifact_id: &str) -> Result<(String, String, PathBuf, Value)> {
    let (source, mime, path, hash, metadata): (String, String, String, String, String) = case
        .db
        .query_row(
            "SELECT source_id,mime,path,sha256,metadata FROM artifacts WHERE id=?",
            [artifact_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .context("Artifact not found")?;
    ensure!(
        crate::case::safe_relative(Path::new(&path)),
        "Invalid artifact path"
    );
    let root = case.root.join("artifacts").canonicalize()?;
    let path = case.root.join(path).canonicalize()?;
    let transcript_root = case.root.join("working/transcripts");
    ensure!(
        path.starts_with(root)
            || transcript_root
                .canonicalize()
                .is_ok_and(|root| path.starts_with(root)),
        "Artifact outside case"
    );
    ensure!(file_hash(&path)? == hash, "Artifact integrity check failed");
    Ok((source, mime, path, serde_json::from_str(&metadata)?))
}
/// Prepare playback under the case lock, run outside it, and publish under it again.
/// This keeps chat, cancellation and viewing responsive during a long conversion.
pub struct PlaybackJob {
    pub directory: tempfile::TempDir,
    pub id: String,
    pub source: String,
    pub case_id: String,
}
pub fn prepare_playback(case: &mut Case, source: &str) -> Result<PlaybackJob> {
    ensure!(case.source(source)?.kind=="video","Playback requires a video source");
    let directory=tempfile::tempdir_in(case.root.join("staging"))?;
    fs::copy(case.verify_source(source)?,directory.path().join("input"))?;
    fs::write(directory.path().join("request.json"),json!({"version":1,"kind":"playback"}).to_string())?;
    let job=PlaybackJob{directory,id:id(),source:source.into(),case_id:case.meta("id")?.unwrap_or_default()};
    case.db.execute("INSERT INTO processing_jobs VALUES(?,?,?,'running','{}','',?)",params![job.id,source,"playback",now()])?;
    Ok(job)
}
pub fn run_playback(job: &PlaybackJob) -> Result<Value> {
    #[cfg(windows)]
    crate::sandbox::run_worker(&worker_path()?,job.directory.path(),Duration::from_secs(3600))?;
    let result:Value=serde_json::from_slice(&fs::read(job.directory.path().join("result.json"))?)?;
    ensure!(result["status"]=="complete","{}",result["error"].as_str().unwrap_or("Playback conversion failed"));
    Ok(result)
}
pub fn publish_playback(case:&mut Case, job:&PlaybackJob,result:Result<Value>) -> Result<Value> {
    let publish=(|| -> Result<Value> {
        let result=result?;
        let preview=job.directory.path().join("playback.mp4");
        ensure!(!fs::symlink_metadata(&preview)?.file_type().is_symlink() && preview.is_file(),"Invalid playback artifact");
        ensure!(preview.metadata()?.len()<=16*1024*1024*1024,"Playback artifact too large");
        let hash=file_hash(&preview)?;
        let relative=format!("artifacts/{hash}.mp4");
        let destination=case.root.join(&relative);
        if !destination.exists(){fs::rename(&preview,&destination)?;}
        let artifact=id();
        case.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",params![artifact,job.source,hash,"video/mp4",relative,result["metadata"].to_string(),now()])?;
        case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![result.to_string(),job.id])?;
        case.audit("playback_created",json!({"source":job.source,"artifact":artifact,"sha256":hash}))?;
        Ok(json!({"artifact_id":artifact}))
    })();
    if let Err(ref e)=publish {case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![e.to_string(),job.id])?;}
    publish
}
