//! Agent actions on the research page, with the safety rules enforced here rather than left to
//! the model:
//! - typing only into search/filter fields, never into credential fields, and not at all while
//!   the page shows a password or one-time-code field;
//! - no clicking controls that deliver, download, share, sign out or change account settings;
//! - navigation only to the agent's research hosts, re-checked after the page loads;
//! - pacing between navigations;
//! - clicks are real (trusted) mouse events at the element's centre after a hit-test.

use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};

use super::{driver::Driver, snapshot::Session, Initiator, NavigationPolicy};

pub const MAX_TYPED_CHARS: usize = 500;
pub const ALLOWED_KEYS: &[&str] = &["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"];

const INFO_FN: &str = r#"function () {
  const e = this;
  const attribute = name => (e.getAttribute && e.getAttribute(name)) || '';
  const form = e.closest ? e.closest('form') : null;
  return {
    tag: (e.tagName || '').toLowerCase(), input_type: attribute('type').toLowerCase(), autocomplete: attribute('autocomplete').toLowerCase(),
    name: attribute('name'), id: attribute('id'), aria_label: attribute('aria-label'), placeholder: attribute('placeholder'), role: attribute('role'),
    href: e.href ? String(e.href) : '', text: (e.innerText || e.textContent || e.value || '').trim().slice(0, 200), title: attribute('title'),
    content_editable: Boolean(e.isContentEditable), form_action: form ? String(form.action || '') : '',
    password_on_page: Boolean(document.querySelector('input[type=password]')),
    otp_on_page: Boolean(document.querySelector('input[autocomplete~="one-time-code"]')),
  };
}"#;
const HIT_FN: &str = "function (x, y) { const hit = document.elementFromPoint(x, y); return Boolean(hit) && (hit === this || this.contains(hit)); }";
const FOCUS_FN: &str = "function () { this.focus(); return document.activeElement === this; }";
const VALUE_FN: &str = "function () { return { active: document.activeElement === this, value: 'value' in this ? String(this.value) : String(this.textContent || '') }; }";
const READY_FN: &str = "document.readyState === 'complete' ? location.href : ''";

#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
pub struct ElementInfo {
    pub tag: String,
    pub input_type: String,
    pub autocomplete: String,
    pub name: String,
    pub id: String,
    pub aria_label: String,
    pub placeholder: String,
    pub role: String,
    pub href: String,
    pub text: String,
    pub title: String,
    pub content_editable: bool,
    pub form_action: String,
    pub password_on_page: bool,
    pub otp_on_page: bool,
}

fn credential_pattern() -> regex::Regex {
    regex::Regex::new(r"(?i)pass(word|code|phrase)?|pwd|otp|one[\s_-]?time|verification|\bmfa\b|2fa|\bpin\b|client[\s_-]?id|security[\s_-]?(code|question|answer)|card|cvv|ssn|social[\s_-]?security|user[\s_-]?name|login|e-?mail").expect("valid pattern")
}

/// Whether the element is, or looks like, a place for credentials or personal data.
pub fn credential_field(info: &ElementInfo) -> bool {
    let pattern = credential_pattern();
    info.input_type == "password"
        || ["password", "one-time-code", "cc-", "username", "email"].iter().any(|token| info.autocomplete.contains(token))
        || [&info.name, &info.id, &info.aria_label, &info.placeholder].iter().any(|value| pattern.is_match(value))
}

/// Typing is allowed only into plain text or search fields, never credentials, and not at all
/// while a password or one-time-code field is on the page.
pub fn ensure_typing_target(info: &ElementInfo) -> Result<()> {
    ensure!(!info.password_on_page && !info.otp_on_page, "The agent does not type while a sign-in or verification field is on the page");
    ensure!(!credential_field(info), "The agent never types into credential or account fields");
    let text_input = info.tag == "input" && ["", "text", "search"].contains(&info.input_type.as_str());
    let text_role = ["searchbox", "combobox", "textbox"].contains(&info.role.as_str()) && (info.tag != "input" || text_input);
    ensure!(text_input || info.tag == "textarea" || text_role, "The agent types only into search or filter fields");
    Ok(())
}

