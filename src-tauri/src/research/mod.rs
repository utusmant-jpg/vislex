//! In-app research browser: an embedded child webview the user signs into, driven by the
//! case agent through WebView2's in-process DevTools protocol (no debugging port).
//!
//! This module holds the policy that does not need a webview, so the ordinary test suite
//! covers it: which navigations the pane and the agent may make, where the browser profile
//! may live, and the per-task limits. The webview itself lives in `pane` and `cdp`.

use std::path::Path;

use anyhow::{ensure, Result};

#[cfg(all(feature = "research", windows))]
pub mod cdp;
pub mod actions;
pub mod driver;
pub mod snapshot;
pub mod tools;
#[cfg(feature = "research")]
pub mod pane;
#[cfg(all(feature = "research", windows))]
pub mod runtime;
#[cfg(all(feature = "research", windows, debug_assertions))]
pub mod spike;
#[cfg(all(feature = "research", windows, debug_assertions))]
pub mod survey;

/// Label of the research child webview. No capability may name it.
pub const WEBVIEW_LABEL: &str = "research";
pub const WESTLAW_HOME: &str = "https://1.next.westlaw.com/";

/// Research hosts the agent may navigate to.
pub const RESEARCH_HOSTS: &[&str] = &["1.next.westlaw.com", "next.westlaw.com", "www.westlaw.com"];
/// Sign-in hosts the user may pass through; the agent never acts on them.
pub const SIGN_ON_HOSTS: &[&str] = &["signon.thomsonreuters.com"];

/// Where a navigation starts. The agent is held to a narrower list than the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Initiator {
    User,
    Agent,
}

/// Navigation policy for the pane. Constructed only by [`NavigationPolicy::resolve`], which
/// refuses unsafe WebView2 configurations; `mock_origin` replaces every real host in debug
/// test mode.
#[derive(Clone, Debug)]
pub struct NavigationPolicy {
    sso_hosts: Vec<String>,
    mock_origin: Option<String>,
}

impl NavigationPolicy {
    /// Resolves the policy for this process. A DevTools switch or a profile override in the
    /// WebView2 environment is refused, except in debug test mode against a loopback mock.
    pub fn resolve(sso_hosts: Vec<String>) -> Result<Self> {
        let arguments = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok();
        #[cfg(debug_assertions)]
        if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
            // Test mode fails closed: only the loopback mock, never the real service.
            let mock = std::env::var("VISLEX_RESEARCH_MOCK_URL").map_err(|_| anyhow::anyhow!("Test mode opens the research pane only against VISLEX_RESEARCH_MOCK_URL"))?;
            let _ = &arguments;
            return Ok(Self { sso_hosts: Vec::new(), mock_origin: Some(mock_origin(&mock)?) });
        }
        ensure!(!debugging_port_requested(arguments.as_deref()), "The research browser does not open while a WebView2 debugging switch is configured");
        ensure!(
            !arguments.as_deref().is_some_and(|arguments| arguments.to_ascii_lowercase().contains("user-data-dir")),
            "The research browser does not open while a WebView2 profile switch is configured"
        );
        // Measured in the R34 spike: WEBVIEW2_USER_DATA_FOLDER overrides the pane's own data
        // directory. The others attach a script debugger or substitute the browser runtime.
        for variable in ["WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER", "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"] {
            ensure!(std::env::var_os(variable).is_none(), "The research browser does not open while {variable} is set");
        }
        Ok(Self { sso_hosts, mock_origin: None })
    }

    pub fn is_mock(&self) -> bool {
        self.mock_origin.is_some()
    }

    /// Whether a top-level navigation may proceed. Exact hosts only, https only, default port,
    /// no credentials in the URL. With a mock origin, only that loopback origin is allowed.
    pub fn allows(&self, url: &str, initiator: Initiator) -> bool {
        let Ok(parsed) = url.parse::<reqwest::Url>() else { return false };
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return false;
        }
        if let Some(origin) = &self.mock_origin {
            return parsed.origin().ascii_serialization() == *origin;
        }
        if parsed.scheme() != "https" || parsed.port().is_some() {
            return false;
        }
        let Some(host) = parsed.host_str() else { return false };
        let host = host.to_ascii_lowercase();
        if RESEARCH_HOSTS.contains(&host.as_str()) {
            return true;
        }
        initiator == Initiator::User
            && (SIGN_ON_HOSTS.contains(&host.as_str()) || self.sso_hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(&host)))
    }
}

