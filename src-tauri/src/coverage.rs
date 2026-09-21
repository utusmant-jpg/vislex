//! Explicit coverage contracts. Retrieval, rendering and transcription are distinct operations.
use crate::case::{Case, digest, now};
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub source_id: String,
    pub stage: String,
    pub start: u64,
    pub end: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    pub revision: u64,
    pub mode: String,
    pub purpose: String,
    pub requirements: Vec<Requirement>,
}
fn scope(case: &Case, task: &str) -> Result<Vec<String>> {
    let raw: String = case.db.query_row("SELECT scope FROM tasks WHERE id=?", [task], |r| r.get(0))?;
    Ok(serde_json::from_str(&raw)?)
}
pub fn load(case: &Case, task: &str) -> Result<Option<Contract>> {
    case.meta(&format!("coverage_contract:{task}"))?.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}
fn version(case: &Case, source: &str) -> Result<String> {
    let s = case.source(source)?;
    let revision: i64 = case.db.query_row("SELECT coalesce((SELECT revision FROM extracts WHERE source_id=?),0)", [source], |r| r.get(0))?;
    Ok(digest(format!("{}:{revision}", s.sha256).as_bytes()))
}
pub fn save(case: &mut Case, task: &str, args: &Value) -> Result<Value> {
    ensure!(args.to_string().len() <= 100000, "Contract too large");
    let mut contract: Contract = serde_json::from_value(args.clone())?;
    let old = load(case, task)?;
    ensure!(contract.revision == old.as_ref().map_or(0, |c| c.revision), "Contract changed; reload it");
    ensure!(["targeted", "exhaustive", "administrative"].contains(&contract.mode.as_str()), "Invalid contract mode");
    ensure!(!contract.purpose.trim().is_empty() && contract.purpose.len() <= 4000, "Describe the investigation purpose");
    ensure!(contract.requirements.len() <= 1000, "Too many requirements");
    ensure!(contract.mode == "administrative" || !contract.requirements.is_empty(), "Evidence contracts require explicit units");
    let ids = scope(case, task)?;
    for r in &contract.requirements {
        ensure!(ids.contains(&r.source_id) && !case.source(&r.source_id)?.restricted, "Source outside permitted scope");
        ensure!(["text_retrieved", "page_rendered"].contains(&r.stage.as_str()), "Unsupported coverage stage; interval samples cannot establish exhaustive perception");
        ensure!(r.start > 0 && r.end >= r.start && r.end - r.start < 1000000, "Invalid unit range");
        if r.stage == "text_retrieved" {
            let text: String = case.db.query_row("SELECT text FROM extracts WHERE source_id=?", [&r.source_id], |row| row.get(0))?;
            ensure!(r.end <= text.lines().count() as u64, "Line range exceeds extraction");
            if contract.mode == "exhaustive" { ensure!(r.start == 1 && r.end == text.lines().count() as u64, "Exhaustive text scope must include every extracted line"); }
        } else {
            ensure!(case.source(&r.source_id)?.kind == "pdf", "Physical pages require PDF evidence");
            let pages:Option<u64> = case.db.query_row("SELECT max(CAST(json_extract(metadata,'$.page_count') AS INTEGER)) FROM artifacts WHERE source_id=?",[&r.source_id],|row|row.get(0))?;
            let pages=pages.context("Render a page first to establish the physical page denominator")?;
            ensure!(r.end<=pages,"Physical page range exceeds document");
            if contract.mode == "exhaustive" {ensure!(r.start==1 && r.end==pages,"Exhaustive page scope must include every physical page");}
        }
    }
    if let Some(old) = old {
        ensure!(old.mode == contract.mode, "A contract cannot downgrade its declared mode");
        ensure!(old.requirements.iter().all(|r| contract.requirements.contains(r)), "Existing coverage requirements cannot disappear or shrink");
    }
    if contract.mode == "exhaustive" {
        ensure!(ids.iter().all(|s| contract.requirements.iter().any(|r| &r.source_id == s)), "Exhaustive scope must enumerate every scoped source");
    }
    contract.revision += 1;
    case.set_meta(&format!("coverage_contract:{task}"), &serde_json::to_string(&contract)?)?;
    case.set_meta(&format!("coverage_contract:{task}:{}", contract.revision), &serde_json::to_string(&contract)?)?;
    case.audit("coverage_contract_saved", json!({"task":task,"contract":contract}))?;
    view(case, task)
}
/// Only application-observed successful outputs create receipts. A rendered page is not a reviewed page.
pub fn observe(case: &mut Case, task: &str, receipt: &str, name: &str, args: &Value, result: &Value) -> Result<()> {
    let Some(source) = args["source_id"].as_str() else { return Ok(()); };
    let mut ranges = vec![];
    if name == "read_text" && result["truncated_long_lines"] != true {
        if let (Some(a),Some(b)) = (result["start"].as_u64(),result["end"].as_u64()) { if a > 0 && b >= a { ranges.push(("text_retrieved",a,b)); } }
    }
    if ["inspect_document_page","inspect_document_pages"].contains(&name) {
        if let Some(frames) = result["frames"].as_array() {
            for frame in frames {
                if let Some(page) = frame["physical_page"].as_u64().or_else(|| frame["metadata"]["page"].as_u64()) { ranges.push(("page_rendered",page,page)); }
            }
        }
    }
    for (index,(stage,start,end)) in ranges.into_iter().enumerate() {
        case.db.execute("INSERT INTO coverage_receipts VALUES(?,?,?,?,?,?,?)", params![format!("{receipt}:{index}"),source,stage,name,format!("{start}-{end}"),json!({"task":task,"receipt":receipt,"start":start,"end":end,"version":version(case,source)?}).to_string(),now()])?;
    }
    Ok(())
}
pub fn missing(start:u64,end:u64, mut ranges:Vec<(u64,u64)>) -> Vec<(u64,u64)> {
    ranges.sort_unstable(); let mut cursor=start; let mut gaps=vec![];
    for (a,b) in ranges { if b<cursor || a>end {continue;} if a>cursor {gaps.push((cursor,a-1));} cursor=cursor.max(b.saturating_add(1)); if cursor>end {break;} }
    if cursor<=end {gaps.push((cursor,end));} gaps
}
pub fn view(case: &Case, task: &str) -> Result<Value> {
    let ids=scope(case,task)?;
    for s in &ids {ensure!(!case.source(s)?.restricted,"Restricted investigation source");}
    let contract=load(case,task)?; let mut rows=vec![];
    if let Some(c)=&contract {for r in &c.requirements {
        let mut query=case.db.prepare("SELECT details FROM coverage_receipts WHERE source_id=? AND stage=?")?;
        let details=query.query_map(params![r.source_id,r.stage],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let current=version(case,&r.source_id)?;
        let mut ranges=vec![];
        for raw in details {let d:Value=serde_json::from_str(&raw)?;if d["task"]==task && d["version"]==current {if let(Some(a),Some(b))=(d["start"].as_u64(),d["end"].as_u64()){ranges.push((a,b));}}}
        let gaps=missing(r.start,r.end,ranges);
        rows.push(json!({"requirement":r,"missing":gaps,"complete":gaps.is_empty()}));
    }}
    Ok(json!({"contract":contract,"units":rows,"note":"Retrieval and rendering coverage do not certify perception, substantive review, or absence of events."}))
}
pub fn gaps(case:&Case,task:&str)->Result<Vec<String>> {
    let v=view(case,task)?; let mut gaps=vec![];
    if !v["contract"].is_null() {for row in v["units"].as_array().context("Invalid coverage")? {if row["complete"]!=true {gaps.push(format!("Uncovered {} units for {}: {}",row["requirement"]["stage"].as_str().unwrap_or(""),row["requirement"]["source_id"].as_str().unwrap_or(""),row["missing"]));}}}
    Ok(gaps)
}
