//! Case reporter citations ("410 U.S. 113", "123 F.3d 456", "2021 WL 1234567") and the research
//! hallucination guard built on them.
//!
//! Reporter abbreviations come from Free Law Project's reporters-db (BSD-2-Clause), the database
//! eyecite uses, vendored by `scripts/build-reporters-db.py` as
//! `resources/research/reporters-db.json`: every edition and its known variations ("F. 3d",
//! "F3d") with the canonical edition ("F.3d"). Only full case citations are recognised: volume,
//! reporter, page. Statutes, regulations, journals and short forms ("410 U.S. at 120", "Id.")
//! are not case reporter citations and are not matched.
//!
//! The guard never judges support or validity. It only checks that a reporter citation the agent
//! writes was captured as a research authority in the task's scope, or is declared in its gaps.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use anyhow::{ensure, Result};
use serde_json::Value;

use crate::case::Case;

const DATA: &str = include_str!("../../resources/research/reporters-db.json");

/// A full case reporter citation found in text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Citation {
    pub volume: String,
    /// The canonical reporter edition, e.g. "F.3d" for "F. 3d".
    pub reporter: String,
    pub page: String,
    /// The citation as printed (volume through page).
    pub raw: String,
    /// Byte offsets of `raw` in the text.
    pub start: usize,
    pub end: usize,
}

/// The comparable form of a citation: "410 U.S. 113".
pub fn normalized(citation: &Citation) -> String {
    format!("{} {} {}", citation.volume, citation.reporter, citation.page)
}

#[derive(serde::Deserialize)]
struct Data {
    editions: HashMap<String, Vec<String>>,
    variations: HashMap<String, String>,
}

struct Table {
    full: regex::Regex,
    /// Format-neutral hyphenated cites such as "2019-Ohio-1234" and "2000-NMSC-123".
    hyphenated: regex::Regex,
    /// Abbreviation without whitespace, apostrophes unified -> canonical edition.
    canonical: HashMap<String, String>,
    cite_types: HashMap<String, Vec<String>>,
}

/// Single words that are also reporter names ("Day", "Hill", "Black") would match ordinary
/// prose, so a plain word is recognised only when it is one of these reporters.
const PLAIN_WORD_REPORTERS: &[&str] = &["Alaska", "Black", "Cranch", "Dakota", "Guam", "Hawaii", "Hun", "Idaho", "Iowa", "Ohio", "Otto", "Utah"];

fn key(abbreviation: &str) -> String {
    abbreviation.chars().filter(|c| !c.is_whitespace()).map(|c| if c == '\u{2019}' { '\'' } else { c }).collect()
}

/// Whether an abbreviation is distinctive enough to search for.
fn searchable(abbreviation: &str) -> bool {
    let distinctive = abbreviation.contains('.')
        || abbreviation.chars().any(|c| c.is_ascii_digit())
        || abbreviation.as_bytes().windows(2).any(|pair| pair[0].is_ascii_uppercase() && pair[1].is_ascii_uppercase());
    distinctive || abbreviation.trim().contains(char::is_whitespace) || PLAIN_WORD_REPORTERS.contains(&abbreviation)
}

