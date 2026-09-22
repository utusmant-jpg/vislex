//! Durable question dossiers. Machine checks never confer human approval.
use crate::case::{digest, id, now, Case};
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
    /// Stable addressable identifier; empty only for dossiers saved before
    /// structured publication existed (readable legacy data, never certifiable).
    #[serde(default)]
    pub id: String,
    pub proposition: String,
    pub assessment: String,
    pub supporting: Vec<String>,
    pub contrary: Vec<String>,
    pub uncertainty: String,
    pub next_check: String,
}
/// One unit of a structured final answer. Factual kinds (observation,
/// attributed_statement, inference) must reference dossier claim ids; their
/// wording is certified only through a block review bound to the exact
/// candidate, never through word-matching heuristics.
fn null_to_empty_strings<'de, D>(deserializer: D) -> std::result::Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<Vec<String>> = Option::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub id: String,
    pub kind: String,
    pub text: String,
    #[serde(default, deserialize_with = "null_to_empty_strings")]
    pub claims: Vec<String>,
}
pub fn block_kind_is_factual(kind: &str) -> bool {
    ["observation", "attributed_statement", "inference"].contains(&kind)
}
pub fn valid_block_kind(kind: &str) -> bool {
    [
        "observation",
        "attributed_statement",
        "inference",
        "hypothesis",
        "limitation",
        "next_action",
    ]
    .contains(&kind)
}
/// Accessible plain text derived from the same structured document, so the
/// published wording and the certified structure cannot diverge.
pub fn render_blocks(blocks: &[Block]) -> String {
    const LABELS: [(&str, &str); 6] = [
        ("observation", "Observation"),
        ("attributed_statement", "Attributed statement"),
        ("inference", "Inference"),
        ("hypothesis", "Hypothesis"),
        ("limitation", "Limitation"),
        ("next_action", "Next action"),
    ];
    blocks
        .iter()
        .map(|block| {
            let label = LABELS
                .iter()
                .find(|(kind, _)| *kind == block.kind)
                .map(|(_, label)| *label)
                .unwrap_or("Statement");
            format!("[{label}] {}", block.text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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
    // Structured candidates: every factual block needs its own support review
    // against this exact wording. Editing any block changes the stamp and
    // invalidates the whole review — there is no wording-similarity carryover.
    let blocks: Vec<Block> = candidate["blocks"]
        .as_array()
        .map(|blocks| serde_json::from_value(Value::Array(blocks.clone())))
        .transpose()?
        .unwrap_or_default();
    let block_reviews = args["block_reviews"].as_array();
    if !blocks.is_empty() {
        let reviews = block_reviews.context("Structured candidates require a per-block support review")?;
        let mut reviewed_ids = std::collections::HashSet::new();
        for review in reviews {
            let id = review["block_id"].as_str().context("Missing block id")?;
            ensure!(
                blocks.iter().any(|block| block.id == id) && reviewed_ids.insert(id),
                "Unknown or duplicate block review"
            );
            let state = review["state"].as_str().unwrap_or("");
            ensure!(["supported", "unsupported"].contains(&state), "Invalid block review state");
            ensure!(
                review["reason"].as_str().is_some_and(|s| !s.trim().is_empty()),
                "Block review needs a source-based explanation"
            );
            if state == "supported" && block_kind_is_factual(
                blocks.iter().find(|block| block.id == id).map(|b| b.kind.as_str()).unwrap_or(""),
            ) {
                ensure!(
                    !blocks.iter().any(|block| block.id == id && block.claims.is_empty()),
                    "A supported factual block must reference the assessed claims it restates"
                );
            }
        }
        for block in &blocks {
            ensure!(
                reviewed_ids.contains(block.id.as_str()),
                "Every answer block needs a review: {}",
                block.id
            );
            if !block_kind_is_factual(&block.kind) {
                ensure!(
                    block.claims.is_empty(),
                    "Non-factual block {} cannot reference claims; only factual blocks carry assessed findings",
                    block.id
                );
            }
        }
    }
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
    let review = json!({"stamp":stamp,"revision":d.revision,"assessments":assessments,"block_reviews":block_reviews.unwrap_or(&Vec::new()),"actor":"agent","created_at":now()});
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
    let mut claim_ids = std::collections::HashSet::new();
    for claim in &next.claims {
        ensure!(
            !claim.id.trim().is_empty() && claim_ids.insert(claim.id.clone()),
            "Claims require unique stable IDs so answer blocks can reference them"
        );
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
    let review = json!({"receipt":id(),"decision":decision,"note":note,"actor":"human","revision":revision,"claim":index,"evidence_stamp":evidence_stamp(case,task)?,"created_at":now()});
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
/// Content-word heuristics were removed with VL-008/009 sentence matching
/// (R03): matching words is not matching a factual proposition. Certification
/// now requires structured answer blocks whose factual wording is bound, by an
/// exact-candidate stamp, to per-block support reviews and assessed claims.

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
        let review: Option<Value> = case
            .meta(&format!("claim_review:{task}:{review_stamp}"))?
            .map(|v| serde_json::from_str(&v))
            .transpose()?;
        if let Some(review) = &review {
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
        let blocks: Vec<Block> = candidate["blocks"]
            .as_array()
            .map(|blocks| serde_json::from_value(Value::Array(blocks.clone())))
            .transpose()?
            .unwrap_or_default();
        // Legacy claims saved before structured publication have empty ids and
        // are deliberately unaddressable: blocks cannot bind to them.
        let claim_ids: std::collections::HashSet<&str> = d
            .claims
            .iter()
            .map(|claim| claim.id.as_str())
            .filter(|id| !id.is_empty())
            .collect();
        let block_reviews: std::collections::HashMap<String, &Value> = review
            .as_ref()
            .and_then(|review| review["block_reviews"].as_array())
            .map(|reviews| {
                reviews
                    .iter()
                    .filter_map(|review| {
                        review["block_id"].as_str().map(|id| (id.to_string(), review))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let supported_block = |block: &Block| {
            block_reviews
                .get(&block.id)
                .is_some_and(|review| review["state"] == "supported")
        };
        let mut block_status = Vec::new();
        let mut all_blocks_reviewed = !blocks.is_empty();
        let mut all_factual_blocks_bound = !blocks.is_empty();
        let mut carries_factual_block = false;
        for block in &blocks {
            let factual = block_kind_is_factual(&block.kind);
            let mut bound = true;
            if factual {
                carries_factual_block = true;
                if block.claims.is_empty() {
                    gaps.push(format!(
                        "Factual block {} asserts evidentiary content without referencing an assessed claim: {}",
                        block.id, block.text
                    ));
                    bound = false;
                }
                for claim_id in &block.claims {
                    if claim_id.is_empty() || !claim_ids.contains(claim_id.as_str()) {
                        gaps.push(format!(
                            "Block {} references unknown dossier claim: {claim_id}",
                            block.id
                        ));
                        bound = false;
                    }
                }
                if bound && !supported_block(block) {
                    gaps.push(format!(
                        "Factual block {} lacks a support review bound to this exact wording; it cannot inherit an earlier review of different wording.",
                        block.id
                    ));
                    all_blocks_reviewed = false;
                }
                if !bound {
                    all_factual_blocks_bound = false;
                }
            } else if !block.claims.is_empty() {
                gaps.push(format!(
                    "Non-factual block {} references claims; only factual blocks carry assessed findings.",
                    block.id
                ));
                all_factual_blocks_bound = false;
            } else if !supported_block(block) {
                gaps.push(format!(
                    "Block {} (kind {}) lacks a review confirming it is a genuine {} disclosure rather than an unreviewed assertion.",
                    block.id, block.kind, block.kind
                ));
                all_blocks_reviewed = false;
            }
            block_status.push(json!({
                "id":block.id,"kind":block.kind,"text":block.text,"claims":block.claims,
                "factual":factual,
                "review":block_reviews.get(&block.id).map(|review| review["state"].clone()).unwrap_or(Value::Null),
            }));
        }
        if !blocks.is_empty() && !carries_factual_block {
            gaps.push(
                "The structured answer contains no factual blocks restating the assessed findings; hypotheses and limitations alone cannot certify completion.".into(),
            );
        }
        if blocks.is_empty() && !d.claims.is_empty() {
            gaps.push(
                "The final answer is unstructured free text; certification requires claim-bound answer blocks reviewed against this exact candidate. Legacy free-text responses stay readable but are never certified.".into(),
            );
        }
        // Every supported dossier claim must be carried by at least one block;
        // a purely structural check, no wording similarity involved.
        for claim in &d.claims {
            if claim.assessment == "supported_within_scope"
                && !claim.id.is_empty()
                && !blocks.iter().any(|block| {
                    block_kind_is_factual(&block.kind)
                        && block.claims.iter().any(|id| id == &claim.id)
                })
            {
                gaps.push(format!(
                    "Assessed claim is not represented by any answer block: {}",
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
            && !blocks.is_empty()
            && all_factual_blocks_bound
            && all_blocks_reviewed
            && carries_factual_block
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
        gaps.sort();
        gaps.dedup();
        return Ok(
            json!({"outcome":outcome,"gaps":gaps,"blocks":block_status,"structured":!blocks.is_empty(),"draft_hash":digest(candidate.to_string().as_bytes()),"evidence_stamp":stamp,"review":"AI-generated / not human reviewed","created_at":now()}),
        );
    }
    gaps.push("No structured investigation contract was supplied; scope completion and claim support are unverified.".into());
    if citations.is_empty() {
        gaps.push("No source citations supplied; this response does not establish an evidentiary finding.".into());
        outcome = "unreviewed";
    }
    gaps.sort();
    gaps.dedup();
    Ok(
        json!({"outcome":outcome,"gaps":gaps,"blocks":[],"structured":false,"draft_hash":digest(candidate.to_string().as_bytes()),"evidence_stamp":stamp,"review":"AI-generated / not human reviewed","created_at":now()}),
    )
}
