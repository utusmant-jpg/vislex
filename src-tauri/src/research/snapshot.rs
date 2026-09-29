//! Page observation: the vendored Playwright injected script runs in an isolated DevTools world
//! (invisible to page script) and turns the page into a compact YAML accessibility snapshot with
//! element refs. Refs are resolved inside that world; a navigation destroys the world, so refs
//! from an earlier snapshot fail instead of pointing at the wrong element.
//!
//! Every function run in the page is a fixed string in this file. Values from the model (refs,
//! search text) are passed as DevTools call arguments, never spliced into JavaScript.

use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::{json, Value};

use super::driver::Driver;

/// Playwright 1.63.0 injected script, extracted unchanged by scripts/build-research-injected.mjs.
pub const INJECTED_SCRIPT: &str = include_str!("../../resources/research/injected-script.js");
pub const INJECTED_SCRIPT_SHA256: &str = "93f3fbc1a0d9b18615738fb32a2996cb982877305f21eab67d69169ae6f13de2";
pub const WORLD_NAME: &str = "vislex-research";
pub const DEFAULT_MAX_CHARS: usize = 6_000;
pub const HARD_MAX_CHARS: usize = 12_000;

const INSTALLED_FN: &str = "function () { return Boolean(globalThis.__vislex); }";

/// Snapshot of `root` with editorial subtrees hidden from the accessibility tree for the
/// duration of one synchronous call (restored before returning, never visible on screen).
const SNAPSHOT_FN: &str = r#"function (scope, excluded) {
  const vislex = globalThis.__vislex;
  const root = scope === 'main' ? (document.querySelector('main, [role=main]') || document.body) : document.body;
  const hidden = [];
  for (const selector of excluded) {
    let matches = [];
    try { matches = document.querySelectorAll(selector); } catch (error) { continue; }
    for (const element of matches) { hidden.push([element, element.getAttribute('aria-hidden')]); element.setAttribute('aria-hidden', 'true'); }
  }
  try {
    return { text: vislex.ariaSnapshot(root, { mode: 'ai' }), url: location.href, title: document.title, excluded: hidden.length };
  } finally {
    for (const [element, previous] of hidden) { previous === null ? element.removeAttribute('aria-hidden') : element.setAttribute('aria-hidden', previous); }
  }
}"#;

/// Returns the element for a ref from the latest snapshot, or throws if it is gone.
const RESOLVE_FN: &str = r#"function (ref) {
  const snapshot = globalThis.__vislex && globalThis.__vislex._lastAriaSnapshotForQuery;
  const entry = snapshot && snapshot.info && snapshot.info.get(ref);
  if (!entry || !entry.element || !entry.element.isConnected) throw new Error('stale ref');
  return entry.element;
}"#;

/// Which part of the page to snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Only actionable and structural lines (links, buttons, inputs, headings).
    Interactive,
    /// The main landmark (or the body when the page has none).
    Main,
    /// The whole page.
    Full,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Snapshot {
    pub version: u64,
    pub url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
    pub ref_count: usize,
    /// True when this is a line diff against the previous snapshot.
    pub delta: bool,
}

