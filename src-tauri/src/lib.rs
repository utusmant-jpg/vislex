pub mod agent;
pub mod ai_access;
pub mod artifact_registry;
pub mod backup;
pub mod case;
#[cfg(feature = "desktop")]
pub mod desktop;
#[cfg(feature = "desktop")]
pub mod codex_account;
#[cfg(feature = "desktop")]
pub mod codex_case;
#[cfg(windows)]
pub mod codex_sandbox;
/// Non-Windows builds have no AppContainer, so the subscription sidecar can
/// never start there. This stub keeps the desktop crate compiling for Linux
/// checks and CI; every spawn is refused and nothing else changes.
#[cfg(not(windows))]
pub mod codex_sandbox {
    use std::{fs::File, path::{Path, PathBuf}};
    pub struct CodexChild { pub stdin: File, pub stdout: File, pub stderr: File, pub home: PathBuf }
    impl CodexChild {
        pub fn wait(&self, _millis: u32) -> anyhow::Result<Option<u32>> { Ok(Some(1)) }
    }
    pub fn spawn_subscription(_executable: &Path) -> anyhow::Result<CodexChild> {
        anyhow::bail!("The ChatGPT subscription route requires the Windows AppContainer sandbox")
    }
}
pub mod processing;
pub mod research;
pub mod review_progress;
#[cfg(windows)]
pub mod sandbox;
pub mod transcription;

pub mod providers;

pub mod evidence;
pub mod escalation;

pub mod teams;
pub mod dossier;
pub mod coverage;
pub mod workbench;
pub mod authority;
pub mod work_products;
pub mod exports;
pub mod semantic;

pub mod automatic;
pub mod discovery;

pub mod speaker_annotations;

pub mod intelligence;
