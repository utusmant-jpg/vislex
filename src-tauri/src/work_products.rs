//! Structured legal work products retain exact evidence dependencies and explicit authority limits.
use crate::{case::Case,evidence::{self,ObjectInput,Dependency}};
use anyhow::{ensure,Context,Result};
use serde_json::{json,Value};

/// The fields of an authority a work product may carry. Only this whitelist is copied, so
/// anything else an adapter recorded (page hashes, retrieval internals, or any publisher
/// editorial text) never reaches a work product or its exports.
pub fn authority_projection(object:&Value)->Value {
    let content:Value=object["content"].as_str().and_then(|raw|serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
    let title=content["title"].as_str().map(|_|content["title"].clone()).unwrap_or_else(||object["title"].clone());
    let plain=|value:&Value|match value {Value::String(_)|Value::Bool(_)=>value.clone(),_=>Value::Null};
    let citation=match &content["citation"] {
        Value::Object(_)=>json!({"raw":plain(&content["citation"]["raw"]),"claimed":plain(&content["citation"]["claimed"]),"mismatch":plain(&content["citation"]["mismatch"])}),
        Value::String(text)=>json!(text),
        _=>Value::Null,
    };
    let scalar=|key:&str|match &content[key] {value@Value::String(_)=>value.clone(),_=>Value::Null};
    let limitations:Vec<Value>=content["limitations"].as_array().into_iter().flatten().filter(|item|item.is_string()).cloned().collect();
    json!({
        "url":scalar("url"),
        "title":title,
        "citation":citation,
        "jurisdiction":scalar("jurisdiction"),
        "relevant_date":scalar("relevant_date"),
        "retrieved_at":scalar("retrieved_at"),
        "treatment_status":scalar("treatment_status"),
        "proposition_support":scalar("proposition_support"),
        "quote":{"exact":content["quote"]["exact"].as_str(),"locator":content["quote"]["locator"].as_str()},
        "limitations":limitations,
    })
}

pub fn save(case:&mut Case,task:&str,args:&Value)->Result<Value> {
    ensure!(args.to_string().len()<=128000,"Work product too large");
    let raw:String=case.db.query_row("SELECT scope FROM tasks WHERE id=?",[task],|r|r.get(0))?;
    let sources:Vec<String>=serde_json::from_str(&raw)?;
    let kind=args["kind"].as_str().context("Missing workflow kind")?;
    let fields:&[&str]=match kind {
        "issue_matrix"=>&["question","factual_position","missing_evidence"],
        "discovery"=>&["request","production","status","due_date"],
        "contract_review"=>&["clause","original_wording","proposed_wording","obligation","responsible_party","due_date"],
        "deposition"=>&["question","purpose","follow_up"],
        "draft"=>&["paragraph","text"],
        "exhibit_list"=>&["label","description"],
        _=>anyhow::bail!("Unsupported work product")
    };
    let items:Value=serde_json::from_str(args["items_json"].as_str().context("Missing JSON rows")?)?;
    let rows=items.as_array().context("Rows must be an array")?;
    ensure!(!rows.is_empty()&&rows.len()<=500,"Supply 1 to 500 rows");
    let jurisdiction=args["jurisdiction"].as_str().context("Missing jurisdiction")?;
    let relevant_date=args["relevant_date"].as_str().context("Missing relevant date")?;
    if !["discovery","exhibit_list"].contains(&kind) {
        ensure!(!jurisdiction.trim().is_empty(),"Jurisdiction is required for this workflow");
        chrono::NaiveDate::parse_from_str(relevant_date,"%Y-%m-%d")?;
    }
    let mut citations=vec![];let mut dependencies=vec![];let mut authority_limits=vec![];
    for row in rows {
        for field in fields {ensure!(row[field].is_string(),"Missing {field} in workflow row");}
        for citation in row["citations"].as_array().context("Every row requires citations, or an empty list for unresolved working material")? {
            let citation=citation.as_str().context("Invalid citation")?;
            let verified=case.validate_citation(citation)?;
            ensure!(sources.iter().any(|s|Some(s.as_str())==verified["source_id"].as_str()),"Work product citation outside permitted scope");
            citations.push(citation.to_string());
        }
        for authority in row["authority_ids"].as_array().context("Every row requires authority_ids, which may be empty")? {
            let id=authority.as_str().context("Invalid authority ID")?;
            let object=evidence::read(case,id,None)?;ensure!(object["kind"]=="authority"&&object["stale"]==false,"Authority is missing or stale");
            for source in object["source_ids"].as_array().context("Missing authority provenance")? {ensure!(sources.iter().any(|s|Some(s.as_str())==source.as_str()),"Authority outside task scope");}
            let revision=object["revision"].as_i64().context("Authority revision missing")?;
            dependencies.push(Dependency{id:id.into(),revision});
            authority_limits.push(json!({"id":id,"revision":revision,"status":"Treatment and proposition support require independent checking","authority":authority_projection(&object)}));
        }
    }
    citations.sort();citations.dedup();dependencies.sort_by(|a,b|a.id.cmp(&b.id));dependencies.dedup_by(|a,b|a.id==b.id);
    evidence::write(case,ObjectInput{id:args["id"].as_str().filter(|s|!s.is_empty()).map(str::to_owned),base_revision:args["base_revision"].as_i64().context("Missing base revision")?,kind:kind.into(),title:args["title"].as_str().context("Missing title")?.into(),content:json!({"workflow":kind,"jurisdiction":jurisdiction,"relevant_date":relevant_date,"rows":rows,"authority_limits":authority_limits,"review":"Unreviewed working product; proposed language is not an executed change or legal conclusion","exposure_sources":sources}).to_string(),source_ids:sources,locators:citations,dependencies,start_seconds:None,end_seconds:None},"agent")
}
