//! Application-wide billing route. Case grants remain in the case database.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessRoute {
    #[default]
    ApiKeys,
    ChatgptSubscription,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct SubscriptionSelection {
    pub model: String,
    pub effort: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AccessSettings {
    pub route: AccessRoute,
    #[serde(default)]
    pub subscription: Option<SubscriptionSelection>,
}

/// The ChatGPT-subscription route is off by default (decision 2026-09-28): it
/// depends on an unverified, separately pinned sidecar and has stalled live
/// tasks. Builds enable it only with the `subscription` Cargo feature. When it
/// is off, saved preferences stay readable, and any case or task that asks for
/// the route is stopped with this reason instead of silently using API keys.
pub const SUBSCRIPTION_ROUTE_ENABLED: bool = cfg!(feature = "subscription");
pub const SUBSCRIPTION_DISABLED_REASON: &str =
    "The ChatGPT subscription route is disabled in this build. Choose an API provider in Settings → Accounts & models";

pub fn ensure_subscription_enabled() -> Result<()> {
    anyhow::ensure!(SUBSCRIPTION_ROUTE_ENABLED, "{SUBSCRIPTION_DISABLED_REASON}");
    Ok(())
}

pub fn read(directory: &Path) -> Result<AccessRoute> {
    Ok(read_settings(directory)?.route)
}

pub fn read_settings(directory: &Path) -> Result<AccessSettings> {
    let path = directory.join("ai-access.json");
    if !path.exists() { return Ok(AccessSettings { route: AccessRoute::ApiKeys, subscription: None }); }
    let bytes = std::fs::read(&path).context("Read AI access preference")?;
    let saved: Saved = serde_json::from_slice(&bytes).context("Invalid AI access preference")?;
    anyhow::ensure!(saved.version == 1, "Unsupported AI access preference version");
    Ok(saved.settings)
}

pub fn write(directory: &Path, route: AccessRoute) -> Result<()> {
    let mut settings = read_settings(directory)?;
    settings.route = route;
    write_settings(directory, settings)
}

pub fn write_settings(directory: &Path, settings: AccessSettings) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    use std::io::Write;
    staged.write_all(&serde_json::to_vec(&Saved { version: 1, settings })?)?;
    staged.as_file().sync_all()?;
    staged.persist(directory.join("ai-access.json"))?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
struct Saved {
    version: u8,
    #[serde(flatten)]
    settings: AccessSettings,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(not(feature = "subscription"))]
    fn subscription_route_is_off_by_default_with_a_stated_reason() {
        assert!(!SUBSCRIPTION_ROUTE_ENABLED);
        let error = ensure_subscription_enabled().unwrap_err().to_string();
        assert!(error.contains("disabled in this build") && error.contains("API provider"), "{error}");
    }
    #[test]
    fn route_defaults_to_api_and_round_trips_without_a_key() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(read(temp.path()).unwrap(), AccessRoute::ApiKeys);
        write(temp.path(), AccessRoute::ChatgptSubscription).unwrap();
        assert_eq!(read(temp.path()).unwrap(), AccessRoute::ChatgptSubscription);
        write_settings(temp.path(), AccessSettings {route: AccessRoute::ApiKeys,
            subscription:Some(SubscriptionSelection {model:"gpt-test".into(),effort:"high".into()})}).unwrap();
        assert_eq!(read_settings(temp.path()).unwrap().subscription.unwrap().effort,"high");
        let raw = std::fs::read_to_string(temp.path().join("ai-access.json")).unwrap();
        assert!(!raw.contains("sk-"));
    }
}
