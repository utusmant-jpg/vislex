//! Host-owned, resumable case analysis. Model output never supplies coverage counts.
use crate::{
    agent,
    case::{digest, id, now, Case},
    evidence,
};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const UNIT_INSTRUCTIONS:&str="This task is a host-owned analysis unit, not user chat. Use read_analysis_unit, reuse its included input, inspect every required page/frame/range, publish_analysis_unit with exact ref and receipt IDs, then finish_analysis_unit with per-finding source-based assessments. Do not create a dossier, coverage prompt or answer through finish_task. Material ambiguity and relevant source_processing fidelity limitations belong in the stored findings and structured data. Model support review remains distinct from human review.";
pub const ANALYSIS_VERSION: &str = "case-intelligence-v1";
/// Namespaced additive migration deliberately does not consume a shared PRAGMA
/// version while other owners are developing migrations in isolated branches.
pub fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch(r#"
    CREATE TABLE IF NOT EXISTS case_analysis_runs(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,model_manifest TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS case_analysis_units(id TEXT PRIMARY KEY,source_id TEXT REFERENCES sources(id),input_stamp TEXT NOT NULL,kind TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,task_id TEXT REFERENCES tasks(id),result TEXT NOT NULL DEFAULT '{}',reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS case_analysis_attempts(unit_id TEXT NOT NULL REFERENCES case_analysis_units(id),task_id TEXT PRIMARY KEY REFERENCES tasks(id));
    CREATE TABLE IF NOT EXISTS case_analysis_run_units(run_id TEXT NOT NULL REFERENCES case_analysis_runs(id),unit_id TEXT NOT NULL REFERENCES case_analysis_units(id),ordinal INTEGER NOT NULL,PRIMARY KEY(run_id,unit_id));
    CREATE INDEX IF NOT EXISTS case_analysis_dispatch ON case_analysis_run_units(run_id,ordinal);
    CREATE INDEX IF NOT EXISTS case_analysis_source ON case_analysis_units(source_id,input_stamp,state);
    CREATE TABLE IF NOT EXISTS case_evidence_refs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),locator TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS case_evidence_ref_ranges(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),locator TEXT NOT NULL,proof TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS case_knowledge_payloads(object_id TEXT NOT NULL,revision INTEGER NOT NULL,unit_id TEXT NOT NULL REFERENCES case_analysis_units(id),payload TEXT NOT NULL,PRIMARY KEY(object_id,revision),FOREIGN KEY(object_id,revision) REFERENCES evidence_versions(object_id,revision));
    CREATE INDEX IF NOT EXISTS case_knowledge_unit ON case_knowledge_payloads(unit_id);
    CREATE TABLE IF NOT EXISTS case_answer_candidates(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),stamp TEXT NOT NULL,candidate TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,stamp));
    "#)?;
    db.execute("INSERT OR IGNORE INTO case_analysis_attempts SELECT id,task_id FROM case_analysis_units WHERE task_id IS NOT NULL",[])?;
    db.execute("INSERT INTO meta(key,value) VALUES('case_intelligence_schema','1') ON CONFLICT(key) DO NOTHING", [])?;
    Ok(())
}

pub fn source_stamp(case: &Case, source: &str) -> Result<String> {
    Ok(digest(
        format!(
            "{}:{}",
            base_source_stamp(case, source)?,
            correction_stamp(case, source, None)?
        )
        .as_bytes(),
    ))
}
fn base_source_stamp(case: &Case, source: &str) -> Result<String> {
    let s = case.source(source)?;
    let revision: i64 = case.db.query_row(
        "SELECT coalesce((SELECT revision FROM extracts WHERE source_id=?),0)",
        [source],
        |r| r.get(0),
    )?;
    let mut pieces = vec![s.sha256, revision.to_string()];
    let mut q = case.db.prepare("SELECT id,kind,status,result FROM processing_jobs j WHERE source_id=? AND kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index') AND NOT EXISTS(SELECT 1 FROM processing_jobs n WHERE n.source_id=j.source_id AND n.kind=j.kind AND n.rowid>j.rowid) ORDER BY kind")?;
    for row in q.query_map([source], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, kind, state, result) = row?;
        pieces.push(format!("{id}:{kind}:{state}:{}", digest(result.as_bytes())));
    }
    Ok(digest(pieces.join("\n").as_bytes()))
}
fn correction_stamp(case: &Case, source: &str, range: Option<(&str, i64, i64)>) -> Result<String> {
    let mut pieces = Vec::new();
    let (run, start, count) = range
        .map(|(r, s, c)| (Some(r), s, c))
        .unwrap_or((None, 0, 0));
    let mut q = case.db.prepare("SELECT c.id,c.revision,c.review,c.proposed_text FROM transcript_corrections c WHERE EXISTS(SELECT 1 FROM transcript_segments s WHERE s.run_id=c.run_id AND s.ordinal=c.ordinal AND s.source_id=?1) AND (?2 IS NULL OR (c.run_id=?2 AND c.ordinal>=?3 AND c.ordinal<?3+?4)) ORDER BY c.id,c.revision")?;
    for row in q.query_map(params![source, run, start, count], |r| {
        Ok(format!(
            "{}:{}:{}:{}",
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            digest(r.get::<_, String>(3)?.as_bytes())
        ))
    })? {
        pieces.push(row?);
    }
    Ok(digest(pieces.join("\n").as_bytes()))
}
fn analysis_base_stamp(case: &Case, source: &str, model: &str) -> Result<String> {
    Ok(digest(
        format!(
            "{}:{model}:{ANALYSIS_VERSION}",
            base_source_stamp(case, source)?
        )
        .as_bytes(),
    ))
}
// Corrections affect their transcript page and synthesis, not unchanged image
// pixels or audio signals. The case manifest still notices every correction.
fn unit_stamp(case: &Case, source: &str, base: &str, kind: &str, spec: &Value) -> Result<String> {
    let corrections = match kind {
        "source_synthesis" | "synthesis_group" => Some(correction_stamp(case, source, None)?),
        "transcript" => match (
            spec["run_id"].as_str(),
            spec["offset"].as_i64(),
            spec["count"].as_i64(),
        ) {
            (Some(run), Some(offset), Some(count)) => {
                Some(correction_stamp(case, source, Some((run, offset, count)))?)
            }
            _ => Some(correction_stamp(case, source, None)?),
        },
        _ => None,
    };
    Ok(corrections.map_or_else(
        || base.to_owned(),
        |c| digest(format!("{base}:{c}").as_bytes()),
    ))
}

