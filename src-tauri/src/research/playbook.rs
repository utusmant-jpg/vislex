//! Site playbook: which part of a research page is the document (opinion or statute) and which
//! regions are the publisher's editorial content. Selectors are data: they travel to fixed page
//! functions as DevTools call arguments and are never spliced into JavaScript.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

const SELECTORS_JSON: &str = include_str!("../../resources/research/westlaw-playbook/selectors.json");

/// Refusal given when a page's site has no verified capture selectors.
pub const CAPTURE_UNAVAILABLE: &str = "Capture is not yet available for this site; cite the page URL as a lead";

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Entry {
    pub id: String,
    pub hosts: Vec<String>,
    /// CSS selector of the document container; empty means capture is refused.
    pub content_root: String,
    /// Editorial regions removed from captures and hidden from snapshots.
    pub editorial: Vec<String>,
    /// Loopback fixture entries, usable only in debug test mode.
    #[serde(default)]
    pub test_only: bool,
    #[serde(default)]
    pub status: String,
}

impl Entry {
    pub fn capture_available(&self) -> bool {
        !self.content_root.trim().is_empty()
    }
}

#[derive(serde::Deserialize)]
struct File {
    entries: Vec<Entry>,
}

fn bundled() -> Vec<Entry> {
    serde_json::from_str::<File>(SELECTORS_JSON).map(|file| file.entries).unwrap_or_default()
}

/// The entries in force for one process.
#[derive(Clone, Debug, Default)]
pub struct Playbook {
    entries: Vec<Entry>,
}

impl Playbook {
    /// Production entries only; loopback fixture entries are never included.
    pub fn production() -> Self {
        Self { entries: bundled().into_iter().filter(|entry| !entry.test_only).collect() }
    }

    /// Production entries plus the loopback fixture entries. Debug builds only.
    #[cfg(debug_assertions)]
    pub fn with_test_entries() -> Self {
        Self { entries: bundled() }
    }

    /// A playbook of synthetic entries, for tests. Debug builds only.
    #[cfg(debug_assertions)]
    pub fn with_entries(entries: Vec<Entry>) -> Self {
        Self { entries }
    }

    /// The playbook for this process: the fixture entries apply only in debug test mode against
    /// the loopback mock origin (where the navigation policy allows nothing else).
    pub fn for_process(sso_hosts: &[String]) -> Self {
        #[cfg(debug_assertions)]
        if super::NavigationPolicy::resolve(sso_hosts.to_vec()).is_ok_and(|policy| policy.is_mock()) {
            return Self::with_test_entries();
        }
        let _ = sso_hosts;
        Self::production()
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The entry for a page URL, by exact host.
    pub fn entry_for(&self, url: &str) -> Option<&Entry> {
        let parsed: reqwest::Url = url.parse().ok()?;
        let host = parsed.host_str()?.to_ascii_lowercase();
        self.entries.iter().find(|entry| entry.hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(&host)))
    }

    /// The entry a capture of `url` must use, or the refusal.
    pub fn capture_entry(&self, url: &str) -> Result<&Entry> {
        match self.entry_for(url) {
            Some(entry) if entry.capture_available() => Ok(entry),
            _ => bail!("{CAPTURE_UNAVAILABLE}"),
        }
    }

    /// Every editorial selector, hidden from snapshots on every page.
    pub fn editorial_selectors(&self) -> Vec<String> {
        let mut selectors: Vec<String> = self.entries.iter().flat_map(|entry| entry.editorial.iter().cloned()).collect();
        selectors.sort();
        selectors.dedup();
        selectors
    }

    /// Capture-capable entries as page-function data.
    pub fn page_data(&self) -> Value {
        Value::Array(
            self.entries
                .iter()
                .filter(|entry| entry.capture_available())
                .map(|entry| json!({"id": entry.id, "hosts": entry.hosts, "content_root": entry.content_root, "editorial": entry.editorial}))
                .collect(),
        )
    }

