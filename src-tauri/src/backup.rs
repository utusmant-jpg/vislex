use crate::case::{file_hash, file_hash_strong, now, safe_relative, Case};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Prepared under the case lock: a consistent snapshot of the database plus the
/// immutable originals and artifacts it references. Archive writing can then run
/// without the lock so the app stays responsive during a large backup.
pub struct BackupPlan {
    #[allow(dead_code)] // held so the staged database copy outlives archive writing
    staging: tempfile::TempDir,
    manifest: Vec<u8>,
    db_path: PathBuf,
    originals: Vec<(PathBuf, String, String)>,
    /// Registered artifacts, including published transcript files registered by
    /// `transcription::publish`. Each canonical path appears once.
    artifacts: Vec<(PathBuf, String, String)>,
    /// `working/transcripts` files present on disk but not registered in the
    /// artifacts table (recovery/unpublished data). Kept in the archive so no
    /// case bytes are lost, but labeled so they are never mistaken for
    /// registered evidence; the database remains the trust anchor.
    transcripts: Vec<(PathBuf, String)>,
    sources: usize,
    leases:Vec<File>,
}
/// Transcript publication names accepted in backup archives. Shared by prepare
/// and restore so the archive inventory is symmetric.
fn valid_transcript_entry(name: &str) -> bool {
    name.strip_prefix("working/transcripts/").is_some_and(|s| {
        s.len() <= 200
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            && [".txt", ".json", ".srt"].iter().any(|ext| s.ends_with(ext))
    })
}
pub fn prepare_backup(case: &mut Case, destination: &Path, password: &str) -> Result<BackupPlan> {
    prepare_backup_inner(case,destination,password,true)
}
pub fn prepare_backup_deferred(case:&mut Case,destination:&Path,password:&str)->Result<BackupPlan> {
    prepare_backup_inner(case,destination,password,false)
}
fn prepare_backup_inner(case: &mut Case, destination: &Path, password: &str,verify_bytes:bool) -> Result<BackupPlan> {
    ensure!(
        password.chars().count() >= 12,
        "Use a backup passphrase with at least 12 characters"
    );
    ensure!(!destination.exists(), "Choose a new backup filename");
    ensure!(
        !destination
            .parent()
            .context("Missing backup folder")?
            .canonicalize()?
            .starts_with(&case.root),
        "Store backups outside the active case"
    );
    let running: i64 = case.db.query_row(
        "SELECT (SELECT count(*) FROM tasks WHERE status='running')+(SELECT count(*) FROM processing_jobs WHERE status='running')",
        [],
        |r| r.get(0),
    )?;
    ensure!(
        running == 0,
        "Stop active investigations and processing before backing up"
    );
    let temp = tempfile::tempdir_in(case.root.join("staging"))?;
    let db_path = temp.path().join("case.sqlite3");
    case.db
        .backup(rusqlite::DatabaseName::Main, &db_path, None)?;
    let mut files = vec![json!({"path":"case.sqlite3","sha256":file_hash(&db_path)?})];
    let sources = case.sources()?;
    let mut originals = Vec::new();
    for s in &sources {
        if verify_bytes{case.verify_source_strong(&s.id)?;}
        files.push(json!({"path":format!("originals/{}",s.sha256),"sha256":s.sha256}));
        originals.push((case.source_path(&s.id)?, format!("originals/{}", s.sha256),s.sha256.clone()));
    }
    let mut stmt = case
        .db
        .prepare("SELECT DISTINCT path,sha256 FROM artifacts")?;
    let artifacts: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    // One canonical entry per normalized relative path, with the hash pinned to
    // the registered value. Registered transcripts are already covered here;
    // the directory scan below must never add a second copy of the same path.
    let mut canonical: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut artifact_entries = Vec::new();
    for (path, hash) in &artifacts {
        ensure!(safe_relative(Path::new(path)), "Unsafe artifact path");
        ensure!(
            path != "case.sqlite3"
                && path != "manifest.json"
                && !path.starts_with("originals/"),
            "Artifact registration claims a reserved archive path: {path}"
        );
        ensure!(
            canonical
                .insert(path.clone(), hash.clone())
                .is_none_or(|existing| existing == *hash),
            "Artifact registration has conflicting hashes for {path}"
        );
        let absolute = case.root.join(path);
        if verify_bytes{ensure!(file_hash_strong(&absolute)? == *hash,"Artifact failed backup integrity check");}
        files.push(json!({"path":path,"sha256":hash}));
        artifact_entries.push((absolute, path.clone(),hash.clone()));
    }
    // Unregistered transcript files are recovery data, not trusted evidence:
    // included and hash-pinned so no case bytes are lost, labeled as
    // unregistered in the manifest, and never treated as a second copy of a
    // registered path.
    let mut transcripts = Vec::new();
    let transcript_dir = case.root.join("working/transcripts");
    if transcript_dir.is_dir() {
        let mut scanned: Vec<(String, std::path::PathBuf)> = Vec::new();
        for entry in fs::read_dir(&transcript_dir)? {
            let entry = entry?;
            if !entry.metadata()?.is_file() {
                continue;
            }
            let relative = format!("working/transcripts/{}", entry.file_name().to_string_lossy());
            ensure!(
                valid_transcript_entry(&relative),
                "Unexpected file in working/transcripts: {}",
                entry.file_name().to_string_lossy()
            );
            scanned.push((relative, entry.path()));
        }
        scanned.sort();
        for (relative, absolute) in scanned {
            if canonical.contains_key(&relative) {
                continue; // registered transcript already archived once above
            }
            let hash = file_hash(&absolute)?;
            canonical.insert(relative.clone(), hash.clone());
            files.push(json!({"path":&relative,"sha256":hash,"origin":"unregistered-recovery"}));
            transcripts.push((absolute, relative));
        }
    }
    let manifest = serde_json::to_vec_pretty(
        &json!({"format":"local-evidence-desk","version":1,"artifact_formats":crate::artifact_registry::ARTIFACT_FORMAT_VERSION,"created_at":now(),"files":files,"originals_included":true}),
    )?;
    Ok(BackupPlan{staging: temp, manifest, db_path, originals, artifacts: artifact_entries, transcripts, sources: sources.len(),leases:Vec::new()})
}
pub fn verify_backup_plan(plan:&mut BackupPlan)->Result<()> {
    for (path,_,hash) in plan.originals.iter().chain(&plan.artifacts) {
        plan.leases.push(crate::processing::verified_lease(path,hash)?);
    }
    Ok(())
}
/// Encrypt and write the archive without holding the case lock.
pub fn write_archive(plan: &BackupPlan, destination: &Path, password: &str) -> Result<()> {
    let mut output = tempfile::NamedTempFile::new_in(destination.parent().context("Missing backup folder")?)?;
    {
        let encryptor = age::Encryptor::with_user_passphrase(password.to_owned().into());
        let writer = encryptor.wrap_output(output.as_file_mut())?;
        let mut archive = tar::Builder::new(writer);
        archive.append_path_with_name(&plan.db_path, "case.sqlite3")?;
        for (absolute, name, _) in &plan.originals {
            archive.append_path_with_name(absolute, name)?;
        }
        for (absolute, name, _) in &plan.artifacts {
            archive.append_path_with_name(absolute, name)?;
        }
        for (absolute, name) in &plan.transcripts {
            archive.append_path_with_name(absolute, name)?;
        }
        let mut header = tar::Header::new_gnu();
        header.set_size(plan.manifest.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        archive.append_data(&mut header, "manifest.json", plan.manifest.as_slice())?;
        archive.into_inner()?.finish()?;
    }
    output.as_file().sync_all()?;
    output.persist_noclobber(destination)?;
    Ok(())
}
/// Record the completed backup in the case audit log under the case lock.
pub fn finish_backup(case: &mut Case, plan: &BackupPlan) -> Result<Value> {
    case.audit(
        "encrypted_backup",
        json!({"sources":plan.sources,"manifest_sha256":crate::case::digest(&plan.manifest)}),
    )?;
    Ok(json!({"saved":true}))
}
pub fn backup(case: &mut Case, destination: &Path, password: &str) -> Result<()> {
    let plan = prepare_backup(case, destination, password)?;
    write_archive(&plan, destination, password)?;
    finish_backup(case, &plan)?;
    Ok(())
}
#[cfg(test)]
mod deferred_tests {
    use super::*;
    #[test]
    fn deferred_backup_verifies_original_before_archive() {
        let dir=tempfile::tempdir().unwrap();
        let source=dir.path().join("source.txt");fs::write(&source,b"original evidence").unwrap();
        let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic backup").unwrap();
        case.import_files(&[source.to_string_lossy().into()],"Synthetic fixture").unwrap();
        let destination=dir.path().join("case.age");
        let mut plan=prepare_backup_deferred(&mut case,&destination,"synthetic passphrase").unwrap();
        let original=case.sources().unwrap().into_iter().next().unwrap();
        let path=case.source_path(&original.id).unwrap();
        let mut permissions=fs::metadata(&path).unwrap().permissions();permissions.set_readonly(false);fs::set_permissions(&path,permissions).unwrap();
        fs::write(path,b"tampered evidence").unwrap();
        assert!(verify_backup_plan(&mut plan).is_err());
        assert!(!destination.exists());
    }
}

pub fn restore(archive_path: &Path, destination: &Path, password: &str) -> Result<Case> {
    crate::case::validate_local_root(destination)?;
    ensure!(
        !destination.exists(),
        "Restore into a new, nonexistent folder"
    );
    let parent = destination.parent().context("Missing destination parent")?;
    ensure!(parent.is_dir(), "Destination parent does not exist");
    let staging = tempfile::tempdir_in(parent)?;
    let decryptor = age::Decryptor::new(File::open(archive_path)?)?;
    let identity = age::scrypt::Identity::new(password.to_owned().into());
    let reader = decryptor.decrypt(std::iter::once(&identity as &dyn age::Identity))?;
    let mut tar = tar::Archive::new(reader);
    let mut total = 0u64;
    let mut count = 0;
    for entry in tar.entries()? {
        let mut entry = entry?;
        count += 1;
        ensure!(count <= 500_005, "Backup contains too many files");
        ensure!(
            entry.header().entry_type().is_file(),
            "Backup contains a non-regular file"
        );
        let path = entry.path()?.into_owned();
        ensure!(safe_relative(&path), "Unsafe backup path");
        let name = path.to_string_lossy();
        let original = name
            .strip_prefix("originals/")
            .is_some_and(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
        // Artifact entries are validated against the versioned registry shared
        // with publication; unknown formats fail deliberately.
        let artifact = crate::artifact_registry::parse_artifact_file(&name).is_some();
        let transcript = valid_transcript_entry(&name);
        ensure!(
            name == "case.sqlite3" || name == "manifest.json" || original || artifact || transcript,
            "Unexpected file in backup"
        );
        total = total
            .checked_add(entry.size())
            .context("Backup size overflow")?;
        ensure!(
            total <= 2_000_000_000_000,
            "Backup exceeds the 2 TB restoration limit"
        );
        let output = staging.path().join(path);
        fs::create_dir_all(output.parent().unwrap())?;
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        std::io::copy(&mut entry, &mut f)?;
        f.flush()?;
    }
    // Consume to EOF so age authenticates the complete encrypted stream, including trailing data.
    let mut reader = tar.into_inner();
    let mut tail = [0u8; 8192];
    let mut trailing = 0u64;
    loop {
        let n = reader.read(&mut tail)?;
        if n == 0 {
            break;
        }
        trailing += n as u64;
        ensure!(trailing < 1024 * 1024, "Unexpected trailing archive data");
    }
    let manifest_path = staging.path().join("manifest.json");
    ensure!(
        manifest_path.metadata()?.len() < 32 * 1024 * 1024,
        "Manifest too large"
    );
    let manifest: Value = serde_json::from_reader(File::open(&manifest_path)?)?;
    ensure!(
        manifest["format"] == "local-evidence-desk" && manifest["version"] == 1,
        "Unsupported backup format"
    );
    // A manifest from a newer build may contain artifact formats this registry
    // cannot validate; restoring it unverifiable would fail open. The field must
    // be the exact integer version when present in any form; older manifests
    // without the field are version 1 by definition.
    if !manifest["artifact_formats"].is_null() {
        let version = manifest["artifact_formats"].as_u64();
        ensure!(
            version == Some(u64::from(crate::artifact_registry::ARTIFACT_FORMAT_VERSION)),
            "Unsupported artifact format version"
        );
    }
    let files = manifest["files"]
        .as_array()
        .context("Missing manifest files")?;
    ensure!(files.len() + 1 == count, "Backup inventory mismatch");
    let mut seen = std::collections::HashSet::new();
    for item in files {
        let path = item["path"].as_str().context("Missing manifest path")?;
        ensure!(
            safe_relative(Path::new(path)) && seen.insert(path),
            "Invalid manifest path"
        );
        ensure!(
            file_hash(&staging.path().join(path))? == item["sha256"].as_str().unwrap_or(""),
            "Backup hash mismatch"
        );
    }
    {
        let restored = Case::open(staging.path())?;
        for s in restored.sources()? {
            let path = restored.verify_source(&s.id)?;
            let mut permissions = fs::metadata(&path)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(path, permissions)?;
        }
        restored.verify_audit()?;
    }
    fs::rename(staging.path(), destination)?;
    let mut case = Case::open(destination)?;
    case.audit(
        "case_restored",
        json!({"created_at":manifest["created_at"]}),
    )?;
    Ok(case)
}
