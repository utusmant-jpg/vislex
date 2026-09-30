use crate::case::{digest, file_hash, file_hash_cached, file_hash_strong, id, now, Case};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read,Seek},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool,Ordering},Arc,Mutex,OnceLock},
    time::Duration,
};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

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
    let staged=stage_prepared(&job,run_prepared(&job));
    let result=publish_staged(case,&job,staged);
    if result.is_ok(){let _=cleanup_published_input(&job);}
    result
}
pub struct JobDirectory(PathBuf);
impl JobDirectory { pub fn path(&self)->&Path { &self.0 } }
pub struct PreparedJob {
    pub job_id:String,
    pub case_root:PathBuf,
    pub source:crate::case::Source,
    pub source_path:PathBuf,
    pub kind:String,
    pub worker:PathBuf,
    pub staging:JobDirectory,
    pub request:Value,
    pub cached:Option<Value>,
}
pub fn prepare_request(case:&mut Case,source_id:&str,options:Value)->Result<PreparedJob> {
    let automatic=options["operation"]=="automatic";
    let source = case.source(source_id)?;
    if options["operation"]=="frame_at" {
        let target=options["target"].as_f64().context("Missing frame target")?;
        ensure!(source.kind=="video" && !source.restricted && target.is_finite() && target>=0. && ["previous","next"].contains(&options["direction"].as_str().unwrap_or("")),"Invalid exact frame request");
    }
    if options["operation"]=="media_clip" {
        let (start,end)=(options["start"].as_f64().context("Missing clip start")?,options["end"].as_f64().context("Missing clip end")?);
        ensure!(["audio","video"].contains(&source.kind.as_str()) && !source.restricted,"Clips need an unrestricted audio or video source");
        ensure!(start.is_finite() && end.is_finite() && start>=0. && end>start && end-start<=crate::escalation::MAX_CLIP_SECONDS,"A clip must be a positive interval no longer than 30 seconds");
    }
    if options["operation"]=="render_page" {
        ensure!(source.kind=="pdf" && options["page"].as_u64().is_some_and(|page|page>=1 && page<=100_000),"Invalid physical PDF page");
    }
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
    let kind = if options["operation"]=="office_image" && ["docx","pptx","xlsx","odt"].contains(&ext.as_str()) {"office_image"} else if options["operation"]=="media_clip" {"media_clip"} else if source.kind=="video" && options["operation"]=="video_ocr" {"video_ocr"} else if source.kind=="video" && options["operation"]=="video_overview" {"video_overview"} else if options["operation"]=="diarize" && ["audio","video"].contains(&source.kind.as_str()) {"diarization"} else if options["operation"]=="redact" && ["image","pdf"].contains(&source.kind.as_str()) {"redaction"} else if ["video","audio"].contains(&source.kind.as_str()) && options["operation"]=="automatic" { "media_inventory" } else if ["video","audio"].contains(&source.kind.as_str()) && options["operation"]=="sound_events" { "sound_events" } else if source.kind == "video" && options["operation"] == "playback" { "playback" } else if source.kind == "audio"
        || (source.kind == "video" && options["operation"] == "transcribe")
    {
        "audio"
    } else if source.kind == "pdf" && options["operation"] == "probe_pdf" {
        "pdf_probe"
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
    } else if ext == "eml" {
        "email"
    } else {
        anyhow::bail!(
            "Sandboxed extraction currently supports PDF, images, video frames, DOCX, XLSX, PPTX, ODT and EML"
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
    if ["docx","xlsx","pptx","odt","email"].contains(&kind) {if let Some(object)=request.as_object_mut(){object.remove("operation");object.remove("crop");}}
    if automatic {request["scheduler_priority"]=json!("background");}
    if kind=="redaction" {request["source_kind"]=json!(source.kind);}
    request["asr_model"] = json!(case.meta("asr_profile")?.unwrap_or_else(||"tiny".into()));
    request["version"] = json!(1);
    request["kind"] = json!(kind);
    if ["video","video_ocr","video_overview","pdf_probe","pdf_page","media_clip","sound_events","office_image"].contains(&kind) || request["operation"]=="frame_at" {
        let epoch=case.meta(&format!("source_policy_epoch:{}",source.id))?.and_then(|raw|raw.parse::<u64>().ok()).unwrap_or(0);
        request["source_lease_epoch"]=json!(epoch);
        request["source_lease"]=json!(case.root.join("staging/source-leases").join(&source.id).join(&source.sha256).join(epoch.to_string()).join("input").to_string_lossy());
    }
    let worker_hash=file_hash_cached(&worker)?;
    let cache_key=format!("processor_cache:{}",digest(json!([source.id,source.sha256,worker_hash,request]).to_string().as_bytes()));
    if kind!="redaction" && kind!="video_ocr" && kind!="video_overview" {
        if let Some(raw)=case.meta(&cache_key)? {
            if let Ok(mut cached)=serde_json::from_str::<Value>(&raw) {
                let mut locators=vec![cached["extraction_locator"].as_str().unwrap_or("").to_string()];
                if let Some(entries)=cached["published"].as_array(){for entry in entries {locators.push(entry["locator"].as_str().unwrap_or("").to_string());}}
                let intact=locators.iter().all(|locator|locator.split("#artifact:").nth(1).is_some_and(|id|artifact(case,id).is_ok()));
                if intact {cached["reused"]=json!(true);return Ok(PreparedJob{job_id,case_root:case.root.clone(),source,source_path,kind:kind.into(),worker,staging,request,cached:Some(cached)});}
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
    Ok(PreparedJob {job_id,case_root:case.root.clone(),source,source_path,kind:kind.into(),worker,staging,request,cached:None})
}
pub fn run_prepared(job:&PreparedJob)->Result<Value> {
    if let Some(cached)=&job.cached {ensure!(file_hash_strong(&job.source_path)?==job.source.sha256,"Source changed since extraction");return Ok(cached.clone());}
    let manifest:Value=serde_json::from_slice(&fs::read(job.staging.path().join("manifest.json"))?)?;
    ensure!(manifest["worker_sha256"].as_str()==Some(file_hash_cached(&job.worker)?.as_str()),"Worker changed; create a fresh job instead of reusing old provenance");
    if job.staging.path().join("result.json").is_file() && !job.staging.path().join("cancel.request").exists() {
        let path=job.staging.path().join("result.json");ensure!(path.metadata()?.len()<=16*1024*1024,"Worker output too large");
        let result:Value=serde_json::from_slice(&fs::read(path)?)?;
        if result["version"]==1 && result["status"]=="complete" {ensure!(file_hash_strong(&job.source_path)?==job.source.sha256,"Source changed before recovery"); return Ok(result); }
    }
    let lease=if ["video","video_ocr","video_overview","pdf_probe","pdf_page","media_clip","sound_events","office_image"].contains(&job.kind.as_str()) || job.request["operation"]=="frame_at" {
        Some(acquire_source_lease(job)?)
    } else {copy_input(&job.source_path,job.staging.path(),&job.source.sha256)?;None};
    if let Some(lease)=lease.as_ref() {
        let new_copy=lease.created_by_job==job.job_id;
        fs::write(job.staging.path().join("source-lease-receipt.json"),json!({"version":1,"source_bytes":job.source.size,"copied_bytes_for_job":if new_copy{lease.copied_bytes}else{0},"reused":!new_copy}).to_string())?;
    }
    #[cfg(windows)]
    crate::sandbox::run_worker_with_readonly(&job.worker,job.staging.path(),lease.as_ref().map(|lease|lease.path.as_path()),Duration::from_secs(if ["playback","video_ocr","video_overview"].contains(&job.kind.as_str()) || job.request["operation"]=="automatic" {3600}else if job.kind=="diarization" {600}else{120}))?;
    #[cfg(not(windows))]
    anyhow::bail!("Windows AppContainer is required");
    let path=job.staging.path().join("result.json");
    ensure!(path.metadata()?.len()<=16*1024*1024,"Worker output too large");
    let value:Value=serde_json::from_slice(&fs::read(path)?)?;
    check_worker_protocol(&value)?;
    ensure!(value["version"]==1 && value["status"]=="complete","{}",value["error"].as_str().unwrap_or("Invalid processor output"));
    Ok(value)
}
/// Worker/host protocol generation. A packaged worker built from older source
/// cannot honour newer request fields (for example source leases), so its
/// output is refused with an actionable message instead of a misleading error.
pub const WORKER_PROTOCOL: u64 = 2;
pub const WORKER_OUTDATED: &str = "The packaged evidence worker is out of date";
pub fn check_worker_protocol(value:&Value)->Result<()> {
    let reported=value["protocol"].as_u64();
    ensure!(reported==Some(WORKER_PROTOCOL),"{WORKER_OUTDATED} (reports protocol {}, this app needs {WORKER_PROTOCOL}). Rebuild it with scripts/build-worker.ps1 and restart VisLex. Worker message: {}",reported.map_or("none".to_string(),|p|p.to_string()),value["error"].as_str().unwrap_or("none").chars().take(300).collect::<String>());
    Ok(())
}
pub fn worker_outdated(error:&str)->bool { error.contains(WORKER_OUTDATED) }
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
    let job=PreparedJob{job_id:job_id.into(),case_root:case.root.clone(),source_path:case.source_path(&source_id)?,source,kind,worker,staging:JobDirectory(path),request:manifest["request"].clone(),cached:None};
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
pub(crate) fn ensure_copy_capacity(directory:&Path,bytes:u64)->Result<()> {
    if let Ok(free)=fs2::available_space(directory) {
        ensure!(free>=bytes,"Not enough case storage to prepare this file: need {} MiB, available {} MiB",bytes.div_ceil(1024*1024),free/(1024*1024));
    }
    Ok(())
}
fn copy_input(source:&Path, staging:&Path, expected:&str)->Result<()> {
    use std::io::{Read,Write};
    use sha2::{Digest,Sha256};
    ensure_copy_capacity(staging,source.metadata()?.len())?;
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
struct SharedSourceLease {
    path:PathBuf,
    copied_bytes:u64,
    created_by_job:String,
    original:Option<fs::File>,
    private:Option<fs::File>,
}
impl Drop for SharedSourceLease {
    fn drop(&mut self) {
        drop(self.original.take());drop(self.private.take());
        // Only known derivative files are removed; an unexpected entry remains
        // available to recovery inventory instead of being recursively deleted.
        let _=fs::remove_file(&self.path);
        let _=fs::remove_file(self.path.parent().unwrap().join("manifest.json"));
        let _=fs::remove_dir(self.path.parent().unwrap());
        let _=fs::remove_dir(self.path.parent().unwrap().parent().unwrap());
        let _=fs::remove_dir(self.path.parent().unwrap().parent().unwrap().parent().unwrap());
    }
}
struct LeaseEntry {build:Mutex<()>,ready:Mutex<Option<Arc<SharedSourceLease>>>,invalid:AtomicBool,case_root:PathBuf,source_id:String}
type LeaseTable=HashMap<PathBuf,Arc<LeaseEntry>>;
static SOURCE_LEASES:OnceLock<Mutex<LeaseTable>>=OnceLock::new();
fn source_leases()->&'static Mutex<LeaseTable>{SOURCE_LEASES.get_or_init(||Mutex::new(HashMap::new()))}
fn acquire_source_lease(job:&PreparedJob)->Result<Arc<SharedSourceLease>> {
    uuid::Uuid::parse_str(&job.source.id).context("Invalid lease source identity")?;
    ensure!(job.source.sha256.len()==64 && job.source.sha256.bytes().all(|byte|byte.is_ascii_hexdigit()),"Invalid lease source hash");
    let epoch=job.request["source_lease_epoch"].as_u64().context("Missing source lease policy epoch")?;
    let path=job.case_root.join("staging/source-leases").join(&job.source.id).join(&job.source.sha256).join(epoch.to_string()).join("input");
    ensure!(job.request["source_lease"].as_str()==Some(path.to_string_lossy().as_ref()),"Source lease request changed");
    let entry={
        let mut table=source_leases().lock().unwrap_or_else(|e|e.into_inner());
        table.entry(path.clone()).or_insert_with(||Arc::new(LeaseEntry{build:Mutex::new(()),ready:Mutex::new(None),invalid:AtomicBool::new(false),case_root:job.case_root.clone(),source_id:job.source.id.clone()})).clone()
    };
    let _builder=entry.build.lock().unwrap_or_else(|e|e.into_inner());
    ensure!(!entry.invalid.load(Ordering::SeqCst),"Source lease was revoked");
    if let Some(lease)=entry.ready.lock().unwrap_or_else(|e|e.into_inner()).as_ref(){return Ok(lease.clone());}
    ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled before source lease");
    let mut original=verified_lease(&job.source_path,&job.source.sha256)?;
    let directory=path.parent().context("Missing lease directory")?;
    fs::create_dir_all(directory)?;
    ensure!(directory.canonicalize()?.starts_with(job.case_root.join("staging").canonicalize()?),"Source lease escaped staging");
    let mut copied_bytes=0u64;
    if !path.exists() {
        ensure_copy_capacity(directory,job.source.size)?;
        use std::io::Write;
        let mut staged=tempfile::NamedTempFile::new_in(directory)?;
        original.rewind()?;
        let mut hash=Sha256::new();let mut buffer=vec![0u8;1024*1024];
        loop {
            ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled while leasing source");
            let count=original.read(&mut buffer)?;if count==0{break;}
            hash.update(&buffer[..count]);staged.write_all(&buffer[..count])?;copied_bytes+=count as u64;
        }
        staged.as_file().sync_all()?;
        ensure!(format!("{:x}",hash.finalize())==job.source.sha256,"Source changed while creating lease");
        if let Err(error)=staged.persist_noclobber(&path){if error.error.kind()!=std::io::ErrorKind::AlreadyExists{return Err(error.into());}}
    }
    let private=verified_lease(&path,&job.source.sha256)?;
    let manifest=json!({"version":1,"source_id":job.source.id,"source_sha256":job.source.sha256,"kind":"read_only_source_lease","copied_bytes_this_session":copied_bytes});
    let mut file=fs::File::create(directory.join("manifest.json"))?;
    std::io::Write::write_all(&mut file,manifest.to_string().as_bytes())?;file.sync_all()?;
    ensure!(!entry.invalid.load(Ordering::SeqCst) && !job.staging.path().join("cancel.request").exists(),"Source lease was revoked during preparation");
    let lease=Arc::new(SharedSourceLease{path:path.clone(),copied_bytes,created_by_job:job.job_id.clone(),original:Some(original),private:Some(private)});
    *entry.ready.lock().unwrap_or_else(|e|e.into_inner())=Some(lease.clone());
    Ok(lease)
}
pub fn invalidate_source_lease(case_root:&Path,source_id:&str) {
    let removed={let mut table=source_leases().lock().unwrap_or_else(|e|e.into_inner());let keys=table.iter().filter(|(_,entry)|entry.case_root==case_root&&entry.source_id==source_id).map(|(path,_)|path.clone()).collect::<Vec<_>>();keys.into_iter().filter_map(|key|{let entry=table.remove(&key)?;entry.invalid.store(true,Ordering::SeqCst);Some(entry)}).collect::<Vec<_>>()};
    drop(removed);
}
pub fn invalidate_case_leases(case_root:&Path) {
    let removed={let mut table=source_leases().lock().unwrap_or_else(|e|e.into_inner());let keys=table.iter().filter(|(_,entry)|entry.case_root==case_root).map(|(path,_)|path.clone()).collect::<Vec<_>>();keys.into_iter().filter_map(|key|{let entry=table.remove(&key)?;entry.invalid.store(true,Ordering::SeqCst);Some(entry)}).collect::<Vec<_>>()};
    drop(removed);
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
        if let Err(error)=staged.persist_noclobber(destination) {
            if error.error.kind()!=std::io::ErrorKind::AlreadyExists {return Err(error.into());}
        }
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
        if let Err(error)=staged.persist_noclobber(destination) {
            if error.error.kind()!=std::io::ErrorKind::AlreadyExists {return Err(error.into());}
        }
    }
    ensure!(file_hash(destination)?==expected,"Published artifact integrity mismatch");
    Ok(())
}
fn publish_file_cancellable(source:&Path,destination:&Path,expected:&str,cancel:&Path)->Result<()> {
    use std::io::Write;
    if !destination.exists() {
        let mut staged=tempfile::NamedTempFile::new_in(destination.parent().context("Missing output directory")?)?;
        let mut input=read_lease(source)?;
        let mut hash=Sha256::new();let mut buffer=vec![0u8;1024*1024];
        loop {
            ensure!(!cancel.exists(),"Processing cancelled during publication");
            let count=input.read(&mut buffer)?;if count==0{break;}
            hash.update(&buffer[..count]);staged.write_all(&buffer[..count])?;
        }
        staged.as_file().sync_all()?;
        ensure!(format!("{:x}",hash.finalize())==expected,"Artifact changed during publication");
        if let Err(error)=staged.persist_noclobber(destination) {
            if error.error.kind()!=std::io::ErrorKind::AlreadyExists {return Err(error.into());}
        }
    }
    ensure!(!cancel.exists(),"Processing cancelled during publication");
    ensure!(file_hash(destination)?==expected,"Published artifact integrity mismatch");
    Ok(())
}
struct StagedPreview { hash:String, mime:String, relative:String }
struct StageDetails {
    combined:String,
    raw_hash:String,
    raw_path:String,
    previews:Vec<StagedPreview>,
    worker_hash:String,
    // Windows read leases deny new writers until the database transaction ends.
    _leases:Vec<fs::File>,
}
pub struct StagedPublication { value:Value, details:Option<StageDetails> }
fn read_lease(path:&Path)->Result<fs::File> {
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(windows)]
    options.share_mode(1); // FILE_SHARE_READ: no concurrent write or delete handles.
    Ok(options.open(path)?)
}
fn leased_hash(mut file:&fs::File)->Result<String> {
    let mut hasher=Sha256::new();let mut buffer=vec![0u8;1024*1024];
    loop {let n=file.read(&mut buffer)?;if n==0 {break;}hasher.update(&buffer[..n]);}
    Ok(format!("{:x}",hasher.finalize()))
}
pub(crate) fn verified_lease(path:&Path,expected:&str)->Result<fs::File> {
    let file=read_lease(path)?;
    ensure!(leased_hash(&file)?==expected,"Published artifact integrity mismatch");
    Ok(file)
}
pub(crate) fn verified_lease_for_rename(path:&Path,expected:&str)->Result<fs::File> {
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(windows)]
    options.share_mode(1|4); // Read and delete/rename allowed; writing remains denied.
    let file=options.open(path)?;
    ensure!(leased_hash(&file)?==expected,"Published artifact integrity mismatch");
    Ok(file)
}
/// Validate, hash and copy large worker output before acquiring the case mutex.
/// Content-addressed files left by a crash are revalidated and reused on resume.
pub fn stage_prepared(job:&PreparedJob,output:Result<Value>)->Result<StagedPublication> {
    let value=output?;
    if job.cached.is_some() {return Ok(StagedPublication{value,details:None});}
    ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled before publication");
    let manifest:Value=serde_json::from_slice(&fs::read(job.staging.path().join("manifest.json"))?)?;
    ensure!(manifest["job_id"]==job.job_id && manifest["source_id"]==job.source.id && manifest["source_sha256"]==job.source.sha256 && manifest["kind"]==job.kind,"Job manifest changed before publication");
    let mut leases=vec![verified_lease(&job.source_path,&job.source.sha256)?];
    let worker_hash=manifest["worker_sha256"].as_str().context("Worker hash missing from job manifest")?.to_string();
    leases.push(verified_lease(&job.worker,&worker_hash)?);
    let pages=value["pages"].as_array().context("Missing source units")?;
    ensure!(pages.len()<=100000,"Too many source units");
    let mut combined=String::new();
    for page in pages {
        let locator=page["locator"].as_str().context("Missing unit locator")?;
        ensure!(locator.len()<=512,"Locator too long");
        let text=page["text"].as_str().context("Missing unit text")?;
        combined.push_str(&format!("[{locator}]\n{text}\n\n"));
        ensure!(combined.len()<=10*1024*1024,"Extract exceeds indexing limit");
    }
    let raw=serde_json::to_vec(&value)?;let raw_hash=digest(&raw);
    let raw_path=format!("artifacts/{raw_hash}.json");
    let raw_destination=job.case_root.join(&raw_path);
    publish_bytes(&raw_destination,&raw,&raw_hash)?;
    leases.push(verified_lease(&raw_destination,&raw_hash)?);
    let previews=value["previews"].as_array().context("Missing preview manifest")?;
    ensure!(previews.len()<=if job.kind=="redaction" {501}else if ["video_ocr","video_overview"].contains(&job.kind.as_str()){180}else{24},"Too many image artifacts");
    let staging_root=job.staging.path().canonicalize()?;
    let mut staged_previews=Vec::new();
    for entry in previews {
        ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled during publication");
        let relative_path=entry["path"].as_str().context("Preview missing path")?;
        ensure!(crate::case::safe_relative(Path::new(relative_path)),"Invalid preview path");
        let preview=job.staging.path().join(relative_path);
        ensure!(preview.canonicalize()?.starts_with(&staging_root),"Preview escaped job directory");
        ensure!(preview.is_file() && preview.metadata()?.len()<=if job.kind=="playback"{16*1024*1024*1024}else{30*1024*1024},"Invalid preview artifact");
        ensure!(!fs::symlink_metadata(&preview)?.file_type().is_symlink(),"Worker returned a link");
        let preview_lease=read_lease(&preview)?;
        let hash=leased_hash(&preview_lease)?;
        let mime=if job.kind=="playback" {"video/mp4"} else if job.kind=="media_clip" {"audio/wav"} else if job.kind=="redaction" && entry["mime"]=="application/pdf" {"application/pdf"} else {"image/jpeg"};
        let ext=crate::artifact_registry::extension_for_mime(mime).context("Unregistered artifact format")?;
        let relative=format!("artifacts/{hash}.{ext}");
        let destination=job.case_root.join(&relative);
        publish_file_cancellable(&preview,&destination,&hash,&job.staging.path().join("cancel.request"))?;
        leases.push(verified_lease(&destination,&hash)?);
        staged_previews.push(StagedPreview{hash,mime:mime.into(),relative});
    }
    let journal=json!({"version":1,"job_id":job.job_id,"source_id":job.source.id,"source_sha256":job.source.sha256,"raw":{"path":raw_path,"sha256":raw_hash},"previews":staged_previews.iter().map(|preview|json!({"path":preview.relative,"sha256":preview.hash})).collect::<Vec<_>>()});
    let journal_path=job.staging.path().join("publication-journal.json");
    let mut journal_file=fs::File::create(&journal_path)?;
    std::io::Write::write_all(&mut journal_file,serde_json::to_string(&journal)?.as_bytes())?;
    journal_file.sync_all()?;
    ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled before registration");
    Ok(StagedPublication{value,details:Some(StageDetails{combined,raw_hash,raw_path,previews:staged_previews,worker_hash,_leases:leases})})
}
pub fn publish_staged(case:&mut Case,job:&PreparedJob,staged:Result<StagedPublication>)->Result<Value> {
    let result=match staged {Ok(staged)=>publish_core(case,job,Ok(staged.value),staged.details),Err(error)=>publish_core(case,job,Err(error),None)};
    if let Err(error)=&result {
        if case.root==job.case_root {
            case.db.execute("UPDATE processing_jobs SET status=?,error=? WHERE id=? AND status='running'",params![if job.staging.path().join("cancel.request").exists(){"cancelled"}else{"failed"},error.to_string(),job.job_id])?;
        }
    }
    result
}
pub fn publish_prepared(case:&mut Case,job:&PreparedJob,output:Result<Value>)->Result<Value> {
    publish_core(case,job,output,None)
}
fn publish_core(case:&mut Case,job:&PreparedJob,output:Result<Value>,staged:Option<StageDetails>)->Result<Value> {
    if job.cached.is_some() {return output;}
    ensure!(case.root==job.case_root,"Case changed before publication");
    let source=&job.source;let source_id=source.id.as_str();let kind=job.kind.as_str();
    let worker=&job.worker;let staging=&job.staging;let request=&job.request;let job_id=&job.job_id;
    if staged.is_some() {
        let current=case.source(source_id)?;
        ensure!(current.sha256==source.sha256,"Source changed before publication");
        if request["operation"]=="automatic" || ["video_ocr","video_overview","media_clip"].contains(&kind) || request["operation"]=="frame_at" {ensure!(!current.restricted,"Source was restricted before publication");}
        if ["video","video_ocr","video_overview","pdf_probe","pdf_page","media_clip","sound_events","office_image"].contains(&kind) || request["operation"]=="frame_at" {
            let epoch=case.meta(&format!("source_policy_epoch:{source_id}"))?.and_then(|raw|raw.parse::<u64>().ok()).unwrap_or(0);
            ensure!(request["source_lease_epoch"].as_u64()==Some(epoch),"Source policy changed before discovery publication");
        }
        let (registered_source,status):(String,String)=case.db.query_row("SELECT source_id,status FROM processing_jobs WHERE id=?",[job_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        ensure!(registered_source==source_id && status=="running","Processing job changed before publication");
        let journal_path=staging.path().join("publication-journal.json");
        ensure!(journal_path.is_file() && journal_path.metadata()?.len()<=100000,"Publication journal is missing or invalid");
        let journal:Value=serde_json::from_slice(&fs::read(journal_path)?)?;
        let staged=staged.as_ref().expect("checked staged publication");
        ensure!(journal["version"]==1 && journal["job_id"]==*job_id && journal["source_id"]==source.id && journal["source_sha256"]==source.sha256 && journal["raw"]["path"]==staged.raw_path && journal["raw"]["sha256"]==staged.raw_hash,"Publication journal changed");
        ensure!(journal["previews"].as_array().is_some_and(|entries|entries.len()==staged.previews.len() && entries.iter().zip(&staged.previews).all(|(entry,preview)|entry["path"]==preview.relative && entry["sha256"]==preview.hash)),"Publication journal previews changed");
    }
    case.db.execute_batch("SAVEPOINT publish_processor")?;
    let execute=(||->Result<Value> {
        ensure!(!job.staging.path().join("cancel.request").exists(),"Processing cancelled before publication");
        let value=output?;
        let (combined,raw_hash,raw_path)=if let Some(staged)=staged.as_ref() {
            (staged.combined.clone(),staged.raw_hash.clone(),staged.raw_path.clone())
        } else {
            let pages = value["pages"].as_array().context("Missing source units")?;
            ensure!(pages.len() <= 100000, "Too many source units");
            let mut combined = String::new();
            for page in pages {
                let locator = page["locator"].as_str().context("Missing unit locator")?;
                ensure!(locator.len() <= 512, "Locator too long");
                let text = page["text"].as_str().context("Missing unit text")?;
                combined.push_str(&format!("[{locator}]\n{text}\n\n"));
                ensure!(combined.len()<=10*1024*1024,"Extract exceeds indexing limit");
            }
            let raw=serde_json::to_vec(&value)?;let raw_hash=digest(&raw);
            let raw_path=format!("artifacts/{raw_hash}.json");
            publish_bytes(&case.root.join(&raw_path),&raw,&raw_hash)?;
            (combined,raw_hash,raw_path)
        };
        let mut result = value.clone();
        let previews = value["previews"]
            .as_array()
            .context("Missing preview manifest")?;
        ensure!(previews.len() <= if kind=="redaction" {501}else if ["video_ocr","video_overview"].contains(&kind) {180}else{24}, "Too many image artifacts");
        if let Some(staged)=staged.as_ref(){ensure!(staged.previews.len()==previews.len(),"Staged preview count changed");}
        let mut published = Vec::new();
        for (index,entry) in previews.iter().enumerate() {
            let (hash,mime,relative)=if let Some(staged)=staged.as_ref() {
                let preview=staged.previews.get(index).context("Staged preview count changed")?;
                (preview.hash.clone(),preview.mime.clone(),preview.relative.clone())
            } else {
                let relative_path=entry["path"].as_str().context("Preview missing path")?;
                ensure!(crate::case::safe_relative(Path::new(relative_path)),"Invalid preview path");
                let preview=staging.path().join(relative_path);
                ensure!(preview.canonicalize()?.starts_with(staging.path().canonicalize()?),"Preview escaped job directory");
                ensure!(preview.is_file() && preview.metadata()?.len()<=if kind=="playback"{16*1024*1024*1024}else{30*1024*1024},"Invalid preview artifact");
                ensure!(!fs::symlink_metadata(&preview)?.file_type().is_symlink(),"Worker returned a link");
                let hash=file_hash(&preview)?;
                let mime=if kind=="playback" {"video/mp4"}else if kind=="media_clip" {"audio/wav"}else if kind=="redaction" && entry["mime"]=="application/pdf" {"application/pdf"}else{"image/jpeg"};
                let ext=crate::artifact_registry::extension_for_mime(mime).context("Unregistered artifact format")?;
                let relative=format!("artifacts/{hash}.{ext}");
                publish_file(&preview,&case.root.join(&relative),&hash)?;
                (hash,mime.into(),relative)
            };
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
                json!({"kind":kind,"worker_sha256":if let Some(staged)=staged.as_ref(){staged.worker_hash.clone()}else{file_hash(&worker)?},"request":request})
                    .to_string(),
                now()
            ],
        )?;
        result["extraction_locator"] = json!(format!(
            "evidence:{source_id}#artifact:{extraction_artifact}"
        ));
        if !combined.is_empty() && !["sound_events","redaction","diarization","video_ocr","video_overview","pdf_probe","pdf_page","media_clip","office_image"].contains(&kind) {
            // Every extraction appends an immutable revision; it becomes the
            // active searchable text only when no extraction is active yet
            // (full-recording transcription supersedes partials separately).
            let indexed: bool = case.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM extracts WHERE source_id=?)",
                [source_id],
                |r| r.get(0),
            )?;
            case.publish_extract(
                source_id,
                &combined,
                &format!("Sandboxed {kind}; see processing limitations"),
                !indexed,
            )?;
        }
        if !["pdf_probe","pdf_page","media_clip"].contains(&kind) {case.db.execute(
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
        )?;}
        Ok(result)
    })();
    match execute {
        Ok(value)=>{
            case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![value.to_string(),job_id])?;
            // Chunked discovery results are bounded by their own job rows and samples;
            // caching every 60 s chunk in meta would grow the database without reuse.
            if !["redaction","video_ocr","video_overview"].contains(&kind) {let worker_hash=if let Some(staged)=staged.as_ref(){staged.worker_hash.clone()}else{file_hash_cached(worker)?};let cache_key=format!("processor_cache:{}",digest(json!([source.id,source.sha256,worker_hash,request]).to_string().as_bytes()));case.set_meta(&cache_key,&value.to_string())?;}
            case.audit("source_processed",json!({"source":source_id,"job":job_id,"kind":kind,"request":request}))?;
            case.db.execute_batch("RELEASE publish_processor")?;
            // Registered derivatives are authoritative now. Release the duplicate staged original.
            if staged.is_none() {
                let input=job.staging.path().join("input");
                if let (Ok(path),Ok(root))=(input.canonicalize(),case.root.join("staging").canonicalize()) {
                    if path.starts_with(root)&&fs::symlink_metadata(&input).is_ok_and(|m|!m.file_type().is_symlink()) {let _=fs::remove_file(input);}
                }
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

/// Release only the verified duplicate worker input after registration succeeds.
pub fn cleanup_published_input(job:&PreparedJob)->Result<bool> {
    let input=job.staging.path().join("input");
    if !input.exists(){return Ok(false);}
    ensure!(!fs::symlink_metadata(&input)?.file_type().is_symlink(),"Staged input changed to a link");
    let path=input.canonicalize()?;
    ensure!(path.starts_with(job.case_root.join("staging").canonicalize()?),"Staged input escaped case");
    fs::remove_file(input)?;
    Ok(true)
}

pub fn artifact(case: &Case, artifact_id: &str) -> Result<(String, String, PathBuf, Value)> {
    let (source,mime,path,hash,metadata)=artifact_descriptor(case,artifact_id)?;
    ensure!(file_hash_strong(&path)?==hash,"Artifact integrity check failed");
    Ok((source,mime,path,metadata))
}
pub(crate) fn artifact_descriptor(case:&Case,artifact_id:&str)->Result<(String,String,PathBuf,String,Value)> {
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
    Ok((source, mime, path, hash, serde_json::from_str(&metadata)?))
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
pub struct StagedPlayback {result:Value,hash:String,relative:String,_leases:Vec<fs::File>}
pub fn stage_playback(job:&PlaybackJob,result:Result<Value>)->Result<StagedPlayback> {
    let result=result?;
    let preview=job.directory.path().join("playback.mp4");
    ensure!(!fs::symlink_metadata(&preview)?.file_type().is_symlink() && preview.is_file(),"Invalid playback artifact");
    ensure!(preview.metadata()?.len()<=16*1024*1024*1024,"Playback artifact too large");
    let source=verified_lease(&job.input_path,&job.expected_hash)?;
    let original=read_lease(&preview)?;let hash=leased_hash(&original)?;
    let relative=format!("artifacts/{hash}.mp4");
    let root=job.directory.path().parent().context("Missing playback staging parent")?.parent().context("Missing case root")?;
    let destination=root.join(&relative);
    publish_file_cancellable(&preview,&destination,&hash,&job.directory.path().join("cancel.request"))?;
    let output=verified_lease(&destination,&hash)?;
    let journal=json!({"version":1,"job_id":job.id,"source_id":job.source,"source_sha256":job.expected_hash,"path":relative,"sha256":hash});
    let mut file=fs::File::create(job.directory.path().join("publication-journal.json"))?;
    std::io::Write::write_all(&mut file,journal.to_string().as_bytes())?;file.sync_all()?;
    Ok(StagedPlayback{result,hash,relative,_leases:vec![source,original,output]})
}
pub fn publish_staged_playback(case:&mut Case,job:&PlaybackJob,staged:Result<StagedPlayback>)->Result<Value> {
    let staged=match staged {Ok(value)=>value,Err(error)=>return publish_playback(case,job,Err(error))};
    ensure!(case.meta("id")?.as_deref()==Some(&job.case_id),"Case changed during playback processing");
    let source=case.source(&job.source)?;ensure!(source.sha256==job.expected_hash,"Source changed during playback processing");
    let state:String=case.db.query_row("SELECT status FROM processing_jobs WHERE id=? AND source_id=?",params![job.id,job.source],|r|r.get(0))?;
    ensure!(state=="running","Playback job changed before publication");
    let journal_path=job.directory.path().join("publication-journal.json");
    ensure!(journal_path.metadata()?.len()<=100000,"Invalid playback journal");
    let journal:Value=serde_json::from_slice(&fs::read(journal_path)?)?;
    ensure!(journal["version"]==1 && journal["job_id"]==job.id && journal["source_id"]==job.source && journal["source_sha256"]==job.expected_hash && journal["path"]==staged.relative && journal["sha256"]==staged.hash,"Playback journal changed");
    ensure!(!job.directory.path().join("cancel.request").exists(),"Playback cancelled before publication");
    case.db.execute_batch("SAVEPOINT playback_staged_publication")?;
    let publish=(||->Result<Value>{
        let artifact=id();
        case.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",params![artifact,job.source,staged.hash,"video/mp4",staged.relative,staged.result["metadata"].to_string(),now()])?;
        case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![staged.result.to_string(),job.id])?;
        case.audit("playback_created",json!({"source":job.source,"artifact":artifact,"sha256":staged.hash}))?;
        Ok(json!({"artifact_id":artifact}))
    })();
    if let Err(ref error)=publish {case.db.execute_batch("ROLLBACK TO playback_staged_publication; RELEASE playback_staged_publication")?;case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![error.to_string(),job.id])?;} else {case.db.execute_batch("RELEASE playback_staged_publication")?;}
    publish
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
    fn automatic_office_work_keeps_background_priority_after_normalizing_request() {
        let dir=tempfile::tempdir().unwrap();
        let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/notes.docx");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic automatic office work").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source_id=case.sources().unwrap()[0].id.clone();
        let job=prepare_request(&mut case,&source_id,json!({"operation":"automatic"})).unwrap();
        assert_eq!(job.request["scheduler_priority"],"background");
        assert!(job.request.get("operation").is_none());
    }
    #[test]
    fn email_originals_get_a_pending_status_and_a_sandboxed_email_request() {
        let dir=tempfile::tempdir().unwrap();
        let source=dir.path().join("Door alarm (SYNTHETIC).eml");
        fs::write(&source,b"From: facilities@synthetic.invalid\r\nTo: review@synthetic.invalid\r\nSubject: Alarm log (SYNTHETIC)\r\n\r\nTwo openings.\r\n").unwrap();
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic email").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let imported=case.sources().unwrap().remove(0);
        assert_eq!(imported.status,"viewer available · extraction pending");
        let job=prepare_request(&mut case,&imported.id,json!({"operation":"automatic"})).unwrap();
        assert_eq!(job.request["kind"],"email");
        assert!(job.request.get("operation").is_none());
    }
    fn staged_fixture()->(tempfile::TempDir,Case,PreparedJob,StagedPublication) {
        let dir=tempfile::tempdir().unwrap();
        let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic staged publication").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source_id=case.sources().unwrap().into_iter().find(|item|item.kind=="video").unwrap().id;
        let job=prepare_request(&mut case,&source_id,json!({"operation":"playback","test":true})).unwrap();
        fs::write(job.staging.path().join("preview.mp4"),b"synthetic derivative").unwrap();
        let staged=stage_prepared(&job,Ok(json!({"pages":[],"previews":[{"path":"preview.mp4","mime":"video/mp4"}]}))).unwrap();
        (dir,case,job,staged)
    }
    #[test]
    fn staged_publication_rejects_cancel_and_duplicate_commit() {
        let (_dir,mut case,job,staged)=staged_fixture();
        fs::write(job.staging.path().join("cancel.request"),b"cancel").unwrap();
        assert!(publish_staged(&mut case,&job,Ok(staged)).is_err());
        let count:i64=case.db.query_row("SELECT count(*) FROM artifacts WHERE source_id=?",[&job.source.id],|r|r.get(0)).unwrap();
        assert_eq!(count,0);
        fs::remove_file(job.staging.path().join("cancel.request")).unwrap();
        let staged=stage_prepared(&job,Ok(json!({"pages":[],"previews":[{"path":"preview.mp4","mime":"video/mp4"}]}))).unwrap();
        assert!(publish_staged(&mut case,&job,Ok(staged)).is_err());
    }
    #[test]
    fn staged_publication_requires_exact_journal_and_once_only_registration() {
        let (_dir,mut case,job,staged)=staged_fixture();
        let journal=job.staging.path().join("publication-journal.json");
        let original=fs::read(&journal).unwrap();
        fs::write(&journal,b"{}").unwrap();
        assert!(publish_staged(&mut case,&job,Ok(staged)).is_err());
        fs::write(&journal,original).unwrap();
        let recovered=resume(&mut case,&job.job_id).unwrap();
        let staged=stage_prepared(&recovered,Ok(json!({"pages":[],"previews":[{"path":"preview.mp4","mime":"video/mp4"}]}))).unwrap();
        publish_staged(&mut case,&recovered,Ok(staged)).unwrap();
        let staged=stage_prepared(&job,Ok(json!({"pages":[],"previews":[{"path":"preview.mp4","mime":"video/mp4"}]}))).unwrap();
        assert!(publish_staged(&mut case,&job,Ok(staged)).is_err());
        let count:i64=case.db.query_row("SELECT count(*) FROM artifacts WHERE source_id=?",[&job.source.id],|r|r.get(0)).unwrap();
        assert_eq!(count,2);
    }
    #[test]
    fn second_opinion_clips_are_bounded_leased_and_published_as_wav() {
        let dir=tempfile::tempdir().unwrap();
        let fixture=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic clip").unwrap();
        case.import_files(&[fixture.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source=case.sources().unwrap().into_iter().find(|item|item.kind=="video").unwrap();
        for (start,end) in [(0.0,31.0),(2.0,1.0),(-1.0,1.0)] {
            assert!(prepare_request(&mut case,&source.id,json!({"operation":"media_clip","start":start,"end":end})).is_err(),"{start}-{end}");
        }
        let job=prepare_request(&mut case,&source.id,json!({"operation":"media_clip","start":0.5,"end":2.0,"track":1})).unwrap();
        assert_eq!(job.kind,"media_clip");
        assert!(job.request["source_lease"].is_string(),"clips read the verified read-only lease, never a full copy");
        fs::write(job.staging.path().join("clip.wav"),b"RIFF synthetic pcm").unwrap();
        let output=json!({"pages":[],"metadata":{"kind":"second_opinion_clip"},"previews":[{"path":"clip.wav","mime":"audio/wav","requested_interval":[0.5,2.0],"origin_seconds":0.0}]});
        let staged=stage_prepared(&job,Ok(output)).unwrap();
        let before_status=case.source(&source.id).unwrap().status;
        let result=publish_staged(&mut case,&job,Ok(staged)).unwrap();
        let clip=result["artifact_id"].as_str().unwrap();
        let (_,mime,path,_)=artifact(&case,clip).unwrap();
        assert_eq!(mime,"audio/wav");
        assert_eq!(path.extension().unwrap(),"wav");
        assert_eq!(case.source(&source.id).unwrap().status,before_status,"a clip does not change the source status");
        let extracts:i64=case.db.query_row("SELECT count(*) FROM extract_revisions WHERE source_id=?",[&source.id],|r|r.get(0)).unwrap();
        assert_eq!(extracts,0,"a clip never becomes searchable source text");
        case.set_restricted(&source.id,true).unwrap();
        assert!(prepare_request(&mut case,&source.id,json!({"operation":"media_clip","start":0.5,"end":2.0})).is_err(),"restricted sources are never clipped");
    }
    #[test]
    fn playback_staging_registers_once_and_keeps_original_bytes() {
        let dir=tempfile::tempdir().unwrap();
        let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic playback").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source=case.sources().unwrap().into_iter().find(|item|item.kind=="video").unwrap();
        let job=prepare_playback(&mut case,&source.id).unwrap();
        fs::write(job.directory.path().join("playback.mp4"),b"synthetic playback").unwrap();
        let staged=stage_playback(&job,Ok(json!({"metadata":{"player_origin_seconds":0}}))).unwrap();
        fs::write(job.directory.path().join("publication-journal.json"),b"{}").unwrap();
        assert!(publish_staged_playback(&mut case,&job,Ok(staged)).is_err());
        let staged=stage_playback(&job,Ok(json!({"metadata":{"player_origin_seconds":0}}))).unwrap();
        let result=publish_staged_playback(&mut case,&job,Ok(staged)).unwrap();
        assert!(artifact(&case,result["artifact_id"].as_str().unwrap()).is_ok());
        assert_eq!(file_hash_strong(&case.source_path(&source.id).unwrap()).unwrap(),source.sha256);
        let staged=stage_playback(&job,Ok(json!({"metadata":{"player_origin_seconds":0}}))).unwrap();
        assert!(publish_staged_playback(&mut case,&job,Ok(staged)).is_err());
    }
    #[test]
    fn artifact_publication_is_idempotent_and_rejects_corrupt_existing_content() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("artifact.json");let content=b"immutable result";let hash=digest(content);
        publish_bytes(&path,content,&hash).unwrap();publish_bytes(&path,content,&hash).unwrap();
        fs::write(&path,b"incomplete old output").unwrap();
        assert!(publish_bytes(&path,content,&hash).is_err());
        assert_eq!(fs::read(&path).unwrap(),b"incomplete old output");
    }
    #[test]
    fn concurrent_identical_derivative_publication_registers_one_good_file() {
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source.bin");let target=dir.path().join("artifact.bin");
        fs::write(&source,vec![7u8;1024*1024]).unwrap();let hash=file_hash(&source).unwrap();
        std::thread::scope(|scope| {
            let first=scope.spawn(||publish_file_cancellable(&source,&target,&hash,&dir.path().join("cancel")));
            let second=scope.spawn(||publish_file_cancellable(&source,&target,&hash,&dir.path().join("cancel")));
            first.join().unwrap().unwrap();second.join().unwrap().unwrap();
        });
        assert_eq!(file_hash(&target).unwrap(),hash);
    }
    #[test]
    fn discovery_jobs_share_one_verified_private_input_until_revoked() {
        let dir=tempfile::tempdir().unwrap();
        let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic source lease").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source_id=case.sources().unwrap().into_iter().find(|item|item.kind=="video").unwrap().id;
        let first=prepare_request(&mut case,&source_id,json!({"operation":"video_ocr","start":0.,"end":60.,"interval":5.})).unwrap();
        let second=prepare_request(&mut case,&source_id,json!({"operation":"video_overview","start":60.,"end":120.,"interval":5.})).unwrap();
        let a=acquire_source_lease(&first).unwrap();let b=acquire_source_lease(&second).unwrap();
        let interval=prepare_request(&mut case,&source_id,json!({"start":0.,"end":5.,"interval":0.5})).unwrap();
        let c=acquire_source_lease(&interval).unwrap();
        assert!(Arc::ptr_eq(&a,&c));assert!(!interval.staging.path().join("input").exists());
        assert!(Arc::ptr_eq(&a,&b));assert!(!first.staging.path().join("input").exists());assert!(!second.staging.path().join("input").exists());
        assert_eq!(file_hash(&a.path).unwrap(),first.source.sha256);
        let path=a.path.clone();case.set_restricted(&source_id,true).unwrap();
        assert!(first.staging.path().join("cancel.request").exists());
        assert_eq!(case.meta(&format!("source_policy_epoch:{source_id}")).unwrap().as_deref(),Some("1"));
        drop(a);drop(b);drop(c);
        assert!(!path.exists());
    }
    #[test]
    #[ignore = "Generates a two-hour synthetic MP4 and measures 240 discovery chunk leases"]
    fn two_hour_recording_lease_writes_one_input_for_both_discovery_passes() {
        let dir=tempfile::tempdir().unwrap();let fixture=dir.path().join("two-hour.mp4");
        let status=std::process::Command::new("ffmpeg").args(["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=black:s=64x64:r=1/60","-t","7200","-c:v","libx264","-preset","ultrafast","-movflags","+faststart","-y"]).arg(&fixture).status().unwrap();
        assert!(status.success());
        let output=std::process::Command::new("ffprobe").args(["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1"]).arg(&fixture).output().unwrap();
        let duration=String::from_utf8(output.stdout).unwrap().trim().parse::<f64>().unwrap();assert!(duration>=7199.,"{duration}");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Two-hour synthetic lease").unwrap();
        case.import_files(&[fixture.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source=case.sources().unwrap().into_iter().find(|item|item.kind=="video").unwrap();
        let started=std::time::Instant::now();let mut copied=0u64;let mut launches=0;
        for minute in 0..120 {
            for operation in ["video_ocr","video_overview"] {
                let job=prepare_request(&mut case,&source.id,json!({"operation":operation,"start":minute as f64*60.,"end":minute as f64*60.+60.,"interval":5.})).unwrap();
                let lease=acquire_source_lease(&job).unwrap();
                if lease.created_by_job==job.job_id {copied+=lease.copied_bytes;}
                launches+=1;
            }
        }
        println!("Two-hour synthetic source bytes={} chunk jobs={} prior per-job copy bytes={} leased copied bytes={} lease setup elapsed_ms={}",source.size,launches,source.size*launches,copied,started.elapsed().as_millis());
        assert_eq!(launches,240);assert_eq!(copied,source.size);
        invalidate_case_leases(&case.root);
    }
    #[test]
    #[ignore = "Measured synthetic publication baseline; writes four 32-MiB derivatives"]
    fn large_derivative_case_lock_baseline() {
        let dir=tempfile::tempdir().unwrap();
        let source=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic publication baseline").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source_id=case.sources().unwrap().into_iter().find(|item|item.kind=="video").unwrap().id;
        let mut spans=Vec::new();
        for marker in 1u8..=4 {
            let job=prepare_request(&mut case,&source_id,json!({"operation":"playback","marker":marker})).unwrap();
            fs::write(job.staging.path().join("preview.mp4"),vec![marker;32*1024*1024]).unwrap();
            let output=json!({"pages":[],"previews":[{"path":"preview.mp4","mime":"video/mp4"}]});
            let staged=stage_prepared(&job,Ok(output)).unwrap();
            let started=std::time::Instant::now();
            publish_staged(&mut case,&job,Ok(staged)).unwrap();
            spans.push(started.elapsed().as_millis());
        }
        spans.sort_unstable();
        println!("Synthetic 32-MiB derivative publication lock spans ms: p50={} p95={} max={}",spans[2],spans[3],spans[3]);
    }
}