/// A ref from a snapshot: `e12`, or `f3e12` inside a frame. Anything else is refused before
/// it reaches the page.
pub fn valid_ref(reference: &str) -> bool {
    let rest = reference.strip_prefix('f').map(|rest| rest.trim_start_matches(|c: char| c.is_ascii_digit())).unwrap_or(reference);
    let digits = rest.strip_prefix('e').unwrap_or("");
    reference.len() <= 16 && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

fn is_interactive(line: &str) -> bool {
    const ROLES: &[&str] = &["link", "button", "searchbox", "textbox", "combobox", "checkbox", "radio", "tab", "menuitem", "option", "heading", "listbox", "switch"];
    let trimmed = line.trim_start().trim_start_matches("- ");
    line.contains("[ref=") && ROLES.iter().any(|role| trimmed.starts_with(role) && trimmed[role.len()..].starts_with([' ', ':']))
        || trimmed.starts_with("/url:")
}

/// Lines containing `needle` (case-insensitive) with `context` lines either side.
fn find_lines(lines: &[&str], needle: &str, context: usize) -> Vec<String> {
    let needle = needle.to_lowercase();
    let mut keep = vec![false; lines.len()];
    for (index, line) in lines.iter().enumerate() {
        if line.to_lowercase().contains(&needle) {
            for slot in keep.iter_mut().take((index + context + 1).min(lines.len())).skip(index.saturating_sub(context)) {
                *slot = true;
            }
        }
    }
    lines.iter().zip(keep).filter(|(_, keep)| *keep).map(|(line, _)| line.to_string()).collect()
}

/// Added lines prefixed `+ `, removed `- `, in order; unchanged lines omitted.
fn line_delta(previous: &str, current: &str) -> String {
    let old: std::collections::HashMap<&str, usize> = previous.lines().fold(Default::default(), |mut counts, line| {
        *counts.entry(line).or_default() += 1;
        counts
    });
    // Lines of the previous snapshot not yet matched by the current one.
    let mut remaining = old;
    let mut out = Vec::new();
    for line in current.lines() {
        match remaining.get_mut(line) {
            Some(count) if *count > 0 => *count -= 1,
            _ => out.push(format!("+ {line}")),
        }
    }
    for line in previous.lines() {
        if let Some(count) = remaining.get_mut(line).filter(|count| **count > 0) {
            *count -= 1;
            out.push(format!("- {line}"));
        }
    }
    if out.is_empty() { "unchanged".into() } else { out.join("\n") }
}

/// One research page session: the isolated world, the snapshot version and the last text.
pub struct Session<D: Driver> {
    driver: D,
    context: Option<i64>,
    version: u64,
    /// Snapshot version at the last navigation; refs from earlier snapshots are invalid.
    page_base: u64,
    last_text: Option<String>,
    /// Selectors whose subtrees never appear in snapshots (editorial content on document
    /// and citator pages, from the site playbook).
    pub excluded: Vec<String>,
    /// When the last paced action (navigation or click) happened.
    pub(crate) last_action: Option<std::time::Instant>,
}

impl<D: Driver> Session<D> {
    pub fn new(driver: D) -> Self {
        Self { driver, context: None, version: 0, page_base: 0, last_text: None, excluded: Vec::new(), last_action: None }
    }

    pub fn driver(&self) -> &D {
        &self.driver
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// Forgets the world and invalidates refs; called after any navigation.
    pub fn reset(&mut self) {
        self.context = None;
        self.last_text = None;
        self.version += 1;
        self.page_base = self.version;
    }

    /// Calls a fixed function in the isolated world with JSON arguments.
    pub async fn call_in_world(&mut self, function: &'static str, arguments: &[Value], by_value: bool) -> Result<Value> {
        let context = self.ensure_world().await?;
        let arguments: Vec<Value> = arguments.iter().map(|value| json!({"value": value})).collect();
        let result = self
            .driver
            .call("Runtime.callFunctionOn", json!({"executionContextId": context, "functionDeclaration": function, "arguments": arguments, "returnByValue": by_value, "awaitPromise": true}))
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            let text = exception["exception"]["description"].as_str().or_else(|| exception["text"].as_str()).unwrap_or("page function failed");
            bail!("{}", text.lines().next().unwrap_or(text));
        }
        Ok(result["result"].clone())
    }

    /// Calls a fixed function with `this` bound to a page object (for example a resolved element).
    pub async fn call_on(&self, object_id: &str, function: &'static str, arguments: &[Value]) -> Result<Value> {
        let arguments: Vec<Value> = arguments.iter().map(|value| json!({"value": value})).collect();
        let result = self
            .driver
            .call("Runtime.callFunctionOn", json!({"objectId": object_id, "functionDeclaration": function, "arguments": arguments, "returnByValue": true, "awaitPromise": true}))
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            bail!("{}", exception["exception"]["description"].as_str().unwrap_or("page function failed").lines().next().unwrap_or_default());
        }
        Ok(result["result"]["value"].clone())
    }

    async fn ensure_world(&mut self) -> Result<i64> {
        if let Some(context) = self.context {
            let alive = self
                .driver
                .call("Runtime.callFunctionOn", json!({"executionContextId": context, "functionDeclaration": INSTALLED_FN, "returnByValue": true}))
                .await
                .ok()
                .and_then(|result| result["result"]["value"].as_bool());
            if alive == Some(true) {
                return Ok(context);
            }
            self.reset();
        }
        let tree = self.driver.call("Page.getFrameTree", json!({})).await?;
        let frame = tree["frameTree"]["frame"]["id"].as_str().context("Page has no main frame")?.to_string();
        let world = self.driver.call("Page.createIsolatedWorld", json!({"frameId": frame, "worldName": WORLD_NAME, "grantUniveralAccess": false})).await?;
        let context = world["executionContextId"].as_i64().context("Isolated world was not created")?;
        let install = format!(
            "globalThis.__vislex = new ({INJECTED_SCRIPT})(globalThis, {{isUnderTest: false, sdkLanguage: 'javascript', testIdAttributeName: 'data-testid', stableRafCount: 1, browserName: 'chromium', customEngines: []}}); true"
        );
        let installed = self.driver.call("Runtime.evaluate", json!({"expression": install, "contextId": context, "returnByValue": true})).await?;
        ensure!(installed["result"]["value"] == Value::Bool(true), "Page observation script did not load");
        self.context = Some(context);
        Ok(context)
    }

    /// Takes a snapshot. `find` keeps matching lines with two lines of context; `delta`
    /// returns only the change from the previous snapshot of this session.
    pub async fn snapshot(&mut self, scope: Scope, find: Option<&str>, delta: bool, max_chars: Option<usize>) -> Result<Snapshot> {
        let excluded: Vec<Value> = self.excluded.iter().cloned().map(Value::String).collect();
        let dom_scope = if scope == Scope::Main { "main" } else { "body" };
        let raw = self.call_in_world(SNAPSHOT_FN, &[json!(dom_scope), Value::Array(excluded)], true).await?;
        let raw = raw.get("value").cloned().unwrap_or(raw);
        let full = raw["text"].as_str().context("Snapshot returned no text")?.to_string();
        let lines: Vec<&str> = full.lines().collect();
        let ref_count = lines.iter().filter(|line| line.contains("[ref=")).count();
        let selected: Vec<String> = match (scope, find) {
            (_, Some(needle)) if !needle.trim().is_empty() => find_lines(&lines, needle.trim(), 2),
            (Scope::Interactive, _) => lines.iter().filter(|line| is_interactive(line)).map(|line| line.to_string()).collect(),
            _ => lines.iter().map(|line| line.to_string()).collect(),
        };
        let selected = selected.join("\n");
        let (text, is_delta) = match (&self.last_text, delta) {
            (Some(previous), true) => (line_delta(previous, &selected), true),
            _ => (selected.clone(), false),
        };
        self.last_text = Some(selected);
        self.version += 1;
        let limit = max_chars.unwrap_or(DEFAULT_MAX_CHARS).clamp(500, HARD_MAX_CHARS);
        let truncated = text.chars().count() > limit;
        let text = if truncated { text.chars().take(limit).collect::<String>() + "\n… (truncated; narrow with find or scope)" } else { text };
        Ok(Snapshot {
            version: self.version,
            url: raw["url"].as_str().unwrap_or_default().to_string(),
            title: raw["title"].as_str().unwrap_or_default().to_string(),
            text,
            truncated,
            ref_count,
            delta: is_delta,
        })
    }

    /// Resolves a ref from a snapshot of the current page (any snapshot since the last
    /// navigation) to a page object id. Refs are stable for unchanged elements; an element that
    /// is gone fails as stale.
    pub async fn resolve(&mut self, reference: &str, version: u64) -> Result<String> {
        ensure!(valid_ref(reference), "Invalid element ref {reference:?}");
        ensure!(self.context.is_some() && version > self.page_base && version <= self.version, "The page changed since that snapshot; take a new snapshot first");
        let element = self.call_in_world(RESOLVE_FN, &[json!(reference)], false).await.map_err(|error| {
            if error.to_string().contains("stale ref") { anyhow!("Element {reference} is not in the latest snapshot or no longer on the page; take a new snapshot") } else { error }
        })?;
        element["objectId"].as_str().map(str::to_string).context("Element could not be resolved")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research::driver::FakeDriver;
    use sha2::{Digest, Sha256};

    #[test]
    fn injected_script_matches_its_pinned_hash() {
        let digest = Sha256::digest(INJECTED_SCRIPT.as_bytes());
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, INJECTED_SCRIPT_SHA256, "Rebuild with scripts/build-research-injected.mjs and update the pin");
    }

    #[test]
    fn refs_are_validated_before_reaching_the_page() {
        for ok in ["e1", "e123", "f2e7"] {
            assert!(valid_ref(ok), "{ok}");
        }
        for bad in ["", "e", "x1", "e1 >> css=body", "e1'", "f2", "fe1x", "e12345678901234567"] {
            assert!(!valid_ref(bad), "{bad}");
        }
    }

    #[test]
    fn find_interactive_and_delta_views() {
        let lines = ["- main [ref=e1]:", "  - heading \"Results\" [level=1] [ref=e2]", "  - text: 12 results", "  - link \"Smith v. Jones\" [ref=e3]:", "    - /url: /doc/1"];
        assert_eq!(lines.iter().filter(|line| is_interactive(line)).count(), 3);
        assert_eq!(find_lines(&lines, "smith", 1), ["  - text: 12 results", "  - link \"Smith v. Jones\" [ref=e3]:", "    - /url: /doc/1"]);
        assert_eq!(line_delta("a\nb\nc", "a\nb\nc"), "unchanged");
        let delta = line_delta("a\nb\nc", "a\nc\nd");
        assert!(delta.contains("+ d") && delta.contains("- b") && !delta.contains("+ a"));
    }

    fn fake_page(snapshot_text: &'static str) -> FakeDriver {
        FakeDriver::new(move |method, params| match method {
            "Page.getFrameTree" => Ok(json!({"frameTree": {"frame": {"id": "F1"}}})),
            "Page.createIsolatedWorld" => Ok(json!({"executionContextId": 7})),
            "Runtime.evaluate" => Ok(json!({"result": {"value": true}})),
            "Runtime.callFunctionOn" => {
                let function = params["functionDeclaration"].as_str().unwrap_or_default();
                if function == INSTALLED_FN {
                    Ok(json!({"result": {"value": true}}))
                } else if function == SNAPSHOT_FN {
                    Ok(json!({"result": {"value": {"text": snapshot_text, "url": "https://1.next.westlaw.com/x", "title": "Results"}}}))
                } else if function == RESOLVE_FN {
                    if params["arguments"][0]["value"] == "e3" { Ok(json!({"result": {"objectId": "obj-3"}})) } else { Ok(json!({"exceptionDetails": {"exception": {"description": "Error: stale ref"}}})) }
                } else {
                    anyhow::bail!("unexpected function")
                }
            }
            other => anyhow::bail!("unexpected {other}"),
        })
    }

    fn block<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    #[test]
    fn snapshot_installs_the_world_once_and_resolves_current_refs_only() {
        let text = "- main [ref=e1]:\n  - searchbox \"Search\" [ref=e2]\n  - link \"Smith v. Jones\" [ref=e3]:\n    - /url: /doc/1\n  - text: filler";
        let mut session = Session::new(fake_page(text));
        block(async {
            let first = session.snapshot(Scope::Interactive, None, false, None).await.unwrap();
            assert_eq!(first.ref_count, 3);
            assert!(!first.text.contains("filler"));
            let second = session.snapshot(Scope::Full, None, true, None).await.unwrap();
            assert!(second.delta);
            assert_eq!(session.resolve("e3", second.version).await.unwrap(), "obj-3");
            assert_eq!(session.resolve("e3", first.version).await.unwrap(), "obj-3", "refs stay valid across snapshots of the same page");
            assert!(session.resolve("e3", second.version + 1).await.unwrap_err().to_string().contains("new snapshot"), "future versions are refused");
            assert!(session.resolve("e9", second.version).await.unwrap_err().to_string().contains("no longer on the page"));
            assert!(session.resolve("e3 >> css=body", second.version).await.is_err());
            session.reset();
            assert!(session.resolve("e3", second.version).await.is_err(), "navigation invalidates refs");
        });
        let methods = session.driver().methods();
        assert_eq!(methods.iter().filter(|method| *method == "Page.createIsolatedWorld").count(), 1);
        // Model-supplied values only ever travel as call arguments.
        for (method, params) in session.driver().calls() {
            if method == "Runtime.callFunctionOn" {
                assert!(!params["functionDeclaration"].as_str().unwrap().contains("css=body"));
            }
        }
    }

    #[test]
    fn snapshots_are_capped() {
        let long: &'static str = Box::leak(("- text: x\n".repeat(5_000)).into_boxed_str());
        let mut session = Session::new(fake_page(long));
        let snapshot = block(session.snapshot(Scope::Full, None, false, Some(1_000))).unwrap();
        assert!(snapshot.truncated && snapshot.text.chars().count() < 1_100);
    }
}