    /// Looks up an entry by id (to confirm the page chose the entry Rust expects).
    pub fn entry(&self, id: &str) -> Result<&Entry> {
        self.entries.iter().find(|entry| entry.id == id).context(CAPTURE_UNAVAILABLE)
    }
}

/// Westlaw page knowledge for the macro tools and captures: fixed page functions that find the
/// global search box, read a results list and read KeyCite signals by page structure (roles,
/// headings, links and labels, not class names), and the Rust parsers that turn what they return
/// into compact results. Page functions take model values only as call arguments.
pub mod westlaw {
    use serde_json::{json, Value};

    use crate::research::{capture, citations};

    /// Most result rows returned by one search.
    pub const MAX_ROWS: usize = 20;
    /// Snippets kept per result row.
    pub const MAX_SNIPPETS: usize = 3;

    /// Whether `host` is a Westlaw host.
    pub fn is_westlaw_host(host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        host == "westlaw.com" || host.ends_with(".westlaw.com")
    }

    /// The global search box: a visible, enabled text input, textarea or editable region whose
    /// label (aria-label, placeholder, title, name, id, label elements, aria-labelledby) mentions
    /// "search"; "Search within results" style boxes rank last. Returns the element or null.
    pub const SEARCH_BOX_FN: &str = r#"function () {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = e => {
    const parts = [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title'), e.getAttribute('name'), e.id];
    if (e.labels) for (const item of Array.from(e.labels)) parts.push(item.textContent);
    for (const id of (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) { const target = document.getElementById(id); if (target) parts.push(target.textContent); }
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  };
  const candidates = [];
  for (const e of document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
    if (e.tagName === 'INPUT' && !['', 'text', 'search'].includes((e.getAttribute('type') || '').toLowerCase())) continue;
    if (!visible(e) || e.disabled || e.readOnly) continue;
    const text = label(e);
    if (!/search/i.test(text)) continue;
    let score = 0;
    if (/suggestions|search westlaw|global|main search/i.test(text)) score += 4;
    if (/within|filter|refine|narrow/i.test(text)) score -= 6;
    if (e.getAttribute('role') === 'combobox' || e.getAttribute('role') === 'searchbox') score += 1;
    candidates.push({ e, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].e : null;
}"#;

    /// The search button beside a search box: a visible button whose label starts with "Search"
    /// ("Search Westlaw Advantage"). Returns the element or null.
    pub const SEARCH_BUTTON_FN: &str = r#"function () {
  for (const e of document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')) {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || e.disabled) continue;
    const text = [e.getAttribute('aria-label'), e.getAttribute('title'), e.value, e.textContent].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (/^search\b/i.test(text) && !/within|filter|refine/i.test(text)) return e;
  }
  return null;
}"#;

    /// Reads a results page: rows under "N. Title" level-3 headings that link to a /Document/
    /// page (rank, title, url, court/date/citation line, summary, snippets and any KeyCite flag
    /// text), category counts such as "Cases (66)", and whether the page says nothing was found.
    pub const RESULTS_FN: &str = r#"function (limit) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const shown = element => { for (let e = element; e && e !== document.body; e = e.parentElement) { if (getComputedStyle(e).display === 'none') return false; } return true; };
  const spaced = element => {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const text = walker.currentNode.nodeValue.trim(); if (text && shown(walker.currentNode.parentElement)) parts.push(text); }
    return clean(parts.join(' '));
  };
  const flagTexts = root => {
    const found = [];
    for (const e of root.querySelectorAll('img[alt], [title], [aria-label]')) {
      for (const value of [e.getAttribute('alt'), e.getAttribute('title'), e.getAttribute('aria-label')]) { const text = clean(value); if (text && text.length <= 120 && /\b(flag|circle)\b/i.test(text) && !found.includes(text)) found.push(text); }
    }
    return found.slice(0, 3);
  };
  const headingSelector = 'h3, [role=heading][aria-level="3"]';
  const rows = [];
  for (const heading of document.querySelectorAll(headingSelector)) {
    if (rows.length >= limit) break;
    const link = heading.querySelector('a[href*="/Document/"]') || heading.closest('a[href*="/Document/"]');
    if (!link) continue;
    const headingText = clean(heading.innerText || heading.textContent);
    const numbered = /^(\d+)\.\s*(.*)$/.exec(headingText);
    if (!numbered) continue;
    let container = heading;
    while (container.parentElement && container.parentElement !== document.body) {
      const parent = container.parentElement;
      if (parent.querySelectorAll(headingSelector).length > 1) break;
      container = parent;
      if (container.tagName === 'LI' || container.getAttribute('role') === 'listitem' || container.tagName === 'ARTICLE') break;
    }
    const blocks = [];
    const walk = element => {
      for (const child of Array.from(element.children)) {
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(child.tagName)) continue;
        if (child === heading || heading.contains(child)) continue;
        if (child.contains(heading)) { walk(child); continue; }
        if (clean(child.innerText || child.textContent)) blocks.push(child);
      }
    };
    walk(container);
    const snippetLinks = block => Array.from(block.querySelectorAll('a')).filter(a => a !== link && clean(a.innerText || a.textContent).length >= 20);
    let citationLine = '', summary = '';
    const snippets = [];
    for (const block of blocks) {
      const text = spaced(block);
      const links = snippetLinks(block);
      if (!citationLine && !links.length && /\b(1[6-9]|20)\d\d\b/.test(text)) { citationLine = text; continue; }
      if (links.length) { for (const a of links) snippets.push(clean(a.innerText || a.textContent)); continue; }
      if (!summary && citationLine && text.length >= 30) { summary = clean(block.innerText || block.textContent); continue; }
      if (citationLine && summary && text.length >= 20) snippets.push(clean(block.innerText || block.textContent));
    }
    rows.push({ rank: Number(numbered[1]), title: clean(numbered[2]) || clean(link.innerText || link.textContent), url: String(link.href || ''), citation_line: citationLine, summary, snippets: snippets.slice(0, 3), flags: flagTexts(container) });
  }
  // Category counts, one per label; a heading ("Cases (66)" above the list) wins over a link.
  const counts = [];
  const byLabel = new Map();
  for (const e of document.querySelectorAll('h1, h2, h3, [role=heading], a, button, [role=tab], li, span')) {
    const raw = e.textContent || '';
    if (raw.length > 80) continue;
    const match = /^([A-Za-z][A-Za-z&,'\/ ]{1,40}?)\s*\(\s*([\d,]+)\s*\)$/.exec(clean(raw));
    if (!match) continue;
    const entry = { label: match[1], count: Number(match[2].replace(/,/g, '')), heading: /^H[1-3]$/.test(e.tagName) || e.getAttribute('role') === 'heading' };
    const key = match[1].toLowerCase();
    if (byLabel.has(key)) { if (entry.heading && !counts[byLabel.get(key)].heading) counts[byLabel.get(key)] = entry; continue; }
    if (counts.length >= 30) continue;
    byLabel.set(key, counts.length);
    counts.push(entry);
  }
  const region = document.querySelector('main, [role=main]') || document.body;
  const none = /no documents found|no results found|returned no results|no documents match/i.test(region.textContent || '');
  return { url: location.href, title: document.title, rows, counts, no_results: none && !rows.length };
}"#;

    /// A content-type link on a results page ("Cases (66)"), by its label. Returns the element or null.
    pub const CATEGORY_LINK_FN: &str = r#"function (labels) {
  const wanted = labels.map(label => label.toLowerCase());
  for (const e of document.querySelectorAll('a, [role=tab], [role=link], button')) {
    const raw = e.textContent || '';
    if (raw.length > 80) continue;
    const text = raw.replace(/\s+/g, ' ').trim();
    const match = /^(.*?)\s*\(\s*[\d,]+\s*\)$/.exec(text);
    const r = e.getBoundingClientRect();
    if (match && wanted.includes(match[1].toLowerCase()) && r.width > 0 && r.height > 0) return e;
  }
  return null;
}"#;

    /// KeyCite signals shown on the page: flag texts (alt, title or aria-label of flag and circle
    /// icons, in page order) and the KeyCite tabs with their counts and addresses.
    pub const KEYCITE_FN: &str = r#"function () {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const flags = [];
  for (const e of document.querySelectorAll('img[alt], [title], [aria-label]')) {
    for (const value of [e.getAttribute('alt'), e.getAttribute('title'), e.getAttribute('aria-label')]) {
      const text = clean(value);
      if (text && text.length <= 120 && /\b(flag|circle)\b/i.test(text) && !flags.includes(text)) flags.push(text);
    }
    if (flags.length >= 10) break;
  }
  const tabs = [];
  const seen = new Set();
  for (const e of document.querySelectorAll('a, button, [role=tab], li, span')) {
    const raw = e.textContent || '';
    if (raw.length > 80) continue;
    const match = /^(Negative Treatment|History|Citing References|Filings|Table of Authorities)\s*\(\s*([\d,]+)\s*\)/i.exec(clean(raw));
    if (!match || seen.has(match[1].toLowerCase())) continue;
    seen.add(match[1].toLowerCase());
    const link = e.closest('a') || e.querySelector('a');
    tabs.push({ label: clean(match[1]), count: Number(match[2].replace(/,/g, '')), url: link && link.href ? String(link.href) : '' });
  }
  return { url: location.href, flags, tabs };
}"#;

    /// The KeyCite flag a flag text names: red, yellow, blue_striped, orange, or unknown.
    pub fn normalize_flag(text: &str) -> &'static str {
        let text = text.to_ascii_lowercase().replace(['-', '_'], " ");
        if text.contains("red flag") {
            "red"
        } else if text.contains("yellow flag") {
            "yellow"
        } else if text.contains("blue") && text.contains("strip") {
            "blue_striped"
        } else if text.contains("orange") {
            "orange"
        } else {
            "unknown"
        }
    }

    fn count(tabs: &[Value], label: &str) -> Value {
        tabs.iter().find(|tab| tab["label"].as_str().is_some_and(|text| text.eq_ignore_ascii_case(label))).map(|tab| tab["count"].clone()).unwrap_or(Value::Null)
    }

    /// Normalizes what KEYCITE_FN returned: the flag (red, yellow, blue_striped, orange; none
    /// when the KeyCite tabs show but no flag does; unknown when the page shows no KeyCite), the
    /// flag text as shown, the tab counts and addresses, and when it was observed. Null for no data.
    pub fn keycite(page: &Value) -> Value {
        if !page.is_object() {
            return Value::Null;
        }
        let flags: Vec<&str> = page["flags"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let tabs: Vec<Value> = page["tabs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|tab| tab["label"].is_string() && tab["count"].is_u64())
            .take(10)
            .map(|tab| json!({"label": tab["label"].as_str().unwrap_or_default().chars().take(60).collect::<String>(), "count": tab["count"], "url": tab["url"].as_str().filter(|url| url.len() <= 2_048 && url.starts_with("http")).unwrap_or_default()}))
            .collect();
        let flag_text = flags.iter().find(|text| normalize_flag(text) != "unknown").copied();
        let flag = match flag_text {
            Some(text) => normalize_flag(text),
            None if !count(&tabs, "Negative Treatment").is_null() || !count(&tabs, "History").is_null() => "none",
            None => "unknown",
        };
        json!({
            "flag": flag,
            "flag_text": flag_text.map(|text| text.chars().take(120).collect::<String>()),
            "negative_treatment": count(&tabs, "Negative Treatment"),
            "history": count(&tabs, "History"),
            "citing_references": count(&tabs, "Citing References"),
            "tabs": tabs,
            "observed_at": crate::case::now(),
        })
    }

    fn truncate(value: &Value, max: usize) -> String {
        let text = value.as_str().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
        if text.chars().count() > max { text.chars().take(max).collect::<String>() + "\u{2026}" } else { text }
    }

    /// Compact result rows (at most `MAX_ROWS`) from what RESULTS_FN returned.
    pub fn rows(page: &Value) -> Vec<Value> {
        page["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["url"].as_str().is_some_and(|url| url.starts_with("http") && url.len() <= 4_096))
            .take(MAX_ROWS)
            .map(|row| {
                let flag = row["flags"].as_array().into_iter().flatten().filter_map(Value::as_str).map(normalize_flag).find(|flag| *flag != "unknown");
                json!({
                    "rank": row["rank"],
                    "title": truncate(&row["title"], 300),
                    "url": row["url"],
                    "citation_line": truncate(&row["citation_line"], 400),
                    "keycite_flag": flag,
                    "summary": truncate(&row["summary"], 600),
                    "snippets": row["snippets"].as_array().into_iter().flatten().take(MAX_SNIPPETS).map(|snippet| truncate(snippet, 300)).collect::<Vec<_>>(),
                })
            })
            .collect()
    }

    /// Content-type labels on a results page for a requested content type.
    pub fn content_type_labels(content_type: &str) -> &'static [&'static str] {
        match content_type {
            "cases" => &["Cases"],
            "statutes" => &["Statutes & Court Rules", "Statutes and Court Rules", "Statutes"],
            "secondary" => &["Secondary Sources"],
            _ => &[],
        }
    }

    /// The results count: the first count shown as a heading, else the first category count.
    pub fn total(page: &Value) -> (Value, Value) {
        let counts: Vec<&Value> = page["counts"].as_array().into_iter().flatten().collect();
        let chosen = counts.iter().find(|count| count["heading"] == true).or_else(|| counts.first());
        match chosen {
            Some(count) => (count["count"].clone(), json!(format!("{} ({})", count["label"].as_str().unwrap_or_default(), count["count"]))),
            None => (Value::Null, Value::Null),
        }
    }

    /// Category counts as {label, count}, at most 12.
    pub fn category_counts(page: &Value) -> Vec<Value> {
        page["counts"].as_array().into_iter().flatten().take(12).map(|count| json!({"label": truncate(&count["label"], 60), "count": count["count"]})).collect()
    }

    fn date_pattern() -> &'static regex::Regex {
        static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        PATTERN.get_or_init(|| {
            regex::Regex::new(r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s*((?:17|18|19|20)\d{2})").expect("date pattern")
        })
    }

    /// "June 20, 2012" as 2012-06-20.
    fn iso_date(captures: &regex::Captures) -> Option<String> {
        let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].iter().position(|name| captures[1].to_ascii_lowercase().starts_with(name))? as u32 + 1;
        let date = chrono::NaiveDate::from_ymd_opt(captures[3].parse().ok()?, month, captures[2].parse().ok()?)?;
        Some(date.format("%Y-%m-%d").to_string())
    }

    /// What a Westlaw document's header says about it, read from its text lines (numbered as
    /// research_read_page numbers them): the court line, the decision date, every citation the
    /// document prints for itself, and reporting notes.
    pub fn document_header(lines: &[&str]) -> Value {
        let header: Vec<String> = lines.iter().take(40).map(|line| capture::split_run_together(line)).collect();
        let court_pattern = regex::Regex::new(r"\b(Court|Supreme|Appeals|Circuit|Tribunal|Commission)\b").expect("pattern");
        // Only the court, when the date and citations ran onto the same line.
        let before_date = |line: &str| date_pattern().find(line).map_or(line.to_string(), |found| line[..found.start()].to_string());
        let court = header
            .iter()
            .map(|line| before_date(line).trim().trim_end_matches(',').trim().to_string())
            .find(|text| court_pattern.is_match(text) && text.chars().count() <= 300 && citations::extract(text).is_empty());
        let decided_line = header.iter().find(|line| line.to_ascii_lowercase().contains("decided") && date_pattern().is_match(line)).or_else(|| header.iter().find(|line| date_pattern().is_match(line)));
        let decided = decided_line.and_then(|line| date_pattern().captures(line)).map(|captures| json!({"text": captures[0].to_string(), "date": iso_date(&captures)}));
        let notes_pattern = regex::Regex::new(r"(?i)not reported in [^\s,;]+|check .{0,60}rules for reporting|unpublished|not for publication|nonprecedential|not designated for publication|memorandum opinion").expect("pattern");
        let mut notes: Vec<String> = Vec::new();
        for line in lines.iter().take(60).map(|line| capture::split_run_together(line)) {
            for found in notes_pattern.find_iter(&line) {
                let note = if found.as_str().to_ascii_lowercase().starts_with("not reported in") { found.as_str().to_string() } else { line.chars().take(300).collect() };
                if !notes.contains(&note) {
                    notes.push(note);
                }
            }
            if notes.len() >= 5 {
                break;
            }
        }
        json!({
            "court": court,
            "decided": decided,
            "citations": capture::parallel_citations(lines),
            "all_citations": capture::all_citations_text(lines),
            "reporting_notes": notes,
        })
    }

    /// A page title without the site suffix ("Stow v. Paster | Westlaw" -> "Stow v. Paster").
    pub fn document_title(title: &str) -> String {
        let title = title.trim();
        for separator in [" | ", " - "] {
            if let Some((head, tail)) = title.rsplit_once(separator) {
                if tail.to_ascii_lowercase().contains("westlaw") {
                    return head.trim().to_string();
                }
            }
        }
        title.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn westlaw_keycite_flags_and_counts_are_normalized() {
        use westlaw::{keycite, normalize_flag};
        for (text, flag) in [
            ("Red Flag - Severe Negative Treatment", "red"),
            ("Yellow Flag - Negative Treatment", "yellow"),
            ("Blue Striped Flag", "blue_striped"),
            ("Blue-striped flag: appealed", "blue_striped"),
            ("Orange Circle", "orange"),
            ("KeyCite", "unknown"),
        ] {
            assert_eq!(normalize_flag(text), flag, "{text}");
        }
        let page = json!({"flags": ["Print flag", "Red Flag - Severe Negative Treatment", "Yellow Flag - Negative Treatment"], "tabs": [{"label": "Negative Treatment", "count": 0, "url": "https://1.next.westlaw.com/RelatedInformation/I1/kcNegativeTreatment.html"}, {"label": "History", "count": 2, "url": ""}, {"label": "Citing References", "count": 9, "url": "javascript:void(0)"}]});
        let seen = keycite(&page);
        assert_eq!((seen["flag"].as_str(), seen["flag_text"].as_str()), (Some("red"), Some("Red Flag - Severe Negative Treatment")), "the first recognised flag, in page order");
        assert_eq!((seen["negative_treatment"].as_u64(), seen["history"].as_u64(), seen["citing_references"].as_u64()), (Some(0), Some(2), Some(9)));
        assert_eq!(seen["tabs"][2]["url"], "", "only web addresses are kept");
        assert!(seen["observed_at"].is_string());
        // KeyCite tabs without a flag: no negative treatment flag. No KeyCite at all: unknown.
        assert_eq!(keycite(&json!({"flags": [], "tabs": [{"label": "History", "count": 1, "url": ""}]}))["flag"], "none");
        assert_eq!(keycite(&json!({"flags": [], "tabs": []}))["flag"], "unknown");
        assert!(keycite(&Value::Null).is_null());
    }

    #[test]
    fn westlaw_document_headers_are_read_from_the_lines() {
        let lines = [
            "Stow v. Paster",
            "Court of Appeals of Ohio, Ninth District, Summit County.June 20, 2012Not Reported in N.E.2d2012 WL 23369142012 -Ohio- 2746 (Approx. 6 pages)",
            "CHECK OHIO SUPREME COURT RULES FOR REPORTING OF OPINIONS AND WEIGHT OF LEGAL AUTHORITY.",
            "Opinion",
            "The judgment is affirmed.",
            "All Citations",
            "Not Reported in N.E.2d, 2012 WL 2336914, 2012 -Ohio- 2746",
        ];
        let header = westlaw::document_header(&lines);
        assert_eq!(header["court"], "Court of Appeals of Ohio, Ninth District, Summit County.");
        assert_eq!(header["decided"], json!({"text": "June 20, 2012", "date": "2012-06-20"}));
        assert_eq!(header["citations"], json!(["2012 WL 2336914", "2012 Ohio 2746"]));
        assert_eq!(header["all_citations"], "Not Reported in N.E.2d, 2012 WL 2336914, 2012 -Ohio- 2746");
        let notes: Vec<&str> = header["reporting_notes"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(notes, ["Not Reported in N.E.2d", "CHECK OHIO SUPREME COURT RULES FOR REPORTING OF OPINIONS AND WEIGHT OF LEGAL AUTHORITY."]);
        assert_eq!(westlaw::document_title("Stow v. Paster | Westlaw Advantage"), "Stow v. Paster");
        assert_eq!(westlaw::document_title("Stow v. Paster"), "Stow v. Paster");
        assert!(westlaw::is_westlaw_host("1.next.westlaw.com") && westlaw::is_westlaw_host("westlaw.com") && !westlaw::is_westlaw_host("westlaw.com.evil.example") && !westlaw::is_westlaw_host("notwestlaw.com"));
    }

    #[test]
    fn westlaw_result_rows_are_compact() {
        let long = "x".repeat(2_000);
        let page = json!({"rows": (1..=25).map(|rank| json!({"rank": rank, "title": format!("Case {rank}"), "url": format!("https://1.next.westlaw.com/Document/I{rank}/View/FullText.html"), "citation_line": "Court of Appeals of Ohio. June 20, 2012", "summary": long, "snippets": ["a", "b", "c", "d"], "flags": ["Yellow Flag - Negative Treatment"]})).chain([json!({"rank": 26, "title": "Script", "url": "javascript:alert(1)"})]).collect::<Vec<_>>(), "counts": [{"label": "Overview", "count": 100, "heading": false}, {"label": "Cases", "count": 66, "heading": true}]});
        let rows = westlaw::rows(&page);
        assert_eq!(rows.len(), westlaw::MAX_ROWS);
        assert_eq!(rows[0]["snippets"].as_array().unwrap().len(), westlaw::MAX_SNIPPETS);
        assert!(rows[0]["summary"].as_str().unwrap().chars().count() <= 601);
        assert_eq!(rows[0]["keycite_flag"], "yellow");
        assert_eq!(westlaw::total(&page), (json!(66), json!("Cases (66)")));
    }

    #[test]
    fn bundled_selectors_parse_and_westlaw_capture_is_refused_until_surveyed() {
        let entries = bundled();
        assert!(entries.len() >= 2, "selectors.json must parse");
        let production = Playbook::production();
        assert!(production.entries().iter().all(|entry| !entry.test_only));
        let error = production.capture_entry("https://1.next.westlaw.com/Document/I123/View/FullText.html").unwrap_err().to_string();
        assert_eq!(error, CAPTURE_UNAVAILABLE);
        assert!(production.capture_entry("http://127.0.0.1:9471/opinion.html").is_err(), "the loopback fixture entry is not in production");
        assert!(production.capture_entry("https://evil.example/").is_err());
        assert_eq!(production.page_data(), json!([]));
        let test = Playbook::with_test_entries();
        let fixture = test.capture_entry("http://127.0.0.1:9471/opinion.html").unwrap();
        assert!(fixture.test_only && fixture.editorial.iter().any(|selector| selector == ".headnote"));
        assert!(test.editorial_selectors().contains(&".headnote".to_string()));
        for entry in entries {
            assert!(!entry.id.is_empty() && !entry.hosts.is_empty());
            for selector in entry.editorial.iter().chain(std::iter::once(&entry.content_root)) {
                assert!(!selector.contains(['\n', '`', '{', '}']), "selector {selector:?}");
            }
        }
    }
}
