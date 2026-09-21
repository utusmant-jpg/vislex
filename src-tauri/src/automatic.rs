//! Durable import/open preparation followed by a scoped AI case review.
use crate::{case::{Case,id,now,digest},processing,agent};
use anyhow::Result;
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};

pub fn enqueue(case:&mut Case)->Result<()> {
    crate::discovery::enqueue_missing(case)?;
    if let Ok(worker)=processing::worker_path() {
        let revision=crate::case::file_hash(&worker)?;
        if case.meta("auto_worker_revision")?.as_deref()!=Some(&revision) {
            case.db.execute("UPDATE processing_jobs SET status='queued',error='' WHERE kind='auto_prepare' AND status='failed'",[])?;
            case.set_meta("auto_worker_revision",&revision)?;
        }
    }
    case.db.execute("UPDATE processing_jobs SET status='queued',error='' WHERE kind='auto_prepare' AND status='interrupted'",[])?;
    for source in case.sources()? {
        let exists:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs WHERE source_id=? AND kind='auto_prepare')",[&source.id],|r|r.get(0))?;
        if !exists {
            case.db.execute("INSERT INTO processing_jobs VALUES(?,?,'auto_prepare','queued','{}','',?)",params![id(),source.id,now()])?;
        }
        if ["audio","video"].contains(&source.kind.as_str()) {
            let existing:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs WHERE source_id=? AND kind='full_audio' AND status<>'interrupted')",[&source.id],|r|r.get(0))?;
            if !existing {case.db.execute("INSERT INTO processing_jobs VALUES(?,?,'full_audio','queued','{}','',?)",params![id(),source.id,now()])?;}
        }
    }
    Ok(())
}
pub struct Job {pub queue_id:String,pub processor:processing::PreparedJob}
pub fn next(case:&mut Case)->Result<Option<Job>> {
    let running:i64=case.db.query_row("SELECT count(*) FROM processing_jobs WHERE kind='auto_prepare' AND status='running'",[],|r|r.get(0))?;
    if running>=2 {return Ok(None);}
    loop {
        let entry:Option<(String,String)>=case.db.query_row("SELECT id,source_id FROM processing_jobs WHERE kind='auto_prepare' AND status='queued' ORDER BY created_at,id LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((queue_id,source_id))=entry else {return Ok(None)};
        let source=case.source(&source_id)?;
        if source.kind=="text" {
            let indexed:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM extracts WHERE source_id=?)",[&source_id],|r|r.get(0))?;
            case.db.execute("UPDATE processing_jobs SET status=?,result=?,error=? WHERE id=?",params![if indexed {"complete"}else{"failed"},json!({"native_text_indexed":indexed,"model_inspected":false}).to_string(),if indexed {""}else{"Text could not be decoded/indexed; retained for review"},queue_id])?;
            continue;
        }
        match processing::prepare_request(case,&source_id,json!({"operation":"automatic"})) {
            Ok(processor)=>{case.db.execute("UPDATE processing_jobs SET status='running' WHERE id=?",[&queue_id])?;return Ok(Some(Job{queue_id,processor}));},
            Err(e)=>{case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![e.to_string(),queue_id])?;}
        }
    }
}
pub fn publish(case:&mut Case,job:&Job,result:Result<Value>)->Result<()> {
    match processing::publish_prepared(case,&job.processor,result) {
        Ok(value)=>{case.db.execute("UPDATE processing_jobs SET status='complete',result=? WHERE id=?",params![json!({"extraction_locator":value["extraction_locator"],"coverage":value["metadata"]["coverage"],"limitations":value["limitations"],"model_inspected":false}).to_string(),job.queue_id])?;},
        Err(e)=>{case.db.execute("UPDATE processing_jobs SET status='failed',error=? WHERE id=?",params![e.to_string(),job.queue_id])?;}
    }
    Ok(())
}
pub fn start_review(case:&mut Case)->Result<Option<String>> {
    let settings=case.settings()?;
    if settings.offline || !settings.allow_text || settings.model.is_empty() {return Ok(None);}
    let busy:i64=case.db.query_row("SELECT (SELECT count(*) FROM tasks WHERE status='running')+(SELECT count(*) FROM processing_jobs WHERE status IN ('queued','running') AND kind IN ('auto_prepare','full_audio'))",[],|r|r.get(0))?;
    if busy>0 {return Ok(None);}
    let (sources,records)=agent::case_scope(case)?;
    if sources.is_empty(){return Ok(None);}
    let usable:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM sources s WHERE s.restricted=0 AND (EXISTS(SELECT 1 FROM extracts e WHERE e.source_id=s.id) OR EXISTS(SELECT 1 FROM processing_jobs j WHERE j.source_id=s.id AND j.status='complete')))",[],|r|r.get(0))?;
    if !usable {return Ok(None);}
    let mut hashes:Vec<_>=sources.iter().map(|s|case.source(s).map(|v|format!("{}:{}",v.id,v.sha256))).collect::<Result<_>>()?;hashes.sort();
    let fingerprint=digest(hashes.join("\n").as_bytes());
    if case.meta("auto_review_fingerprint")?.as_deref()==Some(&fingerprint){return Ok(None);}
    let prompt="Automatically analyze this entire case inventory using available preparation. Some indexes and transcripts may still be pending: disclose them, inspect discovery status, use completed chunks, and do not wait in a polling loop. Use search_passages for visible text and browse_video_overview for silent-action leads before detailed interval inspection. Enumerate every source and its processing results. Read every supported document and OCR unit, inspect every image, and review all recording transcripts. For video, obtain each recording's full duration and inspect consecutive visual windows spanning that duration, then inspect material or ambiguous events more densely. Use parallel assignments when enabled, including the same model. Do not rely on speech to discover silent actions. Compare facts across reports, images and recordings; build a cited chronology with source-relative times and clock uncertainty. Save reusable findings. Use existing prepared artifacts and completed transcripts; do not repeat completed extraction. Track each file and modality explicitly. Report uninspected intervals, sampling density, OCR errors, unsupported structures and failures. Sampled frames never establish exhaustive visual inspection. Return an inventory/coverage table, supported findings, contradictions and remaining gaps. Never claim full review if any file, page or interval remains uninspected.";
    let task=agent::start(case,prompt,"investigate",sources,records,0.)?;
    case.set_meta("auto_review_fingerprint",&fingerprint)?;
    case.set_meta("auto_review_task",&task)?;
    case.set_meta(&format!("chat_title:{task}"),"Automatic case analysis")?;
    case.set_meta(&format!("automatic_task:{task}"),"true")?;
    case.audit("automatic_case_review_started",json!({"task":task,"inventory":fingerprint}))?;
    Ok(Some(task))
}
pub fn preempt_for_chat(case:&mut Case)->Result<()> {
    if let Some(task)=case.meta("auto_review_task")? {
        let active:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='running')",[&task],|r|r.get(0))?;
        if active {agent::pause(case,&task,"Paused for your chat; automatic analysis will continue afterwards")?;case.set_meta("auto_review_fingerprint","")?;}
    }
    Ok(())
}
pub fn status(case:&Case)->Result<Value> {
    let counts=case.db.query_row("SELECT count(*),COALESCE(sum(status='complete'),0),COALESCE(sum(status IN ('queued','running')),0),COALESCE(sum(status IN ('failed','interrupted')),0) FROM processing_jobs WHERE kind='auto_prepare'",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?;
    Ok(json!({"files":counts.0,"prepared":counts.1,"pending":counts.2,"failed":counts.3,"review_task":case.meta("auto_review_task")?,"note":"Preparation, OCR, transcription and AI review have separate coverage. Preparation does not certify complete analysis."}))
}