/// A mock origin is accepted only for plain-http loopback addresses, so test mode can never
/// point the pane at a real Thomson Reuters host.
pub fn mock_origin(value: &str) -> Result<String> {
    let parsed: reqwest::Url = value.parse()?;
    ensure!(parsed.scheme() == "http", "The research mock must be an http loopback origin");
    ensure!(
        matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]")),
        "The research mock must be a loopback origin"
    );
    Ok(parsed.origin().ascii_serialization())
}

/// Whether WebView2 browser arguments ask for a DevTools listener. Any process could then
/// drive the signed-in session. Chromium accepts `--`, `-` and `/` switch prefixes on
/// Windows, so any mention of the switch name counts.
pub fn debugging_port_requested(additional_browser_arguments: Option<&str>) -> bool {
    additional_browser_arguments.is_some_and(|arguments| arguments.to_ascii_lowercase().contains("remote-debugging"))
}

/// Canonical form of `path`: its nearest existing ancestor is canonicalized (resolving `..`,
/// junctions, `subst` drives and short names) and the not-yet-existing remainder appended.
fn canonical_prefix(path: &Path) -> std::path::PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(resolved) = std::fs::canonicalize(existing) {
            return rest.iter().rev().fold(resolved, |joined, part| joined.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Comparable form of a path: canonical as far as it exists, without the verbatim prefix,
/// lower-cased, split into components.
pub fn path_components(path: &Path) -> Vec<String> {
    let resolved = canonical_prefix(path);
    let text = resolved.to_string_lossy().replace('/', r"\");
    let text = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text),
    };
    let mut parts: Vec<String> = Vec::new();
    for part in text.to_ascii_lowercase().split('\\').filter(|part| !part.is_empty() && *part != ".") {
        if part == ".." {
            parts.pop();
        } else {
            parts.push(part.to_string());
        }
    }
    parts
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    path_components(a) == path_components(b)
}

/// The browser profile holds the site session cookies: it must never sit inside a case
/// folder (which backups and exports read) or contain one.
pub fn ensure_profile_boundary(case_root: &Path, profile: &Path) -> Result<()> {
    let (case_root, profile) = (path_components(case_root), path_components(profile));
    ensure!(
        !profile.starts_with(&case_root) && !case_root.starts_with(&profile),
        "The research browser profile must be outside every case folder"
    );
    Ok(())
}

const GRANT_KEY: &str = "research_browser_grant";
const MAX_SSO_HOSTS: usize = 10;

/// Per-case research browser switch. A plain on/off toggle for the user; kept revisioned and
/// audited like the other case grants. Never set by app-wide preferences, refused offline.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Grant {
    pub enabled: bool,
    pub revision: u64,
    pub changed_at: String,
    pub destination: String,
    pub sso_hosts: Vec<String>,
    pub caps: Caps,
    /// Access routes the research tools may be used on; the subscription route stays off
    /// until its no-persistence probe passes (R37).
    pub routes: Vec<String>,
    /// Reserved so a supervised mode can be added without a data migration.
    pub approval_mode: String,
}

pub fn grant(case: &crate::case::Case) -> Result<Option<Grant>> {
    case.meta(GRANT_KEY)?.map(|value| serde_json::from_str(&value).map_err(Into::into)).transpose()
}

/// Whether the case has the research browser switched on.
pub fn enabled(case: &crate::case::Case) -> bool {
    grant(case).ok().flatten().is_some_and(|grant| grant.enabled)
}

