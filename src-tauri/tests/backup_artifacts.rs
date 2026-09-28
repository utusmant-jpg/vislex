//! VL-005 — backup/restore artifact format symmetry.
//!
//! Every artifact format publication can produce (json/jpg/mp4/pdf via the
//! versioned registry) plus published transcript files must round-trip through
//! encrypted backup and restore, with reviewed redaction PDFs specifically
//! covered. Adversarial archives (unknown formats, unsafe paths, tampered
//! hashes) must fail deliberately.

use evidence_desk::{backup, case::{self, Case}, exports, processing, transcription};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn sha256(bytes: &[u8]) -> String { case::digest(bytes) }

fn setup_case(dir: &Path) -> (Case, String) {
    let mut case = Case::create(&dir.join("case.ledcase"), "Artifact symmetry").unwrap();
    let evidence = dir.join("note.txt");
    fs::write(&evidence, "symmetry check\n").unwrap();
    case.import_files(&[evidence.to_string_lossy().into()], "A").unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    (case, source)
}

/// Register a synthetic artifact exactly the way processing publishes one:
/// content-addressed read-only-style file under artifacts/ plus a row in the
/// artifacts table. No worker is needed; backup/restore verification is real.
fn register_artifact(case: &mut Case, source_id: &str, mime: &str, bytes: &[u8], metadata: Value) -> String {
    let hash = sha256(bytes);
    let ext = evidence_desk::artifact_registry::extension_for_mime(mime).unwrap();
    let relative = format!("artifacts/{hash}.{ext}");
    let target = case.root.join(&relative);
    assert!(!target.exists(), "artifact path collision in test");
    fs::write(&target, bytes).unwrap();
    let id = case::id();
    case.db.execute(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![id, source_id, hash, mime, relative, metadata.to_string(), case::now()],
    ).unwrap();
    id
}