pub fn register_ref(case: &Case, locator: &str) -> Result<String> {
    let valid = case.validate_citation(locator)?;
    let source = valid["source_id"]
        .as_str()
        .context("Reference has no source")?;
    ensure!(
        !case.source(source)?.restricted,
        "Evidence reference is restricted"
    );
    // Legacy navigation locators must never become moving factual references.
    let (_, suffix) = locator.split_once('#').context("Missing locator")?;
    let locator = if suffix.starts_with('L') {
        format!(
            "evidence:{source}#R{}{}",
            valid["revision"]
                .as_i64()
                .context("Missing extraction revision")?,
            suffix
        )
    } else {
        locator.to_owned()
    };
    let reference = format!("ref:{}", digest(locator.as_bytes()));
    case.db.execute(
        "INSERT OR IGNORE INTO case_evidence_refs VALUES(?,?,?,?)",
        params![reference, source, locator, now()],
    )?;
    Ok(reference)
}
fn range_ref(case: &Case, source: &str, locator: &str, proof: &Value) -> Result<String> {
    register_ref(case, locator)?;
    let reference = format!(
        "ref:{}",
        digest(json!([locator, proof]).to_string().as_bytes())
    );
    case.db.execute(
        "INSERT OR IGNORE INTO case_evidence_ref_ranges VALUES(?,?,?,?,?)",
        params![reference, source, locator, proof.to_string(), now()],
    )?;
    Ok(reference)
}
pub fn resolve_ref(case: &Case, reference: &str, scope: &[String]) -> Result<Value> {
    let (source, locator, saved): (String,String,Option<String>) = case.db.query_row("SELECT source_id,locator,NULL FROM case_evidence_refs WHERE id=?1 UNION ALL SELECT source_id,locator,proof FROM case_evidence_ref_ranges WHERE id=?1 LIMIT 1",[reference],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.context("Unknown application-issued evidence reference")?;
    ensure!(
        scope.contains(&source) && !case.source(&source)?.restricted,
        "Evidence reference outside permitted scope"
    );
    let mut valid = case.validate_citation(&locator)?;
    valid["ref_id"] = json!(reference);
    valid["locator"] = json!(locator);
    valid["filename"] = json!(case.source(&source)?.name);
    valid["source_sha256"] = json!(case.source(&source)?.sha256);
    if let Some(raw) = saved {
        valid["proof"] = serde_json::from_str::<Value>(&raw)?;
    } else if let Some(suffix) = locator.split_once('#').map(|(_, s)| s) {
        if let Some(lines) = suffix.strip_prefix('R') {
            let (rev, range) = lines.split_once('L').context("Invalid pinned reference")?;
            let (start, end) = range.split_once("-L").context("Invalid pinned range")?;
            let start = start.parse::<usize>()?;
            let end = end.parse::<usize>()?;
            valid["proof"] =
                case.read_text_revision(&source, rev.parse()?, start, end - start + 1)?;
        } else if let Some(artifact) = suffix.strip_prefix("artifact:") {
            let (owner, mime, _, metadata) = crate::processing::artifact(case, artifact)?;
            ensure!(owner == source, "Artifact owner changed");
            valid["proof"] = json!({"artifact_id":artifact,"mime":mime,"metadata":metadata,"meaning":"Immutable derivative. Visual descriptions and machine text remain distinct from original/human interpretation."});
        }
    }
    Ok(valid)
}
/// Ref IDs in publication arguments resolve inside task scope in host code.
/// The model never needs to reconstruct long UUID or revision strings.
pub fn normalize_refs(case: &Case, value: &mut Value, scope: &[String]) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                normalize_refs(case, item, scope)?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if ["citations", "supporting", "contrary", "locators"].contains(&key.as_str()) {
                    if let Some(items) = child.as_array_mut() {
                        for item in items {
                            if let Some(reference) = item.as_str().filter(|s| s.starts_with("ref:"))
                            {
                                *item = resolve_ref(case, reference, scope)?["locator"].clone();
                            }
                        }
                    }
                } else {
                    normalize_refs(case, child, scope)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
/// Add canonical references to source-returned locators, never to generated prose.
pub fn attach_refs(case: &Case, value: &mut Value) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                attach_refs(case, item)?;
            }
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                attach_refs(case, child)?;
            }
            if let Some(locator) = object
                .get("locator")
                .and_then(Value::as_str)
                .filter(|s| s.starts_with("evidence:"))
            {
                if let Ok(reference) = register_ref(case, locator) {
                    object.entry("ref_id").or_insert(json!(reference));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn save_candidate(case: &Case, task: &str, stamp: &str, candidate: &Value) -> Result<String> {
    let candidate_id = format!("candidate:{}", digest(format!("{task}:{stamp}").as_bytes()));
    case.db.execute(
        "INSERT OR IGNORE INTO case_answer_candidates VALUES(?,?,?,?,?)",
        params![candidate_id, task, stamp, candidate.to_string(), now()],
    )?;
    Ok(candidate_id)
}
pub fn candidate(case: &Case, task: &str, candidate_id: &str) -> Result<Value> {
    let (owner, raw): (String, String) = case
        .db
        .query_row(
            "SELECT task_id,candidate FROM case_answer_candidates WHERE id=?",
            [candidate_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .context("Unknown answer candidate")?;
    ensure!(owner == task, "Answer candidate belongs to another task");
    Ok(serde_json::from_str(&raw)?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub kind: String,
    pub title: String,
    pub text: String,
    pub supporting: Vec<String>,
    pub contrary: Vec<String>,
    pub assessment: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub data_json: String,
}
fn add_unit(
    case: &Case,
    run: &str,
    source: Option<&str>,
    stamp: &str,
    kind: &str,
    spec: Value,
    ordinal: &mut i64,
    blocked: Option<&str>,
) -> Result<String> {
    let stamp = if let Some(source) = source {
        unit_stamp(case, source, stamp, kind, &spec)?
    } else {
        stamp.to_owned()
    };
    let unit = digest(json!([source, stamp, kind, spec]).to_string().as_bytes());
    case.db.execute("INSERT OR IGNORE INTO case_analysis_units(id,source_id,input_stamp,kind,spec,state,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",params![unit,source,stamp,kind,spec.to_string(),if blocked.is_some(){"blocked"}else{"queued"},blocked.unwrap_or(""),now(),now()])?;
    case.db.execute(
        "INSERT OR IGNORE INTO case_analysis_run_units VALUES(?,?,?)",
        params![run, unit, *ordinal],
    )?;
    *ordinal += 1;
    Ok(unit)
}
// Five inputs × at most 100 published findings keeps every dependency set
// below evidence::write's existing 1,000-reference boundary without dropping facts.
fn add_synthesis_groups(
    case: &Case,
    run: &str,
    source: Option<&str>,
    stamp: &str,
    mut inputs: Vec<String>,
    ordinal: &mut i64,
) -> Result<Vec<String>> {
    while inputs.len() > 5 {
        let mut next = Vec::new();
        for group in inputs.chunks(5) {
            next.push(add_unit(
                case,
                run,
                source,
                stamp,
                "synthesis_group",
                json!({"input_units":group}),
                ordinal,
                None,
            )?);
        }
        inputs = next;
    }
    Ok(inputs)
}
fn latest_result(case: &Case, source: &str, kind: &str) -> Result<Option<(String, String, Value)>> {
    let row: Option<(String,String,String)> = case.db.query_row("SELECT id,status,result FROM processing_jobs WHERE source_id=? AND kind=? ORDER BY rowid DESC LIMIT 1",params![source,kind],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(id, status, raw)| Ok((id, status, serde_json::from_str(&raw)?)))
        .transpose()
}
/// Build required ranges in application code; the model cannot omit a source.
pub fn ensure_run(case: &mut Case, model_manifest: &str) -> Result<Option<String>> {
    let pending: bool = case.db.query_row("SELECT EXISTS(SELECT 1 FROM processing_jobs j JOIN sources s ON s.id=j.source_id WHERE s.restricted=0 AND j.kind IN ('auto_prepare','full_audio','video_ocr_index','video_overview_index') AND j.status IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM processing_jobs n WHERE n.source_id=j.source_id AND n.kind=j.kind AND n.rowid>j.rowid))",[],|r|r.get(0))?;
    if pending {
        return Ok(None);
    }
    let sources = case
        .sources()?
        .into_iter()
        .filter(|s| !s.restricted)
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Ok(None);
    }
    let mut stamps = Vec::new();
    for source in &sources {
        stamps.push((source.id.clone(), source_stamp(case, &source.id)?));
    }
    stamps.sort();
    let manifest = digest(
        json!([
            ANALYSIS_VERSION,
            model_manifest,
            case.settings()?.allow_images,
            stamps
        ])
        .to_string()
        .as_bytes(),
    );
    if let Some(run) = case.meta("case_analysis_run")? {
        if case.db.query_row(
            "SELECT manifest FROM case_analysis_runs WHERE id=?",
            [&run],
            |r| r.get::<_, String>(0),
        )? == manifest
        {
            reconcile_stale_findings(case, &run)?;
            return Ok(Some(run));
        }
        let busy: bool = case.db.query_row("SELECT EXISTS(SELECT 1 FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.state='running')",[&run],|r|r.get(0))?;
        if busy {
            return Ok(Some(run));
        }
    }
    let run = id();
    case.db.execute_batch("SAVEPOINT analysis_manifest")?;
    let result = (|| -> Result<()> {
        case.db.execute(
            "INSERT INTO case_analysis_runs VALUES(?,?,?,'queued',?,?)",
            params![run, manifest, model_manifest, now(), now()],
        )?;
        let mut ordinal = 0;
        let mut source_roots = Vec::new();
        for source in &sources {
            let source_start = ordinal;
            let stamp = analysis_base_stamp(case, &source.id, model_manifest)?;
            let text: Option<(String, i64)> = case
                .db
                .query_row(
                    "SELECT text,revision FROM extracts WHERE source_id=?",
                    [&source.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let mut added = false;
            if let Some((_, state, _)) = latest_result(case, &source.id, "auto_prepare")? {
                if state != "complete" {
                    add_unit(case,&run,Some(&source.id),&stamp,"preparation_gap",json!({"state":state}),&mut ordinal,Some("Source preparation failed; structural inventory and extraction fidelity remain incomplete"))?;
                }
            }
            if let Some((text, revision)) =
                text.filter(|_| !["audio", "video"].contains(&source.kind.as_str()))
            {
                let lines = text.lines().collect::<Vec<_>>();
                let mut line = 0;
                while line < lines.len() {
                    let chars = lines[line].chars().count();
                    if chars > 2000 {
                        for offset in (0..chars).step_by(2000) {
                            add_unit(
                                case,
                                &run,
                                Some(&source.id),
                                &stamp,
                                "text_fragment",
                                json!({"revision":revision,"line":line+1,"char_offset":offset,"char_count":(chars-offset).min(2000)}),
                                &mut ordinal,
                                None,
                            )?;
                        }
                        line += 1;
                    } else {
                        let start = line;
                        while line < lines.len()
                            && line - start < 120
                            && lines[line].chars().count() <= 2000
                        {
                            line += 1;
                        }
                        add_unit(
                            case,
                            &run,
                            Some(&source.id),
                            &stamp,
                            "text",
                            json!({"revision":revision,"start":start+1,"end":line}),
                            &mut ordinal,
                            None,
                        )?;
                    }
                    added = true;
                }
            }
            if source.kind == "pdf" {
                let pages: Option<i64> = case.db.query_row("SELECT max(CAST(json_extract(metadata,'$.page_count') AS INTEGER)) FROM artifacts WHERE source_id=?",[&source.id],|r|r.get(0))?;
                if let Some(pages) = pages.filter(|p| *p > 0) {
                    for page in 1..=pages {
                        add_unit(
                            case,
                            &run,
                            Some(&source.id),
                            &stamp,
                            "page",
                            json!({"page":page}),
                            &mut ordinal,
                            None,
                        )?;
                        added = true;
                    }
                } else {
                    add_unit(
                        case,
                        &run,
                        Some(&source.id),
                        &stamp,
                        "document_pages",
                        json!({}),
                        &mut ordinal,
                        Some("Physical page count is unavailable after extraction"),
                    )?;
                    added = true;
                }
            }
            if source.kind == "image" {
                let frames = latest_result(case, &source.id, "auto_prepare")?
                    .and_then(|(_, _, r)| r["coverage"]["image_frames"].as_u64())
                    .unwrap_or(1);
                for frame in 0..frames {
                    add_unit(
                        case,
                        &run,
                        Some(&source.id),
                        &stamp,
                        "image_frame",
                        json!({"frame":frame}),
                        &mut ordinal,
                        None,
                    )?;
                }
                added = true;
            }
            if ["audio", "video"].contains(&source.kind.as_str()) {
                if let Some((transcript, status, result)) =
                    latest_result(case, &source.id, "full_audio")?
                {
                    if status == "complete" {
                        for track in result["metadata"]["tracks"]
                            .as_array()
                            .into_iter()
                            .flatten()
                        {
                            if track["decoded_to_eof"] != true
                                || track["gap_seconds"].as_f64().is_some_and(|g| g > 0.001)
                            {
                                add_unit(
                                    case,
                                    &run,
                                    Some(&source.id),
                                    &stamp,
                                    "audio_gap",
                                    json!({"track":track}),
                                    &mut ordinal,
                                    Some("Audio decoder reported missing track coverage"),
                                )?;
                            }
                            if let Some(end) = track["actual_end_seconds"]
                                .as_f64()
                                .filter(|t| t.is_finite() && *t > 0.)
                            {
                                let channels =
                                    track["channels"].as_u64().filter(|n| (1..=32).contains(n));
                                let Some(channels) = channels else {
                                    add_unit(case,&run,Some(&source.id),&stamp,"audio_channel_inventory",json!({"track":track["index"],"channels":track["channels"]}),&mut ordinal,Some("Audio channel inventory is missing or exceeds the supported channel range; full channel coverage is unverified"))?;
                                    continue;
                                };
                                for channel in 0..channels {
                                    let mut start = 0.;
                                    while start < end {
                                        add_unit(
                                            case,
                                            &run,
                                            Some(&source.id),
                                            &stamp,
                                            "audio_signal",
                                            json!({"start":start,"end":(start+60_f64).min(end),"track":track["index"],"channel":channel}),
                                            &mut ordinal,
                                            None,
                                        )?;
                                        start += 60.;
                                    }
                                }
                            }
                        }
                        let total: i64 = case.db.query_row(
                            "SELECT count(*) FROM transcript_segments WHERE run_id=?",
                            [&transcript],
                            |r| r.get(0),
                        )?;
                        if total > 0 {
                            for start in (0..total).step_by(25) {
                                add_unit(
                                    case,
                                    &run,
                                    Some(&source.id),
                                    &stamp,
                                    "transcript",
                                    json!({"run_id":transcript,"offset":start,"count":(total-start).min(25),"artifact_id":transcript}),
                                    &mut ordinal,
                                    None,
                                )?;
                                added = true;
                            }
                        } else {
                            add_unit(
                                case,
                                &run,
                                Some(&source.id),
                                &stamp,
                                "audio_inventory",
                                json!({"run_id":transcript,"result":result}),
                                &mut ordinal,
                                None,
                            )?;
                            added = true;
                        }
                    } else {
                        add_unit(
                            case,
                            &run,
                            Some(&source.id),
                            &stamp,
                            "transcript",
                            json!({"run_id":transcript}),
                            &mut ordinal,
                            Some("Full transcription did not complete"),
                        )?;
                        added = true;
                    }
                } else {
                    add_unit(
                        case,
                        &run,
                        Some(&source.id),
                        &stamp,
                        "transcript",
                        json!({}),
                        &mut ordinal,
                        Some("Full transcription is missing"),
                    )?;
                    added = true;
                }
            }
            if source.kind == "video" {
                if let Some((discovery, status, result)) =
                    latest_result(case, &source.id, "video_overview_index")?
                {
                    let end = result["last_chunk"]["last_decoded_seconds"].as_f64();
                    if status == "complete"
                        && result["last_chunk"]["eof"] == true
                        && end.is_some_and(|s| s.is_finite() && s >= 0.)
                    {
                        let duration = end.unwrap();
                        let mut start = 0.;
                        while start < duration {
                            add_unit(
                                case,
                                &run,
                                Some(&source.id),
                                &stamp,
                                "video",
                                json!({"start":start,"end":(start+5_f64).min(duration+0.001),"interval":0.5,"discovery_run":discovery}),
                                &mut ordinal,
                                None,
                            )?;
                            start += 4.;
                        }
                        let mut scenes=case.db.prepare("SELECT artifact_id,seconds FROM discovery_samples WHERE run_id=? AND kind='video_overview' AND json_extract(metadata,'$.scene_boundary')=1 ORDER BY seconds,artifact_id")?;
                        let scenes = scenes
                            .query_map([&discovery], |r| {
                                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
                            })?
                            .collect::<std::result::Result<Vec<_>, _>>()?;
                        for (artifact, seconds) in scenes {
                            add_unit(
                                case,
                                &run,
                                Some(&source.id),
                                &stamp,
                                "frame",
                                json!({"artifact_id":artifact,"seconds":seconds,"scene_boundary":true}),
                                &mut ordinal,
                                None,
                            )?;
                        }
                        if result["has_gaps"] == true {
                            add_unit(
                                case,
                                &run,
                                Some(&source.id),
                                &stamp,
                                "decode_gap",
                                json!({"discovery_run":discovery}),
                                &mut ordinal,
                                Some("Discovery recorded decode gaps"),
                            )?;
                        }
                    } else {
                        add_unit(
                            case,
                            &run,
                            Some(&source.id),
                            &stamp,
                            "video",
                            json!({"discovery_run":discovery}),
                            &mut ordinal,
                            Some("Complete recording extent is unavailable"),
                        )?;
                    }
                } else {
                    add_unit(
                        case,
                        &run,
                        Some(&source.id),
                        &stamp,
                        "video",
                        json!({}),
                        &mut ordinal,
                        Some("Video discovery is missing"),
                    )?;
                }
            }
            if let Some((_, _, prepared)) = latest_result(case, &source.id, "auto_prepare")? {
                if let Some(metadata) = prepared.get("metadata") {
                    for image in 0..metadata["image_parts"].as_u64().unwrap_or(0) {
                        add_unit(
                            case,
                            &run,
                            Some(&source.id),
                            &stamp,
                            "office_image",
                            json!({"image_index":image}),
                            &mut ordinal,
                            None,
                        )?;
                    }
                    if metadata["chart_parts"].as_u64().unwrap_or(0) > 0 {
                        add_unit(
                            case,
                            &run,
                            Some(&source.id),
                            &stamp,
                            "charts",
                            json!({"count":metadata["chart_parts"]}),
                            &mut ordinal,
                            Some("Office chart layout and data need chart-specific extraction"),
                        )?;
                    }
                    if metadata["embedded_objects"].as_u64().unwrap_or(0) > 0 {
                        add_unit(case,&run,Some(&source.id),&stamp,"embedded_objects",json!({"count":metadata["embedded_objects"]}),&mut ordinal,Some("Embedded document objects remain inside the original and are not extracted"))?;
                    }
                    if let Some(streams) = metadata["streams"].as_array() {
                        if streams.iter().filter(|s| s["type"] == "video").count() > 1 {
                            add_unit(case,&run,Some(&source.id),&stamp,"additional_video_tracks",json!({"streams":streams}),&mut ordinal,Some("Additional video tracks require a track-specific discovery and inspection path"))?;
                        }
                    }
                }
                let extension = std::path::Path::new(&source.name)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ["pptx", "odt"].contains(&extension.as_str()) {
                    add_unit(case,&run,Some(&source.id),&stamp,"document_structure",json!({"limitations":prepared["limitations"]}),&mut ordinal,Some("Document layout, images, charts and embedded objects are not rendered by this extractor"))?;
                }
            }
            if !added {
                add_unit(
                    case,
                    &run,
                    Some(&source.id),
                    &stamp,
                    "unsupported",
                    json!({"kind":source.kind}),
                    &mut ordinal,
                    Some("No analyzable extraction is available for this source"),
                )?;
            }
            let mut q=case.db.prepare("SELECT unit_id FROM case_analysis_run_units WHERE run_id=? AND ordinal>=? AND ordinal<? ORDER BY ordinal")?;
            let inputs = q
                .query_map(params![run, source_start, ordinal], |r| {
                    r.get::<_, String>(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(q);
            let inputs =
                add_synthesis_groups(case, &run, Some(&source.id), &stamp, inputs, &mut ordinal)?;
            source_roots.push(add_unit(
                case,
                &run,
                Some(&source.id),
                &stamp,
                "source_synthesis",
                json!({"source":source.id,"input_units":inputs}),
                &mut ordinal,
                None,
            )?);
        }
        let roots = add_synthesis_groups(case, &run, None, &manifest, source_roots, &mut ordinal)?;
        add_unit(
            case,
            &run,
            None,
            &manifest,
            "synthesis",
            json!({"sources":sources.iter().map(|s|&s.id).collect::<Vec<_>>(),"input_units":roots}),
            &mut ordinal,
            None,
        )?;
        case.set_meta("case_analysis_run", &run)?;
        case.audit(
            "case_analysis_manifest_created",
            json!({"run_id":run,"manifest":manifest,"units":ordinal,"version":ANALYSIS_VERSION}),
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => case.db.execute_batch("RELEASE analysis_manifest")?,
        Err(e) => {
            case.db
                .execute_batch("ROLLBACK TO analysis_manifest; RELEASE analysis_manifest")?;
            return Err(e);
        }
    }
    Ok(Some(run))
}

fn stale_finding_units(case: &Case, run: &str) -> Result<Vec<String>> {
    let mut q=case.db.prepare("SELECT DISTINCT u.id FROM case_analysis_units u JOIN case_analysis_run_units ru ON ru.unit_id=u.id JOIN json_each(json_extract(u.result,'$.objects')) obj LEFT JOIN evidence_objects o ON o.id=json_extract(obj.value,'$.id') LEFT JOIN evidence_versions v ON v.object_id=o.id AND v.revision=o.current_revision WHERE ru.run_id=? AND u.state='complete' AND (o.id IS NULL OR v.stale=1 OR o.current_revision<>json_extract(obj.value,'$.revision'))")?;
    let units = q
        .query_map([run], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(units)
}
fn reconcile_stale_findings(case: &Case, run: &str) -> Result<()> {
    let stale = stale_finding_units(case, run)?;
    for unit in &stale {
        case.db.execute("UPDATE case_analysis_units SET state='queued',task_id=NULL,result='{}',reason='',updated_at=? WHERE id=?",params![now(),unit])?;
    }
    if !stale.is_empty() {
        case.db.execute(
            "UPDATE case_analysis_runs SET state='queued',updated_at=? WHERE id=?",
            params![now(), run],
        )?;
    }
    Ok(())
}

pub fn task_unit(case: &Case, task: &str) -> Result<Option<Value>> {
    let row: Option<(String, Option<String>, String, String, String)> = case
        .db
        .query_row(
            "SELECT id,source_id,kind,spec,state FROM case_analysis_units WHERE task_id=?",
            [task],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    row.map(|(id,source,kind,spec,state)|Ok(json!({"id":id,"source_id":source,"kind":kind,"spec":serde_json::from_str::<Value>(&spec)?,"state":state}))).transpose()
}

pub fn next_task(
    case: &mut Case,
    subscription: bool,
    model_manifest: &str,
) -> Result<Option<String>> {
    let settings = case.settings()?;
    if settings.offline
        || !settings.allow_text
        || case.meta("case_analysis_paused")?.as_deref() == Some("true")
    {
        return Ok(None);
    }
    let foreground:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.status='running' AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='internal_analysis:'||t.id AND m.value='true'))",[],|r|r.get(0))?;
    if foreground {
        return Ok(None);
    }
    let Some(run) = ensure_run(case, model_manifest)? else {
        return Ok(None);
    };
    // Reconcile finished bounded units. A provider's final message never counts.
    let mut q=case.db.prepare("SELECT u.id,u.task_id,t.status,t.error FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id JOIN tasks t ON t.id=u.task_id WHERE r.run_id=? AND u.state='running'")?;
    let active = q
        .query_map([&run], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(q);
    for (unit, task, state, error) in active {
        if state == "running" {
            return Ok(None);
        }
        if state == "paused"
            && (error == crate::automatic::CHAT_PREEMPTION
                || error.starts_with("Application stopped"))
        {
            let old_model: String = case.db.query_row(
                "SELECT model_manifest FROM case_analysis_runs WHERE id=?",
                [&run],
                |r| r.get(0),
            )?;
            if old_model == model_manifest
                && task_unit(case, &task)?.is_some_and(|u| validate_unit_input(case, &u).is_ok())
                && agent::resume(case, &task).is_ok()
            {
                return Ok(Some(task));
            }
        }
        let result: Value = serde_json::from_str(&case.db.query_row::<String, _, _>(
            "SELECT result FROM case_analysis_units WHERE id=?",
            [&unit],
            |r| r.get(0),
        )?)?;
        if state == "complete" && result["published"] == true && result["reviewed"] == true {
            case.db.execute(
                "UPDATE case_analysis_units SET state='complete',updated_at=? WHERE id=?",
                params![now(), unit],
            )?;
        } else {
            case.db.execute(
                "UPDATE case_analysis_units SET state='blocked',reason=?,updated_at=? WHERE id=?",
                params![
                    if error.is_empty() {
                        "Model ended without publishing the required analysis unit"
                    } else {
                        &error
                    },
                    now(),
                    unit
                ],
            )?;
        }
    }
    let Some(run) = ensure_run(case, model_manifest)? else {
        return Ok(None);
    };
    let busy: bool = case.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE status='running')",
        [],
        |r| r.get(0),
    )?;
    if busy {
        return Ok(None);
    }
    if !settings.allow_images {
        case.db.execute("UPDATE case_analysis_units SET state='blocked',reason='image_permission_denied: visual analysis requires the existing case image grant',updated_at=? WHERE id IN (SELECT unit_id FROM case_analysis_run_units WHERE run_id=?) AND state='queued' AND kind IN ('page','image','video','frame','image_frame','office_image')",params![now(),run])?;
    } else {
        case.db.execute("UPDATE case_analysis_units SET state='queued',reason='',updated_at=? WHERE id IN (SELECT unit_id FROM case_analysis_run_units WHERE run_id=?) AND state='blocked' AND reason LIKE 'image_permission_denied:%'",params![now(),run])?;
    }
    let row:Option<(String,Option<String>,String,String)> = case.db.query_row("SELECT u.id,u.source_id,u.kind,u.spec FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.state='queued' ORDER BY r.ordinal LIMIT 1",[&run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((unit, source, kind, spec)) = row else {
        let blocked:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.state='blocked')",[&run],|r|r.get(0))?;
        case.db.execute(
            "UPDATE case_analysis_runs SET state=?,updated_at=? WHERE id=?",
            params![if blocked { "blocked" } else { "ready" }, now(), run],
        )?;
        return Ok(None);
    };
    let (all_sources, records) = agent::case_scope(case)?;
    let sources = source.map(|s| vec![s]).unwrap_or(all_sources);
    let records = records
        .into_iter()
        .filter(|r| {
            case.record(r)
                .is_ok_and(|r| r.dependencies.iter().all(|s| sources.contains(s)))
        })
        .collect();
    let prompt=format!("Internal case analysis unit {unit}. Kind: {kind}. Required input: {spec}. Call read_analysis_unit first. Inspect the required source units using the returned tools and exact locators. Save all material observations, attributed statements, entities, events, contradictions and issues with publish_analysis_unit using application-issued ref IDs. Do not invent identity, timing, speech or law. For visual evidence call the inspection tool, record_visual_observations, then publish. For video inspect the entire specified window at the specified density and refine ambiguous actions with denser surrounding frames. For synthesis_group reconcile every assigned child unit; retain material facts and contradictions with original proof, and retrieve details when a summary is insufficient. For source_synthesis reconcile all reviewed findings for this source into durable chronology, accounts, entities and contradictions. For synthesis query_case_knowledge returns the assigned reviewed source summaries or synthesis groups with their exact proof; paginate them to reconcile every source and use targeted source research only for remaining contradictions; include factual chronology, conflicting accounts, relationships and legal issue spotting with known jurisdiction/date and authority, preserving contrary evidence. No user chat or instructions to the user are needed. Use input already included by read_analysis_unit without repeating the same read. Finish through finish_analysis_unit after publication, assessing the exact returned findings against the proof and contrary evidence. Never call finish_task or generate a user conversation. A zero-finding unit is allowed when explicitly inspected; it is not proof of absence.");
    let task = if subscription {
        agent::start_subscription(case, &prompt, "investigate", sources, records)?
    } else {
        agent::start(case, &prompt, "investigate", sources, records, 0.)?
    };
    case.db.execute(
        "INSERT INTO case_analysis_attempts VALUES(?,?)",
        params![unit, task],
    )?;
    case.set_meta(&format!("internal_analysis:{task}"), "true")?;
    case.set_meta(&format!("automatic_task:{task}"), "true")?;
    case.set_meta("auto_review_task", &task)?;
    case.db.execute("UPDATE case_analysis_units SET state='running',task_id=?,updated_at=? WHERE id=? AND state='queued'",params![task,now(),unit])?;
    case.db.execute(
        "UPDATE case_analysis_runs SET state='running',updated_at=? WHERE id=?",
        params![now(), run],
    )?;
    Ok(Some(task))
}

pub fn read_unit(case: &Case, task: &str) -> Result<Value> {
    let mut unit = task_unit(case, task)?.context("Task has no analysis unit")?;
    let source = unit["source_id"].as_str().map(str::to_owned);
    let spec = &unit["spec"];
    let required = match unit["kind"].as_str().unwrap_or("") {
        "text" => {
            json!({"tool":"read_extract_revision","arguments":{"source_id":source,"revision":spec["revision"],"start":spec["start"],"count":spec["end"].as_u64().unwrap_or(0)-spec["start"].as_u64().unwrap_or(0)+1}})
        }
        "page" => {
            json!({"tool":"inspect_document_pages","arguments":{"source_id":source,"pages":[spec["page"]]}})
        }
        "office_image" => {
            json!({"tool":"inspect_office_image","arguments":{"source_id":source,"image_index":spec["image_index"]}})
        }
        "image_frame" => {
            json!({"tool":"inspect_image_frame","arguments":{"source_id":source,"frame":spec["frame"]}})
        }
        "audio_signal" => {
            json!({"tool":"scan_sound_events","arguments":{"source_id":source,"start":spec["start"],"end":spec["end"],"track":spec["track"],"channel":spec["channel"]}})
        }
        "image" => json!({"tool":"inspect_image","arguments":{"source_id":source,"crop":null}}),
        "frame" => {
            json!({"tool":"inspect_artifact_image","arguments":{"source_id":source,"artifact_id":spec["artifact_id"]}})
        }
        "video" => {
            json!({"tool":"inspect_video_interval","arguments":{"source_id":source,"start":spec["start"],"end":spec["end"],"interval":spec["interval"]}})
        }
        "transcript" => {
            json!({"tool":"read_artifact","arguments":{"source_id":source,"artifact_id":spec["artifact_id"],"offset":spec["offset"],"count":spec["count"]}})
        }
        "audio_inventory" => {
            json!({"tool":"read_artifact","arguments":{"source_id":source,"artifact_id":spec["run_id"],"offset":0,"count":25}})
        }
        _ => json!({"tool":"query_case_knowledge","arguments":{"query":"","offset":0}}),
    };
    unit["required_inspection"] = required;
    let scope: Vec<String> = serde_json::from_str(&case.db.query_row::<String, _, _>(
        "SELECT scope FROM tasks WHERE id=?",
        [task],
        |r| r.get(0),
    )?)?;
    unit["analysis_status"] = json!(scoped_status(case, &scope)?);
    let result: Value = serde_json::from_str(&case.db.query_row::<String, _, _>(
        "SELECT result FROM case_analysis_units WHERE id=?",
        [unit["id"].as_str()],
        |r| r.get(0),
    )?)?;
    if result["published"] == true {
        unit["published_findings"] = result["objects"].clone();
        unit["instruction"]=json!("This unit already published findings. Do not publish duplicates. Review these exact findings and finish_analysis_unit.");
    }
    if let Some(source) = source {
        unit["source_name"] = json!(case.source(&source)?.name);
        if let Some((_, state, result)) = latest_result(case, &source, "auto_prepare")? {
            let mut fidelity = json!({"state":state,"coverage":result["coverage"],"limitations":result["limitations"]});
            if let Some(locator) = result["extraction_locator"].as_str() {
                if let Ok(reference) = register_ref(case, locator) {
                    fidelity["extraction_ref_id"] = json!(reference);
                }
            }
            unit["source_processing"] = fidelity;
        }
        match unit["kind"].as_str().unwrap_or("") {
            "text" => {
                let page = case.read_text_revision(
                    &source,
                    unit["spec"]["revision"]
                        .as_i64()
                        .context("Missing revision")?,
                    unit["spec"]["start"].as_u64().unwrap_or(1) as usize,
                    (unit["spec"]["end"].as_u64().unwrap_or(0)
                        - unit["spec"]["start"].as_u64().unwrap_or(1)
                        + 1) as usize,
                )?;
                unit["input"] = page;
            }
            "text_fragment" => {
                let revision = unit["spec"]["revision"]
                    .as_i64()
                    .context("Missing revision")?;
                let line = unit["spec"]["line"].as_u64().context("Missing line")? as usize;
                let offset = unit["spec"]["char_offset"]
                    .as_u64()
                    .context("Missing fragment offset")? as usize;
                let count = unit["spec"]["char_count"]
                    .as_u64()
                    .context("Missing fragment count")? as usize;
                let text: String = case.db.query_row(
                    "SELECT text FROM extract_revisions WHERE source_id=? AND revision=?",
                    params![source, revision],
                    |r| r.get(0),
                )?;
                let text = text
                    .lines()
                    .nth(line - 1)
                    .context("Fragment line missing")?
                    .chars()
                    .skip(offset)
                    .take(count)
                    .collect::<String>();
                ensure!(text.chars().count() == count, "Fragment range changed");
                let locator = format!("evidence:{source}#R{revision}L{line}-L{line}");
                let proof = json!({"text":text,"revision":revision,"line":line,"char_offset":offset,"char_count":count,"meaning":"Exact character range in immutable extraction line; offsets count Unicode characters."});
                unit["input"] = proof.clone();
                unit["input"]["locator"] = json!(locator);
                unit["input"]["ref_id"] = json!(range_ref(case, &source, &locator, &proof)?);
                unit["required_inspection"] =
                    json!({"tool":"read_analysis_unit","arguments":{},"included":true});
            }
            "transcript" => {
                unit["input"] = crate::transcription::segment_page(
                    case,
                    &source,
                    unit["spec"]["run_id"]
                        .as_str()
                        .context("Missing transcript run")?,
                    unit["spec"]["offset"].as_i64(),
                )?;
                let locator = format!(
                    "evidence:{source}#artifact:{}",
                    unit["spec"]["artifact_id"]
                        .as_str()
                        .context("Missing transcript artifact")?
                );
                unit["input"]["locator"] = json!(locator);
                if let Some(segments) = unit["input"]["segments"].as_array_mut() {
                    for segment in segments {
                        segment["ref_id"] = json!(range_ref(case, &source, &locator, segment)?);
                        segment["locator"] = json!(locator);
                    }
                }
            }
            _ => {}
        }
        attach_refs(case, &mut unit)?;
    }
    Ok(unit)
}

fn video_grid_covered(output: &Value, spec: &Value) -> bool {
    let (Some(start), Some(end), Some(interval)) = (
        spec["start"].as_f64(),
        spec["end"].as_f64(),
        spec["interval"].as_f64(),
    ) else {
        return false;
    };
    let Some(frames) = output["frames"].as_array() else {
        return false;
    };
    let mut used = std::collections::HashSet::new();
    let mut target = start;
    while target < end - 0.00001 {
        let matched = frames.iter().enumerate().find(|(index, frame)| {
            !used.contains(index)
                && frame["metadata"]["source_relative_seconds"]
                    .as_f64()
                    .is_some_and(|pts| pts >= target - 0.02 && pts < target + interval + 0.02)
        });
        if let Some((index, _)) = matched {
            used.insert(index);
        } else {
            return false;
        }
        target += interval;
    }
    true
}

fn validate_unit_input(case: &Case, unit: &Value) -> Result<()> {
    let settings = case.settings()?;
    ensure!(
        !settings.offline && settings.allow_text,
        "Case analysis permission disabled"
    );
    let (stamp,model):(String,String)=case.db.query_row("SELECT u.input_stamp,r.model_manifest FROM case_analysis_units u JOIN case_analysis_run_units ru ON ru.unit_id=u.id JOIN case_analysis_runs r ON r.id=ru.run_id WHERE u.id=? AND r.id=(SELECT value FROM meta WHERE key='case_analysis_run')",[unit["id"].as_str()],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if let Some(source) = unit["source_id"].as_str() {
        ensure!(
            !case.source(source)?.restricted,
            "Analysis source was restricted"
        );
        ensure!(
            stamp
                == unit_stamp(
                    case,
                    source,
                    &analysis_base_stamp(case, source, &model)?,
                    unit["kind"].as_str().context("Missing unit kind")?,
                    &unit["spec"]
                )?,
            "Analysis input changed before publication or completion"
        );
    } else {
        ensure!(
            manifest_current(case, &model)?,
            "Case inventory changed before synthesis completion"
        );
    }
    if [
        "video",
        "page",
        "image",
        "frame",
        "image_frame",
        "office_image",
    ]
    .iter()
    .any(|kind| unit["kind"] == *kind)
    {
        ensure!(
            settings.allow_images,
            "Image permission revoked before visual completion"
        );
    }
    Ok(())
}

pub fn publish_unit(case: &mut Case, task: &str, args: &Value) -> Result<Value> {
    case.db.execute_batch("SAVEPOINT analysis_publish")?;
    let result = publish_unit_inner(case, task, args);
    if result.is_err() {
        case.db.execute_batch("ROLLBACK TO analysis_publish")?;
    }
    case.db.execute_batch("RELEASE analysis_publish")?;
    result
}
fn publish_unit_inner(case: &mut Case, task: &str, args: &Value) -> Result<Value> {
    let unit = task_unit(case, task)?.context("Task has no analysis unit")?;
    ensure!(
        unit["state"] == "running",
        "Analysis unit is no longer running"
    );
    let sources: Vec<String> = serde_json::from_str(&case.db.query_row::<String, _, _>(
        "SELECT scope FROM tasks WHERE id=?",
        [task],
        |r| r.get(0),
    )?)?;
    for source in &sources {
        ensure!(
            !case.source(source)?.restricted,
            "Analysis source was restricted"
        );
    }
    let kind = unit["kind"].as_str().context("Missing unit kind")?;
    let previous: Value = serde_json::from_str(&case.db.query_row::<String, _, _>(
        "SELECT result FROM case_analysis_units WHERE id=?",
        [unit["id"].as_str()],
        |r| r.get(0),
    )?)?;
    if previous["published"] == true {
        if previous["input_hash"] == digest(args.to_string().as_bytes()) {
            return Ok(
                json!({"status":"analysis_published","objects":previous["objects"],"unit_id":unit["id"]}),
            );
        }
        ensure!(
            previous["reviewed"] != true,
            "Completed findings cannot be silently replaced"
        );
    }
    validate_unit_input(case, &unit)?;
    let receipts: Vec<String> = serde_json::from_value(args["receipts"].clone())?;
    ensure!(
        !receipts.is_empty() && receipts.len() <= 1000,
        "Analysis publication needs actual inspection receipts"
    );
    let mut inspected = false;
    let mut observed = false;
    let mut knowledge_pages = std::collections::BTreeMap::new();
    let mut knowledge_dependencies = std::collections::BTreeMap::new();
    let mut supplied_images = std::collections::HashSet::new();
    let mut observed_images = std::collections::HashSet::new();
    for receipt in &receipts {
        let row: Option<(String, String, String, String)> = case
            .db
            .query_row(
                "SELECT name,input,output,status FROM actions WHERE id=? AND task_id=?",
                params![receipt, task],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (name, raw_input, raw_output, status) =
            row.context("Inspection receipt is not from this unit task")?;
        ensure!(
            status == "complete",
            "Failed inspection cannot complete an analysis unit"
        );
        let input: Value = serde_json::from_str(&raw_input)?;
        let output: Value = serde_json::from_str(&raw_output)?;
        let spec = &unit["spec"];
        if name == "read_analysis_unit" && output["id"] == unit["id"] {
            inspected |= match kind {
                "text" => {
                    output["input"]["start"] == spec["start"]
                        && output["input"]["end"] == spec["end"]
                        && output["input"]["truncated_long_lines"] != true
                }
                "text_fragment" => {
                    output["input"]["revision"] == spec["revision"]
                        && output["input"]["line"] == spec["line"]
                        && output["input"]["char_offset"] == spec["char_offset"]
                        && output["input"]["char_count"] == spec["char_count"]
                }
                "transcript" => {
                    output["input"]["run_id"] == spec["run_id"]
                        && output["input"]["segments"]
                            .as_array()
                            .is_some_and(|segments| {
                                segments.len()
                                    == spec["count"].as_u64().unwrap_or(u64::MAX) as usize
                                    && segments
                                        .first()
                                        .is_some_and(|v| v["ordinal"] == spec["offset"])
                            })
                }
                _ => false,
            };
        }
        if input["source_id"] == unit["source_id"] {
            inspected |= match kind {
                "text" => {
                    name == "read_extract_revision"
                        && input["revision"] == spec["revision"]
                        && output["start"] == spec["start"]
                        && output["end"]
                            .as_u64()
                            .is_some_and(|e| e >= spec["end"].as_u64().unwrap_or(u64::MAX))
                        && output["truncated_long_lines"] != true
                }
                "transcript" => {
                    name == "read_artifact"
                        && input["artifact_id"] == spec["artifact_id"]
                        && input["offset"] == spec["offset"]
                        && output["units"].as_array().is_some_and(|v| {
                            v.len() >= spec["count"].as_u64().unwrap_or(u64::MAX) as usize
                        })
                }
                "audio_inventory" => {
                    name == "read_artifact" && input["artifact_id"] == spec["run_id"]
                }
                "page" => {
                    ["inspect_document_pages", "inspect_document_page"].contains(&name.as_str())
                        && (input["page"] == spec["page"]
                            || input["pages"]
                                .as_array()
                                .is_some_and(|p| p.contains(&spec["page"])))
                }
                "office_image" => {
                    name == "inspect_office_image" && input["image_index"] == spec["image_index"]
                }
                "image_frame" => name == "inspect_image_frame" && input["frame"] == spec["frame"],
                "audio_signal" => {
                    name == "scan_sound_events"
                        && input["track"] == spec["track"]
                        && input["channel"] == spec["channel"]
                        && input["start"] == spec["start"]
                        && input["end"] == spec["end"]
                        && output["metadata"]["gap_seconds"]
                            .as_f64()
                            .is_some_and(|gap| gap <= 0.002)
                }
                "image" => name == "inspect_image",
                "frame" => {
                    name == "inspect_artifact_image" && input["artifact_id"] == spec["artifact_id"]
                }
                "video" => {
                    name == "inspect_video_interval"
                        && input["start"]
                            .as_f64()
                            .is_some_and(|s| s <= spec["start"].as_f64().unwrap_or(-1.))
                        && input["end"]
                            .as_f64()
                            .is_some_and(|e| e >= spec["end"].as_f64().unwrap_or(f64::MAX))
                        && input["interval"].as_f64().is_some_and(|i| i <= 0.5)
                        && output["next_start"].is_null()
                        && video_grid_covered(&output, spec)
                }
                _ => false,
            };
        }
        if [
            "inspect_video_interval",
            "inspect_document_pages",
            "inspect_document_page",
        ]
        .contains(&name.as_str())
        {
            for frame in output["frames"].as_array().into_iter().flatten() {
                if let Some(artifact) = frame["artifact_id"].as_str() {
                    supplied_images.insert(artifact.to_string());
                }
            }
        }
        if [
            "inspect_image",
            "inspect_image_frame",
            "inspect_office_image",
            "inspect_artifact_image",
        ]
        .contains(&name.as_str())
        {
            supplied_images.insert(
                output["artifact_id"]
                    .as_str()
                    .unwrap_or("original")
                    .to_string(),
            );
        }
        if name == "record_visual_observations" {
            for observation in output["observations"].as_array().into_iter().flatten() {
                if observation["source_id"] == unit["source_id"] {
                    observed = true;
                    observed_images.insert(
                        observation["artifact_id"]
                            .as_str()
                            .unwrap_or("original")
                            .to_string(),
                    );
                }
            }
        }
        if ["synthesis", "source_synthesis", "synthesis_group"].contains(&kind)
            && name == "query_case_knowledge"
            && input["query"] == ""
        {
            knowledge_pages.insert(
                input["offset"].as_u64().unwrap_or(0),
                output["next_offset"].as_u64(),
            );
            for item in output["items"].as_array().into_iter().flatten() {
                if let (Some(id), Some(revision)) = (item["id"].as_str(), item["revision"].as_i64())
                {
                    knowledge_dependencies.insert(id.to_owned(), revision);
                }
            }
        }
    }
    if ["synthesis", "source_synthesis", "synthesis_group"].contains(&kind) {
        let mut offset = 0;
        while let Some(next) = knowledge_pages.get(&offset) {
            match next {
                None => {
                    inspected = true;
                    break;
                }
                Some(next) if *next > offset => offset = *next,
                _ => break,
            }
        }
    }
    ensure!(
        inspected,
        "Required input range has no matching completed inspection receipt"
    );
    ensure!(
        ![
            "video",
            "page",
            "image",
            "image_frame",
            "office_image",
            "frame"
        ]
        .contains(&kind)
            || (observed
                && !supplied_images.is_empty()
                && supplied_images.is_subset(&observed_images)),
        "Visual analysis needs recorded observations of every supplied image"
    );
    let findings: Vec<Finding> = serde_json::from_value(args["findings"].clone())?;
    ensure!(
        findings.len() <= 100 && args.to_string().len() <= 100_000,
        "Analysis result is too large"
    );
    let mut published = Vec::new();
    for (index, mut finding) in findings.into_iter().enumerate() {
        if !finding.data_json.is_empty() {
            finding.data = serde_json::from_str(&finding.data_json)?;
            finding.data_json.clear();
        }
        ensure!(
            finding.data.is_object(),
            "Finding data must be a structured JSON object"
        );
        ensure!(
            [
                "observed",
                "attributed",
                "inferred",
                "disputed",
                "unresolved",
                "attributed_statement",
                "attributed"
            ]
            .contains(&finding.assessment.as_str()),
            "Unknown epistemic assessment"
        );
        if finding.kind == "issue" {
            ensure!(finding.data["jurisdiction"].is_string() && finding.data["relevant_date"].is_string(),"Legal issues need jurisdiction and relevant_date fields, preserving unknown values");
            ensure!(finding.data["authority_ids"].is_array() && finding.data["issue_type"]=="issue_spotting","Automatic legal issues are issue spotting; authority-backed legal work uses the existing authority/work-product review path");
        }
        ensure!(
            [
                "observation",
                "statement",
                "event",
                "entity",
                "claim",
                "issue",
                "hypothesis",
                "clock",
                "note"
            ]
            .contains(&finding.kind.as_str()),
            "Unknown knowledge kind"
        );
        ensure!(
            !finding.text.trim().is_empty() && !finding.supporting.is_empty(),
            "Knowledge needs text and supporting evidence refs"
        );
        let mut locators = Vec::new();
        for reference in finding.supporting.iter().chain(&finding.contrary) {
            locators.push(
                resolve_ref(case, reference, &sources)?["locator"]
                    .as_str()
                    .context("Reference locator missing")?
                    .to_owned(),
            );
        }
        locators.sort();
        locators.dedup();
        let previous_object = &previous["objects"][index];
        let reuse = previous_object["kind"] == finding.kind;
        let input = evidence::ObjectInput {
            id: if reuse {
                previous_object["id"].as_str().map(str::to_owned)
            } else {
                None
            },
            base_revision: if reuse {
                previous_object["revision"].as_i64().unwrap_or(0)
            } else {
                0
            },
            kind: finding.kind.clone(),
            title: finding.title.clone(),
            content: finding.text.clone(),
            source_ids: sources.clone(),
            locators,
            dependencies: knowledge_dependencies
                .iter()
                .map(|(id, revision)| evidence::Dependency {
                    id: id.clone(),
                    revision: *revision,
                })
                .collect(),
            start_seconds: unit["spec"]["start"].as_f64(),
            end_seconds: unit["spec"]["end"].as_f64(),
        };
        let object = evidence::write(case, input, "agent")?;
        case.db.execute(
            "INSERT INTO case_knowledge_payloads VALUES(?,?,?,?)",
            params![
                object["id"].as_str(),
                object["revision"].as_i64(),
                unit["id"].as_str(),
                serde_json::to_string(&finding)?
            ],
        )?;
        published.push(object);
    }
    case.db.execute("UPDATE case_analysis_units SET result=?,updated_at=? WHERE id=?",params![json!({"published":true,"objects":published,"receipts":receipts,"input_hash":digest(args.to_string().as_bytes())}).to_string(),now(),unit["id"].as_str()])?;
    Ok(json!({"status":"analysis_published","objects":published,"unit_id":unit["id"]}))
}

pub fn query_knowledge(case: &Case, scope: &[String], query: &str, offset: u64) -> Result<Value> {
    query_knowledge_level(case, scope, query, offset, None)
}
pub fn query_unit_knowledge(
    case: &Case,
    task: &str,
    scope: &[String],
    query: &str,
    offset: u64,
) -> Result<Value> {
    let unit = task_unit(case, task)?;
    let inputs = unit
        .filter(|u| {
            ["synthesis", "source_synthesis", "synthesis_group"]
                .iter()
                .any(|k| u["kind"] == *k)
        })
        .map(|u| serde_json::from_value::<Vec<String>>(u["spec"]["input_units"].clone()))
        .transpose()?;
    query_knowledge_level(case, scope, query, offset, inputs.as_deref())
}
fn query_knowledge_level(
    case: &Case,
    scope: &[String],
    query: &str,
    offset: u64,
    inputs: Option<&[String]>,
) -> Result<Value> {
    ensure!(
        query.len() <= 500 && offset <= 1_000_000,
        "Invalid knowledge query"
    );
    let search = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() > 1)
        .take(24)
        .map(|s| format!("\"{s}\"*"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let (join, filter, order) = if search.is_empty() {
        ("", "", "v.object_id")
    } else {
        (
            "JOIN passage_fts ON passage_fts.kind='object' AND passage_fts.object_id=v.object_id",
            "AND passage_fts MATCH ?1",
            "bm25(passage_fts),v.object_id",
        )
    };
    let level = "AND (?3 IS NULL OR u.id IN (SELECT value FROM json_each(?3)))";
    let sql=format!("SELECT v.object_id,v.revision,v.kind,v.title,v.content,v.source_ids,v.locators,v.review,k.payload,u.source_id,u.input_stamp,r.model_manifest,u.result,u.kind,u.spec FROM (SELECT v.*,o.kind FROM evidence_versions v JOIN evidence_objects o ON o.id=v.object_id AND o.current_revision=v.revision) v JOIN case_knowledge_payloads k ON k.object_id=v.object_id AND k.revision=v.revision JOIN case_analysis_units u ON u.id=k.unit_id JOIN case_analysis_run_units ru ON ru.unit_id=u.id JOIN case_analysis_runs r ON r.id=ru.run_id {join} WHERE r.id=(SELECT value FROM meta WHERE key='case_analysis_run') AND v.stale=0 AND json_extract(u.result,'$.reviewed')=1 AND EXISTS(SELECT 1 FROM json_each(json_extract(u.result,'$.objects')) obj WHERE json_extract(obj.value,'$.id')=v.object_id AND json_extract(obj.value,'$.revision')=v.revision) AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(u.result,'$.reviews')) x WHERE json_extract(x.value,'$.object_id')=v.object_id AND json_extract(x.value,'$.state')='unsupported') {filter} {level} ORDER BY {order} LIMIT 51 OFFSET ?2");
    let mut q = case.db.prepare(&sql)?;
    let rows = q
        .query_map(
            params![
                search,
                offset,
                inputs.map(serde_json::to_string).transpose()?
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, String>(11)?,
                    r.get::<_, String>(12)?,
                    r.get::<_, String>(13)?,
                    r.get::<_, String>(14)?,
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let scanned = rows.len().min(50);
    let more = rows.len() > 50;
    let mut items = Vec::new();
    for (
        object,
        revision,
        kind,
        title,
        text,
        raw_sources,
        raw_locators,
        review,
        payload,
        source,
        stamp,
        model_manifest,
        unit_result,
        unit_kind,
        unit_spec,
    ) in rows.into_iter().take(50)
    {
        let sources: Vec<String> = serde_json::from_str(&raw_sources)?;
        if sources
            .iter()
            .any(|s| !scope.contains(s) || case.source(s).map_or(true, |s| s.restricted))
        {
            continue;
        }
        if source.is_none() && !manifest_current(case, &model_manifest)? {
            continue;
        }
        if let Some(source) = source {
            let current = unit_stamp(
                case,
                &source,
                &analysis_base_stamp(case, &source, &model_manifest)?,
                &unit_kind,
                &serde_json::from_str::<Value>(&unit_spec)?,
            )?;
            if stamp != current {
                continue;
            }
        }
        let locators: Vec<String> = serde_json::from_str(&raw_locators)?;
        let mut refs = Vec::new();
        let mut valid = true;
        for locator in locators {
            match register_ref(case, &locator) {
                Ok(reference) => refs.push(resolve_ref(case, &reference, scope)?),
                Err(_) => {
                    valid = false;
                    break;
                }
            }
        }
        if !valid {
            continue;
        }
        let unit_result: Value = serde_json::from_str(&unit_result)?;
        let support_review = unit_result["reviews"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["object_id"] == object && r["revision"] == revision)
            .cloned()
            .unwrap_or(Value::Null);
        let payload: Value = serde_json::from_str(&payload)?;
        let mut proof = Vec::new();
        for reference in payload["supporting"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(payload["contrary"].as_array().into_iter().flatten())
        {
            match resolve_ref(case, reference.as_str().unwrap_or(""), scope) {
                Ok(v) => proof.push(v),
                Err(_) => {
                    valid = false;
                    break;
                }
            }
        }
        if !valid {
            continue;
        }
        items.push(json!({"id":object,"revision":revision,"kind":kind,"title":title,"text":text,"evidence":if proof.is_empty(){refs}else{proof},"support_review":support_review,"human_review":review,"payload":payload}));
    }
    Ok(
        json!({"items":items,"next_offset":if more{Some(offset+scanned as u64)}else{None},"retrieval_level":if inputs.is_some(){"synthesis_inputs"}else{"all_findings"},"meaning":"Derived case knowledge with original proof; human review is separate. Missing results require targeted source research, not invented facts."}),
    )
}

fn manifest_current(case: &Case, model: &str) -> Result<bool> {
    let mut stamps = Vec::new();
    for source in case.sources()?.into_iter().filter(|s| !s.restricted) {
        stamps.push((source.id.clone(), source_stamp(case, &source.id)?));
    }
    stamps.sort();
    let expected = digest(
        json!([
            ANALYSIS_VERSION,
            model,
            case.settings()?.allow_images,
            stamps
        ])
        .to_string()
        .as_bytes(),
    );
    let manifest:Option<String>=case.db.query_row("SELECT manifest FROM case_analysis_runs WHERE id=(SELECT value FROM meta WHERE key='case_analysis_run')",[],|r|r.get(0)).optional()?;
    Ok(manifest.as_deref() == Some(expected.as_str()))
}
/// A bounded retrieval brief is common to both access routes. Full immutable
/// proof remains addressable by ref ID rather than dumping the case in context.
pub fn answer_context(case: &Case, scope: &[String], question: &str) -> Result<Value> {
    let query = question.chars().take(100).collect::<String>();
    let mut knowledge = query_knowledge(case, scope, &query, 0)?;
    let items = knowledge["items"]
        .as_array_mut()
        .context("Missing knowledge items")?;
    let omitted = items.len() > 12;
    items.truncate(12);
    for item in items {
        for reference in item["evidence"].as_array_mut().into_iter().flatten() {
            if let Some(text) = reference["proof"]["text"].as_str() {
                reference["proof"]["text"] = json!(text.chars().take(600).collect::<String>());
                reference["proof"]["excerpt_only"] = json!(true);
            }
        }
    }
    knowledge["brief_only"] = json!(true);
    knowledge["more_matches"] = json!(omitted);
    knowledge["analysis_status"] = json!(scoped_status(case, scope)?);
    Ok(knowledge)
}

// A one-source conversation must not receive blocker IDs or counts belonging
// to other sources in the case. The desktop Jobs panel still sees full status.
fn scoped_status(case: &Case, scope: &[String]) -> Result<Option<Value>> {
    let Some(mut status) = status(case)? else {
        return Ok(None);
    };
    let permitted: Vec<String> = scope
        .iter()
        .filter(|id| case.source(id).is_ok_and(|s| !s.restricted))
        .cloned()
        .collect();
    let run = status["run_id"].as_str().context("Missing analysis run")?;
    // A manifest can outlive a source restriction until dispatch reconciles it.
    // Current source grants cannot authorize historical run-unit identities.
    let excluded: bool = case.db.query_row("SELECT EXISTS(SELECT 1 FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id IS NOT NULL AND u.source_id NOT IN (SELECT value FROM json_each(?)))",params![run,serde_json::to_string(&permitted)?],|r|r.get(0))?;
    if !excluded
        && case
            .sources()?
            .iter()
            .filter(|s| !s.restricted)
            .all(|s| permitted.contains(&s.id))
    {
        return Ok(Some(status));
    }
    let (total,complete,running,blocked):(i64,i64,i64,i64)=case.db.query_row("SELECT count(*),coalesce(sum(u.state='complete'),0),coalesce(sum(u.state='running'),0),coalesce(sum(u.state='blocked'),0) FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.source_id IN (SELECT value FROM json_each(?))",params![run,serde_json::to_string(&permitted)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    if let Some(blockers) = status["blockers"].as_array_mut() {
        blockers.retain(|b| {
            b["source_id"]
                .as_str()
                .is_some_and(|s| permitted.iter().any(|id| id == s))
        });
    }
    Ok(Some(
        json!({"state":status["state"],"scope":"selected_sources","total":total,"complete":complete,"running":running,"blocked":blocked,"blockers":status["blockers"],"human_review":"separate"}),
    ))
}

pub fn status(case: &Case) -> Result<Option<Value>> {
    let Some(run) = case.meta("case_analysis_run")? else {
        return Ok(None);
    };
    let (state, model): (String, String) = case.db.query_row(
        "SELECT state,model_manifest FROM case_analysis_runs WHERE id=?",
        [&run],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let current = manifest_current(case, &model)? && stale_finding_units(case, &run)?.is_empty();
    let findings:i64=case.db.query_row("SELECT count(*) FROM case_knowledge_payloads k JOIN case_analysis_run_units r ON r.unit_id=k.unit_id JOIN case_analysis_units u ON u.id=k.unit_id JOIN evidence_objects o ON o.id=k.object_id AND o.current_revision=k.revision JOIN evidence_versions v ON v.object_id=k.object_id AND v.revision=k.revision WHERE r.run_id=? AND v.stale=0 AND json_extract(u.result,'$.reviewed')=1 AND EXISTS(SELECT 1 FROM json_each(json_extract(u.result,'$.objects')) obj WHERE json_extract(obj.value,'$.id')=k.object_id AND json_extract(obj.value,'$.revision')=k.revision)",[&run],|r|r.get(0))?;
    let (input_tokens,output_tokens,cost,unreported):(i64,i64,Option<f64>,bool)=case.db.query_row("SELECT coalesce(sum(json_extract(t.usage,'$.input_tokens')),0),coalesce(sum(json_extract(t.usage,'$.output_tokens')),0),sum(t.actual),coalesce(sum(t.usage IS NULL OR t.usage='{}' OR t.usage='null' OR t.actual IS NULL),0)>0 FROM transmissions t JOIN case_analysis_attempts a ON a.task_id=t.task_id JOIN case_analysis_run_units r ON r.unit_id=a.unit_id WHERE r.run_id=?",[&run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let (total,complete,running,blocked):(i64,i64,i64,i64)=case.db.query_row("SELECT count(*),coalesce(sum(u.state='complete'),0),coalesce(sum(u.state='running'),0),coalesce(sum(u.state='blocked'),0) FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=?",[&run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let mut q=case.db.prepare("SELECT u.id,u.source_id,u.kind,u.reason FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.state='blocked' ORDER BY r.ordinal LIMIT 50")?;
    let blockers=q.query_map([&run],|r|Ok(json!({"unit_id":r.get::<_,String>(0)?,"source_id":r.get::<_,Option<String>>(1)?,"kind":r.get::<_,String>(2)?,"reason":r.get::<_,String>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(Some(
        json!({"run_id":run,"state":if case.meta("case_analysis_paused")?.as_deref()==Some("true"){if state=="cancelled"{"cancelled"}else{"paused"}}else if !current{"stale"}else{&state},"current":current,"findings":findings,"usage":{"input_tokens":input_tokens,"output_tokens":output_tokens,"cost":cost,"unreported":unreported},"model_manifest":model,"total":total,"complete":complete,"running":running,"blocked":blocked,"blockers":blockers,"version":ANALYSIS_VERSION,"human_review":"separate"}),
    ))
}

pub fn finish_unit(case: &mut Case, task: &str, args: &Value) -> Result<Value> {
    let unit = task_unit(case, task)?.context("Task has no analysis unit")?;
    ensure!(unit["state"] == "running", "Unit is not running");
    validate_unit_input(case, &unit)?;
    let raw: String = case.db.query_row(
        "SELECT result FROM case_analysis_units WHERE id=?",
        [unit["id"].as_str()],
        |r| r.get(0),
    )?;
    let mut result: Value = serde_json::from_str(&raw)?;
    ensure!(
        result["published"] == true,
        "Publish the required unit before completing it"
    );
    let reviews = args["reviews"]
        .as_array()
        .context("Missing finding reviews")?;
    let objects = result["objects"]
        .as_array()
        .context("Missing published objects")?;
    let object_count = objects.len();
    ensure!(
        reviews.len() == objects.len(),
        "Review every exact published finding once"
    );
    let mut seen = std::collections::HashSet::new();
    for review in reviews {
        let object = review["object_id"]
            .as_str()
            .context("Missing review object")?;
        ensure!(
            seen.insert(object)
                && objects
                    .iter()
                    .any(|o| o["id"] == object && o["revision"] == review["revision"]),
            "Review belongs to a different finding or revision"
        );
        ensure!(
            ["supported", "unresolved", "unsupported"]
                .iter()
                .any(|s| review["state"] == *s),
            "Invalid support review state"
        );
        ensure!(
            review["reason"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 4000),
            "Support review needs a source-based reason"
        );
    }
    // Recheck live input/grants before accepting a unit completion.
    let sources: Vec<String> = serde_json::from_str(&case.db.query_row::<String, _, _>(
        "SELECT scope FROM tasks WHERE id=?",
        [task],
        |r| r.get(0),
    )?)?;
    for source in sources {
        ensure!(
            !case.source(&source)?.restricted,
            "Analysis source was restricted"
        );
    }
    for object in objects {
        let current = evidence::read(
            case,
            object["id"].as_str().context("Missing published object")?,
            None,
        )?;
        ensure!(
            current["revision"] == object["revision"] && current["stale"] != true,
            "Published findings or their inputs changed before completion"
        );
    }
    if reviews
        .iter()
        .any(|review| review["state"] == "unsupported")
    {
        result["reviews"] = json!(reviews);
        case.db.execute(
            "UPDATE case_analysis_units SET result=? WHERE id=?",
            params![result.to_string(), unit["id"].as_str()],
        )?;
        return Ok(
            json!({"status":"revision_required","instruction":"Narrow, correct or remove unsupported findings through publish_analysis_unit; inspect missing support when needed, then review the revised exact findings."}),
        );
    }
    result["reviewed"] = json!(true);
    result["reviews"] = json!(reviews);
    case.db.execute(
        "UPDATE case_analysis_units SET state='complete',result=?,updated_at=? WHERE id=?",
        params![result.to_string(), now(), unit["id"].as_str()],
    )?;
    case.db.execute(
        "UPDATE tasks SET status='complete',answer='',error='',updated_at=? WHERE id=?",
        params![now(), task],
    )?;
    case.audit("analysis_unit_completed",json!({"unit_id":unit["id"],"task_id":task,"objects":object_count,"human_review":"separate"}))?;
    Ok(json!({"status":"analysis_unit_complete","unit_id":unit["id"]}))
}

pub fn control(case: &mut Case, action: &str) -> Result<Value> {
    ensure!(
        ["pause", "resume", "retry_failed", "cancel"].contains(&action),
        "Unknown analysis control"
    );
    case.set_meta(
        "case_analysis_paused",
        if ["pause", "cancel"].contains(&action) {
            "true"
        } else {
            "false"
        },
    )?;
    let Some(run) = case.meta("case_analysis_run")? else {
        return Ok(json!({"state":"waiting_for_extraction"}));
    };
    if action == "cancel" {
        case.db.execute(
            "UPDATE case_analysis_runs SET state='cancelled',updated_at=? WHERE id=?",
            params![now(), run],
        )?;
    }
    let task:Option<String>=case.db.query_row("SELECT u.task_id FROM case_analysis_units u JOIN case_analysis_run_units r ON r.unit_id=u.id WHERE r.run_id=? AND u.state='running' LIMIT 1",[&run],|r|r.get(0)).optional()?.flatten();
    if let Some(task) = task {
        if ["pause", "cancel"].contains(&action) {
            agent::pause(case, &task, "Stopped by user")?;
        }
    }
    if ["resume", "retry_failed"].contains(&action) {
        // Old uncertain calls remain stopped; continuation is a distinct task.
        case.db.execute(
            "UPDATE case_analysis_runs SET state='queued',updated_at=? WHERE id=?",
            params![now(), run],
        )?;
        case.db.execute("UPDATE case_analysis_units SET state='queued',task_id=NULL,reason='',updated_at=? WHERE id IN (SELECT unit_id FROM case_analysis_run_units WHERE run_id=?) AND (state='blocked' OR (state='running' AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=case_analysis_units.task_id AND t.status='running'))) AND (kind IN ('text','text_fragment','audio_inventory','page','image','image_frame','office_image','frame','source_synthesis','synthesis','synthesis_group') OR (kind='video' AND json_extract(spec,'$.start') IS NOT NULL) OR (kind='audio_signal' AND json_extract(spec,'$.start') IS NOT NULL) OR (kind='transcript' AND json_extract(spec,'$.count') IS NOT NULL))",params![now(),run])?;
    }
    case.audit(
        "case_analysis_control",
        json!({"run_id":run,"action":action}),
    )?;
    Ok(status(case)?.unwrap_or(Value::Null))
}

#[cfg(test)]
mod grid_tests {
    use super::*;
    #[test]
    fn actual_decoder_grid_requires_middle_and_end_samples() {
        let spec = json!({"start":0.,"end":5.,"interval":0.5});
        let frames = (0..10)
            .map(|i| json!({"metadata":{"source_relative_seconds":i as f64*0.5}}))
            .collect::<Vec<_>>();
        let mut result = json!({"frames":frames});
        assert!(video_grid_covered(&result, &spec));
        result["frames"].as_array_mut().unwrap().remove(5);
        assert!(!video_grid_covered(&result, &spec));
        assert!(!video_grid_covered(
            &json!({"frames":[{"metadata":{"source_relative_seconds":0.}}]}),
            &spec
        ));
    }
}
