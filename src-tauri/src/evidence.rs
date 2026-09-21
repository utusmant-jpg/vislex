//! Append-only evidence objects, exact revision dependencies, and clock hypotheses.
use crate::case::{id, now, Case};
use anyhow::{ensure, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch(r#"
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS evidence_objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL,current_revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence_versions(object_id TEXT NOT NULL REFERENCES evidence_objects(id),revision INTEGER NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,source_ids TEXT NOT NULL,locators TEXT NOT NULL,start_seconds REAL,end_seconds REAL,actor TEXT NOT NULL,review TEXT NOT NULL DEFAULT 'unreviewed',stale INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(object_id,revision));
    CREATE TABLE IF NOT EXISTS evidence_dependencies(object_id TEXT NOT NULL,revision INTEGER NOT NULL,input_id TEXT NOT NULL,input_revision INTEGER NOT NULL,PRIMARY KEY(object_id,revision,input_id,input_revision),FOREIGN KEY(object_id,revision) REFERENCES evidence_versions(object_id,revision),FOREIGN KEY(input_id,input_revision) REFERENCES evidence_versions(object_id,revision));
    CREATE INDEX IF NOT EXISTS evidence_input ON evidence_dependencies(input_id,input_revision);
    CREATE INDEX IF NOT EXISTS evidence_time ON evidence_versions(start_seconds,end_seconds);
    CREATE TABLE IF NOT EXISTS case_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coverage_receipts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),stage TEXT NOT NULL,method TEXT NOT NULL,locator TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS coverage_source ON coverage_receipts(source_id,stage);
    CREATE TABLE IF NOT EXISTS investigation_contracts(task_id TEXT PRIMARY KEY REFERENCES tasks(id),inventory_revision INTEGER NOT NULL,contract TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS investigation_obligations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),description TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',evidence TEXT NOT NULL DEFAULT '[]',reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_assignments(task_id TEXT PRIMARY KEY REFERENCES tasks(id),parent_id TEXT NOT NULL REFERENCES tasks(id),role TEXT NOT NULL,phase TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,merged INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS assignment_parent ON agent_assignments(parent_id,phase);
    CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(kind UNINDEXED,object_id UNINDEXED,title,content);
    CREATE TRIGGER IF NOT EXISTS passage_extract_insert AFTER INSERT ON extracts BEGIN INSERT INTO passage_fts(kind,object_id,title,content) VALUES('source',new.source_id,(SELECT name FROM sources WHERE id=new.source_id),new.text); END;
    CREATE TRIGGER IF NOT EXISTS passage_extract_update AFTER UPDATE ON extracts BEGIN DELETE FROM passage_fts WHERE kind='source' AND object_id=new.source_id; INSERT INTO passage_fts(kind,object_id,title,content) VALUES('source',new.source_id,(SELECT name FROM sources WHERE id=new.source_id),new.text); END;
    CREATE TRIGGER IF NOT EXISTS passage_record_insert AFTER INSERT ON records BEGIN INSERT INTO passage_fts(kind,object_id,title,content) VALUES('record',new.id,new.title,new.content); END;
    CREATE TRIGGER IF NOT EXISTS passage_record_update AFTER UPDATE OF content,title ON records BEGIN DELETE FROM passage_fts WHERE kind='record' AND object_id=new.id; INSERT INTO passage_fts(kind,object_id,title,content) VALUES('record',new.id,new.title,new.content); END;
    INSERT INTO passage_fts(kind,object_id,title,content) SELECT 'source',e.source_id,s.name,e.text FROM extracts e JOIN sources s ON s.id=e.source_id WHERE NOT EXISTS(SELECT 1 FROM passage_fts f WHERE f.kind='source' AND f.object_id=e.source_id);
    INSERT INTO passage_fts(kind,object_id,title,content) SELECT 'record',r.id,r.title,r.content FROM records r WHERE NOT EXISTS(SELECT 1 FROM passage_fts f WHERE f.kind='record' AND f.object_id=r.id);
    CREATE INDEX IF NOT EXISTS actions_task ON actions(task_id);
    CREATE INDEX IF NOT EXISTS transmissions_task ON transmissions(task_id);
    CREATE INDEX IF NOT EXISTS occurrences_source ON occurrences(source_id);
    CREATE INDEX IF NOT EXISTS processing_jobs_source ON processing_jobs(source_id);
    CREATE INDEX IF NOT EXISTS artifacts_source ON artifacts(source_id);
    PRAGMA user_version=5;
    COMMIT;
    "#)?;
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvidenceLocator {
    Text {
        source_id: String,
        extraction_revision: i64,
        line_start: u64,
        line_end: u64,
    },
    Artifact {
        source_id: String,
        artifact_id: String,
    },
    Audio {
        source_id: String,
        stream: u32,
        channel: Option<u32>,
        sample_start: String,
        sample_end: String,
        sample_rate: u32,
    },
    Video {
        source_id: String,
        stream: u32,
        pts: String,
        timebase_num: u32,
        timebase_den: u32,
    },
    Image {
        source_id: String,
        width: u32,
        height: u32,
        region: Option<[u32; 4]>,
    },
    Record {
        record_id: String,
        revision: i64,
    },
}
impl EvidenceLocator {
    pub fn validate(&self, case: &Case) -> Result<()> {
        match self {
            Self::Text {
                source_id,
                extraction_revision,
                line_start,
                line_end,
            } => {
                ensure!(
                    *extraction_revision == 1 && *line_start > 0 && line_end >= line_start,
                    "Invalid text location"
                );
                case.validate_citation(&format!("evidence:{source_id}#L{line_start}-L{line_end}"))?;
            }
            Self::Artifact {
                source_id,
                artifact_id,
            } => {
                let (owner, _, _, _) = crate::processing::artifact(case, artifact_id)?;
                ensure!(&owner == source_id, "Artifact ownership mismatch");
            }
            Self::Audio {
                source_id,
                sample_start,
                sample_end,
                sample_rate,
                ..
            } => {
                ensure!(
                    ["audio", "video"].contains(&case.source(source_id)?.kind.as_str()),
                    "Not audio/video"
                );
                let a: u64 = sample_start.parse()?;
                let b: u64 = sample_end.parse()?;
                ensure!(*sample_rate > 0 && b > a, "Invalid sample interval");
            }
            Self::Video {
                source_id,
                pts,
                timebase_num,
                timebase_den,
                ..
            } => {
                ensure!(case.source(source_id)?.kind == "video", "Not video");
                let _: i64 = pts.parse()?;
                ensure!(*timebase_num > 0 && *timebase_den > 0, "Invalid timebase");
            }
            Self::Image {
                source_id,
                width,
                height,
                region,
            } => {
                ensure!(
                    case.source(source_id)?.kind == "image" && *width > 0 && *height > 0,
                    "Invalid image locator"
                );
                if let Some([x, y, w, h]) = region {
                    ensure!(
                        *w > 0
                            && *h > 0
                            && u64::from(*x) + u64::from(*w) <= u64::from(*width)
                            && u64::from(*y) + u64::from(*h) <= u64::from(*height),
                        "Region out of bounds"
                    );
                }
            }
            Self::Record {
                record_id,
                revision,
            } => {
                ensure!(
                    case.db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM revisions WHERE record_id=? AND revision=?)",
                        params![record_id, revision],
                        |r| r.get::<_, bool>(0)
                    )?,
                    "Revision does not exist"
                );
            }
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Dependency {
    pub id: String,
    pub revision: i64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ObjectInput {
    pub id: Option<String>,
    pub base_revision: i64,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub source_ids: Vec<String>,
    pub locators: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
}
pub fn write(case: &mut Case, input: ObjectInput, actor: &str) -> Result<Value> {
    ensure!(
        [
            "issue_matrix", "discovery", "contract_review", "deposition", "draft", "exhibit_list",
            "track",
            "observation",
            "statement",
            "event",
            "claim",
            "entity",
            "clock",
            "issue",
            "authority",
            "hypothesis",
            "note"
        ]
        .contains(&input.kind.as_str()),
        "Unknown evidence object kind"
    );
    ensure!(
        !input.title.trim().is_empty() && input.title.len() <= 300 && input.content.len() <= 128000,
        "Invalid title or content size"
    );
    ensure!(
        input.source_ids.len() <= 10000
            && input.locators.len() <= 1000
            && input.dependencies.len() <= 1000,
        "Too many dependencies"
    );
    for sid in &input.source_ids {
        ensure!(!case.source(sid)?.restricted, "Restricted source");
    }
    for locator in &input.locators {
        let result = case.validate_citation(locator)?;
        ensure!(
            input
                .source_ids
                .iter()
                .any(|id| Some(id.as_str()) == result["source_id"].as_str()),
            "Citation is outside declared dependencies"
        );
    }
    if let Some(a) = input.start_seconds {
        ensure!(a.is_finite() && a >= 0., "Invalid start time");
    }
    if let Some(b) = input.end_seconds {
        ensure!(
            b.is_finite() && input.start_seconds.is_some_and(|a| b >= a),
            "Invalid interval"
        );
    }
    let object = input.id.clone().unwrap_or_else(id);
    let old: Option<(i64, String)> = case
        .db
        .query_row(
            "SELECT current_revision,kind FROM evidence_objects WHERE id=?",
            [&object],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    ensure!(
        old.as_ref().map(|x| x.0).unwrap_or(0) == input.base_revision,
        "Evidence changed; read the latest revision before editing"
    );
    ensure!(
        old.as_ref().is_none_or(|x| x.1 == input.kind),
        "Object kind is immutable"
    );
    if old.is_some() {
        let previous = read(case, &object, None)?;
        for sid in previous["source_ids"].as_array().unwrap() {
            ensure!(
                input
                    .source_ids
                    .iter()
                    .any(|s| Some(s.as_str()) == sid.as_str()),
                "Existing source restrictions cannot be removed"
            );
        }
    }
    for dep in &input.dependencies {
        ensure!(dep.id != object, "Self dependency is not allowed");
        let parent = read(case, &dep.id, Some(dep.revision))?;
        ensure!(
            parent["stale"] != true && read(case, &dep.id, None)?["revision"] == dep.revision,
            "Cannot depend on stale or superseded evidence"
        );
        let cycle:bool=case.db.query_row("WITH RECURSIVE ancestors(id) AS (SELECT input_id FROM evidence_dependencies WHERE object_id=? UNION SELECT d.input_id FROM evidence_dependencies d JOIN ancestors a ON d.object_id=a.id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?)",params![dep.id,object],|r|r.get(0))?;
        ensure!(!cycle, "Dependency cycle is not allowed");
        for source in parent["source_ids"].as_array().unwrap() {
            ensure!(
                input
                    .source_ids
                    .iter()
                    .any(|s| Some(s.as_str()) == source.as_str()),
                "Derived objects must retain all source restrictions"
            );
        }
    }
    let revision = input.base_revision + 1;
    case.db.execute_batch("SAVEPOINT evidence_write")?;
    let result = (|| -> Result<()> {
        case.db.execute("INSERT INTO evidence_objects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision",params![object,input.kind,revision])?;
        case.db.execute("INSERT INTO evidence_versions(object_id,revision,title,content,source_ids,locators,start_seconds,end_seconds,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![object,revision,input.title,input.content,serde_json::to_string(&input.source_ids)?,serde_json::to_string(&input.locators)?,input.start_seconds,input.end_seconds,actor,now()])?;
        for dep in &input.dependencies {
            case.db.execute(
                "INSERT INTO evidence_dependencies VALUES(?,?,?,?)",
                params![object, revision, dep.id, dep.revision],
            )?;
        }
        case.db.execute("WITH RECURSIVE affected(id) AS (SELECT object_id FROM evidence_dependencies WHERE input_id=? AND input_revision=? UNION SELECT d.object_id FROM evidence_dependencies d JOIN affected a ON d.input_id=a.id) UPDATE evidence_versions SET stale=1 WHERE object_id IN (SELECT id FROM affected) AND revision=(SELECT current_revision FROM evidence_objects WHERE id=object_id)",params![object,input.base_revision])?;
        case.db.execute("INSERT INTO case_outbox(kind,object_id,revision,payload,created_at) VALUES('EvidenceChanged',?,?,?,?)",params![object,revision,json!({"kind":input.kind,"source_ids":input.source_ids}).to_string(),now()])?;
        case.db.execute(
            "DELETE FROM passage_fts WHERE kind='object' AND object_id=?",
            [&object],
        )?;
        case.db.execute(
            "INSERT INTO passage_fts VALUES('object',?,?,?)",
            params![object, input.title, input.content],
        )?;
        case.audit(
            "evidence_revision",
            json!({"id":object,"revision":revision,"actor":actor}),
        )?;
        Ok(())
    })();
    if let Err(e) = result {
        case.db
            .execute_batch("ROLLBACK TO evidence_write; RELEASE evidence_write")?;
        return Err(e);
    }
    case.db.execute_batch("RELEASE evidence_write")?;
    read(case, &object, Some(revision))
}
pub fn read(case: &Case, object: &str, revision: Option<i64>) -> Result<Value> {
    let mut v=case.db.query_row("SELECT o.id,o.kind,v.revision,v.title,v.content,v.source_ids,v.locators,v.start_seconds,v.end_seconds,v.actor,v.review,v.stale,v.created_at FROM evidence_objects o JOIN evidence_versions v ON v.object_id=o.id AND v.revision=COALESCE(?,o.current_revision) WHERE o.id=?",params![revision,object],|r|Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"title":r.get::<_,String>(3)?,"content":r.get::<_,String>(4)?,"source_ids":r.get::<_,String>(5)?,"locators":r.get::<_,String>(6)?,"start_seconds":r.get::<_,Option<f64>>(7)?,"end_seconds":r.get::<_,Option<f64>>(8)?,"actor":r.get::<_,String>(9)?,"review":r.get::<_,String>(10)?,"stale":r.get::<_,bool>(11)?,"created_at":r.get::<_,String>(12)?})))?;
    for field in ["source_ids", "locators"] {
        v[field] = serde_json::from_str(v[field].as_str().unwrap())?;
    }
    for sid in v["source_ids"].as_array().unwrap() {
        ensure!(
            !case.source(sid.as_str().unwrap())?.restricted,
            "Restricted dependency"
        );
    }
    let mut stmt=case.db.prepare("SELECT input_id,input_revision FROM evidence_dependencies WHERE object_id=? AND revision=? ORDER BY input_id")?;
    let deps = stmt
        .query_map(params![object, v["revision"].as_i64().unwrap()], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?}))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    v["dependencies"] = json!(deps);
    Ok(v)
}
pub fn list(case: &Case, source: Option<&str>, kind: Option<&str>, offset: usize) -> Result<Value> {
    let mut stmt=case.db.prepare("SELECT o.id FROM evidence_objects o JOIN evidence_versions v ON v.object_id=o.id AND v.revision=o.current_revision WHERE (? IS NULL OR o.kind=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(v.source_ids) WHERE value=?)) AND NOT EXISTS(SELECT 1 FROM json_each(v.source_ids) j JOIN sources s ON s.id=j.value WHERE s.restricted=1) ORDER BY COALESCE(v.start_seconds,1e30),v.created_at,o.id LIMIT 51 OFFSET ?")?;
    let ids = stmt
        .query_map(params![kind, kind, source, source, offset as i64], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let more = ids.len() > 50;
    let mut values = Vec::new();
    for id in ids.iter().take(50) {
        values.push(read(case, id, None)?)
    }
    Ok(json!({"objects":values,"next_offset":if more{Some(offset+50)}else{None}}))
}
pub fn search(case: &Case, query: &str, offset: usize) -> Result<Value> {
    ensure!(
        !query.trim().is_empty() && query.len() <= 1000,
        "Enter a search query"
    );
    let query = query
        .split_whitespace()
        .take(12)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    // Restrictions are applied before pagination; raw snippets never leave this method unchecked.
    let mut stmt=case.db.prepare("SELECT kind,object_id,title,snippet(passage_fts,3,'[',']',' … ',40) FROM passage_fts WHERE passage_fts MATCH ? AND ((kind='source' AND EXISTS(SELECT 1 FROM sources s WHERE s.id=object_id AND s.restricted=0)) OR (kind='record' AND EXISTS(SELECT 1 FROM records r WHERE r.id=object_id AND NOT EXISTS(SELECT 1 FROM json_each(r.dependencies) j JOIN sources s ON s.id=j.value WHERE s.restricted=1))) OR (kind='object' AND EXISTS(SELECT 1 FROM evidence_versions v JOIN evidence_objects o ON o.id=v.object_id AND o.current_revision=v.revision WHERE o.id=passage_fts.object_id AND NOT EXISTS(SELECT 1 FROM json_each(v.source_ids) j JOIN sources s ON s.id=j.value WHERE s.restricted=1)))) ORDER BY bm25(passage_fts),object_id LIMIT 51 OFFSET ?")?;
    let mut hits=stmt.query_map(params![query,offset as i64],|r|Ok(json!({"kind":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"excerpt":r.get::<_,String>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more = hits.len() > 50;
    hits.truncate(50);
    Ok(
        json!({"results":hits,"next_offset":if more{Some(offset+50)}else{None},"coverage":"Lexical index of extracts, current working records and structured objects. Search hits are leads; inspect originals before making claims."}),
    )
}
pub fn review(case: &mut Case, object: &str, revision: i64, state: &str) -> Result<()> {
    ensure!(
        ["accepted", "rejected", "unreviewed"].contains(&state),
        "Invalid review state"
    );
    let v = read(case, object, None)?;
    ensure!(
        v["revision"] == revision && v["stale"] == false,
        "Review requires a current, non-stale revision"
    );
    case.db.execute_batch("SAVEPOINT evidence_review")?;
    let result = (|| -> Result<()> {
        case.db.execute(
            "UPDATE evidence_versions SET review=? WHERE object_id=? AND revision=?",
            params![state, object, revision],
        )?;
        case.db.execute("INSERT INTO case_outbox(kind,object_id,revision,payload,created_at) VALUES('ReviewChanged',?,?,?,?)",params![object,revision,json!({"review":state}).to_string(),now()])?;
        case.audit(
            "evidence_review",
            json!({"id":object,"revision":revision,"state":state,"actor":"human"}),
        )
    })();
    if let Err(e) = result {
        case.db
            .execute_batch("ROLLBACK TO evidence_review; RELEASE evidence_review")?;
        return Err(e);
    }
    case.db.execute_batch("RELEASE evidence_review")?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anchor {
    pub source_seconds: f64,
    pub incident_seconds: f64,
    pub uncertainty_seconds: f64,
    #[serde(default)]
    pub held_out: bool,
}
/// A clock fit is a hypothesis; acceptance is explicit and never inferred from anchor count alone.
pub fn fit_clock(anchors: &[Anchor]) -> Result<Value> {
    ensure!(
        !anchors.is_empty() && anchors.len() <= 10000,
        "Supply 1–10000 anchors"
    );
    for a in anchors {
        ensure!(
            a.source_seconds.is_finite()
                && a.source_seconds >= 0.
                && a.incident_seconds.is_finite()
                && a.uncertainty_seconds.is_finite()
                && a.uncertainty_seconds >= 0.,
            "Invalid clock anchor"
        );
    }
    let train: Vec<_> = anchors.iter().filter(|a| !a.held_out).collect();
    ensure!(!train.is_empty(), "At least one fitting anchor is required");
    let min = train
        .iter()
        .map(|a| a.source_seconds)
        .fold(f64::INFINITY, f64::min);
    let max = train
        .iter()
        .map(|a| a.source_seconds)
        .fold(f64::NEG_INFINITY, f64::max);
    let mx = train.iter().map(|a| a.source_seconds).sum::<f64>() / train.len() as f64;
    let my = train.iter().map(|a| a.incident_seconds).sum::<f64>() / train.len() as f64;
    ensure!(
        mx.is_finite() && my.is_finite(),
        "Clock anchors exceed numerical limits"
    );
    let mut positions: Vec<f64> = train.iter().map(|a| a.source_seconds).collect();
    positions.sort_by(f64::total_cmp);
    positions.dedup();
    let drift = positions.len() >= 3 && max - min >= 60.;
    let denom = train
        .iter()
        .map(|a| (a.source_seconds - mx).powi(2))
        .sum::<f64>();
    let scale = if drift {
        train
            .iter()
            .map(|a| (a.source_seconds - mx) * (a.incident_seconds - my))
            .sum::<f64>()
            / denom
    } else {
        1.
    };
    ensure!(
        scale.is_finite() && scale > 0.,
        "Non-monotonic or invalid mapping"
    );
    let offset = my - scale * mx;
    ensure!(
        offset.is_finite()
            && anchors
                .iter()
                .all(|a| (scale * a.source_seconds + offset).is_finite()),
        "Clock fit exceeded numerical limits"
    );
    let residuals:Vec<_>=anchors.iter().map(|a|{let residual=a.incident_seconds-(scale*a.source_seconds+offset);json!({"residual_seconds":residual,"held_out":a.held_out,"within_tolerance":residual.abs()<=0.1_f64.max(a.uncertainty_seconds*3.)})}).collect();
    let validated = anchors.iter().any(|a| a.held_out)
        && anchors
            .iter()
            .filter(|a| a.held_out)
            .all(|a| a.source_seconds >= min && a.source_seconds <= max)
        && residuals.iter().all(|r| r["within_tolerance"] == true);
    let uncertainty = anchors
        .iter()
        .map(|a| {
            (a.incident_seconds - (scale * a.source_seconds + offset)).abs() + a.uncertainty_seconds
        })
        .fold(0., f64::max);
    Ok(
        json!({"scale":scale,"offset_seconds":offset,"valid_source_range":[min,max],"uncertainty_seconds":uncertainty,"drift_estimated":drift,"held_out_checks_passed":validated,"status":if validated{"candidate_validated"}else{"provisional"},"residuals":residuals,"limitations":["Anchors are supplied assertions; this fit does not authenticate them.","No extrapolation beyond the fitted range; clock resets require separate segments.","Propagation delay and repeated-sound ambiguity require independent review."]}),
    )
}
