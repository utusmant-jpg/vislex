//! Human corrections are versioned annotations, never changes to machine transcripts or identity.
use crate::{case::{Case,now},processing};
use anyhow::{ensure,Context,Result};
use serde_json::{json,Value};

fn validate(case:&Case,source:&str,artifact:&str)->Result<Value> {
    ensure!(!case.source(source)?.restricted,"Restricted source");
    let (owner,mime,path,meta)=processing::artifact(case,artifact)?;
    ensure!(owner==source && mime=="application/json" && meta["kind"]=="diarization","Choose this recording's immutable speaker-turn artifact");
    ensure!(std::fs::metadata(&path)?.len()<=16*1024*1024,"Speaker artifact too large");
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
pub fn read(case:&Case,source:&str,artifact:&str)->Result<Value> {
    validate(case,source,artifact)?;
    Ok(case.meta(&format!("speaker_annotations:{artifact}"))?.map(|v|serde_json::from_str(&v)).transpose()?.unwrap_or(json!({"revision":0,"labels":{},"turns":{},"identity_verified":false})))
}
pub fn save(case:&mut Case,source:&str,artifact:&str,revision:u64,labels:&Value,turns:&Value)->Result<Value> {
    let raw=validate(case,source,artifact)?;
    let original=raw["metadata"]["turns"].as_array().context("Missing machine speaker turns")?;
    let speakers:Vec<_>=original.iter().filter_map(|t|t["speaker"].as_str()).collect();
    let names=labels.as_object().context("Labels must be an object")?;
    ensure!(names.len()<=100,"Too many labels");
    for (key,value) in names {ensure!(speakers.contains(&key.as_str())&&value.as_str().is_some_and(|v|!v.trim().is_empty()&&v.len()<=120),"Invalid speaker label");}
    let changes=turns.as_object().context("Turn corrections must be an object")?;
    ensure!(changes.len()<=original.len(),"Too many turn corrections");
    for (key,value) in changes {
        let index=key.parse::<usize>().context("Turn key must be its original zero-based index")?;
        ensure!(index<original.len(),"Unknown turn");
        let assignments=value.as_array().context("Each turn requires speaker IDs; empty means unknown")?;
        ensure!(assignments.len()<=10&&assignments.iter().all(|s|s.as_str().is_some_and(|s|speakers.contains(&s))),"Invalid speaker assignment");
    }
    let current=read(case,source,artifact)?;
    ensure!(current["revision"].as_u64()==Some(revision),"Speaker annotations changed; reload before saving");
    let next=json!({"revision":revision+1,"labels":labels,"turns":turns,"created_at":now(),"identity_verified":false,"note":"Human label/turn corrections; no authenticated person identity or transcript modification."});
    let tx=case.db.savepoint()?;
    for key in [format!("speaker_annotations:{artifact}"),format!("speaker_annotations:{artifact}:{}",revision+1)] {tx.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,next.to_string()])?;}
    tx.commit()?;
    case.audit("speaker_annotations_saved",json!({"source":source,"artifact":artifact,"revision":revision+1}))?;
    Ok(next)
}
