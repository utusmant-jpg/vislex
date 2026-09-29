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

pub const MAX_TYPED_CHARS: usize = 10_000;
/// Named keys the agent may press (alone, or in the modifier combinations `parse_key` allows);
/// single letters and digits are also accepted. No function keys.
pub const ALLOWED_KEYS: &[&str] = &["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"];

/// CDP modifier bits.
pub const ALT: u8 = 1;
pub const CONTROL: u8 = 2;
pub const META: u8 = 4;
pub const SHIFT: u8 = 8;

/// Browser, window and developer-tools shortcuts named in refusals (all are outside the
/// allowlist in `combination_allowed` anyway).
pub const REFUSED_COMBINATIONS: &[&str] = &["Control+W", "Control+Q", "Alt+F4", "Control+Shift+I", "Control+Shift+J", "Control+Shift+C", "F12", "Control+U", "Control+S", "Control+P", "Control+O", "Control+N", "Control+T", "Control+Shift+Delete"];

/// One key press: the main key with its modifiers, as CDP key event fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyPress {
    /// Canonical spelling, e.g. "Control+A".
    pub label: String,
    pub modifiers: u8,
    /// DOM `key` value ("a", "A", "Enter", " ").
    pub key: String,
    /// DOM `code` value ("KeyA", "Enter", "Space").
    pub code: String,
    pub virtual_key: u32,
    /// Text the key inserts (none with Control, Alt or Meta held).
    pub text: Option<String>,
}

/// Which modifier and key combinations the agent may press: editing and navigation within the
/// page. Nothing that closes, opens or saves windows and tabs, prints, views source, pastes the
/// user's clipboard or opens developer tools.
fn combination_allowed(modifiers: u8, key: &str) -> bool {
    let letter_or_digit = key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric());
    let named = ALLOWED_KEYS.contains(&key);
    let caret = ["Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].contains(&key);
    match modifiers {
        0 => named || letter_or_digit,
        SHIFT => named || key.len() == 1 && key.chars().all(|c| c.is_ascii_alphabetic()),
        CONTROL | META => ["A", "Z", "Y", "F", "Enter", "Backspace", "Delete"].contains(&key) || caret,
        m if m == CONTROL | SHIFT || m == META | SHIFT => key == "Z" || caret,
        ALT => ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].contains(&key),
        _ => false,
    }
}

