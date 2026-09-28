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
        let existing:Option<(String,String)>=case.db.query_row("SELECT id,status FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status IN ('queued','running','complete') ORDER BY rowid DESC LIMIT 1",[source_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
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
        crate::processing::ensure_copy_capacity(&job.staging,job.source.size)?;
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
    value:Value,text:String,record_text:String,files:Vec<TranscriptFile>,artifact:String,locator:String,worker_hash:String,
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
    let record_text=if text.len()>64*1024 {
        format!("# Full transcript: {}\n\nUNREVIEWED MACHINE TRANSCRIPTION · local {} model\nSource SHA-256: {}\nEvidence: {locator}\n\n{} timestamped segments are saved as an immutable transcript version. Open the transcript panel to read them in bounded pages. The complete TXT, JSON and track SRT files remain in the case.\n",job.source.name,job.asr_model,job.source.sha256,pages.len())
    }else{text.clone()};
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
    Ok(StagedTranscript{value,text,record_text,files,artifact,locator,worker_hash,_leases:leases})
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
        for (ordinal,segment) in staged.value["pages"].as_array().context("Transcript segments missing")?.iter().enumerate() {
            let track=segment["track"].as_u64().context("Missing transcript track")?;
            let start=segment["start"].as_f64().context("Missing transcript start")?;
            let end=segment["end"].as_f64().context("Missing transcript end")?;
            let content=segment["text"].as_str().context("Missing transcript text")?;
            ensure!(start.is_finite()&&end.is_finite()&&end>=start&&content.len()<=10000,"Invalid transcript segment");
            let words=segment["words"].to_string();
            ensure!(words.len()<=200000,"Transcript word timing payload is too large");
            let metadata=json!({"language":segment["language"],"language_probability":segment["language_probability"],"method":segment["method"],"locator":segment["locator"]});
            case.db.execute("INSERT INTO transcript_segments(run_id,ordinal,source_id,track,start_seconds,end_seconds,text,words,metadata) VALUES(?,?,?,?,?,?,?,?,?)",params![job.id,ordinal as i64,job.source.id,track as i64,start,end,content,words,metadata.to_string()])?;
        }
        let record=case.write_record(None,0,&format!("Full transcript · {}",job.source.name.chars().take(170).collect::<String>()),"transcript",&staged.record_text,"processor","All audio tracks decoded to EOF; unreviewed machine transcription",None,vec![job.source.id.clone()])?;
        case.publish_extract(&job.source.id,&staged.text,"Full local machine transcription; unreviewed",true)?;
        case.db.execute("UPDATE sources SET status=? WHERE id=?",params![if staged.value["metadata"]["no_audio_tracks"]==true{"no audio tracks · visual review pending"}else{"text transcribed · all audio tracks · unreviewed"},job.source.id])?;
        case.db.execute("UPDATE records SET stale=1 WHERE (actor<>'processor' OR kind<>'transcript') AND id<>?",[&record.id])?;
        case.db.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'",[])?;
        let receipt=json!({"job_id":job.id,"record_id":record.id,"locator":staged.locator,"segments":staged.value["pages"].as_array().map_or(0,Vec::len),"segmented":staged.record_text.len()<staged.text.len(),"metadata":staged.value["metadata"],"saved_files":staged.files.iter().skip(1).map(|file|&file.relative).collect::<Vec<_>>()});
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
    let row:Option<(String,String,String,String)>=case.db.query_row("SELECT id,status,result,error FROM processing_jobs WHERE source_id=? AND kind='full_audio' ORDER BY rowid DESC LIMIT 1",[source],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
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
pub fn segment_page(case:&Case,source_id:&str,run_id:&str,cursor:Option<i64>)->Result<Value> {
    uuid::Uuid::parse_str(run_id)?;
    let source=case.source(source_id)?;
    ensure!(!source.restricted,"Transcript source is restricted");
    let (job_source,kind,status):(String,String,String)=case.db.query_row("SELECT source_id,kind,status FROM processing_jobs WHERE id=?",[run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    ensure!(job_source==source_id&&kind=="full_audio"&&status=="complete","Transcript version is not available");
    let start=cursor.unwrap_or(0);ensure!(start>=0,"Invalid transcript cursor");
    let mut statement=case.db.prepare("SELECT ordinal,track,start_seconds,end_seconds,text,metadata FROM transcript_segments WHERE run_id=? AND ordinal>=? ORDER BY ordinal LIMIT 26")?;
    let mut segments=statement.query_map(params![run_id,start],|r|Ok(json!({"ordinal":r.get::<_,i64>(0)?,"track":r.get::<_,i64>(1)?,"start":r.get::<_,f64>(2)?,"end":r.get::<_,f64>(3)?,"text":r.get::<_,String>(4)?,"metadata":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).unwrap_or(Value::Null)})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more=segments.len()>25;segments.truncate(25);
    for segment in &mut segments {
        let correction:Option<(String,i64,String,String)>=case.db.query_row("SELECT id,revision,proposed_text,review FROM transcript_corrections WHERE run_id=? AND ordinal=? ORDER BY revision DESC LIMIT 1",params![run_id,segment["ordinal"].as_i64().context("Missing segment ordinal")?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if let Some((id,revision,text,review))=correction {segment["correction"]=json!({"id":id,"revision":revision,"text":text,"review":review});}
    }
    let next_cursor=if more{segments.last().and_then(|segment|segment["ordinal"].as_i64()).map(|ordinal|ordinal+1)}else{None};
    Ok(json!({"source_id":source_id,"run_id":run_id,"segments":segments,"next_cursor":next_cursor}))
}
pub fn segment_detail(case:&Case,source_id:&str,run_id:&str,ordinal:i64)->Result<Value> {
    uuid::Uuid::parse_str(run_id)?;
    ensure!(ordinal>=0,"Invalid transcript segment");
    let source=case.source(source_id)?;ensure!(!source.restricted,"Transcript source is restricted");
    let (job_source,kind,status):(String,String,String)=case.db.query_row("SELECT source_id,kind,status FROM processing_jobs WHERE id=?",[run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    ensure!(job_source==source_id&&kind=="full_audio"&&status=="complete","Transcript version is not available");
    let (track,start,end,text,words,metadata):(i64,f64,f64,String,String,String)=case.db.query_row("SELECT track,start_seconds,end_seconds,text,words,metadata FROM transcript_segments WHERE run_id=? AND ordinal=?",params![run_id,ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    Ok(json!({"run_id":run_id,"ordinal":ordinal,"source_id":source_id,"source_sha256":source.sha256,"track":track,"start":start,"end":end,"text":text,"words":serde_json::from_str::<Value>(&words)?,"metadata":serde_json::from_str::<Value>(&metadata)?}))
}
pub fn save_correction(case:&mut Case,source_id:&str,run_id:&str,ordinal:i64,text:&str,reason:&str)->Result<Value> {
    uuid::Uuid::parse_str(run_id)?;
    ensure!(!text.trim().is_empty()&&text.len()<=10000,"Correction must contain 1–10,000 bytes");
    ensure!(!reason.trim().is_empty()&&reason.len()<=500,"Give a short reason for this correction");
    let source=case.source(source_id)?;ensure!(!source.restricted,"Transcript source is restricted");
    let (job_source,status,input_revision):(String,String,String)=case.db.query_row("SELECT j.source_id,j.status,s.input_revision FROM processing_jobs j JOIN job_schedule s ON s.job_id=j.id WHERE j.id=? AND j.kind='full_audio'",[run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    ensure!(job_source==source_id&&status=="complete"&&input_revision==source.sha256,"Transcript provenance changed");
    let exists:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM transcript_segments WHERE run_id=? AND ordinal=?)",params![run_id,ordinal],|r|r.get(0))?;
    ensure!(exists,"Unknown transcript segment");
    let revision:i64=case.db.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM transcript_corrections WHERE run_id=? AND ordinal=?",params![run_id,ordinal],|r|r.get(0))?;
    let correction=id();
    case.db.execute_batch("SAVEPOINT transcript_correction_proposal")?;
    let saved=(||->Result<()>{
        case.db.execute("INSERT INTO transcript_corrections(id,run_id,ordinal,revision,proposed_text,reason,actor,review,created_at,reviewed_at) VALUES(?,?,?,?,?,?,'human','pending',?,NULL)",params![correction,run_id,ordinal,revision,text,reason,now()])?;
        case.audit("transcript_correction_proposed",json!({"correction":correction,"run":run_id,"ordinal":ordinal,"revision":revision,"text_sha256":digest(text.as_bytes())}))?;
        Ok(())
    })();
    if saved.is_err(){case.db.execute_batch("ROLLBACK TO transcript_correction_proposal")?;}
    case.db.execute_batch("RELEASE transcript_correction_proposal")?;saved?;
    Ok(json!({"id":correction,"run_id":run_id,"ordinal":ordinal,"revision":revision,"review":"pending"}))
}
pub fn review_correction(case:&mut Case,correction_id:&str,accept:bool)->Result<Value> {
    uuid::Uuid::parse_str(correction_id)?;
    let (run_id,ordinal,revision,review,source_id,input_revision):(String,i64,i64,String,String,String)=case.db.query_row("SELECT c.run_id,c.ordinal,c.revision,c.review,j.source_id,s.input_revision FROM transcript_corrections c JOIN processing_jobs j ON j.id=c.run_id JOIN job_schedule s ON s.job_id=j.id WHERE c.id=?",[correction_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    let source=case.source(&source_id)?;
    ensure!(!source.restricted&&source.sha256==input_revision,"Transcript provenance changed");
    let latest:i64=case.db.query_row("SELECT MAX(revision) FROM transcript_corrections WHERE run_id=? AND ordinal=?",params![run_id,ordinal],|r|r.get(0))?;
    ensure!(review=="pending"&&revision==latest,"Only the current pending correction can be reviewed");
    let decision=if accept{"accepted"}else{"rejected"};
    case.db.execute_batch("SAVEPOINT transcript_correction_review")?;
    let saved=(||->Result<()>{
        case.db.execute("UPDATE transcript_corrections SET review=?,reviewed_at=? WHERE id=? AND review='pending'",params![decision,now(),correction_id])?;
        case.audit("transcript_correction_reviewed",json!({"correction":correction_id,"run":run_id,"ordinal":ordinal,"revision":revision,"review":decision}))?;
        Ok(())
    })();
    if saved.is_err(){case.db.execute_batch("ROLLBACK TO transcript_correction_review")?;}
    case.db.execute_batch("RELEASE transcript_correction_review")?;saved?;
    Ok(json!({"id":correction_id,"review":decision,"revision":revision}))
}
#[cfg(test)]
mod staging_tests {
    use super::*;
    #[test]
    fn large_transcript_keeps_later_segments_searchable_and_paged() {
        let dir=tempfile::tempdir().unwrap();
        let input=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic long transcript").unwrap();
        case.import_files(&[input.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source=case.sources().unwrap().into_iter().find(|s|s.kind=="video").unwrap();
        let job=begin(&mut case,&source.id).unwrap();
        let pages=(0..1400).map(|index|json!({"start":index as f64,"end":index as f64+0.5,"track":0,"text":format!("{} {}",if index==1399{"tailneedle"}else{"spoken"},"a".repeat(800)),"words":[]})).collect::<Vec<_>>();
        let staged=stage_transcript(&job,json!({"pages":pages,"metadata":{},"limitations":[]})).unwrap();
        assert!(staged.text.len()>1024*1024);
        let receipt=publish_staged_transcript(&mut case,&job,staged).unwrap();
        assert_eq!(receipt["segmented"],true);
        let record=case.record(receipt["record_id"].as_str().unwrap()).unwrap();
        assert!(record.content.len()<1024*1024 && record.content.contains("1400 timestamped segments"));
        let first=segment_page(&case,&source.id,&job.id,None).unwrap();
        assert_eq!(first["segments"].as_array().unwrap().len(),25);
        let last=segment_page(&case,&source.id,&job.id,Some(1375)).unwrap();
        assert_eq!(last["segments"].as_array().unwrap().len(),25);
        assert!(last["segments"][24]["text"].as_str().unwrap().contains("tailneedle"));
        let detail=segment_detail(&case,&source.id,&job.id,1399).unwrap();
        assert_eq!(detail["words"],json!([]));
        assert_eq!(detail["source_sha256"],source.sha256);
        assert!(crate::evidence::search(&case,"tailneedle",0).unwrap().to_string().contains(&source.id));
        let first=save_correction(&mut case,&source.id,&job.id,1399,"Corrected tail","Checked against original recording").unwrap();
        review_correction(&mut case,first["id"].as_str().unwrap(),true).unwrap();
        let corrected=segment_page(&case,&source.id,&job.id,Some(1399)).unwrap();
        assert!(corrected["segments"][0]["text"].as_str().unwrap().contains("tailneedle"));
        assert_eq!(corrected["segments"][0]["correction"]["review"],"accepted");
        let second=save_correction(&mut case,&source.id,&job.id,1399,"Second wording","Rechecked unclear word").unwrap();
        let pending=segment_page(&case,&source.id,&job.id,Some(1399)).unwrap();
        assert_eq!(pending["segments"][0]["correction"]["review"],"pending");
        assert!(review_correction(&mut case,first["id"].as_str().unwrap(),false).is_err());
        review_correction(&mut case,second["id"].as_str().unwrap(),false).unwrap();
        let archive=dir.path().join("long-transcript.age");
        crate::backup::backup(&mut case,&archive,"synthetic-long-transcript-passphrase").unwrap();
        let restored=crate::backup::restore(&archive,&dir.path().join("restored.ledcase"),"synthetic-long-transcript-passphrase").unwrap();
        assert_eq!(segment_page(&restored,&source.id,&job.id,Some(1399)).unwrap()["segments"][0]["correction"]["review"],"rejected");
        assert_eq!(segment_detail(&restored,&source.id,&job.id,1399).unwrap()["words"],json!([]));
        drop(restored);
        case.set_restricted(&source.id,true).unwrap();
        assert!(segment_page(&case,&source.id,&job.id,Some(1399)).is_err());
        assert!(save_correction(&mut case,&source.id,&job.id,1399,"Hidden","Policy check").is_err());
        case.set_restricted(&source.id,false).unwrap();
        let rerun=begin(&mut case,&source.id).unwrap();
        assert_ne!(rerun.id,job.id);
        assert_eq!(status(&case,&source.id).unwrap()["job_id"],rerun.id);
        assert_eq!(segment_page(&case,&source.id,&job.id,Some(1399)).unwrap()["segments"][0]["correction"]["review"],"rejected");
    }
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