/// Controls the agent must never activate: they deliver or export content, change account or
/// billing state, sign out, or use the site's own AI features.
pub fn denied_control(info: &ElementInfo) -> Option<String> {
    let pattern = regex::Regex::new(
        r"(?i)\b(sign[\s-]?(out|off)|log[\s-]?(out|off)|deliver(y)?|e-?mail|print|download|export|save\s+to|add\s+to\s+folder|folders?|notes?|highlight|annotat\w*|alerts?|share|subscribe|purchase|buy|checkout|preferences|settings|client\s*id|billing|ai[\s-]?assisted|cocounsel|deep\s+research|ask)\b",
    )
    .expect("valid pattern");
    let label = [&info.text, &info.aria_label, &info.title, &info.id, &info.name].iter().map(|value| value.as_str()).collect::<Vec<_>>().join(" ");
    let href = info.href.to_ascii_lowercase();
    if let Some(found) = pattern.find(&label) {
        return Some(format!("The agent may not use the \"{}\" control", found.as_str()));
    }
    if ["/delivery", "/print", "/download", "/signoff", "/signout", "/logout", "/folders", "/alerts", "mailto:"].iter().any(|part| href.contains(part)) {
        return Some("The agent may not follow delivery, account or sign-out links".into());
    }
    None
}

/// Text the agent may type: short, printable, no case-evidence locators or web addresses.
pub fn validate_typed_text(text: &str) -> Result<()> {
    ensure!(!text.trim().is_empty(), "Nothing to type");
    ensure!(text.chars().count() <= MAX_TYPED_CHARS, "Typed text is limited to {MAX_TYPED_CHARS} characters");
    ensure!(text.chars().all(|c| !c.is_control() || c == ' '), "Typed text must be printable");
    let lower = text.to_ascii_lowercase();
    ensure!(!lower.contains("evidence:"), "Case evidence locators may not be typed into the research site");
    ensure!(!["http://", "https://", "www."].iter().any(|prefix| lower.contains(prefix)), "Web addresses may not be typed; navigate instead");
    Ok(())
}

impl<D: Driver> Session<D> {
    async fn pace(&mut self, interval: Duration) {
        if let Some(last) = self.last_action {
            let elapsed = last.elapsed();
            if elapsed < interval {
                tokio::time::sleep(interval - elapsed).await;
            }
        }
        self.last_action = Some(Instant::now());
    }

    pub async fn element_info(&self, object_id: &str) -> Result<ElementInfo> {
        serde_json::from_value(self.call_on(object_id, INFO_FN, &[]).await?).context("Element details unavailable")
    }

    /// Clicks the element for `reference` with trusted mouse events at its centre.
    pub async fn click(&mut self, reference: &str, version: u64, pacing: Duration) -> Result<ElementInfo> {
        let element = self.resolve(reference, version).await?;
        let info = self.element_info(&element).await?;
        if let Some(reason) = denied_control(&info) {
            bail!(reason);
        }
        self.pace(pacing).await;
        self.driver().call("DOM.scrollIntoViewIfNeeded", json!({"objectId": element})).await.ok();
        let model = self.driver().call("DOM.getBoxModel", json!({"objectId": element})).await?;
        let quad: Vec<f64> = model["model"]["content"].as_array().context("Element has no box")?.iter().filter_map(Value::as_f64).collect();
        ensure!(quad.len() == 8, "Element has no box");
        let x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0;
        let y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0;
        ensure!(self.call_on(&element, HIT_FN, &[json!(x), json!(y)]).await? == Value::Bool(true), "Element {reference} is covered by something else; take a new snapshot");
        for (kind, button) in [("mouseMoved", "none"), ("mousePressed", "left"), ("mouseReleased", "left")] {
            self.driver().call("Input.dispatchMouseEvent", json!({"type": kind, "x": x, "y": y, "button": button, "clickCount": 1})).await?;
        }
        Ok(info)
    }

