//! Durable import/open preparation followed by a scoped AI case review.
use crate::{case::{Case,id,now,digest},processing,agent};
use anyhow::Result;
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::{BTreeMap,HashSet};

/// Frames still requiring model observation in the automatic review. Discovery
/// thumbnails are selected once per 20-second bin plus every scene boundary;
/// an inspection only counts after record_visual_observations succeeds.
pub fn next_visual_batch(case:&Case,task:&str)->Result<Vec<Value>> {
    crate::discovery::initialize(case)?;
    let mut observed=HashSet::new();
    let mut actions=case.db.prepare("SELECT output FROM actions WHERE task_id=? AND name='record_visual_observations' AND status='complete'")?;
    for row in actions.query_map([task],|r|r.get::<_,String>(0))? {
        let output:Value=serde_json::from_str(&row?)?;
        if let Some(items)=output["observations"].as_array() {
            for item in items {if let Some(id)=item["artifact_id"].as_str(){observed.insert(id.to_string());}}
        }
    }
    let mut required=Vec::new();
    for source in case.sources()?.into_iter().filter(|source|source.kind=="video"&&!source.restricted) {
        let run:Option<String>=case.db.query_row("SELECT id FROM processing_jobs WHERE source_id=? AND kind='video_overview_index' AND status IN ('complete','failed','interrupted') ORDER BY rowid DESC LIMIT 1",[&source.id],|r|r.get(0)).optional()?;
        let Some(run)=run else {continue};
        let mut samples=case.db.prepare("SELECT artifact_id,seconds,metadata FROM discovery_samples WHERE run_id=? AND kind='video_overview' ORDER BY seconds,artifact_id")?;
        let mut bins:BTreeMap<u64,Value>=BTreeMap::new();
        let mut scenes=Vec::new();
        for row in samples.query_map([&run],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?,r.get::<_,String>(2)?)))? {
            let (artifact,seconds,raw)=row?;
            if !seconds.is_finite()||seconds<0. {continue}
            let metadata:Value=serde_json::from_str(&raw)?;
            let frame=json!({"source_id":source.id,"artifact_id":artifact,"seconds":seconds,"run_id":run,"scene_boundary":metadata["scene_boundary"]==true});
            bins.entry((seconds/20.).floor() as u64).or_insert_with(||frame.clone());
            if metadata["scene_boundary"]==true {scenes.push(frame);}
        }
        required.extend(bins.into_values());
        required.extend(scenes);
    }
    let mut seen=HashSet::new();
    Ok(required.into_iter().filter(|frame|frame["artifact_id"].as_str().is_some_and(|id|seen.insert(id.to_string())&&!observed.contains(id))).take(24).collect())
}
/// Versioned, receipt-derived visual coverage. End time is the last decoded
/// presentation timestamp, so it is an estimate of the recording's playable
/// extent rather than a claim of continuous perception.
pub fn visual_coverage(case:&Case,task:&str)->Result<Value> {
    crate::discovery::initialize(case)?;
    let mut observed=HashSet::new();
    let mut actions=case.db.prepare("SELECT output FROM actions WHERE task_id=? AND name='record_visual_observations' AND status='complete'")?;
    for row in actions.query_map([task],|r|r.get::<_,String>(0))? {
        let output:Value=serde_json::from_str(&row?)?;
        for item in output["observations"].as_array().into_iter().flatten() {
            if let Some(id)=item["artifact_id"].as_str(){observed.insert(id.to_string());}
        }
    }
    let mut sources=Vec::new();let mut all_complete=true;
    for source in case.sources()?.into_iter().filter(|source|source.kind=="video"&&!source.restricted) {
        let run:Option<(String,String,String)>=case.db.query_row("SELECT id,status,result FROM processing_jobs WHERE source_id=? AND kind='video_overview_index' ORDER BY rowid DESC LIMIT 1",[&source.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((run,status,raw))=run else {all_complete=false;sources.push(json!({"source_id":source.id,"source_sha256":source.sha256,"state":"discovery_missing"}));continue};
        let config:Value=serde_json::from_str(&raw)?;
        let end=config["last_chunk"]["last_decoded_seconds"].as_f64();
        let eof=config["last_chunk"]["eof"]==true && status=="complete";
        let expected=end.filter(|end|end.is_finite()&&*end>=0.).map(|end|(end/20.).floor() as u64+1);
        let mut bins=HashSet::new();let mut scene_total=0u64;let mut scene_observed=0u64;
        let mut samples=case.db.prepare("SELECT artifact_id,seconds,metadata FROM discovery_samples WHERE run_id=? AND kind='video_overview'")?;
        for row in samples.query_map([&run],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?,r.get::<_,String>(2)?)))? {
            let (artifact,seconds,raw)=row?;
            if !seconds.is_finite()||seconds<0. {continue}
            let metadata:Value=serde_json::from_str(&raw)?;
            if metadata["scene_boundary"]==true {scene_total+=1;if observed.contains(&artifact){scene_observed+=1;}}
            if observed.contains(&artifact){bins.insert((seconds/20.).floor() as u64);}
        }
        let missing=expected.map(|count|(0..count).filter(|bin|!bins.contains(bin)).collect::<Vec<_>>()).unwrap_or_default();
        let complete=eof && expected.is_some() && missing.is_empty() && scene_total==scene_observed && config["has_gaps"]!=true;
        if !complete {all_complete=false;}
        sources.push(json!({"source_id":source.id,"source_sha256":source.sha256,"discovery_run_id":run,"discovery_status":status,"last_decoded_seconds":end,"eof":eof,"expected_bins":expected,"observed_bins":bins.len(),"missing_bin_count":missing.len(),"missing_bins_first_100":missing.into_iter().take(100).collect::<Vec<_>>(),"scene_frames":scene_total,"scene_frames_observed":scene_observed,"discovery_has_gaps":config["has_gaps"]==true,"state":if complete{"sampled_bins_observed"}else{"partial"}}));
    }
    Ok(json!({"version":1,"task_id":task,"interval_seconds":20,"complete":all_complete,"sources":sources,"meaning":"Only recorded AI observations of sampled frames count. Last decoded time estimates playable extent; neither sampled-bin coverage nor scene-frame coverage proves continuous human review."}))
}

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
/// Pause reason that marks the automatic review as expecting to continue by
/// itself once the user's chat turn is finished. Any other pause (user stop,
/// application interruption, provider error) stays down until explicitly resumed.
pub const CHAT_PREEMPTION: &str = "Paused for your chat; automatic analysis will continue afterwards";
fn review_input_stamp(case:&Case,source_ids:&[String])->Result<String> {
    let allowed:std::collections::HashSet<&str>=source_ids.iter().map(String::as_str).collect();
    let mut revisions=std::collections::HashMap::new();
    let mut statement=case.db.prepare("SELECT source_id,revision FROM extracts")?;
    for row in statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))? {let (id,revision)=row?;revisions.insert(id,revision);}
    let mut latest:std::collections::HashMap<String,std::collections::BTreeMap<String,String>>=std::collections::HashMap::new();
    let mut statement=case.db.prepare("SELECT source_id,kind,id FROM processing_jobs WHERE status='complete' AND kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index') ORDER BY rowid DESC")?;
    for row in statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))? {
        let (source,kind,job)=row?;
        if allowed.contains(source.as_str()) {latest.entry(source).or_default().entry(kind).or_insert(job);}
    }
    let mut transcripts:std::collections::HashMap<String,Vec<String>>=std::collections::HashMap::new();
    for record in case.records()?.into_iter().filter(|record|record.actor=="processor" && record.kind=="transcript") {
        let stamp=format!("{}:{}:{}",record.id,record.revision,digest(record.content.as_bytes()));
        for source in record.dependencies {
            if allowed.contains(source.as_str()) {transcripts.entry(source).or_default().push(stamp.clone());}
        }
    }
    let mut inputs=Vec::with_capacity(source_ids.len());
    for source in case.sources()?.into_iter().filter(|source|allowed.contains(source.id.as_str())) {
        let mut source_transcripts=transcripts.remove(&source.id).unwrap_or_default();source_transcripts.sort();
        inputs.push(format!("{}:{}:{}:{}:{}",source.id,source.sha256,revisions.get(&source.id).copied().unwrap_or(0),serde_json::to_string(&latest.get(&source.id))?,serde_json::to_string(&source_transcripts)?));
    }
    anyhow::ensure!(inputs.len()==source_ids.len(),"Automatic review inventory changed");
    inputs.sort();
    Ok(digest(inputs.join("\n").as_bytes()))
}
pub fn start_review(case:&mut Case)->Result<Option<String>> {
    let settings=case.settings()?;
    if settings.offline || !settings.allow_text || settings.model.is_empty() {return Ok(None);}
    let busy:i64=case.db.query_row("SELECT (SELECT count(*) FROM tasks WHERE status='running')+(SELECT count(*) FROM processing_jobs WHERE status IN ('queued','running') AND kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index'))",[],|r|r.get(0))?;
    if busy>0 {return Ok(None);}
    let (sources,records)=agent::case_scope(case)?;
    if sources.is_empty(){return Ok(None);}
    let usable:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM sources s WHERE s.restricted=0 AND (EXISTS(SELECT 1 FROM extracts e WHERE e.source_id=s.id) OR EXISTS(SELECT 1 FROM processing_jobs j WHERE j.source_id=s.id AND j.status='complete')))",[],|r|r.get(0))?;
    if !usable {return Ok(None);}
    let fingerprint=review_input_stamp(case,&sources)?;
    // Reconcile the persisted state machine against the live task first: a
    // created task never counts as completed analysis. Only observed successful
    // completion writes the completion fingerprint.
    if let Some(task)=case.meta("auto_review_task")? {
        let status:Option<String>=case.db.query_row("SELECT status FROM tasks WHERE id=?",[&task],|r|r.get(0)).optional()?;
        match status.as_deref() {
            Some("complete")=>{
                // The inventory this task was dispatched against, falling back to
                // the legacy start-time fingerprint for cases predating the
                // completion-only rule.
                let dispatched=case.meta(&format!("auto_review_inventory:{task}"))?.or_else(||case.meta("auto_review_fingerprint").ok().flatten());
                if dispatched.as_deref()==Some(fingerprint.as_str()) {
                    let coverage=visual_coverage(case,&task)?;
                    let complete=coverage["complete"]==true;
                    case.set_meta(&format!("auto_visual_coverage:{task}"),&coverage.to_string())?;
                    if case.meta("auto_review_fingerprint")?.as_deref()!=Some(fingerprint.as_str()) {
                        case.set_meta("auto_review_fingerprint",&fingerprint)?;
                        case.audit(if complete{"automatic_case_review_completed"}else{"automatic_case_review_partial"},json!({"task":task,"inventory":fingerprint,"visual_coverage":coverage}))?;
                    }
                    case.set_meta("auto_review_state",if complete{"complete"}else{"partial"})?;
                    return Ok(None);
                }
                // Completed against an older inventory that has since changed:
                // fall through and plan a fresh review below.
            }
            Some("running")=>{return Ok(None);}
            Some("paused")=>{
                // Resume missing work, but only for the chat-preemption pause;
                // user stops, interruptions and failures stay down until an
                // explicit resume. resume() itself refuses to replay a
                // transmission whose delivery is uncertain.
                let reason:String=case.db.query_row("SELECT error FROM tasks WHERE id=?",[&task],|r|r.get(0)).unwrap_or_default();
                if reason==CHAT_PREEMPTION && agent::resume(case,&task).is_ok() {
                    case.set_meta("auto_review_state","running")?;
                    return Ok(Some(task));
                }
                case.set_meta("auto_review_state",if reason=="Stopped by user" || reason==CHAT_PREEMPTION {"paused"} else {"failed"})?;
                return Ok(None);
            }
            _=>{case.set_meta("auto_review_state","failed")?;}
        }
    }
    if case.meta("auto_review_fingerprint")?.as_deref()==Some(&fingerprint){return Ok(None);}
    let prompt="Automatically analyze this entire case inventory using completed preparation. If a processor failed, name that gap and use available results. Enumerate every source and processing result. Read every supported document and OCR unit, inspect every image, and review all recording transcripts. For video, obtain each recording's full duration and inspect at least one frame in every consecutive 20-second bin, plus scene-change frames and denser intervals around possible events. Track each bin by source and source-relative time; mark decode failures or bins not visually inspected. Use existing discovery frames and prepared artifacts before requesting new extraction. Do not rely on speech to discover silent actions. Compare facts across reports, images and recordings; build a cited chronology with clock uncertainty. Save reusable findings. Sampled frames never establish continuous perception or human review. Return coverage, supported findings, contradictions and remaining gaps. Finish with an honest partial report if any file, page or interval remains uninspected.";
    let task=agent::start(case,prompt,"investigate",sources,records,0.)?;
    case.set_meta("auto_review_state","running")?;
    case.set_meta(&format!("auto_review_inventory:{task}"),&fingerprint)?;
    case.set_meta("auto_review_task",&task)?;
    case.set_meta(&format!("chat_title:{task}"),"Automatic case analysis")?;
    case.set_meta(&format!("automatic_task:{task}"),"true")?;
    case.audit("automatic_case_review_started",json!({"task":task,"inventory":fingerprint}))?;
    Ok(Some(task))
}
pub fn preempt_for_chat(case:&mut Case)->Result<()> {
    if let Some(task)=case.meta("auto_review_task")? {
        let active:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='running')",[&task],|r|r.get(0))?;
        if active {agent::pause(case,&task,CHAT_PREEMPTION)?;case.set_meta("auto_review_state","paused")?;}
    }
    Ok(())
}
pub fn status(case:&Case)->Result<Value> {
    let counts=case.db.query_row("SELECT count(*),COALESCE(sum(status='complete'),0),COALESCE(sum(status IN ('queued','running')),0),COALESCE(sum(status IN ('failed','interrupted')),0) FROM processing_jobs WHERE kind='auto_prepare'",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?;
    let task=case.meta("auto_review_task")?;
    // Derived live state; the persisted auto_review_state mirrors it at transitions.
    let live=match &task {
        Some(task)=>case.db.query_row("SELECT status FROM tasks WHERE id=?",[task],|r|r.get::<_,String>(0)).optional()?,
        None=>None,
    };
    let review_state=match live.as_deref() {
        Some("running")=>"running",
        Some("paused")=>{
            let reason:String=case.db.query_row("SELECT error FROM tasks WHERE id=?",[task.as_deref().unwrap()],|r|r.get(0)).unwrap_or_default();
            if reason=="Stopped by user" || reason==CHAT_PREEMPTION {"paused"} else {"failed"}
        },
        Some("complete")=>{
            let dispatched=task.as_ref().and_then(|task|case.meta(&format!("auto_review_inventory:{task}")).ok().flatten().or_else(||case.meta("auto_review_fingerprint").ok().flatten()));
            let current=case.sources().and_then(|sources|review_input_stamp(case,&sources.into_iter().filter(|source|!source.restricted).map(|source|source.id).collect::<Vec<_>>())).ok();
            if dispatched.is_some() && dispatched==current {
                let coverage=task.as_ref().and_then(|task|case.meta(&format!("auto_visual_coverage:{task}")).ok().flatten()).and_then(|raw|serde_json::from_str::<Value>(&raw).ok()).or_else(||task.as_ref().and_then(|task|visual_coverage(case,task).ok()));
                if coverage.as_ref().is_some_and(|coverage|coverage["complete"]==true) {"complete"} else {"partial"}
            } else {"planned"}
        }
        _=>"planned",
    };
    Ok(json!({"files":counts.0,"prepared":counts.1,"pending":counts.2,"failed":counts.3,"review_task":task,"review_state":review_state,"note":"Preparation, OCR, transcription and AI review have separate coverage. A partial review finished with recorded gaps. Sampled visual bins never imply continuous or human review."}))
}
/// Interactive chats wait for the initial file preparation and automatic review.
/// A failed processor or review leaves a visible gap, so users can investigate it.
pub fn chat_pause_reason(case:&Case)->Result<Option<&'static str>> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref()==Ok("1") {return Ok(None);}
    let failed:i64=case.db.query_row("SELECT count(*) FROM processing_jobs j WHERE j.kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index') AND j.status IN ('failed','interrupted') AND NOT EXISTS(SELECT 1 FROM processing_jobs newer WHERE newer.source_id=j.source_id AND newer.kind=j.kind AND newer.status='complete' AND newer.rowid>j.rowid)",[],|r|r.get(0))?;
    if failed>0 {return Ok(None);}
    let pending:i64=case.db.query_row("SELECT count(*) FROM processing_jobs j WHERE j.kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index') AND j.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM processing_jobs newer WHERE newer.source_id=j.source_id AND newer.kind=j.kind AND newer.status='complete' AND newer.rowid>j.rowid)",[],|r|r.get(0))?;
    if pending>0 {return Ok(Some("Files are still being prepared. Chat will be available when processing finishes or reports an error."));}
    if let Some(task)=case.meta("auto_review_task")? {
        let running:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='running')",[task],|r|r.get(0))?;
        if running {return Ok(Some("Automatic case review is still running. Chat will be available when it finishes or reports an error."));}
    }
    Ok(None)
}
pub fn completed_review_context(case:&Case,source_ids:&[String])->Result<Option<Value>> {
    let Some(task)=case.meta("auto_review_task")? else {return Ok(None)};
    let Some((status,answer))=case.db.query_row("SELECT status,answer FROM tasks WHERE id=?",[&task],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? else {return Ok(None)};
    if status!="complete" {return Ok(None);}
    let fingerprint=review_input_stamp(case,source_ids)?;
    if case.meta(&format!("auto_review_inventory:{task}"))?.as_deref()!=Some(fingerprint.as_str()) {return Ok(None);}
    let progress=crate::review_progress::load(case,&task)?;
    Ok(Some(json!({"task_id":task,"answer_unreviewed":answer.chars().take(4000).collect::<String>(),"saved_summary":progress.summary.chars().take(2000).collect::<String>(),"gaps":progress.gaps,"meaning":"Prior AI analysis is a lead with citations to recheck, not human-reviewed proof. Read saved records and current sources before making factual claims."})))
}
