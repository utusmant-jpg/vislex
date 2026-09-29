//! The research hallucination guard: reporter citations the agent writes must be captured
//! research authorities in its task's scope, or declared in its gaps.

use evidence_desk::{
    case::{Case, Settings},
    research::{self, citations},
};
use serde_json::json;

fn setup() -> (tempfile::TempDir, Case, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("test.ledcase"), "Synthetic case").unwrap();
    let note = dir.path().join("note.txt");
    std::fs::write(&note, "A synthetic note.\n").unwrap();
    case.import_files(&[note.to_string_lossy().into()], "Synthetic").unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    case.save_settings(Settings { offline: false, allow_text: true, allow_images: false, model: "test-model".into() }).unwrap();
    (dir, case, source)
}

fn start(case: &mut Case, source: &str, research_used: bool) -> String {
    let task = evidence_desk::agent::start(case, "Research the duty of care", "investigate", vec![source.to_string()], vec![], 0.).unwrap();
    if research_used {
        // What the first research tool call records: the grant revision the task uses.
        let revision = research::grant(case).unwrap().unwrap().revision;
        case.set_meta(&format!("research_grant_revision:{task}"), &revision.to_string()).unwrap();
        case.set_meta(&format!("research_usage:{task}"), r#"{"navigations":1}"#).unwrap();
    }
    task
}

/// Publishes a synthetic capture whose document prints `printed` and whose agent claimed `claimed`.
fn capture(case: &mut Case, task: &str, printed: &str, claimed: &str) -> serde_json::Value {
    let lines = vec!["Smith v. Jones".to_string(), format!("{printed} (9th Cir. 2001)"), "Opinion".into(), format!("A duty of reasonable care applies ({printed}).")];
    let html = format!("<main>{}</main>", lines.iter().map(|line| format!("<p>{line}</p>")).collect::<String>());
    let bundle = json!({
        "url": format!("https://1.next.westlaw.com/Document/{}", evidence_desk::case::id()),
        "html": html,
        "lines": lines,
        "full_page_sha256": evidence_desk::case::digest(html.as_bytes()),
        "citation_raw": research::capture::detect_citation(&lines.iter().map(String::as_str).collect::<Vec<_>>()),
        "playbook": "fixture",
    });
    let args = json!({"title": "Smith v. Jones", "jurisdiction": "9th Cir.", "citation_text": claimed, "proposition": "A duty of reasonable care applies.", "relevant_date": null, "quote_start_line": 3, "quote_end_line": 3});
    research::publish(case, task, &bundle, &args).unwrap()
}

#[test]
fn fabricated_citations_are_refused_with_an_actionable_message() {
    let (_dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    let task = start(&mut case, &source, true);
    let answer = "The duty applies. Smith v. Jones, 999 F.3d 999, 1001 (9th Cir. 2020); see also 2021 WL 7654321. The statute is 42 U.S.C. § 1983.";
    assert_eq!(citations::uncaptured(&case, &task, &[answer], &[]).unwrap(), ["999 F.3d 999", "2021 WL 7654321"]);
    let error = citations::guard(&case, &task, &[answer], &[]).unwrap_err().to_string();
    assert!(error.contains("Capture these authorities with research_capture before citing them, or list them in gaps"), "{error}");
    assert!(error.contains("999 F.3d 999") && error.contains("2021 WL 7654321") && !error.contains("1983"), "{error}");
    // Text without reporter citations is never affected.
    citations::guard(&case, &task, &["The statute is 42 U.S.C. § 1983; see the note."], &[]).unwrap();
}

#[test]
fn captured_citations_pass_in_any_spacing_and_with_pin_cites() {
    let (_dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    let task = start(&mut case, &source, true);
    let output = capture(&mut case, &task, "123 F.3d 456", "123 F. 3d 456");
    assert_eq!(output["citation_raw"], "123 F.3d 456");
    assert_eq!(output["citation_mismatch"], false, "normalized comparison");
    citations::guard(&case, &task, &["Smith v. Jones, 123 F. 3d 456, 460 (9th Cir. 2001)."], &[]).unwrap();
    citations::guard(&case, &task, &["Title", "Body cites 123 F3d 456."], &[]).unwrap();
    let error = citations::guard(&case, &task, &["Smith, 123 F.3d 456; Doe, 124 F.3d 456."], &[]).unwrap_err().to_string();
    assert!(error.contains("124 F.3d 456") && !error.contains("123 F.3d 456"), "{error}");
}

#[test]
fn a_claimed_citation_that_mismatches_the_document_is_not_captured() {
    let (_dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    let task = start(&mut case, &source, true);
    let output = capture(&mut case, &task, "123 F.3d 456", "555 U.S. 1");
    assert_eq!(output["citation_mismatch"], true);
    assert_eq!(citations::uncaptured(&case, &task, &["123 F.3d 456 and 555 U.S. 1"], &[]).unwrap(), ["555 U.S. 1"]);
}

#[test]
fn citations_declared_in_gaps_pass() {
    let (_dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    let task = start(&mut case, &source, true);
    let answer = "Possibly relevant: 999 F.3d 999 and 2021 WL 7654321.";
    citations::guard(&case, &task, &[answer], &["Not captured or verified: 999 F. 3d 999.", "2021 WL 7654321 was not opened."]).unwrap();
    let error = citations::guard(&case, &task, &[answer], &["999 F.3d 999 is unverified."]).unwrap_err().to_string();
    assert!(error.contains("2021 WL 7654321") && !error.contains("999 F.3d 999"), "{error}");
}

#[test]
fn tasks_without_research_are_unaffected() {
    let (_dir, mut case, source) = setup();
    // The research browser was never switched on.
    let plain = start(&mut case, &source, false);
    citations::guard(&case, &plain, &["See 999 F.3d 999."], &[]).unwrap();
    // Switched on for the case, but this task never used it (no pinned grant).
    research::set_grant(&mut case, true, &[]).unwrap();
    let unused = start(&mut case, &source, false);
    citations::guard(&case, &unused, &["See 999 F.3d 999."], &[]).unwrap();
    assert_eq!(citations::uncaptured(&case, &unused, &["See 999 F.3d 999."], &[]).unwrap(), ["999 F.3d 999"], "reported, but not enforced");
}

#[test]
fn another_tasks_capture_outside_scope_is_flagged() {
    let (_dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    let first = start(&mut case, &source, true);
    let second = start(&mut case, &source, true);
    let output = capture(&mut case, &first, "123 F.3d 456", "123 F.3d 456");
    let captured_source = output["source_id"].as_str().unwrap().to_string();
    citations::guard(&case, &first, &["123 F.3d 456"], &[]).unwrap();
    let error = citations::guard(&case, &second, &["123 F.3d 456"], &[]).unwrap_err().to_string();
    assert!(error.contains("123 F.3d 456"), "{error}");
    // A later task whose scope includes the captured source may cite it.
    let later = evidence_desk::agent::start(&mut case, "Review the authority", "investigate", vec![source, captured_source], vec![], 0.).unwrap();
    case.set_meta(&format!("research_grant_revision:{later}"), "1").unwrap();
    case.set_meta(&format!("research_usage:{later}"), r#"{"captures":1}"#).unwrap();
    citations::guard(&case, &later, &["123 F.3d 456"], &[]).unwrap();
}

#[test]
fn a_capture_without_a_printed_citation_confirms_only_claims_its_text_prints() {
    let (_dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    let task = start(&mut case, &source, true);
    // The page prints no reporter citation; the agent claims one the text never shows.
    let output = capture(&mut case, &task, "Slip opinion No. 21-1234", "999 F.3d 1");
    assert!(output["citation_raw"].is_null(), "{output}");
    let error = citations::guard(&case, &task, &["See 999 F.3d 1."], &[]).unwrap_err().to_string();
    assert!(error.contains("999 F.3d 1"), "{error}");
}

#[test]
fn records_keep_citations_they_already_had_and_case_sources_vouch_for_their_own() {
    let (dir, mut case, source) = setup();
    research::set_grant(&mut case, true, &[]).unwrap();
    // A brief imported into the case cites a precedent.
    let brief = dir.path().join("brief.txt");
    std::fs::write(&brief, "Plaintiff relies on Roe v. Wade, 410 U.S. 113 (1973).\n").unwrap();
    case.import_files(&[brief.to_string_lossy().into()], "Synthetic").unwrap();
    let brief_id = case.sources().unwrap().into_iter().find(|s| s.name.contains("brief")).unwrap().id;
    let task = evidence_desk::agent::start(&mut case, "Research", "investigate", vec![source, brief_id], vec![], 0.).unwrap();
    case.set_meta(&format!("research_usage:{task}"), r#"{"navigations":1}"#).unwrap();
    citations::guard_revision(&case, &task, &["The brief cites 410 U.S. 113."], &[]).unwrap();
    // A citation already in the revision being updated is kept; a new uncaptured one is not.
    citations::guard_revision(&case, &task, &["Memo: 555 U.S. 1 and more."], &["Memo: 555 U.S. 1."]).unwrap();
    let error = citations::guard_revision(&case, &task, &["Memo: 556 U.S. 2."], &["Memo: 555 U.S. 1."]).unwrap_err().to_string();
    assert!(error.contains("556 U.S. 2") && error.contains("leave them out"), "{error}");
    // A gap naming a different citation does not cover this one.
    assert!(citations::guard(&case, &task, &["See 410 U.S. 1130."], &["410 U.S. 113 is unverified."]).is_err());
    // Record citations are not reporters.
    assert!(citations::normalized_all("See 2 R. 45 and 1 App. 12.").is_empty());
}
