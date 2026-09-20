use crate::case::{file_hash, now, safe_relative, Case};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub fn backup(case: &mut Case, destination: &Path, password: &str) -> Result<()> {
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
    for s in &sources {
        case.verify_source(&s.id)?;
        files.push(json!({"path":format!("originals/{}",s.sha256),"sha256":s.sha256}));
    }
    let mut stmt = case
        .db
        .prepare("SELECT DISTINCT path,sha256 FROM artifacts")?;
    let artifacts: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    for (path, hash) in &artifacts {
        ensure!(safe_relative(Path::new(path)), "Unsafe artifact path");
        ensure!(
            file_hash(&case.root.join(path))? == *hash,
            "Artifact failed backup integrity check"
        );
        files.push(json!({"path":path,"sha256":hash}));
    }
    let manifest = serde_json::to_vec_pretty(
        &json!({"format":"local-evidence-desk","version":1,"created_at":now(),"files":files,"originals_included":true}),
    )?;
    let mut output = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
    {
        let encryptor = age::Encryptor::with_user_passphrase(password.to_owned().into());
        let writer = encryptor.wrap_output(output.as_file_mut())?;
        let mut archive = tar::Builder::new(writer);
        archive.append_path_with_name(&db_path, "case.sqlite3")?;
        for s in &sources {
            archive.append_path_with_name(
                case.source_path(&s.id)?,
                format!("originals/{}", s.sha256),
            )?;
        }
        for (path, _) in &artifacts {
            archive.append_path_with_name(case.root.join(path), path)?;
        }
        let mut header = tar::Header::new_gnu();
        header.set_size(manifest.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        archive.append_data(&mut header, "manifest.json", manifest.as_slice())?;
        archive.into_inner()?.finish()?;
    }
    output.as_file().sync_all()?;
    output.persist_noclobber(destination)?;
    case.audit(
        "encrypted_backup",
        json!({"sources":sources.len(),"manifest_sha256":crate::case::digest(&manifest)}),
    )?;
    Ok(())
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
        let artifact = name.strip_prefix("artifacts/").is_some_and(|s| {
            s.split_once('.').is_some_and(|(hash, ext)| {
                hash.len() == 64
                    && hash.chars().all(|c| c.is_ascii_hexdigit())
                    && ["json", "jpg", "mp4"].contains(&ext)
            })
        });
        let transcript = name.strip_prefix("working/transcripts/").is_some_and(|s| {
            s.len() <= 200
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                && [".txt", ".json", ".srt"].iter().any(|ext| s.ends_with(ext))
        });
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
