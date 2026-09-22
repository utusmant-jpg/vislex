//! VL-010 — extraction/full-transcript revision consistency.
//!
//! A completed full transcript must become the active searchable text even when
//! an older partial extraction exists; every extraction is an immutable
//! revision; historical wording stays retrievable; later partials cannot
//! clobber the active full text; active-revision changes propagate staleness.
//! R02: `#R<rev>L a-b` citations are bound to that immutable revision; bare
//! `#L a-b` remains the legacy active-text form and is labeled as such.

use evidence_desk::case::Case;
use evidence_desk::evidence::EvidenceLocator;
use serde_json::json;
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

/// R02 — a genuine schema-5 fixture: the extract_revisions table does not
/// exist at all. Migration must recreate it and backfill the active extraction
/// as revision 1 so pinned citations resolve on the migrated case.
#[test]
fn genuine_schema_five_database_migrates_and_supports_pinned_citations() {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("v5.ledcase"), "Schema five case").unwrap();
    let text = dir.path().join("legacy.txt");
    fs::write(&text, "line one legacy\nline two legacy\n").unwrap();
    case.import_files(&[text.to_string_lossy().into()], "A").unwrap();
    let sid = case.sources().unwrap()[0].id.clone();
    // Real pre-schema-6 shape: no extract_revisions table, user_version 5.
    case.db.execute_batch("DROP TABLE extract_revisions; PRAGMA user_version=5;").unwrap();
    let root = case.root.clone();
    drop(case);

    let mut migrated = Case::open(&root).unwrap();
    let pinned = migrated.validate_citation(&format!("evidence:{sid}#R1L1-L2")).unwrap();
    assert_eq!(pinned["revision_binding"], "pinned");
    assert_eq!(pinned["revision"], 1);
    // The active read path now emits revision-pinned locators.
    let active = migrated.read_text(&sid, 1, 2).unwrap();
    assert_eq!(active["locator"], format!("evidence:{sid}#R1L1-L2"));
    // Migration kept the supersession backbone: a new publication appends and
    // activates revision 2 without clobbering the backfilled revision 1.
    migrated.publish_extract(&sid, "replacement wording", "later extraction", true).unwrap();
    let historical = migrated.read_text_revision(&sid, 1, 1, 2).unwrap();
    assert_eq!(historical["text"], "line one legacy\nline two legacy");
    migrated.verify_audit().unwrap();
}

/// R02 — the core historical-citation invariant. A citation pinned to a long
/// revision 1 stays valid after a short revision 2 activates; the short active
/// revision cannot validate lines it does not have; the old wording survives
/// restart and encrypted backup/restore unchanged.
#[test]
fn pinned_citation_keeps_exact_old_wording_across_supersession_restart_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history.ledcase");
    let mut case = Case::create(&root, "History case").unwrap();
    let mut wav: Vec<u8> = Vec::new();
    wav.extend_from_slice(b"RIFF");wav.extend_from_slice(&36u32.to_le_bytes());wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");wav.extend_from_slice(&16u32.to_le_bytes());wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());wav.extend_from_slice(&16000u32.to_le_bytes());wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");wav.extend_from_slice(&0u32.to_le_bytes());
    let media = dir.path().join("interview.wav");
    fs::write(&media, &wav).unwrap();
    case.import_files(&[media.to_string_lossy().into()], "A").unwrap();
    let sid = case.sources().unwrap()[0].id.clone();
    // A media source has no native text extraction, so publications number from 1.
    let rev1 = "old first line\nold second line\nold third line";
    assert_eq!(case.publish_extract(&sid, rev1, "initial extraction", true).unwrap(), 1);
    // rev1-long: pinned 3-line citation valid while rev1 is active.
    case.validate_citation(&format!("evidence:{sid}#R1L1-L3")).unwrap();
    // rev2-short: a one-line replacement becomes active.
    assert_eq!(case.publish_extract(&sid, "new single line", "corrected extraction", true).unwrap(), 2);

    // The pinned citation remains valid against revision 1's own bounds...
    let pinned = case.validate_citation(&format!("evidence:{sid}#R1L1-L3")).unwrap();
    assert_eq!(pinned["revision_binding"], "pinned");
    assert_eq!(pinned["revision"], 1);
    // ...while the same range cannot validate against the short revision 2.
    assert!(case.validate_citation(&format!("evidence:{sid}#R2L1-L3")).is_err());
    // The exact old wording is still what the citation resolves to.
    let historical = case.read_text_revision(&sid, 1, 1, 3).unwrap();
    assert_eq!(historical["text"], rev1);
    // Active reads emit the new pinned grammar.
    let active = case.read_text(&sid, 1, 1).unwrap();
    assert_eq!(active["locator"], format!("evidence:{sid}#R2L1-L1"));
    // The legacy form still validates, labeled as active-text bound.
    let legacy = case.validate_citation(&format!("evidence:{sid}#L1-L1")).unwrap();
    assert_eq!(legacy["revision_binding"], "active-text");
    assert_eq!(legacy["revision"], 2);

    // RESTART — close and reopen; pinned citation and wording unchanged.
    drop(case);
    let mut reopened = Case::open(&root).unwrap();
    reopened.validate_citation(&format!("evidence:{sid}#R1L1-L3")).unwrap();
    assert_eq!(reopened.read_text_revision(&sid, 1, 1, 3).unwrap()["text"], rev1);

    // BACKUP/RESTORE — the revision history travels inside the case database.
    let archive = dir.path().join("history.age");
    evidence_desk::backup::backup(&mut reopened, &archive, "history-pass-123").unwrap();
    drop(reopened);
    let restored = evidence_desk::backup::restore(&archive, &dir.path().join("restored.ledcase"), "history-pass-123").unwrap();
    let pinned_after = restored.validate_citation(&format!("evidence:{sid}#R1L1-L3")).unwrap();
    assert_eq!(pinned_after["revision"], 1);
    assert_eq!(restored.read_text_revision(&sid, 1, 1, 3).unwrap()["text"], rev1);
    assert!(restored.validate_citation(&format!("evidence:{sid}#R2L1-L3")).is_err());
    restored.verify_audit().unwrap();
}