/// A pattern for one abbreviation that tolerates spacing differences after periods and before
/// series numbers ("F.3d", "F. 3d"; "U.S.", "U. S.") and either apostrophe.
fn pattern(abbreviation: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    for word in abbreviation.split_whitespace() {
        let mut current = String::new();
        for c in word.chars() {
            current.push(c);
            if c == '.' {
                tokens.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
    }
    let mut out = String::new();
    for (index, token) in tokens.iter().enumerate() {
        if index > 0 {
            let previous = &tokens[index - 1];
            let tight = previous.ends_with('.') || token.starts_with(|c: char| c.is_ascii_digit() || c == '(' || c == '[');
            out.push_str(if tight { r"\s*" } else { r"\s+" });
        }
        out.push_str(&regex::escape(token).replace(['\'', '\u{2019}'], "['\u{2019}]"));
    }
    out
}

fn alternation(mut abbreviations: Vec<&String>) -> String {
    // Longest first, so "F. Supp. 3d" is preferred to "F." at the same position.
    abbreviations.sort_by(|a, b| key(b).len().cmp(&key(a).len()).then_with(|| a.cmp(b)));
    abbreviations.dedup();
    abbreviations.into_iter().map(|abbreviation| pattern(abbreviation)).collect::<Vec<_>>().join("|")
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let data: Data = serde_json::from_str(DATA).expect("reporters-db.json");
        let mut canonical = HashMap::new();
        for (variation, edition) in &data.variations {
            canonical.entry(key(variation)).or_insert_with(|| edition.clone());
        }
        // An edition always stands for itself, even where a variation strips to the same key.
        for edition in data.editions.keys() {
            canonical.insert(key(edition), edition.clone());
        }
        // A short one-word variation ("R.", "App.") names too many things (record cites, other
        // courts) to stand for a reporter; editions themselves are always searched.
        let distinctive_variation = |a: &&String| a.contains(char::is_whitespace) || a.chars().any(|c| c.is_ascii_digit()) || a.chars().filter(|c| c.is_alphabetic()).count() > 4;
        let all: Vec<&String> = data.editions.keys().chain(data.variations.keys().filter(distinctive_variation)).filter(|a| searchable(a)).collect();
        let neutral: Vec<&String> = all
            .iter()
            .copied()
            .filter(|a| !a.contains(char::is_whitespace))
            .filter(|a| canonical.get(&key(a)).and_then(|edition| data.editions.get(edition)).is_some_and(|types| types.iter().any(|t| t == "neutral")))
            .collect();
        let build = |source: String| regex::RegexBuilder::new(&source).size_limit(256 << 20).dfa_size_limit(64 << 20).build().expect("citation pattern");
        // Volume, reporter (optionally with an early Supreme Court nominative such as
        // "(1 Cranch)"), an optional comma, and a page (or the blank "___" of a slip cite).
        let full = build(format!(
            r"\b(?P<volume>[0-9]{{1,4}})\s+(?P<reporter>{})(?:\s*\((?:[0-9]{{1,2}}\s+)?[A-Z][A-Za-z.]*\))?,?\s+(?P<page>[0-9]{{1,8}}|_{{3,}})\b",
            alternation(all)
        ));
        let hyphenated = build(format!(r"\b(?P<volume>(?:17|18|19|20)[0-9]{{2}})-(?P<reporter>{})-(?P<page>[0-9]{{1,8}})\b", alternation(neutral)));
        Table { full, hyphenated, canonical, cite_types: data.editions }
    })
}

/// Reporters whose "volume" is always a year (format-neutral, Westlaw and Lexis cites).
fn year_volume_only(table: &Table, edition: &str) -> bool {
    table.cite_types.get(edition).is_some_and(|types| types.iter().all(|t| matches!(t.as_str(), "neutral" | "specialty_west" | "specialty_lexis")))
}

fn scan(table: &Table, pattern: &regex::Regex, text: &str, found: &mut Vec<Citation>) {
    let mut at = 0;
    while at < text.len() {
        let Some(captures) = pattern.captures_at(text, at) else { break };
        let whole = captures.get(0).expect("match");
        let (volume, reporter, page) = (&captures["volume"], &captures["reporter"], &captures["page"]);
        // Docket numbers and dates ("12-410 U.S.", "3/2021 WL") are not volumes.
        let preceded = text[..whole.start()].chars().next_back().is_some_and(|c| matches!(c, '-' | '/' | '\u{2013}'));
        let edition = table.canonical.get(&key(reporter));
        let accepted = match edition {
            Some(edition) if !preceded => !year_volume_only(table, edition) || (volume.len() == 4 && matches!(&volume[..2], "17" | "18" | "19" | "20")),
            _ => false,
        };
        if accepted {
            let page = if page.starts_with('_') { "___" } else { page };
            found.push(Citation {
                volume: volume.to_string(),
                reporter: edition.expect("accepted").clone(),
                page: page.to_string(),
                raw: whole.as_str().to_string(),
                start: whole.start(),
                end: whole.end(),
            });
            at = whole.end();
        } else {
            // Try again one character later: a rejected match may hide a real one.
            at = whole.start() + text[whole.start()..].chars().next().map_or(1, char::len_utf8);
        }
    }
}

