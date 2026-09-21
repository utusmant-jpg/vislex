use crate::case::{digest, file_hash, file_hash_cached, id, now, Case};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub fn worker_path() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path)=std::env::var_os("VISLEX_WORKER_PATH") {
        let path=PathBuf::from(path).canonicalize()?;
        ensure!(path.is_file(),"Development worker override is not a file");
        return Ok(path);
    }
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
pub struct JobDirectory(PathBuf);
impl JobDirectory { pub fn path(&self)->&Path { &self.0 } }
pub struct PreparedJob {
    pub job_id:String,
    pub source:crate::case::Source,
    pub source_path:PathBuf,
    pub kind:String,
    pub worker:PathBuf,
    pub staging:JobDirectory,
    pub request:Value,
    pub cached:Option<Value>,
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
    let kind = if source.kind=="video" && options["operation"]=="video_ocr" {"video_ocr"} else if source.kind=="video" && options["operation"]=="video_overview" {"video_overview"} else if options["operation"]=="diarize" && ["audio","video"].contains(&source.kind.as_str()) {"diarization"} else if options["operation"]=="redact" && ["image","pdf"].contains(&source.kind.as_str()) {"redaction"} else if ["video","audio"].contains(&source.kind.as_str()) && options["operation"]=="automatic" { "media_inventory" } else if ["video","audio"].contains(&source.kind.as_str()) && options["operation"]=="sound_events" { "sound_events" } else if source.kind == "video" && options["operation"] == "playback" { "playback" } else if source.kind == "audio"
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
    } else if ext == "pptx" {
        "pptx"
    } else if ext == "odt" {
        "odt"
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
    let staging = JobDirectory(tempfile::tempdir_in(case.root.join("staging"))?.keep());
    let mut request = options;
    if ["docx","xlsx","pptx","odt"].contains(&kind) {if let Some(object)=request.as_object_mut(){object.remove("operation");object.remove("crop");}}
    if kind=="redaction" {request["source_kind"]=json!(source.kind);}
    request["asr_model"] = json!(case.meta("asr_profile")?.unwrap_or_else(||"tiny".into()));
    request["version"] = json!(1);
    request["kind"] = json!(kind);
    let worker_hash=file_hash_cached(&worker)?;
    let cache_key=format!("processor_cache:{}",digest(json!([source.id,source.sha256,worker_hash,request]).to_string().as_bytes()));
    if kind!="redaction" && kind!="video_ocr" && kind!="video_overview" {
        if let Some(raw)=case.meta(&cache_key)? {
            if let Ok(mut cached)=serde_json::from_str::<Value>(&raw) {
                let mut locators=vec![cached["extraction_locator"].as_str().unwrap_or("").to_string()];
                if let Some(entries)=cached["published"].as_array(){for entry in entries {locators.push(entry["locator"].as_str().unwrap_or("").to_string());}}
                let intact=locators.iter().all(|locator|locator.split("#artifact:").nth(1).is_some_and(|id|artifact(case,id).is_ok()));
                if intact {cached["reused"]=json!(true);return Ok(PreparedJob{job_id,source,source_path,kind:kind.into(),worker,staging,request,cached:Some(cached)});}
            }
        }
    }
    fs::write(staging.path().join("request.json"), request.to_string())?;
    let manifest=json!({"version":1,"job_id":job_id,"source_id":source.id,"source_sha256":source.sha256,"kind":kind,"request":request,"worker_sha256":worker_hash});
    let mut manifest_file=fs::File::create(staging.path().join("manifest.json"))?;
    std::io::Write::write_all(&mut manifest_file,manifest.to_string().as_bytes())?;manifest_file.sync_all()?;
    case.db.execute(
        "INSERT INTO processing_jobs VALUES(?,?,?,'running','{}','',?)",
        params![job_id, source_id, kind, now()],
    )?;
    case.set_meta(&format!("processing_staging:{job_id}"),&staging.path().strip_prefix(&case.root)?.to_string_lossy().replace('\\',"/"))?;
    Ok(PreparedJob {job_id,source,source_path,kind:kind.into(),worker,staging,request,cached:None})
}
pub fn run_prepared(job:&PreparedJob)->Result<Value> {
    if let Some(cached)=&job.cached {ensure!(file_hash_cached(&job.source_path)?==job.source.sha256,"Source changed since extraction");return Ok(cached.clone());}
    let manifest:Value=serde_json::from_slice(&fs::read(job.staging.path().join("manifest.json"))?)?;
    ensure!(manifest["worker_sha256"].as_str()==Some(file_hash_cached(&job.worker)?.as_str()),"Worker changed; create a fresh job instead of reusing old provenance");
    if job.staging.path().join("result.json").is_file() && !job.staging.path().join("cancel.request").exists() {
        let path=job.staging.path().join("result.json");ensure!(path.metadata()?.len()<=16*1024*1024,"Worker output too large");
        let result:Value=serde_json::from_slice(&fs::read(path)?)?;
        if result["version"]==1 && result["status"]=="complete" {ensure!(file_hash_cached(&job.source_path)?==job.source.sha256,"Source changed before recovery"); return Ok(result); }
    }
    copy_input(&job.source_path,job.staging.path(),&job.source.sha256)?;
    #[cfg(windows)]
    crate::sandbox::run_worker(&job.worker,job.staging.path(),Duration::from_secs(if ["playback","video_ocr","video_overview"].contains(&job.kind.as_str()) || job.request["operation"]=="automatic" {3600}else if job.kind=="diarization" {600}else{120}))?;
    #[cfg(not(windows))]
    anyhow::bail!("Windows AppContainer is required");
    let path=job.staging.path().join("result.json");
    ensure!(path.metadata()?.len()<=16*1024*1024,"Worker output too large");
    let value:Value=serde_json::from_slice(&fs::read(path)?)?;
    ensure!(value["version"]==1 && value["status"]=="complete","{}",value["error"].as_str().unwrap_or("Invalid processor output"));
    Ok(value)
}
/// Resume only a registered private job. Outputs remain unpublished until normal validation succeeds.
pub fn resume(case:&mut Case,job_id:&str)->Result<PreparedJob> {
    let (source_id,kind,status):(String,String,String)=case.db.query_row("SELECT source_id,kind,status FROM processing_jobs WHERE id=?",[job_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    ensure!(["interrupted","failed"].contains(&status.as_str()),"Job is not resumable");
    let relative=case.meta(&format!("processing_staging:{job_id}"))?.context("Job predates durable recovery; retry normally")?;
    ensure!(crate::case::safe_relative(Path::new(&relative)),"Invalid staging path");
    let path=case.root.join(relative).canonicalize()?;
    ensure!(path.starts_with(case.root.join("staging").canonicalize()?) && !fs::symlink_metadata(&path)?.file_type().is_symlink(),"Invalid private job path");
    let manifest_path=path.join("manifest.json");ensure!(manifest_path.metadata()?.len()<=100000,"Invalid job manifest");
    let manifest:Value=serde_json::from_slice(&fs::read(manifest_path)?)?;
    let source=case.source(&source_id)?;
    ensure!(manifest["job_id"]==job_id && manifest["source_id"]==source_id && manifest["source_sha256"]==source.sha256 && manifest["kind"]==kind,"Recovery manifest mismatch");
    ensure!(!path.join("cancel.request").exists(),"Cancelled jobs require a new explicit request");
    let worker=worker_path()?;ensure!(manifest["worker_sha256"].as_str()==Some(file_hash(&worker)?.as_str()),"Worker changed; retry with a new job");
    let job=PreparedJob{job_id:job_id.into(),source_path:case.source_path(&source_id)?,source,kind,worker,staging:JobDirectory(path),request:manifest["request"].clone(),cached:None};
    case.db.execute("UPDATE processing_jobs SET status='running',error='' WHERE id=?",[job_id])?;
    case.audit("processing_resumed",json!({"job":job_id}))?;
    Ok(job)
}
/// Read-only reconciliation inventory; never delete or silently register unknown files.
pub fn recovery_inventory(case:&Case)->Result<Value> {
    let mut unregistered=vec![];
    for entry in fs::read_dir(case.root.join("artifacts"))? {
        let entry=entry?;if !entry.file_type()?.is_file(){continue;}
        let relative=format!("artifacts/{}",entry.file_name().to_string_lossy());
        let registered:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM artifacts WHERE path=?)",[&relative],|r|r.get(0))?;
        if !registered {unregistered.push(relative);}
    }
    let mut query=case.db.prepare("SELECT id,source_id,kind,status,error FROM processing_jobs WHERE status IN ('interrupted','failed') ORDER BY created_at,id")?;
    let jobs=query.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!({"jobs":jobs,"unregistered_artifacts":unregistered,"policy":"Unregistered files are retained and not exposed as evidence. Resume a registered job to validate and publish its outputs."}))
}
/// Stream and hash outside the case lock, checking cancellation between bounded chunks.
fn copy_input(source:&Path, staging:&Path, expected:&str)->Result<()> {
    use std::io::{Read,Write};
    use sha2::{Digest,Sha256};
    let mut input=fs::File::open(source)?;
    let mut output=fs::File::create(staging.join("input"))?;
    let mut hash=Sha256::new();let mut buffer=vec![0u8;1024*1024];
    loop {
        ensure!(!staging.join("cancel.request").exists(),"Processing cancelled while preparing input");
        let count=input.read(&mut buffer)?;if count==0{break;}
        hash.update(&buffer[..count]);output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    ensure!(format!("{:x}",hash.finalize())==expected,"Source changed while preparing processing");
    Ok(())
}
pub fn cancel(case:&Case,job_id:&str)->Result<()> {
    let active:bool=case.db.query_row("SELECT status='running' FROM processing_jobs WHERE id=?",[job_id],|r|r.get(0))?;
    ensure!(active,"Processing job is not running");
    let relative=case.meta(&format!("processing_staging:{job_id}"))?.context("This job does not support direct cancellation")?;
    ensure!(crate::case::safe_relative(Path::new(&relative)),"Invalid job staging path");
    let path=case.root.join(relative).canonicalize()?;
    ensure!(path.starts_with(case.root.join("staging").canonicalize()?),"Job path escaped staging");
    fs::write(path.join("cancel.request"),b"cancel")?;
    Ok(())
}
fn publish_bytes(destination:&Path, bytes:&[u8], expected:&str)->Result<()> {
    if !destination.exists() {
        let mut staged=tempfile::NamedTempFile::new_in(destination.parent().context("Missing output directory")?)?;
        std::io::Write::write_all(&mut staged,bytes)?;
        staged.as_file().sync_all()?;
        staged.persist_noclobber(destination)?;
    }
    ensure!(file_hash(destination)?==expected,"Published artifact integrity mismatch");
    Ok(())
}
fn publish_file(source:&Path,destination:&Path,expected:&str)->Result<()> {
    if !destination.exists() {
        let mut staged=tempfile::NamedTempFile::new_in(destination.parent().context("Missing output directory")?)?;
        std::io::copy(&mut fs::File::open(source)?,staged.as_file_mut())?;
        staged.as_file().sync_all()?;
        ensure!(file_hash(staged.path())?==expected,"Artifact changed during publication");
        staged.persist_noclobber(destination)?;
    }
    ensure!(file_hash(destination)?==expected,"Published artifact integrity mismatch");
    Ok(())
}
pub fn publish_prepared(case:&mut Case,job:&PreparedJob,output:Result<Value>)->Result<Value> {
    if job.cached.is_some() {return output;}
    let source=&job.source;let source_id=source.id.as_str();let kind=job.kind.as_str();
    let worker=&job.worker;let staging=&job.staging;let request=&job.request;let job_id=&job.job_id;
    case.db.execute_batch("SAVEPOINT publish_processor")?;
    let execute=(||->Result<Value> {
        ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled before publication");
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
        publish_bytes(&case.root.join(&raw_path),&raw,&raw_hash)?;
        let mut result = value.clone();
        let previews = value["previews"]
            .as_array()
            .context("Missing preview manifest")?;
        ensure!(previews.len() <= if kind=="redaction" {501}else if ["video_ocr","video_overview"].contains(&kind) {180}else{24}, "Too many image artifacts");
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
            let mime=if kind=="playback" {"video/mp4"}else if kind=="redaction" && entry["mime"]=="application/pdf" {"application/pdf"}else{"image/jpeg"};
            let ext=if mime=="video/mp4" {"mp4"}else if mime=="application/pdf" {"pdf"}else{"jpg"};
            let relative = format!("artifacts/{hash}.{ext}");
            publish_file(&preview,&case.root.join(&relative),&hash)?;
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
        if !combined.is_empty() && !indexed && !["sound_events","redaction","diarization","video_ocr","video_overview"].contains(&kind) {
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
                if ["video_ocr","video_overview"].contains(&kind) {"video discovery indexed · sampled only"} else if kind=="diarization" {"selected speaker turns proposed · not identity"} else if kind=="redaction" {"redaction derivative prepared · review required"} else if kind == "sound_events" {
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
            // Chunked discovery results are bounded by their own job rows and samples;
            // caching every 60 s chunk in meta would grow the database without reuse.
            if !["redaction","video_ocr","video_overview"].contains(&kind) {let cache_key=format!("processor_cache:{}",digest(json!([source.id,source.sha256,file_hash_cached(worker)?,request]).to_string().as_bytes()));case.set_meta(&cache_key,&value.to_string())?;}
            case.audit("source_processed",json!({"source":source_id,"job":job_id,"kind":kind,"request":request}))?;
            case.db.execute_batch("RELEASE publish_processor")?;
            // Registered derivatives are authoritative now. Release the duplicate staged original.
            let input=job.staging.path().join("input");
            if let (Ok(path),Ok(root))=(input.canonicalize(),case.root.join("staging").canonicalize()) {
                if path.starts_with(root)&&fs::symlink_metadata(&input).is_ok_and(|m|!m.file_type().is_symlink()) {let _=fs::remove_file(input);}
            }
            Ok(value)
        },
        Err(e)=>{
            case.db.execute_batch("ROLLBACK TO publish_processor; RELEASE publish_processor")?;
            case.db.execute("UPDATE processing_jobs SET status=?,error=? WHERE id=?",params![if job.staging.path().join("cancel.request").exists(){"cancelled"}else{"failed"},e.to_string(),job_id])?;
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
    ensure!(file_hash_cached(&path)? == hash, "Artifact integrity check failed");
    Ok((source, mime, path, serde_json::from_str(&metadata)?))
}
/// Prepare playback under the case lock, run outside it, and publish under it again.
/// This keeps chat, cancellation and viewing responsive during a long conversion.
pub struct PlaybackJob {
    pub directory: tempfile::TempDir,
    pub id: String,
    pub source: String,
    pub case_id: String,
    pub input_path: PathBuf,
    pub expected_hash: String,
}
pub fn prepare_playback(case: &mut Case, source: &str) -> Result<PlaybackJob> {
    ensure!(case.source(source)?.kind=="video","Playback requires a video source");
    let directory=tempfile::tempdir_in(case.root.join("staging"))?;
    fs::write(directory.path().join("request.json"),json!({"version":1,"kind":"playback"}).to_string())?;
    let job=PlaybackJob{directory,id:id(),source:source.into(),case_id:case.meta("id")?.unwrap_or_default(),input_path:case.source_path(source)?,expected_hash:case.source(source)?.sha256};
    case.set_meta(&format!("processing_staging:{}",job.id),&job.directory.path().strip_prefix(&case.root)?.to_string_lossy().replace('\\',"/"))?;
    case.db.execute("INSERT INTO processing_jobs VALUES(?,?,?,'running','{}','',?)",params![job.id,source,"playback",now()])?;
    Ok(job)
}
pub fn run_playback(job: &PlaybackJob) -> Result<Value> {
    copy_input(&job.input_path,job.directory.path(),&job.expected_hash)?;
    #[cfg(windows)]
    crate::sandbox::run_worker(&worker_path()?,job.directory.path(),Duration::from_secs(3600))?;
    let result_path=job.directory.path().join("result.json");
    ensure!(result_path.metadata()?.len()<=16*1024*1024,"Worker output too large");
    let result:Value=serde_json::from_slice(&fs::read(&result_path)?)?;
    ensure!(result["status"]=="complete","{}",result["error"].as_str().unwrap_or("Playback conversion failed"));
    Ok(result)
}
pub fn publish_playback(case:&mut Case, job:&PlaybackJob,result:Result<Value>) -> Result<Value> {
    case.db.execute_batch("SAVEPOINT playback_publication")?;
    let publish=(|| -> Result<Value> {
        ensure!(!job.directory.path().join("cancel.request").exists(),"Playback cancelled before publication");
        let result=result?;
        let preview=job.directory.path().join("playback.mp4");
        ensure!(!fs::symlink_metadata(&preview)?.file_type().is_symlink() && preview.is_file(),"Invalid playback artifact");
        ensure!(preview.metadata()?.len()<=16*1024*1024*1024,"Playback artifact too large");
        let hash=file_hash(&preview)?;
        let relative=format!("artifacts/{hash}.mp4");
        let destination=case.root.join(&relative);
        publish_file(&preview,&destination,&hash)?;
        let artifact=id();
        case.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",params![artifact,job.source,hash,"video/mp4",relative,result["metadata"].to_string(),now()])?;
        case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![result.to_string(),job.id])?;
        case.audit("playback_created",json!({"source":job.source,"artifact":artifact,"sha256":hash}))?;
        Ok(json!({"artifact_id":artifact}))
    })();
    if let Err(ref e)=publish {
        case.db.execute_batch("ROLLBACK TO playback_publication; RELEASE playback_publication")?;
        case.db.execute("UPDATE processing_jobs SET status=?,error=? WHERE id=?",params![if job.directory.path().join("cancel.request").exists(){"cancelled"}else{"failed"},e.to_string(),job.id])?;
    } else {case.db.execute_batch("RELEASE playback_publication")?;}
    publish
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    #[test]
    fn artifact_publication_is_idempotent_and_rejects_corrupt_existing_content() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("artifact.json");let content=b"immutable result";let hash=digest(content);
        publish_bytes(&path,content,&hash).unwrap();publish_bytes(&path,content,&hash).unwrap();
        fs::write(&path,b"incomplete old output").unwrap();
        assert!(publish_bytes(&path,content,&hash).is_err());
        assert_eq!(fs::read(&path).unwrap(),b"incomplete old output");
    }
}