/// A single hostname a firm uses for sign-in: a DNS name of letters, digits and hyphens per
/// label (internationalized names are converted to their ASCII form), no wildcard, scheme,
/// port or path.
fn normalize_sso_host(host: &str) -> Result<String> {
    let input = host.trim().trim_end_matches('.');
    let invalid = || anyhow::anyhow!("Invalid sign-in host {input:?}; enter a host name such as login.firm.example");
    ensure!(!input.is_empty() && !input.contains(['/', ':', '@', '*', '?', '#', ' ']), invalid());
    let parsed: reqwest::Url = format!("https://{input}/").parse().map_err(|_| invalid())?;
    let host = parsed.domain().ok_or_else(invalid)?.to_string();
    let label_ok = |label: &str| {
        (1..=63).contains(&label.len())
            && label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    ensure!(host.len() <= 253 && host.split('.').count() >= 2 && host.split('.').all(label_ok), invalid());
    ensure!(!RESEARCH_HOSTS.contains(&host.as_str()) && !SIGN_ON_HOSTS.contains(&host.as_str()), "{host} is already allowed");
    Ok(host)
}

/// Switches the research browser on or off for the case and sets its extra sign-in hosts.
pub fn set_grant(case: &mut crate::case::Case, enabled: bool, sso_hosts: &[String]) -> Result<Grant> {
    ensure!(!(enabled && case.settings()?.offline), "Turn off offline mode before enabling the research browser");
    ensure!(sso_hosts.len() <= MAX_SSO_HOSTS, "At most {MAX_SSO_HOSTS} sign-in hosts");
    let mut hosts = sso_hosts.iter().map(|host| normalize_sso_host(host)).collect::<Result<Vec<_>>>()?;
    hosts.sort();
    hosts.dedup();
    // An unreadable stored grant never prevents switching the research browser off.
    let previous = match grant(case) {
        Ok(previous) => previous,
        Err(_) if !enabled => None,
        Err(error) => return Err(error),
    };
    let grant = Grant {
        enabled,
        revision: previous.as_ref().map_or(1, |grant| grant.revision + 1),
        changed_at: chrono::Utc::now().to_rfc3339(),
        destination: "westlaw".into(),
        sso_hosts: hosts,
        caps: previous.as_ref().map_or_else(Caps::default, |grant| grant.caps),
        routes: vec!["api_keys".into()],
        approval_mode: "autonomous".into(),
    };
    // The setting and its audit entry are written together or not at all.
    case.db.execute_batch("SAVEPOINT research_grant")?;
    let written = (|| -> Result<()> {
        case.set_meta(GRANT_KEY, &serde_json::to_string(&grant)?)?;
        case.audit("research_grant_changed", serde_json::json!({"enabled": grant.enabled, "revision": grant.revision, "sso_hosts": grant.sso_hosts}))
    })();
    match written {
        Ok(()) => case.db.execute_batch("RELEASE research_grant")?,
        Err(error) => {
            case.db.execute_batch("ROLLBACK TO research_grant; RELEASE research_grant")?;
            return Err(error);
        }
    }
    Ok(grant)
}

/// Per-task limits enforced in Rust regardless of model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Caps {
    pub searches: u32,
    pub documents: u32,
    /// Clicks and key presses (either can open a document).
    pub actions: u32,
    pub captures: u32,
    pub typed_characters: u32,
    pub min_navigation_interval_ms: u64,
    pub navigations_per_minute: u32,
}

