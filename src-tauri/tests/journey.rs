//! VL-001 — the protected end-to-end journey as a repeatable integration gate.
//!
//! import → process → search → open exact original evidence (citation) →
//! source-linked finding → human review → pinned export → encrypted backup →
//! restore → reopen, with original hashes, restrictions, review state and the
//! audit chain verified across the whole loop.
//!
//! Worker-bound media processing (sandbox suite) is intentionally out of scope
//! here: this gate exercises the real import/extraction/search/record/export/
//! backup paths that do not require the packaged worker.

use evidence_desk::{backup, case::{Case, Settings}};
use serde_json::json;
use std::fs;

fn journey_dir(tag: &str) -> tempfile::TempDir {
    let parent = std::env::temp_dir().join(format!("vislex-journey-{tag}"));
    fs::create_dir_all(&parent).unwrap();
    tempfile::tempdir_in(parent).unwrap()
}

/// The complete protected journey over synthetic evidence. Every later backend
/// ticket must keep this green; failures here block integration.
#[test]
fn protected_journey_survives_backup_restore_and_reopen() {
    let dir = journey_dir("main");

    // IMPORT — two synthetic sources through the real staging/hash/publish path.
    let root = dir.path().join("matter.ledcase");
    let mut case = Case::create(&root, "Protected journey").unwrap();
    let witness = dir.path().join("witness-statement.txt");
    fs::write(&witness, "A witness reported a blue bag near the counter.\nThe clock is uncertain.\nA second mention of the blue bag appears here.\n").unwrap();
    let invoice = dir.path().join("invoice.txt");
    fs::write(&invoice, "Private medical invoice — restricted production.\n").unwrap();
    let receipt = case.import_files(
        &[witness.to_string_lossy().into(), invoice.to_string_lossy().into()],
        "Production A",
    ).unwrap();
    assert_eq!(receipt["items"][0]["status"], "imported");
    assert_eq!(receipt["items"][1]["status"], "imported");
    let sources = case.sources().unwrap();
    assert_eq!(sources.len(), 2);
    let witness_id = sources.iter().find(|s| s.name == "witness-statement.txt").unwrap().id.clone();
    let invoice_id = sources.iter().find(|s| s.name == "invoice.txt").unwrap().id.clone();
    let witness_hash = case.source(&witness_id).unwrap().sha256.clone();

    // PROCESS — native text extraction and FTS indexing happen during import.
    assert_eq!(case.source(&witness_id).unwrap().status, "text indexed");

    // SEARCH — exact lexical hit with the source locator the citation will use.
    let found = case.search("blue", 0).unwrap();
    let hits = found["results"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "indexed extraction must be searchable");
    assert_eq!(hits[0]["source_id"], witness_id);

    // OPEN EXACT ORIGINAL EVIDENCE — cite exact line bounds; both ends verified.
    let lines = case.read_text(&witness_id, 1, 3).unwrap();
    assert_eq!(lines["total_lines"], 3);
    case.validate_citation(&format!("evidence:{witness_id}#L1-L2")).unwrap();

    // SOURCE-LINKED FINDING — a record depending on the cited source only.
    let finding = case.write_record(
        None,
        0,
        "Blue bag observation",
        "claim",
        &format!("The witness reported a blue bag. evidence:{witness_id}#L1-L2"),
        "human",
        "initial finding",
        None,
        vec![witness_id.clone()],
    ).unwrap();

    // REVIEW — human acceptance of that exact revision.
    case.review_record(&finding.id, 1, None).unwrap();
    assert_eq!(case.record(&finding.id).unwrap().review, "human-reviewed");

    // RESTRICTION — a later restriction must survive the whole loop.
    case.set_restricted(&invoice_id, true).unwrap();
    assert!(case.source(&invoice_id).unwrap().restricted);

    // PINNED EXPORT — reviewed record export outside the case, audited.
    let export_path = dir.path().join("finding.md");
    case.export_record(&finding.id, &export_path).unwrap();
    let exported = fs::read_to_string(&export_path).unwrap();
    assert!(exported.contains("blue bag"));
    assert!(exported.contains(&format!("evidence:{witness_id}#L1-L2")));

    // A record depending on restricted evidence must not export.
    let restricted_note = case.write_record(
        None,
        0,
        "Restricted analysis",
        "note",
        "depends on restricted invoice",
        "human",
        "test",
        None,
        vec![invoice_id.clone()],
    ).unwrap();
    assert!(case.export_record(&restricted_note.id, &dir.path().join("blocked.md")).is_err());

    // ENCRYPTED BACKUP — archive outside the case; plaintext must not appear.
    let archive = dir.path().join("matter.age");
    backup::backup(&mut case, &archive, "journey-passphrase-123").unwrap();
    let raw = fs::read(&archive).unwrap();
    assert!(!raw.is_empty());
    assert!(!String::from_utf8_lossy(&raw).contains("blue bag"));
    assert!(!String::from_utf8_lossy(&raw).contains("Protected journey"));

    // RESTORE + REOPEN — new folder, correct passphrase.
    let restored_root = dir.path().join("restored.ledcase");
    let mut restored = backup::restore(&archive, &restored_root, "journey-passphrase-123").unwrap();

    // Original hashes remain identical.
    assert_eq!(restored.source(&witness_id).unwrap().sha256, witness_hash);
    restored.verify_source(&witness_id).unwrap();
    restored.verify_source(&invoice_id).unwrap();

    // Restrictions remain intact after restore.
    assert!(restored.source(&invoice_id).unwrap().restricted);
    assert!(!restored.source(&witness_id).unwrap().restricted);

    // Review state and revisions survive; historical citations still resolve.
    let restored_finding = restored.record(&finding.id).unwrap();
    assert_eq!(restored_finding.review, "human-reviewed");
    assert_eq!(restored_finding.revision, 1);
    restored.validate_citation(&format!("evidence:{witness_id}#L1-L2")).unwrap();
    let restored_search = restored.search("blue", 0).unwrap();
    assert_eq!(restored_search["results"].as_array().unwrap().len(), 1);

    // Restricted dependency still blocks export from the restored case.
    assert!(restored.export_record(&restricted_note.id, &dir.path().join("blocked2.md")).is_err());

    // Audit chain verifies end to end.
    restored.verify_audit().unwrap();

    // REOPEN — close and open the restored case again.
    let reopened_root = restored_root.clone();
    drop(restored);
    let mut reopened = Case::open(&reopened_root).unwrap();
    assert_eq!(reopened.source(&witness_id).unwrap().sha256, witness_hash);
    assert!(reopened.source(&invoice_id).unwrap().restricted);
    reopened.verify_audit().unwrap();
    reopened.audit("journey_complete", json!({"gate":"VL-001"})).unwrap();
    drop(reopened);
    drop(case);
}