/// Parses "Enter", "a", "Control+A", "Shift+Tab", "Alt+ArrowLeft" or "Meta+A" (modifier names
/// in any case; Ctrl and Cmd are accepted) and checks it against the allowlist.
pub fn parse_key(spec: &str) -> Result<KeyPress> {
    let spec = spec.trim();
    ensure!(!spec.is_empty() && spec.len() <= 40, "Name a key to press, for example Enter or Control+A");
    let parts: Vec<&str> = spec.split('+').map(str::trim).collect();
    ensure!(parts.iter().all(|part| !part.is_empty()), "Key {spec:?} is not allowed");
    let (main, modifier_names) = parts.split_last().expect("at least one part");
    let mut modifiers = 0u8;
    for name in modifier_names {
        let bit = match name.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => CONTROL,
            "shift" => SHIFT,
            "alt" => ALT,
            "meta" | "cmd" | "command" => META,
            _ => bail!("Key {spec:?} is not allowed: {name} is not a modifier (use Control, Shift, Alt or Meta)"),
        };
        ensure!(modifiers & bit == 0, "Key {spec:?} names a modifier twice");
        modifiers |= bit;
    }
    // Canonical key name: named keys case-insensitively, letters upper-case, digits as is.
    let key = if main.len() == 1 && main.chars().all(|c| c.is_ascii_alphanumeric()) {
        main.to_ascii_uppercase()
    } else {
        ALLOWED_KEYS.iter().find(|named| named.eq_ignore_ascii_case(main)).map(|named| named.to_string()).unwrap_or_else(|| main.to_string())
    };
    let mut label: Vec<&str> = Vec::new();
    for (bit, name) in [(CONTROL, "Control"), (ALT, "Alt"), (META, "Meta"), (SHIFT, "Shift")] {
        if modifiers & bit != 0 {
            label.push(name);
        }
    }
    label.push(&key);
    let label = label.join("+");
    ensure!(
        combination_allowed(modifiers, &key),
        "Key {label:?} is not allowed. Press Enter, Tab, Escape, Backspace, Delete, Space, the arrow keys, PageUp, PageDown, Home, End, a letter or digit, Shift with those, Control (or Meta) with A, Z, Y, F, Enter, Backspace, Delete, Home, End or an arrow, Control+Shift with Z, Home, End or an arrow, or Alt with an arrow. Browser, window and developer-tools shortcuts are refused."
    );
    let command = modifiers & (CONTROL | ALT | META) != 0;
    let (dom_key, code, virtual_key, text) = match key.as_str() {
        "Enter" => ("Enter".to_string(), "Enter".to_string(), 13, Some("\r")),
        "Tab" => ("Tab".into(), "Tab".into(), 9, None),
        "Escape" => ("Escape".into(), "Escape".into(), 27, None),
        "Backspace" => ("Backspace".into(), "Backspace".into(), 8, None),
        "Delete" => ("Delete".into(), "Delete".into(), 46, None),
        "Space" => (" ".into(), "Space".into(), 32, Some(" ")),
        "ArrowLeft" => ("ArrowLeft".into(), "ArrowLeft".into(), 37, None),
        "ArrowUp" => ("ArrowUp".into(), "ArrowUp".into(), 38, None),
        "ArrowRight" => ("ArrowRight".into(), "ArrowRight".into(), 39, None),
        "ArrowDown" => ("ArrowDown".into(), "ArrowDown".into(), 40, None),
        "PageUp" => ("PageUp".into(), "PageUp".into(), 33, None),
        "PageDown" => ("PageDown".into(), "PageDown".into(), 34, None),
        "End" => ("End".into(), "End".into(), 35, None),
        "Home" => ("Home".into(), "Home".into(), 36, None),
        single => {
            let c = single.chars().next().expect("one character");
            if c.is_ascii_digit() {
                (single.to_string(), format!("Digit{c}"), c as u32, None)
            } else {
                let dom = if modifiers & SHIFT != 0 { single.to_string() } else { single.to_ascii_lowercase() };
                (dom, format!("Key{c}"), c as u32, None)
            }
        }
    };
    // Letters and digits insert themselves when no command modifier is held.
    let text = match text {
        Some(text) => (!command).then(|| text.to_string()),
        None if key.len() == 1 && !command => Some(dom_key.clone()),
        None => None,
    };
    Ok(KeyPress { label, modifiers, key: dom_key, code, virtual_key, text })
}

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
/// Selects the field's whole content, so inserted text replaces it instead of landing at the caret.
const SELECT_ALL_FN: &str = r#"function () {
  const e = this;
  if (e.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(e);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return 'range';
  }
  if (typeof e.select === 'function') { e.select(); return 'select'; }
  return 'none';
}"#;
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
    ensure!(!secret_field(info), "Passwords and verification codes are for the user to type; ask them to complete this step in the Browser view");
    let text_input = info.tag == "input" && !["checkbox", "radio", "file", "submit", "button", "image", "reset", "hidden", "range", "color"].contains(&info.input_type.as_str());
    let text_role = ["searchbox", "combobox", "textbox", "spinbutton"].contains(&info.role.as_str());
    ensure!(text_input || info.tag == "textarea" || text_role || info.content_editable, "That element does not take typed text; pick a text field from the snapshot");
    Ok(())
}

