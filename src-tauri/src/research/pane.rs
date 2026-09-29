//! The research pane: a child webview inside the main window with its own WebView2 profile,
//! no Tauri capability and no IPC. It is created from an async command, never from a sync
//! command or while the case mutex is held (`Window::add_child` blocks on the UI thread).

use std::{
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
};

use anyhow::{ensure, Context, Result};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview, WebviewUrl,
};

use super::{ensure_profile_boundary, Initiator, NavigationPolicy, WEBVIEW_LABEL};

/// Position and size of the pane in logical pixels of the main window.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Application state for the pane. At most one research webview exists.
#[derive(Default)]
pub struct PaneState {
    opening: AtomicBool,
    /// True only while a pane exists that passed `verify_isolation`.
    verified: AtomicBool,
    /// The policy the open pane was created with; navigation and pop-up handlers read it.
    policy: Arc<Mutex<Option<NavigationPolicy>>>,
    /// Case session the open pane belongs to; the pane closes when it is no longer current.
    owner: Mutex<Option<Owner>>,
    /// Bumped by every close; an open that finishes after a close discards its pane.
    generation: std::sync::atomic::AtomicU64,
    /// Debug spike panes have no case owner and are exempt from automatic closing.
    #[cfg(debug_assertions)]
    pub spike: AtomicBool,
}

/// The case session a research pane was opened for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub case_id: String,
    pub session_epoch: u64,
    pub grant_revision: u64,
}

impl PaneState {
    pub fn policy(&self) -> Option<NavigationPolicy> {
        self.policy.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub fn owner(&self) -> Option<Owner> {
        self.owner.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub fn set_owner(&self, owner: Option<Owner>) {
        *self.owner.lock().unwrap_or_else(|error| error.into_inner()) = owner;
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Whether an open or close is in progress (sign-out must not run concurrently).
    pub fn busy(&self) -> bool {
        self.opening.load(Ordering::SeqCst) || self.is_spike()
    }

    pub fn is_spike(&self) -> bool {
        #[cfg(debug_assertions)]
        return self.spike.load(Ordering::SeqCst);
        #[cfg(not(debug_assertions))]
        false
    }
}

/// Where the pane opens: the research service home, or the loopback mock in debug test mode.
/// Test mode fails closed: it never falls back to the real service.
pub fn start_url() -> Result<String> {
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
        return std::env::var("VISLEX_RESEARCH_MOCK_URL").context("Test mode opens the research pane only against VISLEX_RESEARCH_MOCK_URL");
    }
    Ok(super::WESTLAW_HOME.to_string())
}

/// The research browser profile: a sibling of the application's own WebView2 folder, never
/// inside it or inside a case. Debug test mode may redirect it to a throwaway folder.
pub fn profile_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    // Test mode fails closed: it never uses (or deletes) the user's real research profile.
    #[cfg(debug_assertions)]
    if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
        let folder = std::env::var_os("VISLEX_RESEARCH_PROFILE_DIR").filter(|folder| !folder.is_empty()).context("Test mode needs VISLEX_RESEARCH_PROFILE_DIR")?;
        return Ok(PathBuf::from(folder));
    }
    Ok(app.path().local_data_dir()?.join(format!("{}.research", app.config().identifier)))
}

fn allowed(policy: &Arc<Mutex<Option<NavigationPolicy>>>, url: &str) -> bool {
    policy.lock().unwrap_or_else(|error| error.into_inner()).as_ref().is_some_and(|policy| policy.allows(url, Initiator::User))
}

pub fn webview<R: Runtime>(app: &AppHandle<R>) -> Option<Webview<R>> {
    app.get_webview(WEBVIEW_LABEL)
}

/// Clears `opening` however `open` returns, including by panic.
struct Opening<'a>(&'a AtomicBool);
impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// WebView2 policy overrides an administrator or another program can set in the registry.
/// Either one would defeat the pane's isolation, so the pane refuses to open when present.
#[cfg(windows)]
fn registry_overrides() -> Vec<String> {
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::ERROR_FILE_NOT_FOUND,
            System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_ANY},
        },
    };
    let executable = std::env::current_exe().ok().and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned())).unwrap_or_default();
    let mut found = Vec::new();
    for (hive, hive_name) in [(HKEY_LOCAL_MACHINE, "HKLM"), (HKEY_CURRENT_USER, "HKCU")] {
        for key in ["AdditionalBrowserArguments", "UserDataFolder"] {
            let subkey = HSTRING::from(format!(r"Software\Policies\Microsoft\Edge\WebView2\{key}"));
            for value in [executable.as_str(), "*"] {
                if value.is_empty() {
                    continue;
                }
                let mut size = 0u32;
                let status = unsafe { RegGetValueW(hive, &subkey, &HSTRING::from(value), RRF_RT_ANY, None, None, Some(&mut size as *mut u32)) };
                // Anything but "not found" (including access denied) counts as present.
                if status != ERROR_FILE_NOT_FOUND {
                    found.push(format!(r"{hive_name}\...\WebView2\{key}\{value}"));
                }
            }
        }
    }
    found
}

#[cfg(not(windows))]
fn registry_overrides() -> Vec<String> {
    Vec::new()
}

/// After creation the webview must use the requested profile, however WebView2 was configured
/// (environment variable, registry policy or anything else). A DevTools listener cannot be
/// detected this way: the R34 spike found WebView2 writes no `DevToolsActivePort` marker, so
/// debugging switches are refused from the environment and registry policy before creation.
#[cfg(windows)]
fn verify_isolation<R: Runtime>(pane: &Webview<R>, profile: &Path, test_mock: bool) -> Result<()> {
    let effective = super::cdp::user_data_folder(pane)?;
    // Native test harnesses set WEBVIEW2_USER_DATA_FOLDER, which overrides the profile; that
    // is accepted only against the loopback mock.
    ensure!(test_mock || super::same_path(&effective, profile), "The research browser did not get its own profile (WebView2 used {})", effective.display());
    Ok(())
}