#[test]
fn every_artifact_format_and_transcripts_round_trip_through_backup() {
    let dir = tempfile::tempdir().unwrap();
    let (mut case, source) = setup_case(dir.path());
    let original_hash = case.source(&source).unwrap().sha256.clone();

    let json_artifact = register_artifact(&mut case, &source, "application/json", br#"{"units":[]}"#, json!({"kind":"extraction"}));
    let jpg_artifact = register_artifact(&mut case, &source, "image/jpeg", b"synthetic-jpeg-bytes", json!({"kind":"frame"}));
    let mp4_artifact = register_artifact(&mut case, &source, "video/mp4", b"synthetic-mp4-bytes", json!({"kind":"playback","player_origin_seconds":0}));
    // Reviewed redaction PDF: the exact case the old restore rejected.
    let pdf_bytes = b"synthetic-flattened-redaction-pdf";
    let pdf_artifact = register_artifact(&mut case, &source, "application/pdf", pdf_bytes, json!({"redaction":true,"page_count":2}));
    exports::review_redaction(&mut case, &pdf_artifact, &[1, 2], "Both pages reviewed").unwrap();

    let transcript_dir = case.root.join("working/transcripts");
    fs::create_dir_all(&transcript_dir).unwrap();
    let transcript_text = "[00:00.000] machine transcript text";
    fs::write(transcript_dir.join("recording-2026.txt"), transcript_text).unwrap();
    fs::write(transcript_dir.join("recording-2026.json"), br#"{"segments":[]}"#).unwrap();
    fs::write(transcript_dir.join("recording-2026.track-0.srt"), b"1\n00:00:00,000 --> 00:00:02,000\nline\n").unwrap();

    let archive = dir.path().join("symmetry.age");
    backup::backup(&mut case, &archive, "format-passphrase-1").unwrap();
    drop(case);

    let mut restored = backup::restore(&archive, &dir.path().join("restored.ledcase"), "format-passphrase-1").unwrap();

    // Originals hash-identical to the source case.
    assert_eq!(restored.source(&source).unwrap().sha256, original_hash);
    restored.verify_source(&source).unwrap();

    // Every registered artifact format restored with verified integrity.
    for artifact in [&json_artifact, &jpg_artifact, &mp4_artifact, &pdf_artifact] {
        let (owner, _mime, path, _metadata) = processing::artifact(&restored, artifact).unwrap();
        assert_eq!(owner, source);
        assert!(path.is_file());
    }

    // Transcript files restored byte-identical and listed in the verified manifest.
    assert_eq!(fs::read_to_string(restored.root.join("working/transcripts/recording-2026.txt")).unwrap(), transcript_text);
    assert!(restored.root.join("working/transcripts/recording-2026.json").is_file());
    assert!(restored.root.join("working/transcripts/recording-2026.track-0.srt").is_file());

    // The reviewed redaction derivative still exports from the restored case:
    // human review state and artifact hash survived together.
    let exported = dir.path().join("restored-redaction.pdf");
    let value = exports::export_redaction(&mut restored, &pdf_artifact, &exported).unwrap();
    assert_eq!(value["sha256"], sha256(pdf_bytes));
    assert_eq!(fs::read(&exported).unwrap(), pdf_bytes.to_vec());

    // A derivative whose bytes change after review must refuse export in the restored case too.
    let pdf_path = restored.root.join(format!("artifacts/{}.pdf", sha256(pdf_bytes)));
    let mut permissions = fs::metadata(&pdf_path).unwrap().permissions();
    permissions.set_readonly(false);
    fs::set_permissions(&pdf_path, permissions).unwrap();
    fs::write(&pdf_path, b"tampered-after-review").unwrap();
    assert!(exports::export_redaction(&mut restored, &pdf_artifact, &dir.path().join("blocked.pdf")).is_err());

    restored.verify_audit().unwrap();
}

/// Craft an encrypted backup archive with arbitrary entries for adversarial cases.
/// Headers are written as raw GNU blocks so archive-producer validation (which a
/// real attacker would not use) cannot blunt the test; VisLex's own restore-side
/// guards are what must fail these archives.
fn craft_archive(destination: &Path, password: &str, entries: &[(&str, &[u8])]) {
    let mut tar_bytes = Vec::new();
    for (name, data) in entries {
        let mut block = [0u8; 512];
        block[..name.len()].copy_from_slice(name.as_bytes());
        block[100..108].copy_from_slice(b"0000600\0");
        block[108..116].copy_from_slice(b"0000000\0");
        block[116..124].copy_from_slice(b"0000000\0");
        let size_field = format!("{:011o}\0", data.len());
        block[124..136].copy_from_slice(size_field.as_bytes());
        block[136..148].copy_from_slice(b"00000000000\0");
        block[156] = b'0';
        for slot in block[148..156].iter_mut() { *slot = b' '; }
        let checksum: u32 = block.iter().map(|b| *b as u32).sum();
        let checksum_field = format!("{:06o}\0 ", checksum);
        block[148..156].copy_from_slice(checksum_field.as_bytes());
        tar_bytes.extend_from_slice(&block);
        tar_bytes.extend_from_slice(data);
        let padding = (512 - data.len() % 512) % 512;
        tar_bytes.extend(std::iter::repeat(0u8).take(padding));
    }
    tar_bytes.extend_from_slice(&[0u8; 1024]);
    let mut output = fs::File::create(destination).unwrap();
    let encryptor = age::Encryptor::with_user_passphrase(password.to_owned().into());
    let mut writer = encryptor.wrap_output(&mut output).unwrap();
    std::io::Write::write_all(&mut writer, &tar_bytes).unwrap();
    writer.finish().unwrap();
}

fn manifest_for(files: &[(&str, String)]) -> Vec<u8> {
    let items: Vec<Value> = files.iter().map(|(path, hash)| json!({"path":path,"sha256":hash})).collect();
    serde_json::to_vec(&json!({"format":"local-evidence-desk","version":1,"created_at":"2026-09-21T00:00:00Z","files":items,"originals_included":true})).unwrap()
}

const PASSWORD: &str = "adversarial-pass-1";

fn restore_error(archive: &Path, dir: &tempfile::TempDir) -> String {
    match backup::restore(archive, &dir.path().join("out.ledcase"), PASSWORD) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("restore unexpectedly succeeded"),
    }
}

#[test]
fn unknown_artifact_formats_fail_deliberately() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("unknown.age");
    let hash = "a".repeat(64);
    let exe_name = format!("artifacts/{hash}.exe");
    let manifest = manifest_for(&[("case.sqlite3", sha256(b"placeholder"))]);
    let entries: Vec<(&str, &[u8])> = vec![
        ("case.sqlite3", b"placeholder"),
        ("manifest.json", &manifest),
        (&exe_name, b"not a registered format"),
    ];
    craft_archive(&archive, PASSWORD, &entries);
    let error = restore_error(&archive, &dir);
    assert!(error.contains("Unexpected file in backup"), "got: {error}");
}