/// A password or one-time verification code field. The agent types anything else.
pub fn secret_field(info: &ElementInfo) -> bool {
    let secret = regex::Regex::new(r"(?i)pass(word|code|phrase)|\botp\b|one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|\bcvv\b|\bpin\b").expect("valid pattern");
    info.input_type == "password"
        || ["current-password", "new-password", "one-time-code", "cc-csc", "cc-number"].iter().any(|token| info.autocomplete.contains(token))
        || [&info.name, &info.id, &info.aria_label, &info.placeholder].iter().any(|value| secret.is_match(value))
}

/// Text the agent may type: short, printable, no case-evidence locators or web addresses.
pub fn validate_typed_text(text: &str) -> Result<()> {
    ensure!(!text.trim().is_empty(), "Nothing to type");
    ensure!(text.chars().count() <= MAX_TYPED_CHARS, "Typed text is limited to {MAX_TYPED_CHARS} characters");
    ensure!(text.chars().all(|c| !c.is_control() || matches!(c, ' ' | '\n' | '\t')), "Typed text must be printable");
    Ok(())
}

/// Whether a field's value is the typed text: exactly, or the same once whitespace is collapsed
/// (single-line inputs drop line breaks; editable regions render them as blocks).
pub fn typed_matches(value: &str, text: &str) -> bool {
    let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    value == text || collapse(value) == collapse(text)
}

impl<D: Driver> Session<D> {
    pub(crate) async fn pace(&mut self, interval: Duration) {
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
        self.click_object(&element, reference, pacing).await
    }

    /// Clicks a resolved page element with trusted mouse events at its centre after a hit-test.
    pub(crate) async fn click_object(&mut self, element: &str, label: &str, pacing: Duration) -> Result<ElementInfo> {
        let info = self.element_info(element).await?;
        self.pace(pacing).await;
        self.driver().call("DOM.scrollIntoViewIfNeeded", json!({"objectId": element})).await.ok();
        let model = self.driver().call("DOM.getBoxModel", json!({"objectId": element})).await?;
        let quad: Vec<f64> = model["model"]["content"].as_array().context("Element has no box")?.iter().filter_map(Value::as_f64).collect();
        ensure!(quad.len() == 8, "Element has no box");
        let x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0;
        let y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0;
        ensure!(self.call_on(element, HIT_FN, &[json!(x), json!(y)]).await? == Value::Bool(true), "Element {label} is covered by something else; take a new snapshot");
        for (kind, button) in [("mouseMoved", "none"), ("mousePressed", "left"), ("mouseReleased", "left")] {
            self.driver().call("Input.dispatchMouseEvent", json!({"type": kind, "x": x, "y": y, "button": button, "clickCount": 1})).await?;
        }
        Ok(info)
    }

    /// Replaces the content of a search or filter field with `text`, then confirms the field
    /// holds exactly that text.
    pub async fn type_text(&mut self, reference: &str, version: u64, text: &str) -> Result<()> {
        validate_typed_text(text)?;
        let element = self.resolve(reference, version).await?;
        self.type_into(&element, text).await
    }

    /// Focuses a resolved field, selects everything in it and inserts `text` in its place. If
    /// the field still holds other text, selects all with a trusted Control+A and tries once more.
    pub(crate) async fn type_into(&mut self, element: &str, text: &str) -> Result<()> {
        validate_typed_text(text)?;
        ensure_typing_target(&self.element_info(element).await?)?;
        ensure!(self.call_on(element, FOCUS_FN, &[]).await? == Value::Bool(true), "The field did not take focus");
        // Re-check at the moment of insertion: the focused element must still be a safe target.
        ensure_typing_target(&self.element_info(element).await?)?;
        self.call_on(element, SELECT_ALL_FN, &[]).await?;
        self.driver().call("Input.insertText", json!({"text": text})).await?;
        let mut after = self.call_on(element, VALUE_FN, &[]).await?;
        ensure!(after["active"] == Value::Bool(true), "The field lost focus while typing; take a new snapshot");
        if !typed_matches(after["value"].as_str().unwrap_or_default(), text) {
            self.dispatch_key(&parse_key("Control+A")?).await?;
            ensure_typing_target(&self.element_info(element).await?)?;
            self.driver().call("Input.insertText", json!({"text": text})).await?;
            after = self.call_on(element, VALUE_FN, &[]).await?;
        }
        let value = after["value"].as_str().unwrap_or_default();
        ensure!(
            after["active"] == Value::Bool(true) && typed_matches(value, text),
            "The field did not end up holding exactly the typed text (it shows {:?}); take a snapshot and check the field",
            value.chars().take(120).collect::<String>()
        );
        Ok(())
    }

