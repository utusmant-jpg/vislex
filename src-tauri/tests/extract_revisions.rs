//! VL-010 — extraction/full-transcript revision consistency.
//!
//! A completed full transcript must become the active searchable text even when
//! an older partial extraction exists; every extraction is an immutable
//! revision; historical wording stays retrievable; later partials cannot
//! clobber the active full text; active-revision changes propagate staleness.

use evidence_desk::case::Case;
use std::fs;

fn setup_media_case() -> (tempfile::TempDir, Case, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("media.ledcase"), "Revision case").unwrap();
    // A synthetic WAV so the source is genuinely audio-kind.
    let mut wav: Vec<u8> = Vec::new();
    wav.extend_from_slice(b"RIFF");wav.extend_from_slice(&36u32.to_le_bytes());wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");wav.extend_from_slice(&16u32.to_le_bytes());wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());wav.extend_from_slice(&16000u32.to_le_bytes());wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");wav.extend_from_slice(&0u32.to_le_bytes());
    let path = dir.path().join("interview.wav");
    fs::write(&path, &wav).unwrap();
    case.import_files(&[path.to_string_lossy().into()], "A").unwrap();
    let sid = case.sources().unwrap()[0].id.clone();
    (dir, case, sid)
}

#[test]
fn full_transcript_supersedes_partial_and_keeps_history_retrievable() {
    let (_dir, mut case, sid) = setup_media_case();

    // Partial interval transcription arrives first and becomes searchable.
    case.publish_extract(&sid, "[00:00.5] partial machine text", "Sandboxed audio; see processing limitations", true).unwrap();
    let active = case.read_text(&sid, 1, 5).unwrap();
    assert_eq!(active["revision"], 1);
    assert!(active["text"].as_str().unwrap().contains("partial machine text"));
    assert_eq!(case.search("partial", 0).unwrap()["results"].as_array().unwrap().len(), 1);

    // THE VL-010 DEFECT: the completed full transcript must supersede the
    // partial, becoming the active searchable text.
    let full_text = "[00:00.0] full transcript first line\n[00:12.3] the blue bag appears twice\n[00:40.0] later statement";
    let revision = case.publish_extract(&sid, full_text, "Full local machine transcription; unreviewed", true).unwrap();
    assert_eq!(revision, 2);
    let active = case.read_text(&sid, 1, 10).unwrap();
    assert_eq!(active["revision"], 2);
    assert!(active["text"].as_str().unwrap().contains("full transcript first line"));
    // Search now hits the full wording, not the stale partial.
    assert_eq!(case.search("blue", 0).unwrap()["results"].as_array().unwrap().len(), 1);

    // Historical partial wording remains retrievable exactly as published.
    let historical = case.read_text_revision(&sid, 1, 1, 5).unwrap();
    assert_eq!(historical["text"], "[00:00.5] partial machine text");
    assert_eq!(historical["historical"], true);
    let history = case.extract_history(&sid).unwrap();
    assert_eq!(history["active_revision"], 2);
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);

    // A later partial cannot silently replace the active full text.
    let later = case.publish_extract(&sid, "[01:00.0] another partial", "Sandboxed audio; see processing limitations", false).unwrap();
    assert_eq!(later, 3);
    let active = case.read_text(&sid, 1, 10).unwrap();
    assert_eq!(active["revision"], 2, "partial must not clobber the full transcript");
    assert!(active["text"].as_str().unwrap().contains("full transcript first line"));
}

#[test]
fn activation_propagates_staleness_and_currentness() {
    let (_dir, mut case, sid) = setup_media_case();
    let record = case.write_record(None, 0, "Notes", "note", "findings from the partial", "human", "initial", None, vec![sid.clone()]).unwrap();
    case.publish_extract(&sid, "partial text", "Sandboxed audio; see processing limitations", true).unwrap();
    let generation_before = case.generation().unwrap();
    let full = "full machine transcription\nsecond line";
    case.publish_extract(&sid, full, "Full local machine transcription; unreviewed", true).unwrap();
    assert!(case.generation().unwrap() > generation_before, "activation bumps the case generation");
    assert!(case.record(&record.id).unwrap().stale, "dependent records become stale on supersession");
    // Line citations validate against the active revision.
    case.validate_citation(&format!("evidence:{sid}#L1-L2")).unwrap();
    assert!(case.validate_citation(&format!("evidence:{sid}#L1-L5")).is_err());
}

#[test]
fn revision_locators_accept_recorded_revisions_and_reject_unknowns() {
    let (_dir, mut case, sid) = setup_media_case();
    case.publish_extract(&sid, "partial text", "Sandboxed audio; see processing limitations", true).unwrap();
    case.publish_extract(&sid, "full text\nsecond", "Full local machine transcription; unreviewed", true).unwrap();
    let locator = serde_json::from_value::<evidence_desk::evidence::EvidenceLocator>(serde_json::json!({
        "kind": "text", "source_id": sid, "extraction_revision": 2, "line_start": 1, "line_end": 1
    })).unwrap();
    assert!(locator.validate(&case).is_ok());
    let unknown = serde_json::from_value::<evidence_desk::evidence::EvidenceLocator>(serde_json::json!({
        "kind": "text", "source_id": sid, "extraction_revision": 9, "line_start": 1, "line_end": 1
    })).unwrap();
    assert!(unknown.validate(&case).is_err());
}

#[test]
fn schema_six_migration_backfills_existing_extraction_as_revision_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("old.ledcase"), "Old case").unwrap();
    let text = dir.path().join("doc.txt");
    fs::write(&text, "legacy indexed wording\n").unwrap();
    case.import_files(&[text.to_string_lossy().into()], "A").unwrap();
    let sid = case.sources().unwrap()[0].id.clone();
    // Simulate a pre-schema-6 case, then reopen to run the migration.
    case.db.pragma_update(None, "user_version", 5).unwrap();
    let root = case.root.clone();
    drop(case);
    let migrated = Case::open(&root).unwrap();
    assert!(root.join("pre-migration-v5.sqlite3").exists());
    let revisions: i64 = migrated.db.query_row(
        "SELECT COUNT(*) FROM extract_revisions WHERE source_id=? AND revision=1",
        [&sid], |r| r.get(0),
    ).unwrap();
    assert_eq!(revisions, 1, "active extraction backfilled as immutable revision");
    let historical = migrated.read_text_revision(&sid, 1, 1, 1).unwrap();
    assert_eq!(historical["text"], "legacy indexed wording");
    migrated.verify_audit().unwrap();
}