/// Every full case reporter citation in `text`, in order of appearance.
pub fn extract(text: &str) -> Vec<Citation> {
    let table = table();
    let mut found = Vec::new();
    scan(table, &table.full, text, &mut found);
    let mut hyphenated = Vec::new();
    scan(table, &table.hyphenated, text, &mut hyphenated);
    hyphenated.retain(|h| !found.iter().any(|f| f.start < h.end && h.start < f.end));
    found.extend(hyphenated);
    found.sort_by_key(|citation| citation.start);
    found
}

/// The normalized citations in `text`.
pub fn normalized_all(text: &str) -> Vec<String> {
    extract(text).iter().map(normalized).collect()
}

/// Sources the task may cite: its scope plus the sources its own captures created.
fn task_sources(case: &Case, task: &str) -> Result<HashSet<String>> {
    let scope: String = case.db.query_row("SELECT scope FROM tasks WHERE id=?", [task], |row| row.get(0))?;
    let mut sources: HashSet<String> = serde_json::from_str::<Vec<String>>(&scope).unwrap_or_default().into_iter().collect();
    if let Some(created) = case.meta(&format!("task_created_sources:{task}"))? {
        sources.extend(serde_json::from_str::<Vec<String>>(&created).unwrap_or_default());
    }
    Ok(sources)
}

