use crate::case::{digest, file_hash, file_hash_cached, id, now, Case, Source};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};

pub struct Job {
    pub id: String,
    pub source: Source,
    pub input: PathBuf,
    pub staging: PathBuf,
    pub worker: PathBuf,
    pub asr_model:String,
}
pub fn enqueue(case: &mut Case, sources: &[String]) -> Result<Value> {
    crate::processing::worker_path()?;
    ensure!(!sources.is_empty() && sources.len()<=10000,"Select between 1 and 10,000 recordings");
    let mut jobs = Vec::new();
    for source_id in sources {
        let source = case.source(source_id)?;
        ensure!(
            ["audio", "video"].contains(&source.kind.as_str()),
            "Only media can be transcribed"
        );
        ensure!(
            source.size <= 16 * 1024 * 1024 * 1024,
            "Recording exceeds 16 GiB limit"
        );
        let existing:Option<(String,String)>=case.db.query_row("SELECT id,status FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status IN ('queued','running','complete') ORDER BY created_at DESC LIMIT 1",[source_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((job, status)) = existing {
            jobs.push(json!({"source_id":source_id,"job_id":job,"status":status}));
            continue;
        }
        let job = id();
        case.db.execute(
            "INSERT INTO processing_jobs VALUES(?,?,'full_audio','queued','{}','',?)",
            params![job, source_id, now()],
        )?;
        jobs.push(json!({"source_id":source_id,"job_id":job,"status":"queued"}));
    }
    case.audit("full_transcriptions_queued", json!({"jobs":jobs}))?;
    Ok(
        json!({"jobs":jobs,"next":"Jobs execute locally in sequence. Use recording_status to check; do other work instead of repeatedly polling."}),
    )
}
pub fn next(case: &mut Case) -> Result<Option<Job>> {
    let running: i64 = case.db.query_row(
        "SELECT count(*) FROM processing_jobs WHERE kind='full_audio' AND status='running'",
        [],
        |r| r.get(0),
    )?;
    if running > 0 {
        return Ok(None);
    }
    let source:Option<String>=case.db.query_row("SELECT source_id FROM processing_jobs WHERE kind='full_audio' AND status='queued' ORDER BY created_at LIMIT 1",[],|r|r.get(0)).optional()?;
    source.map(|source| begin(case, &source)).transpose()
}
pub fn begin(case: &mut Case, source_id: &str) -> Result<Job> {
    let source = case.source(source_id)?;
    ensure!(
        ["video", "audio"].contains(&source.kind.as_str()),
        "Select audio or video"
    );
    ensure!(
        source.size <= 16 * 1024 * 1024 * 1024,
        "Full transcription supports files up to 16 GiB"
    );
    let running: i64 = case.db.query_row(
        "SELECT count(*) FROM processing_jobs WHERE kind='full_audio' AND status='running'",
        [],
        |r| r.get(0),
    )?;
    ensure!(
        running == 0,
        "A full transcription is already running; wait or cancel it"
    );
    let worker = crate::processing::worker_path()?;
    let queued:Option<String>=case.db.query_row("SELECT id FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status='queued' ORDER BY created_at LIMIT 1",[source_id],|r|r.get(0)).optional()?;
    let job = queued.clone().unwrap_or_else(id);
    let staging = case.root.join("staging").join(format!("transcript-{job}"));
    fs::create_dir(&staging)?;
    let asr_model=case.meta("asr_profile")?.unwrap_or_else(||"tiny".into());
    let manifest=json!({"job_id":job,"source_id":source_id,"source_sha256":source.sha256,"worker_sha256":file_hash(&worker)?,"asr_model":asr_model});
    let mut manifest_file=fs::File::create(staging.join("manifest.json"))?;std::io::Write::write_all(&mut manifest_file,manifest.to_string().as_bytes())?;manifest_file.sync_all()?;
    fs::write(
        staging.join("progress.json"),
        json!({"state":"copying","segments":0}).to_string(),
    )?;
    if queued.is_some() {
        case.db.execute(
            "UPDATE processing_jobs SET status='running' WHERE id=?",
            [&job],
        )?;
    } else {
        case.db.execute(
            "INSERT INTO processing_jobs VALUES(?,?,'full_audio','running','{}','',?)",
            params![job, source_id, now()],
        )?;
    }
    case.audit(
        "full_transcription_started",
        json!({"job":job,"source":source_id,"scope":"all audio tracks to EOF","local":true}),
    )?;
    Ok(Job {
        id: job,
        source,
        input: case.source_path(source_id)?,
        staging,
        worker,
        asr_model,
    })
}
pub fn resume(case:&mut Case,job_id:&str)->Result<Job> {
    uuid::Uuid::parse_str(job_id)?;
    let (sid,status):(String,String)=case.db.query_row("SELECT source_id,status FROM processing_jobs WHERE id=? AND kind='full_audio'",[job_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    ensure!(["failed","interrupted"].contains(&status.as_str()),"Only interrupted or failed transcription can resume");
    let running:u64=case.db.query_row("SELECT count(*) FROM processing_jobs WHERE kind='full_audio' AND status='running'",[],|r|r.get(0))?;ensure!(running==0,"Another transcript is running");
    let staging=case.root.join("staging").join(format!("transcript-{job_id}")).canonicalize()?;
    ensure!(staging.starts_with(case.root.join("staging").canonicalize()?)&&!staging.join("cancel.request").exists(),"Invalid or cancelled checkpoint");
    let manifest:Value=serde_json::from_slice(&fs::read(staging.join("manifest.json"))?)?;
    let source=case.source(&sid)?;let worker=crate::processing::worker_path()?;
    ensure!(!source.restricted&&manifest["job_id"]==job_id&&manifest["source_id"]==sid&&manifest["source_sha256"]==source.sha256&&manifest["worker_sha256"]==file_hash_cached(&worker)?,"Checkpoint provenance changed; create a new transcription");
    let asr_model=manifest["asr_model"].as_str().context("Missing checkpoint model")?.to_string();
    case.db.execute("UPDATE processing_jobs SET status='running',error='' WHERE id=?",[job_id])?;
    case.audit("transcription_resumed",json!({"job":job_id,"asr_model":asr_model}))?;
    Ok(Job{id:job_id.into(),input:case.source_path(&sid)?,source,staging,worker,asr_model})
}
pub fn run(job: &Job) -> Result<Value> {
    {
        use std::io::{Read,Write};use sha2::{Digest,Sha256};
        let mut input=fs::File::open(&job.input)?;let mut output=fs::File::create(job.staging.join("input"))?;
        let mut buffer=vec![0u8;1024*1024];let mut hash=Sha256::new();
        loop {anyhow::ensure!(!job.staging.join("cancel.request").exists(),"Transcription cancelled while copying input");let n=input.read(&mut buffer)?;if n==0{break;}hash.update(&buffer[..n]);output.write_all(&buffer[..n])?;}
        output.sync_all()?;
        anyhow::ensure!(format!("{:x}",hash.finalize())==job.source.sha256,"Source changed while preparing transcription");
    }
    fs::write(
        job.staging.join("progress.json"),
        json!({"state":"initializing","segments":0}).to_string(),
    )?;
    fs::write(
        job.staging.join("request.json"),
        json!({"version":1,"kind":"full_audio","asr_model":job.asr_model}).to_string(),
    )?;
    #[cfg(windows)]
    crate::sandbox::run_worker(&job.worker, &job.staging, Duration::from_secs(7200))?;
    #[cfg(not(windows))]
    anyhow::bail!("AppContainer is required");
    let output = job.staging.join("result.json");
    ensure!(
        output.metadata()?.len() <= 64 * 1024 * 1024,
        "Transcript result exceeds 64 MiB"
    );
    let value: Value = serde_json::from_slice(&fs::read(output)?)?;
    ensure!(
        value["version"] == 1 && value["status"] == "complete",
        "{}",
        value["error"]
            .as_str()
            .unwrap_or("Incomplete transcription")
    );
    Ok(value)
}
fn timestamp(seconds: f64, srt: bool) -> String {
    let ms = (seconds.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}{}{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        if srt { ',' } else { '.' },
        ms % 1000
    )
}
pub fn publish(case: &mut Case, job: &Job, value: Value) -> Result<Value> {
    ensure!(!job.staging.join("cancel.request").exists(),"Transcription cancelled before publication");
    let source=case.source(&job.source.id)?;ensure!(!source.restricted&&source.sha256==job.source.sha256,"Source permission or integrity changed");
    let state:String=case.db.query_row("SELECT status FROM processing_jobs WHERE id=?",[&job.id],|r|r.get(0))?;ensure!(state=="running","Transcription is no longer active");
    let pages = value["pages"]
        .as_array()
        .context("Transcript segments missing")?;
    ensure!(pages.len() <= 100000, "Too many transcript segments");
    let raw = serde_json::to_vec_pretty(&value)?;
    let raw_hash = digest(&raw);
    let raw_path = format!("artifacts/{raw_hash}.json");
    let artifact = id();
    let locator = format!("evidence:{}#artifact:{artifact}", job.source.id);
    let mut text=format!("# Full transcript: {}\n\nUNREVIEWED MACHINE TRANSCRIPTION · local {} model\nSource SHA-256: {}\nEvidence: {locator}\n\n",job.source.name,job.asr_model,job.source.sha256);
    if value["metadata"]["no_audio_tracks"] == true {
        text.push_str("No audio tracks were found in this container. No speech transcript can be produced; visual events remain unreviewed.\n");
    }
    if let Some(notes) = value["limitations"].as_array() {
        for note in notes {
            text.push_str(&format!("- {}\n", note.as_str().unwrap_or("")));
        }
    }
    text.push_str("\n");
    let mut srt_by_track = std::collections::BTreeMap::<u64, String>::new();
    let mut count_by_track = std::collections::BTreeMap::<u64, usize>::new();
    for segment in pages {
        let start = segment["start"].as_f64().context("Missing segment start")?;
        let end = segment["end"].as_f64().context("Missing segment end")?;
        ensure!(
            start.is_finite() && end.is_finite() && end >= start && start >= 0.0 && end <= 43205.0,
            "Invalid transcript interval"
        );
        let track = segment["track"].as_u64().context("Missing track")?;
        let content = segment["text"].as_str().context("Missing speech text")?;
        text.push_str(&format!(
            "[track {track} · {} → {}] {content}\n\n",
            timestamp(start, false),
            timestamp(end, false)
        ));
        let number = count_by_track.entry(track).or_default();
        *number += 1;
        srt_by_track.entry(track).or_default().push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            number,
            timestamp(start, true),
            timestamp(end, true),
            content
        ));
    }
    ensure!(
        text.len() <= 1024 * 1024,
        "Transcript exceeds editable record size limit; raw job output retained"
    );
    let safe_name: String = job
        .source
        .name
        .chars()
        .take(80)
        .map(|c| {
            if c.is_ascii_alphanumeric() || ".-_".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = format!("{safe_name}-{}-{}", &job.source.id[..8], &job.id[..8]);
    let directory = case.root.join("working/transcripts");
    fs::create_dir_all(&directory)?;
    let mut files = vec![
        (raw_path.clone(), raw, "application/json".to_string()),
        (
            format!("working/transcripts/{stem}.txt"),
            text.as_bytes().to_vec(),
            "text/plain".into(),
        ),
    ];
    files.push((
        format!("working/transcripts/{stem}.json"),
        serde_json::to_vec_pretty(&value)?,
        "application/json".into(),
    ));
    for (track, srt) in srt_by_track {
        files.push((
            format!("working/transcripts/{stem}.track-{track}.srt"),
            srt.into_bytes(),
            "application/x-subrip".into(),
        ));
    }
    // Atomic individual files first; the database transaction publishes references together.
    for (relative, bytes, _) in &files {
        let destination = case.root.join(relative);
        if !destination.exists() {
            let mut temp = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
            std::io::Write::write_all(&mut temp, bytes)?;
            temp.as_file().sync_all()?;
            temp.persist_noclobber(&destination)?;
        }
        ensure!(
            file_hash(&destination)? == digest(bytes),
            "Transcript publication hash mismatch"
        );
    }
    case.db.execute_batch("SAVEPOINT full_transcript_publish")?;
    let result = (|| -> Result<Value> {
        for (index, (relative, bytes, mime)) in files.iter().enumerate() {
            case.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",params![if index==0{artifact.clone()}else{id()},job.source.id,digest(bytes),mime,relative,json!({"kind":"full_audio","job":job.id,"worker_sha256":file_hash(&job.worker)?}).to_string(),now()])?;
        }
        let record = case.write_record(
            None,
            0,
            &format!(
                "Full transcript · {}",
                job.source.name.chars().take(170).collect::<String>()
            ),
            "transcript",
            &text,
            "processor",
            "All audio tracks decoded to EOF; unreviewed machine transcription",
            None,
            vec![job.source.id.clone()],
        )?;
        // A completed full-recording transcription supersedes any older partial
        // extraction: it always becomes the active searchable text, and the
        // previous wording remains retrievable as an immutable revision.
        case.publish_extract(&job.source.id, &text, "Full local machine transcription; unreviewed", true)?;
        case.db.execute(
            "UPDATE sources SET status=? WHERE id=?",
            params![
                if value["metadata"]["no_audio_tracks"] == true {
                    "no audio tracks · visual review pending"
                } else {
                    "text transcribed · all audio tracks · unreviewed"
                },
                job.source.id
            ],
        )?;
        case.db
            .execute("UPDATE records SET stale=1 WHERE (actor<>'processor' OR kind<>'transcript') AND id<>?", [&record.id])?;
        case.db.execute(
            "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'",
            [],
        )?;
        let result = json!({"job_id":job.id,"record_id":record.id,"locator":locator,"segments":pages.len(),"metadata":value["metadata"],"saved_files":files.iter().skip(1).map(|(path,_,_)|path).collect::<Vec<_>>()});
        case.db.execute(
            "UPDATE processing_jobs SET status='complete',result=? WHERE id=?",
            params![result.to_string(), job.id],
        )?;
        case.audit("full_transcription_completed", result.clone())?;
        Ok(result)
    })();
    if result.is_err() {
        case.db
            .execute_batch("ROLLBACK TO full_transcript_publish")?;
    }
    case.db.execute_batch("RELEASE full_transcript_publish")?;
    result
}
struct TranscriptFile {relative:String,hash:String,mime:String}
pub struct StagedTranscript {
    value:Value,text:String,files:Vec<TranscriptFile>,artifact:String,locator:String,worker_hash:String,
    _leases:Vec<fs::File>,
}
/// Build and verify transcript derivatives before acquiring the case mutex.
pub fn stage_transcript(job:&Job,value:Value)->Result<StagedTranscript> {
    ensure!(!job.staging.join("cancel.request").exists(),"Transcription cancelled before publication");
    let manifest:Value=serde_json::from_slice(&fs::read(job.staging.join("manifest.json"))?)?;
    ensure!(manifest["job_id"]==job.id && manifest["source_id"]==job.source.id && manifest["source_sha256"]==job.source.sha256,"Transcription manifest changed");
    let worker_hash=manifest["worker_sha256"].as_str().context("Missing worker hash")?.to_string();
    let mut leases=vec![crate::processing::verified_lease(&job.input,&job.source.sha256)?,crate::processing::verified_lease(&job.worker,&worker_hash)?];
    let pages=value["pages"].as_array().context("Transcript segments missing")?;
    ensure!(pages.len()<=100000,"Too many transcript segments");
    let raw=serde_json::to_vec_pretty(&value)?;let raw_hash=digest(&raw);
    let artifact=job.id.clone();let locator=format!("evidence:{}#artifact:{artifact}",job.source.id);
    let mut text=format!("# Full transcript: {}\n\nUNREVIEWED MACHINE TRANSCRIPTION · local {} model\nSource SHA-256: {}\nEvidence: {locator}\n\n",job.source.name,job.asr_model,job.source.sha256);
    if value["metadata"]["no_audio_tracks"]==true {text.push_str("No audio tracks were found in this container. No speech transcript can be produced; visual events remain unreviewed.\n");}
    if let Some(notes)=value["limitations"].as_array(){for note in notes{text.push_str(&format!("- {}\n",note.as_str().unwrap_or("")));}}
    text.push('\n');
    let mut srt_by_track=std::collections::BTreeMap::<u64,String>::new();
    let mut count_by_track=std::collections::BTreeMap::<u64,usize>::new();
    for segment in pages {
        let start=segment["start"].as_f64().context("Missing segment start")?;
        let end=segment["end"].as_f64().context("Missing segment end")?;
        ensure!(start.is_finite()&&end.is_finite()&&end>=start&&start>=0.&&end<=43205.,"Invalid transcript interval");
        let track=segment["track"].as_u64().context("Missing track")?;
        let content=segment["text"].as_str().context("Missing speech text")?;
        text.push_str(&format!("[track {track} · {} → {}] {content}\n\n",timestamp(start,false),timestamp(end,false)));
        let number=count_by_track.entry(track).or_default();*number+=1;
        srt_by_track.entry(track).or_default().push_str(&format!("{}\n{} --> {}\n{}\n\n",number,timestamp(start,true),timestamp(end,true),content));
    }
    ensure!(text.len()<=1024*1024,"Transcript exceeds editable record size limit; raw job output retained");
    let safe_name:String=job.source.name.chars().take(80).map(|c|if c.is_ascii_alphanumeric()||".-_".contains(c){c}else{'_'}).collect();
    let stem=format!("{safe_name}-{}-{}",&job.source.id[..8],&job.id[..8]);
    let case_root=job.staging.parent().context("Missing staging parent")?.parent().context("Missing case root")?;
    fs::create_dir_all(case_root.join("working/transcripts"))?;
    let mut contents=vec![(format!("artifacts/{raw_hash}.json"),raw,"application/json".to_string()),(format!("working/transcripts/{stem}.txt"),text.as_bytes().to_vec(),"text/plain".into()),(format!("working/transcripts/{stem}.json"),serde_json::to_vec_pretty(&value)?,"application/json".into())];
    for (track,srt) in srt_by_track {contents.push((format!("working/transcripts/{stem}.track-{track}.srt"),srt.into_bytes(),"application/x-subrip".into()));}
    let mut files=Vec::new();
    for (relative,bytes,mime) in contents {
        ensure!(!job.staging.join("cancel.request").exists(),"Transcription cancelled during publication");
        let hash=digest(&bytes);let destination=case_root.join(&relative);
        if !destination.exists(){let mut temp=tempfile::NamedTempFile::new_in(destination.parent().context("Missing transcript directory")?)?;std::io::Write::write_all(&mut temp,&bytes)?;temp.as_file().sync_all()?;temp.persist_noclobber(&destination)?;}
        leases.push(crate::processing::verified_lease(&destination,&hash)?);
        files.push(TranscriptFile{relative,hash,mime});
    }
    let journal=json!({"version":1,"job_id":job.id,"source_id":job.source.id,"source_sha256":job.source.sha256,"files":files.iter().map(|f|json!({"path":f.relative,"sha256":f.hash})).collect::<Vec<_>>()});
    let mut journal_file=fs::File::create(job.staging.join("publication-journal.json"))?;
    std::io::Write::write_all(&mut journal_file,journal.to_string().as_bytes())?;journal_file.sync_all()?;
    Ok(StagedTranscript{value,text,files,artifact,locator,worker_hash,_leases:leases})
}
pub fn publish_staged_transcript(case:&mut Case,job:&Job,staged:StagedTranscript)->Result<Value> {
    ensure!(!job.staging.join("cancel.request").exists(),"Transcription cancelled before publication");
    ensure!(job.staging.parent().and_then(|p|p.parent())==Some(case.root.as_path()),"Case changed before transcription publication");
    let source=case.source(&job.source.id)?;ensure!(!source.restricted&&source.sha256==job.source.sha256,"Source permission or integrity changed");
    let state:String=case.db.query_row("SELECT status FROM processing_jobs WHERE id=? AND source_id=?",params![job.id,job.source.id],|r|r.get(0))?;ensure!(state=="running","Transcription is no longer active");
    let journal_path=job.staging.join("publication-journal.json");ensure!(journal_path.metadata()?.len()<=100000,"Invalid transcript journal");
    let journal:Value=serde_json::from_slice(&fs::read(journal_path)?)?;
    ensure!(journal["version"]==1&&journal["job_id"]==job.id&&journal["source_id"]==job.source.id&&journal["source_sha256"]==job.source.sha256,"Transcription journal changed");
    ensure!(journal["files"].as_array().is_some_and(|items|items.len()==staged.files.len()&&items.iter().zip(&staged.files).all(|(item,file)|item["path"]==file.relative&&item["sha256"]==file.hash)),"Transcription journal files changed");
    case.db.execute_batch("SAVEPOINT staged_transcript_publish")?;
    let result=(||->Result<Value>{
        for (index,file) in staged.files.iter().enumerate(){case.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",params![if index==0{staged.artifact.clone()}else{id()},job.source.id,file.hash,file.mime,file.relative,json!({"kind":"full_audio","job":job.id,"worker_sha256":staged.worker_hash}).to_string(),now()])?;}
        let record=case.write_record(None,0,&format!("Full transcript · {}",job.source.name.chars().take(170).collect::<String>()),"transcript",&staged.text,"processor","All audio tracks decoded to EOF; unreviewed machine transcription",None,vec![job.source.id.clone()])?;
        case.publish_extract(&job.source.id,&staged.text,"Full local machine transcription; unreviewed",true)?;
        case.db.execute("UPDATE sources SET status=? WHERE id=?",params![if staged.value["metadata"]["no_audio_tracks"]==true{"no audio tracks · visual review pending"}else{"text transcribed · all audio tracks · unreviewed"},job.source.id])?;
        case.db.execute("UPDATE records SET stale=1 WHERE (actor<>'processor' OR kind<>'transcript') AND id<>?",[&record.id])?;
        case.db.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'",[])?;
        let receipt=json!({"job_id":job.id,"record_id":record.id,"locator":staged.locator,"segments":staged.value["pages"].as_array().map_or(0,Vec::len),"metadata":staged.value["metadata"],"saved_files":staged.files.iter().skip(1).map(|file|&file.relative).collect::<Vec<_>>()});
        case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![receipt.to_string(),job.id])?;
        case.audit("full_transcription_completed",receipt.clone())?;
        Ok(receipt)
    })();
    if result.is_err(){case.db.execute_batch("ROLLBACK TO staged_transcript_publish")?;}
    case.db.execute_batch("RELEASE staged_transcript_publish")?;
    result
}
pub fn fail(case: &mut Case, job: &Job, error: &str) -> Result<()> {
    case.db.execute(
        "UPDATE processing_jobs SET status='failed',error=? WHERE id=?",
        params![error, job.id],
    )?;
    case.audit(
        "full_transcription_failed",
        json!({"job":job.id,"source":job.source.id,"error":error}),
    )?;
    Ok(())
}
pub fn status(case: &Case, source: &str) -> Result<Value> {
    case.source(source)?;
    let row:Option<(String,String,String,String)>=case.db.query_row("SELECT id,status,result,error FROM processing_jobs WHERE source_id=? AND kind='full_audio' ORDER BY created_at DESC LIMIT 1",[source],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((job, state, result, error)) = row else {
        return Ok(Value::Null);
    };
    let progress_path = case
        .root
        .join("staging")
        .join(format!("transcript-{job}"))
        .join("progress.json");
    let progress = if progress_path.metadata().is_ok_and(|m| m.len() < 65536) {
        fs::read(progress_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let result: Value = serde_json::from_str(&result)?;
    let record = if let Some(record) = result["record_id"].as_str() {
        Some(case.record(record)?)
    } else {
        None
    };
    Ok(
        json!({"job_id":job,"status":state,"progress":progress,"result":result,"error":error,"record":record}),
    )
}
#[cfg(test)]
mod staging_tests {
    use super::*;
    #[test]
    fn staged_transcript_is_recoverable_and_registers_once() {
        let dir=tempfile::tempdir().unwrap();
        let input=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic transcript").unwrap();
        case.import_files(&[input.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source=case.sources().unwrap().into_iter().find(|s|s.kind=="video").unwrap();
        let job=begin(&mut case,&source.id).unwrap();
        let value=json!({"pages":[{"start":0.0,"end":1.0,"track":0,"text":"Test speech"}],"metadata":{},"limitations":[]});
        let staged=stage_transcript(&job,value.clone()).unwrap();
        let journal=job.staging.join("publication-journal.json");
        fs::write(&journal,b"{}").unwrap();
        assert!(publish_staged_transcript(&mut case,&job,staged).is_err());
        let staged=stage_transcript(&job,value.clone()).unwrap();
        let receipt=publish_staged_transcript(&mut case,&job,staged).unwrap();
        assert_eq!(receipt["segments"],1);
        assert_eq!(case.record(receipt["record_id"].as_str().unwrap()).unwrap().content.contains("Test speech"),true);
        let staged=stage_transcript(&job,value).unwrap();
        assert!(publish_staged_transcript(&mut case,&job,staged).is_err());
    }
}
pub fn cancel(case: &Case, source: &str) -> Result<()> {
    if case.db.execute("UPDATE processing_jobs SET status='cancelled',error='Cancelled by user' WHERE source_id=? AND kind='full_audio' AND status='queued'",[source])?>0{return Ok(())}
    let job:String=case.db.query_row("SELECT id FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status='running'",[source],|r|r.get(0))?;
    fs::write(
        case.root
            .join("staging")
            .join(format!("transcript-{job}"))
            .join("cancel.request"),
        b"cancel",
    )?;
    Ok(())
}
