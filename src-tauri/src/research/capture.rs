//! Publishing a research capture as citable case evidence, mirroring `authority::publish`.
//!
//! The browser job (outside the case lock) returns the sanitised document; this runs in the tool
//! arm under the case lock and inside the agent's `SAVEPOINT agent_action`:
//! import -> restricted re-check -> extract -> authority object -> task scope expansion (D2) ->
//! audit -> automatic preparation. Any failure rolls all of it back and leaves no staged file and
//! no unregistered original behind.

use std::collections::HashSet;

use anyhow::{ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::citations;
use super::tools::{quote_span, relevant_date_arg, text_arg, MAX_CAPTURE_BYTES};
use crate::case::{digest, id, now, Case, PreparedImport};

pub const EXTRACT_METHOD: &str = "Research page capture; publisher editorial regions excluded";
pub const ACTOR: &str = "research_browser_adapter";
/// Upper bound on a quote stored in the authority object.
pub const MAX_QUOTE_CHARS: usize = 20_000;
const NEXT: &str = "Dossier and records were marked stale by this import; re-read before saving claims";

/// Lines searched for the citation printed at the top of a document.
const HEADER_LINES: usize = 60;
/// Lines after the first printed citation that may carry its parallel citations.
const PARALLEL_LINES: usize = 2;

/// The first reporter citation printed near the top of the document text, as printed with its
/// spacing collapsed, if any. A lead for the mismatch check only; it is not a verified citation.
pub fn detect_citation(lines: &[&str]) -> Option<String> {
    lines.iter().take(HEADER_LINES).find_map(|line| citations::extract(line).into_iter().next().map(|found| found.raw.split_whitespace().collect::<Vec<_>>().join(" ")))
}

/// Normalized citations printed in the document header: the first line with a citation and the
/// next lines, which usually carry its parallel citations.
fn header_citations(lines: &[&str]) -> HashSet<String> {
    let header = &lines[..lines.len().min(HEADER_LINES)];
    let Some(first) = header.iter().position(|line| !citations::extract(line).is_empty()) else { return HashSet::new() };
    header[first..header.len().min(first + PARALLEL_LINES + 1)].iter().flat_map(|line| citations::normalized_all(line)).collect()
}

fn squashed(citation: &str) -> String {
    citation.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// Whether the agent's claimed citation differs from the one printed in the document. Every
/// reporter citation the agent claims must be printed in the header (normalized, so "F. 3d" and
/// "F.3d" agree); a claim with no recognisable reporter citation falls back to text comparison.
fn citation_mismatch(raw: &str, claimed: &str, lines: &[&str]) -> bool {
    let claims = citations::normalized_all(claimed);
    if claims.is_empty() {
        let (raw, claimed) = (squashed(raw), squashed(claimed));
        return !(claimed.contains(&raw) || raw.contains(&claimed));
    }
    let mut printed = header_citations(lines);
    printed.extend(citations::normalized_all(raw));
    !claims.iter().all(|claim| printed.contains(claim))
}

/// A readable, filesystem-neutral source name from the model's title.
fn source_name(title: &str) -> String {
    let safe: String = title.chars().filter(|c| c.is_alphanumeric() || " ,-()'&".contains(*c)).take(80).collect();
    let safe = safe.split_whitespace().collect::<Vec<_>>().join(" ");
    if safe.is_empty() { "Research capture.html".into() } else { format!("Research capture - {safe}.html") }
}

/// Publishes a capture bundle from the browser job. Returns the tool result for the model.
pub fn publish(case: &mut Case, task: &str, bundle: &Value, args: &Value) -> Result<Value> {
    ensure!(!case.settings()?.offline, "Offline mode enabled");
    // The research browser must still be on with the settings this task started with.
    let grant = super::grant(case)?.filter(|grant| grant.enabled).context("The research browser is switched off for this case")?;
    let pinned = case.meta(&format!("research_grant_revision:{task}"))?;
    ensure!(pinned.as_deref() == Some(grant.revision.to_string().as_str()), "The research browser settings changed during this task; start a new task");
    let title = text_arg(args, "title", 250)?;
    let jurisdiction = text_arg(args, "jurisdiction", 200)?;
    let claimed = text_arg(args, "citation_text", 300)?;
    let proposition = text_arg(args, "proposition", 1000)?;
    let relevant_date = relevant_date_arg(args)?;
    let (start, end) = quote_span(args)?;

    let url = bundle["url"].as_str().filter(|url| url.len() <= 4000).context("The capture has no page address")?;
    let parsed: reqwest::Url = url.parse().context("The capture has an invalid page address")?;
    let html = bundle["html"].as_str().context("The capture has no document")?;
    ensure!(!html.trim().is_empty() && html.len() <= MAX_CAPTURE_BYTES, "The document is empty or larger than the capture limit");
    let lines: Vec<&str> = bundle["lines"].as_array().context("The capture has no document text")?.iter().filter_map(Value::as_str).collect();
    ensure!(end < lines.len(), "The quoted lines are outside the captured document ({} lines)", lines.len());
    let full_page_sha256 = bundle["full_page_sha256"].as_str().filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).context("The capture has no page hash")?;
    let exact = lines[start..=end].join("\n");
    ensure!(exact.chars().count() <= MAX_QUOTE_CHARS, "Quote at most {MAX_QUOTE_CHARS} characters; quote a narrower span");
    let raw = bundle["citation_raw"].as_str().map(str::to_string);
    let mismatch = raw.as_ref().map(|raw| citation_mismatch(raw, &claimed, &lines));
    // With no printed citation found, the claim is confirmed only if the document text prints it.
    let claimed_in_text = raw.is_none() && {
        let claims = citations::normalized_all(&claimed);
        let printed: std::collections::HashSet<String> = citations::normalized_all(&lines.join("\n")).into_iter().collect();
        !claims.is_empty() && claims.iter().all(|claim| printed.contains(claim))
    };

    let bytes = html.as_bytes();
    let sha = digest(bytes);
    let target = case.root.join("originals").join(&sha);
    let target_existed = target.exists();
    case.db.execute_batch("SAVEPOINT research_capture")?;
    let published = (|| -> Result<Value> {
        // 1. Import the sanitised document bytes (content-addressed, immutable).
        let prepared = PreparedImport::from_verified_bytes(&case.root, bytes, &source_name(&title), &format!("westlaw-research:{url}"))?;
        let batch = id();
        let imported = case.publish_import(prepared, "Research browser capture", &batch)?;
        case.db.execute("INSERT INTO imports VALUES(?,?,?,?,?,?)", params![id(), url, batch, "imported", imported.to_string(), now()])?;
        case.audit("import_batch", json!({"batch": batch, "items": [json!({"path": format!("westlaw-research:{url}"), "status": "imported", "detail": imported.to_string()})]}))?;
        let source: String = imported["source_id"].as_str().context("Import returned no source")?.to_string();
        let duplicate = imported["duplicate"] == true;
        // 2. Identity comes from the bytes: an identical restricted source is refused.
        ensure!(!case.source(&source)?.restricted, "Matching source is restricted");
        // 3. Extract: the same lines the model quoted. An existing identical revision is reused;
        //    an existing source's different active text is never replaced.
        let text = lines.join("\n");
        let same: Option<i64> = case.db.query_row("SELECT revision FROM extract_revisions WHERE source_id=? AND text=? ORDER BY revision LIMIT 1", params![source, text], |row| row.get(0)).optional()?;
        let active: Option<String> = case.db.query_row("SELECT text FROM extracts WHERE source_id=?", [&source], |row| row.get(0)).optional()?;
        let revision = match (same, active) {
            (Some(revision), _) => revision,
            (None, None) => case.publish_extract(&source, &text, EXTRACT_METHOD, true)?,
            (None, Some(current)) if current.is_empty() => case.publish_extract(&source, &text, EXTRACT_METHOD, true)?,
            (None, Some(_)) => case.publish_extract(&source, &text, EXTRACT_METHOD, false)?,
        };
        let locator = format!("evidence:{source}#R{revision}L{}-L{}", start + 1, end + 1);
        case.validate_citation(&locator)?;
        // 4. The authority object, unreviewed, with its retrieval provenance.
        let content = json!({
            "url": url,
            "title": title,
            "citation": {"raw": raw, "claimed": claimed, "mismatch": mismatch, "claimed_in_text": claimed_in_text},
            "jurisdiction": jurisdiction,
            "relevant_date": relevant_date,
            "retrieved_at": now(),
            "retrieved_by": {"task": task, "grant_revision": grant.revision, "tool": "research_capture"},
            "playbook": bundle["playbook"],
            "tr_editorial": "excluded",
            "quote": {"exact": exact, "start_line": start + 1, "end_line": end + 1, "locator": locator},
            "proposition": proposition,
            "full_page_sha256": full_page_sha256,
            "original_source_id": source,
            "mime": "text/html",
            "treatment_status": "not_checked",
            "proposition_support": "not_assessed",
            "limitations": [
                "Captured from the user's research session; the publisher's editorial content (headnotes, synopsis, key numbers, citator treatment) was excluded.",
                "Capture does not verify current validity, subsequent treatment or support for the proposition.",
                "The citation was supplied by the agent; compare it with the citation printed in the document.",
                "Relevant date is the requested research date, not proof this document was in force then."
            ],
        });
        let object = crate::evidence::write(
            case,
            crate::evidence::ObjectInput {
                id: None,
                base_revision: 0,
                kind: "authority".into(),
                title: title.clone(),
                content: content.to_string(),
                source_ids: vec![source.clone()],
                locators: vec![locator.clone()],
                dependencies: vec![],
                start_seconds: None,
                end_seconds: None,
            },
            ACTOR,
        )?;
        let authority = object["id"].as_str().context("Authority was not recorded")?.to_string();
        // 5. D2: the capturing task (only) may now read the source it created.
        let expanded = case.db.execute(
            "UPDATE tasks SET scope=json_insert(scope,'$[#]',?1) WHERE id=?2 AND status='running' AND json_valid(scope) AND NOT EXISTS(SELECT 1 FROM json_each(tasks.scope) WHERE value=?1)",
            params![source, task],
        )? > 0;
        if !expanded {
            let in_scope: bool = case.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?2 AND status='running' AND EXISTS(SELECT 1 FROM json_each(tasks.scope) WHERE value=?1))",
                params![source, task],
                |row| row.get(0),
            )?;
            ensure!(in_scope, "The task is no longer running; the capture was not saved");
        }
        if expanded || !duplicate {
            let key = format!("task_created_sources:{task}");
            let mut created: Vec<String> = case.meta(&key)?.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
            if !created.contains(&source) {
                created.push(source.clone());
                case.set_meta(&key, &serde_json::to_string(&created)?)?;
            }
        }
        if expanded {
            case.audit("task_scope_expanded", json!({"task": task, "source": source, "via": "research_capture"}))?;
        }
        // 6. Audit the publication (host and path, like page openings).
        case.audit(
            "research_capture_published",
            json!({"task": task, "source": source, "authority": authority, "locator": locator, "host": parsed.host_str(), "path": parsed.path(), "full_page_sha256": full_page_sha256, "citation_mismatch": mismatch, "grant_revision": grant.revision, "duplicate": duplicate}),
        )?;
        // 7. Background preparation, as for any import.
        crate::automatic::enqueue(case)?;
        Ok(json!({
            "source_id": source,
            "authority_id": authority,
            "locator": locator,
            "quote": exact,
            "citation_raw": raw,
            "citation_mismatch": mismatch,
            "scope_expanded": expanded,
            "next": NEXT,
        }))
    })();
    match published {
        Ok(value) => {
            case.db.execute_batch("RELEASE research_capture")?;
            Ok(value)
        }
        Err(error) => {
            let _ = case.db.execute_batch("ROLLBACK TO research_capture; RELEASE research_capture");
            // An original moved into place by this capture is removed with its rows.
            let registered: bool = case.db.query_row("SELECT EXISTS(SELECT 1 FROM sources WHERE sha256=?)", [&sha], |row| row.get(0)).unwrap_or(true);
            if !target_existed && !registered && target.exists() {
                if let Ok(metadata) = std::fs::metadata(&target) {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    let _ = std::fs::set_permissions(&target, permissions);
                }
                let _ = std::fs::remove_file(&target);
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_reporter_citations_as_leads() {
        assert_eq!(detect_citation(&["Smith v. Jones", "123  F.3d 456 (9th Cir. 2001)"]).as_deref(), Some("123 F.3d 456"));
        assert_eq!(detect_citation(&["2024 WL 1234567 (D. Mass. 2024)"]).as_deref(), Some("2024 WL 1234567"));
        assert_eq!(detect_citation(&["567 U.S. 1 (2012)"]).as_deref(), Some("567 U.S. 1"));
        assert_eq!(detect_citation(&["12 F. Supp. 3d 45"]).as_deref(), Some("12 F. Supp. 3d 45"));
        assert_eq!(detect_citation(&["No citation here", "Section 12 of the Act"]), None);
        // As printed (spacing collapsed), not canonicalized; statutes are not case citations.
        assert_eq!(detect_citation(&["Codified at 12 U.S.C. § 1234", "Roe v. Wade, 410 U. S. 113, 120"]).as_deref(), Some("410 U. S. 113"));
        assert_eq!(detect_citation(&["Smith v. Jones, 2019-Ohio-1234"]).as_deref(), Some("2019-Ohio-1234"));
        let mut late = vec!["text"; 60];
        late.push("123 F.3d 456");
        assert_eq!(detect_citation(&late), None, "only the document header is searched");
        assert_eq!(source_name("Smith v. Jones <script>/..\\"), "Research capture - Smith v Jones script.html");
    }

    #[test]
    fn mismatch_compares_normalized_citations_and_accepts_printed_parallel_cites() {
        let lines = ["Roe v. Wade", "410 U.S. 113, 93 S. Ct. 705,", "35 L. Ed. 2d 147 (1973)", "Opinion", "See 123 F.3d 456."];
        let raw = detect_citation(&lines).unwrap();
        assert_eq!(raw, "410 U.S. 113");
        assert!(!citation_mismatch(&raw, "410 U. S. 113", &lines));
        assert!(!citation_mismatch(&raw, "Roe v. Wade, 410 U.S. 113, 120 (1973)", &lines));
        assert!(!citation_mismatch(&raw, "93 S.Ct. 705", &lines), "a printed parallel citation");
        assert!(!citation_mismatch(&raw, "410 U.S. 113, 35 L. Ed. 2d 147", &lines));
        assert!(citation_mismatch(&raw, "411 U.S. 113", &lines));
        assert!(citation_mismatch(&raw, "123 F.3d 456", &lines), "a case cited in the body is not this document");
        assert!(citation_mismatch(&raw, "410 U.S. 113, 999 S. Ct. 1", &lines), "every claimed citation must be printed");
        // A claim without a reporter citation is compared as text.
        assert!(!citation_mismatch(&raw, "410U.S.113", &lines));
        assert!(citation_mismatch(&raw, "Roe v. Wade", &lines));
    }
}
