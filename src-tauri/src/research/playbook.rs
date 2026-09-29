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

#[cfg(test)]
mod tests {
    use super::*;

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