    /// Types into a search or filter field, then confirms the text landed there.
    pub async fn type_text(&mut self, reference: &str, version: u64, text: &str) -> Result<()> {
        validate_typed_text(text)?;
        let element = self.resolve(reference, version).await?;
        ensure_typing_target(&self.element_info(&element).await?)?;
        ensure!(self.call_on(&element, FOCUS_FN, &[]).await? == Value::Bool(true), "The field did not take focus");
        // Re-check at the moment of insertion: the focused element must still be a safe target.
        ensure_typing_target(&self.element_info(&element).await?)?;
        self.driver().call("Input.insertText", json!({"text": text})).await?;
        let after = self.call_on(&element, VALUE_FN, &[]).await?;
        ensure!(after["active"] == Value::Bool(true) && after["value"].as_str().is_some_and(|value| value.contains(text)), "The text did not reach the field");
        Ok(())
    }

    pub async fn press(&mut self, key: &str, pacing: Duration) -> Result<()> {
        ensure!(ALLOWED_KEYS.contains(&key), "Key {key:?} is not allowed");
        self.pace(pacing).await;
        let code = match key { "Enter" => 13, "Tab" => 9, "Escape" => 27, "ArrowDown" => 40, "ArrowUp" => 38, "PageDown" => 34, "PageUp" => 33, "Home" => 36, _ => 35 };
        for kind in ["keyDown", "keyUp"] {
            self.driver().call("Input.dispatchKeyEvent", json!({"type": kind, "key": key, "code": key, "windowsVirtualKeyCode": code})).await?;
        }
        Ok(())
    }