#[test]
fn unsafe_archive_paths_fail() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("escape.age");
    let manifest = manifest_for(&[]);
    let entries: Vec<(&str, &[u8])> = vec![
        ("../evil.txt", b"escape attempt"),
        ("manifest.json", &manifest),
    ];
    craft_archive(&archive, PASSWORD, &entries);
    let error = restore_error(&archive, &dir);
    assert!(error.contains("Unsafe backup path"), "got: {error}");
    assert!(!dir.path().parent().unwrap().join("evil.txt").exists());
}

#[test]
fn tampered_hashes_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("tampered.age");
    let name = format!("originals/{}", "a".repeat(64));
    let claimed = "b".repeat(64); // never matches the entry content
    let manifest = manifest_for(&[
        ("case.sqlite3", sha256(b"placeholder")),
        (&name, claimed),
    ]);
    let entries: Vec<(&str, &[u8])> = vec![
        ("case.sqlite3", b"placeholder"),
        ("manifest.json", &manifest),
        (&name, b"claimed bytes do not match"),
    ];
    craft_archive(&archive, PASSWORD, &entries);
    let error = restore_error(&archive, &dir);
    assert!(error.contains("Backup hash mismatch"), "got: {error}");
}

/// R01 — a real publication, not hand-registered rows. `transcription::publish`
/// registers the TXT/JSON/SRT files in the artifacts table AND writes them under
/// working/transcripts; backup must archive each canonical path exactly once so
/// restore (exclusive create + unique manifest paths) still succeeds.
#[test]
fn registered_transcripts_publish_backup_restore_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    // Stand-in worker binary: publication records its real hash as provenance.
    let worker = dir.path().join("stand-in-worker.exe");
    fs::write(&worker, b"synthetic worker bytes").unwrap();
    std::env::set_var("VISLEX_WORKER_PATH", &worker);

    let mut case = Case::create(&dir.path().join("published.ledcase"), "Published transcript").unwrap();
    // Minimal detectable WAV so import classifies the source as audio.
    let recording = dir.path().join("interview.wav");
    let mut wav = b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00D\xac\x00\x00\x00\x00\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00".to_vec();
    wav.extend_from_slice(b"synthetic-audio-payload");
    fs::write(&recording, &wav).unwrap();
    case.import_files(&[recording.to_string_lossy().into()], "A").unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    assert_eq!(case.source(&source).unwrap().kind, "audio");

    // Real begin (job row, staging, provenance manifest) + real publish.
    let job = transcription::begin(&mut case, &source).unwrap();
    let value = json!({
        "version": 1,
        "status": "complete",
        "metadata": {},
        "limitations": [],
        "pages": [
            {"start": 0.0, "end": 1.5, "track": 0, "text": "machine transcript line one"},
            {"start": 1.5, "end": 3.0, "track": 1, "text": "second track segment"}
        ]
    });
    let published = transcription::publish(&mut case, &job, value).unwrap();
    let saved: Vec<String> = published["saved_files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    assert!(saved.iter().all(|p| p.starts_with("working/transcripts/")));
    assert_eq!(saved.len(), 4, "txt, json and one srt per track");

    // Every published path is registered in the artifacts table.
    for path in &saved {
        let registered: i64 = case.db.query_row(
            "SELECT count(*) FROM artifacts WHERE path=?",
            [path],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(registered, 1, "{path} must be registered exactly once");
    }

    let archive = dir.path().join("published.age");
    backup::backup(&mut case, &archive, "registered-pass-1").unwrap();
    drop(case);

    // Restore must succeed: one archive entry per canonical path, unique manifest.
    let restored_root = dir.path().join("restored-published.ledcase");
    let restored = backup::restore(&archive, &restored_root, "registered-pass-1").unwrap();

    for path in &saved {
        let absolute = restored.root.join(path);
        assert!(absolute.is_file(), "{path} missing after restore");
        let hash: String = restored.db.query_row(
            "SELECT sha256 FROM artifacts WHERE path=?",
            [path],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(hash, sha256(&fs::read(&absolute).unwrap()), "{path} hash drift");
    }
    // The transcript record and its machine-extraction revision survived.
    let record_id = published["record_id"].as_str().unwrap().to_string();
    assert!(restored.record(&record_id).is_ok());
    restored.verify_audit().unwrap();

    // Reopen the restored case; human review of the transcript record then
    // survives a second full backup -> restore cycle with hashes intact.
    drop(restored);
    let mut reopened = Case::open(&restored_root).unwrap();
    reopened.review_record(&record_id, 1, None).unwrap();
    assert_eq!(reopened.record(&record_id).unwrap().review, "human-reviewed");
    let second = dir.path().join("published-2.age");
    backup::backup(&mut reopened, &second, "registered-pass-2").unwrap();
    drop(reopened);
    let cycled = backup::restore(&second, &dir.path().join("cycled.ledcase"), "registered-pass-2").unwrap();
    assert_eq!(cycled.record(&record_id).unwrap().review, "human-reviewed");
    for path in &saved {
        let hash: String = cycled.db.query_row(
            "SELECT sha256 FROM artifacts WHERE path=?",
            [path],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(hash, sha256(&fs::read(cycled.root.join(path)).unwrap()), "{path} hash drift after cycle");
    }
    cycled.verify_audit().unwrap();

    // Wrong passphrase and a truncated archive must both fail closed.
    assert!(backup::restore(&archive, &dir.path().join("wrong-pass.ledcase"), "not-the-passphrase").is_err());
    let mut bytes = fs::read(&archive).unwrap();
    bytes.truncate(bytes.len() / 2);
    let truncated = dir.path().join("truncated.age");
    fs::write(&truncated, &bytes).unwrap();
    assert!(backup::restore(&truncated, &dir.path().join("truncated-out.ledcase"), "registered-pass-1").is_err());
}

/// R01 — two artifact rows claiming the same path with different hashes must
/// fail the backup before any archive is written, instead of producing a
/// self-contradictory manifest restore would refuse.
#[test]
fn conflicting_artifact_hashes_fail_backup_early() {
    let dir = tempfile::tempdir().unwrap();
    let (mut case, source) = setup_case(dir.path());
    let hash_a = sha256(b"conflicting-a");
    let hash_b = sha256(b"conflicting-b");
    let path = format!("artifacts/{hash_a}.json");
    fs::write(case.root.join(&path), b"conflicting-a").unwrap();
    case.db.execute(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![case::id(), source, hash_a, "application/json", path, "{}", case::now()],
    ).unwrap();
    // Second registration of the SAME path pinning a different hash.
    case.db.execute(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![case::id(), source, hash_b, "application/json", path, "{}", case::now()],
    ).unwrap();
    let archive = dir.path().join("conflict.age");
    let error = backup::backup(&mut case, &archive, "conflict-pass-123").unwrap_err();
    // Either failure order is correct fail-closed behavior: the registration
    // conflict fires for whichever row the unordered query returns second, and
    // the disk-integrity check covers the other order.
    assert!(
        error.to_string().contains("conflicting") || error.to_string().contains("integrity"),
        "got: {error}"
    );
    assert!(!archive.exists(), "no archive may be written on conflict");
}

/// R01 — a registered transcript modified on disk after registration must abort
/// the backup against the pinned database hash; the scan may never silently
/// re-pin the new bytes into the manifest.
#[test]
fn modified_registered_transcript_aborts_backup() {
    let dir = tempfile::tempdir().unwrap();
    let (mut case, source) = setup_case(dir.path());
    let bytes = b"[00:00.000] original machine text";
    let hash = sha256(bytes);
    let path = "working/transcripts/edited-after-registration.txt";
    fs::create_dir_all(case.root.join("working/transcripts")).unwrap();
    fs::write(case.root.join(path), bytes).unwrap();
    case.db.execute(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![case::id(), source, hash, "text/plain", path, json!({"kind":"full_audio"}).to_string(), case::now()],
    ).unwrap();
    fs::write(case.root.join(path), b"[00:00.000] silently changed text").unwrap();
    let archive = dir.path().join("modified.age");
    let error = backup::backup(&mut case, &archive, "modified-pass-123").unwrap_err();
    assert!(error.to_string().contains("integrity"), "got: {error}");
    assert!(!archive.exists(), "no archive may be written for drifted transcript");
}

/// R01 — crafted archives containing the same entry twice must fail closed;
/// restore never silently overwrites a restored file.
#[test]
fn duplicate_archive_entries_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("duplicate.age");
    let name = format!("originals/{}", "c".repeat(64));
    let content = b"duplicate entry bytes";
    let manifest = manifest_for(&[
        ("case.sqlite3", sha256(b"placeholder")),
        (&name, sha256(content)),
    ]);
    let entries: Vec<(&str, &[u8])> = vec![
        ("case.sqlite3", b"placeholder"),
        ("manifest.json", &manifest),
        (&name, content),
        (&name, content),
    ];
    craft_archive(&archive, PASSWORD, &entries);
    let error = restore_error(&archive, &dir);
    assert!(
        error.contains("Backup inventory mismatch") || error.contains("already exists") || error.contains("os error"),
        "got: {error}"
    );
}

/// R01 — a manifest claiming a newer artifact format version than this build's
/// registry must fail closed rather than restore unverifiable formats. The
/// version must be the exact registry integer; string/float forms of any other
/// value are rejected too.
#[test]
fn future_artifact_format_versions_fail_closed() {
    for bad in [json!(u32::MAX), json!("2"), json!(2.5), json!(-1)] {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("future.age");
        let mut manifest = manifest_for(&[("case.sqlite3", sha256(b"placeholder"))]);
        let mut value: Value = serde_json::from_slice(&manifest).unwrap();
        value["artifact_formats"] = bad.clone();
        manifest = serde_json::to_vec(&value).unwrap();
        let entries: Vec<(&str, &[u8])> = vec![
            ("case.sqlite3", b"placeholder"),
            ("manifest.json", &manifest),
        ];
        craft_archive(&archive, PASSWORD, &entries);
        let error = restore_error(&archive, &dir);
        assert!(
            error.contains("Unsupported artifact format"),
            "for {bad}: got {error}"
        );
    }
}

/// R01 — legacy manifests written before `artifact_formats` existed (treated as
/// version 1 by definition) must still restore against a real database payload.
#[test]
fn legacy_manifests_without_artifact_formats_still_restore() {
    let dir = tempfile::tempdir().unwrap();
    // A real, freshly created case database as the archive payload. Checkpoint
    // the WAL so the single file is a complete snapshot, exactly like the
    // staged copy the production backup path produces.
    let seed = Case::create(&dir.path().join("seed.ledcase"), "Legacy seed").unwrap();
    seed.db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    let db_bytes = fs::read(seed.root.join("case.sqlite3")).unwrap();
    drop(seed);

    let archive = dir.path().join("legacy.age");
    let manifest = manifest_for(&[("case.sqlite3", sha256(&db_bytes))]);
    let entries: Vec<(&str, &[u8])> = vec![
        ("case.sqlite3", &db_bytes),
        ("manifest.json", &manifest),
    ];
    craft_archive(&archive, PASSWORD, &entries);
    let restored = backup::restore(&archive, &dir.path().join("legacy-out.ledcase"), PASSWORD).unwrap();
    restored.verify_audit().unwrap();
}

/// A backup written at artifact-format version 1 restores after the registry
/// gained a format, but it cannot smuggle in a format newer than itself.
#[test]
fn version_one_backups_restore_under_a_newer_registry() {
    let dir = tempfile::tempdir().unwrap();
    let seed = Case::create(&dir.path().join("seed.ledcase"), "Version one seed").unwrap();
    seed.db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    let db_bytes = fs::read(seed.root.join("case.sqlite3")).unwrap();
    drop(seed);
    let versioned = |files: &[(&str, String)]| {
        let mut value: Value = serde_json::from_slice(&manifest_for(files)).unwrap();
        value["artifact_formats"] = json!(1);
        serde_json::to_vec(&value).unwrap()
    };
    let archive = dir.path().join("v1.age");
    let manifest = versioned(&[("case.sqlite3", sha256(&db_bytes))]);
    craft_archive(&archive, PASSWORD, &[("case.sqlite3", &db_bytes), ("manifest.json", &manifest)]);
    let restored = backup::restore(&archive, &dir.path().join("v1-out.ledcase"), PASSWORD).unwrap();
    restored.verify_audit().unwrap();
    drop(restored);

    let clip = b"RIFF synthetic clip".to_vec();
    let clip_name = format!("artifacts/{}.wav", sha256(&clip));
    let archive = dir.path().join("v1-with-wav.age");
    let manifest = versioned(&[("case.sqlite3", sha256(&db_bytes)), (&clip_name, sha256(&clip))]);
    craft_archive(&archive, PASSWORD, &[("case.sqlite3", &db_bytes), (&clip_name, &clip), ("manifest.json", &manifest)]);
    let error = restore_error(&archive, &dir);
    assert!(error.contains("newer than its manifest version"), "got: {error}");
}