#[cfg(not(windows))]
fn verify_isolation<R: Runtime>(_pane: &Webview<R>, _profile: &Path, _allow_debugging: bool) -> Result<()> {
    anyhow::bail!("The research browser requires Windows")
}

/// Opens the pane at `start` and places it at `rect`. The navigation policy is resolved here
/// from the process environment, so no caller can open the pane with a weaker one. Returns the
/// existing pane if it is already open.
pub fn open<R: Runtime>(app: &AppHandle<R>, start: &str, profile: PathBuf, case_root: Option<&Path>, sso_hosts: Vec<String>, rect: Rect) -> Result<Webview<R>> {
    let state = app.state::<PaneState>();
    if let Some(existing) = webview(app) {
        ensure!(state.verified.load(Ordering::SeqCst), "The research pane is closing; try again");
        return Ok(existing);
    }
    let policy = NavigationPolicy::resolve(sso_hosts)?;
    let overrides = registry_overrides();
    ensure!(policy.is_mock() || overrides.is_empty(), "The research browser does not open while WebView2 policy overrides are set: {}", overrides.join(", "));
    ensure!(policy.allows(start, Initiator::User), "The research pane cannot open this address");
    if let Some(case_root) = case_root {
        ensure_profile_boundary(case_root, &profile)?;
    }
    ensure!(!state.opening.swap(true, Ordering::SeqCst), "The research pane is already opening");
    let _opening = Opening(&state.opening);
    if let Some(existing) = webview(app) {
        ensure!(state.verified.load(Ordering::SeqCst), "The research pane is closing; try again");
        return Ok(existing);
    }
    std::fs::create_dir_all(&profile).context("Could not create the research browser profile")?;
    let allow_debugging = policy.is_mock();
    *state.policy.lock().unwrap_or_else(|error| error.into_inner()) = Some(policy);
    let url: Url = start.parse()?;
    let navigation = state.policy.clone();
    let popups = state.policy.clone();
    let popup_app = app.clone();
    let builder = WebviewBuilder::new(WEBVIEW_LABEL, WebviewUrl::External(url))
        .data_directory(profile.clone())
        .incognito(false)
        .devtools(false)
        .on_navigation(move |url| allowed(&navigation, url.as_str()))
        // Pop-ups never open new windows; an allowed target opens in the pane itself.
        .on_new_window(move |url, _| {
            if allowed(&popups, url.as_str()) {
                if let Some(pane) = webview(&popup_app) {
                    tauri::async_runtime::spawn(async move {
                        let _ = pane.navigate(url);
                    });
                }
            }
            NewWindowResponse::Deny
        })
        // Downloads are refused; captures are the only way research content enters a case.
        .on_download(|_, _| false);
    let window = app.get_window("main").context("Main window unavailable")?;
    let pane = window.add_child(builder, LogicalPosition::new(rect.x, rect.y), LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)))?;
    if let Err(error) = verify_isolation(&pane, &profile, allow_debugging) {
        *state.policy.lock().unwrap_or_else(|error| error.into_inner()) = None;
        pane.close().context("The research pane failed verification and could not be closed")?;
        return Err(error);
    }
    state.verified.store(true, Ordering::SeqCst);
    Ok(pane)
}

/// Moves, resizes, shows or hides the pane. A missing pane is not an error.
pub fn layout<R: Runtime>(app: &AppHandle<R>, rect: Rect, visible: bool) -> Result<()> {
    let Some(pane) = webview(app) else { return Ok(()) };
    if visible {
        pane.set_position(LogicalPosition::new(rect.x, rect.y))?;
        pane.set_size(LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)))?;
        pane.show()?;
    } else {
        pane.hide()?;
    }
    Ok(())
}

/// Back, forward or reload from the toolbar. The resulting navigation still passes the
/// pane's navigation policy, like any other navigation the user starts in the page.
pub fn history<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<()> {
    let pane = webview(app).context("The research browser is closed")?;
    match action {
        "back" => pane.eval("history.back()")?,
        "forward" => pane.eval("history.forward()")?,
        "reload" => pane.reload()?,
        other => anyhow::bail!("Unknown browser action {other:?}"),
    }
    Ok(())
}

/// Signs out by deleting the research profile (cookies and site data). Closes the pane first
/// and retries while the WebView2 browser process releases its files. Blocks; never call it
/// on the UI thread.
pub fn clear_session<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let profile = profile_dir(app)?;
    let state = app.state::<PaneState>();
    ensure!(!state.opening.swap(true, Ordering::SeqCst), "The research pane is opening; try again");
    let _busy = Opening(&state.opening);
    close(app)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match std::fs::remove_dir_all(&profile) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) if std::time::Instant::now() >= deadline => {
                return Err(error).context("The research browser profile is still in use; close VisLex and try again");
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(250)),
        }
    }
    ensure!(!profile.exists(), "The research browser profile could not be removed");
    Ok(())
}

pub fn close<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let state = app.state::<PaneState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    #[cfg(debug_assertions)]
    state.spike.store(false, Ordering::SeqCst);
    state.verified.store(false, Ordering::SeqCst);
    state.set_owner(None);
    *state.policy.lock().unwrap_or_else(|error| error.into_inner()) = None;
    if let Some(pane) = webview(app) {
        pane.close()?;
    }
    Ok(())
}