    /// Scrolls the page with a trusted wheel event (reaches virtualised result lists).
    pub async fn scroll(&mut self, down: bool) -> Result<()> {
        let metrics = self.driver().call("Page.getLayoutMetrics", json!({})).await?;
        let viewport = &metrics["cssVisualViewport"];
        let (x, y) = (viewport["clientWidth"].as_f64().unwrap_or(800.0) / 2.0, viewport["clientHeight"].as_f64().unwrap_or(600.0) / 2.0);
        self.driver().call("Input.dispatchMouseEvent", json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": if down { 600 } else { -600 }})).await?;
        Ok(())
    }

    /// Navigates to an allowed research address and waits for it to load. The landing address
    /// is re-checked: a redirect off the research hosts stops loading and fails.
    pub async fn navigate(&mut self, url: &str, policy: &NavigationPolicy, pacing: Duration, timeout: Duration) -> Result<String> {
        ensure!(policy.allows(url, Initiator::Agent), "The agent may not open this address");
        self.pace(pacing).await;
        let result = self.driver().call("Page.navigate", json!({"url": url})).await?;
        self.reset();
        if let Some(error) = result["errorText"].as_str().filter(|error| !error.is_empty()) {
            bail!("Navigation failed: {error}");
        }
        let deadline = Instant::now() + timeout;
        let landed = loop {
            let href = self.driver().call("Runtime.evaluate", json!({"expression": READY_FN, "returnByValue": true})).await?;
            if let Some(href) = href["result"]["value"].as_str().filter(|href| !href.is_empty()) {
                break href.to_string();
            }
            ensure!(Instant::now() < deadline, "The page did not finish loading");
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        if !policy.allows(&landed, Initiator::Agent) {
            self.driver().call("Page.stopLoading", json!({})).await.ok();
            bail!("The page redirected outside the research site");
        }
        Ok(landed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research::driver::FakeDriver;

    fn field(tag: &str, input_type: &str) -> ElementInfo {
        ElementInfo { tag: tag.into(), input_type: input_type.into(), ..Default::default() }
    }

    #[test]
    fn typing_is_limited_to_search_and_filter_fields() {
        assert!(ensure_typing_target(&ElementInfo { aria_label: "Search Westlaw".into(), ..field("input", "search") }).is_ok());
        assert!(ensure_typing_target(&field("textarea", "")).is_ok());
        assert!(ensure_typing_target(&ElementInfo { role: "combobox".into(), ..field("div", "") }).is_ok());
        for refused in [
            field("input", "password"),
            ElementInfo { autocomplete: "one-time-code".into(), ..field("input", "text") },
            ElementInfo { name: "ClientID".into(), ..field("input", "text") },
            ElementInfo { id: "Username".into(), ..field("input", "text") },
            ElementInfo { aria_label: "Verification code".into(), ..field("input", "text") },
            ElementInfo { placeholder: "Email address".into(), ..field("input", "text") },
            field("input", "checkbox"),
            field("button", ""),
            ElementInfo { password_on_page: true, ..field("input", "search") },
            ElementInfo { otp_on_page: true, ..field("input", "search") },
        ] {
            assert!(ensure_typing_target(&refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn delivery_account_and_ai_controls_are_denied() {
        for text in ["Sign Off", "Deliver", "Email", "Print", "Download", "Add to Folder", "Share", "Preferences", "Client ID", "AI-Assisted Research", "Ask CoCounsel"] {
            assert!(denied_control(&ElementInfo { text: text.into(), ..Default::default() }).is_some(), "{text}");
        }
        assert!(denied_control(&ElementInfo { href: "https://1.next.westlaw.com/Delivery/Print".into(), ..Default::default() }).is_some());
        for allowed in ["Search", "Smith v. Jones, 123 F.3d 456", "Negative Treatment", "Next page", "Jurisdiction: All Federal"] {
            assert!(denied_control(&ElementInfo { text: allowed.into(), ..Default::default() }).is_none(), "{allowed}");
        }
    }

    #[test]
    fn typed_text_rules() {
        assert!(validate_typed_text("negligen! /s \"duty of care\" & DA(aft 2015)").is_ok());
        for bad in ["", "   ", "see evidence:abc#L1-L2", "https://evil.example", "www.example.com", "a\u{7}b", &"x".repeat(501)] {
            assert!(validate_typed_text(bad).is_err(), "{bad}");
        }
    }

    fn block<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    /// A results page with one link (e3) and a search box (e2), both current in snapshot 1.
    fn page(info: ElementInfo, hit: bool) -> FakeDriver {
        let info = serde_json::to_value(serde_json::json!({
            "tag": info.tag, "input_type": info.input_type, "autocomplete": info.autocomplete, "name": info.name, "id": info.id,
            "aria_label": info.aria_label, "placeholder": info.placeholder, "role": info.role, "href": info.href, "text": info.text,
            "title": info.title, "content_editable": info.content_editable, "form_action": info.form_action,
            "password_on_page": info.password_on_page, "otp_on_page": info.otp_on_page,
        }))
        .unwrap();
        let typed = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        FakeDriver::new(move |method, params| match method {
            "Page.getFrameTree" => Ok(json!({"frameTree": {"frame": {"id": "F1"}}})),
            "Page.createIsolatedWorld" => Ok(json!({"executionContextId": 7})),
            "Runtime.evaluate" => Ok(json!({"result": {"value": true}})),
            "DOM.scrollIntoViewIfNeeded" | "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" => Ok(json!({})),
            "Input.insertText" => {
                *typed.lock().unwrap() = params["text"].as_str().unwrap_or_default().to_string();
                Ok(json!({}))
            }
            "DOM.getBoxModel" => Ok(json!({"model": {"content": [10.0, 10.0, 30.0, 10.0, 30.0, 20.0, 10.0, 20.0]}})),
            "Runtime.callFunctionOn" => {
                let function = params["functionDeclaration"].as_str().unwrap_or_default();
                Ok(if function.contains("Boolean(globalThis.__vislex)") {
                    json!({"result": {"value": true}})
                } else if function.contains("ariaSnapshot") {
                    json!({"result": {"value": {"text": "- searchbox \"Search\" [ref=e2]\n- link \"Doc\" [ref=e3]", "url": "https://1.next.westlaw.com/", "title": "t"}}})
                } else if function.contains("stale ref") {
                    json!({"result": {"objectId": format!("obj-{}", params["arguments"][0]["value"].as_str().unwrap())}})
                } else if function == INFO_FN {
                    json!({"result": {"value": info.clone()}})
                } else if function == HIT_FN {
                    json!({"result": {"value": hit}})
                } else if function == FOCUS_FN {
                    json!({"result": {"value": true}})
                } else if function == VALUE_FN {
                    json!({"result": {"value": {"active": true, "value": typed.lock().unwrap().clone()}}})
                } else {
                    anyhow::bail!("unexpected function")
                })
            }
            other => anyhow::bail!("unexpected {other}"),
        })
    }

    fn snapshot_version<D: Driver>(session: &mut Session<D>) -> u64 {
        block(session.snapshot(crate::research::snapshot::Scope::Full, None, false, None)).unwrap().version
    }

    #[test]
    fn click_sends_trusted_mouse_events_after_checks() {
        let mut session = Session::new(page(ElementInfo { tag: "a".into(), text: "Smith v. Jones".into(), ..Default::default() }, true));
        let version = snapshot_version(&mut session);
        block(session.click("e3", version, Duration::ZERO)).unwrap();
        let mouse: Vec<String> = session.driver().calls().into_iter().filter(|(method, _)| method == "Input.dispatchMouseEvent").map(|(_, params)| params["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(mouse, ["mouseMoved", "mousePressed", "mouseReleased"]);
        let clicked = session.driver().calls().into_iter().find(|(method, _)| method == "Input.dispatchMouseEvent").unwrap().1;
        assert_eq!((clicked["x"].as_f64(), clicked["y"].as_f64()), (Some(20.0), Some(15.0)));
    }

    #[test]
    fn click_refuses_denied_or_covered_elements() {
        let mut session = Session::new(page(ElementInfo { tag: "button".into(), text: "Deliver".into(), ..Default::default() }, true));
        let version = snapshot_version(&mut session);
        assert!(block(session.click("e3", version, Duration::ZERO)).unwrap_err().to_string().contains("Deliver"));
        let mut session = Session::new(page(ElementInfo { tag: "a".into(), text: "Doc".into(), ..Default::default() }, false));
        let version = snapshot_version(&mut session);
        assert!(block(session.click("e3", version, Duration::ZERO)).unwrap_err().to_string().contains("covered"));
        assert!(!session.driver().methods().contains(&"Input.dispatchMouseEvent".to_string()));
    }

    #[test]
    fn typing_goes_only_into_search_fields_and_text_travels_as_data() {
        let injection = "x'); document.body.remove(); ('";
        let mut session = Session::new(page(ElementInfo { tag: "input".into(), input_type: "search".into(), ..Default::default() }, true));
        let version = snapshot_version(&mut session);
        block(session.type_text("e2", version, injection)).unwrap();
        for (method, params) in session.driver().calls() {
            if method == "Runtime.callFunctionOn" {
                assert!(!params["functionDeclaration"].as_str().unwrap().contains("document.body.remove"));
            }
        }
        let mut session = Session::new(page(ElementInfo { tag: "input".into(), input_type: "password".into(), ..Default::default() }, true));
        let version = snapshot_version(&mut session);
        assert!(block(session.type_text("e2", version, "secret")).is_err());
        assert!(!session.driver().methods().contains(&"Input.insertText".to_string()));
    }

    #[test]
    fn navigation_is_limited_to_research_hosts_including_after_redirects() {
        let policy = NavigationPolicy { sso_hosts: vec![], mock_origin: None };
        let driver = FakeDriver::new(|method, params| match method {
            "Page.navigate" => Ok(json!({"frameId": "F1"})),
            "Runtime.evaluate" if params["expression"] == READY_FN => Ok(json!({"result": {"value": "https://signon.thomsonreuters.com/?returnto=x"}})),
            "Page.stopLoading" => Ok(json!({})),
            other => anyhow::bail!("unexpected {other}"),
        });
        let mut session = Session::new(driver);
        assert!(block(session.navigate("https://evil.example/", &policy, Duration::ZERO, Duration::from_secs(1))).is_err());
        assert!(session.driver().methods().is_empty(), "refused before any call");
        let error = block(session.navigate("https://1.next.westlaw.com/Search", &policy, Duration::ZERO, Duration::from_secs(1))).unwrap_err();
        assert!(error.to_string().contains("redirected"));
        assert!(session.driver().methods().contains(&"Page.stopLoading".to_string()));
    }

    #[test]
    fn only_listed_keys_are_pressed() {
        let mut session = Session::new(FakeDriver::new(|_, _| Ok(json!({}))));
        block(session.press("Enter", Duration::ZERO)).unwrap();
        assert!(block(session.press("F12", Duration::ZERO)).is_err());
        assert!(block(session.press("Control", Duration::ZERO)).is_err());
    }
}
