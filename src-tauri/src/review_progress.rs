//! Durable, source-attributed review progress; never private model reasoning.
use crate::case::Case;
use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Progress {
    pub summary: String,
    pub citations: Vec<String>,
    pub gaps: Vec<String>,
    pub next_steps: Vec<String>,
    pub checkpoint_step: i64,
    pub duplicate_reads: usize,
    pub checkpoints_without_progress: usize,
}
pub fn load(case: &Case, task: &str) -> Result<Progress> {
    Ok(case.meta(&format!("review_progress:{task}"))?.map(|s|serde_json::from_str(&s)).transpose()?.unwrap_or_default())
}
pub fn save(case: &Case, task: &str, state: &Progress) -> Result<()> {
    case.set_meta(&format!("review_progress:{task}"), &serde_json::to_string(state)?)
}
pub fn is_retrieval(name: &str) -> bool {
    ["read_text","read_extract_revision","read_record","read_artifact","search_passages","search_evidence","read_tool_result","read_receipt","recording_status","list_sources","list_records"].contains(&name)
}
pub fn observe(case: &Case, task: &str, name: &str, args: &Value, output: &Value, status: &str) -> Result<bool> {
    if (name == "checkpoint_review" || name == "finish_task") && status=="complete" { return Ok(false); }
    let mut progress = load(case,task)?;
    let same: bool = case.db.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE task_id=? AND name=? AND (input=? OR ?=1) AND (CASE WHEN json_valid(output) THEN json_remove(output,'$.receipt_id','$.repeat_notice') ELSE output END)=json_remove(?,'$.receipt_id','$.repeat_notice') AND status=?)",params![task,name,args.to_string(),is_retrieval(name),output.to_string(),status],|r|r.get(0))?;
    let duplicate = same && (is_retrieval(name) || status == "failed");
    if duplicate { progress.duplicate_reads += 1; }
    else if status == "complete" && !["list_sources","list_records","recording_status","open_source","validate_citation"].contains(&name) {
        progress.duplicate_reads = 0;
        progress.checkpoints_without_progress = 0;
    }
    save(case,task,&progress)?;
    Ok(duplicate)
}

/// Lightweight ledger survives context compaction and includes receipt ids for exact recovery.
pub fn ledger(case: &Case, task: &str, ids: &[String]) -> Result<Value> {
    let mut source_rows = BTreeMap::new();
    let records = case.records()?;
    for source in case.sources()?.into_iter().filter(|s|ids.contains(&s.id)&&!s.restricted) {
        let transcripts:Vec<_>=records.iter().filter(|r|r.kind=="transcript"&&r.actor=="processor"&&r.dependencies.contains(&source.id)).map(|r|json!({"record_id":r.id,"revision":r.revision,"total_lines":r.content.lines().count(),"review":r.review})).collect();
        source_rows.insert(source.id.clone(),json!({"source_id":source.id,"filename":source.name,"kind":source.kind,"sha256":source.sha256,"status":source.status,"full_transcripts":transcripts,"read_count":0,"reads":[],"visual_observation_count":0,"visual_observations":[]}));
    }
    let mut stmt=case.db.prepare("SELECT id,name,input,output,status FROM actions WHERE task_id=? ORDER BY created_at,rowid")?;
    let rows=stmt.query_map([task],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?;
    let mut receipts=Vec::new();
    let mut since_visual=0;
    let mut total=0;
    for row in rows {
        let (receipt,name,input,output,status)=row?;
        total+=1;
        let args:Value=serde_json::from_str(&input)?;
        let result:Value=serde_json::from_str(&output).unwrap_or(Value::Null);
        if name=="record_visual_observations"&&status=="complete" {since_visual=0;}
        else if is_retrieval(&name) {since_visual+=1;}
        let targets:Vec<String>=if let Some(source)=args["source_id"].as_str(){vec![source.into()]}
            else if let Some(id)=args["record_id"].as_str(){records.iter().find(|r|r.id==id).map(|r|r.dependencies.clone()).unwrap_or_default()}
            else {Vec::new()};
        if status=="complete"&&["read_text","read_extract_revision","read_record","read_artifact"].contains(&name.as_str()) {
            for source in targets {
                if let Some(row)=source_rows.get_mut(&source) {
                    let read=json!({"tool":name,"arguments":args,"receipt":receipt,"revision":result["revision"],"start":result["start_line"].as_u64().or(result["start"].as_u64()),"end":result["end_line"].as_u64().or(result["end"].as_u64()),"next_start":result["next_start"],"next_offset":result["next_offset"]});
                    row["read_count"]=json!(row["read_count"].as_u64().unwrap_or(0)+1);
                    let duplicate=row["reads"].as_array().unwrap().iter().any(|r|r["tool"]==read["tool"]&&r["arguments"]==read["arguments"]);
                    if !duplicate {
                        let reads=row["reads"].as_array_mut().unwrap();
                        reads.push(read);
                        if reads.len()>24 {reads.remove(0);}
                    }
                }
            }
        }
        if name=="record_visual_observations"&&status=="complete" {
            if let Some(observations)=result["observations"].as_array() {
                for observation in observations {
                    if let Some(row)=observation["source_id"].as_str().and_then(|id|source_rows.get_mut(id)) {
                        let mut item=observation.clone();item["receipt"]=json!(receipt);
                        for field in ["description","visible_text","uncertainty"] {if let Some(text)=item[field].as_str(){item[field]=json!(text.chars().take(600).collect::<String>());}}
                        row["visual_observation_count"]=json!(row["visual_observation_count"].as_u64().unwrap_or(0)+1);
                        let observations=row["visual_observations"].as_array_mut().unwrap();
                        observations.push(item);
                        if observations.len()>24 {observations.remove(0);}
                    }
                }
            }
        }
        receipts.push(json!({"receipt":receipt,"tool":name,"arguments":args,"status":status,"error":result["error"]}));
    }
    Ok(json!({"sources":source_rows.into_values().collect::<Vec<_>>(),"recent_receipts":receipts.iter().rev().take(12).collect::<Vec<_>>(),"actions":total,"retrievals_since_visual":since_visual,"meaning":"Per-source reads show the 24 most recent distinct retrievals; visual observations show the 24 most recent samples. Counts are completed actions, not unique coverage. This is not a complete coverage ledger. Read ranges record retrieval, not verification or exhaustive coverage. Audio tracks are not speaker identities. Visual observations are unreviewed AI descriptions of sampled frames only. Full exact results remain available via read_receipt. Do not reread whole transcripts merely because earlier context was compacted."}))
}
