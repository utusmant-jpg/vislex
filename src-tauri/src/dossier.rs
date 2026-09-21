//! Durable question dossiers. Machine checks never confer human approval.
use crate::case::{digest, now, Case};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub id: String,
    pub description: String,
    pub source_id: String,
    pub tool: String,
    pub state: String,
    pub receipts: Vec<String>,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub proposition: String,
    pub assessment: String,
    pub supporting: Vec<String>,
    pub contrary: Vec<String>,
    pub uncertainty: String,
    pub next_check: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dossier {
    pub revision: u64,
    pub scope: String,
    pub checks: Vec<Check>,
    pub claims: Vec<Claim>,
}
pub fn load(case: &Case, task: &str) -> Result<Option<Dossier>> {
    case.meta(&format!("dossier:{task}"))?
        .map(|v| serde_json::from_str(&v).map_err(Into::into))
        .transpose()
}

/// Revision fingerprint includes evidence metadata, not task/review receipts or generated reports.
/// Conservatively invalidates across source analysis changes; no hidden model reasoning is stored.
pub fn evidence_stamp(case: &Case, task: &str) -> Result<String> {
    let (scope, generation): (String, i64) = case.db.query_row(
        "SELECT scope,generation FROM tasks WHERE id=?",
        [task],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut parts = vec![
        scope.clone(),
        generation.to_string(),
        case.generation()?.to_string(),
    ];
    for sql in [
        "SELECT s.id||':'||s.sha256||':'||s.restricted FROM sources s JOIN json_each(?1) j ON j.value=s.id ORDER BY s.id",
        "SELECT e.source_id||':'||e.revision||':'||e.method FROM extracts e JOIN json_each(?1) j ON j.value=e.source_id ORDER BY e.source_id",
        "SELECT r.id||':'||r.revision||':'||r.review FROM records r WHERE EXISTS(SELECT 1 FROM json_each(r.dependencies) d JOIN json_each(?1) j ON d.value=j.value) AND r.id!=?2 ORDER BY r.id",
        "SELECT v.object_id||':'||v.revision||':'||v.stale||':'||v.review FROM evidence_versions v JOIN evidence_objects o ON o.id=v.object_id AND o.current_revision=v.revision WHERE EXISTS(SELECT 1 FROM json_each(v.source_ids) d JOIN json_each(?1) j ON d.value=j.value) ORDER BY v.object_id",
    ] {
        let mut statement = case.db.prepare(sql)?;
        let own_report=case.meta(&format!("completion_record:{task}"))?.unwrap_or_default();
        let mut rows = if sql.contains("?2") { statement.query(params![scope, own_report])? } else { statement.query([&scope])? };
        while let Some(row) = rows.next()? { parts.push(digest(row.get::<_,String>(0)?.as_bytes())); }
    }
    Ok(digest(serde_json::to_string(&parts)?.as_bytes()))
}
pub fn candidate_stamp(case: &Case, task: &str, candidate: &Value) -> Result<String> {
    Ok(digest(json!({"policy":1,"candidate":candidate,"evidence":evidence_stamp(case,task)?,"dossier":load(case,task)?,"coverage":crate::coverage::load(case,task)?}).to_string().as_bytes()))
}
pub fn review_candidate(case: &mut Case, task: &str, args: &Value) -> Result<Value> {
    ensure!(args.to_string().len() <= 100000, "Review is too large");
    let d = load(case, task)?.context("Declare a dossier before reviewing claims")?;
    ensure!(
        args["revision"].as_u64() == Some(d.revision),
        "Dossier changed; review the current revision"
    );
    let candidate = &args["candidate"];
    ensure!(
        candidate["answer"].is_string()
            && candidate["citations"].is_array()
            && candidate["gaps"].is_array(),
        "Invalid final candidate"
    );
    let stamp = candidate_stamp(case, task, candidate)?;
    ensure!(
        case.meta(&format!("support_candidate:{task}"))?.as_deref() == Some(stamp.as_str()),
        "Submit this exact candidate through finish_task first"
    );
    let assessments = args["assessments"]
        .as_array()
        .context("Missing claim assessments")?;
    ensure!(
        assessments.len() == d.claims.len() && !assessments.is_empty(),
        "Assess every dossier claim"
    );
    let mut seen = std::collections::HashSet::new();
    for assessment in assessments {
        let index = assessment["claim_index"]
            .as_u64()
            .context("Missing claim index")? as usize;
        ensure!(
            index < d.claims.len() && seen.insert(index),
            "Invalid or duplicate claim assessment"
        );
        let state = assessment["state"].as_str().unwrap_or("");
        ensure!(
            ["supported", "overstated", "contradicted", "unresolved"].contains(&state),
            "Invalid claim review state"
        );
        ensure!(
            assessment["reason"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty()),
            "Review needs a source-based explanation"
        );
        if state == "supported" {
            ensure!(
                !d.claims[index].supporting.is_empty(),
                "Supported assessment requires source evidence"
            );
        }
    }
    let review = json!({"stamp":stamp,"revision":d.revision,"assessments":assessments,"actor":"agent","created_at":now()});
    case.set_meta(&format!("claim_review:{task}:{stamp}"), &review.to_string())?;
    case.audit(
        "candidate_claim_reviewed",
        json!({"task":task,"review":review}),
    )?;
    Ok(
        json!({"status":"assessments_recorded","stamp":stamp,"review":"Machine assessment, not proof or human approval"}),
    )
}
fn validate_locator(case: &Case, locator: &str, scope: &[String]) -> Result<()> {
    let result = case.validate_citation(locator)?;
    let source = result["source_id"].as_str().context("Missing source")?;
    ensure!(
        scope.iter().any(|s| s == source) && !case.source(source)?.restricted,
        "Dossier citation outside permitted scope"
    );
    Ok(())
}
pub fn save(case: &mut Case, task: &str, value: &Value) -> Result<Value> {
    ensure!(
        value.to_string().len() <= 64000,
        "Dossier exceeds size limit"
    );
    let mut next: Dossier = serde_json::from_value(value.clone())?;
    let old = load(case, task)?;
    ensure!(
        next.revision == old.as_ref().map_or(0, |d| d.revision),
        "Dossier changed; reload before editing"
    );
    ensure!(
        !next.scope.trim().is_empty()
            && next.scope.len() <= 4000
            && next.checks.len() <= 100
            && next.claims.len() <= 100,
        "Invalid dossier scope or item count"
    );
    let scope: String = case
        .db
        .query_row("SELECT scope FROM tasks WHERE id=?", [task], |r| r.get(0))?;
    let scope: Vec<String> = serde_json::from_str(&scope)?;
    let stamp = evidence_stamp(case, task)?;
    let changed = old.is_some()
        && case.meta(&format!("dossier_evidence:{task}"))?.as_deref() != Some(stamp.as_str());
    let mut ids = std::collections::HashSet::new();
    for check in &next.checks {
        ensure!(
            !check.id.is_empty() && ids.insert(&check.id) && !check.description.trim().is_empty(),
            "Checks require unique IDs and descriptions"
        );
        ensure!(
            ["open", "done", "blocked"].contains(&check.state.as_str()),
            "Invalid check state"
        );
        ensure!(
            scope.contains(&check.source_id) && !case.source(&check.source_id)?.restricted,
            "Check source outside permitted scope"
        );
        ensure!(
            [
                "read_text",
                "read_artifact",
                "read_record",
                "inspect_image",
                "inspect_document_pages",
                "inspect_video_interval",
                "transcribe_audio_interval",
                "discover_sound_events"
            ]
            .contains(&check.tool.as_str()),
            "Check must name a source inspection tool"
        );
        if check.state == "blocked" {
            ensure!(
                !check.reason.trim().is_empty(),
                "Blocked checks need a reason"
            );
        }
        if check.state == "done" {
            ensure!(
                !check.receipts.is_empty(),
                "Completed checks need actual inspection receipts"
            );
            if changed {
                if let Some(previous) = old
                    .as_ref()
                    .and_then(|d| d.checks.iter().find(|c| c.id == check.id))
                {
                    ensure!(
                        check
                            .receipts
                            .iter()
                            .any(|r| !previous.receipts.contains(r)),
                        "Evidence changed; reinspect before completing this obligation again"
                    );
                }
            }
            for receipt in &check.receipts {
                let input: Option<String> = case.db.query_row("SELECT input FROM actions WHERE id=? AND task_id=? AND name=? AND status='complete'", params![receipt,task,check.tool], |r|r.get(0)).optional()?;
                let input: Value = serde_json::from_str(
                    &input.context("Inspection receipt missing or from another task/tool")?,
                )?;
                if check.tool == "read_record" {
                    let record = case.record(
                        input["record_id"]
                            .as_str()
                            .context("Receipt missing record")?,
                    )?;
                    ensure!(
                        record.dependencies.contains(&check.source_id),
                        "Receipt does not inspect this source"
                    );
                } else {
                    ensure!(
                        input["source_id"].as_str() == Some(check.source_id.as_str()),
                        "Receipt does not inspect this source"
                    );
                }
            }
        }
    }
    if let Some(old) = &old {
        for check in &old.checks {
            ensure!(next.checks.iter().any(|c|c.id==check.id && c.source_id==check.source_id && c.tool==check.tool && c.description==check.description), "Existing obligations cannot be removed or redefined; mark them blocked with a reason");
        }
    }
    for claim in &next.claims {
        ensure!(
            !claim.proposition.trim().is_empty(),
            "Claim needs a proposition"
        );
        ensure!(
            [
                "supported_within_scope",
                "possible_inconsistency",
                "direct_inconsistency",
                "omission",
                "changed_account",
                "ambiguous",
                "timing_uncertainty",
                "extraction_error",
                "insufficient_evidence"
            ]
            .contains(&claim.assessment.as_str()),
            "Invalid assessment"
        );
        if claim.assessment == "supported_within_scope" {
            ensure!(
                !claim.supporting.is_empty(),
                "Supported claims require evidence"
            );
        }
        if claim.assessment == "direct_inconsistency" {
            ensure!(
                !claim.supporting.is_empty() && !claim.contrary.is_empty(),
                "Direct inconsistency requires both sides"
            );
        }
        for citation in claim.supporting.iter().chain(&claim.contrary) {
            validate_locator(case, citation, &scope)?;
        }
    }
    next.revision += 1;
    case.db.execute_batch("SAVEPOINT save_dossier")?;
    let result = (|| -> Result<()> {
        let encoded = serde_json::to_string(&next)?;
        case.set_meta(&format!("dossier:{task}:{}", next.revision), &encoded)?;
        case.set_meta(&format!("dossier:{task}"), &encoded)?;
        case.set_meta(&format!("dossier_evidence:{task}"), &stamp)?;
        case.audit(
            "dossier_saved",
            json!({"task":task,"revision":next.revision,"evidence_stamp":stamp}),
        )
    })();
    if let Err(error) = result {
        case.db
            .execute_batch("ROLLBACK TO save_dossier; RELEASE save_dossier")?;
        return Err(error);
    }
    case.db.execute_batch("RELEASE save_dossier")?;
    view(case, task)
}
pub fn view(case: &Case, task: &str) -> Result<Value> {
    let scope: String = case
        .db
        .query_row("SELECT scope FROM tasks WHERE id=?", [task], |r| r.get(0))?;
    for source in serde_json::from_str::<Vec<String>>(&scope)? {
        ensure!(
            !case.source(&source)?.restricted,
            "A dossier source is restricted; its derived contents cannot be displayed"
        );
    }
    let dossier = load(case, task)?;
    let stamp = evidence_stamp(case, task)?;
    let completion: Option<Value> = case
        .meta(&format!("completion:{task}"))?
        .map(|v| serde_json::from_str(&v))
        .transpose()?;
    let stale = dossier.is_some()
        && case.meta(&format!("dossier_evidence:{task}"))?.as_deref() != Some(stamp.as_str());
    let completion_stale = completion
        .as_ref()
        .is_some_and(|v| v["evidence_stamp"].as_str() != Some(stamp.as_str()));
    let reviews: Vec<Value> = if let Some(d) = &dossier {
        (0..d.claims.len())
            .map(|index| -> Result<Value> {
                let review: Option<Value> = case
                    .meta(&format!("dossier_review:{task}:{}:{index}", d.revision))?
                    .map(|v| serde_json::from_str(&v))
                    .transpose()?;
                Ok(review
                    .map(|mut v| {
                        v["stale"] = json!(v["evidence_stamp"].as_str() != Some(stamp.as_str()));
                        v
                    })
                    .unwrap_or(Value::Null))
            })
            .collect::<Result<_>>()?
    } else {
        vec![]
    };
    Ok(
        json!({"dossier":dossier,"stale":stale,"completion_stale":completion_stale,"completion":completion,"human_reviews":reviews,"review":"AI assessments / not human reviewed unless explicitly marked","hypotheses":case.meta(&format!("hypotheses:{task}:{}",dossier.as_ref().map_or(0,|d|d.revision)))?.map(|s|serde_json::from_str::<Value>(&s)).transpose()?,"coverage":crate::coverage::view(case,task)?,"coverage_note":"Receipts establish source inspection calls, not exhaustive coverage or the truth of a claim."}),
    )
}
pub fn human_review(
    case: &mut Case,
    task: &str,
    revision: u64,
    index: usize,
    decision: &str,
    note: &str,
) -> Result<Value> {
    let current = view(case, task)?;
    let dossier = load(case, task)?.context("No dossier to review")?;
    ensure!(
        dossier.revision == revision && index < dossier.claims.len(),
        "Dossier changed; reload before reviewing"
    );
    ensure!(
        current["stale"] != true,
        "Evidence changed; recheck dossier before approval"
    );
    ensure!(
        ["accepted", "rejected", "needs_review"].contains(&decision) && note.len() <= 4000,
        "Invalid review decision"
    );
    let review = json!({"decision":decision,"note":note,"actor":"human","revision":revision,"claim":index,"evidence_stamp":evidence_stamp(case,task)?,"created_at":now()});
    case.db.execute_batch("SAVEPOINT dossier_review")?;
    let result = (|| -> Result<()> {
        case.set_meta(
            &format!("dossier_review:{task}:{revision}:{index}"),
            &review.to_string(),
        )?;
        case.audit(
            "dossier_claim_reviewed",
            json!({"task":task,"review":review}),
        )
    })();
    if let Err(error) = result {
        case.db
            .execute_batch("ROLLBACK TO dossier_review; RELEASE dossier_review")?;
        return Err(error);
    }
    case.db.execute_batch("RELEASE dossier_review")?;
    view(case, task)
}
pub fn completion(case: &Case, task: &str, candidate: &Value) -> Result<Value> {
    let dossier = load(case, task)?;
    let stamp = evidence_stamp(case, task)?;
    let mut gaps: Vec<String> = serde_json::from_value(candidate["gaps"].clone())?;
    gaps.extend(crate::coverage::gaps(case,task)?);
    let citations = candidate["citations"]
        .as_array()
        .context("Missing citations")?;
    let mut outcome = "unreviewed";
    if let Some(d) = dossier {
        let review_stamp = candidate_stamp(case, task, candidate)?;
        if let Some(review) = case.meta(&format!("claim_review:{task}:{review_stamp}"))? {
            let review: Value = serde_json::from_str(&review)?;
            for assessment in review["assessments"]
                .as_array()
                .context("Invalid saved review")?
            {
                if assessment["state"] != "supported" {
                    gaps.push(format!(
                        "Claim {} review is {}: {}",
                        assessment["claim_index"],
                        assessment["state"].as_str().unwrap_or("unresolved"),
                        assessment["reason"].as_str().unwrap_or("")
                    ));
                }
            }
        } else {
            gaps.push(
                "No claim-level review is bound to this exact answer and evidence revision.".into(),
            );
        }
        for claim in &d.claims {
            if !candidate["answer"]
                .as_str()
                .unwrap_or("")
                .contains(&claim.proposition)
            {
                gaps.push(format!(
                    "Final answer does not contain the assessed proposition verbatim: {}",
                    claim.proposition
                ));
            }
            for citation in claim.supporting.iter().chain(&claim.contrary) {
                if !citations
                    .iter()
                    .any(|v| v.as_str() == Some(citation.as_str()))
                {
                    gaps.push(format!(
                        "Final source list omits dossier evidence: {citation}"
                    ));
                }
            }
        }
        for check in d.checks.iter().filter(|c| c.state != "done") {
            gaps.push(format!(
                "{}: {}{}",
                check.state,
                check.description,
                if check.reason.is_empty() {
                    String::new()
                } else {
                    format!(" — {}", check.reason)
                }
            ));
        }
        let stale =
            case.meta(&format!("dossier_evidence:{task}"))?.as_deref() != Some(stamp.as_str());
        if stale {
            gaps.push("Evidence changed since the dossier assessment; recheck its claims and inspection obligations.".into());
        }
        if !stale
            && gaps.is_empty()
            && !citations.is_empty()
            && !d.checks.is_empty()
            && !d.claims.is_empty()
            && d.claims
                .iter()
                .all(|c| c.assessment == "supported_within_scope")
        {
            outcome = "declared_checks_complete";
        } else {
            outcome = "partial";
        }
    } else {
        gaps.push("No structured investigation contract was supplied; scope completion and claim support are unverified.".into());
    }
    if citations.is_empty() {
        gaps.push("No source citations supplied; this response does not establish an evidentiary finding.".into());
        outcome = "unreviewed";
    }
    gaps.sort();
    gaps.dedup();
    Ok(
        json!({"outcome":outcome,"gaps":gaps,"draft_hash":digest(candidate.to_string().as_bytes()),"evidence_stamp":stamp,"review":"AI-generated / not human reviewed","created_at":now()}),
    )
}
