//! Incremental discovery indexes. They never populate transcript lines or perception coverage.
use crate::{case::{Case,id,now,digest},processing};
use anyhow::{ensure,Context,Result};
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};

pub fn initialize(case:&Case)->Result<()> {
    case.db.execute_batch("CREATE TABLE IF NOT EXISTS discovery_chunks(run_id TEXT NOT NULL,start REAL NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,start));
        CREATE TABLE IF NOT EXISTS discovery_samples(run_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL,seconds REAL NOT NULL,artifact_id TEXT NOT NULL,metadata TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(run_id,artifact_id));
        CREATE INDEX IF NOT EXISTS discovery_source_time ON discovery_samples(source_id,kind,seconds);")?;
    Ok(())
}
fn permitted(case:&Case,source:&str)->Result<()> {let s=case.source(source)?;ensure!(s.kind=="video"&&!s.restricted,"Choose a permitted video recording");Ok(())}
pub fn enqueue(case:&mut Case,source:&str,interval:f64,retry:bool)->Result<Value> {
    permitted(case,source)?;ensure!(interval.is_finite()&&(1.0..=60.0).contains(&interval),"Sampling interval must be 1–60 seconds");initialize(case)?;
    let revision=digest(json!({"source":case.source(source)?.sha256,"interval":interval,"worker":processing::worker_path().ok().and_then(|p|crate::case::file_hash(&p).ok()),"schema":1}).to_string().as_bytes());
    let mut jobs=vec![];
    for kind in ["video_ocr_index","video_overview_index"] {
        let existing:Option<(String,String)>=case.db.query_row("SELECT id,status FROM processing_jobs WHERE source_id=? AND kind=? AND json_extract(result,'$.revision')=? ORDER BY created_at DESC LIMIT 1",params![source,kind,revision],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((job,status))=existing {
            if retry && ["failed","interrupted","cancelled"].contains(&status.as_str()) {
                case.db.execute("UPDATE processing_jobs SET status='queued',error='' WHERE id=?",[&job])?;
            }
            jobs.push(job);continue;
        }
        let job=id();
        case.db.execute("INSERT INTO processing_jobs VALUES(?,?,?,'queued',?,'',?)",params![job,source,kind,json!({"revision":revision,"interval":interval,"next_start":0.0,"model_inspected":false}).to_string(),now()])?;
        jobs.push(job);
    }
    Ok(json!({"jobs":jobs,"sample_interval":interval,"note":"Queued discovery is not inspection. Failed/cancelled jobs require an explicit retry."}))
}
pub fn enqueue_missing(case:&mut Case)->Result<()> {
    initialize(case)?;
    case.db.execute("UPDATE processing_jobs SET status='queued',error='' WHERE status='interrupted' AND kind IN ('video_ocr_index','video_overview_index')",[])?;
    for source in case.sources()?.into_iter().filter(|s|s.kind=="video"&&!s.restricted) {
        let exists:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs WHERE source_id=? AND kind IN ('video_ocr_index','video_overview_index'))",[&source.id],|r|r.get(0))?;
        if !exists {enqueue(case,&source.id,5.,false)?;}
    }
    Ok(())
}
pub struct Job {pub run_id:String,pub start:f64,pub processor:processing::PreparedJob}
pub fn next(case:&mut Case)->Result<Option<Job>> {
    initialize(case)?;
    let busy:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs WHERE status='running' AND kind IN ('video_ocr_index','video_overview_index','video','audio','diarization'))",[],|r|r.get(0))?;
    if busy {return Ok(None)}
    let row:Option<(String,String,String,String)>=case.db.query_row("SELECT j.id,j.source_id,j.kind,j.result FROM processing_jobs j JOIN sources s ON s.id=j.source_id WHERE j.status='queued' AND j.kind IN ('video_ocr_index','video_overview_index') AND s.restricted=0 ORDER BY CASE j.kind WHEN 'video_ocr_index' THEN 0 ELSE 1 END,j.created_at,j.id LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((run_id,source,kind,raw))=row else{return Ok(None)};
    let mut config:Value=serde_json::from_str(&raw)?;
    let worker=processing::worker_path()?;let hash=crate::case::file_hash(&worker)?;
    if let Some(old)=config["worker_sha256"].as_str() {if old!=hash {case.db.execute("UPDATE processing_jobs SET status='failed',error='Worker changed; request a new index revision' WHERE id=?",[&run_id])?;return Ok(None)}}
    config["worker_sha256"]=json!(hash);
    let start=config["next_start"].as_f64().context("Missing discovery checkpoint")?;
    let operation=if kind=="video_ocr_index" {"video_ocr"}else{"video_overview"};
    let processor=match processing::prepare_request(case,&source,json!({"operation":operation,"start":start,"end":start+60.,"interval":config["interval"]})) {
        Ok(job)=>job,Err(e)=>{case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![e.to_string(),run_id])?;return Ok(None)}
    };
    config["active_job"]=if processor.cached.is_some(){Value::Null}else{json!(processor.job_id)};
    case.db.execute("UPDATE processing_jobs SET status='running',result=? WHERE id=?",params![config.to_string(),run_id])?;
    Ok(Some(Job{run_id,start,processor}))
}
pub fn publish(case:&mut Case,job:&Job,result:Result<Value>)->Result<()> {
    let state:String=case.db.query_row("SELECT status FROM processing_jobs WHERE id=?",[&job.run_id],|r|r.get(0))?;
    if state=="cancelled" {let _=processing::cancel(case,&job.processor.job_id);return Ok(())}
    let result=processing::publish_prepared(case,&job.processor,result);
    match result {
        Ok(value)=>{store_chunk(case,&job.run_id,&job.processor.source.id,&job.processor.kind,job.start,&value)?;},
        Err(e)=>{case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![e.to_string(),job.run_id])?;}
    }
    Ok(())
}
pub fn store_chunk(case:&mut Case,run:&str,source:&str,kind:&str,start:f64,value:&Value)->Result<()> {
    initialize(case)?;
    let raw:String=case.db.query_row("SELECT result FROM processing_jobs WHERE id=? AND source_id=?",params![run,source],|r|r.get(0))?;
    let mut config:Value=serde_json::from_str(&raw)?;
    let entries=value["published"].as_array().context("Missing published frames")?;
    ensure!(entries.len()<=180,"Too many discovery frames");
    let tx=case.db.savepoint()?;
    let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM discovery_chunks WHERE run_id=? AND start=?)",params![run,start],|r|r.get(0))?;
    if exists {return Ok(())}
    for entry in entries {
        let artifact=entry["artifact_id"].as_str().context("Missing frame reference")?;
        let meta=&entry["metadata"];
        let seconds=meta["source_relative_seconds"].as_f64().context("Missing decoder timestamp")?;
        ensure!(seconds.is_finite()&&seconds>=start&&seconds<start+60.,"Frame outside chunk");
        let owner:String=tx.query_row("SELECT source_id FROM artifacts WHERE id=?",[artifact],|r|r.get(0))?;ensure!(owner==source,"Frame belongs to another source");
        tx.execute("INSERT INTO discovery_samples VALUES(?,?,?,?,?,?,?)",params![run,source,kind,seconds,artifact,meta.to_string(),meta["ocr"]["text"].as_str().unwrap_or("")])?;
    }
    tx.execute("INSERT INTO discovery_chunks VALUES(?,?,?)",params![run,start,value.to_string()])?;
    config["next_start"]=json!(start+60.);config["active_job"]=Value::Null;
    config["last_chunk"]=value["metadata"].clone();
    let warning=value["metadata"]["failures"].as_array().is_some_and(|a|!a.is_empty()) || value["metadata"]["missing_pts_frames"].as_u64().unwrap_or(0)>0;
    config["has_gaps"]=json!(config["has_gaps"].as_bool().unwrap_or(false)||warning);
    let complete=value["metadata"]["eof"].as_bool().context("Missing EOF indicator")?;
    tx.execute("UPDATE processing_jobs SET status=?,result=? WHERE id=?",params![if complete{"complete"}else{"queued"},config.to_string(),run])?;
    tx.execute("INSERT INTO meta(key,value) VALUES('discovery_generation','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    tx.commit()?;Ok(())
}
pub fn cancel(case:&Case,source:&str)->Result<Value> {
    permitted(case,source)?;
    let mut q=case.db.prepare("SELECT result FROM processing_jobs WHERE source_id=? AND kind IN ('video_ocr_index','video_overview_index') AND status='running'")?;
    for raw in q.query_map([source],|r|r.get::<_,String>(0))? {let v:Value=serde_json::from_str(&raw?)?;if let Some(job)=v["active_job"].as_str(){processing::cancel(case,job)?;}}
    case.db.execute("UPDATE processing_jobs SET status='cancelled' WHERE source_id=? AND kind IN ('video_ocr_index','video_overview_index') AND status IN ('queued','running')",[source])?;
    Ok(json!({"status":"cancelled","published_chunks_preserved":true}))
}
pub fn status(case:&Case,source:&str)->Result<Value> {
    permitted(case,source)?;initialize(case)?;
    let mut q=case.db.prepare("SELECT id,kind,status,result,error FROM processing_jobs WHERE source_id=? AND kind IN ('video_ocr_index','video_overview_index') ORDER BY created_at DESC,id")?;
    let jobs=q.query_map([source],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"result":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(Value::Null),"error":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!({"jobs":jobs,"note":"Only listed sample times were indexed. Intervening footage remains uninspected; failures and undecoded frames are separate gaps."}))
}
pub fn browse(case:&Case,source:&str,kind:&str,start:f64,end:f64,offset:u64,query:&str)->Result<Value> {
    permitted(case,source)?;initialize(case)?;
    ensure!(["video_ocr","video_overview"].contains(&kind)&&start.is_finite()&&end.is_finite()&&0.<=start&&end>start,"Invalid discovery range");
    let parent=format!("{kind}_index");
    let run:Option<String>=case.db.query_row("SELECT id FROM processing_jobs WHERE source_id=? AND kind=? ORDER BY created_at DESC,id DESC LIMIT 1",params![source,parent],|r|r.get(0)).optional()?;
    let mut q=case.db.prepare("SELECT artifact_id,metadata FROM discovery_samples WHERE run_id=? AND seconds>=? AND seconds<? AND instr(lower(text),lower(?))>0 ORDER BY seconds,artifact_id LIMIT 31 OFFSET ?")?;
    let mut samples=q.query_map(params![run,start,end,query,offset.min(i64::MAX as u64)as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more=samples.len()>30;samples.truncate(30);
    let samples=samples.into_iter().map(|(a,m)|Ok(json!({"artifact_id":a,"locator":format!("evidence:{source}#artifact:{a}"),"metadata":serde_json::from_str::<Value>(&m)?}))).collect::<Result<Vec<_>>>()?;
    Ok(json!({"source_id":source,"run_id":run,"samples":samples,"next_offset":if more{Some(offset+30)}else{None},"status":status(case,source)?,"note":"Navigation thumbnails are not proof of intervening activity. Use inspect_artifact_image then inspect_video_interval to verify candidates."}))
}
pub fn search(case:&Case,scope:&[String],terms:&[String])->Result<Vec<Value>> {
    initialize(case)?;let mut hits=vec![];
    let mut q=case.db.prepare("SELECT d.source_id,s.name,d.seconds,d.artifact_id,d.text,d.run_id FROM discovery_samples d JOIN sources s ON s.id=d.source_id WHERE s.restricted=0 AND d.kind='video_ocr' AND d.run_id=(SELECT j.id FROM processing_jobs j WHERE j.source_id=d.source_id AND j.kind='video_ocr_index' ORDER BY j.created_at DESC,j.id DESC LIMIT 1) ORDER BY d.source_id,d.seconds,d.artifact_id")?;
    for row in q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,f64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))? {
        let (sid,name,seconds,artifact,text,run)=row?;
        if scope.contains(&sid)&&terms.iter().any(|t|text.to_lowercase().contains(&t.to_lowercase())) {
            hits.push(json!({"type":"video_text","source_id":sid,"title":name,"source_relative_seconds":seconds,"artifact_id":artifact,"revision":run,"locator":format!("evidence:{sid}#artifact:{artifact}"),"excerpt":text.chars().take(1500).collect::<String>(),"limitation":"Sampled OCR lead; inspect frame and surrounding footage. Displayed clocks are not verified timestamps."}));
        }
    }
    Ok(hits)
}
