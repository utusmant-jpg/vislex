use crate::case::{digest, file_hash, id, now, Case, Source};
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
}
pub fn enqueue(case: &mut Case, sources: &[String]) -> Result<Value> {
    crate::processing::worker_path()?;
    ensure!(
        !sources.is_empty() && sources.len() <= 32,
        "Queue between 1 and 32 recordings"
    );
    let pending:i64=case.db.query_row("SELECT count(*) FROM processing_jobs WHERE kind='full_audio' AND status IN ('queued','running')",[],|r|r.get(0))?;
    ensure!(
        pending + sources.len() as i64 <= 32,
        "Recording queue limit reached"
    );
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
    })
}
pub fn run(job: &Job) -> Result<Value> {
    fs::copy(&job.input, job.staging.join("input"))?;
    ensure!(
        file_hash(&job.staging.join("input"))? == job.source.sha256,
        "Input changed while preparing transcription"
    );
    fs::write(
        job.staging.join("progress.json"),
        json!({"state":"initializing","segments":0}).to_string(),
    )?;
    fs::write(
        job.staging.join("request.json"),
        json!({"version":1,"kind":"full_audio"}).to_string(),
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
    let pages = value["pages"]
        .as_array()
        .context("Transcript segments missing")?;
    ensure!(pages.len() <= 100000, "Too many transcript segments");
    let raw = serde_json::to_vec_pretty(&value)?;
    let raw_hash = digest(&raw);
    let raw_path = format!("artifacts/{raw_hash}.json");
    let artifact = id();
    let locator = format!("evidence:{}#artifact:{artifact}", job.source.id);
    let mut text=format!("# Full transcript: {}\n\nUNREVIEWED MACHINE TRANSCRIPTION · local tiny model\nSource SHA-256: {}\nEvidence: {locator}\n\n",job.source.name,job.source.sha256);
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
        let indexed: bool = case.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM extracts WHERE source_id=?)",
            [&job.source.id],
            |r| r.get(0),
        )?;
        if !indexed {
            case.db.execute("INSERT INTO extracts(source_id,text,method) VALUES(?,?,'Full local machine transcription; unreviewed')",params![job.source.id,text])?;
            case.db
                .execute("DELETE FROM source_fts WHERE source_id=?", [&job.source.id])?;
            case.db.execute(
                "INSERT INTO source_fts(source_id,name,text) VALUES(?,?,?)",
                params![job.source.id, job.source.name, text],
            )?;
        }
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
