//! Explicit public-source retrieval. No case text, credentials or cookies are sent.
use crate::case::{Case, now};
use anyhow::{ensure, Context, Result};
use serde_json::{json,Value};
use rusqlite::params;
pub struct Download {pub url:String,pub bytes:Vec<u8>,pub mime:String,pub retrieved_at:String}

pub fn validate_url(raw:&str)->Result<reqwest::Url> {
    ensure!(raw.len()<=4000,"URL too long");let url=reqwest::Url::parse(raw)?;
    ensure!(url.scheme()=="https" && url.username().is_empty() && url.password().is_none() && url.port().is_none(),"Use a public HTTPS URL without credentials or a custom port");
    let host=url.host_str().context("Missing public host")?;
    ensure!(["www.courtlistener.com","courtlistener.com","www.govinfo.gov","govinfo.gov","www.supremecourt.gov","supremecourt.gov","uscode.house.gov","www.uscourts.gov","www.ecfr.gov"].contains(&host),"This authority host is not supported by the public-source adapter");
    ensure!(url.fragment().is_none(),"Use the canonical URL without a fragment");Ok(url)
}
pub async fn retrieve(raw:&str)->Result<Download> {
    let url=validate_url(raw)?;
    let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(45)).user_agent("VisLex-PublicAuthority/1.0").build()?;
    let mut response=client.get(url.clone()).send().await?;
    ensure!(response.status().is_success(),"Public source returned HTTP {}; use its canonical document URL",response.status());
    let mime=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|h|h.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_string();
    ensure!(["text/plain","text/html","application/pdf"].contains(&mime.as_str()),"Unsupported public-source document type");
    let mut bytes=vec![];while let Some(chunk)=response.chunk().await? {ensure!(bytes.len()+chunk.len()<=8*1024*1024,"Authority exceeds 8 MiB retrieval limit; import its original manually");bytes.extend_from_slice(&chunk);}
    ensure!(!bytes.is_empty(),"Empty authority response");Ok(Download{url:url.to_string(),bytes,mime,retrieved_at:now()})
}
pub fn html_text(html:&str)->Result<String> {
    let mut clean=html.to_owned();
    for element in ["script","style","noscript"] {clean=regex::Regex::new(&format!("(?is)<{element}\\b[^>]*>.*?</{element}\\s*>"))?.replace_all(&clean,"").into_owned();}
    clean=regex::Regex::new("(?is)<[^>]+>")?.replace_all(&clean,"\n").into_owned();
    for (entity,value) in [("&nbsp;"," "),("&lt;","<"),("&gt;",">"),("&quot;","\""),("&#39;","'"),("&amp;","&")] {clean=clean.replace(entity,value);}
    Ok(clean.lines().map(str::trim).filter(|line|!line.is_empty()).collect::<Vec<_>>().join("\n"))
}
/// Trusted ingest for bytes already retrieved by this adapter. The bytes come from
/// a validated public HTTPS response held in memory, so they are staged directly
/// for the case publisher; this narrow path never accepts an external filesystem
/// path, and the user-facing import guard still rejects importing files from
/// inside the active case.
fn ingest_authority_bytes(case:&mut Case,download:&Download,suffix:&str)->Result<Value> {
    let prepared=crate::case::PreparedImport::from_verified_bytes(
        &case.root,
        &download.bytes,
        &format!("Public authority.{suffix}"),
        &format!("public-authority:{}",download.url),
    )?;
    let batch=crate::case::id();
    let item=case.publish_import(prepared,"Public authority retrieval",&batch);
    let (status,detail)=match &item{Ok(v)=>("imported",v.to_string()),Err(e)=>("failed",e.to_string())};
    case.db.execute("INSERT INTO imports VALUES(?,?,?,?,?,?)",params![crate::case::id(),download.url,batch,status,detail,now()])?;
    case.audit("import_batch",json!({"batch":batch,"items":[json!({"path":download.url,"status":status,"detail":detail})]}))?;
    item
}
pub fn publish(case:&mut Case,download:Download,title:&str,jurisdiction:&str,relevant_date:&str)->Result<Value> {
    ensure!(!case.settings()?.offline,"Offline mode enabled");
    ensure!(!title.trim().is_empty()&&title.len()<=250&&!jurisdiction.trim().is_empty()&&jurisdiction.len()<=200,"Supply title and jurisdiction");
    chrono::NaiveDate::parse_from_str(relevant_date,"%Y-%m-%d").context("Use YYYY-MM-DD for the legally relevant date")?;
    let suffix=if download.mime=="application/pdf"{"pdf"}else if download.mime=="text/html"{"html"}else{"txt"};
    let imported=ingest_authority_bytes(case,&download,suffix)?;
    // Identity comes from the immutable downloaded bytes, not a URL or a model-supplied citation.
    let hash=crate::case::digest(&download.bytes);
    let source:String=case.db.query_row("SELECT id FROM sources WHERE sha256=?",[hash],|r| r.get(0))?;
    ensure!(!case.source(&source)?.restricted,"Matching source is restricted");
    if download.mime=="text/html" {
        let raw=std::str::from_utf8(&download.bytes).context("Non-UTF8 authority HTML; import and inspect manually")?;
        let text=html_text(raw)?;
        // The importer already created an empty FTS row for this non-text kind;
        // replace it so the structural extraction is actually searchable.
        case.db.execute("INSERT OR IGNORE INTO extracts(source_id,text,method) VALUES(?,?,'Public HTML structural text extraction; verify against saved original')",params![source,text])?;
        case.db.execute("UPDATE extracts SET text=?,method='Public HTML structural text extraction; verify against saved original' WHERE source_id=? AND text=''",params![text,source])?;
        case.db.execute("DELETE FROM source_fts WHERE source_id=?",[&source])?;
        case.db.execute("INSERT INTO source_fts(source_id,name,text) VALUES(?,?,?)",params![source,title,text])?;
    }
    let content=json!({"url":download.url,"jurisdiction":jurisdiction,"relevant_date":relevant_date,"retrieved_at":download.retrieved_at,"treatment_status":"not_checked","proposition_support":"not_assessed","original_source_id":source,"mime":download.mime,"limitations":["Retrieval does not verify current validity, subsequent treatment or support for a legal proposition.","Relevant date is the requested research date, not proof this document was in force then."]});
    let object=crate::evidence::write(case,crate::evidence::ObjectInput{id:None,base_revision:0,kind:"authority".into(),title:title.into(),content:content.to_string(),source_ids:vec![source.clone()],locators:vec![],dependencies:vec![],start_seconds:None,end_seconds:None},"public_source_adapter")?;
    case.audit("public_authority_retrieved",json!({"source":source,"authority":object["id"],"url":download.url,"import":imported}))?;
    crate::automatic::enqueue(case)?;
    Ok(json!({"source_id":source,"authority":object}))
}