/// R02 — the false-positive the old validator allowed: revision 1 is SHORT,
/// revision 2 is long; lines that exist only in the active text must NOT
/// validate for revision 1. Checked through both citation and locator APIs.
#[test]
fn pinned_citation_cannot_validate_lines_that_only_exist_in_later_revisions() {
    let (_dir, mut case, sid) = setup_media_case();
    case.publish_extract(&sid, "only line of revision one", "initial partial", true).unwrap();
    case.publish_extract(&sid, "first\nsecond\nthird\nfourth\nfifth", "full transcript", true).unwrap();
    // The lines exist in active revision 2 but not in revision 1.
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L2-L3")).is_err(),
        "revision 1 has one line; lines 2-3 must not validate for it");
    assert!(case.validate_citation(&format!("evidence:{sid}#R2L2-L3")).is_ok());
    // Same invariant through the structured locator used by evidence objects.
    let beyond = serde_json::from_value::<EvidenceLocator>(json!({
        "kind": "text", "source_id": sid, "extraction_revision": 1, "line_start": 2, "line_end": 3
    })).unwrap();
    assert!(beyond.validate(&case).is_err());
    let within = serde_json::from_value::<EvidenceLocator>(json!({
        "kind": "text", "source_id": sid, "extraction_revision": 1, "line_start": 1, "line_end": 1
    })).unwrap();
    assert!(within.validate(&case).is_ok());
    // A locator for a different recorded revision keeps its own bounds.
    let rev2 = serde_json::from_value::<EvidenceLocator>(json!({
        "kind": "text", "source_id": sid, "extraction_revision": 2, "line_start": 2, "line_end": 5
    })).unwrap();
    assert!(rev2.validate(&case).is_ok());
}

/// R02 — grammar hardening: wrong case, unknown source, unknown revision,
/// zero/negative revisions, reversed ranges and malformed locators all reject.
#[test]
fn pinned_citation_grammar_rejects_malformed_and_mismatched_locators() {
    let (_dir, mut case, sid) = setup_media_case();
    case.publish_extract(&sid, "first\nsecond\nthird", "initial", true).unwrap();
    let good = format!("evidence:{sid}#R1L1-L2");
    case.validate_citation(&good).unwrap();
    // Lowercase revision marker is not part of the grammar.
    assert!(case.validate_citation(&format!("evidence:{sid}#r1L1-L2")).is_err());
    // Unknown source, unknown revision, zero revision.
    assert!(case.validate_citation("evidence:missing-source#R1L1-L2").is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R9L1-L2")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R0L1-L2")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R-1L1-L2")).is_err());
    // Reversed/open-ended ranges and malformed separators.
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L3-L1")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L1")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L1-3")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#RXL1-L2")).is_err());
    // Canonical spelling only: signed numbers, leading zeros and line zero are
    // rejected so one location has exactly one serialization (TS grammar parity).
    assert!(case.validate_citation(&format!("evidence:{sid}#R+1L1-L2")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R01L1-L2")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L01-L2")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L0-L1")).is_err());
    assert!(case.validate_citation(&format!("evidence:{sid}#R1L1-L201")).is_err());
    // Structured locator against the wrong source must fail too.
    let wrong_source = serde_json::from_value::<EvidenceLocator>(json!({
        "kind": "text", "source_id": "not-a-source", "extraction_revision": 1, "line_start": 1, "line_end": 1
    })).unwrap();
    assert!(wrong_source.validate(&case).is_err());
}