/// Normalized citations of research authorities in the task's scope: the citation printed in the
/// captured document, and the agent's claimed citation unless it was flagged as a mismatch.
fn captured(case: &Case, task: &str) -> Result<HashSet<String>> {
    let sources = task_sources(case, task)?;
    let mut statement = case.db.prepare(
        "SELECT v.content,v.source_ids FROM evidence_versions v JOIN evidence_objects o ON o.id=v.object_id WHERE o.kind='authority' AND v.actor=?",
    )?;
    let rows = statement.query_map([super::capture::ACTOR], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut citations = HashSet::new();
    for row in rows {
        let (content, source_ids) = row?;
        let content: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
        let mut linked: Vec<String> = serde_json::from_str(&source_ids).unwrap_or_default();
        linked.extend(content["original_source_id"].as_str().map(str::to_string));
        if !linked.iter().any(|source| sources.contains(source)) {
            continue;
        }
        let citation = &content["citation"];
        if let Some(raw) = citation["raw"].as_str() {
            citations.extend(normalized_all(raw));
        }
        // The agent's claimed citation counts when the document confirmed it: it matched the
        // printed citation, or (with no printed citation found) it appears in the document text.
        if citation["mismatch"] == Value::Bool(false) || citation["claimed_in_text"] == Value::Bool(true) {
            if let Some(claimed) = citation["claimed"].as_str() {
                citations.extend(normalized_all(claimed));
            }
        }
    }
    Ok(citations)
}

/// Reporter citations in `texts` that are neither a research authority captured in the task's
/// scope nor mentioned in `gaps`, normalized and de-duplicated, in order of appearance.
pub fn uncaptured(case: &Case, task: &str, texts: &[&str], gaps: &[&str]) -> Result<Vec<String>> {
    uncaptured_since(case, task, texts, &[], gaps)
}

/// As `uncaptured`, ignoring citations already present in `prior` (the revision being updated)
/// and citations printed in the task's own non-research sources (the case's briefs and filings
/// are evidence of what they cite; research captures are not evidence of what *they* cite).
pub fn uncaptured_since(case: &Case, task: &str, texts: &[&str], prior: &[&str], gaps: &[&str]) -> Result<Vec<String>> {
    let cited: Vec<Citation> = texts.iter().flat_map(|text| extract(text)).collect();
    if cited.is_empty() {
        return Ok(Vec::new());
    }
    let captured = captured(case, task)?;
    let known: HashSet<String> = gaps.iter().chain(prior).flat_map(|text| normalized_all(text)).collect();
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for citation in cited {
        let normal = normalized(&citation);
        if !captured.contains(&normal) && !known.contains(&normal) && seen.insert(normal.clone()) {
            missing.push(normal);
        }
    }
    if !missing.is_empty() {
        let printed = in_case_sources(case, task, &missing)?;
        missing.retain(|citation| !printed.contains(citation));
    }
    Ok(missing)
}

/// Sources created by research captures (anywhere in the case).
fn research_sources(case: &Case) -> Result<HashSet<String>> {
    let mut statement = case.db.prepare("SELECT v.content,v.source_ids FROM evidence_versions v JOIN evidence_objects o ON o.id=v.object_id WHERE o.kind='authority' AND v.actor=?")?;
    let rows = statement.query_map([super::capture::ACTOR], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut sources = HashSet::new();
    for row in rows {
        let (content, source_ids) = row?;
        sources.extend(serde_json::from_str::<Vec<String>>(&source_ids).unwrap_or_default());
        let content: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
        sources.extend(content["original_source_id"].as_str().map(str::to_string));
    }
    Ok(sources)
}

/// Which of `wanted` are printed in the active text of the task's non-research sources.
fn in_case_sources(case: &Case, task: &str, wanted: &[String]) -> Result<HashSet<String>> {
    use rusqlite::OptionalExtension;
    let research = research_sources(case)?;
    let mut found = HashSet::new();
    for source in task_sources(case, task)?.difference(&research) {
        let text: Option<String> = case.db.query_row("SELECT text FROM extracts WHERE source_id=?", [source], |row| row.get(0)).optional()?;
        let Some(text) = text else { continue };
        found.extend(normalized_all(&text).into_iter().filter(|citation| wanted.contains(citation)));
        if found.len() == wanted.len() {
            break;
        }
    }
    Ok(found)
}

/// Whether the task has actually browsed with the research browser (opened a page, acted,
/// searched or captured), not merely asked for its status.
fn browsed(case: &Case, task: &str) -> Result<bool> {
    let Some(raw) = case.meta(&format!("research_usage:{task}"))? else { return Ok(false) };
    let usage: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(["navigations", "actions", "queries", "captures"].iter().any(|field| usage[*field].as_u64().unwrap_or(0) > 0))
}

/// Refuses a final answer that cites reporter citations the task did not capture, when the task
/// has browsed with the research browser. Tasks without research are unaffected. Citations the
/// answer lists in its gaps are allowed.
pub fn guard(case: &Case, task: &str, texts: &[&str], gaps: &[&str]) -> Result<()> {
    check(case, task, texts, &[], gaps, true)
}

/// The guard for records and work products, which have no gaps: citations already in the
/// revision being updated (`prior`) are allowed.
pub fn guard_revision(case: &Case, task: &str, texts: &[&str], prior: &[&str]) -> Result<()> {
    check(case, task, texts, prior, &[], false)
}

fn check(case: &Case, task: &str, texts: &[&str], prior: &[&str], gaps: &[&str], has_gaps: bool) -> Result<()> {
    if !browsed(case, task)? {
        return Ok(());
    }
    let missing = uncaptured_since(case, task, texts, prior, gaps)?;
    const SHOWN: usize = 20;
    let more = missing.len().saturating_sub(SHOWN);
    ensure!(
        missing.is_empty(),
        "Capture these authorities with research_capture before citing them{}: {}{}",
        if has_gaps { ", or list them in gaps as not verified" } else { ", or leave them out" },
        missing.iter().take(SHOWN).cloned().collect::<Vec<_>>().join("; "),
        if more > 0 { format!("; and {more} more") } else { String::new() }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cites(text: &str) -> Vec<String> {
        normalized_all(text)
    }

    #[test]
    fn extracts_common_reporters_and_canonicalizes_variations() {
        for (text, expected) in [
            ("Roe v. Wade, 410 U.S. 113 (1973).", "410 U.S. 113"),
            ("410 U. S. 113", "410 U.S. 113"),
            ("123 F.3d 456 (9th Cir. 2001)", "123 F.3d 456"),
            ("123 F. 3d 456", "123 F.3d 456"),
            ("123 F3d 456", "123 F.3d 456"),
            ("12 F. Supp. 3d 45", "12 F. Supp. 3d 45"),
            ("12 F.Supp.3d 45", "12 F. Supp. 3d 45"),
            ("12 F. Supp. 2d 45", "12 F. Supp. 2d 45"),
            ("93 S.Ct. 705", "93 S. Ct. 705"),
            ("35 L. Ed. 2d 147", "35 L. Ed. 2d 147"),
            ("45 F.4th 1", "45 F.4th 1"),
            ("500 F. App'x 12", "500 F. App'x 12"),
            ("500 F. App\u{2019}x 12", "500 F. App'x 12"),
            ("100 A.3d 200", "100 A.3d 200"),
            ("250 Cal. Rptr. 3d 10", "250 Cal. Rptr. 3d 10"),
            ("5 Cal. 5th 100", "5 Cal. 5th 100"),
            ("300 N.E.2d 1", "300 N.E.2d 1"),
            ("2021 WL 1234567 (S.D.N.Y. Mar. 1, 2021)", "2021 WL 1234567"),
            ("2020 U.S. Dist. LEXIS 12345", "2020 U.S. Dist. LEXIS 12345"),
            ("2019-Ohio-1234", "2019 Ohio 1234"),
            ("2019 ND 123", "2019 ND 123"),
            ("597 U.S. ___ (2022)", "597 U.S. ___"),
            ("5 U.S. (1 Cranch) 137", "5 U.S. 137"),
            ("5 Cranch 137", "5 Cranch 137"),
        ] {
            assert_eq!(cites(text), [expected], "{text}");
        }
    }

    #[test]
    fn pin_cites_parentheticals_and_parallel_cites() {
        let text = "See Roe v. Wade, 410 U.S. 113, 120, 93 S. Ct. 705, 35 L. Ed. 2d 147 (1973) (holding that ...); cf. 123 F.3d 456, 460 n.4.";
        assert_eq!(cites(text), ["410 U.S. 113", "93 S. Ct. 705", "35 L. Ed. 2d 147", "123 F.3d 456"]);
        let found = extract("Cite: 410 U.S. 113, 120.");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].volume.as_str(), found[0].reporter.as_str(), found[0].page.as_str()), ("410", "U.S.", "113"));
        assert_eq!(found[0].raw, "410 U.S. 113");
        assert_eq!(&"Cite: 410 U.S. 113, 120."[found[0].start..found[0].end], "410 U.S. 113");
        assert_eq!(cites("410 U.S.\n113"), ["410 U.S. 113"]);
    }

    #[test]
    fn statutes_regulations_journals_and_prose_are_not_case_citations() {
        for text in [
            "12 U.S.C. § 1234",
            "Section 12 U.S.C. 1234",
            "42 U.S.C. 1983",
            "29 C.F.R. 1910.1200",
            "85 Fed. Reg. 12345",
            "124 Stat. 119",
            "100 Harv. L. Rev. 123",
            "Section 12 of the Act",
            "within 3 Day 45 of notice",
            "a 5 Hill 20 metre climb",
            "410 U.S. at 120",
            "Id. at 5.",
            "No citation here",
            "Case No. 12-410 U.S. 113",
            "Suite 200 PA 19103",
            "5 WL 12345",
            "18 U.S.C.A. 1030",
            "28 U.S.C.S. 1331",
            "Pub. L. No. 111-148, 124 Stat. 119",
            "Fed. R. Civ. P. 56",
            "Cal. Civ. Code § 1714",
            "35 Pa. C.S. § 1",
            "735 Ill. Comp. Stat. 5/2-619",
            "Rule 12(b)(6)",
            "Exhibit 5 at 12; page 3 of 10",
            "On March 3 2020 the parties met at 10 Main St.",
        ] {
            assert!(cites(text).is_empty(), "{text}: {:?}", cites(text));
        }
    }

    #[test]
    fn normalization_is_stable_across_spacing() {
        let a = extract("123  F. 3d   456");
        let b = extract("123 F.3d 456");
        assert_eq!(normalized(&a[0]), normalized(&b[0]));
        assert_eq!(a[0].raw, "123  F. 3d   456");
    }

    #[test]
    fn the_vendored_table_loads_quickly_enough() {
        let started = std::time::Instant::now();
        let _ = table();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(table().canonical.len() > 3000);
    }
}
