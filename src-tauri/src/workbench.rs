//! Case-level investigation navigation and independently reviewable alternatives.
use crate::case::{Case, now};
use anyhow::{ensure, Context, Result};
use serde_json::{json,Value};

pub fn hypotheses(case:&mut Case,task:&str,args:&Value)->Result<Value> {
    crate::dossier::view(case,task)?;
    ensure!(args.to_string().len()<=64000,"Hypothesis set too large");
    let dossier=crate::dossier::load(case,task)?.context("Create a dossier first")?;
    ensure!(args["dossier_revision"].as_u64()==Some(dossier.revision),"Dossier revision changed");
    let alternatives=args["alternatives"].as_array().context("Supply alternatives")?;
    ensure!(!alternatives.is_empty()&&alternatives.len()<=12,"Supply 1 to 12 bounded alternatives");
    let scope:String=case.db.query_row("SELECT scope FROM tasks WHERE id=?",[task],|r|r.get(0))?;
    let scope:Vec<String>=serde_json::from_str(&scope)?;
    for alternative in alternatives {
        for field in ["explanation","unresolved_premise","prediction","discriminating_check"] {
            ensure!(alternative[field].as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=4000),"Every alternative requires an explanation, premise, prediction and discriminating check");
        }
        let citations=alternative["citations"].as_array().context("Supply source citations")?;
        ensure!(!citations.is_empty(),"An alternative must connect to inspected evidence");
        for citation in citations {let v=case.validate_citation(citation.as_str().context("Invalid citation")?)?;ensure!(scope.iter().any(|s|Some(s.as_str())==v["source_id"].as_str()),"Alternative cites evidence outside task scope");}
    }
    let value=json!({"dossier_revision":dossier.revision,"alternatives":alternatives,"evidence_stamp":crate::dossier::evidence_stamp(case,task)?,"created_at":now(),"review":"unreviewed hypotheses, not findings"});
    case.set_meta(&format!("hypotheses:{task}:{}",dossier.revision),&value.to_string())?;
    case.audit("competing_explanations_saved",json!({"task":task,"value":value}))?;
    Ok(value)
}
pub fn view(case:&Case,offset:u64)->Result<Value> {
    let mut statement=case.db.prepare("SELECT t.id,t.prompt,t.status FROM tasks t WHERE EXISTS(SELECT 1 FROM meta m WHERE m.key='dossier:'||t.id) AND NOT EXISTS(SELECT 1 FROM json_each(t.scope) j JOIN sources s ON s.id=j.value WHERE s.restricted=1) ORDER BY t.updated_at DESC,t.id LIMIT 31 OFFSET ?")?;
    let mut tasks=statement.query_map([offset.min(i64::MAX as u64) as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more=tasks.len()>30;tasks.truncate(30);let mut investigations=vec![];
    for (task,prompt,status) in tasks {
        let dossier=crate::dossier::view(case,&task)?;
        let revision=dossier["dossier"]["revision"].as_u64().unwrap_or(0);
        let hypotheses=case.meta(&format!("hypotheses:{task}:{revision}"))?.map(|s|serde_json::from_str::<Value>(&s)).transpose()?;
        let previous=if revision>1 {case.meta(&format!("dossier:{task}:{}",revision-1))?.map(|s|serde_json::from_str::<Value>(&s)).transpose()?}else{None};
        investigations.push(json!({"task_id":task,"question":prompt,"status":status,"view":dossier,"hypotheses":hypotheses,"previous":previous}));
    }
    let mut query=case.db.prepare("SELECT o.id FROM evidence_objects o JOIN evidence_versions v ON v.object_id=o.id AND v.revision=o.current_revision WHERE v.stale=1 AND NOT EXISTS(SELECT 1 FROM json_each(v.source_ids) j JOIN sources s ON s.id=j.value WHERE s.restricted=1) ORDER BY v.created_at DESC LIMIT 100")?;
    let ids=query.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let affected=ids.iter().map(|id|crate::evidence::read(case,id,None)).collect::<Result<Vec<_>>>()?;
    Ok(json!({"investigations":investigations,"affected_objects":affected,"next_offset":if more {Some(offset+30)}else{None}}))
}
pub fn replay(case:&Case,clock_ids:&[String])->Result<Value> {
    ensure!(clock_ids.len()>=2 && clock_ids.len()<=4,"Select two to four clock mappings");
    let mut sources=std::collections::HashSet::new();let mut recordings=vec![];
    let mut start=f64::NEG_INFINITY;let mut end=f64::INFINITY;
    for id in clock_ids {
        let object=crate::evidence::read(case,id,None)?;
        ensure!(object["kind"]=="clock" && object["review"]=="accepted" && object["stale"]==false,"Replay requires current, human-accepted clock mappings");
        let content:Value=serde_json::from_str(object["content"].as_str().context("Clock content missing")?)?;
        ensure!(content["clock_domain"]=="container_relative","Clock must explicitly use container-relative playback seconds; revise older proposals");
        let anchors:Vec<crate::evidence::Anchor>=serde_json::from_value(content["anchors"].clone())?;
        let fit=crate::evidence::fit_clock(&anchors)?;
        ensure!(fit["held_out_checks_passed"]==true,"Clock requires independent held-out anchors within its supported range");
        let source=object["source_ids"].as_array().filter(|s|s.len()==1).and_then(|s|s[0].as_str()).context("Clock must identify one recording")?;
        ensure!(sources.insert(source.to_string()) && case.source(source)?.kind=="video","Select distinct video recordings");
        let scale=fit["scale"].as_f64().unwrap();let offset=fit["offset_seconds"].as_f64().unwrap();
        start=start.max(fit["valid_source_range"][0].as_f64().unwrap()*scale+offset);
        end=end.min(fit["valid_source_range"][1].as_f64().unwrap()*scale+offset);
        recordings.push(json!({"source_id":source,"name":case.source(source)?.name,"clock_id":id,"clock_revision":object["revision"],"fit":fit}));
    }
    ensure!(end>start,"Accepted clock ranges do not overlap");
    Ok(json!({"recordings":recordings,"incident_range":[start,end],"note":"Clock fit uncertainty remains visible. Browser playback is approximate; exact findings require original PTS-based evidence."}))
}
pub fn coverage_map(case:&Case,offset:u64)->Result<Value> {
    let mut query=case.db.prepare("SELECT id FROM sources WHERE restricted=0 ORDER BY name,id LIMIT 51 OFFSET ?")?;
    let mut ids=query.query_map([offset.min(i64::MAX as u64)as i64],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more=ids.len()>50;ids.truncate(50);let mut rows=vec![];
    for id in ids {
        let source=case.source(&id)?;
        let text_lines:u64=case.db.query_row("SELECT coalesce((SELECT length(text)-length(replace(text,char(10),''))+1 FROM extracts WHERE source_id=?),0)",[&id],|r|r.get(0))?;
        let mut query=case.db.prepare("SELECT metadata FROM artifacts WHERE source_id=? ORDER BY created_at")?;
        let metadata=query.query_map([&id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut pages=std::collections::BTreeSet::new();let mut times=vec![];let mut duration=None;
        for raw in metadata {let m:Value=serde_json::from_str(&raw)?;if m["redaction"]==true {continue;}
            if let Some(p)=m["page"].as_u64(){pages.insert(p);}
            if let Some(t)=m["source_relative_seconds"].as_f64(){if t.is_finite(){times.push(t);}}
            if let Some(t)=m["container_duration_seconds"].as_f64(){duration=Some(t);}
        }
        times.sort_by(f64::total_cmp);times.dedup();let count=times.len();times.truncate(200);
        let receipts:u64=case.db.query_row("SELECT count(*) FROM coverage_receipts WHERE source_id=?",[&id],|r|r.get(0))?;
        let failed:u64=case.db.query_row("SELECT count(*) FROM processing_jobs WHERE source_id=? AND status IN ('failed','interrupted')",[&id],|r|r.get(0))?;
        let next=if failed>0 {"Inspect processing failures and recover or retry missing work"}else if source.kind=="video" && count==0 {"Inspect the event window as an ordered frame sequence; text cannot establish silent actions"}else if source.kind=="pdf" && pages.is_empty(){"Render relevant physical pages and inspect scanned or layout-dependent evidence"}else if text_lines==0 {"Prepare this source and inspect extraction limitations"}else{"Select a material unresolved claim and check it against the original and contrary evidence"};
        rows.push(json!({"source_id":id,"name":source.name,"kind":source.kind,"status":source.status,"extracted_lines":text_lines,"rendered_pages":pages,"sampled_frame_count":count,"sampled_seconds":times,"sample_list_truncated":count>200,"duration_seconds":duration,"inspection_receipts":receipts,"failed_jobs":failed,"next_check":next}));
    }
    Ok(json!({"sources":rows,"next_offset":if more{Some(offset+50)}else{None},"note":"Preparation, rendering, sampling and retrieval are separate observations. None establishes exhaustive review. Frame gaps remain unobserved; transcript accuracy and speaker identity require separate checks. Detailed task contracts appear in each question dossier."}))
}
pub fn save_track(case:&mut Case,task:&str,args:&Value)->Result<Value> {
    use crate::evidence::ObjectInput;
    let raw:String=case.db.query_row("SELECT scope FROM tasks WHERE id=?",[task],|r|r.get(0))?;let scope:Vec<String>=serde_json::from_str(&raw)?;
    let source=args["source_id"].as_str().context("Missing recording")?;ensure!(scope.iter().any(|s|s==source)&&!case.source(source)?.restricted&&case.source(source)?.kind=="video","Choose a permitted video");
    let entries:Vec<Value>=serde_json::from_str(args["observations_json"].as_str().context("Missing observations")?)?;
    ensure!((2..=100).contains(&entries.len()),"A track requires 2 to 100 observed frames");
    let mut observations=vec![];let mut locators=vec![];let mut previous=f64::NEG_INFINITY;
    for entry in entries {
        let artifact=entry["artifact_id"].as_str().context("Missing decoded frame")?;
        let (sid,mime,_,metadata)=crate::processing::artifact(case,artifact)?;
        ensure!(sid==source&&mime=="image/jpeg","Observation must use a frame of this recording");
        let seconds=metadata["source_relative_seconds"].as_f64().context("Artifact is not a timestamped frame")?;
        ensure!(seconds.is_finite()&&seconds>previous,"Observations must be in strictly increasing decoder timestamp order");previous=seconds;
        let description=entry["description"].as_str().context("Describe the visible observation")?;
        ensure!(!description.trim().is_empty()&&description.len()<=4000,"Invalid observation description");
        let uncertainty=entry["uncertainty"].as_str().context("State association uncertainty")?;
        let locator=format!("evidence:{source}#artifact:{artifact}");locators.push(locator.clone());
        observations.push(json!({"artifact_id":artifact,"locator":locator,"source_relative_seconds":seconds,"pts":metadata["pts"],"time_base":metadata["time_base"],"description":description,"uncertainty":uncertainty}));
    }
    let start=observations.first().unwrap()["source_relative_seconds"].as_f64();let end=Some(previous);
    crate::evidence::write(case,ObjectInput{id:args["id"].as_str().filter(|s|!s.is_empty()).map(str::to_owned),base_revision:args["base_revision"].as_i64().context("Missing revision")?,kind:"track".into(),title:args["title"].as_str().context("Missing track title")?.into(),content:json!({"observations":observations,"association":"Unreviewed association hypothesis; identity, continuous motion and visibility across frame gaps are not established","source_id":source}).to_string(),source_ids:scope,locators,dependencies:vec![],start_seconds:start,end_seconds:end},"agent")
}