impl Default for Caps {
    fn default() -> Self {
        Self { searches: 30, documents: 60, actions: 150, captures: 25, typed_characters: 4_000, min_navigation_interval_ms: 1_500, navigations_per_minute: 20 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> NavigationPolicy {
        NavigationPolicy { sso_hosts: vec!["login.firm.example".into()], mock_origin: None }
    }

    #[test]
    fn agent_reaches_only_research_hosts_over_default_https() {
        let policy = policy();
        assert!(policy.allows("https://1.next.westlaw.com/Search/Results.html?query=x", Initiator::Agent));
        assert!(policy.allows("https://1.NEXT.Westlaw.COM:443/", Initiator::Agent));
        for url in [
            "https://1.next.westlaw.com./",
            "https://1.next.westlaw.com%2eevil.example/",
            "https://1.nеxt.westlaw.com/",
            "http://1.next.westlaw.com/",
            "https://1.next.westlaw.com:8443/",
            "https://1.next.westlaw.com.evil.example/",
            "https://evil.example/1.next.westlaw.com",
            "https://user:pass@1.next.westlaw.com/",
            "https://signon.thomsonreuters.com/",
            "https://login.firm.example/",
            "data:text/html,<p>x</p>",
            "blob:https://1.next.westlaw.com/abc",
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
            "not a url",
        ] {
            assert!(!policy.allows(url, Initiator::Agent), "{url}");
        }
    }

    #[test]
    fn user_may_also_pass_sign_on_and_listed_sso_hosts() {
        let policy = policy();
        assert!(policy.allows("https://signon.thomsonreuters.com/?productid=CBT", Initiator::User));
        assert!(policy.allows("https://LOGIN.firm.example/saml", Initiator::User));
        assert!(!policy.allows("https://other.firm.example/", Initiator::User));
        assert!(!policy.allows("http://signon.thomsonreuters.com/", Initiator::User));
    }

    #[test]
    fn mock_origin_replaces_every_real_host() {
        let policy = NavigationPolicy { sso_hosts: vec![], mock_origin: Some(mock_origin("http://127.0.0.1:9471/start").unwrap()) };
        assert!(policy.allows("http://127.0.0.1:9471/results.html", Initiator::Agent));
        assert!(!policy.allows("http://127.0.0.1:9472/", Initiator::Agent));
        assert!(!policy.allows("https://1.next.westlaw.com/", Initiator::User));
        assert!(mock_origin("https://1.next.westlaw.com/").is_err());
        assert!(mock_origin("http://10.0.0.5:80/").is_err());
        assert!(mock_origin("http://localhost:9471/").is_ok());
        assert!(mock_origin("http://[::1]:9471/").is_ok());
        assert!(mock_origin("http://127.0.0.1.evil.example/").is_err());
    }

    #[test]
    fn debugging_port_detection() {
        assert!(debugging_port_requested(Some("--remote-debugging-port=9222")));
        assert!(debugging_port_requested(Some("-remote-debugging-port=9222")));
        assert!(debugging_port_requested(Some("/remote-debugging-port=9222")));
        assert!(debugging_port_requested(Some("--foo --REMOTE-DEBUGGING-PIPE")));
        assert!(!debugging_port_requested(Some("--disable-features=msSmartScreenProtection")));
        assert!(!debugging_port_requested(None));
    }

    #[test]
    fn profile_must_not_overlap_a_case_folder() {
        let case = Path::new(r"C:\Cases\Smith");
        assert!(ensure_profile_boundary(case, Path::new(r"C:\Users\a\AppData\Local\org.localevidencedesk.app.research")).is_ok());
        assert!(ensure_profile_boundary(case, Path::new(r"C:\Cases\Smith\profile")).is_err());
        assert!(ensure_profile_boundary(case, Path::new(r"c:/cases/smith/")).is_err());
        assert!(ensure_profile_boundary(case, Path::new(r"C:\Cases")).is_err());
        assert!(ensure_profile_boundary(case, Path::new(r"C:\Cases\Smithson")).is_ok());
        assert!(ensure_profile_boundary(case, Path::new(r"C:\Other\..\Cases\Smith\p")).is_err());
        assert!(ensure_profile_boundary(case, Path::new(r"\\?\C:\Cases\Smith\p")).is_err());
        assert!(same_path(Path::new(r"\\?\C:\A\B"), Path::new(r"c:/a/./b/")));
    }

    #[test]
    fn fake_driver_records_calls_and_scripted_results() {
        use driver::{Driver, FakeDriver};
        let driver = FakeDriver::new(|method, params| match method {
            "Runtime.evaluate" => Ok(serde_json::json!({"result": {"value": params["expression"].clone()}})),
            _ => anyhow::bail!("unexpected {method}"),
        });
        let result = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            let echoed = driver.call("Runtime.evaluate", serde_json::json!({"expression": "1+1"})).await.unwrap();
            let refused = driver.call("Page.navigate", serde_json::json!({})).await;
            (echoed, refused.is_err())
        });
        assert_eq!(result.0["result"]["value"], "1+1");
        assert!(result.1);
        assert_eq!(driver.methods(), ["Runtime.evaluate", "Page.navigate"]);
    }
}
