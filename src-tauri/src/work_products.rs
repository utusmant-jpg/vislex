//! Structured legal work products retain exact evidence dependencies and explicit authority limits.
use crate::{case::Case,evidence::{self,ObjectInput,Dependency}};
use anyhow::{ensure,Context,Result};
use serde_json::{json,Value};

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
            authority_limits.push(json!({"id":id,"revision":revision,"status":"Treatment and proposition support require independent checking","authority":object["content"]}));
        }
    }
    citations.sort();citations.dedup();dependencies.sort_by(|a,b|a.id.cmp(&b.id));dependencies.dedup_by(|a,b|a.id==b.id);
    evidence::write(case,ObjectInput{id:args["id"].as_str().filter(|s|!s.is_empty()).map(str::to_owned),base_revision:args["base_revision"].as_i64().context("Missing base revision")?,kind:kind.into(),title:args["title"].as_str().context("Missing title")?.into(),content:json!({"workflow":kind,"jurisdiction":jurisdiction,"relevant_date":relevant_date,"rows":rows,"authority_limits":authority_limits,"review":"Unreviewed working product; proposed language is not an executed change or legal conclusion","exposure_sources":sources}).to_string(),source_ids:sources,locators:citations,dependencies,start_seconds:None,end_seconds:None},"agent")
}