/// Tampered archives must fail closed with a hash mismatch, never restore silently.
#[test]
fn protected_journey_rejects_tampered_archive() {
    let dir = journey_dir("tamper");
    let root = dir.path().join("case.ledcase");
    let mut case = Case::create(&root, "Tamper check").unwrap();
    let evidence = dir.path().join("note.txt");
    fs::write(&evidence, "verifiable content\n").unwrap();
    case.import_files(&[evidence.to_string_lossy().into()], "A").unwrap();

    let archive = dir.path().join("tamper.age");
    backup::backup(&mut case, &archive, "tamper-passphrase-9").unwrap();
    drop(case);

    // Flip one byte inside the encrypted stream: decryption must fail closed.
    let mut bytes = fs::read(&archive).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    fs::write(&archive, &bytes).unwrap();
    assert!(backup::restore(&archive, &dir.path().join("out.ledcase"), "tamper-passphrase-9").is_err());
}

/// Restore requires a new folder; reopening the same location is refused.
#[test]
fn protected_journey_restore_requires_new_folder() {
    let dir = journey_dir("refuse");
    let root = dir.path().join("case.ledcase");
    let mut case = Case::create(&root, "Refuse check").unwrap();
    let evidence = dir.path().join("note.txt");
    fs::write(&evidence, "content\n").unwrap();
    case.import_files(&[evidence.to_string_lossy().into()], "A").unwrap();
    let archive = dir.path().join("refuse.age");
    backup::backup(&mut case, &archive, "refuse-passphrase-9").unwrap();
    assert!(backup::restore(&archive, &root, "refuse-passphrase-9").is_err());
}

/// An offline case that grants no AI permissions keeps them after reopen even
/// when a case-level settings save happens in between (durable per-case policy;
/// full enforcement of app-default separation is VL-002).
#[test]
fn protected_journey_preserves_case_policy_shape() {
    let dir = journey_dir("policy");
    let root = dir.path().join("case.ledcase");
    let mut case = Case::create(&root, "Policy shape").unwrap();
    let evidence = dir.path().join("note.txt");
    fs::write(&evidence, "content\n").unwrap();
    case.import_files(&[evidence.to_string_lossy().into()], "A").unwrap();
    let saved = Settings::default();
    assert!(saved.offline && !saved.allow_text && !saved.allow_images);
    case.save_settings(saved).unwrap();
    let root2 = root.clone();
    drop(case);
    let reopened = Case::open(&root2).unwrap();
    let settings = reopened.settings().unwrap();
    assert!(settings.offline, "reopened case must keep its own offline policy");
    assert!(!settings.allow_text);
    assert!(!settings.allow_images);
}
