use crate::case::{Case,Record,file_hash,now};
use anyhow::{ensure,Context,Result};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},io::Write};

fn escaped(s:&str)->String {s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&#39;")}
fn destination(case:&Case,path:&Path)->Result<()> {
    ensure!(!path.exists(),"Choose a new export destination");
    ensure!(!path.parent().context("Missing destination parent")?.canonicalize()?.starts_with(&case.root),"Export outside the active case");Ok(())
}
pub fn dossier_bundle(case:&mut Case,task:&str,path:&Path)->Result<Value> {
    destination(case,path)?;
    let view=crate::dossier::view(case,task)?;
    ensure!(view["stale"]==false && view["completion_stale"]==false,"Recheck changed evidence before exporting");
    let dossier=crate::dossier::load(case,task)?.context("No dossier")?;
    ensure!(!dossier.claims.is_empty(),"No reviewed findings to export");
    for (i,_) in dossier.claims.iter().enumerate() {ensure!(view["human_reviews"][i]["decision"]=="accepted" && view["human_reviews"][i]["stale"]==false,"Every exported finding requires current human acceptance");}
    let stage=tempfile::tempdir_in(path.parent().context("Missing parent")?)?;
    fs::create_dir(stage.path().join("evidence"))?;
    let mut files=std::collections::BTreeMap::new();let mut body=format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'\"><title>Reviewed investigation</title><style>body{{max-width:1000px;margin:40px auto;font:17px/1.6 system-ui}}article{{border-top:1px solid #bbb;padding:16px 0}}pre{{white-space:pre-wrap}}</style><h1>Reviewed investigation</h1><p>{}</p><p>This local package includes cited original files. It is not a redacted disclosure package. Human acceptance is recorded; unresolved limitations remain.</p>",escaped(&dossier.scope));
    for claim in &dossier.claims {
        body.push_str(&format!("<article><h2>{}</h2><p>{}</p><p>Uncertainty: {}</p><p>Next check: {}</p>",escaped(&claim.proposition),escaped(&claim.assessment),escaped(&claim.uncertainty),escaped(&claim.next_check)));
        for (label,citations) in [("Supporting",&claim.supporting),("Conflicting",&claim.contrary)] {
            body.push_str(&format!("<h3>{label}</h3><ul>"));
            for citation in citations {
                let valid=case.validate_citation(citation)?;let source=valid["source_id"].as_str().context("Missing source")?;
                ensure!(!case.source(source)?.restricted,"Restricted export dependency");case.verify_source(source)?;
                let (from,relative)=if let Some((_,artifact))=citation.split_once("#artifact:") {
                    let (_,mime,file,_)=crate::processing::artifact(case,artifact)?;
                    let extension=match mime.as_str(){"image/jpeg"=>"jpg","video/mp4"=>"mp4","application/json"=>"json",_=>"bin"};
                    (file,format!("evidence/{artifact}.{extension}"))
                } else {(case.source_path(source)?,format!("evidence/{source}.bin"))};
                if !files.contains_key(&relative) {let target=stage.path().join(&relative);let mut output=fs::File::create(&target)?;std::io::copy(&mut fs::File::open(&from)?,&mut output)?;output.sync_all()?;drop(output);let hash=file_hash(&target)?;ensure!(hash==file_hash(&from)?,"Evidence changed during export");files.insert(relative.clone(),json!({"sha256":hash,"source_id":source,"original_name":case.source(source)?.name}));}
                body.push_str(&format!("<li><a download href=\"{}\">{}</a></li>",escaped(&relative),escaped(citation)));
            }
            body.push_str("</ul>");
        }body.push_str("</article>");
    }
    body.push_str(&format!("<h2>Checks and limitations</h2><pre>{}</pre></html>",escaped(&serde_json::to_string_pretty(&json!({"checks":dossier.checks,"completion":view["completion"]}))?)));
    fs::write(stage.path().join("index.html"),&body)?;
    fs::write(stage.path().join("dossier.json"),serde_json::to_vec_pretty(&view)?)?;
    files.insert("index.html".into(),json!({"sha256":crate::case::digest(body.as_bytes())}));
    files.insert("dossier.json".into(),json!({"sha256":file_hash(&stage.path().join("dossier.json"))?}));
    let manifest=json!({"version":1,"task":task,"dossier_revision":dossier.revision,"exported_at":now(),"files":files,"redacted":false});
    fs::write(stage.path().join("manifest.json"),serde_json::to_vec_pretty(&manifest)?)?;
    for file in files.keys().chain(std::iter::once(&"manifest.json".to_string())) {fs::OpenOptions::new().read(true).write(true).open(stage.path().join(file))?.sync_all()?;}
    // Same-parent staging permits an atomic directory rename without replacing an existing package.
    ensure!(!path.exists(),"Destination appeared during export");fs::rename(stage.path(),path)?;
    case.audit("reviewed_dossier_exported",json!({"task":task,"revision":dossier.revision,"manifest_hash":crate::case::digest(&serde_json::to_vec(&manifest)?)}))?;
    Ok(json!({"path":path,"manifest":manifest}))
}
pub struct DocumentExport {pub staging:tempfile::TempDir,pub record:Record,pub target:PathBuf,pub format:String}
pub fn prepare_document(case:&Case,record:&str,target:&Path)->Result<DocumentExport> {
    destination(case,target)?;let record=case.record(record)?;
    for source in &record.dependencies {ensure!(!case.source(source)?.restricted,"Restricted source dependency");}
    let format=target.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();ensure!(["docx","pdf"].contains(&format.as_str()),"Use .docx or .pdf");
    let staging=tempfile::tempdir_in(case.root.join("staging"))?;
    let request=json!({"version":1,"kind":"document_export","format":format,"title":record.title,"content":record.content,"status":format!("DRAFT — {} — revision {} — stale: {}. Not a sanitized disclosure package.",record.review,record.revision,record.stale)});
    fs::write(staging.path().join("request.json"),request.to_string())?;
    Ok(DocumentExport{staging,record,target:target.into(),format})
}
pub fn run_document(job:&DocumentExport)->Result<()> {
    #[cfg(windows)]
    crate::sandbox::run_worker(&crate::processing::worker_path()?,job.staging.path(),std::time::Duration::from_secs(120))?;
    #[cfg(not(windows))]
    anyhow::bail!("Windows sandbox required");
    let output:Value=serde_json::from_slice(&fs::read(job.staging.path().join("result.json"))?)?;
    ensure!(output["status"]=="complete","{}",output["error"].as_str().unwrap_or("Export failed"));Ok(())
}
pub fn publish_document(case:&mut Case,job:&DocumentExport)->Result<Value> {
    destination(case,&job.target)?;let current=case.record(&job.record.id)?;ensure!(current.revision==job.record.revision && current.stale==job.record.stale && current.review==job.record.review,"Draft or review status changed during export");
    for source in &job.record.dependencies {ensure!(!case.source(source)?.restricted,"Source became restricted");}
    let output=job.staging.path().join(format!("document.{}",job.format));
    ensure!(output.metadata()?.len()<=32*1024*1024,"Export too large");
    let mut staged=tempfile::NamedTempFile::new_in(job.target.parent().context("Missing parent")?)?;
    std::io::copy(&mut fs::File::open(output)?,staged.as_file_mut())?;staged.flush()?;staged.as_file().sync_all()?;let hash=file_hash(staged.path())?;
    staged.persist_noclobber(&job.target)?;
    case.audit("document_draft_exported",json!({"record":job.record.id,"revision":job.record.revision,"sha256":hash}))?;
    Ok(json!({"path":job.target,"sha256":hash}))
}

pub fn review_redaction(case:&mut Case,artifact:&str,pages:&[u64],note:&str)->Result<Value> {
    let (source,mime,path,metadata)=crate::processing::artifact(case,artifact)?;
    ensure!(mime=="application/pdf"&&metadata["redaction"]==true,"Select a flattened redaction PDF");
    ensure!(!case.source(&source)?.restricted,"Restricted source");
    let count=metadata["page_count"].as_u64().context("Missing page count")?;
    ensure!(count>0&&count<=500&&(1..=count).all(|n|pages.contains(&n))&&pages.len()==count as usize,"Review every derivative page before acceptance");
    ensure!(note.len()<=4000,"Review note too long");
    let review=json!({"artifact_id":artifact,"sha256":file_hash(&path)?,"pages":pages,"note":note,"actor":"human","created_at":now()});
    case.set_meta(&format!("redaction_review:{artifact}"),&review.to_string())?;
    case.audit("redaction_reviewed",review.clone())?;Ok(review)
}
pub fn export_redaction(case:&mut Case,artifact:&str,target:&Path)->Result<Value> {
    destination(case,target)?;ensure!(target.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("pdf")),"Use a PDF destination");
    let (source,mime,path,metadata)=crate::processing::artifact(case,artifact)?;
    ensure!(mime=="application/pdf"&&metadata["redaction"]==true&&!case.source(&source)?.restricted,"Invalid or restricted derivative");
    let review:Value=serde_json::from_str(&case.meta(&format!("redaction_review:{artifact}"))?.context("Human page review is required")?)?;
    let hash=file_hash(&path)?;ensure!(review["sha256"]==hash,"Derivative changed since human review");
    let mut stage=tempfile::NamedTempFile::new_in(target.parent().context("Missing parent")?)?;
    std::io::copy(&mut fs::File::open(path)?,stage.as_file_mut())?;stage.as_file().sync_all()?;ensure!(file_hash(stage.path())?==hash,"Export integrity failure");stage.persist_noclobber(target)?;
    case.audit("redaction_exported",json!({"artifact":artifact,"sha256":hash,"review":review}))?;
    Ok(json!({"path":target,"sha256":hash,"included_original":false}))
}
