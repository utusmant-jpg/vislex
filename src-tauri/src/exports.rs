use crate::case::{Case,Record,file_hash,now};
use anyhow::{ensure,Context,Result};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},io::Write};

fn escaped(s:&str)->String {s.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;").replace('\'',"&#39;")}
fn destination(case:&Case,path:&Path)->Result<()> {
    ensure!(!path.exists(),"Choose a new export destination");
    ensure!(!path.parent().context("Missing destination parent")?.canonicalize()?.starts_with(&case.root),"Export outside the active case");Ok(())
}
pub struct DossierCopy {pub from:PathBuf,pub relative:String,pub source_id:String,pub name:String,pub artifact_id:Option<String>,
    /// Registered content hash these bytes must certify at publication: the
    /// source's sha256 for originals, the registered artifact hash otherwise.
    pub sha256:String}
/// Prepared under the case lock: every citation validated, restricted sources
/// rejected, and the report HTML resolved. Copying the cited originals then runs
/// without the lock so the case stays responsive during a large export.
pub struct DossierPlan {pub task:String,pub dossier_revision:u64,pub copies:Vec<DossierCopy>,pub html:String,pub view:Value,
    /// Identity (created_at) of each accepted human review receipt at
    /// preparation time; publication rechecks the SAME receipts, not merely
    /// that some accepted decision currently exists (R07).
    pub review_receipts:Vec<String>}
pub fn prepare_dossier_bundle(case:&mut Case,task:&str,path:&Path)->Result<DossierPlan> {
    destination(case,path)?;
    let view=crate::dossier::view(case,task)?;
    ensure!(view["stale"]==false && view["completion_stale"]==false,"Recheck changed evidence before exporting");
    let dossier=crate::dossier::load(case,task)?.context("No dossier")?;
    ensure!(!dossier.claims.is_empty(),"No reviewed findings to export");
    let mut review_receipts=Vec::new();
    for (i,_) in dossier.claims.iter().enumerate() {
        ensure!(view["human_reviews"][i]["decision"]=="accepted" && view["human_reviews"][i]["stale"]==false,"Every exported finding requires current human acceptance");
        review_receipts.push(view["human_reviews"][i]["receipt"].as_str().unwrap_or("").to_string());
    }
    let mut copies=Vec::new();let mut listed=std::collections::BTreeSet::new();let mut body=format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'\"><title>Reviewed investigation</title><style>body{{max-width:1000px;margin:40px auto;font:17px/1.6 system-ui}}article{{border-top:1px solid #bbb;padding:16px 0}}pre{{white-space:pre-wrap}}</style><h1>Reviewed investigation</h1><p>{}</p><p>This local package includes cited original files. It is not a redacted disclosure package. Human acceptance is recorded; unresolved limitations remain.</p>",escaped(&dossier.scope));
    for claim in &dossier.claims {
        body.push_str(&format!("<article><h2>{}</h2><p>{}</p><p>Uncertainty: {}</p><p>Next check: {}</p>",escaped(&claim.proposition),escaped(&claim.assessment),escaped(&claim.uncertainty),escaped(&claim.next_check)));
        for (label,citations) in [("Supporting",&claim.supporting),("Conflicting",&claim.contrary)] {
            body.push_str(&format!("<h3>{label}</h3><ul>"));
            for citation in citations {
                let valid=case.validate_citation(citation)?;let source=valid["source_id"].as_str().context("Missing source")?;
                ensure!(!case.source(source)?.restricted,"Restricted export dependency");
                let (from,relative,artifact_id,sha256)=if let Some((_,artifact))=citation.split_once("#artifact:") {
                    let (_,mime,file,registered,metadata)=crate::processing::artifact_descriptor(case,artifact)?;
                    let extension=crate::artifact_registry::extension_for_mime(&mime).context("Unregistered export artifact format")?;
                    let _=metadata;
                    (file,format!("evidence/{artifact}.{extension}"),Some(artifact.to_string()),registered)
                } else {(case.source_path(source)?,format!("evidence/{source}.bin"),None,case.source(source)?.sha256.clone())};
                if listed.insert(relative.clone()) {copies.push(DossierCopy{from,relative:relative.clone(),source_id:source.into(),name:case.source(source)?.name,artifact_id,sha256});}
                body.push_str(&format!("<li><a download href=\"{}\">{}</a></li>",escaped(&relative),escaped(citation)));
            }
            body.push_str("</ul>");
        }body.push_str("</article>");
    }
    body.push_str(&format!("<h2>Checks and limitations</h2><pre>{}</pre></html>",escaped(&serde_json::to_string_pretty(&json!({"checks":dossier.checks,"completion":view["completion"]}))?)));
    Ok(DossierPlan{task:task.into(),dossier_revision:dossier.revision,copies,html:body,view,review_receipts})
}
pub struct DossierStaging{_source_leases:Vec<fs::File>,copy_leases:Vec<fs::File>,pub directory:tempfile::TempDir,pub manifest:Value}
/// Copy cited originals and write the package contents without holding the case lock.
pub fn write_dossier_bundle(plan:&DossierPlan,path:&Path)->Result<DossierStaging> {
    let stage=tempfile::tempdir_in(path.parent().context("Missing parent")?)?;
    fs::create_dir(stage.path().join("evidence"))?;
    let mut files=std::collections::BTreeMap::new();
    let mut source_leases=Vec::new();let mut copy_leases=Vec::new();
    for copy in &plan.copies {
        source_leases.push(crate::processing::verified_lease(&copy.from,&copy.sha256).context("Source lease for dossier export")?);
        let target=stage.path().join(&copy.relative);let mut output=fs::File::create(&target)?;std::io::copy(&mut fs::File::open(&copy.from)?,&mut output)?;output.sync_all()?;drop(output);
        copy_leases.push(crate::processing::verified_lease_for_rename(&target,&copy.sha256).context("Staged copy lease for dossier export")?);
        files.insert(copy.relative.clone(),json!({"sha256":copy.sha256,"source_id":copy.source_id,"original_name":copy.name}));
    }
    fs::write(stage.path().join("index.html"),&plan.html)?;
    fs::write(stage.path().join("dossier.json"),serde_json::to_vec_pretty(&plan.view)?)?;
    files.insert("index.html".into(),json!({"sha256":crate::case::digest(plan.html.as_bytes())}));
    files.insert("dossier.json".into(),json!({"sha256":file_hash(&stage.path().join("dossier.json"))?}));
    let manifest=json!({"version":1,"task":plan.task,"dossier_revision":plan.dossier_revision,"exported_at":now(),"files":files,"redacted":false});
    fs::write(stage.path().join("manifest.json"),serde_json::to_vec_pretty(&manifest)?)?;
    for file in ["index.html","dossier.json","manifest.json"] {fs::OpenOptions::new().read(true).write(true).open(stage.path().join(file))?.sync_all()?;}
    Ok(DossierStaging{_source_leases:source_leases,copy_leases,directory:stage,manifest})
}
/// Re-check the exact reviewed snapshot the plan was prepared against, then
/// atomically publish and audit. An export prepared against one state must not
/// silently complete after evidence, dossier revision, review decisions,
/// currentness or restrictions changed.
pub fn publish_dossier_bundle(case:&mut Case,plan:&DossierPlan,staged:Result<DossierStaging>,path:&Path)->Result<Value> {
    let staged=staged?;
    let view=crate::dossier::view(case,&plan.task)?;
    ensure!(view["stale"]==false && view["completion_stale"]==false,"Evidence changed during export; recheck before publishing");
    let dossier=crate::dossier::load(case,&plan.task)?.context("No dossier")?;
    ensure!(dossier.revision==plan.dossier_revision,"Dossier changed during export; prepare the export again");
    for (i,receipt) in plan.review_receipts.iter().enumerate() {
        ensure!(view["human_reviews"][i]["decision"]=="accepted" && view["human_reviews"][i]["stale"]==false,"Finding review changed during export; every exported finding requires current human acceptance");
        ensure!(view["human_reviews"][i]["receipt"].as_str()==Some(receipt.as_str()),"Finding review was replaced during export; prepare the export again against the current review");
    }
    for copy in &plan.copies {
        ensure!(!case.source(&copy.source_id)?.restricted,"Source became restricted during export");
        if let Some(artifact)=&copy.artifact_id {
            let (source,_,path,hash,_)=crate::processing::artifact_descriptor(case,artifact)?;
            ensure!(source==copy.source_id && path==copy.from && hash==copy.sha256,"Export dependency changed");
        } else {
            ensure!(case.source(&copy.source_id)?.sha256==copy.sha256,"Export dependency changed");
        }
    }
    // Same-parent staging permits an atomic directory rename without replacing an existing package.
    ensure!(!path.exists(),"Destination appeared during export");
    let DossierStaging{_source_leases,copy_leases,directory,manifest}=staged;
    drop(copy_leases);
    fs::rename(directory.path(),path)?;
    case.audit("reviewed_dossier_exported",json!({"task":plan.task,"revision":plan.dossier_revision,"manifest_hash":crate::case::digest(&serde_json::to_vec(&manifest)?)}))?;
    Ok(json!({"path":path,"manifest":manifest}))
}
pub fn dossier_bundle(case:&mut Case,task:&str,path:&Path)->Result<Value> {
    let plan=prepare_dossier_bundle(case,task,path)?;
    publish_dossier_bundle(case,&plan,write_dossier_bundle(&plan,path),path)
}
pub struct DocumentExport {pub staging:tempfile::TempDir,pub record:Record,pub target:PathBuf,pub format:String,pub dependencies:Vec<(String,String,PathBuf)>}
pub fn prepare_document_at_revision(case:&Case,record:&str,expected_revision:Option<i64>,target:&Path)->Result<DocumentExport> {
    if let Some(expected)=expected_revision {ensure!(case.record(record)?.revision==expected,"Record changed since export was selected; refresh and try again");}
    prepare_document(case,record,target)
}
pub fn prepare_document_deferred_at_revision(case:&Case,record:&str,expected_revision:Option<i64>,target:&Path)->Result<DocumentExport> {
    if let Some(expected)=expected_revision {ensure!(case.record(record)?.revision==expected,"Record changed since export was selected; refresh and try again");}
    prepare_document_inner(case,record,target,false)
}
pub fn prepare_document(case:&Case,record:&str,target:&Path)->Result<DocumentExport> {
    prepare_document_inner(case,record,target,true)
}
fn prepare_document_inner(case:&Case,record:&str,target:&Path,verify_bytes:bool)->Result<DocumentExport> {
    destination(case,target)?;let record=case.record(record)?;
    // Pin the exact content hash of each restricted-checked dependency at
    // preparation time so publication can revalidate it.
    let mut dependencies=Vec::new();
    for source in &record.dependencies {ensure!(!case.source(source)?.restricted,"Restricted source dependency");if verify_bytes{case.verify_source_strong(source)?;}dependencies.push((source.clone(),case.source(source)?.sha256,case.source_path(source)?));}
    let format=target.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();ensure!(["docx","pdf"].contains(&format.as_str()),"Use .docx or .pdf");
    let staging=tempfile::tempdir_in(case.root.join("staging"))?;
    let request=json!({"version":1,"kind":"document_export","format":format,"title":record.title,"content":record.content,"status":format!("DRAFT — {} — revision {} — stale: {}. Not a sanitized disclosure package.",record.review,record.revision,record.stale)});
    fs::write(staging.path().join("request.json"),request.to_string())?;
    Ok(DocumentExport{staging,record,target:target.into(),format,dependencies})
}
pub fn run_document(job:&DocumentExport)->Result<()> {
    #[cfg(windows)]
    crate::sandbox::run_worker(&crate::processing::worker_path()?,job.staging.path(),std::time::Duration::from_secs(120))?;
    #[cfg(not(windows))]
    anyhow::bail!("Windows sandbox required");
    let output:Value=serde_json::from_slice(&fs::read(job.staging.path().join("result.json"))?)?;
    ensure!(output["status"]=="complete","{}",output["error"].as_str().unwrap_or("Export failed"));Ok(())
}
pub struct StagedDocument {file:tempfile::NamedTempFile,hash:String,_leases:Vec<fs::File>}
pub fn stage_document(job:&DocumentExport)->Result<StagedDocument> {
    let mut leases=Vec::new();
    for (_,hash,path) in &job.dependencies {leases.push(crate::processing::verified_lease(path,hash)?);}
    let output=job.staging.path().join(format!("document.{}",job.format));
    ensure!(output.metadata()?.len()<=32*1024*1024,"Export too large");
    let mut staged=tempfile::NamedTempFile::new_in(job.target.parent().context("Missing parent")?)?;
    std::io::copy(&mut fs::File::open(output)?,staged.as_file_mut())?;staged.flush()?;staged.as_file().sync_all()?;
    let hash=file_hash(staged.path())?;
    Ok(StagedDocument{file:staged,hash,_leases:leases})
}
pub fn publish_staged_document(case:&mut Case,job:&DocumentExport,staged:StagedDocument)->Result<Value> {
    destination(case,&job.target)?;
    let current=case.record(&job.record.id)?;
    ensure!(current.revision==job.record.revision && current.stale==job.record.stale && current.review==job.record.review,"Draft or review status changed during export");
    for (source,pinned,_) in &job.dependencies {ensure!(!case.source(source)?.restricted,"Source became restricted");ensure!(case.source(source)?.sha256==*pinned,"Source dependency changed during export");}
    staged.file.persist_noclobber(&job.target)?;
    case.audit("document_draft_exported",json!({"record":job.record.id,"revision":job.record.revision,"sha256":staged.hash}))?;
    Ok(json!({"path":job.target,"sha256":staged.hash}))
}
pub fn publish_document(case:&mut Case,job:&DocumentExport)->Result<Value> {
    destination(case,&job.target)?;let current=case.record(&job.record.id)?;ensure!(current.revision==job.record.revision && current.stale==job.record.stale && current.review==job.record.review,"Draft or review status changed during export");
    for (source,pinned,_) in &job.dependencies {ensure!(!case.source(source)?.restricted,"Source became restricted");ensure!(case.source(source)?.sha256==*pinned,"Source dependency changed during export");case.verify_source_strong(source)?;}
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
pub struct RedactionExportPlan {artifact:String,source:String,from:PathBuf,hash:String,review:Value,target:PathBuf}
pub struct StagedRedactionExport {file:tempfile::NamedTempFile,_source_lease:fs::File}
pub fn prepare_redaction_export(case:&Case,artifact:&str,target:&Path)->Result<RedactionExportPlan> {
    destination(case,target)?;ensure!(target.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("pdf")),"Use a PDF destination");
    let (source,mime,from,hash,metadata)=crate::processing::artifact_descriptor(case,artifact)?;
    ensure!(mime=="application/pdf"&&metadata["redaction"]==true&&!case.source(&source)?.restricted,"Invalid or restricted derivative");
    let review:Value=serde_json::from_str(&case.meta(&format!("redaction_review:{artifact}"))?.context("Human page review is required")?)?;
    ensure!(review["sha256"]==hash && review["artifact_id"]==artifact,"Derivative changed since human review");
    Ok(RedactionExportPlan{artifact:artifact.into(),source,from,hash,review,target:target.into()})
}
pub fn stage_redaction_export(plan:&RedactionExportPlan)->Result<StagedRedactionExport> {
    let source_lease=crate::processing::verified_lease(&plan.from,&plan.hash)?;
    let mut file=tempfile::NamedTempFile::new_in(plan.target.parent().context("Missing parent")?)?;
    std::io::copy(&mut fs::File::open(&plan.from)?,file.as_file_mut())?;file.as_file().sync_all()?;
    ensure!(file_hash(file.path())?==plan.hash,"Export integrity failure");
    Ok(StagedRedactionExport{file,_source_lease:source_lease})
}
pub fn publish_staged_redaction_export(case:&mut Case,plan:&RedactionExportPlan,staged:StagedRedactionExport)->Result<Value> {
    destination(case,&plan.target)?;
    let (source,mime,from,hash,metadata)=crate::processing::artifact_descriptor(case,&plan.artifact)?;
    ensure!(source==plan.source&&from==plan.from&&hash==plan.hash&&mime=="application/pdf"&&metadata["redaction"]==true&&!case.source(&source)?.restricted,"Redaction dependency changed during export");
    let review:Value=serde_json::from_str(&case.meta(&format!("redaction_review:{}",plan.artifact))?.context("Human page review is required")?)?;
    ensure!(review==plan.review,"Human review changed during export");
    staged.file.persist_noclobber(&plan.target)?;
    case.audit("redaction_exported",json!({"artifact":plan.artifact,"sha256":plan.hash,"review":review}))?;
    Ok(json!({"path":plan.target,"sha256":plan.hash,"included_original":false}))
}
#[cfg(test)]
mod staging_tests {
    use super::*;
    #[test]
    fn staged_document_rechecks_revision_before_atomic_export() {
        let dir=tempfile::tempdir().unwrap();
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic export").unwrap();
        let record=case.write_record(None,0,"Notes","note","first","human","unreviewed",None,vec![]).unwrap();
        let target=dir.path().join("notes.pdf");
        let job=prepare_document_at_revision(&case,&record.id,Some(record.revision),&target).unwrap();
        fs::write(job.staging.path().join("document.pdf"),b"synthetic PDF export").unwrap();
        let staged=stage_document(&job).unwrap();
        case.write_record(Some(&record.id),record.revision,"Notes","note","changed","human","unreviewed",None,vec![]).unwrap();
        assert!(publish_staged_document(&mut case,&job,staged).is_err());
        assert!(!target.exists());
    }
    #[test]
    fn staged_redaction_export_rechecks_human_review() {
        let dir=tempfile::tempdir().unwrap();
        let input=Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic redaction export").unwrap();
        case.import_files(&[input.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let source=case.sources().unwrap().into_iter().next().unwrap();
        let artifact=crate::case::id();let bytes=b"synthetic flattened PDF";let hash=crate::case::digest(bytes);
        let relative=format!("artifacts/{hash}.pdf");fs::write(case.root.join(&relative),bytes).unwrap();
        case.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",rusqlite::params![artifact,source.id,hash,"application/pdf",relative,json!({"redaction":true,"page_count":1}).to_string(),now()]).unwrap();
        review_redaction(&mut case,&artifact,&[1],"Reviewed").unwrap();
        let target=dir.path().join("released.pdf");let plan=prepare_redaction_export(&case,&artifact,&target).unwrap();
        let staged=stage_redaction_export(&plan).unwrap();
        case.set_meta(&format!("redaction_review:{artifact}"),"{}").unwrap();
        assert!(publish_staged_redaction_export(&mut case,&plan,staged).is_err());assert!(!target.exists());
    }
}