    /// Presses a key or an allowed modifier combination ("Enter", "Control+A", "Shift+Tab").
    pub async fn press(&mut self, key: &str, pacing: Duration) -> Result<()> {
        let press = parse_key(key)?;
        self.pace(pacing).await;
        self.dispatch_key(&press).await
    }

    /// Trusted key events: the modifiers down, the key down and up, the modifiers up.
    async fn dispatch_key(&self, press: &KeyPress) -> Result<()> {
        const MODIFIER_KEYS: [(u8, &str, &str, u32); 4] = [(CONTROL, "Control", "ControlLeft", 17), (ALT, "Alt", "AltLeft", 18), (META, "Meta", "MetaLeft", 91), (SHIFT, "Shift", "ShiftLeft", 16)];
        let held: Vec<_> = MODIFIER_KEYS.iter().filter(|(bit, ..)| press.modifiers & bit != 0).collect();
        let mut state = 0u8;
        for (bit, key, code, virtual_key) in &held {
            state |= bit;
            self.driver().call("Input.dispatchKeyEvent", json!({"type": "rawKeyDown", "key": key, "code": code, "windowsVirtualKeyCode": virtual_key, "modifiers": state})).await?;
        }
        let mut down = json!({"type": if press.text.is_some() { "keyDown" } else { "rawKeyDown" }, "key": press.key, "code": press.code, "windowsVirtualKeyCode": press.virtual_key, "modifiers": press.modifiers});
        if let Some(text) = &press.text {
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
        if press.modifiers & (CONTROL | META) != 0 && press.modifiers & (ALT | SHIFT) == 0 && press.key == "a" {
            down["commands"] = json!(["selectAll"]);
        }
        self.driver().call("Input.dispatchKeyEvent", down).await?;
        self.driver().call("Input.dispatchKeyEvent", json!({"type": "keyUp", "key": press.key, "code": press.code, "windowsVirtualKeyCode": press.virtual_key, "modifiers": press.modifiers})).await?;
        for (bit, key, code, virtual_key) in held.iter().rev() {
            state &= !bit;
            self.driver().call("Input.dispatchKeyEvent", json!({"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": virtual_key, "modifiers": state})).await?;
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
        ensure!(policy.allows(url, Initiator::Agent), "The agent does not open local or private-network addresses");
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
            bail!("The page redirected to a local or private-network address");
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
    fn the_agent_types_anywhere_except_passwords_and_codes() {
        for allowed in [
            ElementInfo { aria_label: "Search Westlaw".into(), ..field("input", "search") },
            field("textarea", ""),
            ElementInfo { role: "combobox".into(), ..field("div", "") },
            ElementInfo { name: "ClientID".into(), ..field("input", "text") },
            ElementInfo { placeholder: "Email address".into(), ..field("input", "email") },
            ElementInfo { id: "Username".into(), ..field("input", "text") },
            // A search box on a page that also has a sign-in form.
            ElementInfo { password_on_page: true, ..field("input", "search") },
            ElementInfo { content_editable: true, ..field("div", "") },
        ] {
            assert!(ensure_typing_target(&allowed).is_ok(), "{allowed:?}");
        }
        for refused in [
            field("input", "password"),
            ElementInfo { autocomplete: "one-time-code".into(), ..field("input", "text") },
            ElementInfo { autocomplete: "current-password".into(), ..field("input", "text") },
            ElementInfo { aria_label: "Verification code".into(), ..field("input", "text") },
            field("input", "checkbox"),
            field("button", ""),
        ] {
            assert!(ensure_typing_target(&refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn typed_text_rules() {
        assert!(validate_typed_text("negligen! /s \"duty of care\" & DA(aft 2015)").is_ok());
        for good in ["see evidence:abc#L1-L2", "https://www.courtlistener.com", "line one\nline two", "someone@firm.example"] {
            assert!(validate_typed_text(good).is_ok(), "{good}");
        }
        for bad in ["", "   ", "a\u{7}b", &"x".repeat(10_001)] {
            assert!(validate_typed_text(bad).is_err(), "{bad}");
        }
    }

    fn block<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    /// How the scripted search field behaves: its content before typing, and whether selecting
    /// all by script and by Control+A work.
    #[derive(Clone, Copy)]
    struct Field {
        before: &'static str,
        script_selects: bool,
        key_selects: bool,
    }

    const EMPTY: Field = Field { before: "", script_selects: true, key_selects: true };

    /// A results page with one link (e3) and a search box (e2), both current in snapshot 1.
    fn page(info: ElementInfo, hit: bool) -> FakeDriver {
        page_with(info, hit, EMPTY)
    }

    /// As `page`, with a field that inserts text at the caret unless its content is selected.
    fn page_with(info: ElementInfo, hit: bool, field: Field) -> FakeDriver {
        let info = serde_json::to_value(serde_json::json!({
            "tag": info.tag, "input_type": info.input_type, "autocomplete": info.autocomplete, "name": info.name, "id": info.id,
            "aria_label": info.aria_label, "placeholder": info.placeholder, "role": info.role, "href": info.href, "text": info.text,
            "title": info.title, "content_editable": info.content_editable, "form_action": info.form_action,
            "password_on_page": info.password_on_page, "otp_on_page": info.otp_on_page,
        }))
        .unwrap();
        let typed = std::sync::Arc::new(std::sync::Mutex::new((field.before.to_string(), false)));
        FakeDriver::new(move |method, params| match method {
            "Page.getFrameTree" => Ok(json!({"frameTree": {"frame": {"id": "F1"}}})),
            "Page.createIsolatedWorld" => Ok(json!({"executionContextId": 7})),
            "Runtime.evaluate" => Ok(json!({"result": {"value": true}})),
            "DOM.scrollIntoViewIfNeeded" | "Input.dispatchMouseEvent" => Ok(json!({})),
            "Input.dispatchKeyEvent" => {
                if field.key_selects && params["commands"] == json!(["selectAll"]) {
                    typed.lock().unwrap().1 = true;
                }
                Ok(json!({}))
            }
            "Input.insertText" => {
                let mut state = typed.lock().unwrap();
                let text = params["text"].as_str().unwrap_or_default();
                // Replaces a selection; otherwise lands at the caret (the end).
                if state.1 { state.0 = text.to_string() } else { state.0.push_str(text) }
                state.1 = false;
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
                    json!({"result": {"value": {"active": true, "value": typed.lock().unwrap().0.clone()}}})
                } else if function == SELECT_ALL_FN {
                    if field.script_selects {
                        typed.lock().unwrap().1 = true;
                    }
                    json!({"result": {"value": if field.script_selects { "select" } else { "none" }}})
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
    fn click_works_on_any_control_but_refuses_covered_elements() {
        let mut session = Session::new(page(ElementInfo { tag: "button".into(), text: "Access with single sign-on".into(), ..Default::default() }, true));
        let version = snapshot_version(&mut session);
        block(session.click("e3", version, Duration::ZERO)).unwrap();
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
    fn navigation_reaches_the_open_web_but_not_private_addresses_even_by_redirect() {
        let policy = NavigationPolicy { mock_origin: None };
        let landing = std::sync::Arc::new(std::sync::Mutex::new("https://signon.thomsonreuters.com/?returnto=x"));
        let current = landing.clone();
        let driver = FakeDriver::new(move |method, params| match method {
            "Page.navigate" => Ok(json!({"frameId": "F1"})),
            "Runtime.evaluate" if params["expression"] == READY_FN => Ok(json!({"result": {"value": *current.lock().unwrap()}})),
            "Page.stopLoading" => Ok(json!({})),
            other => anyhow::bail!("unexpected {other}"),
        });
        let mut session = Session::new(driver);
        assert!(block(session.navigate("http://192.168.1.1/", &policy, Duration::ZERO, Duration::from_secs(1))).is_err());
        assert!(session.driver().methods().is_empty(), "refused before any call");
        // Westlaw redirecting to its sign-in page is fine.
        assert_eq!(block(session.navigate("https://1.next.westlaw.com/Search", &policy, Duration::ZERO, Duration::from_secs(1))).unwrap(), "https://signon.thomsonreuters.com/?returnto=x");
        // A public page redirecting into the local network is stopped.
        *landing.lock().unwrap() = "http://127.0.0.1:8080/admin";
        let error = block(session.navigate("https://www.example.com/", &policy, Duration::ZERO, Duration::from_secs(1))).unwrap_err();
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

    /// The log's failure: typing into a search box that already held a query inserted the new
    /// text at the caret ("CO(Ohioadv: theft ..."). Typing now replaces the field's content.
    #[test]
    fn typing_replaces_what_the_field_held() {
        let search = || ElementInfo { tag: "input".into(), input_type: "text".into(), ..Default::default() };
        let query = "adv: theft /s \"lawful owner\"";
        let mut session = Session::new(page_with(search(), true, Field { before: "CO(Ohio", script_selects: true, key_selects: true }));
        let version = snapshot_version(&mut session);
        block(session.type_text("e2", version, query)).unwrap();
        let calls = session.driver().calls();
        let select = calls.iter().position(|(method, params)| method == "Runtime.callFunctionOn" && params["functionDeclaration"] == SELECT_ALL_FN).expect("select all");
        let insert = calls.iter().position(|(method, _)| method == "Input.insertText").expect("insert");
        assert!(select < insert, "the field is selected before the text is inserted");
        assert_eq!(calls.iter().filter(|(method, _)| method == "Input.insertText").count(), 1);

        // A field the script cannot select: the text lands at the caret, so a trusted Control+A
        // selects everything and the text is inserted again.
        let mut session = Session::new(page_with(search(), true, Field { before: "CO(Ohio", script_selects: false, key_selects: true }));
        let version = snapshot_version(&mut session);
        block(session.type_text("e2", version, query)).unwrap();
        let keys: Vec<Value> = session.driver().calls().into_iter().filter(|(method, _)| method == "Input.dispatchKeyEvent").map(|(_, params)| params).collect();
        assert!(keys.iter().any(|event| event["key"] == "a" && event["modifiers"] == CONTROL && event["commands"] == json!(["selectAll"])), "{keys:?}");

        // Nothing selects: the field never holds exactly the typed text, which is reported.
        let mut session = Session::new(page_with(search(), true, Field { before: "CO(Ohio", script_selects: false, key_selects: false }));
        let version = snapshot_version(&mut session);
        let error = block(session.type_text("e2", version, query)).unwrap_err().to_string();
        assert!(error.contains("did not end up holding exactly the typed text") && error.contains("CO(Ohio"), "{error}");

        // Whitespace differences (a single-line input drops the line break) still match.
        assert!(typed_matches("line one line two", "line one\nline two"));
        assert!(!typed_matches("CO(Ohioadv: theft", "adv: theft"));
    }

    #[test]
    fn key_combinations_are_parsed_into_cdp_events_and_shortcuts_are_refused() {
        let control_a = parse_key("Control+A").unwrap();
        assert_eq!((control_a.label.as_str(), control_a.modifiers, control_a.key.as_str(), control_a.code.as_str(), control_a.virtual_key, control_a.text.as_deref()), ("Control+A", CONTROL, "a", "KeyA", 65, None));
        assert_eq!(parse_key("ctrl+a").unwrap(), control_a, "modifier and key names are case-insensitive");
        let shift_tab = parse_key("Shift+Tab").unwrap();
        assert_eq!((shift_tab.modifiers, shift_tab.key.as_str(), shift_tab.virtual_key), (SHIFT, "Tab", 9));
        let back = parse_key("Alt+ArrowLeft").unwrap();
        assert_eq!((back.modifiers, back.code.as_str(), back.virtual_key), (ALT, "ArrowLeft", 37));
        assert_eq!(parse_key("Meta+A").unwrap().modifiers, META);
        assert_eq!(parse_key("Control+Shift+ArrowRight").unwrap().modifiers, CONTROL | SHIFT);
        assert_eq!(parse_key("Shift+Control+Z").unwrap().label, "Control+Shift+Z");
        let enter = parse_key("Enter").unwrap();
        assert_eq!((enter.text.as_deref(), enter.virtual_key), (Some("\r"), 13));
        assert_eq!(parse_key("Control+Enter").unwrap().text, None);
        let space = parse_key("Space").unwrap();
        assert_eq!((space.key.as_str(), space.code.as_str(), space.text.as_deref()), (" ", "Space", Some(" ")));
        let letter = parse_key("j").unwrap();
        assert_eq!((letter.key.as_str(), letter.code.as_str(), letter.text.as_deref()), ("j", "KeyJ", Some("j")));
        assert_eq!(parse_key("Shift+J").unwrap().key, "J");
        let digit = parse_key("7").unwrap();
        assert_eq!((digit.code.as_str(), digit.virtual_key, digit.text.as_deref()), ("Digit7", 55, Some("7")));
        for refused in REFUSED_COMBINATIONS.iter().copied().chain(["Control+V", "Control+C", "Control+X", "Control+Tab", "Alt+F", "Alt+Shift+ArrowLeft", "F5", "Control+Alt+Delete", "Meta+W", "Meta+Q", "Control+Control+A", "Hyper+A", "Control+", "", "Shift+1"]) {
            assert!(parse_key(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_combination_holds_its_modifiers_around_the_key() {
        let mut session = Session::new(FakeDriver::new(|_, _| Ok(json!({}))));
        block(session.press("Control+Shift+ArrowLeft", Duration::ZERO)).unwrap();
        let events: Vec<(String, String, u64)> = session
            .driver()
            .calls()
            .into_iter()
            .map(|(_, params)| (params["type"].as_str().unwrap().to_string(), params["key"].as_str().unwrap().to_string(), params["modifiers"].as_u64().unwrap()))
            .collect();
        let expected = [("rawKeyDown", "Control", 2), ("rawKeyDown", "Shift", 10), ("rawKeyDown", "ArrowLeft", 10), ("keyUp", "ArrowLeft", 10), ("keyUp", "Shift", 2), ("keyUp", "Control", 0)];
        assert_eq!(events, expected.map(|(kind, key, modifiers)| (kind.to_string(), key.to_string(), modifiers)));
        // A key that inserts text is a keyDown carrying it (Enter submits forms through it).
        let mut session = Session::new(FakeDriver::new(|_, _| Ok(json!({}))));
        block(session.press("Enter", Duration::ZERO)).unwrap();
        let down = session.driver().calls()[0].1.clone();
        assert_eq!((down["type"].as_str(), down["text"].as_str(), down["windowsVirtualKeyCode"].as_u64()), (Some("keyDown"), Some("\r"), Some(13)));
        // A refused combination sends nothing.
        let mut session = Session::new(FakeDriver::new(|_, _| Ok(json!({}))));
        assert!(block(session.press("Control+W", Duration::ZERO)).is_err());
        assert!(session.driver().calls().is_empty());
    }
}
